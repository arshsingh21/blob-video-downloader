const { app, BrowserWindow, BrowserView, session, ipcMain, globalShortcut, components, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Interceptor = require('./interceptor');
const Downloader = require('./downloader');

let mainWindow;
let browseView;
let interceptor;
let downloader;

const PARTITION = 'persist:browse';

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
  downloader = new Downloader(mainWindow, interceptor, browseView);

  // BrowserView navigation events → sync URL bar
  browseView.webContents.on('did-navigate', (_e, url) => {
    mainWindow.webContents.send('url-changed', url);
  });
  browseView.webContents.on('did-navigate-in-page', (_e, url) => {
    mainWindow.webContents.send('url-changed', url);
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
          resolve({
            found: true,
            src: video.currentSrc || video.src || '',
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration,
            paused: video.paused,
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
