#!/usr/bin/env node
/**
 * RFDB postinstall script
 *
 * Ensures the RFDB server binary is available:
 * 1. Check for prebuilt binary (fastest)
 * 2. Check ~/.local/bin/rfdb-server (user-installed)
 * 3. Provide clear instructions for unsupported platforms
 */

const path = require('path');
const fs = require('fs');

const platform = process.platform;
const arch = process.arch;

// Determine platform directory name
let platformDir;
if (platform === 'darwin') {
  platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
} else if (platform === 'linux') {
  platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
} else {
  console.warn(`\n⚠️  @grafema/rfdb: Platform ${platform} is not supported yet.\n`);
  process.exit(0);
}

const prebuiltDir = path.join(__dirname, '..', 'prebuilt', platformDir);
const binaryPath = path.join(prebuiltDir, 'rfdb-server');
const homeBinaryPath = path.join(process.env.HOME || '', '.local', 'bin', 'rfdb-server');

// 1. Check for prebuilt binary
if (fs.existsSync(binaryPath)) {
  try {
    fs.chmodSync(binaryPath, 0o755);
  } catch (e) {
    // Ignore chmod errors
  }
  console.log(`✓ @grafema/rfdb: Binary ready for ${platform}-${arch}`);
  process.exit(0);
}

// 2. Check if user already has binary in ~/.local/bin
if (fs.existsSync(homeBinaryPath)) {
  console.log(`✓ @grafema/rfdb: Found user binary at ${homeBinaryPath}`);
  process.exit(0);
}

// 3. No binary available - provide instructions
console.log(`
⚠️  @grafema/rfdb: No prebuilt binary for ${platform}-${arch}

To use Grafema, build the server binary from source:

  # Clone and build
  git clone https://github.com/Disentinel/grafema.git
  cd grafema/packages/rfdb-server
  cargo build --release

  # Install to ~/.local/bin (Grafema will find it automatically)
  mkdir -p ~/.local/bin
  cp target/release/rfdb-server ~/.local/bin/

  # Or specify in config.yaml:
  # server:
  #   binaryPath: /path/to/rfdb-server

Requires Rust: https://rustup.rs
`);

process.exit(0);
