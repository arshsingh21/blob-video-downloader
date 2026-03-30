# Video Downloader Browser — Electron App

Build a minimal Electron-based browser with built-in video stream detection and download capabilities. The key insight: by browsing inside our app, we **inherit the exact cookies, headers, referer, and session** the site expects — solving the auth/header problem you hit with ok.ru.

## Decisions

- **Default homepage**: Blank page (custom welcome screen with brief usage hint)
- **Download location**: Prompt user to choose location each time (via native save dialog)
- **Tabs**: No tabs — single-view browser
- **Window chrome**: Default Electron frame (native min/max/close)
- **MediaSource interception**: Deferred to v2 — v1 relies on network-level interception only

## User Review Required

> [!IMPORTANT]
> **Complete project replacement** — the current single-file `index.html` will be replaced with an Electron app in the same directory. The old bookmarklet approach is abandoned in favor of a real browser.

> [!WARNING]
> **ffmpeg and yt-dlp are required on your system.** The app will use your existing installs at:
> - `C:\Users\arshs\AppData\Local\Microsoft\WinGet\Links\yt-dlp.exe`
> - `C:\Users\arshs\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe`
>
> We will NOT bundle these (would add ~200MB). Instead we'll detect them at runtime and show an error if missing.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Electron Main Process                                 │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Network Interceptor (session.webRequest)        │  │
│  │  - Uses dedicated session.fromPartition()        │  │
│  │  - Detects .m3u8, .mpd, .mp4, .webm, .ts URLs   │  │
│  │  - Captures request headers + cookies            │  │
│  │  - Strips restrictive CSP via onHeadersReceived  │  │
│  │  - Sends detected streams to renderer via IPC    │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Download Manager                                │  │
│  │  - Spawns ffmpeg for HLS/DASH streams            │  │
│  │  - Spawns yt-dlp for complex sites               │  │
│  │  - Direct fetch for mp4/webm files               │  │
│  │  - Exports cookies from session → temp cookie    │  │
│  │    jar file for yt-dlp (--cookies flag)           │  │
│  │  - Passes captured headers to tools              │  │
│  │  - Prompts for save location via native dialog   │  │
│  │  - Retries on transient failures, re-detects     │  │
│  │    on expired stream tokens                      │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
        ↕ IPC
┌────────────────────────────────────────────────────────┐
│  Electron Renderer (UI)                                │
│  ┌──────────────┐ ┌─────────────────────────────────┐  │
│  │  Nav Bar      │ │  WebContentsView (web content)  │  │
│  │  URL + btns   │ │  ← actual website renders here  │  │
│  └──────────────┘ └─────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Downloads Panel (slide-out sidebar)             │  │
│  │  - Detected streams list                        │  │
│  │  - Download progress bars                       │  │
│  │  - Download history                             │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

## Proposed Changes

### Project Setup

#### [NEW] package.json
- Electron app config, scripts (`npm start` to launch)
- Dependencies: `electron` (dev)

---

### Main Process

#### [NEW] main.js
Core Electron main process:
- Creates `BrowserWindow` with default frame (native window controls)
- Creates a `WebContentsView` for the actual web content (NOT `<webview>` — it is deprecated)
- Uses a dedicated `session.fromPartition('browse')` to isolate web content from DevTools/app traffic
- Attaches network interceptor to the partitioned session
- Syncs the URL bar to the actual navigated URL via `did-navigate` / `did-navigate-in-page` events (prevents phishing via redirect)
- Handles IPC for navigation, downloads, detected streams
- Opens native save dialog when user clicks download
- Registers keyboard shortcuts: Ctrl+L (focus URL bar), F5 (reload), Alt+Left/Right (back/forward)

#### [NEW] interceptor.js
Network request interceptor module:
- Hooks into `session.webRequest.onBeforeRequest` with URL filters
- Also uses `onBeforeSendHeaders` to capture full request headers
- Uses `onHeadersReceived` to strip/relax Content-Security-Policy headers on browsed pages (many sites like ok.ru set strict CSP that would block injected scripts)
- Detects `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.mov`, `.ts`, `.m4s` requests
- Captures cookies, referer, user-agent from the actual browser session
- Deduplicates detected streams
- Emits events when new streams are found

#### [NEW] downloader.js
Download manager module:
- **HLS/DASH** → spawns `ffmpeg -i <url> -headers <captured_headers> -c copy <user_chosen_path>`
- **Direct video** → spawns `ffmpeg` or uses Node `https` stream
- **Complex sites** → spawns `yt-dlp` with `--cookies <temp_cookie_jar>` and `--add-header` for non-cookie headers
- **Cookie export**: uses `session.cookies.get({})` to read cookies from the Electron session, writes a Netscape-format cookie jar to a temp file, passes it to yt-dlp via `--cookies`. Cleans up temp file after download completes.
- **Progress reporting**:
  - For ffmpeg: parses stderr for `time=HH:MM:SS.ms`; pre-parses the m3u8 `#EXTINF` durations to calculate total duration for percentage. Falls back to indeterminate progress if duration is unknown.
  - For yt-dlp: parses stdout for `XX.X%`
- **Error handling & retries**:
  - Transient failures (network drop, ffmpeg/yt-dlp crash): auto-retry up to 2 times with backoff
  - Expired stream token (HTTP 403/410): notify user that the stream expired, prompt to re-navigate the page so the interceptor can capture a fresh URL
  - Cleans up partial files on permanent failure
- Manages concurrent downloads, cancellation
- Uses `dialog.showSaveDialog()` to prompt for save location each time

---

### Renderer (UI)

#### [DELETE → REPLACE] index.html
The old static page is replaced with the browser UI.

#### [NEW] index.html
Minimal browser UI (no tabs, single view):
- **Top nav bar**: Back/Forward/Reload buttons, URL input, Downloads badge button
- **Main area**: Container `<div>` that hosts the `WebContentsView` (managed by main process, positioned to fill available space)
- **Right sidebar** (slide-out): Detected streams + active downloads with progress
- **Welcome page**: When no URL is loaded, shows a brief usage hint ("Type a URL to start browsing. Video streams will be detected automatically.")

#### [NEW] renderer.js
Renderer logic:
- Manages nav bar interactions (URL entry, back/forward/reload)
- Updates URL bar from `did-navigate` events received via IPC (shows the actual URL, not just user input)
- Listens for detected streams via IPC, updates sidebar
- Handles download button clicks → sends IPC to main → main opens save dialog
- Shows download progress bars (determinate when duration known, indeterminate otherwise)
- Notifications when downloads complete
- Keyboard shortcut handling for Ctrl+L, F5, etc.

#### [NEW] styles.css
Dark theme styling for the browser chrome:
- Matches current `#0f0f13` / `#1a1a22` / `#5a5aff` palette
- Nav bar, sidebar, progress bars, stream cards

---

### Preload

#### [NEW] preload.js
App preload — bridges IPC between the renderer (browser chrome UI) and main process:
- Exposes safe IPC bridge (`contextBridge.exposeInMainWorld`)
- Provides `window.api.navigate(url)`, `window.api.download(streamInfo)`, `window.api.onStreamDetected(callback)`, `window.api.onUrlChanged(callback)`, etc.

> **Note**: A second preload for web content (MediaSource interception) is deferred to v2. In v1, all stream detection happens at the network level via `webRequest` — no scripts are injected into browsed pages.

## Key Features

| Feature | How it works |
|---|---|
| **Blank start page** | App opens to a welcome screen with usage hint — type a URL to start browsing |
| **Auto-detect HLS/DASH** | `webRequest` intercepts `.m3u8`/`.mpd` URLs as the page loads |
| **Auto-detect direct video** | `webRequest` intercepts `.mp4`/`.webm`/`.mov` URLs |
| **Correct headers** | Cookies, Referer, User-Agent captured from the actual browser session |
| **Cookie jar export** | Electron session cookies exported to Netscape-format temp file for yt-dlp |
| **CSP stripping** | `onHeadersReceived` relaxes CSP so sites render correctly in the embedded view |
| **Session isolation** | Dedicated `session.fromPartition('browse')` prevents DevTools/app noise in interceptor |
| **URL bar sync** | Nav bar always shows the real navigated URL, not just user input |
| **Save dialog** | Native OS file picker prompts for download location every time |
| **One-click download** | Click download → pick location → ffmpeg/yt-dlp spawned with correct headers + cookies |
| **Progress tracking** | Parse m3u8 for total duration + ffmpeg stderr for time progress; yt-dlp stdout for % |
| **Error recovery** | Auto-retry on transient failures; prompt to re-navigate on expired tokens |
| **Keyboard shortcuts** | Ctrl+L (URL bar), F5 (reload), Alt+Left/Right (back/forward) |
| **Single view** | No tabs — simple, focused browser window |

## v2 — Future Enhancements

| Feature | Details |
|---|---|
| **MediaSource interception** | Inject a second preload into the `WebContentsView` web content that monkey-patches `MediaSource.addSourceBuffer` and `SourceBuffer.appendBuffer` to reconstruct segments and extract manifest URLs. Requires a separate preload security context from the app preload. |
| **Tabbed browsing** | Multiple `WebContentsView` instances with a tab bar |
| **Download queue** | Configurable max concurrent downloads with queuing |
| **Format selection** | Let user pick quality/format before downloading |

## Verification Plan

### Automated Tests
- Launch the Electron app via `npm start`
- Navigate to a test site with HLS content
- Verify stream detection badge appears
- Trigger download and verify save dialog opens
- Verify ffmpeg/yt-dlp subprocess spawns with correct headers and cookie jar

### Manual Verification
- Navigate to ok.ru video page → verify `.m3u8` detected → download succeeds with correct auth
- Navigate to a YouTube page → verify yt-dlp download works
- Test direct `.mp4` URL download
- Verify save dialog appears and file is saved to chosen location
- Verify URL bar updates after redirects
- Verify keyboard shortcuts work
- Test error recovery: kill ffmpeg mid-download → verify retry and partial cleanup
