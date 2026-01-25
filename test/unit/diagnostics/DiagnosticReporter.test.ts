/**
 * DiagnosticReporter Tests
 *
 * Tests for DiagnosticReporter class.
 * Based on specification: _tasks/2026-01-23-reg-78-error-handling-diagnostics/003-joel-tech-plan.md
 *
 * Tests:
 * - report({ format: 'text' }) - human readable format
 * - report({ format: 'json' }) - JSON format
 * - summary() - "Analyzed X files. Errors: Y, Warnings: Z"
 * - Includes suggestions in output
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { DiagnosticCollector, DiagnosticReporter } from '@grafema/core';
import type { Diagnostic } from '@grafema/core';
import type { PluginPhase } from '@grafema/types';

// =============================================================================
// Helper to create collector with diagnostics
// =============================================================================

/**
 * Create a DiagnosticCollector pre-populated with diagnostics
 */
function createCollectorWithDiagnostics(diagnostics: Omit<Diagnostic, 'timestamp'>[]): DiagnosticCollector {
  const collector = new DiagnosticCollector();
  for (const diag of diagnostics) {
    collector.add(diag);
  }
  return collector;
}

// =============================================================================
// Test Helpers
// =============================================================================

function createDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'ERR_TEST',
    severity: 'error',
    message: 'Test error message',
    phase: 'INDEXING',
    plugin: 'TestPlugin',
    timestamp: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// TESTS: DiagnosticReporter
// =============================================================================

describe('DiagnosticReporter', () => {
  // ===========================================================================
  // TESTS: report({ format: 'text' })
  // ===========================================================================

  describe('report({ format: "text" })', () => {
    it('should return human-readable format', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_PARSE_FAILURE',
          severity: 'warning',
          message: 'Failed to parse file',
          file: 'src/app.js',
          line: 42,
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(output.includes('ERR_PARSE_FAILURE'), 'Should include error code');
      assert.ok(output.includes('src/app.js'), 'Should include file path');
      assert.ok(output.includes('42'), 'Should include line number');
      assert.ok(output.includes('Failed to parse file'), 'Should include message');
    });

    it('should include severity indicator', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'fatal', code: 'ERR_FATAL' }),
        createDiagnostic({ severity: 'error', code: 'ERR_ERROR' }),
        createDiagnostic({ severity: 'warning', code: 'ERR_WARN' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(output.includes('[FATAL]') || output.includes('FATAL'), 'Should indicate fatal');
      assert.ok(output.includes('[ERROR]') || output.includes('ERROR'), 'Should indicate error');
      assert.ok(output.includes('[WARN]') || output.includes('WARN'), 'Should indicate warning');
    });

    it('should include suggestions in output', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_GIT_NOT_FOUND',
          message: 'Git repository not found',
          suggestion: 'Run `git init` to initialize a repository',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(
        output.includes('Run `git init` to initialize a repository'),
        'Should include suggestion'
      );
    });

    it('should handle diagnostics without file info', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_DATABASE_LOCKED',
          message: 'Database is locked',
          file: undefined,
          line: undefined,
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(output.includes('ERR_DATABASE_LOCKED'), 'Should include error code');
      assert.ok(output.includes('Database is locked'), 'Should include message');
    });

    it('should handle file without line number', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_FILE_UNREADABLE',
          message: 'Cannot read file',
          file: 'src/config.json',
          line: undefined,
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(output.includes('src/config.json'), 'Should include file path');
      // Should not crash or show "undefined"
      assert.ok(!output.includes('undefined'), 'Should not include "undefined"');
    });

    it('should return "No issues found" when empty', () => {
      const collector = createCollectorWithDiagnostics([]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(
        output.includes('No issues') || output === '',
        'Should indicate no issues or be empty'
      );
    });

    it('should include summary when requested', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'warning' }),
        createDiagnostic({ severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text', includeSummary: true });

      assert.ok(output.includes('Errors: 1') || output.includes('1 error'), 'Should show error count');
      assert.ok(output.includes('Warnings: 2') || output.includes('2 warning'), 'Should show warning count');
    });

    it('should handle multiple diagnostics', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_1', message: 'First error' }),
        createDiagnostic({ code: 'ERR_2', message: 'Second error' }),
        createDiagnostic({ code: 'ERR_3', message: 'Third error' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(output.includes('First error'), 'Should include first error');
      assert.ok(output.includes('Second error'), 'Should include second error');
      assert.ok(output.includes('Third error'), 'Should include third error');
    });
  });

  // ===========================================================================
  // TESTS: report({ format: 'json' })
  // ===========================================================================

  describe('report({ format: "json" })', () => {
    it('should return valid JSON', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_TEST' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'json' });

      assert.doesNotThrow(() => JSON.parse(output), 'Should be valid JSON');
    });

    it('should include all diagnostic fields', () => {
      const diag = createDiagnostic({
        code: 'ERR_PARSE_FAILURE',
        severity: 'warning',
        message: 'Parse failed',
        file: 'src/app.js',
        line: 42,
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
        suggestion: 'Fix syntax',
      });
      const collector = createCollectorWithDiagnostics([diag]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'json' });
      const parsed = JSON.parse(output);

      assert.ok(parsed.diagnostics, 'Should have diagnostics array');
      assert.strictEqual(parsed.diagnostics.length, 1);

      const d = parsed.diagnostics[0];
      assert.strictEqual(d.code, 'ERR_PARSE_FAILURE');
      assert.strictEqual(d.severity, 'warning');
      assert.strictEqual(d.message, 'Parse failed');
      assert.strictEqual(d.file, 'src/app.js');
      assert.strictEqual(d.line, 42);
      assert.strictEqual(d.phase, 'INDEXING');
      assert.strictEqual(d.plugin, 'JSModuleIndexer');
      assert.strictEqual(d.suggestion, 'Fix syntax');
    });

    it('should include summary when requested', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'json', includeSummary: true });
      const parsed = JSON.parse(output);

      assert.ok(parsed.summary, 'Should have summary object');
      assert.strictEqual(parsed.summary.total, 2);
      assert.strictEqual(parsed.summary.errors, 1);
      assert.strictEqual(parsed.summary.warnings, 1);
    });

    it('should handle empty diagnostics', () => {
      const collector = createCollectorWithDiagnostics([]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'json' });
      const parsed = JSON.parse(output);

      assert.ok(Array.isArray(parsed.diagnostics), 'Should have diagnostics array');
      assert.strictEqual(parsed.diagnostics.length, 0);
    });

    it('should handle special characters in messages', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          message: 'Error with "quotes" and \\ backslashes',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'json' });

      assert.doesNotThrow(() => JSON.parse(output), 'Should handle special characters');
    });
  });

  // ===========================================================================
  // TESTS: report({ format: 'csv' })
  // ===========================================================================

  describe('report({ format: "csv" })', () => {
    it('should return CSV format with header', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_TEST' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'csv' });
      const lines = output.split('\n');

      assert.ok(lines[0].includes('severity'), 'Should have header');
      assert.ok(lines[0].includes('code'), 'Should have code in header');
      assert.ok(lines[0].includes('message'), 'Should have message in header');
    });

    it('should include all rows', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_1' }),
        createDiagnostic({ code: 'ERR_2' }),
        createDiagnostic({ code: 'ERR_3' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'csv' });
      const lines = output.split('\n');

      // Header + 3 data rows
      assert.strictEqual(lines.length, 4);
    });

    it('should handle messages with commas', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          message: 'Error at line 1, column 5',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'csv' });

      // Message should be quoted
      assert.ok(output.includes('"Error at line 1, column 5"'), 'Should quote messages with commas');
    });

    it('should handle messages with quotes', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          message: 'Missing "name" field',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'csv' });

      // Quotes should be escaped
      assert.ok(
        output.includes('""name""') || output.includes('\\"name\\"'),
        'Should escape quotes in messages'
      );
    });
  });

  // ===========================================================================
  // TESTS: summary()
  // ===========================================================================

  describe('summary()', () => {
    it('should return "No issues found" when empty', () => {
      const collector = createCollectorWithDiagnostics([]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.summary();

      assert.ok(
        summary.includes('No issues') || summary === '',
        'Should indicate no issues'
      );
    });

    it('should count errors correctly', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'error' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.summary();

      assert.ok(summary.includes('3') || summary.includes('Errors'), 'Should count errors');
    });

    it('should count warnings correctly', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'warning' }),
        createDiagnostic({ severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.summary();

      assert.ok(summary.includes('2') || summary.includes('Warning'), 'Should count warnings');
    });

    it('should count fatal errors separately', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'fatal' }),
        createDiagnostic({ severity: 'error' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.summary();

      // Implementation may show "Fatal: 1, Errors: 1" or similar
      assert.ok(
        summary.includes('Fatal') || summary.includes('fatal') || summary.includes('1'),
        'Should indicate fatal errors'
      );
    });

    it('should show mixed counts', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'fatal' }),
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'warning' }),
        createDiagnostic({ severity: 'warning' }),
        createDiagnostic({ severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.summary();

      // Should show all counts
      assert.ok(summary.length > 0, 'Should have content');
    });
  });

  // ===========================================================================
  // TESTS: getStats()
  // ===========================================================================

  describe('getStats()', () => {
    it('should return zero counts when empty', () => {
      const collector = createCollectorWithDiagnostics([]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getStats();

      assert.strictEqual(stats.total, 0);
      assert.strictEqual(stats.fatal, 0);
      assert.strictEqual(stats.errors, 0);
      assert.strictEqual(stats.warnings, 0);
      assert.strictEqual(stats.info, 0);
    });

    it('should count each severity correctly', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'fatal' }),
        createDiagnostic({ severity: 'fatal' }),
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'warning' }),
        createDiagnostic({ severity: 'info' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getStats();

      assert.strictEqual(stats.total, 7);
      assert.strictEqual(stats.fatal, 2);
      assert.strictEqual(stats.errors, 3);
      assert.strictEqual(stats.warnings, 1);
      assert.strictEqual(stats.info, 1);
    });

    it('should return correct total', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getStats();

      assert.strictEqual(stats.total, 2);
      assert.strictEqual(stats.errors + stats.warnings + stats.fatal + stats.info, stats.total);
    });
  });

  // ===========================================================================
  // TESTS: Suggestions in Output
  // ===========================================================================

  describe('suggestions in output', () => {
    it('should include suggestion in text format', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_DATABASE_CORRUPTED',
          message: 'Database corruption detected',
          suggestion: 'Run `grafema analyze --clear` to rebuild the database',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(
        output.includes('grafema analyze --clear'),
        'Should include suggestion in text output'
      );
    });

    it('should include suggestion in JSON format', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          suggestion: 'Install missing dependency',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'json' });
      const parsed = JSON.parse(output);

      assert.strictEqual(
        parsed.diagnostics[0].suggestion,
        'Install missing dependency'
      );
    });

    it('should handle missing suggestion gracefully', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          suggestion: undefined,
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const textOutput = reporter.report({ format: 'text' });
      const jsonOutput = reporter.report({ format: 'json' });

      // Should not crash
      assert.ok(textOutput !== undefined);
      assert.doesNotThrow(() => JSON.parse(jsonOutput));
    });
  });

  // ===========================================================================
  // TESTS: getCategorizedStats()
  // ===========================================================================

  describe('getCategorizedStats()', () => {
    it('should return empty array when no diagnostics', () => {
      const collector = createCollectorWithDiagnostics([]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getCategorizedStats();

      assert.strictEqual(stats.total, 0);
      assert.strictEqual(stats.fatal, 0);
      assert.strictEqual(stats.errors, 0);
      assert.strictEqual(stats.warnings, 0);
      assert.strictEqual(stats.info, 0);
      assert.strictEqual(stats.byCode.length, 0);
    });

    it('should group diagnostics by code', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getCategorizedStats();

      assert.strictEqual(stats.byCode.length, 2);

      const disconnected = stats.byCode.find(c => c.code === 'DISCONNECTED_NODES');
      assert.ok(disconnected, 'Should have DISCONNECTED_NODES category');
      assert.strictEqual(disconnected.count, 3);

      const unresolved = stats.byCode.find(c => c.code === 'UNRESOLVED_FUNCTION_CALL');
      assert.ok(unresolved, 'Should have UNRESOLVED_FUNCTION_CALL category');
      assert.strictEqual(unresolved.count, 2);
    });

    it('should sort categories by count descending', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'MISSING_ASSIGNMENT', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getCategorizedStats();

      assert.strictEqual(stats.byCode.length, 3);
      // Should be sorted descending: 5, 3, 1
      assert.strictEqual(stats.byCode[0].code, 'UNRESOLVED_FUNCTION_CALL');
      assert.strictEqual(stats.byCode[0].count, 5);
      assert.strictEqual(stats.byCode[1].code, 'DISCONNECTED_NODES');
      assert.strictEqual(stats.byCode[1].count, 3);
      assert.strictEqual(stats.byCode[2].code, 'MISSING_ASSIGNMENT');
      assert.strictEqual(stats.byCode[2].count, 1);
    });

    it('should include category name for known codes', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getCategorizedStats();

      assert.strictEqual(stats.byCode.length, 1);
      assert.strictEqual(stats.byCode[0].name, 'disconnected nodes');
    });

    it('should include check command for known codes', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getCategorizedStats();

      assert.strictEqual(stats.byCode.length, 1);
      assert.strictEqual(stats.byCode[0].checkCommand, 'grafema check connectivity');
    });

    it('should handle unknown diagnostic codes', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'UNKNOWN_CODE_XYZ', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getCategorizedStats();

      assert.strictEqual(stats.byCode.length, 1);
      assert.strictEqual(stats.byCode[0].code, 'UNKNOWN_CODE_XYZ');
      // Should have fallback values
      assert.ok(stats.byCode[0].name);
      assert.ok(stats.byCode[0].checkCommand);
    });

    it('should include severity totals', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'error' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const stats = reporter.getCategorizedStats();

      assert.strictEqual(stats.total, 3);
      assert.strictEqual(stats.warnings, 2);
      assert.strictEqual(stats.errors, 1);
    });
  });

  // ===========================================================================
  // TESTS: categorizedSummary()
  // ===========================================================================

  describe('categorizedSummary()', () => {
    it('should return "No issues found" when empty', () => {
      const collector = createCollectorWithDiagnostics([]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(
        summary.includes('No issues') || summary === 'No issues found.',
        'Should indicate no issues'
      );
    });

    it('should show severity totals', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(summary.includes('Warnings: 3'), 'Should show warning count');
    });

    it('should show category counts with friendly names', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(summary.includes('3 disconnected nodes'), 'Should show disconnected nodes count');
      assert.ok(summary.includes('2 unresolved calls'), 'Should show unresolved calls count');
    });

    it('should show check commands for each category', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(
        summary.includes('grafema check connectivity'),
        'Should show connectivity check command'
      );
      assert.ok(summary.includes('grafema check calls'), 'Should show calls check command');
    });

    it('should show footer with --all command', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(
        summary.includes('grafema check --all'),
        'Should show --all command in footer'
      );
    });

    it('should limit to top 5 categories by default', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'CODE_A', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_A', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_A', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_A', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_A', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_A', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_B', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_B', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_B', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_B', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_B', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_C', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_C', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_C', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_C', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_D', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_D', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_D', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_E', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_E', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_F', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_G', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      // Should show top 5 categories (CODE_A through CODE_E)
      assert.ok(summary.includes('CODE_A'), 'Should show CODE_A');
      assert.ok(summary.includes('CODE_B'), 'Should show CODE_B');
      assert.ok(summary.includes('CODE_C'), 'Should show CODE_C');
      assert.ok(summary.includes('CODE_D'), 'Should show CODE_D');
      assert.ok(summary.includes('CODE_E'), 'Should show CODE_E');

      // Should NOT show CODE_F and CODE_G in individual lines
      // They should be in "other issues" summary
      const lines = summary.split('\n');
      const categoryLines = lines.filter(line => line.includes('CODE_'));
      assert.ok(categoryLines.length <= 5, 'Should limit to 5 category lines');
    });

    it('should show "other issues" when more than 5 categories', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'CODE_A', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_B', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_C', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_D', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_E', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_F', severity: 'warning' }),
        createDiagnostic({ code: 'CODE_G', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(
        summary.includes('2 other issue') || summary.includes('other'),
        'Should indicate other issues exist'
      );
    });

    it('should handle mixed severities correctly', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'error' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(summary.includes('Warnings: 2'), 'Should count warnings');
      assert.ok(summary.includes('Errors: 1'), 'Should count errors');
    });

    it('should format output with proper indentation', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      // Categories should be indented under severity totals
      const lines = summary.split('\n');
      const categoryLine = lines.find(line => line.includes('disconnected nodes'));
      assert.ok(categoryLine, 'Should have category line');
      assert.ok(
        categoryLine.startsWith('  ') || categoryLine.startsWith('\t'),
        'Category line should be indented'
      );
    });

    it('should handle single category gracefully', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      assert.ok(summary.includes('2 disconnected nodes'), 'Should show single category');
      assert.ok(
        !summary.includes('other issue'),
        'Should not mention other issues when only one category'
      );
    });

    it('should match expected output format from spec', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'DISCONNECTED_NODES', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'UNRESOLVED_FUNCTION_CALL', severity: 'warning' }),
        createDiagnostic({ code: 'MISSING_ASSIGNMENT', severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const summary = reporter.categorizedSummary();

      // Should have:
      // - "Warnings: 8"
      // - Categories with counts and commands
      // - Footer with --all command
      assert.ok(summary.includes('Warnings: 8'), 'Should show total warnings');
      assert.ok(
        summary.includes('5 unresolved calls'),
        'Should show unresolved calls count'
      );
      assert.ok(
        summary.includes('2 disconnected nodes'),
        'Should show disconnected nodes count'
      );
      assert.ok(
        summary.includes('1 missing assignment'),
        'Should show missing assignment count'
      );
      assert.ok(summary.includes('grafema check calls'), 'Should show calls command');
      assert.ok(summary.includes('grafema check connectivity'), 'Should show connectivity command');
      assert.ok(summary.includes('grafema check dataflow'), 'Should show dataflow command');
      assert.ok(summary.includes('grafema check --all'), 'Should show --all command');
    });
  });

  // ===========================================================================
  // TESTS: Real-world scenarios
  // ===========================================================================

  describe('real-world scenarios', () => {
    it('should format typical analysis output', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_PARSE_FAILURE',
          severity: 'warning',
          message: 'Syntax error in file',
          file: 'src/components/Button.jsx',
          line: 15,
          plugin: 'JSModuleIndexer',
          phase: 'INDEXING',
          suggestion: 'Check JSX syntax',
        }),
        createDiagnostic({
          code: 'ERR_FILE_UNREADABLE',
          severity: 'error',
          message: 'Permission denied',
          file: 'src/secrets.json',
          plugin: 'FileReader',
          phase: 'DISCOVERY',
          suggestion: 'Check file permissions',
        }),
        createDiagnostic({
          code: 'ERR_UNSUPPORTED_LANG',
          severity: 'warning',
          message: 'Rust files not supported',
          file: 'src/native/lib.rs',
          plugin: 'JSModuleIndexer',
          phase: 'INDEXING',
          suggestion: 'Use RustAnalyzer plugin',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text', includeSummary: true });

      // Should include all three diagnostics
      assert.ok(output.includes('Button.jsx'), 'Should include first file');
      assert.ok(output.includes('secrets.json'), 'Should include second file');
      assert.ok(output.includes('lib.rs'), 'Should include third file');

      // Should include summary
      assert.ok(
        output.includes('Error') || output.includes('Warning'),
        'Should include summary'
      );
    });

    it('should format fatal error prominently', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_DATABASE_CORRUPTED',
          severity: 'fatal',
          message: 'Graph database is corrupted',
          suggestion: 'Run `grafema analyze --clear` to rebuild',
        }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'text' });

      assert.ok(
        output.includes('FATAL') || output.includes('fatal'),
        'Should prominently indicate fatal error'
      );
      assert.ok(
        output.includes('grafema analyze --clear'),
        'Should include recovery suggestion'
      );
    });

    it('should generate machine-readable JSON for CI integration', () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ severity: 'error' }),
        createDiagnostic({ severity: 'warning' }),
      ]);
      const reporter = new DiagnosticReporter(collector);

      const output = reporter.report({ format: 'json', includeSummary: true });
      const parsed = JSON.parse(output);

      // CI can check these fields
      assert.ok(Array.isArray(parsed.diagnostics));
      assert.ok(parsed.summary);
      assert.strictEqual(typeof parsed.summary.errors, 'number');
      assert.strictEqual(typeof parsed.summary.warnings, 'number');
    });
  });
});
