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
  constructor(cdmDir) {
    // cdmDir: directory containing device_client_id_blob + device_private_key
    this.cdmDir = cdmDir || null;
    this._pyScriptPath = path.join(__dirname, 'drm-keygen.py');
  }

  /** Check if local CDM files are configured */
  hasCDM() {
    if (!this.cdmDir) return false;
    const blobPath = path.join(this.cdmDir, 'device_client_id_blob');
    const keyPath = path.join(this.cdmDir, 'device_private_key');
    return fs.existsSync(blobPath) && fs.existsSync(keyPath);
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

    const blobPath = path.join(this.cdmDir, 'device_client_id_blob');
    const keyPath = path.join(this.cdmDir, 'device_private_key');

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
    // Use CDRM Project API
    const postData = JSON.stringify({
      PSSH: pssh,
      License_URL: licenseUrl,
      Headers: this._formatHeadersForCDRM(headers),
      JSON: '',
      Cookies: headers['Cookie'] || '',
      Data: '',
      Proxy: '',
    });

    return new Promise((resolve, reject) => {
      const req = https.request('https://cdrm-project.com/wv', {
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
            reject(new Error(`CDRM API returned HTTP ${res.statusCode}: ${body}`));
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
            reject(new Error(`Failed to parse CDRM response: ${body}`));
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
   * Returns the first CONTENT type key as "kid:key" hex string for mp4decrypt.
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

    // Find the CONTENT key (not SIGNING key)
    const contentKey = keys.find(k => k.type === 'CONTENT') || keys[0];
    return {
      kid: contentKey.kid,
      key: contentKey.key,
      decryptionKey: `${contentKey.kid}:${contentKey.key}`,
      method,
      allKeys: keys,
    };
  }

  /**
   * Download encrypted DASH content and decrypt with mp4decrypt.
   * Uses yt-dlp to download the encrypted segments, then mp4decrypt to decrypt.
   */
  async downloadAndDecrypt({ mpdUrl, decryptionKey, headers, savePath, onProgress }) {
    const tempEncrypted = savePath + '.encrypted.mp4';
    const tempDecrypted = savePath + '.decrypted.mp4';

    try {
      // Step 1: Download encrypted content with yt-dlp
      if (onProgress) onProgress({ step: 'downloading', percent: null });
      await this._downloadEncrypted(mpdUrl, headers, tempEncrypted, onProgress);

      // Step 2: Decrypt with mp4decrypt
      if (onProgress) onProgress({ step: 'decrypting', percent: null });
      await this._decrypt(tempEncrypted, tempDecrypted, decryptionKey);

      // Step 3: Remux to final output (fix container if needed)
      if (onProgress) onProgress({ step: 'remuxing', percent: null });
      await this._remux(tempDecrypted, savePath);

      return true;
    } finally {
      // Clean up temp files
      this._cleanupFile(tempEncrypted);
      this._cleanupFile(tempDecrypted);
    }
  }

  /** Download encrypted DASH/HLS content using ffmpeg -c copy (preserves encryption) */
  async _downloadEncrypted(mpdUrl, headers, outputPath, onProgress) {
    const args = ['-y'];

    const headerParts = [];
    for (const key of ['Referer', 'User-Agent', 'Cookie', 'Origin']) {
      if (headers[key]) headerParts.push(`${key}: ${headers[key]}`);
    }
    if (headerParts.length > 0) {
      args.push('-headers', headerParts.join('\r\n') + '\r\n');
    }

    // Download without decryption — just copy the encrypted streams
    args.push('-i', mpdUrl, '-c', 'copy', '-y', outputPath);

    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { shell: false });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        // Try to parse progress
        const timeMatch = stderr.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
        if (timeMatch && onProgress) {
          onProgress({ step: 'downloading', timeStr: timeMatch[1] });
          stderr = ''; // reset buffer
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else if (stderr.includes('403') || stderr.includes('Server returned 403')) {
          reject(Object.assign(new Error('Stream token expired'), { expired: true }));
        } else {
          reject(new Error(`ffmpeg download failed (code ${code}): ${stderr.slice(-300)}`));
        }
      });

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') reject(new Error('ffmpeg not found on PATH'));
        else reject(err);
      });
    });
  }

  /** Decrypt with mp4decrypt using the content key */
  async _decrypt(inputPath, outputPath, decryptionKey) {
    // decryptionKey format: "kid:key" (both hex)
    const args = ['--key', decryptionKey, inputPath, outputPath];

    return new Promise((resolve, reject) => {
      const proc = spawn('mp4decrypt', args, { shell: false });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`mp4decrypt failed (code ${code}): ${stderr}`));
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

  _cleanupFile(filePath) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

module.exports = DrmHandler;
