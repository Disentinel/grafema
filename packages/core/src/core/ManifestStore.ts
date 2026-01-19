/**
 * ManifestStore - simple persistent processing state storage
 *
 * Format: StableID|Phase|Status|Timestamp
 * Operations: grep for search, sed for update
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * Processing status type
 */
export type ProcessingStatus = 'done' | 'in_progress' | 'pending' | 'crashed';

/**
 * Phase statistics
 */
export interface PhaseStats {
  done: number;
  in_progress: number;
  pending: number;
  crashed?: number;
}

/**
 * All phases statistics
 */
export interface ManifestStats {
  [phase: string]: PhaseStats;
}

export class ManifestStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;

    // Create file if doesn't exist
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '# StableID|Phase|Status|Timestamp\n', 'utf-8');
    }
  }

  /**
   * Check if file is processed in phase
   * @param key - Full key like "PHASE|Plugin|Hash" or stableId
   * @param phase - For backward compat, ignored if key contains |
   */
  isDone(key: string, phase?: string): boolean {
    try {
      // If key already contains pipe, use as-is, else build pattern
      const searchKey = key.includes('|') ? key : `${key}|${phase}`;
      const pattern = `^${searchKey}\\|done`;
      execSync(`grep -q "${pattern}" "${this.filePath}"`, { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mark file as processed in phase
   * @param key - Full key like "PHASE|Plugin|Hash" or stableId
   * @param phase - For backward compat, ignored if key contains |
   */
  markDone(key: string, phase?: string): void {
    const timestamp = Math.floor(Date.now() / 1000);
    const fullKey = key.includes('|') ? key : `${key}|${phase}`;
    const line = `${fullKey}|done|${timestamp}\n`;

    // Atomic append
    appendFileSync(this.filePath, line, 'utf-8');
  }

  /**
   * Mark file as in progress
   * @param key - Full key like "PHASE|Plugin|Hash" or stableId
   * @param phase - For backward compat, ignored if key contains |
   */
  markInProgress(key: string, phase?: string): void {
    const timestamp = Math.floor(Date.now() / 1000);
    const fullKey = key.includes('|') ? key : `${key}|${phase}`;
    const line = `${fullKey}|in_progress|${timestamp}\n`;

    appendFileSync(this.filePath, line, 'utf-8');
  }

  /**
   * Get status of file in phase
   * @param key - Full key like "PHASE|Plugin|Hash" or stableId
   * @param phase - For backward compat, ignored if key contains |
   */
  getStatus(key: string, phase?: string): ProcessingStatus {
    try {
      const searchKey = key.includes('|') ? key : `${key}|${phase}`;
      const pattern = `^${searchKey}\\|`;
      const result = execSync(
        `grep "${pattern}" "${this.filePath}" | tail -1`,
        { encoding: 'utf-8' }
      ).trim();

      if (!result) return 'pending';

      const parts = result.split('|');
      // Status is after the key parts
      const statusIndex = key.includes('|') ? key.split('|').length : 2;
      return parts[statusIndex] as ProcessingStatus;
    } catch {
      return 'pending';
    }
  }

  /**
   * Get all files for phase with specific status
   */
  getByStatus(phase: string, status: ProcessingStatus): string[] {
    try {
      const pattern = `\\|${phase}\\|${status}\\|`;
      const result = execSync(
        `grep "${pattern}" "${this.filePath}" | cut -d'|' -f1`,
        { encoding: 'utf-8' }
      ).trim();

      return result ? result.split('\n') : [];
    } catch {
      return [];
    }
  }

  /**
   * Get statistics by phases
   */
  getStats(): ManifestStats {
    const content = readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l && !l.startsWith('#'));

    const stats: ManifestStats = {};

    for (const line of lines) {
      const parts = line.split('|');
      const phase = parts[1];
      const status = parts[2] as ProcessingStatus;

      if (!phase || !status) continue;

      if (!stats[phase]) {
        stats[phase] = { done: 0, in_progress: 0, pending: 0 };
      }

      if (status in stats[phase]) {
        (stats[phase] as unknown as Record<string, number>)[status]++;
      }
    }

    return stats;
  }

  /**
   * Clean up stale in_progress (crashed processes)
   * @param olderThanSeconds - older than N seconds considered dead
   */
  cleanupStaleProgress(olderThanSeconds: number = 300): void {
    const now = Math.floor(Date.now() / 1000);
    const content = readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n');

    const cleaned = lines.map(line => {
      if (!line || line.startsWith('#')) return line;

      const parts = line.split('|');
      const status = parts[2];
      const timestamp = parts[3];

      if (status === 'in_progress' && timestamp) {
        const age = now - parseInt(timestamp);
        if (age > olderThanSeconds) {
          // Mark as crashed (process died)
          parts[2] = 'crashed';
          return parts.join('|');
        }
      }

      return line;
    });

    writeFileSync(this.filePath, cleaned.join('\n'), 'utf-8');
  }

  /**
   * Clear entire manifest (for testing)
   */
  clear(): void {
    writeFileSync(this.filePath, '# StableID|Phase|Status|Timestamp\n', 'utf-8');
  }
}
