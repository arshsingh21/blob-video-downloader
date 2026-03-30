# Plan: Cloudflare 403 Bypass + Download Path Parity

## Problem 1 — Cloudflare 403 on `downloadPageUrl`

`yt-dlp` hits a `403 Forbidden` when downloading OnlyFans pages. Cloudflare detects it
via TLS fingerprint (JA3/JA4) — a fake `User-Agent` string alone is not enough.

### Cloudflare Detection Layers

| Layer | What it checks | Solution |
|---|---|---|
| TLS fingerprint (JA3/JA4) | Non-browser TLS handshake | `--impersonate chrome` (via `curl-cffi`) |
| HTTP/2 fingerprinting | Non-browser H2 settings | covered by `--impersonate chrome` |
| `cf_clearance` cookie | Solved JS challenge | already handled — `_exportCookies` exports session cookies |
| JS challenge | Requires real browser | not solvable by yt-dlp alone |

### Required Changes — `downloader.js`

**`_downloadWithYtdlp`:**
- Add `--impersonate`, `chrome` to args.
- Remove `--add-header User-Agent:…` when impersonating (conflicting headers cause errors).

**`downloadPageUrl`:**
- Add `--impersonate`, `chrome` to args.
- Remove the hardcoded `--user-agent` flag — impersonation manages the full browser fingerprint.

> **Do NOT add** `--extractor-args "generic:impersonate"` — this is not a valid yt-dlp flag
> and will cause errors. `--impersonate chrome` is sufficient.

### Prerequisite

`curl-cffi` must be available to yt-dlp for `--impersonate` to work:

```
pip install curl-cffi
```

Modern yt-dlp (≥2023.11) bundles `curl-cffi` in the standalone binary. If using the pip
package, install it manually. The flag fails silently if the library is missing.

---

## Problem 2 — Element Picker vs Auto-Detected Stream Download Divergence

### Root Cause

Auto-detected streams (via `Interceptor`) are created with **full captured request headers**
(Cookie, Referer, User-Agent, Origin) because the interceptor hooks `onBeforeSendHeaders`
and records the actual browser request headers.

The element picker created streams with **`headers: {}`** — no Referer, no User-Agent, no
Origin — causing CDN auth failures that the interceptor path would never see.

Additionally, `downloader.download()` enriches headers with session cookies and passes
`enrichedHeaders` to ffmpeg, but passed the original `headers` (not enriched) to yt-dlp
as the last-resort fallback — a silent bug affecting all download paths.

### Fixes Applied

**`renderer.js` — element picker stream creation:**
```js
// Before
const stream = { url: src, type: 'direct', headers: {} };

// After — captures current page URL as Referer before the pick
const pageUrlForReferer = await window.api.getCurrentUrl();
const stream = { url: src, type: 'direct', headers: pageUrlForReferer ? { Referer: pageUrlForReferer } : {} };
```

**`downloader.js` — yt-dlp fallback in `download()`:**
```js
// Before — passed original (possibly empty) headers
await this._downloadWithYtdlp(id, url, headers, savePath);

// After — passes enriched headers (includes session cookies)
await this._downloadWithYtdlp(id, url, enrichedHeaders, savePath);
```

### Download Path Comparison (post-fix)

| Aspect | Auto-detected stream | Element-picker stream |
|---|---|---|
| Headers at creation | Full (Cookie, Referer, UA, Origin) | Referer only (from current page URL) |
| Cookie enrichment | `_enrichHeadersWithCookies` adds if missing | Same |
| yt-dlp cookie jar | `_exportCookies('persist:browse')` | Same |
| yt-dlp fallback headers | enrichedHeaders (post-fix) | enrichedHeaders (post-fix) |
| Referer passed to tools | Yes (captured) | Yes (page URL, post-fix) |

The remaining difference (no Origin/UA on picker streams) is acceptable — `_downloadDirectHttp`
adds a default UA, and Origin is only meaningful for CORS preflight, not CDN auth.

---

## Problem 3 — `downloadPageUrl` Missing DRM Validation + Broken Fragment Cleanup

### Root Cause

`download()` calls `_validateDownload(savePath)` after every download to detect encrypted/green-screen
files. `downloadPageUrl()` had **no such check**, so DRM-encrypted content would silently
produce an unplayable file.

Additionally, `downloadPageUrl` used `%(title)s` as the yt-dlp output template, meaning
the actual file on disk had a different name than `savePath`. This broke:
- **Fragment cleanup** — used `baseName` from `savePath`, would never match `%(title)s` files
- **DRM validation** — can't validate a file you don't know the path of

### Fix Applied

Switched `downloadPageUrl` to write directly to `savePath` (the path the user chose in the
save dialog). Added `_validateDownload(savePath)` after the download completes, matching
the behavior of `download()`.

---

## Status

All code changes applied. Remaining action required from user:

1. Verify `curl-cffi` is available: `yt-dlp --impersonate chrome --version` — if it prints
   a version without error, impersonation is ready. If it says "impersonation not supported",
   run `pip install curl-cffi`.
2. Restart the app and retry the OnlyFans download to confirm the 403 is resolved.
