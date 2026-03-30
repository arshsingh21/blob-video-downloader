# Fix 403 and MediaKey Errors

The current implementation has a race condition in header capture and lacks standard browser identification, leading to `403 Forbidden` errors during downloads and `MediaKey` errors during playback.

## User Review Required

> [!IMPORTANT]
> To fix the `MediaKey` error, I will be setting a standard Chrome User-Agent. This will make the browser identify as a regular Chrome instance, which is necessary for many DRM-protected sites (like OK.ru) to serve content correctly.

## Proposed Changes

### Interceptor & Network Logic

#### [MODIFY] [interceptor.js](file:///c:/Users/arshs/.gemini/antigravity/blob-video-downloader/interceptor.js)
- Fix the race condition by capturing both the URL and headers in `onBeforeSendHeaders`.
- Ensure all relevant headers (`Referer`, `Cookie`, `Origin`, `User-Agent`) are captured and passed to the downloader.
- Refine CSP stripping to be more targeted, ensuring we don't break DRM handshakes.

### Browser Configuration

#### [MODIFY] [main.js](file:///c:/Users/arshs/.gemini/antigravity/blob-video-downloader/main.js)
- Set a standard Chrome User-Agent for the `BrowserView`.
- Ensure Widevine is correctly initialized by adding necessary command-line switches if the `components` API isn't sufficient for the specific site.
- Explicitly enable `plugins` and `web-security` (with caution) where necessary for DRM.

### Downloader Execution

#### [MODIFY] [downloader.js](file:///c:/Users/arshs/.gemini/antigravity/blob-video-downloader/downloader.js)
- Improve how headers are passed to `ffmpeg` by using a more robust format.
- Ensure `yt-dlp` receives all captured headers, not just a subset.

## Open Questions

- Are there specific sites other than OK.ru where you are seeing these errors? (The fix for OK.ru might differ slightly from others like Netflix or YouTube).

## Verification Plan

### Automated Tests
- I will use the browser tool to navigate to test sites and verify that streams are detected with full header sets.
- Monitor the Electron console for any remaining `MediaKey` or `403` errors.

### Manual Verification
- The user will need to navigate to the problematic video and attempt a playback/download to confirm the fix.
