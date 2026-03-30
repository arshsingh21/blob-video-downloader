const { app, BrowserWindow, BrowserView, session, ipcMain, globalShortcut, components, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Interceptor = require('./interceptor');
const Downloader = require('./downloader');

// ── File Logging ──────────────────────────────────────────────────────────────
const LOG_PATH = path.join(__dirname, 'app.log');
// Keep last 5 log files (rotate on each launch)
for (let i = 4; i >= 1; i--) {
  const from = path.join(__dirname, `app.${i}.log`);
  const to   = path.join(__dirname, `app.${i + 1}.log`);
  try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch (_) {}
}
try { if (fs.existsSync(LOG_PATH)) fs.renameSync(LOG_PATH, path.join(__dirname, 'app.1.log')); } catch (_) {}

const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });

function writeLog(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')}\n`;
  logStream.write(line);
}

const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log   = (...args) => { _origLog(...args);   writeLog('INFO',  args); };
console.warn  = (...args) => { _origWarn(...args);  writeLog('WARN',  args); };
console.error = (...args) => { _origError(...args); writeLog('ERROR', args); };

process.on('uncaughtException',  (err) => console.error('UncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));

console.log(`Log file: ${LOG_PATH}`);

let mainWindow;
let browseView;
let interceptor;
let downloader;

const PARTITION = 'persist:browse';

// ── Persistent Settings ───────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = {
  downloadDir: 'C:\\Users\\arshs\\Downloads\\DL',
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

let appSettings = loadSettings();

// Fix "Sandbox cannot access executable" on Windows — required for CDM child process
app.commandLine.appendSwitch('no-sandbox');
// Disable RendererCodeIntegrity which blocks Widevine CDM loading on Windows
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    title: 'Video Downloader Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  // Create the BrowserView for web content with isolated session
  browseView = new BrowserView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
    },
  });

  mainWindow.setBrowserView(browseView);
  layoutBrowserView();
  browseView.webContents.loadURL('https://onlyfans.com/purchased');

  mainWindow.on('resize', layoutBrowserView);

  // Set a standard Chrome User-Agent so sites (ok.ru, etc.) don't reject us
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const browseSes = session.fromPartition(PARTITION);
  browseSes.setUserAgent(chromeUA);

  // Grant DRM (protected-media-identifier) and media permissions
  browseSes.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = [
      'protected-media-identifier',
      'media',
      'mediaKeySystem',
      'geolocation',
      'notifications',
    ];
    console.log('Permission request:', permission);
    callback(allowed.includes(permission));
  });

  browseSes.setPermissionCheckHandler((webContents, permission) => {
    const allowed = [
      'protected-media-identifier',
      'media',
      'mediaKeySystem',
    ];
    return allowed.includes(permission);
  });

  // Set up interceptor on the browse session
  interceptor = new Interceptor();
  interceptor.attach(browseSes);

  interceptor.on('stream-detected', (stream) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream-detected', stream);
    }
  });

  // Set up downloader
  downloader = new Downloader(mainWindow, interceptor, browseView, () => appSettings);

  // Attach CDP debugger to capture CDM-level license requests that bypass webRequest API
  try {
    browseView.webContents.debugger.attach('1.3');
    browseView.webContents.debugger.sendCommand('Network.enable');
    browseView.webContents.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        const reqMethod = params.request.method;
        // Log all OnlyFans API calls for debugging
        if (/onlyfans\.com\/api/i.test(url)) {
          console.log(`[CDP] OnlyFans API [${reqMethod}]: ${url}`);
        }
        // Capture license URLs — POST requests to DRM endpoints
        if (reqMethod === 'POST' && (
          /onlyfans\.com.*\/drm\//i.test(url) ||
          /\/(license|widevine|wv)\b/i.test(url)
        )) {
          console.log('[CDP] License URL captured:', url);
          const headers = params.request.headers || {};
          interceptor.storeLicenseUrl(url, headers);
        }
      }
    });
    console.log('CDP debugger attached to BrowserView');
  } catch (err) {
    console.warn('CDP debugger attach failed:', err.message);
  }

  // BrowserView navigation events → sync URL bar + clear stale streams
  browseView.webContents.on('did-navigate', (_e, url, isMainFrame) => {
    mainWindow.webContents.send('url-changed', url);
    // Full page navigation (reload, back/forward, new URL) → clear stale stream URLs
    // so expired CloudFront tokens don't persist in the sidebar.
    if (isMainFrame) {
      interceptor.clear();
      mainWindow.webContents.send('streams-cleared');
    }
  });
  browseView.webContents.on('did-navigate-in-page', (_e, url) => {
    mainWindow.webContents.send('url-changed', url);
    // SPA navigation (pushState) — clear streams too since the content changed
    interceptor.clear();
    mainWindow.webContents.send('streams-cleared');
  });
  browseView.webContents.on('page-title-updated', (_e, title) => {
    mainWindow.webContents.send('title-changed', title);
    mainWindow.setTitle(`${title} — Video Downloader Browser`);
  });
  browseView.webContents.on('did-start-loading', () => {
    mainWindow.webContents.send('loading-changed', true);
  });
  browseView.webContents.on('did-stop-loading', () => {
    mainWindow.webContents.send('loading-changed', false);
  });

  // Detect DRM / MediaKey errors from the BrowserView and forward to renderer
  browseView.webContents.on('console-message', (_e, level, message) => {
    if (/MediaKey|MediaKeySession|system code|CDM/.test(message)) {
      console.log('DRM error in page:', message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('drm-error', message);
      }
    }
  });

  // Handle new-window requests (e.g. target="_blank") — open in the same view
  browseView.webContents.setWindowOpenHandler(({ url }) => {
    browseView.webContents.loadURL(url);
    return { action: 'deny' };
  });
}

let sidebarOpen = false;
const SIDEBAR_WIDTH = 360;

function layoutBrowserView() {
  if (!mainWindow || !browseView) return;
  const bounds = mainWindow.getContentBounds();
  const navBarHeight = 52;
  const viewWidth = sidebarOpen ? bounds.width - SIDEBAR_WIDTH : bounds.width;
  browseView.setBounds({
    x: 0,
    y: navBarHeight,
    width: Math.max(viewWidth, 200),
    height: bounds.height - navBarHeight,
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.on('navigate', (_e, url) => {
  if (!browseView) return;
  // Auto-add https:// if no protocol
  if (url && !url.match(/^https?:\/\//i)) {
    // If it looks like a domain, add https. Otherwise treat as search (just add https).
    url = 'https://' + url;
  }
  interceptor.clear();
  browseView.webContents.loadURL(url);
});

ipcMain.on('toggle-sidebar', (_e, open) => {
  sidebarOpen = open;
  layoutBrowserView();
});

ipcMain.on('go-back', () => {
  if (browseView?.webContents.navigationHistory.canGoBack()) browseView.webContents.navigationHistory.goBack();
});

ipcMain.on('go-forward', () => {
  if (browseView?.webContents.navigationHistory.canGoForward()) browseView.webContents.navigationHistory.goForward();
});

ipcMain.on('reload', () => {
  browseView?.webContents.reload();
});

ipcMain.handle('get-detected-streams', () => {
  return interceptor.streams;
});

ipcMain.on('clear-detected-streams', () => {
  interceptor.clear();
});

ipcMain.handle('download', async (_e, streamInfo) => {
  return downloader.download(streamInfo);
});

ipcMain.on('cancel-download', (_e, id) => {
  downloader.cancel(id);
});

ipcMain.handle('pick-video-element', async () => {
  if (!browseView) return { cancelled: true };

  const script = `
    new Promise((resolve) => {
      const style = document.createElement('style');
      style.id = '__vdl_pick_style';
      style.textContent = \`
        body.__vdl_picking * { cursor: crosshair !important; }
        .__vdl_highlight { outline: 2px solid rgba(90,90,255,0.7) !important; outline-offset: 1px; }
        .__vdl_video_highlight { outline: 3px solid #5aff8a !important; outline-offset: 2px; }
      \`;
      document.head.appendChild(style);
      document.body.classList.add('__vdl_picking');

      let lastEl = null;

      function findNearestVideo(el) {
        if (!el) return null;
        if (el.tagName === 'VIDEO') return el;
        let ancestor = el.parentElement;
        for (let i = 0; i < 10 && ancestor; i++) {
          if (ancestor.tagName === 'VIDEO') return ancestor;
          ancestor = ancestor.parentElement;
        }
        let container = el;
        for (let i = 0; i < 5 && container; i++) {
          const v = container.querySelector('video');
          if (v) return v;
          container = container.parentElement;
        }
        return null;
      }

      function cleanup() {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('keydown', onKey, true);
        if (lastEl) lastEl.classList.remove('__vdl_highlight', '__vdl_video_highlight');
        document.body.classList.remove('__vdl_picking');
        const s = document.getElementById('__vdl_pick_style');
        if (s) s.remove();
      }

      function onMove(e) {
        if (lastEl) lastEl.classList.remove('__vdl_highlight', '__vdl_video_highlight');
        const video = findNearestVideo(e.target);
        lastEl = video || e.target;
        lastEl.classList.add(video ? '__vdl_video_highlight' : '__vdl_highlight');
      }

      function onClick(e) {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        const video = findNearestVideo(e.target);
        if (video) {
          // Collect all possible source URLs from the element
          const src = video.currentSrc || video.src || '';
          const sources = [src];
          // Also check <source> child elements (some players use these instead of src attr)
          for (const s of video.querySelectorAll('source')) {
            if (s.src) sources.push(s.src);
          }
          // dataset or data-src attributes used by lazy-loading players
          if (video.dataset && video.dataset.src) sources.push(video.dataset.src);

          resolve({
            found: true,
            src,
            sources: sources.filter((s, i, a) => s && a.indexOf(s) === i), // unique non-empty
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration,
            paused: video.paused,
            isBlob: src.startsWith('blob:'),
          });
        } else {
          resolve({ found: false });
        }
      }

      function onKey(e) {
        if (e.key === 'Escape') { cleanup(); resolve({ cancelled: true }); }
      }

      document.addEventListener('click', onClick, true);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('keydown', onKey, true);
    })
  `;

  try {
    return await browseView.webContents.executeJavaScript(script);
  } catch {
    return { cancelled: true };
  }
});

// Highlight the video element in the BrowserView whose src matches the given URL.
// Falls back to the largest visible video on the page when URL matching fails
ipcMain.on('show-in-folder', (_e, filePath) => {
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
});

// (e.g. after a DRM error tears down and recreates the video element).
ipcMain.on('highlight-video', (_e, url) => {
  if (!browseView) return;
  browseView.webContents.executeJavaScript(`
    (function() {
      // Clear any existing highlight first
      document.querySelectorAll('.__vdl_hover_hl').forEach(el => {
        el.classList.remove('__vdl_hover_hl');
        el.style.removeProperty('outline');
        el.style.removeProperty('outline-offset');
        el.style.removeProperty('box-shadow');
      });

      const target = ${JSON.stringify(url)};
      const stem = target ? target.split('?')[0].split('/').pop().replace(/\\.[^.]+$/, '') : '';
      const videos = Array.from(document.querySelectorAll('video'));
      if (!videos.length) return;

      // Strategy 1: exact src match
      let match = videos.find(v => {
        const src = v.currentSrc || v.src || '';
        return src && (src === target || (stem && src.includes(stem)));
      });

      // Strategy 2: closest visible video to the centre of the viewport
      if (!match) {
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        let bestDist = Infinity;
        for (const v of videos) {
          const r = v.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const dx = (r.left + r.width  / 2) - cx;
          const dy = (r.top  + r.height / 2) - cy;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < bestDist) { bestDist = dist; match = v; }
        }
      }

      // Strategy 3: largest video by area
      if (!match) {
        match = videos.reduce((best, v) => {
          const r = v.getBoundingClientRect();
          const br = best ? best.getBoundingClientRect() : { width: 0, height: 0 };
          return r.width * r.height > br.width * br.height ? v : best;
        }, null);
      }

      if (match) {
        match.classList.add('__vdl_hover_hl');
        match.style.outline = '3px solid #5aff8a';
        match.style.outlineOffset = '3px';
        match.style.boxShadow = '0 0 0 8px rgba(90,255,138,0.2)';
        match.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    })()
  `).catch(() => {});
});

ipcMain.on('unhighlight-video', () => {
  if (!browseView) return;
  browseView.webContents.executeJavaScript(`
    document.querySelectorAll('.__vdl_hover_hl').forEach(el => {
      el.classList.remove('__vdl_hover_hl');
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('box-shadow');
    });
  `).catch(() => {});
});

ipcMain.handle('get-current-url', () => {
  return browseView?.webContents.getURL() || '';
});

ipcMain.handle('download-page-url', async (_e, pageUrl) => {
  return downloader.downloadPageUrl(pageUrl);
});

ipcMain.handle('check-tools', async () => {
  const check = (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000, shell: true }, (err) => resolve(!err));
    });

  const [ytdlp, ffmpeg, mp4decrypt, python] = await Promise.all([
    check('yt-dlp', ['--version']),
    check('ffmpeg', ['-version']),
    check('mp4decrypt', ['--version']),
    check('python', ['--version']),
  ]);
  return { ytdlp, ffmpeg, mp4decrypt, python };
});

// ── DRM / CDM Configuration ──────────────────────────────────────────────────

ipcMain.handle('get-drm-status', () => {
  return {
    hasCDM: downloader.hasCDM(),
    cdmDir: downloader.drmHandler.cdmDir,
  };
});

ipcMain.handle('set-cdm-dir', async (_e, dir) => {
  downloader.setCdmDir(dir);
  return { hasCDM: downloader.hasCDM(), cdmDir: dir };
});

ipcMain.handle('pick-cdm-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select CDM Directory',
    properties: ['openDirectory'],
    message: 'Select the folder containing device_client_id_blob and device_private_key',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const dir = result.filePaths[0];
  downloader.setCdmDir(dir);
  return { hasCDM: downloader.hasCDM(), cdmDir: dir };
});

// ── App Settings ─────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => appSettings);

ipcMain.handle('set-setting', (_e, key, value) => {
  appSettings[key] = value;
  saveSettings(appSettings);
  return appSettings;
});

ipcMain.handle('pick-download-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Download Folder',
    defaultPath: appSettings.downloadDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const dir = result.filePaths[0];
  appSettings.downloadDir = dir;
  saveSettings(appSettings);
  return dir;
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (components) {
    try {
      // Don't block on CDM — pass empty array so app starts immediately.
      // The CDM will initialize in the background if/when it can.
      await components.whenReady([]);
      console.log('Component updater ready. CDM status:', JSON.stringify(components.status()));
    } catch (err) {
      console.error('Component updater error:', err);
    }
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
