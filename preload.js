const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Navigation
  navigate: (url) => ipcRenderer.send('navigate', url),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),

  // URL bar sync
  onUrlChanged: (callback) => ipcRenderer.on('url-changed', (_e, url) => callback(url)),
  onTitleChanged: (callback) => ipcRenderer.on('title-changed', (_e, title) => callback(title)),
  onLoadingChanged: (callback) => ipcRenderer.on('loading-changed', (_e, loading) => callback(loading)),

  // Stream detection
  onStreamDetected: (callback) => ipcRenderer.on('stream-detected', (_e, stream) => callback(stream)),
  onStreamsCleared: (callback) => ipcRenderer.on('streams-cleared', () => callback()),
  getDetectedStreams: () => ipcRenderer.invoke('get-detected-streams'),
  clearDetectedStreams: () => ipcRenderer.send('clear-detected-streams'),

  // Downloads
  download: (streamInfo) => ipcRenderer.invoke('download', streamInfo),
  cancelDownload: (id) => ipcRenderer.send('cancel-download', id),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_e, data) => callback(data)),

  // Element picker
  pickVideoElement: () => ipcRenderer.invoke('pick-video-element'),

  // Sidebar
  toggleSidebar: (open) => ipcRenderer.send('toggle-sidebar', open),

  // Page-URL download (yt-dlp fallback for DRM content)
  getCurrentUrl: () => ipcRenderer.invoke('get-current-url'),
  downloadPageUrl: (url) => ipcRenderer.invoke('download-page-url', url),

  // Open file manager with file selected
  showInFolder: (filePath) => ipcRenderer.send('show-in-folder', filePath),

  // Video element highlighting (hover on stream card → glow in browser)
  highlightVideo: (url) => ipcRenderer.send('highlight-video', url),
  unhighlightVideo: () => ipcRenderer.send('unhighlight-video'),

  // DRM error notifications
  onDrmError: (callback) => ipcRenderer.on('drm-error', (_e, message) => callback(message)),

  // Tool availability check
  checkTools: () => ipcRenderer.invoke('check-tools'),

  // DRM / CDM configuration
  getDrmStatus: () => ipcRenderer.invoke('get-drm-status'),
  setCdmDir: (dir) => ipcRenderer.invoke('set-cdm-dir', dir),
  pickCdmDir: () => ipcRenderer.invoke('pick-cdm-dir'),

  // App settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  pickDownloadDir: () => ipcRenderer.invoke('pick-download-dir'),
});
