/**
 * Get the path to the rfdb-server binary for the current platform.
 * Only checks prebuilt directory. For full search, use findRfdbBinary() from @grafema/core.
 * @deprecated Use findRfdbBinary() from @grafema/core for full binary search.
 * @returns Path to binary, or null if not available
 */
export function getBinaryPath(): string | null;

/**
 * Check if a binary is available for the current platform.
 */
export function isAvailable(): boolean;

/**
 * Wait for the server to be ready.
 * @param socketPath Unix socket path
 * @param timeout Timeout in ms (default: 5000)
 */
export function waitForServer(socketPath: string, timeout?: number): Promise<void>;
