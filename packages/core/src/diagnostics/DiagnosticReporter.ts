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
import { CODE_TO_CATEGORY } from './categories.js';

/**
 * Report output options
 */
export interface ReportOptions {
  format: 'text' | 'json' | 'csv';
  includeSummary?: boolean;
  includeTrace?: boolean;
}

/**
 * Options for strict mode formatting (REG-332)
 */
export interface StrictFormatOptions {
  /** Show resolution chain (hybrid: auto-show for ≤3 errors, hide for more) */
  verbose?: boolean;
  /** REG-332: Number of errors suppressed by grafema-ignore comments */
  suppressedCount?: number;
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
 * Category count with metadata
 */
export interface CategoryCount {
  code: string;
  count: number;
  name: string;
  checkCommand: string;
}

/**
 * Summary statistics with category breakdown
 */
export interface CategorizedSummaryStats extends SummaryStats {
  byCode: CategoryCount[];
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
   * Generate a categorized summary with actionable commands.
   */
  categorizedSummary(): string {
    const stats = this.getCategorizedStats();

    if (stats.total === 0) {
      return 'No issues found.';
    }

    const lines: string[] = [];

    // Severity totals (same format as summary())
    const severityParts: string[] = [];
    if (stats.fatal > 0) {
      severityParts.push(`Fatal: ${stats.fatal}`);
    }
    if (stats.errors > 0) {
      severityParts.push(`Errors: ${stats.errors}`);
    }
    if (stats.warnings > 0) {
      severityParts.push(`Warnings: ${stats.warnings}`);
    }
    lines.push(severityParts.join(', '));

    // Top 5 categories
    const topCategories = stats.byCode.slice(0, 5);
    for (const category of topCategories) {
      lines.push(`  - ${category.count} ${category.name} (run \`${category.checkCommand}\`)`);
    }

    // "Other issues" if more than 5 categories
    if (stats.byCode.length > 5) {
      const remainingCount = stats.byCode.slice(5).reduce((sum, cat) => sum + cat.count, 0);
      const issueWord = remainingCount === 1 ? 'other issue' : 'other issues';
      lines.push(`  - ${remainingCount} ${issueWord}`);
    }

    // Footer
    lines.push('');
    lines.push('Run `grafema check --all` for full diagnostics.');

    return lines.join('\n');
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
   * Get diagnostic statistics grouped by category.
   */
  getCategorizedStats(): CategorizedSummaryStats {
    const diagnostics = this.collector.getAll();

    // Get severity stats
    const severityStats: SummaryStats = {
      total: diagnostics.length,
      fatal: diagnostics.filter(d => d.severity === 'fatal').length,
      errors: diagnostics.filter(d => d.severity === 'error').length,
      warnings: diagnostics.filter(d => d.severity === 'warning').length,
      info: diagnostics.filter(d => d.severity === 'info').length,
    };

    // Group by code
    const codeMap = new Map<string, number>();
    for (const diag of diagnostics) {
      const count = codeMap.get(diag.code) || 0;
      codeMap.set(diag.code, count + 1);
    }

    // Convert to CategoryCount array with metadata
    const byCode: CategoryCount[] = [];
    for (const [code, count] of codeMap.entries()) {
      const category = CODE_TO_CATEGORY[code];
      byCode.push({
        code,
        count,
        name: category?.name || code,
        checkCommand: category?.checkCommand || 'grafema check --all',
      });
    }

    // Sort by count descending
    byCode.sort((a, b) => b.count - a.count);

    return {
      ...severityStats,
      byCode,
    };
  }

  /**
   * Format strict mode errors with enhanced context (REG-332).
   * Shows resolution chain and context-aware suggestions.
   *
   * Uses hybrid progressive disclosure:
   * - ≤3 errors: show chain by default
   * - >3 errors: hide chain unless verbose=true
   *
   * @param diagnostics - The fatal diagnostics from strict mode
   * @param options - Formatting options
   * @returns Formatted string for CLI output
   */
  formatStrict(diagnostics: Diagnostic[], options: StrictFormatOptions = {}): string {
    const lines: string[] = [];
    // Hybrid: show chain for ≤3 errors unless explicitly set
    const showChain = options.verbose ?? diagnostics.length <= 3;

    for (const diag of diagnostics) {
      // Header: CODE file:line
      const location = diag.file
        ? diag.line
          ? `${diag.file}:${diag.line}`
          : diag.file
        : '';
      lines.push(`${diag.code} ${location}`);
      lines.push('');

      // Message
      lines.push(`  ${diag.message}`);

      // Resolution chain (if showing and present)
      if (showChain && diag.resolutionChain && diag.resolutionChain.length > 0) {
        lines.push('');
        lines.push('  Resolution chain:');
        for (const step of diag.resolutionChain) {
          const stepLocation = step.file
            ? step.line
              ? ` (${step.file}:${step.line})`
              : ` (${step.file})`
            : '';
          lines.push(`    ${step.step} -> ${step.result}${stepLocation}`);
        }
      }

      // Suggestion (if present)
      if (diag.suggestion) {
        lines.push('');
        lines.push(`  Suggestion: ${diag.suggestion}`);
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    }

    // Remove trailing separator
    if (lines.length > 0) {
      lines.splice(-3);
    }

    // Add hint about verbose mode if chain hidden
    if (!showChain && diagnostics.some(d => d.resolutionChain && d.resolutionChain.length > 0)) {
      lines.push('');
      lines.push('  Run with --verbose to see resolution chains.');
    }

    // REG-332: Show suppression summary if any errors were suppressed
    if (options.suppressedCount && options.suppressedCount > 0) {
      lines.push('');
      lines.push(`  ${options.suppressedCount} error(s) suppressed by grafema-ignore comments.`);
    }

    return lines.join('\n');
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
