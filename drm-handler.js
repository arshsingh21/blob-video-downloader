/**
 * DRM Handler — Widevine L3 decryption pipeline
 *
 * Flow: Fetch MPD → Extract PSSH → Get decryption key (pywidevine or external) →
 *       Download encrypted segments → Decrypt with mp4decrypt
 */

const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Widevine system ID in the DASH ContentProtection element
const WIDEVINE_SYSTEM_ID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

class DrmHandler {
  constructor(cdmDir, electronSession) {
    // cdmDir: directory containing device_client_id_blob + device_private_key
    this.cdmDir = cdmDir || null;
    this._pyScriptPath = path.join(__dirname, 'drm-keygen.py');
    this._session = electronSession || null; // Electron session for cookie access
  }

  /** Resolve CDM file path, accepting multiple naming conventions */
  _resolveCdmFile(type) {
    // type: 'blob' or 'key'
    const names = type === 'blob'
      ? ['device_client_id_blob', 'client_id.bin', 'client_id']
      : ['device_private_key', 'private_key.pem', 'private_key'];
    for (const name of names) {
      const p = path.join(this.cdmDir, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /** Check if local CDM files are configured */
  hasCDM() {
    if (!this.cdmDir) return false;
    return !!this._resolveCdmFile('blob') && !!this._resolveCdmFile('key');
  }

  /** Fetch an MPD manifest over HTTP(S) */
  async fetchMPD(mpdUrl, headers = {}) {
    return new Promise((resolve, reject) => {
      const mod = mpdUrl.startsWith('https') ? https : http;
      const reqHeaders = {};
      for (const key of ['Cookie', 'Referer', 'User-Agent', 'Origin']) {
        if (headers[key]) reqHeaders[key] = headers[key];
      }

      const req = mod.get(mpdUrl, { headers: reqHeaders }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this.fetchMPD(res.headers.location, headers).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`MPD fetch failed: HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('MPD fetch timed out')); });
    });
  }

  /**
   * Extract Widevine PSSH from MPD XML content.
   * Looks for <ContentProtection> with Widevine systemId, then <cenc:pssh> or <pssh>.
   */
  extractPSSH(mpdXml) {
    // Strategy 1: Find ContentProtection block with Widevine UUID, extract <pssh> or <cenc:pssh>
    const cpRegex = /<ContentProtection[^>]*schemeIdUri\s*=\s*"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*>([\s\S]*?)<\/ContentProtection>/gi;
    let match;
    while ((match = cpRegex.exec(mpdXml)) !== null) {
      const block = match[1];
      const psshMatch = block.match(/<(?:cenc:)?pssh[^>]*>\s*([A-Za-z0-9+/=]+)\s*<\/(?:cenc:)?pssh>/i);
      if (psshMatch) {
        return psshMatch[1].trim();
      }
    }

    // Strategy 2: Look for any <cenc:pssh> element (some MPDs put it outside ContentProtection)
    const globalPssh = mpdXml.match(/<(?:cenc:)?pssh[^>]*>\s*([A-Za-z0-9+/=]{20,})\s*<\/(?:cenc:)?pssh>/i);
    if (globalPssh) {
      return globalPssh[1].trim();
    }

    return null;
  }

  /**
   * Extract the license server URL from MPD (some MPDs embed it in <ms:laurl>).
   * Returns null if not found — caller should use an intercepted license URL.
   */
  extractLicenseUrl(mpdXml) {
    // <ms:laurl Lic_type="EME-1.0">https://...</ms:laurl>
    const laMatch = mpdXml.match(/<(?:ms:)?laurl[^>]*>\s*(https?:\/\/[^<]+)\s*<\/(?:ms:)?laurl>/i);
    if (laMatch) return laMatch[1].trim();

    // Widevine-specific: <widevine:license> element
    const wvMatch = mpdXml.match(/<(?:widevine:)?license[^>]*(?:src|url)\s*=\s*"([^"]+)"/i);
    if (wvMatch) return wvMatch[1].trim();

    // licenseAcquisitionURL attribute inside ContentProtection
    const lacMatch = mpdXml.match(/licenseAcquisitionURL\s*=\s*"([^"]+)"/i);
    if (lacMatch) return lacMatch[1].trim();

    // Any https URL inside a Widevine ContentProtection block
    const cpBlock = mpdXml.match(/<ContentProtection[^>]*edef8ba9-79d6-4ace-a3c8-27dcd51d21ed[^>]*>([\s\S]*?)<\/ContentProtection>/i);
    if (cpBlock) {
      const urlInBlock = cpBlock[1].match(/https?:\/\/[^\s"'<>]+/i);
      if (urlInBlock) return urlInBlock[0].trim();
    }

    // Last resort: any URL in the MPD that looks like a license endpoint
    const anyLicense = mpdXml.match(/https?:\/\/[^\s"'<>]*\/(license|drm|widevine|wv)[^\s"'<>]*/i);
    if (anyLicense) return anyLicense[0].trim();

    return null;
  }

  /**
   * Get decryption key using local CDM via pywidevine subprocess.
   * Returns array of { kid, key } objects.
   */
  async getDecryptionKeyCDM(pssh, licenseUrl, headers = {}) {
    if (!this.hasCDM()) {
      throw new Error('CDM files not configured. Place device_client_id_blob and device_private_key in the CDM directory.');
    }

    const blobPath = this._resolveCdmFile('blob');
    const keyPath = this._resolveCdmFile('key');

    // Build headers JSON for the Python script
    const headersJson = JSON.stringify(headers);

    return new Promise((resolve, reject) => {
      const proc = spawn('python', [
        this._pyScriptPath,
        '--pssh', pssh,
        '--license-url', licenseUrl,
        '--client-id', blobPath,
        '--private-key', keyPath,
        '--headers', headersJson,
      ], { shell: false, timeout: 30000 });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`pywidevine failed (code ${code}): ${stderr || stdout}`));
          return;
        }
        try {
          const keys = JSON.parse(stdout.trim());
          if (!Array.isArray(keys) || keys.length === 0) {
            reject(new Error('No content keys returned from CDM'));
            return;
          }
          resolve(keys);
        } catch (e) {
          reject(new Error(`Failed to parse CDM output: ${stdout}`));
        }
      });

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('Python not found. Install Python and pywidevine: pip install pywidevine'));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Get decryption key using external CDRM service (fallback, no CDM files needed).
   * Returns array of { kid, key } objects.
   */
  async getDecryptionKeyExternal(pssh, licenseUrl, headers = {}) {
    // External fallback — no CDM files needed but requires a public API service.
    // cdrm-project.com API endpoint (may change over time):
    const endpoints = [
      { url: 'https://cdrm-project.com/wv', method: 'POST' },
      { url: 'https://cdrm-project.com/api/wv', method: 'POST' },
    ];

    const postData = JSON.stringify({
      PSSH: pssh,
      License_URL: licenseUrl,
      Headers: this._formatHeadersForCDRM(headers),
      JSON: '',
      Cookies: headers['Cookie'] || '',
      Data: '',
      Proxy: '',
    });

    let lastError;
    for (const endpoint of endpoints) {
      try {
        const keys = await this._postCDRM(endpoint.url, postData);
        return keys;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `External DRM service unavailable (${lastError?.message}). ` +
      'Configure CDM files via Settings to use local decryption instead.'
    );
  }

  _postCDRM(url, postData) {
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`CDRM API returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            const keys = this._parseCDRMResponse(body);
            if (keys.length === 0) {
              reject(new Error('No content keys returned from CDRM service'));
              return;
            }
            resolve(keys);
          } catch (e) {
            reject(new Error(`Failed to parse CDRM response: ${body.slice(0, 100)}`));
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('CDRM request timed out')); });
      req.write(postData);
      req.end();
    });
  }

  /**
   * Try to get decryption key — local CDM first, then external service fallback.
   * Returns ALL content keys (DASH video/audio tracks each have their own KID).
   */
  async getDecryptionKey(pssh, licenseUrl, headers = {}) {
    let keys;
    let method;

    if (this.hasCDM()) {
      try {
        keys = await this.getDecryptionKeyCDM(pssh, licenseUrl, headers);
        method = 'local-cdm';
      } catch (cdmErr) {
        console.error('Local CDM failed, trying external service:', cdmErr.message);
        keys = await this.getDecryptionKeyExternal(pssh, licenseUrl, headers);
        method = 'external';
      }
    } else {
      keys = await this.getDecryptionKeyExternal(pssh, licenseUrl, headers);
      method = 'external';
    }

    // Collect ALL CONTENT keys — DASH streams have separate KIDs for video and audio
    const contentKeys = keys.filter(k => k.type === 'CONTENT');
    if (contentKeys.length === 0) contentKeys.push(keys[0]); // fallback if no typed keys

    const decryptionKeys = contentKeys.map(k => `${k.kid}:${k.key}`);

    console.log(`[DRM] Got ${contentKeys.length} content key(s) via ${method}:`);
    for (const k of contentKeys) {
      console.log(`  KID=${k.kid}  KEY=${k.key}  TYPE=${k.type}`);
    }

    return {
      decryptionKeys,            // array of "kid:key" strings for mp4decrypt
      decryptionKey: decryptionKeys[0], // backward compat single key
      method,
      allKeys: keys,
    };
  }

  /**
   * Download encrypted DASH content and decrypt with mp4decrypt.
   * Uses yt-dlp to download the encrypted segments, then mp4decrypt to decrypt.
   */
  async downloadAndDecrypt({ mpdUrl, decryptionKey, decryptionKeys, headers, savePath, onProgress }) {
    if (!decryptionKeys) decryptionKeys = decryptionKey ? [decryptionKey] : [];

    const tempVideoEnc = savePath + '.video.enc.mp4';
    const tempAudioEnc = savePath + '.audio.enc.mp4';
    const tempVideoDec = savePath + '.video.dec.mp4';
    const tempAudioDec = savePath + '.audio.dec.mp4';

    try {
      // Step 1: Download video and audio tracks separately (encrypted).
      // yt-dlp won't merge when --allow-unplayable-formats is set, so we download
      // each track individually to preserve CENC tenc/pssh boxes for mp4decrypt.
      if (onProgress) onProgress({ step: 'downloading', percent: null });
      console.log(`[DRM] Downloading encrypted video track from: ${mpdUrl}`);
      await this._downloadEncrypted(mpdUrl, headers, tempVideoEnc, 'bestvideo', onProgress);
      console.log(`[DRM] Video enc: ${fs.existsSync(tempVideoEnc) ? fs.statSync(tempVideoEnc).size : 0} bytes`);

      console.log(`[DRM] Downloading encrypted audio track`);
      await this._downloadEncrypted(mpdUrl, headers, tempAudioEnc, 'bestaudio', null);
      console.log(`[DRM] Audio enc: ${fs.existsSync(tempAudioEnc) ? fs.statSync(tempAudioEnc).size : 0} bytes`);

      // Step 2: Inspect actual KIDs in each file, build complete key list
      const videoKids = await this._inspectKids(tempVideoEnc);
      const audioKids = await this._inspectKids(tempAudioEnc);
      console.log(`[DRM] Video KIDs in file: ${videoKids.join(', ') || '(none)'}`);
      console.log(`[DRM] Audio KIDs in file: ${audioKids.join(', ') || '(none)'}`);
      console.log(`[DRM] Keys from license:  ${decryptionKeys.join(', ')}`);

      const allKeys = [...decryptionKeys];
      for (const kid of [...new Set([...videoKids, ...audioKids])]) {
        if (!decryptionKeys.some(k => k.toLowerCase().startsWith(kid.toLowerCase()))) {
          allKeys.push(`${kid}:${decryptionKeys[0].split(':')[1]}`);
          console.log(`[DRM] Fallback key added for unmatched KID: ${kid}`);
        }
      }

      // Step 3: Decrypt each track
      if (onProgress) onProgress({ step: 'decrypting', percent: null });
      await this._decrypt(tempVideoEnc, tempVideoDec, allKeys);
      await this._decrypt(tempAudioEnc, tempAudioDec, allKeys);
      console.log(`[DRM] Decrypted video: ${fs.existsSync(tempVideoDec) ? fs.statSync(tempVideoDec).size : 0} bytes`);
      console.log(`[DRM] Decrypted audio: ${fs.existsSync(tempAudioDec) ? fs.statSync(tempAudioDec).size : 0} bytes`);

      // Step 4: Mux decrypted video + audio into final output
      if (onProgress) onProgress({ step: 'remuxing', percent: null });
      await this._muxVideoAudio(tempVideoDec, tempAudioDec, savePath);
      console.log(`[DRM] Final: ${fs.existsSync(savePath) ? fs.statSync(savePath).size : 0} bytes → ${savePath}`);

      return true;
    } finally {
      this._cleanupFile(tempVideoEnc);
      this._cleanupFile(tempAudioEnc);
      this._cleanupFile(tempVideoDec);
      this._cleanupFile(tempAudioDec);
    }
  }

  /**
   * Download one encrypted DASH track using yt-dlp --allow-unplayable-formats.
   * format: yt-dlp format selector e.g. 'bestvideo', 'bestaudio', 'best'
   * This preserves CENC encryption boxes (tenc/pssh) that mp4decrypt needs.
   */
  async _downloadEncrypted(mpdUrl, headers, outputPath, format = 'bestvideo', onProgress) {
    // Write a temporary cookie file for yt-dlp using Electron session cookies
    const cookiePath = outputPath + '.cookies.txt';
    const cookieLines = ['# Netscape HTTP Cookie File'];

    if (this._session) {
      // Pull all cookies directly from Electron's session store (most reliable)
      try {
        const allCookies = await this._session.cookies.get({});
        console.log(`[DRM] Writing ${allCookies.length} session cookies to cookie file`);
        for (const c of allCookies) {
          if (c.name.includes('\t') || c.value.includes('\t') || c.value.includes('\n')) continue;
          const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
          const flag = 'TRUE';
          const cookiePath2 = c.path || '/';
          const secure = c.secure ? 'TRUE' : 'FALSE';
          const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
          cookieLines.push(`${domain}\t${flag}\t${cookiePath2}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
        }
      } catch (err) {
        console.warn('[DRM] Could not read session cookies:', err.message);
      }
    } else if (headers['Cookie']) {
      // Fallback: parse Cookie header string into Netscape format
      const pairs = headers['Cookie'].split(';').map(s => s.trim()).filter(Boolean);
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        cookieLines.push(`.onlyfans.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
        cookieLines.push(`.cdn3.onlyfans.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
        cookieLines.push(`.cdn2.onlyfans.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
      }
    }
    fs.writeFileSync(cookiePath, cookieLines.join('\n') + '\n', 'utf-8');

    const args = [
      '--allow-unplayable-formats',   // download encrypted content as-is (preserves CENC boxes)
      '--no-check-certificates',
      '--no-continue',                // never resume partial downloads (avoids 416 errors)
      '--no-part',                    // write directly to output, no .part file
      '-f', format,                   // caller specifies track: bestvideo / bestaudio
      '--cookies', cookiePath,
      '-o', outputPath,
    ];

    if (headers['Referer']) args.push('--add-header', `Referer:${headers['Referer']}`);
    if (headers['User-Agent']) args.push('--add-header', `User-Agent:${headers['User-Agent']}`);

    args.push(mpdUrl);

    console.log(`[DRM] yt-dlp download args: ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, { shell: false });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
        const pctMatch = data.toString().match(/([\d.]+)%/);
        if (pctMatch && onProgress) {
          onProgress({ step: 'downloading', percent: Math.min(99, Math.round(parseFloat(pctMatch[1]))) });
        }
      });
      proc.stderr.on('data', (data) => { output += data.toString(); });

      proc.on('close', (code) => {
        try { fs.unlinkSync(cookiePath); } catch (_) {}
        if (code === 0) {
          resolve();
        } else if (/403|410|expired/i.test(output)) {
          reject(Object.assign(new Error('Stream token expired'), { expired: true }));
        } else {
          reject(new Error(`yt-dlp encrypted download failed (code ${code}): ${output.slice(-400)}`));
        }
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(cookiePath); } catch (_) {}
        if (err.code === 'ENOENT') reject(new Error('yt-dlp not found on PATH'));
        else reject(err);
      });
    });
  }

  /** Decrypt with mp4decrypt using one or more content keys */
  async _decrypt(inputPath, outputPath, decryptionKey) {
    // decryptionKey: either a single "kid:key" string or an array of them
    const keyList = Array.isArray(decryptionKey) ? decryptionKey : [decryptionKey];
    const args = [];
    for (const kv of keyList) {
      args.push('--key', kv);
    }
    args.push(inputPath, outputPath);
    console.log(`[DRM] mp4decrypt args: ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn('mp4decrypt', args, { shell: false });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });

      proc.on('close', (code) => {
        if (stdout) console.log(`[DRM] mp4decrypt stdout: ${stdout}`);
        if (stderr) console.log(`[DRM] mp4decrypt stderr: ${stderr}`);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`mp4decrypt failed (code ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('mp4decrypt not found on PATH. Install Bento4: https://www.bento4.com/downloads/'));
        } else {
          reject(err);
        }
      });
    });
  }

  /** Mux a decrypted video file and a decrypted audio file into one MP4 */
  async _muxVideoAudio(videoPath, audioPath, outputPath) {
    const args = ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', outputPath];
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { shell: false });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) { resolve(); return; }
        // If mux failed, try video-only as a fallback (better than nothing)
        console.warn(`[DRM] ffmpeg mux failed (code ${code}), copying video-only: ${stderr.slice(-200)}`);
        try { fs.copyFileSync(videoPath, outputPath); resolve(); } catch (e) { reject(e); }
      });
      proc.on('error', (err) => {
        // ffmpeg not found — just copy video track
        try { fs.copyFileSync(videoPath, outputPath); resolve(); } catch (e) { reject(err); }
      });
    });
  }

  /** Remux with ffmpeg to ensure clean container */
  async _remux(inputPath, outputPath) {
    // If input and output are the same, skip
    if (inputPath === outputPath) return;

    const args = ['-y', '-i', inputPath, '-c', 'copy', outputPath];

    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { shell: false });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          // If remux fails, just rename the decrypted file
          try {
            fs.copyFileSync(inputPath, outputPath);
            resolve();
          } catch (e) {
            reject(new Error(`Remux failed (code ${code}): ${stderr.slice(-200)}`));
          }
        }
      });

      proc.on('error', () => {
        // ffmpeg not available for remux — just copy
        try {
          fs.copyFileSync(inputPath, outputPath);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  _formatHeadersForCDRM(headers) {
    // CDRM expects headers as a string like "Key: Value\nKey: Value"
    const parts = [];
    for (const [k, v] of Object.entries(headers)) {
      if (k !== 'Cookie' && v) parts.push(`${k}: ${v}`);
    }
    return parts.join('\n');
  }

  _parseCDRMResponse(body) {
    // CDRM returns HTML or JSON with key lines like "KID:KEY" or structured data
    // Try JSON first
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data)) return data;
      if (data.keys) return data.keys;
      if (data.Message) {
        // Try to parse key lines from the message
        return this._parseKeyLines(data.Message);
      }
    } catch (_) {}

    // Try parsing as text with key lines
    return this._parseKeyLines(body);
  }

  _parseKeyLines(text) {
    // Match lines like "KID_HEX:KEY_HEX" (32-char hex : 32-char hex)
    const keys = [];
    const regex = /([0-9a-f]{32}):([0-9a-f]{32})/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      keys.push({ kid: match[1].toLowerCase(), key: match[2].toLowerCase(), type: 'CONTENT' });
    }
    return keys;
  }

  /**
   * Extract actual KIDs from a downloaded encrypted MP4 using mp4info (Bento4).
   * Returns array of KID hex strings found in the file's CENC protection boxes.
   */
  async _inspectKids(filePath) {
    return new Promise((resolve) => {
      const proc = spawn('mp4info', ['--format', 'json', filePath], { shell: false, timeout: 10000 });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', () => resolve([]));
      proc.on('close', () => {
        const kids = new Set();
        try {
          const info = JSON.parse(stdout);
          const tracks = info.tracks || [];
          for (const track of tracks) {
            const prot = track.sample_description?.protection_scheme;
            if (prot) {
              // KID may be in different locations depending on mp4info version
              const kid = prot.kid || prot.default_kid || prot.default_KID;
              if (kid) kids.add(kid.replace(/-/g, '').toLowerCase());
            }
            // Also check 'protection' array
            const protList = track.protection || track.sample_description?.protection || [];
            for (const p of (Array.isArray(protList) ? protList : [])) {
              const kid = p.kid || p.default_kid;
              if (kid) kids.add(kid.replace(/-/g, '').toLowerCase());
            }
          }
        } catch (_) {
          // mp4info not available or different format — fall back to raw binary scan
          const kidSet = this._scanKidsFromBinary(filePath);
          for (const k of kidSet) kids.add(k);
        }
        resolve([...kids]);
      });
    });
  }

  /**
   * Fallback: scan the raw binary of an MP4 for KID bytes by looking for PSSH/tenc boxes.
   * Reads first 2MB (init segments are always at the start).
   */
  _scanKidsFromBinary(filePath) {
    const kids = new Set();
    try {
      const SCAN_BYTES = 2 * 1024 * 1024;
      const buf = Buffer.alloc(SCAN_BYTES);
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, SCAN_BYTES, 0);
      fs.closeSync(fd);
      const data = buf.slice(0, bytesRead);

      // Search for Widevine PSSH system ID: edef8ba979d64acea3c827dcd51d21ed
      const wvId = Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex');
      let pos = 0;
      while (pos < data.length - 32) {
        const idx = data.indexOf(wvId, pos);
        if (idx === -1) break;
        // After system ID (16 bytes) comes data size (4 bytes) then PSSH data
        // KIDs are in the Widevine PSSH protobuf — too complex to parse here
        // Instead, look for 'tenc' box which has the default KID
        pos = idx + 16;
      }

      // Search for 'tenc' box (Track Encryption Box) — contains default KID at offset 8
      const tenc = Buffer.from('74656e63', 'hex'); // 'tenc'
      pos = 0;
      while (pos < data.length - 24) {
        const idx = data.indexOf(tenc, pos);
        if (idx === -1) break;
        // tenc box: [4 bytes size][4 bytes 'tenc'][1 version][3 flags][1 reserved][1 per_sample_iv_size][16 bytes KID]
        // or version 1: [4 size][4 tenc][1 ver][3 flags][4 default_crypt_byte_block+default_skip_byte_block][1 default_per_sample_iv_size][16 KID]
        const kidOffset = idx + 8 + 4; // skip version+flags+reserved+per_sample_iv_size
        if (kidOffset + 16 <= data.length) {
          const kidBuf = data.slice(kidOffset, kidOffset + 16);
          const kidHex = kidBuf.toString('hex');
          // Sanity check: skip all-zeros or all-FF
          if (!/^0{32}$/.test(kidHex) && !/^f{32}$/i.test(kidHex)) {
            kids.add(kidHex);
            console.log(`[DRM] Found KID in tenc box at offset ${kidOffset}: ${kidHex}`);
          }
        }
        pos = idx + 4;
      }
    } catch (err) {
      console.log(`[DRM] Binary KID scan error: ${err.message}`);
    }
    return kids;
  }

  _cleanupFile(filePath) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

module.exports = DrmHandler;
