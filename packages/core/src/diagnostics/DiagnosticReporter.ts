/**
 * DiagnosticReporter - Formats diagnostics for output
 *
 * Supports multiple output formats:
 * - text: Human-readable format with severity indicators
 * - json: Machine-readable JSON format for CI integration
 * - csv: Spreadsheet-compatible format
 *
 * Usage:
 *   const reporter = new DiagnosticReporter(collector);
 *   console.log(reporter.report({ format: 'text', includeSummary: true }));
 *   console.log(reporter.summary());
 */

import type { Diagnostic, DiagnosticCollector } from './DiagnosticCollector.js';

/**
 * Report output options
 */
export interface ReportOptions {
  format: 'text' | 'json' | 'csv';
  includeSummary?: boolean;
  includeTrace?: boolean;
}

/**
 * Summary statistics
 */
export interface SummaryStats {
  total: number;
  fatal: number;
  errors: number;
  warnings: number;
  info: number;
}

/**
 * DiagnosticReporter - formats diagnostics for different output formats
 */
export class DiagnosticReporter {
  constructor(private collector: DiagnosticCollector) {}

  /**
   * Generate a formatted report of all diagnostics.
   */
  report(options: ReportOptions): string {
    const diagnostics = this.collector.getAll();

    if (options.format === 'json') {
      return this.jsonReport(diagnostics, options);
    } else if (options.format === 'csv') {
      return this.csvReport(diagnostics);
    } else {
      return this.textReport(diagnostics, options);
    }
  }

  /**
   * Generate a human-readable summary of diagnostic counts.
   */
  summary(): string {
    const stats = this.getStats();

    if (stats.total === 0) {
      return 'No issues found.';
    }

    const parts: string[] = [];

    if (stats.fatal > 0) {
      parts.push(`Fatal: ${stats.fatal}`);
    }
    if (stats.errors > 0) {
      parts.push(`Errors: ${stats.errors}`);
    }
    if (stats.warnings > 0) {
      parts.push(`Warnings: ${stats.warnings}`);
    }

    return parts.join(', ');
  }

  /**
   * Get diagnostic statistics by severity.
   */
  getStats(): SummaryStats {
    const diagnostics = this.collector.getAll();
    return {
      total: diagnostics.length,
      fatal: diagnostics.filter(d => d.severity === 'fatal').length,
      errors: diagnostics.filter(d => d.severity === 'error').length,
      warnings: diagnostics.filter(d => d.severity === 'warning').length,
      info: diagnostics.filter(d => d.severity === 'info').length,
    };
  }

  /**
   * Generate human-readable text report.
   */
  private textReport(diagnostics: Diagnostic[], options: ReportOptions): string {
    if (diagnostics.length === 0) {
      return 'No issues found.';
    }

    const lines: string[] = [];

    for (const diag of diagnostics) {
      const icon = this.getSeverityIcon(diag.severity);
      const location = this.formatLocation(diag);

      lines.push(`${icon} ${diag.code} ${location} ${diag.message}`);

      if (diag.suggestion) {
        lines.push(`   Suggestion: ${diag.suggestion}`);
      }
    }

    if (options.includeSummary) {
      lines.push('');
      lines.push(this.summary());
    }

    return lines.join('\n');
  }

  /**
   * Generate JSON report.
   */
  private jsonReport(diagnostics: Diagnostic[], options: ReportOptions): string {
    const result: {
      diagnostics: Diagnostic[];
      summary?: SummaryStats;
    } = {
      diagnostics,
    };

    if (options.includeSummary) {
      result.summary = this.getStats();
    }

    return JSON.stringify(result, null, 2);
  }

  /**
   * Generate CSV report.
   */
  private csvReport(diagnostics: Diagnostic[]): string {
    const header = 'severity,code,file,line,message,plugin,phase,suggestion';
    const rows = diagnostics.map(d =>
      [
        d.severity,
        d.code,
        d.file || '',
        d.line || '',
        this.csvEscape(d.message),
        d.plugin,
        d.phase,
        d.suggestion ? this.csvEscape(d.suggestion) : '',
      ].join(',')
    );
    return [header, ...rows].join('\n');
  }

  /**
   * Get severity indicator for text output.
   */
  private getSeverityIcon(severity: Diagnostic['severity']): string {
    switch (severity) {
      case 'fatal':
        return '[FATAL]';
      case 'error':
        return '[ERROR]';
      case 'warning':
        return '[WARN]';
      case 'info':
        return '[INFO]';
      default:
        return '[?]';
    }
  }

  /**
   * Format file location for display.
   */
  private formatLocation(diag: Diagnostic): string {
    if (!diag.file) {
      return '';
    }
    if (diag.line) {
      return `(${diag.file}:${diag.line})`;
    }
    return `(${diag.file})`;
  }

  /**
   * Escape a value for CSV output.
   * Wraps in quotes and escapes internal quotes.
   */
  private csvEscape(value: string): string {
    // Always quote to handle commas and special characters
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
}
