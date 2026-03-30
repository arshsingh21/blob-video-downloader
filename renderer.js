// ── DOM refs ──────────────────────────────────────────────────────────────────
const urlInput        = document.getElementById('url-input');
const btnBack         = document.getElementById('btn-back');
const btnForward      = document.getElementById('btn-forward');
const btnReload       = document.getElementById('btn-reload');
const btnStreams       = document.getElementById('btn-streams');
const streamBadge     = document.getElementById('stream-badge');
const sidebar         = document.getElementById('sidebar');
const btnCloseSB      = document.getElementById('btn-close-sidebar');
const streamList      = document.getElementById('stream-list');
const downloadList    = document.getElementById('download-list');
const welcome         = document.getElementById('welcome');
const toolWarning     = document.getElementById('tool-warning');
const toolWarnText    = document.getElementById('tool-warning-text');
const btnPick         = document.getElementById('btn-pick');
const drmBanner       = document.getElementById('drm-banner');
const btnDrmDownload  = document.getElementById('btn-drm-download');
const btnDrmDismiss   = document.getElementById('btn-drm-dismiss');
const btnPageDownload = document.getElementById('btn-page-download');

let detectedStreams = [];
let downloads = {};  // id -> state

// ── Navigation ────────────────────────────────────────────────────────────────
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = urlInput.value.trim();
    if (url) {
      window.api.navigate(url);
      welcome.classList.add('hidden');
    }
  }
});

btnBack.addEventListener('click', () => window.api.goBack());
btnForward.addEventListener('click', () => window.api.goForward());
btnReload.addEventListener('click', () => window.api.reload());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'l') {
    e.preventDefault();
    urlInput.focus();
    urlInput.select();
  }
  if (e.key === 'F5') {
    e.preventDefault();
    window.api.reload();
  }
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    window.api.goBack();
  }
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    window.api.goForward();
  }
});

// URL bar sync
window.api.onUrlChanged((url) => {
  urlInput.value = url;
  if (url && url !== 'about:blank') {
    welcome.classList.add('hidden');
  }
});

window.api.onTitleChanged((title) => {
  // Title shown in window frame by main process
});

window.api.onLoadingChanged((loading) => {
  if (loading) {
    btnReload.classList.add('loading');
  } else {
    btnReload.classList.remove('loading');
  }
});

// ── Stream Detection ──────────────────────────────────────────────────────────
window.api.onStreamDetected((stream) => {
  // Avoid duplicates in our local list
  if (detectedStreams.some(s => s.url === stream.url)) return;
  detectedStreams.push(stream);
  updateStreamBadge();
  renderStreams();
});

// Clear stale streams whenever the page navigates (refresh, back/forward, SPA route change)
// so expired CloudFront tokens don't sit in the sidebar.
window.api.onStreamsCleared(() => {
  detectedStreams = [];
  updateStreamBadge();
  renderStreams();
});

function updateStreamBadge() {
  const count = detectedStreams.length;
  streamBadge.textContent = count;
  if (count > 0) {
    streamBadge.classList.remove('hidden');
  } else {
    streamBadge.classList.add('hidden');
  }
}

function renderStreams() {
  streamList.innerHTML = '';
  if (detectedStreams.length === 0) {
    streamList.innerHTML = '<p style="color:#666;font-size:0.8rem;padding:8px;">No streams detected yet. Browse to a video page.</p>';
    return;
  }

  for (const stream of detectedStreams) {
    const card = document.createElement('div');
    card.className = 'stream-card';

    const typeLabel = stream.type === 'stream' ? 'HLS / DASH' : stream.type === 'direct' ? 'Direct Video' : 'Segment';
    const drmBadge = stream.drm ? '<span class="drm-badge">DRM</span>' : '';
    const downloadLabel = stream.drm ? 'Download (DRM Decrypt)' : 'Download';
    const labelHtml = stream.label ? `<div class="stream-label">${escapeHtml(stream.label)}</div>` : '';

    card.innerHTML = `
      <div class="stream-type">${typeLabel} ${drmBadge}</div>
      ${labelHtml}
      ${stream.drm ? '<div class="stream-drm-note">🔓 DRM-protected — will decrypt with Widevine pipeline</div>' : ''}
      <div class="stream-url" title="${escapeHtml(stream.url)}">${escapeHtml(truncateUrl(stream.url))}</div>
      <div class="stream-actions">
        <button class="btn-download">${downloadLabel}</button>
        <button class="btn-locate">Locate</button>
        <button class="btn-copy-url">Copy URL</button>
      </div>
    `;

    // "Locate" button — highlights the matching video element in the browser until clicked again
    let locateActive = false;
    card.querySelector('.btn-locate').addEventListener('click', () => {
      locateActive = !locateActive;
      // Clear any other active locate buttons first
      document.querySelectorAll('.btn-locate.active').forEach(b => {
        b.classList.remove('active');
        b.textContent = 'Locate';
      });
      if (locateActive) {
        card.querySelector('.btn-locate').classList.add('active');
        card.querySelector('.btn-locate').textContent = 'Located ✓';
        window.api.highlightVideo(stream.url);
      } else {
        window.api.unhighlightVideo();
      }
    });

    card.querySelector('.btn-download').addEventListener('click', () => {
      window.api.download(stream);
    });

    card.querySelector('.btn-copy-url').addEventListener('click', (e) => {
      navigator.clipboard.writeText(stream.url);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy URL'; }, 1500);
    });

    streamList.appendChild(card);
  }
}

// ── Sidebar Toggle ────────────────────────────────────────────────────────────
function openSidebar() {
  sidebar.classList.remove('hidden');
  window.api.toggleSidebar(true);
  renderStreams();
  renderDownloads();
}

function closeSidebar() {
  sidebar.classList.add('hidden');
  window.api.toggleSidebar(false);
}

btnStreams.addEventListener('click', () => {
  if (sidebar.classList.contains('hidden')) {
    openSidebar();
  } else {
    closeSidebar();
  }
});

btnCloseSB.addEventListener('click', closeSidebar);

// ── Downloads ─────────────────────────────────────────────────────────────────
let downloadStartTimes = {};  // id -> timestamp

window.api.onDownloadProgress((data) => {
  if (!downloadStartTimes[data.id]) {
    downloadStartTimes[data.id] = Date.now();
  }
  downloads[data.id] = data;
  renderDownloads();
});

function renderDownloads() {
  downloadList.innerHTML = '';
  const ids = Object.keys(downloads);
  if (ids.length === 0) {
    downloadList.innerHTML = '<p style="color:#666;font-size:0.8rem;padding:8px;">No active downloads.</p>';
    return;
  }

  for (const id of ids) {
    const dl = downloads[id];
    const card = document.createElement('div');
    card.className = 'download-card';

    const name = dl.savePath ? dl.savePath.split(/[/\\]/).pop() : 'video';
    const statusClass = dl.status === 'error' ? 'error' : dl.status === 'complete' ? 'complete' : dl.status === 'expired' ? 'expired' : '';
    const statusText = formatStatus(dl);

    let progressHtml = '';
    if (dl.status === 'downloading' || dl.status === 'starting' || dl.status === 'retrying') {
      if (dl.percent != null) {
        progressHtml = `<div class="progress-bar"><div class="progress-fill" style="width:${dl.percent}%"></div></div>`;
      } else {
        progressHtml = `<div class="progress-bar"><div class="progress-fill indeterminate"></div></div>`;
      }
    }

    let cancelHtml = '';
    if (dl.status === 'downloading' || dl.status === 'starting' || dl.status === 'retrying') {
      cancelHtml = `<button class="btn-cancel" data-id="${id}">Cancel</button>`;
    }

    let timerHtml = '';
    if (downloadStartTimes[id]) {
      const elapsed = formatElapsed(Date.now() - downloadStartTimes[id]);
      timerHtml = `<span class="download-timer">${elapsed}</span>`;
    }

    const showFolderHtml = dl.status === 'complete' && dl.savePath
      ? `<button class="btn-show-folder" data-path="${escapeHtml(dl.savePath)}">Show in Folder</button>`
      : '';

    card.innerHTML = `
      <div class="download-name" title="${escapeHtml(dl.savePath || name)}">${escapeHtml(name)}</div>
      <div class="download-status-row">
        <span class="download-status ${statusClass}">${statusText}</span>
        ${timerHtml}
      </div>
      ${progressHtml}
      ${cancelHtml}
      ${showFolderHtml}
    `;

    const cancelBtn = card.querySelector('.btn-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        window.api.cancelDownload(parseInt(id));
      });
    }

    const showBtn = card.querySelector('.btn-show-folder');
    if (showBtn) {
      showBtn.addEventListener('click', () => {
        window.api.showInFolder(showBtn.dataset.path);
      });
    }

    downloadList.appendChild(card);
  }
}

function formatStatus(dl) {
  switch (dl.status) {
    case 'starting':    return 'Starting...';
    case 'downloading':
      if (dl.tool === 'drm' && dl.step) return dl.step;
      return dl.percent != null ? `Downloading ${dl.percent}%${dl.tool ? ` (${dl.tool})` : ''}` : 'Downloading...';
    case 'retrying':    return `Retrying (attempt ${dl.attempt})...`;
    case 'complete':    return 'Complete';
    case 'cancelled':   return 'Cancelled';
    case 'expired':     return dl.message || 'Stream token expired';
    case 'error':       return dl.message || 'Download failed';
    default:            return dl.status;
  }
}

// ── Tool Check ────────────────────────────────────────────────────────────────
(async function checkTools() {
  const tools = await window.api.checkTools();
  const missing = [];
  if (!tools.ytdlp) missing.push('yt-dlp');
  if (!tools.ffmpeg) missing.push('ffmpeg');
  if (missing.length > 0) {
    toolWarnText.textContent = `Missing required tools: ${missing.join(', ')}. Install them for downloads to work.`;
    toolWarning.classList.remove('hidden');
  }

  // DRM tool warnings (non-blocking)
  const drmMissing = [];
  if (!tools.mp4decrypt) drmMissing.push('mp4decrypt (Bento4)');
  if (!tools.python) drmMissing.push('Python');
  if (drmMissing.length > 0) {
    console.log(`DRM tools not found: ${drmMissing.join(', ')}. DRM downloads will use external decryption service.`);
  }

  // Check CDM status
  const drmStatus = await window.api.getDrmStatus();
  if (drmStatus.hasCDM) {
    console.log('CDM files found — local Widevine decryption available.');
  }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return u.host + (path.length > 60 ? path.slice(0, 57) + '...' : path);
  } catch {
    return url.length > 80 ? url.slice(0, 77) + '...' : url;
  }
}

// ── Video Element Picker ──────────────────────────────────────────────────────
btnPick.addEventListener('click', async () => {
  if (btnPick.classList.contains('active')) return;
  btnPick.classList.add('active');
  btnPick.title = 'Click an element on the page (Esc to cancel)';

  // Capture current page URL before the pick so we can set Referer on the
  // synthetic stream — matching what the interceptor captures for auto-detected streams.
  const pageUrlForReferer = await window.api.getCurrentUrl();

  const result = await window.api.pickVideoElement();

  btnPick.classList.remove('active');
  btnPick.title = 'Pick video element on page';

  if (!result || result.cancelled) return;

  if (!result.found) {
    alert('No video element found near that element.');
    return;
  }

  // Pick the best non-blob src available
  let src = result.src;
  if ((!src || result.isBlob) && result.sources) {
    src = result.sources.find(s => s && !s.startsWith('blob:')) || src;
  }

  if (!src || src.startsWith('blob:')) {
    // Video uses MSE/blob — fall back to intercepted streams or page-URL download
    const interceptedMatch = detectedStreams.find(s =>
      s.type === 'stream' || (s.type === 'direct' && !s.url.startsWith('blob:'))
    );
    if (interceptedMatch) {
      // An intercepted stream is already in the sidebar — just open it
      openSidebar();
      renderStreams();
      return;
    }
    const use = confirm(
      `Video found (${result.width}×${result.height}) but uses a protected/blob source.\n\nDownload the page URL with yt-dlp instead?`
    );
    if (use) triggerPageDownload();
    return;
  }

  // Detect DRM: CDN domain alone is NOT enough — must also be a /dash/ path or explicit DRM marker.
  // Plain cdn*.onlyfans.com MP4s are clear (unencrypted) and download normally.
  const isDrm = (
    (/cdn\d*\.onlyfans\.com/i.test(src) || /cdn\d*\.fansly\.com/i.test(src))
      && /\/dash\//i.test(src)
  ) || /\/drm\//i.test(src) || /\/widevine\//i.test(src) || /cenc/i.test(src) || /clearkey/i.test(src);

  // Determine stream type
  const streamType = /\.m3u8|\.mpd|dash|hls/i.test(src) ? 'stream' : 'direct';

  // Build label from video dimensions/duration if available
  const label = result.width && result.height
    ? `${result.width}×${result.height}${result.duration && isFinite(result.duration) ? ` · ${Math.round(result.duration)}s` : ''}`
    : null;

  const stream = {
    url: src,
    type: streamType,
    headers: pageUrlForReferer ? { Referer: pageUrlForReferer } : {},
    drm: isDrm,
    label,
  };
  if (!detectedStreams.some(s => s.url === src)) {
    detectedStreams.push(stream);
    updateStreamBadge();
  }
  openSidebar();
  renderStreams();
});

// ── DRM Error Handling ───────────────────────────────────────────────────────
window.api.onDrmError(() => {
  drmBanner.classList.remove('hidden');
});

btnDrmDismiss.addEventListener('click', () => {
  drmBanner.classList.add('hidden');
});

// CDM setup button
const btnCdmSetup = document.getElementById('btn-cdm-setup');
if (btnCdmSetup) {
  btnCdmSetup.addEventListener('click', async () => {
    const result = await window.api.pickCdmDir();
    if (result) {
      if (result.hasCDM) {
        btnCdmSetup.textContent = 'CDM: Configured ✓';
        btnCdmSetup.classList.add('cdm-ok');
      } else {
        alert('CDM files not found in the selected directory.\nMake sure it contains:\n  - device_client_id_blob\n  - device_private_key');
      }
    }
  });

  window.api.getDrmStatus().then(status => {
    if (status.hasCDM) {
      btnCdmSetup.textContent = 'CDM: Configured ✓';
      btnCdmSetup.classList.add('cdm-ok');
    }
  });
}

// ── Download folder settings ──────────────────────────────────────────────────
const downloadDirDisplay    = document.getElementById('download-dir-display');
const btnPickDownloadDir    = document.getElementById('btn-pick-download-dir');
const btnOpenDownloadDir    = document.getElementById('btn-open-download-dir');

function setDownloadDirDisplay(dir) {
  if (!downloadDirDisplay) return;
  const short = dir.length > 38 ? '…' + dir.slice(-36) : dir;
  downloadDirDisplay.textContent = short;
  downloadDirDisplay.title = dir;
}

// Load persisted setting on startup
window.api.getSettings().then(s => setDownloadDirDisplay(s.downloadDir));

if (btnPickDownloadDir) {
  btnPickDownloadDir.addEventListener('click', async () => {
    const dir = await window.api.pickDownloadDir();
    if (dir) setDownloadDirDisplay(dir);
  });
}

if (btnOpenDownloadDir) {
  btnOpenDownloadDir.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (s.downloadDir) window.api.showInFolder(s.downloadDir);
  });
}

async function triggerPageDownload() {
  const url = await window.api.getCurrentUrl();
  if (!url || url === 'about:blank') return;
  window.api.downloadPageUrl(url);
  // Open sidebar to show download progress
  openSidebar();
}

btnDrmDownload.addEventListener('click', triggerPageDownload);
btnPageDownload.addEventListener('click', triggerPageDownload);

// Tick download timers every second
setInterval(() => {
  const hasActive = Object.values(downloads).some(
    dl => dl.status === 'downloading' || dl.status === 'starting' || dl.status === 'retrying'
  );
  if (hasActive && !sidebar.classList.contains('hidden')) {
    renderDownloads();
  }
}, 1000);

// Initial render
renderStreams();
