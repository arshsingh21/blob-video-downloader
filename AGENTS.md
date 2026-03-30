# AI Agent Guide — Video Downloader Browser

> This document explains the structure, architecture, data flow, and conventions of the **blob-video-downloader** project to any AI agent working on the codebase.

---

## 1. What This Project Is

A **custom Electron desktop browser** whose sole purpose is to **detect and download video streams** (HLS, DASH, direct `.mp4`/`.webm`) from any website. The key insight: by browsing *inside* the Electron app, the browser session inherits the exact cookies, headers, referer, and auth tokens the site expects — solving the authentication problems that external download tools like `yt-dlp` and `ffmpeg` hit when run standalone.

**Target platform:** Windows (paths and process-kill logic are Windows-centric, but the code has Linux fallbacks).

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | **Electron** (Castlabs fork `v33.4.11+wvcus` for Widevine CDM support) |
| Language | Vanilla **Node.js** (CommonJS `require`) — no TypeScript, no bundler, no framework |
| UI | Plain **HTML + CSS + vanilla JS** (no React, no Svelte, no build step) |
| Styling | Single `styles.css` file, dark theme (`#0f0f13` / `#1a1a22` / `#5a5aff` palette) |
| Download tools | External system binaries: **ffmpeg** and **yt-dlp** (NOT bundled, detected on PATH at runtime) |
| Package manager | npm (lockfile committed) |

### Why the Castlabs Electron fork?

Standard Electron cannot play DRM-protected (Widevine) content. The [Castlabs fork](https://github.com/castlabs/electron-releases) bundles the Widevine CDM so sites like OK.ru, Netflix, etc. can play videos inside the app. This fork is referenced directly as a git dependency in `package.json`:

```json
"electron": "https://github.com/castlabs/electron-releases#v33.4.11+wvcus"
```

---

## 3. File Map & Responsibilities

```
blob-video-downloader/
├── package.json                      # App metadata, scripts, Electron dependency
├── launch.js                         # Entry point (`npm start`). Spawns Electron with ELECTRON_RUN_AS_NODE unset
├── main.js                           # Electron MAIN process: window, BrowserView, IPC handlers, lifecycle
├── preload.js                        # Preload bridge: exposes `window.api.*` via contextBridge
├── index.html                        # Browser chrome UI: nav bar, sidebar, welcome screen, banners
├── renderer.js                       # Renderer logic: DOM events, sidebar, streams list, download cards
├── styles.css                        # All CSS (dark theme, nav bar, sidebar, cards, progress bars)
├── interceptor.js                    # Network request interceptor (stream detection, CSP stripping)
├── downloader.js                     # Download manager (ffmpeg/yt-dlp spawning, cookie export, retries)
├── scripts/
│   └── postinstall.js                # Patches node_modules/electron/index.js for built-in module resolution
├── AGENTS.md                         # This file — architecture guide for AI agents
├── ytdlp-cloudflare-bypass-plan.md   # Active plan: Cloudflare 403 fix + download path parity fixes
├── PLAN.md                           # Original design document / implementation plan
├── Media_key_plan.md                 # Follow-up plan for fixing 403 + MediaKey DRM errors
└── .claude/
    └── settings.local.json           # Claude AI assistant config (not project code)
```

---

## 4. Architecture

The app uses the standard Electron **main + renderer** process model, with a `BrowserView` for web content:

```
┌─────────────────────────────────────────────────────────┐
│                    MAIN PROCESS (main.js)                │
│                                                         │
│  ┌─────────────────┐   ┌─────────────────────────────┐  │
│  │  Interceptor     │   │  Downloader                 │  │
│  │  (interceptor.js)│   │  (downloader.js)            │  │
│  │                  │   │                             │  │
│  │  Hooks into      │   │  Spawns ffmpeg / yt-dlp     │  │
│  │  session.web     │   │  Exports cookies to jar     │  │
│  │  Request API     │   │  Retry + error recovery     │  │
│  └─────────────────┘   └─────────────────────────────┘  │
│              ↕ IPC (ipcMain ↔ ipcRenderer)              │
├─────────────────────────────────────────────────────────┤
│              RENDERER PROCESS                            │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  index.html + renderer.js + styles.css              │ │
│  │  Nav bar │ URL input │ Stream badge │ Sidebar        │ │
│  │  Welcome screen │ DRM banner │ tool warning          │ │
│  └─────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│              BROWSERVIEW (isolated session)               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Partition: "persist:browse"                        │ │
│  │  Actual websites render here                        │ │
│  │  Cookies + headers captured by Interceptor          │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Key architectural decisions

1. **`BrowserView`, not `<webview>`** — `<webview>` is deprecated in Electron. The `BrowserView` is created in `main.js` and positioned below the 52px nav bar.

2. **Session isolation** — The BrowserView uses `session.fromPartition('persist:browse')` so interceptor hooks only fire on web-content traffic, not DevTools or the app's own UI.

3. **No tabs** — Single-view browser. `target="_blank"` links are caught by `setWindowOpenHandler` and loaded in the same view.

4. **No build step** — Everything runs as-is. No webpack, no esbuild, no transpilation.

---

## 5. IPC Contract

All communication between renderer and main goes through `preload.js`, which exposes `window.api`:

### Renderer → Main (fire-and-forget)

| Channel | Args | Purpose |
|---|---|---|
| `navigate` | `url: string` | Navigate BrowserView to URL |
| `go-back` | — | History back |
| `go-forward` | — | History forward |
| `reload` | — | Reload current page |
| `toggle-sidebar` | `open: boolean` | Resize BrowserView to make room for sidebar |
| `cancel-download` | `id: number` | Kill download subprocess |
| `clear-detected-streams` | — | Reset interceptor's stream list |

### Renderer → Main (invoke/handle, returns a Promise)

| Channel | Args | Returns | Purpose |
|---|---|---|---|
| `get-detected-streams` | — | `StreamInfo[]` | Get all intercepted streams |
| `download` | `StreamInfo` | `{id, savePath} \| null` | Start download (shows save dialog) |
| `download-page-url` | `pageUrl: string` | `{id, savePath} \| null` | yt-dlp page-level download |
| `pick-video-element` | — | `{found, src, ...} \| {cancelled}` | Inject element picker into page |
| `get-current-url` | — | `string` | Get BrowserView's current URL |
| `check-tools` | — | `{ytdlp: bool, ffmpeg: bool}` | Check if tools are on PATH |

### Main → Renderer (push events)

| Channel | Data | Purpose |
|---|---|---|
| `stream-detected` | `StreamInfo` | New stream intercepted |
| `url-changed` | `url: string` | BrowserView navigated |
| `title-changed` | `title: string` | Page title updated |
| `loading-changed` | `loading: boolean` | Page started/stopped loading |
| `download-progress` | `{id, status, percent, ...}` | Download status update |
| `drm-error` | `message: string` | DRM/MediaKey console error detected |

### `StreamInfo` shape

```js
{
  url: string,       // Full URL of the detected resource
  type: 'stream' | 'direct' | 'segment',
  headers: {         // Captured from the actual browser request
    Referer?: string,
    Cookie?: string,
    'User-Agent'?: string,
    Origin?: string,
    // ...other request headers
  },
  timestamp: number  // Date.now() when detected
}
```

---

## 6. How Stream Detection Works (`interceptor.js`)

The `Interceptor` class extends `EventEmitter` and attaches two hooks to the BrowserView's session:

### `onBeforeSendHeaders` — Primary detection

Fires *before* the browser sends each request. Checks the URL against (in order):

1. **`STREAM_PATTERN`** — `.m3u8`, `.mpd` → type `'stream'`
2. **`DIRECT_PATTERN`** — `.mp4`, `.webm`, `.mov` → type `'direct'`
3. **`CDN_VIDEO_PATTERN`** — CDN paths like `/dash/`, `/hls/`, `/video/` containing video extensions
4. **`KNOWN_CDN_PATTERN`** — Hardcoded CDN domains (OnlyFans, Fansly, etc.)
5. **`CLOUDFRONT_SIGNED_VIDEO`** — CloudFront signed URLs containing video extensions or `/source` paths
6. **`CDN_PATH_VIDEO`** — Broad path-based detection (`/files/.../source`, `/uploads/.../video`, etc.)
7. **`SEGMENT_PATTERN`** — `.ts`, `.m4s` → type `'segment'` (only if nothing else detected yet)

Captures the **full request headers** (cookies, referer, UA) for *every* request into a bounded header cache (500 entries). This ensures that content-type-based detections in `onHeadersReceived` can still retrieve the original request headers.

### `onHeadersReceived` — Content-type fallback + CSP stripping

1. **Content-type detection** — Checks `Content-Type` response headers for `video/*`, `application/x-mpegurl`, `application/dash+xml`. Also matches `application/octet-stream` but *only* if the URL looks like it could be video. Catches CDN URLs that don't have obvious file extensions.
2. **Header enrichment** — Uses the header cache from `onBeforeSendHeaders` to attach the original request headers to content-type-detected streams (so downloads get auth cookies/referer).
3. **CSP stripping** — Deletes `Content-Security-Policy` and `Content-Security-Policy-Report-Only` headers from responses (except DRM license requests) so sites render correctly in the embedded view.

---

## 7. How Downloads Work (`downloader.js`)

### Strategy selection

| Stream type | Tool | Method |
|---|---|---|
| `'stream'` (m3u8/mpd) | **ffmpeg** | `-c copy` remux, headers via `-headers` flag |
| `'direct'` (mp4/webm) | **Direct HTTP → ffmpeg → yt-dlp** | Tries in order; all use enriched headers |
| Page-level download | **yt-dlp** first, **ffmpeg** fallback | yt-dlp with `--cookies` and `--referer` |

### Header enrichment

Before any download attempt, `_enrichHeadersWithCookies(url, headers)` reads session cookies
for the URL's domain and merges them in. This enriched object is passed to **all three**
download methods (HTTP, ffmpeg, yt-dlp). The yt-dlp path also independently exports the
full session cookie jar via `_exportCookies('persist:browse')`.

> **Important:** Always pass `enrichedHeaders` (not the original `headers`) to every tool,
> including the yt-dlp last-resort fallback in `download()`. Passing bare `headers` there was
> a bug that has been fixed.

### Cookie export flow

1. `session.fromPartition('persist:browse').cookies.get({})` reads all cookies from the Electron session
2. Cookies are written to a temp file in **Netscape cookie jar format** (the format yt-dlp expects)
3. Temp file is passed to yt-dlp via `--cookies <path>`
4. Temp file is deleted after the download completes (or fails)

### Progress reporting

- **ffmpeg**: Parses `time=HH:MM:SS.ms` from stderr. If the stream is HLS, pre-fetches the `.m3u8` to sum `#EXTINF` durations for a total, enabling percentage calculation.
- **yt-dlp**: Parses `XX.X%` from stdout.

### Post-download DRM validation

After every successful download (both `download()` and `downloadPageUrl()`), `_validateDownload`
runs `ffprobe` on the file to confirm it has at least one video stream with dimensions > 10×10.
DRM-encrypted content often produces files with 0×0 dimensions or no decodable streams — this
catches the "green blocky screen" case and deletes the corrupt file, reporting an error instead
of a false success.

`downloadPageUrl` writes directly to the user-chosen `savePath` (not `%(title)s`) so the output
path is always known and validation is straightforward.

### Error handling

- **Transient failures**: Auto-retry up to 2 times with exponential backoff (`2s * attempt`)
- **HTTP 403/410** (expired tokens): Marked as `expired` — user must re-navigate the page to get fresh URLs
- **DRM-encrypted output**: Caught by `_validateDownload` post-download; file deleted, error shown
- **Unsupported site** (yt-dlp): Falls back to ffmpeg using the best intercepted stream
- **Partial files**: Cleaned up on permanent failure

### Process management

- Each spawned process is tracked in `this.active` map by ID
- Cancellation uses `taskkill /pid <pid> /T /F` on Windows (kills the process tree)

---

### Element Picker vs Auto-detected Stream Parity

Both paths ultimately call `downloader.download(streamInfo)` with a `StreamInfo` object.
The key difference is how headers are populated at creation:

| Source | Headers at creation |
|---|---|
| `Interceptor` (auto-detect) | Full captured request headers (Cookie, Referer, UA, Origin) |
| Element picker (`pick-video-element`) | `{ Referer: currentPageUrl }` — set before the pick starts |

The Referer is critical for CDN auth. Cookies are always supplemented by `_enrichHeadersWithCookies`
and the yt-dlp cookie jar export regardless of source.

---

## 8. UI Structure (`index.html` + `renderer.js`)

### Layout

```
┌──────────────────────────────────────────────────────┐
│ [←] [→] [⟳] [────── URL input ──────] [🎯] [📹 3]  │  ← 52px nav bar
├──────────────────────────────────────┬───────────────┤
│                                      │  Sidebar      │
│         BrowserView                  │  - Streams    │
│         (managed by main.js,         │  - Page DL    │
│          not in this HTML)           │  - Downloads  │
│                                      │  (360px)      │
└──────────────────────────────────────┴───────────────┘
```

- **Nav bar** (52px): Back, Forward, Reload, URL input, Pick element (🎯), Streams toggle (📹 with badge)
- **Sidebar** (360px, slide-out right): Detected streams list, "Download Page Video" button, active downloads
- **Welcome screen**: Shown when no URL is loaded; hidden once navigation begins
- **DRM banner**: Appears when MediaKey errors detected in BrowserView console
- **Tool warning**: Appears if ffmpeg/yt-dlp aren't found on PATH

### Keyboard shortcuts (handled in `renderer.js`)

| Shortcut | Action |
|---|---|
| `Ctrl+L` | Focus + select URL bar |
| `F5` | Reload |
| `Alt+Left` | Back |
| `Alt+Right` | Forward |
| `Escape` | Cancel element picker |

---

## 9. Special Considerations

### Castlabs Electron + Widevine

- The `package.json` uses a **git URL** for Electron, pointing to the Castlabs fork. `npm install` downloads it. The `--no-sandbox` and `--disable-features=RendererCodeIntegrity` flags in `main.js` are required for CDM loading on Windows.
- DRM permissions (`protected-media-identifier`, `media`, `mediaKeySystem`) are explicitly allowed in `setPermissionRequestHandler`.

### `launch.js` wrapper

`npm start` runs `node launch.js`, not `electron .` directly. This is because VS Code's integrated terminal (and other Electron-based editors) set `ELECTRON_RUN_AS_NODE=1`, which makes the `electron` binary run as plain Node instead of Electron. `launch.js` strips this env var before spawning.

### `scripts/postinstall.js`

Patches `node_modules/electron/index.js` to handle the case where `require('electron')` is called from *inside* an Electron process. Without this patch, the npm-installed `electron` package would shadow the built-in `electron` module, causing `app`, `BrowserWindow`, etc. to be undefined.

### User-Agent

The BrowserView's User-Agent is hardcoded to a standard Chrome UA string. This is critical — many sites (especially OK.ru) reject non-standard UAs or serve different content (no video) to Electron's default UA.

### No `<webview>`, no second preload

v1 does NOT inject any preload or scripts into the web content loaded in the BrowserView. All stream detection is network-level only (via `session.webRequest`). A MediaSource interception preload is listed as v2 future work.

---

## 10. Data Flow: Typical Download

```
 User types URL → renderer.js → IPC 'navigate' → main.js → browseView.loadURL()
                                                             ↓
                                         Site loads, requests fire
                                                             ↓
                                  interceptor.js hooks see .m3u8 request
                                  captures URL + headers + cookies
                                                             ↓
                                  emits 'stream-detected' → IPC → renderer
                                  renderer shows badge + sidebar card
                                                             ↓
 User clicks "Download" → renderer → IPC 'download' → main.js → downloader.download()
                                                                      ↓
                                                         dialog.showSaveDialog()
                                                                      ↓
                                                    ffmpeg spawned with -headers and -i <url>
                                                    progress parsed from stderr
                                                    sent back via IPC 'download-progress'
                                                                      ↓
                                                         renderer shows progress bar
                                                         status: complete / error / expired
```

---

## 11. How to Run

```bash
cd blob-video-downloader
npm install          # Installs Castlabs Electron (large download, ~200MB)
npm start            # Runs launch.js → spawns Electron
```

**Prerequisites on PATH:** `ffmpeg` and `yt-dlp` (the app checks at startup and shows a warning if missing).

---

## 12. Conventions & Patterns

1. **CommonJS everywhere** — `require()` / `module.exports`, no ES modules
2. **No TypeScript** — Plain `.js` files
3. **No framework** — Vanilla DOM manipulation in `renderer.js`
4. **Single CSS file** — All styles in `styles.css`, no CSS modules or preprocessors
5. **IPC via preload** — All cross-process communication goes through `preload.js`; the renderer never touches `ipcRenderer` directly
6. **Dark theme** — Color palette: `#0f0f13` (bg), `#1a1a22` (surfaces), `#2a2a38` (borders), `#5a5aff` (accent), `#5aff8a` (success), `#ff5a5a` (error), `#ffaa5a` (warning)
7. **Process cleanup** — Every spawned child process uses `taskkill /T /F` for tree-kill on Windows
8. **Temp file hygiene** — Cookie jar files are written to `os.tmpdir()` and deleted after use

---

## 13. Known Limitations / v2 Roadmap

| Limitation | Future Fix |
|---|---|
| No MediaSource/blob interception | v2: inject preload into BrowserView to monkey-patch `MediaSource.addSourceBuffer` |
| No tabs | v2: multiple `BrowserView` instances with tab bar |
| No download queue | v2: configurable max concurrency |
| No format/quality selection | v2: pick quality before downloading |
| Hardcoded CDN patterns | Continuously expand regex patterns in `interceptor.js` |
| Windows-centric process kill | Works on Linux via `-SIGTERM` but untested |
