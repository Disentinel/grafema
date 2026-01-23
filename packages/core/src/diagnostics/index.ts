/**
 * Diagnostics - Error collection, reporting, and logging
 *
 * This module provides the diagnostics infrastructure for Grafema:
 * - DiagnosticCollector: Collects errors from plugin execution
 * - DiagnosticReporter: Formats diagnostics for output (text/json/csv)
 * - DiagnosticWriter: Writes diagnostics.log file
 */

export { DiagnosticCollector } from './DiagnosticCollector.js';
export type { Diagnostic, DiagnosticInput } from './DiagnosticCollector.js';

export { DiagnosticReporter } from './DiagnosticReporter.js';
export type { ReportOptions, SummaryStats } from './DiagnosticReporter.js';

export { DiagnosticWriter } from './DiagnosticWriter.js';
