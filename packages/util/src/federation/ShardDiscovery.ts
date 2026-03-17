/**
 * ShardDiscovery — discovers registered RFDB shards via /tmp/rfdb-shards/.
 *
 * Each rfdb-server running with --federate writes a JSON registration file
 * containing its root path, socket, port, and PID. ShardDiscovery scans
 * these files and resolves file paths to the appropriate shard.
 *
 * Discovery is by file path prefix: if a target file's absolute path
 * starts with a shard's root, that shard owns the file.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface ShardRegistration {
  /** Absolute path of the project root this shard covers */
  root: string;
  /** Unix socket path for this shard */
  socket: string;
  /** WebSocket port (if available) */
  wsPort?: number;
  /** Process ID of the rfdb-server */
  pid: number;
  /** Epoch timestamp when the server started */
  started: number;
  /** Server version */
  serverVersion: string;
}

const SHARDS_DIR = '/tmp/rfdb-shards';

export class ShardDiscovery {
  /** root path → registration (sorted by longest root first for prefix matching) */
  private shards = new Map<string, ShardRegistration>();

  /** Number of discovered shards */
  get size(): number {
    return this.shards.size;
  }

  /** All registered shard roots */
  get roots(): string[] {
    return [...this.shards.keys()];
  }

  /**
   * Scan /tmp/rfdb-shards/ for registered shards.
   * Validates each registration: checks PID is alive, parses JSON.
   * Call this periodically or before federated queries.
   */
  scan(): number {
    this.shards.clear();

    if (!existsSync(SHARDS_DIR)) {
      return 0;
    }

    const files = readdirSync(SHARDS_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const raw = readFileSync(join(SHARDS_DIR, file), 'utf-8');
        const reg = JSON.parse(raw) as ShardRegistration;

        if (!reg.root || !reg.socket || !reg.pid) continue;

        // Check if process is still alive
        if (!isProcessAlive(reg.pid)) continue;

        // Normalize root path (ensure no trailing slash)
        const root = reg.root.replace(/\/$/, '');
        this.shards.set(root, { ...reg, root });
      } catch {
        // Skip malformed registration files
      }
    }

    return this.shards.size;
  }

  /**
   * Find the shard that owns a given absolute file path.
   * Uses longest-prefix matching: /repo/packages/api/ wins over /repo/.
   */
  resolve(absoluteFilePath: string): ShardRegistration | null {
    let bestMatch: ShardRegistration | null = null;
    let bestLength = 0;

    for (const [root, reg] of this.shards) {
      if (absoluteFilePath.startsWith(root) && root.length > bestLength) {
        bestMatch = reg;
        bestLength = root.length;
      }
    }

    return bestMatch;
  }

  /**
   * Get all known shards (for scatter-gather queries).
   */
  all(): ShardRegistration[] {
    return [...this.shards.values()];
  }

  /**
   * Register a shard programmatically (for testing or remote shards).
   */
  register(reg: ShardRegistration): void {
    const root = reg.root.replace(/\/$/, '');
    this.shards.set(root, { ...reg, root });
  }

  /**
   * Remove a shard by root path.
   */
  unregister(root: string): void {
    this.shards.delete(root.replace(/\/$/, ''));
  }
}

/** Check if a process with given PID is alive */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
