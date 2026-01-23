/**
 * DiagnosticCollector - Collects and filters diagnostics from plugin execution
 *
 * The DiagnosticCollector aggregates errors from PluginResult.errors[],
 * converting both GrafemaError instances (with rich info) and plain Error
 * instances (treated as generic errors) into unified Diagnostic entries.
 *
 * Usage:
 *   const collector = new DiagnosticCollector();
 *   collector.addFromPluginResult('INDEXING', 'JSModuleIndexer', result);
 *
 *   if (collector.hasFatal()) {
 *     throw new Error('Fatal error detected');
 *   }
 *
 *   console.log(collector.toDiagnosticsLog());
 */

import type { PluginPhase, PluginResult } from '@grafema/types';
import { GrafemaError } from '../errors/GrafemaError.js';

/**
 * Diagnostic entry - unified format for all errors/warnings
 */
export interface Diagnostic {
  code: string;
  severity: 'fatal' | 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  phase: PluginPhase;
  plugin: string;
  timestamp: number;
  suggestion?: string;
}

/**
 * Diagnostic input (without timestamp, which is auto-generated)
 */
export type DiagnosticInput = Omit<Diagnostic, 'timestamp'>;

/**
 * DiagnosticCollector - collects, filters, and formats diagnostics
 */
export class DiagnosticCollector {
  private diagnostics: Diagnostic[] = [];

  /**
   * Extract errors from PluginResult and add as diagnostics.
   *
   * GrafemaError instances provide rich info (code, severity, context, suggestion).
   * Plain Error instances are treated as generic errors with code 'ERR_UNKNOWN'.
   */
  addFromPluginResult(phase: PluginPhase, plugin: string, result: PluginResult): void {
    for (const error of result.errors) {
      if (error instanceof GrafemaError) {
        this.add({
          code: error.code,
          severity: error.severity,
          message: error.message,
          file: error.context.filePath,
          line: error.context.lineNumber,
          phase,
          plugin,
          suggestion: error.suggestion,
        });
      } else {
        // Plain Error - treat as generic error
        this.add({
          code: 'ERR_UNKNOWN',
          severity: 'error',
          message: error.message,
          phase,
          plugin,
        });
      }
    }
  }

  /**
   * Add a diagnostic directly.
   * Timestamp is set automatically.
   */
  add(diagnostic: DiagnosticInput): void {
    this.diagnostics.push({
      ...diagnostic,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all diagnostics.
   * Returns a copy to prevent external modification.
   */
  getAll(): Diagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * Get diagnostics filtered by phase.
   */
  getByPhase(phase: PluginPhase): Diagnostic[] {
    return this.diagnostics.filter(d => d.phase === phase);
  }

  /**
   * Get diagnostics filtered by plugin name (case-sensitive).
   */
  getByPlugin(plugin: string): Diagnostic[] {
    return this.diagnostics.filter(d => d.plugin === plugin);
  }

  /**
   * Get diagnostics filtered by error code.
   */
  getByCode(code: string): Diagnostic[] {
    return this.diagnostics.filter(d => d.code === code);
  }

  /**
   * Check if any fatal diagnostic exists.
   * Fatal errors require immediate stop of analysis.
   */
  hasFatal(): boolean {
    return this.diagnostics.some(d => d.severity === 'fatal');
  }

  /**
   * Check if any error (including fatal) exists.
   */
  hasErrors(): boolean {
    return this.diagnostics.some(d => d.severity === 'error' || d.severity === 'fatal');
  }

  /**
   * Check if any warning exists.
   */
  hasWarnings(): boolean {
    return this.diagnostics.some(d => d.severity === 'warning');
  }

  /**
   * Get total count of diagnostics.
   */
  count(): number {
    return this.diagnostics.length;
  }

  /**
   * Format diagnostics as JSON lines (one JSON object per line).
   * Suitable for .grafema/diagnostics.log file.
   */
  toDiagnosticsLog(): string {
    return this.diagnostics.map(d => JSON.stringify(d)).join('\n');
  }

  /**
   * Clear all diagnostics.
   */
  clear(): void {
    this.diagnostics = [];
  }
}
