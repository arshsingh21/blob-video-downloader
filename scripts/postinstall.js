// Patch node_modules/electron/index.js to not shadow the built-in electron module
// when running inside an Electron process.
const fs = require('fs');
const path = require('path');

const electronIndex = path.join(__dirname, '..', 'node_modules', 'electron', 'index.js');

if (!fs.existsSync(electronIndex)) {
  console.log('electron/index.js not found, skipping patch');
  process.exit(0);
}

const patched = `const fs = require('fs');
const path = require('path');

// If running inside an Electron process, return the built-in module
if (process.versions.electron) {
  try {
    module.exports = require('electron/main');
  } catch (e) {
    // Fallback: use process._linkedBinding to detect and load built-in
    // This shouldn't happen in a normal Electron process
  }
  if (typeof module.exports === 'object' && module.exports.app) {
    return;
  }
}

const pathFile = path.join(__dirname, 'path.txt');

function getElectronPath () {
  let executablePath;
  if (fs.existsSync(pathFile)) {
    executablePath = fs.readFileSync(pathFile, 'utf-8');
  }
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    return path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, executablePath || 'electron');
  }
  if (executablePath) {
    return path.join(__dirname, 'dist', executablePath);
  } else {
    throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again');
  }
}

module.exports = getElectronPath();
`;

fs.writeFileSync(electronIndex, patched, 'utf-8');
console.log('Patched electron/index.js to avoid shadowing built-in module');
