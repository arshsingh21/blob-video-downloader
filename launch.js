// Cross-platform launcher that ensures ELECTRON_RUN_AS_NODE is not set
// (VSCode and other Electron-based editors set this in their terminal environment)
const { spawn } = require('child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
  cwd: __dirname,
});

child.on('close', (code) => process.exit(code));
