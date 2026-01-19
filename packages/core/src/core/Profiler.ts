/**
 * Profiler - utility for measuring execution time of code sections
 *
 * Usage:
 *   const profiler = new Profiler('JSASTAnalyzer');
 *   profiler.start('parse');
 *   // ... parsing code ...
 *   profiler.end('parse');
 *
 *   profiler.printSummary();
 */

/**
 * Section timing statistics
 */
export interface SectionStats {
  total: number;
  count: number;
  min: number;
  max: number;
}

/**
 * Formatted section stats for display
 */
export interface FormattedStats {
  total: string;
  count: number;
  avg: string;
  min: string;
  max: string;
}

export class Profiler {
  private name: string;
  private timings: Map<string, SectionStats>;
  private activeTimers: Map<string, bigint>;
  private enabled: boolean;

  constructor(name: string) {
    this.name = name;
    this.timings = new Map();
    this.activeTimers = new Map();
    this.enabled = process.env.NAVI_PROFILE === '1' || process.env.NAVI_PROFILE === 'true';
  }

  /**
   * Start timing a section
   */
  start(section: string): void {
    if (!this.enabled) return;
    this.activeTimers.set(section, process.hrtime.bigint());
  }

  /**
   * End timing a section and record the duration
   */
  end(section: string): void {
    if (!this.enabled) return;

    const startTime = this.activeTimers.get(section);
    if (!startTime) return;

    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000; // nanoseconds to ms

    this.activeTimers.delete(section);

    // Update stats
    if (!this.timings.has(section)) {
      this.timings.set(section, { total: 0, count: 0, min: Infinity, max: 0 });
    }

    const stats = this.timings.get(section)!;
    stats.total += durationMs;
    stats.count += 1;
    stats.min = Math.min(stats.min, durationMs);
    stats.max = Math.max(stats.max, durationMs);
  }

  /**
   * Measure a sync function execution time
   */
  measure<T>(section: string, fn: () => T): T {
    if (!this.enabled) return fn();

    this.start(section);
    try {
      return fn();
    } finally {
      this.end(section);
    }
  }

  /**
   * Measure an async function execution time
   */
  async measureAsync<T>(section: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();

    this.start(section);
    try {
      return await fn();
    } finally {
      this.end(section);
    }
  }

  /**
   * Get stats for a section
   */
  getStats(section: string): SectionStats | undefined {
    return this.timings.get(section);
  }

  /**
   * Get all stats
   */
  getAllStats(): Record<string, FormattedStats> {
    const result: Record<string, FormattedStats> = {};
    for (const [section, stats] of this.timings) {
      result[section] = {
        total: stats.total.toFixed(2),
        count: stats.count,
        avg: (stats.total / stats.count).toFixed(2),
        min: stats.min.toFixed(2),
        max: stats.max.toFixed(2)
      };
    }
    return result;
  }

  /**
   * Print summary to console
   */
  printSummary(): void {
    if (!this.enabled || this.timings.size === 0) return;

    console.log(`\n📊 [${this.name}] Profiling Summary:`);
    console.log('─'.repeat(80));
    console.log(`${'Section'.padEnd(30)} ${'Total(ms)'.padStart(12)} ${'Count'.padStart(8)} ${'Avg(ms)'.padStart(10)} ${'Min'.padStart(10)} ${'Max'.padStart(10)}`);
    console.log('─'.repeat(80));

    // Sort by total time descending
    const sorted = [...this.timings.entries()].sort((a, b) => b[1].total - a[1].total);

    for (const [section, stats] of sorted) {
      const avg = stats.total / stats.count;
      console.log(
        `${section.padEnd(30)} ${stats.total.toFixed(1).padStart(12)} ${String(stats.count).padStart(8)} ${avg.toFixed(2).padStart(10)} ${stats.min.toFixed(2).padStart(10)} ${stats.max.toFixed(2).padStart(10)}`
      );
    }

    console.log('─'.repeat(80));

    // Total time
    const totalTime = [...this.timings.values()].reduce((sum, s) => sum + s.total, 0);
    console.log(`${'TOTAL'.padEnd(30)} ${totalTime.toFixed(1).padStart(12)}`);
    console.log('');
  }

  /**
   * Reset all timings
   */
  reset(): void {
    this.timings.clear();
    this.activeTimers.clear();
  }

  /**
   * Merge stats from another profiler
   */
  merge(other: Profiler): void {
    for (const [section, otherStats] of other.timings) {
      if (!this.timings.has(section)) {
        this.timings.set(section, { total: 0, count: 0, min: Infinity, max: 0 });
      }
      const stats = this.timings.get(section)!;
      stats.total += otherStats.total;
      stats.count += otherStats.count;
      stats.min = Math.min(stats.min, otherStats.min);
      stats.max = Math.max(stats.max, otherStats.max);
    }
  }
}

// Global profiler instance for aggregating stats
export const globalProfiler = new Profiler('Global');
