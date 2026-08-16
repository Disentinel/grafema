/**
 * RFDBConnectionBase — connection lifecycle + shared state for RFDBServerBackend.
 *
 * Extracted from RFDBServerBackend.ts (REG-490). This base class owns the
 * socket/client/protocol state and the connect → negotiate → close → shutdown
 * lifecycle. The data and query layers extend it (RFDBConnectionBase →
 * RFDBDataBackend → RFDBServerBackend) so every method remains a member of the
 * single public `RFDBServerBackend` class — the public surface is unchanged.
 */

import { RFDBClient } from '@grafema/rfdb-client';
import type { ChildProcess } from 'child_process';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';

import type { FieldDeclaration } from '@grafema/types';
import {
  startRfdbServer,
  checkServerDatabase,
  staleServerMessage,
  pathIdentity,
  rfdbPidPath,
  rfdbServerRecordPath,
} from '../../utils/startRfdbServer.js';
import { GRAFEMA_VERSION, getSchemaVersion } from '../../version.js';
import type { RFDBServerBackendOptions } from './rfdbTypes.js';
import { resolveSocketPath, waitForPidExit } from './rfdbCodec.js';

export class RFDBConnectionBase {
  readonly socketPath: string;
  readonly dbPath: string | undefined;
  protected readonly autoStart: boolean;
  protected readonly silent: boolean;
  protected readonly _clientName: string;
  protected client: RFDBClient | null;
  protected serverProcess: ChildProcess | null;
  connected: boolean;  // Public for compatibility
  protected protocolVersion: number = 2; // Negotiated protocol version
  protected edgeTypes: Set<string>;

  constructor(options: RFDBServerBackendOptions = {}) {
    this.dbPath = options.dbPath;
    this.autoStart = options.autoStart ?? true; // Default true for backwards compat
    this.silent = options.silent ?? false;
    this._clientName = options.clientName ?? 'core';
    // Default socket path: next to the database in .grafema folder, falling back
    // to a hashed /tmp path when the project path would exceed SUN_LEN.
    this.socketPath = resolveSocketPath(options);
    this.client = null;
    this.serverProcess = null;
    this.connected = false;
    this.edgeTypes = new Set();
  }

  /**
   * Log message if not in silent mode.
   */
  protected log(message: string): void {
    if (!this.silent) {
      console.error(message);
    }
  }

  /**
   * Log error (always shown, even in silent mode).
   */
  protected logError(message: string, error?: unknown): void {
    console.error(message, error ?? '');
  }

  /**
   * Connect to RFDB server.
   * If autoStart is true (default), starts the server if not running.
   * If autoStart is false, requires explicit `grafema server start`.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    // Try to connect first
    this.client = new RFDBClient(this.socketPath, this._clientName);

    // Attach error handler to prevent unhandled 'error' events
    // This is important for stale sockets (socket file exists but server is dead)
    this.client.on('error', (err: Error) => {
      this.logError('[RFDBServerBackend] Client error:', err.message);
    });

    let responsive = false;
    try {
      await this.client.connect();
      // Verify server is responsive
      await this.client.ping();
      responsive = true;
    } catch {
      // Server not running or stale socket
      if (!this.autoStart) {
        throw new Error(
          `RFDB server not running at ${this.socketPath}\n` +
          `Start the server first: grafema server start`
        );
      }
      this.log(`[RFDBServerBackend] RFDB server not running, starting...`);
    }

    if (responsive) {
      // Responsive is not the same as usable: a detached server whose project
      // directory was deleted and recreated answers ping and then fails every
      // write with a bare ENOENT (REG-1199). Say so here, while the cause is
      // still nameable — and outside the catch above, so the diagnosis is not
      // swallowed and re-read as "server not running".
      this._assertServerServesThisDatabase();
      this.connected = true;
      await this._negotiateProtocol();
      this.log(`[RFDBServerBackend] Connected to RFDB server at ${this.socketPath} (protocol v${this.protocolVersion})`);
      return;
    }

    // Start the server (only if autoStart is true)
    await this._startServer();

    // Connect again with fresh client
    this.client = new RFDBClient(this.socketPath, this._clientName);
    this.client.on('error', (err: Error) => {
      this.logError('[RFDBServerBackend] Client error:', err.message);
    });
    await this.client.connect();
    await this.client.ping();
    this.connected = true;
    await this._negotiateProtocol();
    this.log(`[RFDBServerBackend] Connected to RFDB server at ${this.socketPath} (protocol v${this.protocolVersion})`);
  }

  /**
   * Alias for connect()
   */
  async initialize(): Promise<void> {
    return this.connect();
  }

  /**
   * Throw the real diagnosis when the server we just reached was started
   * against a database that is no longer there (REG-1199).
   *
   * Silent when there is nothing to compare against: a server started outside
   * this code path leaves no record, and refusing to talk to it would be a
   * regression, not a fix.
   */
  private _assertServerServesThisDatabase(): void {
    if (!this.dbPath) return;
    const verdict = checkServerDatabase(this.socketPath, this.dbPath, {
      existsSync,
      readFileSync: (p: string, enc: 'utf8') => readFileSync(p, enc),
      pathIdentity,
    });
    if (verdict.state === 'stale') {
      throw new Error(staleServerMessage(this.socketPath, verdict));
    }
  }

  /**
   * Start RFDB server process using shared utility.
   */
  private async _startServer(): Promise<void> {
    if (!this.dbPath) {
      throw new Error('dbPath required to start RFDB server');
    }

    await startRfdbServer({
      dbPath: this.dbPath,
      socketPath: this.socketPath,
      pidPath: rfdbPidPath(this.socketPath),
      waitTimeoutMs: 30_000,
      logger: this.silent ? undefined : { debug: (m: string) => this.log(m) },
    });
  }

  /**
   * Negotiate protocol version with server.
   * Requests v3 (semantic IDs), falls back to v2 if server doesn't support it.
   * Called after ping() confirmed connectivity, so failures here indicate
   * the server doesn't support hello/v3, not network issues.
   */
  private async _negotiateProtocol(): Promise<void> {
    if (!this.client) return;
    try {
      const hello = await this.client.hello(3);
      this.protocolVersion = hello.protocolVersion;
      this._checkServerVersion(hello.serverVersion);
    } catch {
      // Server predates hello command or doesn't support v3 — safe v2 fallback
      this.protocolVersion = 2;
      this.log('[RFDBServerBackend] WARNING: Server does not support version negotiation. Consider updating rfdb-server.');
    }
  }

  /**
   * Validate server version against expected client version.
   * Warns on mismatch but never fails — version differences are informational.
   */
  private _checkServerVersion(serverVersion: string): void {
    if (!serverVersion) return;
    const expected = getSchemaVersion(GRAFEMA_VERSION);
    const actual = getSchemaVersion(serverVersion);
    if (actual !== expected) {
      this.log(
        `[RFDBServerBackend] WARNING: rfdb-server version mismatch — ` +
        `server v${serverVersion}, expected v${GRAFEMA_VERSION}. ` +
        `Update with: grafema server restart`
      );
    }
  }

  /**
   * Close client connection. Server continues running to serve other clients.
   */
  async close(): Promise<void> {
    // Request server flush before disconnecting
    if (this.client) {
      try {
        await this.client.flush();
      } catch {
        // Ignore flush errors on close - best effort
      }
      await this.client.close();
      this.client = null;
    }
    this.connected = false;

    // NOTE: We intentionally do NOT kill the server process.
    // The server continues running to serve other clients (MCP, other CLI invocations).
    // This is by design for multi-client architecture.
    // Server lifecycle is managed separately (system process, or manual grafema server stop).
    this.serverProcess = null;
  }

  /**
   * Shutdown the RFDB server gracefully (flush + exit).
   * Use before operations that invalidate the socket (e.g. clear + restart).
   * Waits for the server process to fully exit so the subsequent connect()
   * doesn't find it 'alive' in the PID file and skip spawning a fresh server.
   */
  async shutdownServer(): Promise<void> {
    if (!this.client) return;
    const pidPath = rfdbPidPath(this.socketPath);
    try {
      await this.client.shutdown();
    } catch {
      // Server may already be gone
    }
    this.client = null;
    this.connected = false;
    this.serverProcess = null;
    await waitForPidExit(pidPath, 5000);
    // Explicitly remove PID, server record and socket so checkExistingServer
    // returns 'none' and the subsequent connect() spawns a fresh server
    // unconditionally.
    try { unlinkSync(pidPath); } catch { /* already gone */ }
    try { unlinkSync(rfdbServerRecordPath(this.socketPath)); } catch { /* already gone */ }
    try { unlinkSync(this.socketPath); } catch { /* already gone */ }
  }

  /**
   * Clear the database
   */
  async clear(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.clear();
  }

  /**
   * Flush data to disk
   */
  async flush(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.flush();
  }

  /**
   * Declare metadata fields for server-side indexing.
   * Persisted in metadata.json — survives database reopen.
   */
  async declareFields(fields: FieldDeclaration[]): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return this.client.declareFields(fields);
  }
}
