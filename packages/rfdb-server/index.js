/**
 * @grafema/rfdb - High-performance graph database for Grafema
 *
 * This package provides the rfdb-server binary and helpers for managing it.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

/**
 * Get the path to the rfdb-server binary for the current platform.
 * @returns {string|null} Path to binary, or null if not available
 */
function getBinaryPath() {
  const platform = process.platform;
  const arch = process.arch;

  let platformDir;
  if (platform === 'darwin') {
    platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (platform === 'linux') {
    platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  } else {
    return null;
  }

  const binaryPath = path.join(__dirname, 'prebuilt', platformDir, 'rfdb-server');
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

/**
 * Check if a binary is available for the current platform.
 * @returns {boolean}
 */
function isAvailable() {
  return getBinaryPath() !== null;
}

/**
 * Start the rfdb-server.
 * @param {Object} options
 * @param {string} options.socketPath - Unix socket path (default: /tmp/rfdb.sock)
 * @param {string} options.dataDir - Data directory (default: ./rfdb-data)
 * @param {boolean} options.silent - Suppress output (default: false)
 * @returns {ChildProcess} The server process
 */
function startServer(options = {}) {
  const binaryPath = getBinaryPath();
  if (!binaryPath) {
    throw new Error(`No rfdb-server binary available for ${process.platform}-${process.arch}`);
  }

  const socketPath = options.socketPath || '/tmp/rfdb.sock';
  const dataDir = options.dataDir || './rfdb-data';

  const args = ['--socket', socketPath, '--data-dir', dataDir];

  const child = spawn(binaryPath, args, {
    stdio: options.silent ? 'ignore' : 'inherit',
    detached: false,
  });

  child.socketPath = socketPath;

  return child;
}

/**
 * Wait for the server to be ready.
 * @param {string} socketPath - Unix socket path
 * @param {number} timeout - Timeout in ms (default: 5000)
 * @returns {Promise<void>}
 */
function waitForServer(socketPath, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    function tryConnect() {
      const socket = net.createConnection(socketPath);

      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - startTime > timeout) {
          reject(new Error(`Server not ready after ${timeout}ms`));
        } else {
          setTimeout(tryConnect, 100);
        }
      });
    }

    tryConnect();
  });
}

module.exports = {
  getBinaryPath,
  isAvailable,
  startServer,
  waitForServer,
};
