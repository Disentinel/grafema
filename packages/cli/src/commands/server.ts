/**
 * Server command - Manage RFDB (Rega Flow Database) server lifecycle
 *
 * Provides explicit control over the RFDB server process:
 *   grafema server start   - Start detached server
 *   grafema server stop    - Stop server gracefully
 *   grafema server status  - Check if server is running
 *   grafema server graphql - Start GraphQL API server
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';
import { RFDBClient, loadConfig, RFDBServerBackend, findRfdbBinary, startRfdbServer } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

// Extend config type for server settings
interface ServerConfig {
  binaryPath?: string;
}

/**
 * Find RFDB server binary using shared utility.
 * Wraps findRfdbBinary() with CLI-specific error logging.
 */
function findServerBinary(explicitPath?: string): string | null {
  const binaryPath = findRfdbBinary({ explicitPath });
  if (!binaryPath && explicitPath) {
    console.error(`Specified binary not found: ${explicitPath}`);
  }
  return binaryPath;
}

/**
 * Check if server is running by attempting to ping it
 */
async function isServerRunning(socketPath: string): Promise<{ running: boolean; version?: string }> {
  if (!existsSync(socketPath)) {
    return { running: false };
  }

  const client = new RFDBClient(socketPath, 'cli');
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

/**
 * Resolve RFDB binary path: CLI flag > config > auto-detect
 */
function resolveBinaryPath(projectPath: string, explicitBinary?: string): string | null {
  if (explicitBinary) {
    return findServerBinary(explicitBinary);
  }

  // Try config
  try {
    const config = loadConfig(projectPath);
    const serverConfig = (config as unknown as { server?: ServerConfig }).server;
    if (serverConfig?.binaryPath) {
      return findServerBinary(serverConfig.binaryPath);
    }
  } catch {
    // Config not found or invalid - continue with auto-detect
  }

  return findServerBinary();
}

/**
 * Stop a running RFDB server: send shutdown, wait for socket removal, clean PID
 */
async function stopRunningServer(socketPath: string, pidPath: string): Promise<void> {
  const client = new RFDBClient(socketPath, 'cli');
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
}

// Create main server command with subcommands
export const serverCommand = new Command('server')
  .description('Manage RFDB (Rega Flow Database) server lifecycle')
  .addHelpText('after', `
Examples:
  grafema server start                       Start the RFDB server
  grafema server start --binary /path/to/bin Start with specific binary
  grafema server stop                        Stop the running server
  grafema server status                      Check if server is running
  grafema server status --json               Server status as JSON

Config (in .grafema/config.yaml):
  server:
    binaryPath: /path/to/rfdb-server    # Optional: path to binary
`);

// grafema server start
serverCommand
  .command('start')
  .description('Start the RFDB server')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-b, --binary <path>', 'Path to rfdb-server binary')
  .action(async (options: { project: string; binary?: string }) => {
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

    const binaryPath = resolveBinaryPath(projectPath, options.binary);

    if (!binaryPath) {
      exitWithError('RFDB server binary not found', [
        'Specify path: grafema server start --binary /path/to/rfdb-server',
        'Or add to config.yaml:',
        '  server:',
        '    binaryPath: /path/to/rfdb-server',
        'Or install: npm install @grafema/rfdb',
        'Or build: cargo build --release && cp target/release/rfdb-server ~/.local/bin/'
      ]);
    }

    console.log(`Starting RFDB server...`);
    console.log(`  Binary: ${binaryPath}`);
    console.log(`  Database: ${dbPath}`);
    console.log(`  Socket: ${socketPath}`);

    // Start server using shared utility
    const serverProcess = await startRfdbServer({
      dbPath,
      socketPath,
      binaryPath,
      pidPath,
      waitTimeoutMs: 10000,
    });

    if (serverProcess === null) {
      // Existing server detected via PID file
      console.log('Server already running (detected via PID file)');
      return;
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
    await stopRunningServer(socketPath, pidPath);
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
      const client = new RFDBClient(socketPath, 'cli');
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

// grafema server restart
serverCommand
  .command('restart')
  .description('Restart the RFDB server (stop if running, then start)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-b, --binary <path>', 'Path to rfdb-server binary')
  .action(async (options: { project: string; binary?: string }) => {
    const projectPath = resolve(options.project);
    const { grafemaDir, socketPath, dbPath, pidPath } = getProjectPaths(projectPath);

    // Check if grafema is initialized
    if (!existsSync(grafemaDir)) {
      exitWithError('Grafema not initialized', [
        'Run: grafema init',
        'Or: grafema analyze (initializes automatically)'
      ]);
    }

    // Stop server if running
    const status = await isServerRunning(socketPath);
    if (status.running) {
      console.log('Stopping RFDB server...');
      await stopRunningServer(socketPath, pidPath);
      console.log('Server stopped');
    }

    const binaryPath = resolveBinaryPath(projectPath, options.binary);

    if (!binaryPath) {
      exitWithError('RFDB server binary not found', [
        'Specify path: grafema server restart --binary /path/to/rfdb-server',
        'Or add to config.yaml:',
        '  server:',
        '    binaryPath: /path/to/rfdb-server',
        'Or install: npm install @grafema/rfdb',
        'Or build: cargo build --release && cp target/release/rfdb-server ~/.local/bin/'
      ]);
    }

    console.log('Starting RFDB server...');
    console.log(`  Binary: ${binaryPath}`);
    console.log(`  Database: ${dbPath}`);
    console.log(`  Socket: ${socketPath}`);

    const serverProcess = await startRfdbServer({
      dbPath,
      socketPath,
      binaryPath,
      pidPath,
      waitTimeoutMs: 10000,
    });

    const verifyStatus = await isServerRunning(socketPath);
    if (!verifyStatus.running) {
      exitWithError('Server started but not responding', [
        'Check server logs for errors'
      ]);
    }

    console.log('');
    console.log(`Server restarted successfully`);
    if (verifyStatus.version) {
      console.log(`  Version: ${verifyStatus.version}`);
    }
    if (serverProcess?.pid) {
      console.log(`  PID: ${serverProcess.pid}`);
    }
  });

// grafema server graphql
serverCommand
  .command('graphql')
  .description('Start GraphQL API server (requires RFDB server running)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('--port <number>', 'Port to listen on', '4000')
  .option('--host <string>', 'Hostname to bind to', 'localhost')
  .action(async (options: { project: string; port: string; host: string }) => {
    const projectPath = resolve(options.project);
    const { socketPath } = getProjectPaths(projectPath);

    // Check if RFDB server is running
    const status = await isServerRunning(socketPath);
    if (!status.running) {
      exitWithError('RFDB server not running', [
        'Start the server first: grafema server start',
        'Or run: grafema analyze (starts server automatically)'
      ]);
    }

    // Create backend connection
    const backend = new RFDBServerBackend({ socketPath, clientName: 'cli' });
    await backend.connect();

    // Import and start GraphQL server
    const { startServer } = await import('@grafema/api');
    const port = parseInt(options.port, 10);

    console.log('Starting Grafema GraphQL API...');
    console.log(`  RFDB Socket: ${socketPath}`);
    if (status.version) {
      console.log(`  RFDB Version: ${status.version}`);
    }
    console.log('');

    const server = startServer({
      backend,
      port,
      hostname: options.host,
    });

    // Handle shutdown
    const shutdown = async () => {
      console.log('\nShutting down GraphQL server...');
      server.close();
      await backend.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
