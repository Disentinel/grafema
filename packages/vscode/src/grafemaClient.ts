/**
 * Grafema RFDB Client Manager
 *
 * Manages connection to RFDB server with auto-start capability.
 * If the database exists but server is not running, spawns it automatically.
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { EventEmitter } from 'events';
import { RFDBClient } from '@grafema/rfdb-client';
import type { ConnectionState } from './types';

const GRAFEMA_DIR = '.grafema';
const SOCKET_FILE = 'rfdb.sock';
const DB_FILE = 'graph.rfdb';

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GrafemaClientManager handles RFDB connection lifecycle with auto-start.
 *
 * States:
 * - No DB file: Show "Run grafema analyze first"
 * - DB exists, no server: Start server, then connect
 * - DB exists, server running: Connect directly
 */
export class GrafemaClientManager extends EventEmitter {
  private workspaceRoot: string;
  private client: RFDBClient | null = null;
  private serverProcess: ChildProcess | null = null;
  private _state: ConnectionState = { status: 'disconnected' };

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
  }

  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState): void {
    this._state = state;
    this.emit('stateChange', state);
  }

  get socketPath(): string {
    return join(this.workspaceRoot, GRAFEMA_DIR, SOCKET_FILE);
  }

  get dbPath(): string {
    return join(this.workspaceRoot, GRAFEMA_DIR, DB_FILE);
  }

  /**
   * Get the connected client. Throws if not connected.
   */
  getClient(): RFDBClient {
    if (!this.client || this._state.status !== 'connected') {
      throw new Error('Not connected to RFDB server');
    }
    return this.client;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._state.status === 'connected' && this.client !== null;
  }

  /**
   * Connect to RFDB server, auto-starting if necessary
   */
  async connect(): Promise<void> {
    // Check if database exists
    if (!existsSync(this.dbPath)) {
      this.setState({
        status: 'no-database',
        message: 'No graph database. Run `grafema analyze` first.',
      });
      return;
    }

    // Try to connect first (server may already be running)
    this.setState({ status: 'connecting' });

    try {
      await this.tryConnect();
      return;
    } catch {
      // Connection failed, try to start server
    }

    // Start server
    this.setState({ status: 'starting-server' });
    try {
      await this.startServer();
      await this.tryConnect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', message });
    }
  }

  /**
   * Try to connect to existing server
   */
  private async tryConnect(): Promise<void> {
    const client = new RFDBClient(this.socketPath);
    await client.connect();

    // Verify connection with ping
    const pong = await client.ping();
    if (!pong) {
      await client.close();
      throw new Error('Server did not respond to ping');
    }

    this.client = client;
    this.setState({ status: 'connected' });
  }

  /**
   * Find rfdb-server binary
   * Follows same pattern as RFDBServerBackend
   */
  private findServerBinary(): string | null {
    // 0. Check GRAFEMA_RFDB_SERVER environment variable
    const envBinary = process.env.GRAFEMA_RFDB_SERVER;
    if (envBinary && existsSync(envBinary)) {
      return envBinary;
    }

    // 1. Check packages/rfdb-server in monorepo (development)
    // Navigate up from node_modules to find monorepo root
    const possibleRoots = [
      // When running from extension host
      join(this.workspaceRoot, 'node_modules', '@grafema', 'rfdb-client'),
      // When in monorepo development
      join(__dirname, '..', '..', '..'),
      join(__dirname, '..', '..', '..', '..'),
      join(__dirname, '..', '..', '..', '..', '..'),
      // Known grafema monorepo location (development convenience)
      '/Users/vadimr/grafema',
    ];

    for (const root of possibleRoots) {
      const releaseBinary = join(root, 'packages', 'rfdb-server', 'target', 'release', 'rfdb-server');
      if (existsSync(releaseBinary)) {
        return releaseBinary;
      }

      const debugBinary = join(root, 'packages', 'rfdb-server', 'target', 'debug', 'rfdb-server');
      if (existsSync(debugBinary)) {
        return debugBinary;
      }
    }

    // 2. Check @grafema/rfdb npm package
    try {
      // Use require.resolve to find the package
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

    return null;
  }

  /**
   * Start RFDB server process
   */
  private async startServer(): Promise<void> {
    const binaryPath = this.findServerBinary();
    if (!binaryPath) {
      throw new Error(
        'RFDB server binary not found.\n' +
          'Install @grafema/rfdb: npm install @grafema/rfdb\n' +
          'Or build from source: cargo build --release --bin rfdb-server'
      );
    }

    // Remove stale socket
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    this.serverProcess = spawn(binaryPath, [this.dbPath, '--socket', this.socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Don't let server process prevent VS Code from exiting
    this.serverProcess.unref();

    this.serverProcess.on('error', (err: Error) => {
      console.error('[grafema-explore] Server process error:', err);
    });

    // Wait for socket to appear
    let attempts = 0;
    while (!existsSync(this.socketPath) && attempts < 50) {
      await sleep(100);
      attempts++;
    }

    if (!existsSync(this.socketPath)) {
      throw new Error(`RFDB server failed to start (socket not created after ${attempts * 100}ms)`);
    }
  }

  /**
   * Disconnect from server
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
    }
    this.setState({ status: 'disconnected' });

    // Note: We don't kill the server process - it continues running for other clients
    this.serverProcess = null;
  }
}
