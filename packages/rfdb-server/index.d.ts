import { ChildProcess } from 'child_process';

/**
 * Get the path to the rfdb-server binary for the current platform.
 * @returns Path to binary, or null if not available
 */
export function getBinaryPath(): string | null;

/**
 * Check if a binary is available for the current platform.
 */
export function isAvailable(): boolean;

export interface StartServerOptions {
  /** Unix socket path (default: /tmp/rfdb.sock) */
  socketPath?: string;
  /** Data directory (default: ./rfdb-data) */
  dataDir?: string;
  /** Suppress output (default: false) */
  silent?: boolean;
}

/**
 * Start the rfdb-server.
 * @returns The server process
 */
export function startServer(options?: StartServerOptions): ChildProcess & { socketPath: string };

/**
 * Wait for the server to be ready.
 * @param socketPath Unix socket path
 * @param timeout Timeout in ms (default: 5000)
 */
export function waitForServer(socketPath: string, timeout?: number): Promise<void>;
