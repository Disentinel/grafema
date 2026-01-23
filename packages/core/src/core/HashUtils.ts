/**
 * HashUtils - unified hash computation for Grafema
 *
 * WHY THIS EXISTS:
 * - 6 copies of the same hash computation existed across the codebase
 * - Single source of truth ensures consistent hashing everywhere
 * - Makes future algorithm changes (e.g., SHA-256 -> BLAKE3) trivial
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';

const HASH_ALGORITHM = 'sha256';

/**
 * Calculate hash from a file path (synchronous).
 * Returns null if file doesn't exist or is unreadable.
 */
export function calculateFileHash(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return createHash(HASH_ALGORITHM).update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Calculate hash from a file path (asynchronous).
 * Returns null if file doesn't exist or is unreadable.
 */
export async function calculateFileHashAsync(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return createHash(HASH_ALGORITHM).update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Calculate hash from content string.
 * Always returns a hash (never null).
 */
export function calculateContentHash(content: string): string {
  return createHash(HASH_ALGORITHM).update(content).digest('hex');
}
