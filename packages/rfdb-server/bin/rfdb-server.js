#!/usr/bin/env node
/**
 * RFDB Server launcher
 *
 * Launches the native rfdb-server binary for the current platform.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function getBinaryPath() {
  const platform = process.platform;
  const arch = process.arch;

  let platformDir;
  if (platform === 'darwin') {
    platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (platform === 'linux') {
    platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  } else {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    console.error('Please build from source: cargo build --release');
    process.exit(1);
  }

  const binaryPath = path.join(__dirname, '..', 'prebuilt', platformDir, 'rfdb-server');

  if (!fs.existsSync(binaryPath)) {
    console.error(`Binary not found for ${platform}-${arch}`);
    console.error(`Expected at: ${binaryPath}`);
    console.error('');
    console.error('Available options:');
    console.error('1. Build from source: cargo build --release');
    console.error('2. Download from GitHub releases');
    process.exit(1);
  }

  return binaryPath;
}

const binaryPath = getBinaryPath();
const args = process.argv.slice(2);

const child = spawn(binaryPath, args, {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (err) => {
  console.error(`Failed to start rfdb-server: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code || 0);
});

// Forward signals to child
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
