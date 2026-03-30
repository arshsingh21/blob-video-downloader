const { spawn, execSync } = require('child_process');
const { app, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const DrmHandler = require('./drm-handler');

function killProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch (_) {}
}
const https = require('https');
const http = require('http');

const YTDLP_PATH = 'yt-dlp';
const FFMPEG_PATH = 'ffmpeg';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

// Default CDM directory — project-local cdm/ folder, auto-detected on startup
const DEFAULT_CDM_DIR = path.join(__dirname, 'cdm');

class Downloader {
  constructor(mainWindow, interceptor, browseView, getSettings) {
    this.mainWindow = mainWindow;
    this.interceptor = interceptor;
    this.browseView = browseView;
    this.active = new Map(); // id -> { process, cancel }
    this._nextId = 1;
    this._getSettings = getSettings || (() => ({}));
    this.drmHandler = new DrmHandler(DEFAULT_CDM_DIR, session.fromPartition('persist:browse'));
  }

  /** Update CDM directory path */
  setCdmDir(dir) {
    this.drmHandler = new DrmHandler(dir, session.fromPartition('persist:browse'));
  }

  /** Check if CDM files are present */
  hasCDM() {
    return this.drmHandler.hasCDM();
  }

  // Get the current page URL from the BrowserView
  _getPageUrl() {
    try {
      return this.browseView?.webContents.getURL() || '';
    } catch (_) {
      return '';
    }
  }

  // Export cookies from Electron session to Netscape cookie jar format
  async _exportCookies(partitionName) {
    const ses = session.fromPartition(partitionName);
    const cookies = await ses.cookies.get({});
    const lines = ['# Netscape HTTP Cookie File'];

    for (const c of cookies) {
      // Skip cookies with values that could break Netscape format parsing
      if (c.name.includes('\t') || c.value.includes('\t') || c.value.includes('\n')) continue;

      const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
      const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const cookiePath = c.path || '/';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      lines.push(`${domain}\t${flag}\t${cookiePath}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
    }

    // Ensure file ends with a newline
    const tmpPath = path.join(os.tmpdir(), `vdl-cookies-${Date.now()}.txt`);
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
    return tmpPath;
  }

  // Parse m3u8 content to estimate total duration (seconds)
  _parseM3u8Duration(content) {
    let total = 0;
    const re = /#EXTINF:([\d.]+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      total += parseFloat(m[1]);
    }
    return total > 0 ? total : null;
  }

  // Parse ffmpeg time string "HH:MM:SS.ms" to seconds
  _parseTime(timeStr) {
    const parts = timeStr.split(':');
    if (parts.length !== 3) return 0;
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }

  // Fetch m3u8 to get duration before downloading
  async _fetchM3u8Duration(url, headers) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      const reqHeaders = {};
      if (headers['Referer']) reqHeaders['Referer'] = headers['Referer'];
      if (headers['User-Agent']) reqHeaders['User-Agent'] = headers['User-Agent'];
      if (headers['Cookie']) reqHeaders['Cookie'] = headers['Cookie'];

      const req = mod.get(url, { headers: reqHeaders }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(this._parseM3u8Duration(body)));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
  }

  async download(streamInfo) {
    const { url, type, headers, drm } = streamInfo;

    // For DRM downloads skip the blocking save dialog — start immediately to avoid
    // CloudFront signed URL expiry (tokens last ~3-5 min, dialog eats that window).
    // Auto-name the file and save to configured download dir; user can rename after.
    let savePath;
    if (drm) {
      const stem = (() => {
        try {
          const p = new URL(url).pathname;
          const base = p.split('/').pop().replace(/\.[^.]+$/, '') || 'video';
          return base;
        } catch { return 'video'; }
      })();
      const settings = this._getSettings();
      const downloadsDir = settings.downloadDir || app.getPath('downloads');
      // Ensure the directory exists
      if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
      // Find a non-colliding filename
      let candidate = path.join(downloadsDir, `${stem}.mp4`);
      let n = 1;
      while (fs.existsSync(candidate)) {
        candidate = path.join(downloadsDir, `${stem} (${n++}).mp4`);
      }
      savePath = candidate;
    } else {
      const defaultName = type === 'stream' ? 'video.mp4' : path.basename(new URL(url).pathname) || 'video.mp4';
      const result = await dialog.showSaveDialog(this.mainWindow, {
        title: 'Save Video',
        defaultPath: defaultName,
        filters: [
          { name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov'] },
          { name: 'Audio', extensions: ['mp3', 'aac', 'opus'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return null;
      savePath = result.filePath;
    }

    const id = this._nextId++;
    this._sendProgress(id, { status: 'starting', url, savePath, percent: null });

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          this._sendProgress(id, { status: 'retrying', attempt, url, savePath, percent: null });
          await this._sleep(RETRY_DELAY_MS * attempt);
        }

        // DRM-protected content: use the Widevine decryption pipeline
        if (drm) {
          const enrichedHeaders = await this._enrichHeadersWithCookies(url, headers);
          await this._downloadDrmMedia(id, url, enrichedHeaders, savePath);
        } else if (type === 'stream') {
          // For HLS/DASH streams, use ffmpeg (correct tool for remuxing)
          const enrichedHeaders = await this._enrichHeadersWithCookies(url, headers);
          await this._downloadWithFfmpeg(id, url, enrichedHeaders, savePath);
        } else {
          // For direct video files: try direct HTTP download first (most reliable
          // for CDN files — uses exact session cookies), then ffmpeg, then yt-dlp
          const enrichedHeaders = await this._enrichHeadersWithCookies(url, headers);
          try {
            await this._downloadDirectHttp(id, url, enrichedHeaders, savePath);
          } catch (httpErr) {
            this._cleanupPartial(savePath);
            // HTTP download failed — try ffmpeg, then yt-dlp
            try {
              await this._downloadWithFfmpeg(id, url, enrichedHeaders, savePath);
            } catch (ffErr) {
              if (ffErr.expired) throw ffErr;
              this._cleanupPartial(savePath);
              await this._downloadWithYtdlp(id, url, enrichedHeaders, savePath);
            }
          }
        }

        // Post-download validation: check if the file is valid video
        const valid = await this._validateDownload(savePath);
        if (!valid) {
          this._cleanupPartial(savePath);
          const drmMsg = drm
            ? 'DRM decryption may have failed — the output file is not valid video. Check that your CDM keys are correct and mp4decrypt is installed.'
            : 'The downloaded file does not appear to be valid video. It may be DRM-encrypted or the stream URL may have expired.';
          this._sendProgress(id, { status: 'error', url, savePath, message: drmMsg });
          this.active.delete(id);
          return null;
        }

        this._sendProgress(id, { status: 'complete', url, savePath, percent: 100 });
        this.active.delete(id);
        return { id, savePath };
      } catch (err) {
        lastError = err;
        // If token expired (403/410), don't retry — tell user to re-navigate
        if (err.expired) {
          this._sendProgress(id, { status: 'expired', url, savePath, message: 'Stream token expired. Re-navigate to the page to get a fresh URL.' });
          this.active.delete(id);
          this._cleanupPartial(savePath);
          return null;
        }
      }
    }

    // All retries exhausted
    this._sendProgress(id, { status: 'error', url, savePath, message: lastError?.message || 'Download failed' });
    this.active.delete(id);
    this._cleanupPartial(savePath);
    return null;
  }

  /**
   * DRM download pipeline:
   * 1. Determine if URL is an MPD or needs MPD discovery
   * 2. Fetch + parse MPD → extract PSSH
   * 3. Get decryption key (local CDM or external service)
   * 4. Download encrypted → decrypt with mp4decrypt → remux
   */
  async _downloadDrmMedia(id, url, headers, savePath) {
    // Step 1: Get MPD content
    this._sendProgress(id, { status: 'downloading', url, savePath, percent: null, tool: 'drm', step: 'Fetching MPD manifest...' });

    let mpdUrl = url;
    let mpdXml;

    // If the URL is an MPD, fetch it directly
    if (/\.mpd(\?|$)/i.test(url) || /application\/dash/i.test(url)) {
      mpdXml = await this.drmHandler.fetchMPD(url, headers);
    } else {
      // URL might be a direct video from a DRM CDN — look for an MPD in detected streams
      const streams = this.interceptor ? this.interceptor.streams : [];
      const mpdStream = streams.find(s => /\.mpd(\?|$)/i.test(s.url));
      if (mpdStream) {
        mpdUrl = mpdStream.url;
        const mpdHeaders = await this._enrichHeadersWithCookies(mpdStream.url, mpdStream.headers || {});
        mpdXml = await this.drmHandler.fetchMPD(mpdUrl, mpdHeaders);
      } else {
        throw new Error('No MPD manifest found. Browse to the video page and let it play briefly so the DRM manifest can be intercepted.');
      }
    }

    // Step 2: Extract PSSH
    this._sendProgress(id, { status: 'downloading', url, savePath, percent: null, tool: 'drm', step: 'Extracting PSSH...' });
    const pssh = this.drmHandler.extractPSSH(mpdXml);
    if (!pssh) {
      throw new Error('Could not extract Widevine PSSH from the MPD manifest. The content may use a different DRM system.');
    }

    // Step 3: Find license server URL
    let licenseUrl = this.drmHandler.extractLicenseUrl(mpdXml);
    // licenseHeaders: used specifically for the license POST — may differ from CDN stream headers
    let licenseHeaders = { ...headers };

    if (this.interceptor) {
      const licenseEntry = this.interceptor.getLicenseUrl();
      if (licenseEntry) {
        if (!licenseUrl) licenseUrl = licenseEntry.url;
        // Use the headers the browser actually sent for the license request —
        // these contain the real auth tokens (cookies, sign, time, etc.)
        if (licenseEntry.headers && Object.keys(licenseEntry.headers).length > 0) {
          licenseHeaders = { ...licenseEntry.headers };
        }
      }
    }

    // Enrich license headers with session cookies for the license server's domain
    if (licenseUrl) {
      try {
        const licenseOrigin = new URL(licenseUrl).origin;
        const ses = session.fromPartition('persist:browse');
        const cookies = await ses.cookies.get({ url: licenseOrigin });
        if (cookies.length > 0 && !licenseHeaders['Cookie']) {
          licenseHeaders['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      } catch (_) {}
    }

    if (!licenseUrl) {
      throw new Error('Could not find the Widevine license server URL. Let the video play briefly in the browser so the license request can be captured.');
    }

    // Step 4: Get decryption key
    this._sendProgress(id, { status: 'downloading', url, savePath, percent: null, tool: 'drm', step: 'Getting decryption key...' });
    const keyInfo = await this.drmHandler.getDecryptionKey(pssh, licenseUrl, licenseHeaders);
    console.log(`[DRM] Keys obtained via ${keyInfo.method}: ${keyInfo.decryptionKeys.join(', ')}`);

    // Step 5: Download and decrypt
    await this.drmHandler.downloadAndDecrypt({
      mpdUrl,
      decryptionKeys: keyInfo.decryptionKeys,
      headers,
      savePath,
      onProgress: ({ step, percent, timeStr }) => {
        const stepLabels = {
          downloading: 'Downloading encrypted video...',
          decrypting: 'Decrypting with mp4decrypt...',
          remuxing: 'Remuxing final output...',
        };
        this._sendProgress(id, {
          status: 'downloading',
          url, savePath, percent,
          tool: 'drm',
          step: stepLabels[step] || step,
        });
      },
    });
  }


  async _downloadWithFfmpeg(id, url, headers, savePath) {
    // Try to get total duration for progress calculation
    let totalDuration = null;
    if (/\.m3u8/i.test(url)) {
      totalDuration = await this._fetchM3u8Duration(url, headers);
    }

    const args = ['-y'];

    // Forward all captured headers to ffmpeg
    const headerParts = [];
    const passHeaders = ['Referer', 'User-Agent', 'Cookie', 'Origin', 'Accept', 'Accept-Language'];
    for (const key of passHeaders) {
      if (headers[key]) headerParts.push(`${key}: ${headers[key]}`);
    }
    if (headerParts.length > 0) {
      args.push('-headers', headerParts.join('\r\n') + '\r\n');
    }

    args.push('-i', url, '-c', 'copy', savePath);

    return new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_PATH, args, { shell: false });
      this.active.set(id, { process: proc, cancel: () => killProcessTree(proc.pid) });

      let stderrBuf = '';
      proc.stderr.on('data', (data) => {
        stderrBuf += data.toString();
        // Parse progress from ffmpeg stderr
        const timeMatch = stderrBuf.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
        if (timeMatch) {
          const currentTime = this._parseTime(timeMatch[1]);
          const percent = totalDuration ? Math.min(99, Math.round((currentTime / totalDuration) * 100)) : null;
          this._sendProgress(id, { status: 'downloading', url, savePath, percent, tool: 'ffmpeg' });
          stderrBuf = '';
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Check if this looks like an expired token
          if (stderrBuf.includes('403') || stderrBuf.includes('410') || stderrBuf.includes('Server returned 403')) {
            reject(Object.assign(new Error('Stream token expired'), { expired: true }));
          } else {
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        }
      });

      proc.on('error', (err) => reject(err));
    });
  }

  async _downloadWithYtdlp(id, url, headers, savePath) {
    const cookieJar = await this._exportCookies('persist:browse');

    const args = [
      '--no-check-certificates',
      '--impersonate', 'chrome',
      '--cookies', cookieJar,
      '-o', savePath,
    ];

    // Add non-cookie headers (skip User-Agent — --impersonate manages the full fingerprint)
    if (headers['Referer']) args.push('--add-header', `Referer:${headers['Referer']}`);
    if (headers['Origin']) args.push('--add-header', `Origin:${headers['Origin']}`);

    args.push(url);

    return new Promise((resolve, reject) => {
      const proc = spawn(YTDLP_PATH, args, { shell: false });
      this.active.set(id, { process: proc, cancel: () => killProcessTree(proc.pid) });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
        // Parse yt-dlp progress: [download]  45.2% of ~50.00MiB
        const pctMatch = data.toString().match(/([\d.]+)%/);
        if (pctMatch) {
          const percent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
          this._sendProgress(id, { status: 'downloading', url, savePath, percent, tool: 'yt-dlp' });
        }
      });

      proc.stderr.on('data', (data) => { output += data.toString(); });

      proc.on('close', (code) => {
        // Clean up temp cookie jar
        try { fs.unlinkSync(cookieJar); } catch (_) {}

        if (code === 0) {
          resolve();
        } else {
          if (output.includes('HTTP Error 403') || output.includes('HTTP Error 410')) {
            reject(Object.assign(new Error('Stream token expired'), { expired: true }));
          } else {
            reject(new Error(`yt-dlp exited with code ${code}: ${output.slice(-200)}`));
          }
        }
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(cookieJar); } catch (_) {}
        reject(err);
      });
    });
  }

  async downloadPageUrl(pageUrl) {
    const result = await dialog.showSaveDialog(this.mainWindow, {
      title: 'Save Video',
      defaultPath: 'video.mp4',
      filters: [
        { name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov'] },
        { name: 'Audio', extensions: ['mp3', 'aac', 'opus'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || !result.filePath) return null;
    const savePath = result.filePath;

    const id = this._nextId++;
    this._sendProgress(id, { status: 'starting', url: pageUrl, savePath, percent: null });

    try {
      const cookieJar = await this._exportCookies('persist:browse');

      // Write directly to the user-chosen path so the output location is always known.
      // Using %(title)s here would produce a different filename than savePath, breaking
      // both the fragment cleanup below and the DRM validation that follows.
      const saveDir = path.dirname(savePath);

      const args = [
        '--no-check-certificates',
        '--no-playlist',
        '--fixup', 'never',
        '--impersonate', 'chrome',
        '--referer', pageUrl,
        '--cookies', cookieJar,
        '-o', savePath,
        pageUrl,
      ];

      await new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, args, { shell: false });
        this.active.set(id, { process: proc, cancel: () => killProcessTree(proc.pid) });

        let output = '';
        proc.stdout.on('data', (data) => {
          output += data.toString();
          const pctMatch = data.toString().match(/([\d.]+)%/);
          if (pctMatch) {
            const percent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
            this._sendProgress(id, { status: 'downloading', url: pageUrl, savePath, percent, tool: 'yt-dlp' });
          }
        });

        proc.stderr.on('data', (data) => { output += data.toString(); });

        proc.on('close', (code) => {
          try { fs.unlinkSync(cookieJar); } catch (_) {}
          // Treat as success if download reached 100% even if post-processing failed
          const downloadedFully = /100% of/.test(output);
          if (code === 0 || downloadedFully) {
            resolve();
          } else {
            reject(new Error(`yt-dlp exited with code ${code}: ${output.slice(-300)}`));
          }
        });

        proc.on('error', (err) => {
          try { fs.unlinkSync(cookieJar); } catch (_) {}
          reject(err);
        });
      });

      // Clean up fragment files (e.g., video.mp4.f123.m4s)
      const baseName = path.basename(savePath);
      try {
        const files = fs.readdirSync(saveDir);
        for (const file of files) {
          if (file.startsWith(baseName) && /\.f\d+\.m4s$/.test(file)) {
            fs.unlinkSync(path.join(saveDir, file));
          }
        }
      } catch (_) {}

      // Validate the file isn't DRM-encrypted garbage (same check as download())
      const valid = await this._validateDownload(savePath);
      if (!valid) {
        this._cleanupPartial(savePath);
        this._sendProgress(id, {
          status: 'error',
          url: pageUrl,
          savePath,
          message: 'The downloaded file does not appear to be valid video. It may be DRM-encrypted or the stream URL may have expired.',
        });
        this.active.delete(id);
        return null;
      }

      this._sendProgress(id, { status: 'complete', url: pageUrl, savePath, percent: 100 });
      this.active.delete(id);
      return { id, savePath };
    } catch (err) {
      // If yt-dlp doesn't support the site, fall back to ffmpeg with intercepted streams
      const unsupported = /Unsupported URL|No video formats found/.test(err.message);
      if (unsupported && this.interceptor) {
        const streams = this.interceptor.streams;
        // Prefer stream (m3u8/mpd) over direct, pick the most recent
        const best = streams.filter(s => s.type === 'stream').pop()
                  || streams.filter(s => s.type === 'direct').pop()
                  || streams[streams.length - 1];

        if (best) {
          this._sendProgress(id, { status: 'downloading', url: best.url, savePath, percent: null, tool: 'ffmpeg (fallback)' });
          try {
            await this._downloadWithFfmpeg(id, best.url, best.headers || {}, savePath);
            this._sendProgress(id, { status: 'complete', url: best.url, savePath, percent: 100 });
            this.active.delete(id);
            return { id, savePath };
          } catch (ffErr) {
            this._sendProgress(id, { status: 'error', url: pageUrl, savePath, message: `yt-dlp: Unsupported site. ffmpeg fallback: ${ffErr.message}` });
            this.active.delete(id);
            this._cleanupPartial(savePath);
            return null;
          }
        }
      }

      this._sendProgress(id, { status: 'error', url: pageUrl, savePath, message: err.message });
      this.active.delete(id);
      this._cleanupPartial(savePath);
      return null;
    }
  }

  cancel(id) {
    const entry = this.active.get(id);
    if (entry) {
      entry.cancel();
      this.active.delete(id);
      this._sendProgress(id, { status: 'cancelled' });
    }
  }

  _sendProgress(id, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('download-progress', { id, ...data });
    }
  }

  _cleanupPartial(filePath) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }

  // Enrich headers with session cookies for the given URL's domain
  async _enrichHeadersWithCookies(url, headers) {
    const enriched = { ...headers };
    // If Cookie header is already set, don't overwrite
    if (enriched['Cookie']) return enriched;

    try {
      const parsedUrl = new URL(url);
      const ses = session.fromPartition('persist:browse');
      const cookies = await ses.cookies.get({ url: parsedUrl.origin });
      if (cookies.length > 0) {
        enriched['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch (_) {}
    return enriched;
  }

  // Direct HTTP download — most reliable for CDN files because it uses
  // the exact same cookies and headers the browser would send.
  _downloadDirectHttp(id, url, headers, savePath) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;

      const reqHeaders = {};
      // Only forward relevant headers
      const passKeys = ['Cookie', 'Referer', 'User-Agent', 'Origin', 'Accept', 'Accept-Language'];
      for (const key of passKeys) {
        if (headers[key]) reqHeaders[key] = headers[key];
      }
      if (!reqHeaders['User-Agent']) {
        reqHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      }

      const req = mod.get(url, { headers: reqHeaders }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this._downloadDirectHttp(id, res.headers.location, headers, savePath)
            .then(resolve).catch(reject);
          return;
        }

        if (res.statusCode === 403 || res.statusCode === 410) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode} — access denied or URL expired`);
          err.expired = true;
          reject(err);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;
        const file = fs.createWriteStream(savePath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const percent = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
            this._sendProgress(id, { status: 'downloading', url, savePath, percent, tool: 'http' });
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          // Check file size — if too small, likely an error page
          if (downloadedBytes < 10000) {
            reject(new Error('Downloaded file too small — likely an error response'));
          } else {
            resolve();
          }
        });

        file.on('error', (err) => {
          fs.unlink(savePath, () => {});
          reject(err);
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('HTTP download timed out'));
      });

      // Store for cancellation
      this.active.set(id, {
        process: null,
        cancel: () => { req.destroy(); }
      });
    });
  }

  // Validate that the downloaded file is a playable video using ffprobe.
  // Returns true if valid, false if corrupt/encrypted (green screen).
  async _validateDownload(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stat = fs.statSync(filePath);
      if (stat.size < 10000) return false; // too small to be real video

      // Use ffprobe to check if the file has valid video streams
      return new Promise((resolve) => {
        const proc = spawn('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,width,height,duration',
          '-of', 'json',
          filePath
        ], { shell: false, timeout: 10000 });

        let output = '';
        proc.stdout.on('data', (data) => { output += data.toString(); });
        proc.stderr.on('data', () => {}); // ignore stderr

        proc.on('close', (code) => {
          if (code !== 0) {
            // ffprobe failed — file is likely not valid video
            resolve(false);
            return;
          }
          try {
            const info = JSON.parse(output);
            const streams = info.streams || [];
            if (streams.length === 0) {
              resolve(false); // no video streams found
              return;
            }
            // Check for reasonable dimensions (encrypted video often reports 0x0 or very small)
            const stream = streams[0];
            if (stream.width && stream.height && stream.width > 10 && stream.height > 10) {
              resolve(true); // looks like valid video
            } else {
              resolve(false); // suspicious dimensions
            }
          } catch (_) {
            resolve(false); // couldn't parse ffprobe output
          }
        });

        proc.on('error', () => resolve(true)); // ffprobe not installed — skip validation
      });
    } catch (_) {
      return true; // validation error — don't block download
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Downloader;
