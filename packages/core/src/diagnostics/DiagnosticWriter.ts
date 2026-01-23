/**
 * DiagnosticWriter - Writes diagnostics to .grafema/diagnostics.log
 *
 * Writes diagnostics in JSON lines format (one JSON object per line).
 * This format is:
 * - Easy to parse line-by-line
 * - Appendable without reading entire file
 * - Compatible with streaming tools (grep, jq, etc.)
 *
 * Usage:
 *   const writer = new DiagnosticWriter();
 *   await writer.write(collector, '/project/.grafema');
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

import type { DiagnosticCollector } from './DiagnosticCollector.js';

/**
 * DiagnosticWriter - writes diagnostics.log file
 */
export class DiagnosticWriter {
  /**
   * Write all diagnostics to .grafema/diagnostics.log
   *
   * Creates the directory if it doesn't exist.
   * Overwrites existing file.
   */
  async write(collector: DiagnosticCollector, grafemaDir: string): Promise<void> {
    const logPath = this.getLogPath(grafemaDir);

    // Create directory if it doesn't exist
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write diagnostics as JSON lines
    const content = collector.toDiagnosticsLog();
    writeFileSync(logPath, content, 'utf-8');
  }

  /**
   * Get the path to the diagnostics.log file
   */
  getLogPath(grafemaDir: string): string {
    return join(grafemaDir, 'diagnostics.log');
  }
}
