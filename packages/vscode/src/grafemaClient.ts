/**
 * Grafema RFDB Client Manager
 *
 * Manages connection to RFDB server with auto-start capability.
 * If the database exists but server is not running, spawns it automatically.
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import type { FSWatcher } from 'fs';
import { existsSync, readFileSync, unlinkSync, watch } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { EventEmitter } from 'events';
import { RFDBClient, RFDBWebSocketClient } from '@grafema/rfdb-client';
import * as vscode from 'vscode';
import type { ConnectionState, GraphStats } from './types';

const GRAFEMA_DIR = '.grafema';
const SOCKET_FILE = 'rfdb.sock';
const DB_FILE = 'graph.rfdb';

/**
 * Default HTTP port for the rfdb-server /ui and /api endpoints (the GUI
 * is served from the same process as the Unix-socket RPC listener).
 *
 * DAI-15: dynamic allocation is preferred. startServer() passes
 * `--http-port 0` by default (OS picks a free port) and discovers the
 * actual port via the `<workspace>/.grafema/rfdb-http.port` lockfile.
 * Users can pin a specific port by setting `grafema.rfdbHttpPort` to a
 * non-default value.
 */
const DEFAULT_RFDB_HTTP_PORT = 3335;
const HTTP_PORT_LOCKFILE = 'rfdb-http.port';

/**
 * Module-level holder for the currently-active rfdb HTTP port. Populated
 * when startServer() spawns rfdb-server with `--http-port`. MapPanel (and
 * anyone else) reads it via getRfdbHttpPort() so there is one source of
 * truth.
 */
let activeRfdbHttpPort: number | undefined;

/**
 * Test hook: reset module-level state between tests. Not part of the
 * public API — only used by unit tests that re-require the module.
 */
export function _resetActiveRfdbHttpPortForTests(): void {
  activeRfdbHttpPort = undefined;
}

/**
 * Read the rfdb-http.port lockfile from a workspace (if present). Returns
 * `undefined` on any I/O / parse error — callers treat this as "no port
 * discovered yet" and fall back to config or default.
 */
export function readRfdbHttpPortLockfile(workspaceRoot: string): number | undefined {
  try {
    const p = join(workspaceRoot, GRAFEMA_DIR, HTTP_PORT_LOCKFILE);
    if (!existsSync(p)) return undefined;
    const txt = readFileSync(p, 'utf-8').trim();
    const n = Number.parseInt(txt, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  } catch {
    // ignore — stale or missing lockfile is a soft failure
  }
  return undefined;
}

/**
 * Returns true when the user has explicitly overridden `grafema.rfdbHttpPort`
 * at any scope (workspace/user/folder). Lets startServer() decide between
 * "pin the requested port" (explicit) vs "let the OS pick" (default).
 */
function isExplicitRfdbHttpPortSet(): boolean {
  try {
    const info = vscode.workspace.getConfiguration('grafema').inspect<number>('rfdbHttpPort');
    if (!info) return false;
    return (
      info.globalValue !== undefined ||
      info.workspaceValue !== undefined ||
      info.workspaceFolderValue !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Report the HTTP port the rfdb-server is listening on.
 *
 * Resolution order:
 *   1. Port recorded by the last successful startServer() call (discovered
 *      from the lockfile or from the explicit `--http-port` CLI arg).
 *   2. Explicit `grafema.rfdbHttpPort` VS Code setting (non-default).
 *   3. Lockfile `<workspace>/.grafema/rfdb-http.port` written by a live
 *      rfdb-server — covers the case where the server was spawned by
 *      `grafema analyze` (CLI) outside the extension.
 *   4. `GRAFEMA_RFDB_HTTP_PORT` environment variable.
 *   5. DEFAULT_RFDB_HTTP_PORT (3335).
 *
 * Returns `undefined` only if the caller explicitly sets the setting
 * to 0 — otherwise always returns a positive port.
 */
export function getRfdbHttpPort(workspaceRoot?: string): number | undefined {
  if (typeof activeRfdbHttpPort === 'number' && activeRfdbHttpPort > 0) {
    return activeRfdbHttpPort;
  }
  try {
    const config = vscode.workspace.getConfiguration('grafema');
    const configured = config.get<number>('rfdbHttpPort');
    if (isExplicitRfdbHttpPortSet()) {
      if (configured === 0) return undefined; // explicit opt-out
      if (typeof configured === 'number' && configured > 0) return configured;
    }
  } catch {
    // vscode API may not be available (e.g., unit tests) — fall through.
  }
  // Lockfile discovery — covers CLI-started server.
  const root = workspaceRoot ?? resolveWorkspaceRoot();
  if (root) {
    const fromLock = readRfdbHttpPortLockfile(root);
    if (typeof fromLock === 'number') return fromLock;
  }
  const env = process.env.GRAFEMA_RFDB_HTTP_PORT;
  if (env) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RFDB_HTTP_PORT;
}

function resolveWorkspaceRoot(): string | undefined {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
  } catch {
    // no workspace (unit test) — ignore
  }
  return undefined;
}

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
  readonly workspaceRoot: string;
  private explicitBinaryPath: string | null;
  private explicitSocketPath: string | null;
  private client: RFDBClient | RFDBWebSocketClient | null = null;
  private serverProcess: ChildProcess | null = null;
  private _state: ConnectionState = { status: 'disconnected' };
  private watchers: FSWatcher[] = [];
  private reconnecting = false;

  constructor(workspaceRoot: string, explicitBinaryPath?: string, explicitSocketPath?: string) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.explicitBinaryPath = explicitBinaryPath || null;
    this.explicitSocketPath = explicitSocketPath || null;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Set connection state. Public so analyze/init commands can update state.
   */
  setState(state: ConnectionState): void {
    this._state = state;
    this.emit('stateChange', state);
  }

  get socketPath(): string {
    return this.explicitSocketPath || join(this.workspaceRoot, GRAFEMA_DIR, SOCKET_FILE);
  }

  get dbPath(): string {
    return join(this.workspaceRoot, GRAFEMA_DIR, DB_FILE);
  }

  /**
   * Get the connected client. Throws if not connected.
   */
  getClient(): RFDBClient | RFDBWebSocketClient {
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
   * Connect to RFDB server, auto-starting if necessary.
   * Supports Unix socket (default) and WebSocket transport via configuration.
   */
  async connect(): Promise<void> {
    const config = vscode.workspace.getConfiguration('grafema');
    const transport = config.get<string>('rfdbTransport') || 'unix';

    if (transport === 'websocket') {
      // WebSocket mode: connect directly, no auto-start
      const wsUrl = config.get<string>('rfdbWebSocketUrl') || 'ws://localhost:7474';
      this.setState({ status: 'connecting' });

      try {
        const wsClient = new RFDBWebSocketClient(wsUrl, 'extension');
        await wsClient.connect();

        const pong = await wsClient.ping();
        if (!pong) {
          await wsClient.close();
          throw new Error('Server did not respond to ping');
        }

        // Negotiate protocol and select database
        await this.negotiateAndSelectDatabase(wsClient);

        this.client = wsClient;
        this.setState({ status: 'connected' });
        this.startWatching();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setState({
          status: 'error',
          message: `WebSocket connection failed: ${message}\n\nMake sure rfdb-server is running with --ws-port flag.`,
        });
      }
      return;
    }

    // Unix socket mode: existing logic with auto-start
    if (!existsSync(this.dbPath)) {
      this.setState({
        status: 'no-database',
        message: 'No graph database. Run `grafema analyze` first.',
      });
      return;
    }

    this.setState({ status: 'connecting' });

    try {
      await this.tryConnect();
      return;
    } catch {
      // Connection failed, try to start server
    }

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
    const client = new RFDBClient(this.socketPath, 'extension');
    await client.connect();

    // Verify connection with ping
    const pong = await client.ping();
    if (!pong) {
      await client.close();
      throw new Error('Server did not respond to ping');
    }

    // Negotiate protocol and select database
    await this.negotiateAndSelectDatabase(client);

    this.client = client;
    this.setState({ status: 'connected' });

    // Start watching for changes
    this.startWatching();
  }

  /**
   * Negotiate protocol version and auto-select default database.
   * Called after successful connection to rfdb-server.
   */
  private async negotiateAndSelectDatabase(
    client: RFDBClient | RFDBWebSocketClient
  ): Promise<void> {
    await client.hello();

    try {
      await client.openDatabase('default', 'rw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Only attempt recovery for "not found" errors
      if (!message.includes('not found')) {
        throw err;
      }

      const { databases } = await client.listDatabases();

      if (databases.length === 0) {
        throw new Error(
          'No graph databases found. Run `grafema analyze` to create one.'
        );
      }

      const dbNames = databases.map((d: { name: string }) => d.name).join(', ');
      throw new Error(
        `Database "default" not found. Available: ${dbNames}. ` +
        'Run `grafema analyze` to create the default database.'
      );
    }
  }

  /**
   * Find rfdb-server binary
   *
   * Search order:
   * 1. Explicit path from VS Code setting (user override)
   * 2. Bundled binary in extension (production)
   * 3. GRAFEMA_RFDB_SERVER environment variable
   * 4. Monorepo development paths
   * 5. @grafema/rfdb npm package (fallback)
   */
  private findServerBinary(): string | null {
    // 0. Check explicit path from VS Code setting
    if (this.explicitBinaryPath && existsSync(this.explicitBinaryPath)) {
      return this.explicitBinaryPath;
    }

    // 1. Check extension bundled binary (production)
    // After esbuild, __dirname is packages/vscode/dist
    // Binary is at packages/vscode/binaries/rfdb-server
    const extensionBinary = join(__dirname, '..', 'binaries', 'rfdb-server');
    if (existsSync(extensionBinary)) {
      return extensionBinary;
    }

    // 2. Check GRAFEMA_RFDB_SERVER environment variable
    const envBinary = process.env.GRAFEMA_RFDB_SERVER;
    if (envBinary && existsSync(envBinary)) {
      return envBinary;
    }

    // 3. Check packages/rfdb-server in monorepo (development)
    // Navigate up from node_modules to find monorepo root
    const possibleRoots = [
      // When running from extension host
      join(this.workspaceRoot, 'node_modules', '@grafema', 'rfdb-client'),
      // When in monorepo development
      join(__dirname, '..', '..', '..'),
      join(__dirname, '..', '..', '..', '..'),
      join(__dirname, '..', '..', '..', '..', '..'),
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

    // 4. Check ~/.grafema/bin/ (lazy-downloaded by CLI)
    const homeBinary = join(homedir(), '.grafema', 'bin', 'rfdb-server');
    if (existsSync(homeBinary)) {
      return homeBinary;
    }

    // 5. Check @grafema/rfdb npm package
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
   * Start RFDB server process.
   * Public so analyze command can ensure server is running before analysis.
   */
  async startServer(): Promise<void> {
    // If socket exists and a server is responding, skip — already running
    if (existsSync(this.socketPath)) {
      try {
        const probe = new RFDBClient(this.socketPath, 'probe');
        await probe.connect();
        const pong = await probe.ping();
        await probe.close();
        if (pong) return; // Server is alive, nothing to do
      } catch {
        // Socket exists but server is dead — remove stale socket below
      }
      unlinkSync(this.socketPath);
    }

    // Gracefully stop any old server holding the db lock.
    // SIGTERM triggers flush + exit in rfdb-server's signal handler.
    const pidPath = join(dirname(this.socketPath), 'rfdb.pid');
    if (existsSync(pidPath)) {
      try {
        const oldPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
        if (oldPid > 0) {
          process.kill(oldPid, 'SIGTERM');
          // Wait for process to actually exit (flush may take seconds for large graphs)
          for (let i = 0; i < 50; i++) {
            await sleep(100);
            try { process.kill(oldPid, 0); } catch { break; } // process gone
          }
        }
      } catch {
        // Process already dead or permission denied — fine
      }
      try { unlinkSync(pidPath); } catch { /* ignore */ }
    }

    const binaryPath = this.findServerBinary();
    if (!binaryPath) {
      throw new Error(
        'RFDB server binary not found.\n' +
          'Install @grafema/rfdb: npm install @grafema/rfdb\n' +
          'Or build from source: cargo build --release --bin rfdb-server'
      );
    }

    // DAI-15: prefer OS-assigned port (--http-port 0) unless the user
    // has explicitly pinned one via `grafema.rfdbHttpPort`. Avoids
    // collisions when 3335 is taken by another rfdb-server / process.
    const lockfilePath = join(this.workspaceRoot, GRAFEMA_DIR, HTTP_PORT_LOCKFILE);
    // Remove any stale lockfile so the post-spawn read can't pick up an
    // old port from a dead server. `ensureStaleLockfileCleared` also
    // tries to connect first; if the pre-flight probe above already
    // reaped a stale socket, the lockfile left behind is guaranteed
    // stale too.
    try { if (existsSync(lockfilePath)) unlinkSync(lockfilePath); } catch { /* ignore */ }

    const explicit = isExplicitRfdbHttpPortSet();
    const requestedPort = explicit
      ? vscode.workspace.getConfiguration('grafema').get<number>('rfdbHttpPort') ?? 0
      : 0;

    this.serverProcess = spawn(
      binaryPath,
      [this.dbPath, '--socket', this.socketPath, '--http-port', String(requestedPort)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    // Provisional — replaced below once the real port is discovered.
    activeRfdbHttpPort = requestedPort > 0 ? requestedPort : undefined;

    // Don't let server process prevent VS Code from exiting
    this.serverProcess.unref();

    // Write PID file so future restarts can gracefully kill this server
    if (this.serverProcess.pid) {
      const { writeFileSync } = require('fs');
      try { writeFileSync(pidPath, String(this.serverProcess.pid)); } catch { /* ignore */ }
    }

    this.serverProcess.on('error', (err: Error) => {
      console.error('[grafema-explore] Server process error:', err);
    });

    // Capture server stderr/stdout for debugging
    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[grafema-explore] rfdb-server stderr:', data.toString().trim());
    });
    this.serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log('[grafema-explore] rfdb-server stdout:', data.toString().trim());
    });
    this.serverProcess.on('exit', (code: number | null) => {
      console.error(`[grafema-explore] rfdb-server exited with code ${code}`);
    });

    // Wait for socket to appear
    let attempts = 0;
    while (!existsSync(this.socketPath) && attempts < 100) {
      await sleep(100);
      attempts++;
    }

    if (!existsSync(this.socketPath)) {
      throw new Error(`RFDB server failed to start (socket not created after ${attempts * 100}ms)`);
    }

    // Discover the actual HTTP port from the lockfile (written by the
    // server after bind succeeds). Poll up to 10s — warmup can delay
    // lockfile appearance when the graph is large.
    for (let i = 0; i < 100; i++) {
      const p = readRfdbHttpPortLockfile(this.workspaceRoot);
      if (typeof p === 'number' && p > 0) {
        activeRfdbHttpPort = p;
        break;
      }
      await sleep(100);
    }
    // If the lockfile never appeared but the user pinned an explicit port,
    // keep the provisional value — getRfdbHttpPort() will still hand out
    // a usable port.
  }

  /**
   * Disconnect from server
   */
  async disconnect(): Promise<void> {
    this.stopWatching();

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

  /**
   * Attempt to reconnect after connection loss
   * Emits 'reconnected' event on success (clients should clear caches)
   */
  async reconnect(): Promise<boolean> {
    if (this.reconnecting) {
      return false;
    }

    this.reconnecting = true;
    console.log('[grafema-explore] Attempting reconnect...');

    try {
      // Close existing client if any
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          // Ignore
        }
        this.client = null;
      }

      // Try to connect
      await this.connect();

      if (this._state.status === 'connected') {
        console.log('[grafema-explore] Reconnected successfully');
        // Emit reconnected event - clients should clear their caches
        this.emit('reconnected');
        return true;
      }
    } catch (err) {
      console.error('[grafema-explore] Reconnect failed:', err);
    } finally {
      this.reconnecting = false;
    }

    return false;
  }

  /**
   * Execute a client operation with auto-reconnect on failure
   */
  async withReconnect<T>(operation: (client: RFDBClient | RFDBWebSocketClient) => Promise<T>): Promise<T | null> {
    if (!this.client || this._state.status !== 'connected') {
      // Try to reconnect first
      const reconnected = await this.reconnect();
      if (!reconnected || !this.client) {
        return null;
      }
    }

    try {
      return await operation(this.client);
    } catch (err) {
      console.error('[grafema-explore] Operation failed, attempting reconnect:', err);

      // Try reconnect once
      const reconnected = await this.reconnect();
      if (reconnected && this.client) {
        try {
          return await operation(this.client);
        } catch (retryErr) {
          console.error('[grafema-explore] Operation failed after reconnect:', retryErr);
        }
      }

      return null;
    }
  }

  /**
   * Get graph statistics (node/edge count, version, db path).
   * Returns null if not connected.
   */
  async getStats(): Promise<GraphStats | null> {
    if (!this.isConnected()) return null;
    const client = this.getClient();
    const [version, nodeCount, edgeCount] = await Promise.all([
      client.ping(),
      client.nodeCount(),
      client.edgeCount(),
    ]);
    return {
      version: version || 'unknown',
      nodeCount,
      edgeCount,
      dbPath: this.dbPath,
    };
  }

  /**
   * Watch for socket file changes (indicates server restart/reanalysis)
   */
  private startWatching(): void {
    this.stopWatching();

    const handleChange = (eventType: string, filename: string | null) => {
      if (!filename) return;
      console.log(`[grafema-explore] Detected change: ${eventType} ${filename}`);
      setTimeout(() => {
        if (this._state.status === 'connected') {
          this.client?.ping().catch(() => {
            console.log('[grafema-explore] Socket invalid after change, reconnecting...');
            this.reconnect();
          });
        } else {
          this.connect();
        }
      }, 500);
    };

    // Watch socket directory for socket file changes
    const socketDir = dirname(this.socketPath);
    const socketFilename = basename(this.socketPath);
    this.addWatcher(socketDir, socketFilename, handleChange);

    // Watch .grafema/ dir for DB changes (if socket is in a different directory)
    const grafemaDir = join(this.workspaceRoot, GRAFEMA_DIR);
    if (grafemaDir !== socketDir) {
      this.addWatcher(grafemaDir, DB_FILE, handleChange);
    }
  }

  private addWatcher(
    dir: string,
    targetFile: string,
    onChange: (eventType: string, filename: string | null) => void
  ): void {
    if (!existsSync(dir)) return;
    try {
      const watcher = watch(dir, (eventType, filename) => {
        if (filename === targetFile) {
          onChange(eventType, filename);
        }
      });
      this.watchers.push(watcher);
    } catch (err) {
      console.error(`[grafema-explore] Failed to watch ${dir}:`, err);
    }
  }

  /**
   * Stop watching for changes
   */
  private stopWatching(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
