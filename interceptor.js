const { EventEmitter } = require('events');

const STREAM_PATTERN = /\.(m3u8|mpd)(\?|$)/i;
const DIRECT_PATTERN = /\.(mp4|webm|mov)(\?|$)/i;
const SEGMENT_PATTERN = /\.(ts|m4s)(\?|$)/i;

// CDN URL patterns for sites that don't use obvious extensions
const CDN_VIDEO_PATTERN = /\/(dash|hls|video|source|media|stream)\b.*\.(mp4|m3u8|mpd|webm)/i;
const KNOWN_CDN_PATTERN = /(cdn\d*\.onlyfans\.com|cdn\d*\.fansly\.com|media\..*\.com)\/.*(\/source|\/dash|\/hls|drm|\.mp4|\.m3u8)/i;

// OnlyFans-specific: CloudFront signed URLs with Policy/Signature/Key-Pair-Id
const CLOUDFRONT_SIGNED_VIDEO = /\.cloudfront\.net\/.*(\.mp4|\.m3u8|\.mpd|dash|hls|\/source)/i;

// API endpoints that serve video metadata or direct video URLs
const API_VIDEO_ENDPOINT = /\/api2?\/v\d+\/.*(posts|stories|chats|media|messages).*\//i;

// Broad CDN video path detection (catches /files/…/source, /media/…/video, etc.)
const CDN_PATH_VIDEO = /\/(files|uploads|content|assets)\/.*\/(source|video|preview|full|original)/i;

// MIME types to skip (not video even if URL matched)
const SKIP_CONTENT_TYPES = /^(text\/html|application\/json|text\/plain|image\/)/i;

// DRM detection: only flag as DRM when the URL is a DASH manifest/segment (in a /dash/ path)
// OR has an explicit DRM marker. Regular MP4s on cdn*.onlyfans.com are NOT DRM-encrypted.
const DRM_CDN_PATTERN = /(cdn\d*\.onlyfans\.com|cdn\d*\.fansly\.com|cdn\.drm\.|sec\.cloudfront\.net)/i;
const DRM_DASH_PATH = /\/dash\//i;   // OnlyFans DASH (CENC) content lives under /dash/
const DRM_URL_MARKER = /(\/drm\/|\/widevine\/|\/encrypted\/|cenc|clearkey)/i;

// Widevine license server URL patterns
const LICENSE_URL_PATTERN = /\/(license|widevine|wv|drm\/license|eme|getlicense|drm\/(video|audio|manifest|message))/i;
// OnlyFans-specific license URL pattern
const ONLYFANS_LICENSE_PATTERN = /onlyfans\.com\/api.*\/drm\//i;

class Interceptor extends EventEmitter {
  constructor() {
    super();
    this._detected = new Map(); // url -> { url, type, headers, timestamp }
    this._headerCache = new Map(); // url -> requestHeaders (for content-type fallback)
    this._licenseUrls = new Map(); // domain -> { url, headers, timestamp }
  }

  get streams() {
    return Array.from(this._detected.values());
  }

  /** Manually store a license URL (e.g. captured via CDP debugger) */
  storeLicenseUrl(url, headers = {}) {
    try {
      const domain = new URL(url).hostname;
      const entry = { url, headers, timestamp: Date.now() };
      this._licenseUrls.set(domain, entry);
      this._licenseUrls.set(url, entry);
      this.emit('license-url-detected', { url, headers, domain });
    } catch (_) {}
  }

  /** Get the most recently captured license URL for a given domain (or any) */
  getLicenseUrl(domain) {
    if (domain) {
      const entry = this._licenseUrls.get(domain);
      if (entry) return entry;
    }
    // Return the most recent license URL
    let latest = null;
    for (const entry of this._licenseUrls.values()) {
      if (!latest || entry.timestamp > latest.timestamp) latest = entry;
    }
    return latest;
  }

  clear() {
    this._detected.clear();
    this._headerCache.clear();
    // Don't clear license URLs — they're reusable across page navigations
  }

  attach(session) {
    // Detect streams AND capture headers in the same hook (onBeforeSendHeaders)
    // to avoid the race condition where onBeforeRequest fires before headers exist.
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const url = details.url;
      const headers = { ...details.requestHeaders };
      let type = null;

      // Cache headers for every request so onHeadersReceived can use them
      this._headerCache.set(url, headers);
      // Keep cache bounded (last 500 requests)
      if (this._headerCache.size > 500) {
        const oldest = this._headerCache.keys().next().value;
        this._headerCache.delete(oldest);
      }

      if (STREAM_PATTERN.test(url)) {
        type = 'stream';
      } else if (DIRECT_PATTERN.test(url)) {
        type = 'direct';
      } else if (CDN_VIDEO_PATTERN.test(url)) {
        type = /m3u8|mpd|dash|hls/i.test(url) ? 'stream' : 'direct';
      } else if (KNOWN_CDN_PATTERN.test(url)) {
        type = /m3u8|mpd|dash|hls/i.test(url) ? 'stream' : 'direct';
      } else if (CLOUDFRONT_SIGNED_VIDEO.test(url)) {
        type = /m3u8|mpd|dash|hls/i.test(url) ? 'stream' : 'direct';
      } else if (CDN_PATH_VIDEO.test(url)) {
        type = /m3u8|mpd|dash|hls/i.test(url) ? 'stream' : 'direct';
      } else if (SEGMENT_PATTERN.test(url) && this._detected.size === 0) {
        type = 'segment';
      }

      if (type && !this._detected.has(url)) {
        // Detect if this stream is likely DRM-encrypted
        const drm = (DRM_CDN_PATTERN.test(url) && DRM_DASH_PATH.test(url)) || DRM_URL_MARKER.test(url);
        const entry = { url, type, headers, drm, timestamp: Date.now() };
        this._detected.set(url, entry);
        this.emit('stream-detected', entry);
      }

      // Capture Widevine license server URLs for DRM key retrieval
      // Capture on any method — license URL may appear in GET preflight before POST
      if (LICENSE_URL_PATTERN.test(url) || ONLYFANS_LICENSE_PATTERN.test(url)) {
        try {
          const domain = new URL(url).hostname;
          this._licenseUrls.set(domain, { url, headers, timestamp: Date.now() });
          // Also store by full URL path for OnlyFans (license URL is per-media)
          this._licenseUrls.set(url, { url, headers, timestamp: Date.now() });
          this.emit('license-url-detected', { url, headers, domain });
          console.log('[DRM] License URL captured:', url);
        } catch (_) {}
      }

      // Debug: log ALL onlyfans.com API requests so we can identify license URL pattern
      if (/onlyfans\.com\/api/i.test(url)) {
        console.log(`[DRM DEBUG] OnlyFans API request [${details.method}]: ${url}`);
      }

      callback({ cancel: false });
    });

    // Strip restrictive CSP headers so sites render correctly,
    // but preserve headers needed for DRM license handshakes
    session.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };

      // Detect video responses by content-type (catches CDN URLs without extensions)
      const contentType = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === 'content-type'
      );
      if (contentType) {
        const ct = Array.isArray(contentType[1]) ? contentType[1][0] : contentType[1];
        const isVideo = /video\/|application\/x-mpegurl|application\/dash\+xml|application\/octet-stream/i.test(ct);

        // For octet-stream, only treat as video if the URL looks like it could be video
        const isOctetStream = /application\/octet-stream/i.test(ct);
        const urlLooksLikeVideo = /\.(mp4|webm|mov|m3u8|mpd|ts|m4s)|\/(source|video|media|stream|dash|hls)|cloudfront\.net/i.test(details.url);

        if ((isVideo && !isOctetStream) || (isOctetStream && urlLooksLikeVideo)) {
          if (!this._detected.has(details.url)) {
            const type = /mpegurl|dash/i.test(ct) ? 'stream' : 'direct';
            const drm = DRM_CDN_PATTERN.test(details.url) || DRM_URL_MARKER.test(details.url);
            // Retrieve the request headers we cached during onBeforeSendHeaders
            const cachedHeaders = this._headerCache.get(details.url) || {};
            const entry = { url: details.url, type, headers: cachedHeaders, drm, timestamp: Date.now() };
            this._detected.set(details.url, entry);
            this.emit('stream-detected', entry);
          }
        }
      }

      // Only strip CSP on page/subframe navigations, not on license/key requests
      const isDrmRequest = /license|widevine|drm|playready/i.test(details.url);
      if (!isDrmRequest) {
        const cspKeys = Object.keys(headers).filter(
          k => k.toLowerCase() === 'content-security-policy' ||
               k.toLowerCase() === 'content-security-policy-report-only'
        );
        for (const key of cspKeys) {
          delete headers[key];
        }
      }

      callback({ responseHeaders: headers });
    });
  }
}

module.exports = Interceptor;
