/**
 * Server command - Manage RFDB server lifecycle
 *
 * Provides explicit control over the RFDB server process:
 *   grafema server start   - Start detached server
 *   grafema server stop    - Stop server gracefully
 *   grafema server status  - Check if server is running
 */

import { Command } from 'commander';
import { resolve, join, dirname } from 'path';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { RFDBClient } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Find RFDB server binary in order of preference:
 * 1. @grafema/rfdb npm package
 * 2. rust-engine/target/release (monorepo development)
 * 3. rust-engine/target/debug
 */
function findServerBinary(): string | null {
  // 1. Check @grafema/rfdb npm package
  try {
    const rfdbPkg = require.resolve('@grafema/rfdb');
    const rfdbDir = dirname(rfdbPkg);
    const platform = process.platform;
    const arch = process.arch;

    let platformDir: string;
    if (platform === 'darwin') {
      platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    } else if (platform === 'linux') {
      platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    } else {
      platformDir = `${platform}-${arch}`;
    }

    const npmBinary = join(rfdbDir, 'prebuilt', platformDir, 'rfdb-server');
    if (existsSync(npmBinary)) {
      return npmBinary;
    }
  } catch {
    // @grafema/rfdb not installed
  }

  // 2. Check rust-engine in monorepo
  // From packages/cli/dist/commands -> project root is 4 levels up
  const projectRoot = join(__dirname, '../../../..');
  const releaseBinary = join(projectRoot, 'rust-engine/target/release/rfdb-server');
  if (existsSync(releaseBinary)) {
    return releaseBinary;
  }

  // 3. Check debug build
  const debugBinary = join(projectRoot, 'rust-engine/target/debug/rfdb-server');
  if (existsSync(debugBinary)) {
    return debugBinary;
  }

  return null;
}

/**
 * Check if server is running by attempting to ping it
 */
async function isServerRunning(socketPath: string): Promise<{ running: boolean; version?: string }> {
  if (!existsSync(socketPath)) {
    return { running: false };
  }

  const client = new RFDBClient(socketPath);
  // Suppress error events (we handle via try/catch)
  client.on('error', () => {});

  try {
    await client.connect();
    const version = await client.ping();
    await client.close();
    return { running: true, version: version || undefined };
  } catch {
    // Socket exists but can't connect - stale socket
    return { running: false };
  }
}

/**
 * Get paths for a project
 */
function getProjectPaths(projectPath: string) {
  const grafemaDir = join(projectPath, '.grafema');
  const socketPath = join(grafemaDir, 'rfdb.sock');
  const dbPath = join(grafemaDir, 'graph.rfdb');
  const pidPath = join(grafemaDir, 'rfdb.pid');
  return { grafemaDir, socketPath, dbPath, pidPath };
}

// Create main server command with subcommands
export const serverCommand = new Command('server')
  .description('Manage RFDB server lifecycle');

// grafema server start
serverCommand
  .command('start')
  .description('Start the RFDB server')
  .option('-p, --project <path>', 'Project path', '.')
  .action(async (options: { project: string }) => {
    const projectPath = resolve(options.project);
    const { grafemaDir, socketPath, dbPath, pidPath } = getProjectPaths(projectPath);

    // Check if grafema is initialized
    if (!existsSync(grafemaDir)) {
      exitWithError('Grafema not initialized', [
        'Run: grafema init',
        'Or: grafema analyze (initializes automatically)'
      ]);
    }

    // Check if server already running
    const status = await isServerRunning(socketPath);
    if (status.running) {
      console.log(`Server already running at ${socketPath}`);
      if (status.version) {
        console.log(`  Version: ${status.version}`);
      }
      return;
    }

    // Remove stale socket if exists
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    // Find server binary
    const binaryPath = findServerBinary();
    if (!binaryPath) {
      exitWithError('RFDB server binary not found', [
        'Install: npm install @grafema/rfdb',
        'Or build: cargo build --release --bin rfdb-server'
      ]);
    }

    console.log(`Starting RFDB server...`);
    console.log(`  Database: ${dbPath}`);
    console.log(`  Socket: ${socketPath}`);

    // Start server
    const serverProcess = spawn(binaryPath, [dbPath, '--socket', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Don't let server process prevent parent from exiting
    serverProcess.unref();

    // Write PID file
    if (serverProcess.pid) {
      writeFileSync(pidPath, String(serverProcess.pid));
    }

    // Wait for socket to appear
    let attempts = 0;
    while (!existsSync(socketPath) && attempts < 50) {
      await sleep(100);
      attempts++;
    }

    if (!existsSync(socketPath)) {
      exitWithError('Server failed to start', [
        'Check if database path is valid',
        'Check server logs for errors'
      ]);
    }

    // Verify server is responsive
    const verifyStatus = await isServerRunning(socketPath);
    if (!verifyStatus.running) {
      exitWithError('Server started but not responding', [
        'Check server logs for errors'
      ]);
    }

    console.log('');
    console.log(`Server started successfully`);
    if (verifyStatus.version) {
      console.log(`  Version: ${verifyStatus.version}`);
    }
    if (serverProcess.pid) {
      console.log(`  PID: ${serverProcess.pid}`);
    }
  });

// grafema server stop
serverCommand
  .command('stop')
  .description('Stop the RFDB server')
  .option('-p, --project <path>', 'Project path', '.')
  .action(async (options: { project: string }) => {
    const projectPath = resolve(options.project);
    const { socketPath, pidPath } = getProjectPaths(projectPath);

    // Check if server is running
    const status = await isServerRunning(socketPath);
    if (!status.running) {
      console.log('Server not running');
      // Clean up stale socket and PID file
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
      if (existsSync(pidPath)) {
        unlinkSync(pidPath);
      }
      return;
    }

    console.log('Stopping RFDB server...');

    // Send shutdown command
    const client = new RFDBClient(socketPath);
    // Suppress error events (server closes connection on shutdown)
    client.on('error', () => {});

    try {
      await client.connect();
      await client.shutdown();
    } catch {
      // Expected - server closes connection
    }

    // Wait for socket to disappear
    let attempts = 0;
    while (existsSync(socketPath) && attempts < 30) {
      await sleep(100);
      attempts++;
    }

    // Clean up PID file
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }

    console.log('Server stopped');
  });

// grafema server status
serverCommand
  .command('status')
  .description('Check RFDB server status')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: { project: string; json?: boolean }) => {
    const projectPath = resolve(options.project);
    const { grafemaDir, socketPath, dbPath, pidPath } = getProjectPaths(projectPath);

    // Check if grafema is initialized
    const initialized = existsSync(grafemaDir);

    // Check server status
    const status = await isServerRunning(socketPath);

    // Read PID if available
    let pid: number | null = null;
    if (existsSync(pidPath)) {
      try {
        pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      } catch {
        // Ignore read errors
      }
    }

    // Get stats if running
    let nodeCount: number | undefined;
    let edgeCount: number | undefined;
    if (status.running) {
      const client = new RFDBClient(socketPath);
      client.on('error', () => {}); // Suppress error events

      try {
        await client.connect();
        nodeCount = await client.nodeCount();
        edgeCount = await client.edgeCount();
        await client.close();
      } catch {
        // Ignore errors
      }
    }

    if (options.json) {
      console.log(JSON.stringify({
        initialized,
        running: status.running,
        version: status.version || null,
        socketPath: initialized ? socketPath : null,
        dbPath: initialized ? dbPath : null,
        pid,
        nodeCount,
        edgeCount,
      }, null, 2));
      return;
    }

    // Text output
    if (!initialized) {
      console.log('Grafema not initialized');
      console.log('  Run: grafema init');
      return;
    }

    if (status.running) {
      console.log('RFDB server is running');
      console.log(`  Socket: ${socketPath}`);
      if (status.version) {
        console.log(`  Version: ${status.version}`);
      }
      if (pid) {
        console.log(`  PID: ${pid}`);
      }
      if (nodeCount !== undefined && edgeCount !== undefined) {
        console.log(`  Nodes: ${nodeCount}`);
        console.log(`  Edges: ${edgeCount}`);
      }
    } else {
      console.log('RFDB server is not running');
      console.log(`  Socket: ${socketPath}`);
      if (existsSync(socketPath)) {
        console.log('  (stale socket file exists)');
      }
    }
  });
