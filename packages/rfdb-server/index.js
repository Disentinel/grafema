/**
 * @grafema/rfdb - High-performance graph database for Grafema
 *
 * This package provides the rfdb-server binary and helpers for managing it.
 */

const path = require('path');
const fs = require('fs');
const net = require('net');

/**
 * Get the path to the rfdb-server binary for the current platform.
 * Only checks prebuilt directory. For full search (monorepo, PATH, env var, ~/.local/bin),
 * use findRfdbBinary() from @grafema/core instead.
 * @deprecated Use findRfdbBinary() from @grafema/core for full binary search.
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
  waitForServer,
};
