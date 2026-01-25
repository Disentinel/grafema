#!/usr/bin/env node
/**
 * RFDB postinstall script
 *
 * Validates that a prebuilt binary exists for the current platform,
 * or provides instructions for building from source.
 */

const path = require('path');
const fs = require('fs');

const platform = process.platform;
const arch = process.arch;

let platformDir;
if (platform === 'darwin') {
  platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
} else if (platform === 'linux') {
  platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
} else {
  console.warn(`\n⚠️  @grafema/rfdb: No prebuilt binary for ${platform}-${arch}`);
  console.warn('   Build from source with: cargo build --release\n');
  process.exit(0);
}

const binaryPath = path.join(__dirname, '..', 'prebuilt', platformDir, 'rfdb-server');

if (!fs.existsSync(binaryPath)) {
  console.warn(`\n⚠️  @grafema/rfdb: No prebuilt binary for ${platform}-${arch}`);
  console.warn('   Build from source with: cargo build --release');
  console.warn('   Or download from: https://github.com/Disentinel/rfdb/releases\n');
  process.exit(0);
}

// Make binary executable
try {
  fs.chmodSync(binaryPath, 0o755);
} catch (e) {
  // Ignore chmod errors on Windows
}

console.log(`✓ @grafema/rfdb: Binary ready for ${platform}-${arch}`);
