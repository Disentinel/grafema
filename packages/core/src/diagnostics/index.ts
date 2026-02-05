/**
 * Diagnostics - Error collection, reporting, and logging
 *
 * This module provides the diagnostics infrastructure for Grafema:
 * - DiagnosticCollector: Collects errors from plugin execution
 * - DiagnosticReporter: Formats diagnostics for output (text/json/csv)
 * - DiagnosticWriter: Writes diagnostics.log file
 * - categories: Single source of truth for diagnostic category mappings
 */

export { DiagnosticCollector } from './DiagnosticCollector.js';
export type { Diagnostic, DiagnosticInput } from './DiagnosticCollector.js';

export { DiagnosticReporter } from './DiagnosticReporter.js';
export type { ReportOptions, SummaryStats, CategoryCount, CategorizedSummaryStats } from './DiagnosticReporter.js';

export { DiagnosticWriter } from './DiagnosticWriter.js';

// Category mappings (single source of truth)
export {
  DIAGNOSTIC_CATEGORIES,
  CODE_TO_CATEGORY,
  getCategoryForCode,
  getCodesForCategory,
} from './categories.js';
export type {
  DiagnosticCategory,
  DiagnosticCategoryKey,
  CodeCategoryInfo,
} from './categories.js';
