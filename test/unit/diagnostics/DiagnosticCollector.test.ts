/**
 * DiagnosticCollector Tests
 *
 * Tests for DiagnosticCollector class.
 * Based on specification: _tasks/2026-01-23-reg-78-error-handling-diagnostics/003-joel-tech-plan.md
 *
 * Tests:
 * - addFromPluginResult() extracts errors from PluginResult
 * - Handles GrafemaError (rich info) vs plain Error (generic)
 * - getByPhase(), getByPlugin(), getByCode() filtering
 * - hasFatal(), hasErrors() methods
 * - toDiagnosticsLog() returns JSON lines format
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  GrafemaError,
  ConfigError,
  FileAccessError,
  LanguageError,
  DatabaseError,
  PluginError,
  AnalysisError,
  DiagnosticCollector,
} from '@grafema/core';
import type { Diagnostic } from '@grafema/core';

import type { PluginResult, PluginPhase } from '@grafema/types';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a success PluginResult with no errors
 */
function createSuccessResult(nodes = 0, edges = 0): PluginResult {
  return {
    success: true,
    created: { nodes, edges },
    errors: [],
    warnings: [],
    metadata: {},
  };
}

/**
 * Create a failure PluginResult with errors
 */
function createErrorResult(errors: Error[], warnings: string[] = []): PluginResult {
  return {
    success: false,
    created: { nodes: 0, edges: 0 },
    errors,
    warnings,
    metadata: {},
  };
}

// =============================================================================
// TESTS: DiagnosticCollector
// =============================================================================

describe('DiagnosticCollector', () => {
  let collector: DiagnosticCollector;

  beforeEach(() => {
    collector = new DiagnosticCollector();
  });

  // ===========================================================================
  // TESTS: addFromPluginResult()
  // ===========================================================================

  describe('addFromPluginResult()', () => {
    it('should extract errors from PluginResult', () => {
      const error = new LanguageError(
        'Failed to parse file.js',
        'ERR_PARSE_FAILURE',
        { filePath: 'src/file.js', lineNumber: 42 },
        'Fix syntax error'
      );

      const result = createErrorResult([error]);

      collector.addFromPluginResult('INDEXING', 'JSModuleIndexer', result);

      assert.strictEqual(collector.count(), 1);
      const diagnostics = collector.getAll();
      assert.strictEqual(diagnostics[0].code, 'ERR_PARSE_FAILURE');
      assert.strictEqual(diagnostics[0].message, 'Failed to parse file.js');
      assert.strictEqual(diagnostics[0].phase, 'INDEXING');
      assert.strictEqual(diagnostics[0].plugin, 'JSModuleIndexer');
    });

    it('should handle GrafemaError with rich info', () => {
      const error = new ConfigError(
        'Missing projectPath field',
        'ERR_CONFIG_MISSING_FIELD',
        { filePath: 'grafema.config.json', plugin: 'ConfigLoader' },
        'Add "projectPath" to config file'
      );

      const result = createErrorResult([error]);

      collector.addFromPluginResult('DISCOVERY', 'ConfigLoader', result);

      const diagnostics = collector.getAll();
      assert.strictEqual(diagnostics.length, 1);

      const diag = diagnostics[0];
      assert.strictEqual(diag.code, 'ERR_CONFIG_MISSING_FIELD');
      assert.strictEqual(diag.severity, 'fatal');
      assert.strictEqual(diag.message, 'Missing projectPath field');
      assert.strictEqual(diag.file, 'grafema.config.json');
      assert.strictEqual(diag.phase, 'DISCOVERY');
      assert.strictEqual(diag.plugin, 'ConfigLoader');
      assert.strictEqual(diag.suggestion, 'Add "projectPath" to config file');
    });

    it('should handle plain Error with generic info', () => {
      const error = new Error('Something went wrong');
      const result = createErrorResult([error]);

      collector.addFromPluginResult('ANALYSIS', 'DataFlowAnalyzer', result);

      const diagnostics = collector.getAll();
      assert.strictEqual(diagnostics.length, 1);

      const diag = diagnostics[0];
      assert.strictEqual(diag.code, 'ERR_UNKNOWN');
      assert.strictEqual(diag.severity, 'error');
      assert.strictEqual(diag.message, 'Something went wrong');
      assert.strictEqual(diag.phase, 'ANALYSIS');
      assert.strictEqual(diag.plugin, 'DataFlowAnalyzer');
    });

    it('should handle mixed GrafemaError and plain Error', () => {
      const grafemaError = new FileAccessError(
        'Cannot read file',
        'ERR_FILE_UNREADABLE',
        { filePath: 'src/app.js' }
      );
      const plainError = new Error('Unknown error');

      const result = createErrorResult([grafemaError, plainError]);

      collector.addFromPluginResult('INDEXING', 'JSModuleIndexer', result);

      assert.strictEqual(collector.count(), 2);

      const diagnostics = collector.getAll();
      const grafemaDiag = diagnostics.find(d => d.code === 'ERR_FILE_UNREADABLE');
      const unknownDiag = diagnostics.find(d => d.code === 'ERR_UNKNOWN');

      assert.ok(grafemaDiag, 'Should have GrafemaError diagnostic');
      assert.ok(unknownDiag, 'Should have unknown error diagnostic');
    });

    it('should handle empty errors array', () => {
      const result = createSuccessResult(10, 5);

      collector.addFromPluginResult('INDEXING', 'JSModuleIndexer', result);

      assert.strictEqual(collector.count(), 0);
    });

    it('should preserve severity from GrafemaError', () => {
      const fatalError = new DatabaseError(
        'Database locked',
        'ERR_DATABASE_LOCKED',
        {}
      );
      const warningError = new LanguageError(
        'Unsupported syntax',
        'ERR_UNSUPPORTED_LANG',
        {}
      );

      const result = createErrorResult([fatalError, warningError]);

      collector.addFromPluginResult('INDEXING', 'Plugin', result);

      const diagnostics = collector.getAll();
      const fatalDiag = diagnostics.find(d => d.code === 'ERR_DATABASE_LOCKED');
      const warningDiag = diagnostics.find(d => d.code === 'ERR_UNSUPPORTED_LANG');

      assert.strictEqual(fatalDiag?.severity, 'fatal');
      assert.strictEqual(warningDiag?.severity, 'warning');
    });

    it('should set timestamp for each diagnostic', () => {
      const error = new PluginError('Plugin failed', 'ERR_PLUGIN_FAILED', {});
      const result = createErrorResult([error]);

      const before = Date.now();
      collector.addFromPluginResult('ANALYSIS', 'TestPlugin', result);
      const after = Date.now();

      const diagnostics = collector.getAll();
      assert.ok(diagnostics[0].timestamp >= before, 'Timestamp should be after test start');
      assert.ok(diagnostics[0].timestamp <= after, 'Timestamp should be before test end');
    });
  });

  // ===========================================================================
  // TESTS: add()
  // ===========================================================================

  describe('add()', () => {
    it('should add a diagnostic directly', () => {
      collector.add({
        code: 'ERR_CUSTOM',
        severity: 'error',
        message: 'Custom error',
        phase: 'VALIDATION',
        plugin: 'CustomValidator',
      });

      assert.strictEqual(collector.count(), 1);
      const diag = collector.getAll()[0];
      assert.strictEqual(diag.code, 'ERR_CUSTOM');
      assert.strictEqual(diag.message, 'Custom error');
    });

    it('should add timestamp automatically', () => {
      collector.add({
        code: 'ERR_TEST',
        severity: 'warning',
        message: 'Test',
        phase: 'INDEXING',
        plugin: 'TestPlugin',
      });

      const diag = collector.getAll()[0];
      assert.ok(typeof diag.timestamp === 'number');
      assert.ok(diag.timestamp > 0);
    });
  });

  // ===========================================================================
  // TESTS: getByPhase()
  // ===========================================================================

  describe('getByPhase()', () => {
    beforeEach(() => {
      // Add diagnostics from different phases
      collector.add({
        code: 'ERR_DISCOVERY_1',
        severity: 'error',
        message: 'Discovery error 1',
        phase: 'DISCOVERY',
        plugin: 'DiscoveryPlugin',
      });
      collector.add({
        code: 'ERR_INDEXING_1',
        severity: 'warning',
        message: 'Indexing warning 1',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      });
      collector.add({
        code: 'ERR_INDEXING_2',
        severity: 'error',
        message: 'Indexing error 2',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      });
      collector.add({
        code: 'ERR_ANALYSIS_1',
        severity: 'error',
        message: 'Analysis error 1',
        phase: 'ANALYSIS',
        plugin: 'DataFlowAnalyzer',
      });
    });

    it('should return diagnostics for specified phase', () => {
      const indexingDiags = collector.getByPhase('INDEXING');

      assert.strictEqual(indexingDiags.length, 2);
      for (const diag of indexingDiags) {
        assert.strictEqual(diag.phase, 'INDEXING');
      }
    });

    it('should return empty array for phase with no diagnostics', () => {
      const validationDiags = collector.getByPhase('VALIDATION');
      assert.strictEqual(validationDiags.length, 0);
    });

    it('should return single diagnostic for phase with one error', () => {
      const discoveryDiags = collector.getByPhase('DISCOVERY');
      assert.strictEqual(discoveryDiags.length, 1);
      assert.strictEqual(discoveryDiags[0].code, 'ERR_DISCOVERY_1');
    });
  });

  // ===========================================================================
  // TESTS: getByPlugin()
  // ===========================================================================

  describe('getByPlugin()', () => {
    beforeEach(() => {
      collector.add({
        code: 'ERR_1',
        severity: 'error',
        message: 'Error 1',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      });
      collector.add({
        code: 'ERR_2',
        severity: 'warning',
        message: 'Warning 2',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      });
      collector.add({
        code: 'ERR_3',
        severity: 'error',
        message: 'Error 3',
        phase: 'ANALYSIS',
        plugin: 'DataFlowAnalyzer',
      });
    });

    it('should return diagnostics for specified plugin', () => {
      const jsIndexerDiags = collector.getByPlugin('JSModuleIndexer');

      assert.strictEqual(jsIndexerDiags.length, 2);
      for (const diag of jsIndexerDiags) {
        assert.strictEqual(diag.plugin, 'JSModuleIndexer');
      }
    });

    it('should return empty array for plugin with no diagnostics', () => {
      const unknownDiags = collector.getByPlugin('UnknownPlugin');
      assert.strictEqual(unknownDiags.length, 0);
    });

    it('should be case-sensitive', () => {
      const diags = collector.getByPlugin('jsmoduleindexer');
      assert.strictEqual(diags.length, 0);
    });
  });

  // ===========================================================================
  // TESTS: getByCode()
  // ===========================================================================

  describe('getByCode()', () => {
    beforeEach(() => {
      collector.add({
        code: 'ERR_PARSE_FAILURE',
        severity: 'warning',
        message: 'Parse failure 1',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
        file: 'src/file1.js',
      });
      collector.add({
        code: 'ERR_PARSE_FAILURE',
        severity: 'warning',
        message: 'Parse failure 2',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
        file: 'src/file2.js',
      });
      collector.add({
        code: 'ERR_FILE_UNREADABLE',
        severity: 'error',
        message: 'File unreadable',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      });
    });

    it('should return all diagnostics with specified code', () => {
      const parseDiags = collector.getByCode('ERR_PARSE_FAILURE');

      assert.strictEqual(parseDiags.length, 2);
      for (const diag of parseDiags) {
        assert.strictEqual(diag.code, 'ERR_PARSE_FAILURE');
      }
    });

    it('should return empty array for unknown code', () => {
      const diags = collector.getByCode('ERR_UNKNOWN_CODE');
      assert.strictEqual(diags.length, 0);
    });

    it('should return single diagnostic for unique code', () => {
      const diags = collector.getByCode('ERR_FILE_UNREADABLE');
      assert.strictEqual(diags.length, 1);
    });
  });

  // ===========================================================================
  // TESTS: hasFatal()
  // ===========================================================================

  describe('hasFatal()', () => {
    it('should return false when no diagnostics', () => {
      assert.strictEqual(collector.hasFatal(), false);
    });

    it('should return false when only warnings', () => {
      collector.add({
        code: 'ERR_WARN',
        severity: 'warning',
        message: 'Warning',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasFatal(), false);
    });

    it('should return false when only errors (not fatal)', () => {
      collector.add({
        code: 'ERR_ERROR',
        severity: 'error',
        message: 'Error',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasFatal(), false);
    });

    it('should return true when has fatal diagnostic', () => {
      collector.add({
        code: 'ERR_FATAL',
        severity: 'fatal',
        message: 'Fatal error',
        phase: 'DISCOVERY',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasFatal(), true);
    });

    it('should return true when fatal is mixed with other severities', () => {
      collector.add({
        code: 'ERR_WARN',
        severity: 'warning',
        message: 'Warning',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });
      collector.add({
        code: 'ERR_ERROR',
        severity: 'error',
        message: 'Error',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });
      collector.add({
        code: 'ERR_FATAL',
        severity: 'fatal',
        message: 'Fatal',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasFatal(), true);
    });

    it('should detect fatal from ConfigError', () => {
      const error = new ConfigError('Config invalid', 'ERR_CONFIG_INVALID', {});
      const result = createErrorResult([error]);

      collector.addFromPluginResult('DISCOVERY', 'ConfigLoader', result);

      assert.strictEqual(collector.hasFatal(), true);
    });

    it('should detect fatal from DatabaseError', () => {
      const error = new DatabaseError('DB locked', 'ERR_DATABASE_LOCKED', {});
      const result = createErrorResult([error]);

      collector.addFromPluginResult('INDEXING', 'Plugin', result);

      assert.strictEqual(collector.hasFatal(), true);
    });
  });

  // ===========================================================================
  // TESTS: hasErrors()
  // ===========================================================================

  describe('hasErrors()', () => {
    it('should return false when no diagnostics', () => {
      assert.strictEqual(collector.hasErrors(), false);
    });

    it('should return false when only warnings', () => {
      collector.add({
        code: 'ERR_WARN',
        severity: 'warning',
        message: 'Warning',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasErrors(), false);
    });

    it('should return true when has error', () => {
      collector.add({
        code: 'ERR_ERROR',
        severity: 'error',
        message: 'Error',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasErrors(), true);
    });

    it('should return true when has fatal (fatal is also an error)', () => {
      collector.add({
        code: 'ERR_FATAL',
        severity: 'fatal',
        message: 'Fatal',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasErrors(), true);
    });

    it('should detect errors from FileAccessError', () => {
      const error = new FileAccessError('File not found', 'ERR_FILE_UNREADABLE', {});
      const result = createErrorResult([error]);

      collector.addFromPluginResult('INDEXING', 'Plugin', result);

      assert.strictEqual(collector.hasErrors(), true);
    });

    it('should detect errors from PluginError', () => {
      const error = new PluginError('Plugin failed', 'ERR_PLUGIN_FAILED', {});
      const result = createErrorResult([error]);

      collector.addFromPluginResult('ANALYSIS', 'TestPlugin', result);

      assert.strictEqual(collector.hasErrors(), true);
    });

    it('should detect errors from AnalysisError', () => {
      const error = new AnalysisError('Timeout', 'ERR_ANALYSIS_TIMEOUT', {});
      const result = createErrorResult([error]);

      collector.addFromPluginResult('ANALYSIS', 'Analyzer', result);

      assert.strictEqual(collector.hasErrors(), true);
    });
  });

  // ===========================================================================
  // TESTS: hasWarnings()
  // ===========================================================================

  describe('hasWarnings()', () => {
    it('should return false when no diagnostics', () => {
      assert.strictEqual(collector.hasWarnings(), false);
    });

    it('should return false when only errors', () => {
      collector.add({
        code: 'ERR_ERROR',
        severity: 'error',
        message: 'Error',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.hasWarnings(), false);
    });

    it('should return true when has warning', () => {
      collector.add({
        code: 'WARN_DEPRECATED',
        severity: 'warning',
        message: 'Deprecated API',
        phase: 'ANALYSIS',
        plugin: 'Analyzer',
      });

      assert.strictEqual(collector.hasWarnings(), true);
    });

    it('should detect warnings from LanguageError', () => {
      const error = new LanguageError('Unsupported', 'ERR_UNSUPPORTED_LANG', {});
      const result = createErrorResult([error]);

      collector.addFromPluginResult('INDEXING', 'Plugin', result);

      assert.strictEqual(collector.hasWarnings(), true);
    });
  });

  // ===========================================================================
  // TESTS: toDiagnosticsLog()
  // ===========================================================================

  describe('toDiagnosticsLog()', () => {
    it('should return empty string when no diagnostics', () => {
      const log = collector.toDiagnosticsLog();
      assert.strictEqual(log, '');
    });

    it('should return JSON lines format', () => {
      collector.add({
        code: 'ERR_1',
        severity: 'error',
        message: 'Error 1',
        phase: 'INDEXING',
        plugin: 'Plugin1',
      });
      collector.add({
        code: 'ERR_2',
        severity: 'warning',
        message: 'Warning 2',
        phase: 'ANALYSIS',
        plugin: 'Plugin2',
      });

      const log = collector.toDiagnosticsLog();
      const lines = log.split('\n');

      assert.strictEqual(lines.length, 2);

      // Each line should be valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line);
        assert.ok('code' in parsed);
        assert.ok('severity' in parsed);
        assert.ok('message' in parsed);
        assert.ok('phase' in parsed);
        assert.ok('plugin' in parsed);
        assert.ok('timestamp' in parsed);
      }
    });

    it('should include all diagnostic fields', () => {
      collector.add({
        code: 'ERR_TEST',
        severity: 'error',
        message: 'Test message',
        file: 'src/app.js',
        line: 42,
        phase: 'INDEXING',
        plugin: 'TestPlugin',
        suggestion: 'Fix the issue',
      });

      const log = collector.toDiagnosticsLog();
      const parsed = JSON.parse(log);

      assert.strictEqual(parsed.code, 'ERR_TEST');
      assert.strictEqual(parsed.severity, 'error');
      assert.strictEqual(parsed.message, 'Test message');
      assert.strictEqual(parsed.file, 'src/app.js');
      assert.strictEqual(parsed.line, 42);
      assert.strictEqual(parsed.phase, 'INDEXING');
      assert.strictEqual(parsed.plugin, 'TestPlugin');
      assert.strictEqual(parsed.suggestion, 'Fix the issue');
      assert.ok(typeof parsed.timestamp === 'number');
    });

    it('should preserve order of diagnostics', () => {
      collector.add({
        code: 'ERR_FIRST',
        severity: 'error',
        message: 'First',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });
      collector.add({
        code: 'ERR_SECOND',
        severity: 'error',
        message: 'Second',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });
      collector.add({
        code: 'ERR_THIRD',
        severity: 'error',
        message: 'Third',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      const log = collector.toDiagnosticsLog();
      const lines = log.split('\n');

      assert.strictEqual(JSON.parse(lines[0]).code, 'ERR_FIRST');
      assert.strictEqual(JSON.parse(lines[1]).code, 'ERR_SECOND');
      assert.strictEqual(JSON.parse(lines[2]).code, 'ERR_THIRD');
    });
  });

  // ===========================================================================
  // TESTS: count()
  // ===========================================================================

  describe('count()', () => {
    it('should return 0 when no diagnostics', () => {
      assert.strictEqual(collector.count(), 0);
    });

    it('should return correct count after adding diagnostics', () => {
      collector.add({
        code: 'ERR_1',
        severity: 'error',
        message: 'Error 1',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.count(), 1);

      collector.add({
        code: 'ERR_2',
        severity: 'warning',
        message: 'Warning 2',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.count(), 2);
    });
  });

  // ===========================================================================
  // TESTS: clear()
  // ===========================================================================

  describe('clear()', () => {
    it('should remove all diagnostics', () => {
      collector.add({
        code: 'ERR_1',
        severity: 'error',
        message: 'Error',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });
      collector.add({
        code: 'ERR_2',
        severity: 'warning',
        message: 'Warning',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      assert.strictEqual(collector.count(), 2);

      collector.clear();

      assert.strictEqual(collector.count(), 0);
      assert.strictEqual(collector.getAll().length, 0);
      assert.strictEqual(collector.hasFatal(), false);
      assert.strictEqual(collector.hasErrors(), false);
    });
  });

  // ===========================================================================
  // TESTS: getAll()
  // ===========================================================================

  describe('getAll()', () => {
    it('should return empty array when no diagnostics', () => {
      assert.deepStrictEqual(collector.getAll(), []);
    });

    it('should return all diagnostics', () => {
      collector.add({
        code: 'ERR_1',
        severity: 'error',
        message: 'Error 1',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });
      collector.add({
        code: 'ERR_2',
        severity: 'warning',
        message: 'Warning 2',
        phase: 'ANALYSIS',
        plugin: 'Plugin',
      });

      const all = collector.getAll();
      assert.strictEqual(all.length, 2);
    });

    it('should return a copy (not modify internal state)', () => {
      collector.add({
        code: 'ERR_1',
        severity: 'error',
        message: 'Error',
        phase: 'INDEXING',
        plugin: 'Plugin',
      });

      const all = collector.getAll();
      all.push({
        code: 'ERR_FAKE',
        severity: 'error',
        message: 'Fake',
        phase: 'INDEXING',
        plugin: 'Plugin',
        timestamp: Date.now(),
      });

      // Internal state should not be modified
      assert.strictEqual(collector.count(), 1);
    });
  });

  // ===========================================================================
  // TESTS: Real-world scenarios
  // ===========================================================================

  describe('real-world scenarios', () => {
    it('should handle multiple plugins reporting errors in same phase', () => {
      const error1 = new FileAccessError(
        'Cannot read file1.js',
        'ERR_FILE_UNREADABLE',
        { filePath: 'src/file1.js' }
      );
      const error2 = new LanguageError(
        'Unsupported syntax in file2.ts',
        'ERR_PARSE_FAILURE',
        { filePath: 'src/file2.ts' }
      );

      collector.addFromPluginResult('INDEXING', 'JSModuleIndexer', createErrorResult([error1]));
      collector.addFromPluginResult('INDEXING', 'TSParser', createErrorResult([error2]));

      assert.strictEqual(collector.count(), 2);
      assert.strictEqual(collector.getByPhase('INDEXING').length, 2);
      assert.strictEqual(collector.getByPlugin('JSModuleIndexer').length, 1);
      assert.strictEqual(collector.getByPlugin('TSParser').length, 1);
    });

    it('should handle errors across multiple phases', () => {
      collector.addFromPluginResult(
        'DISCOVERY',
        'ProjectDiscovery',
        createErrorResult([new PluginError('Discovery warning', 'ERR_PLUGIN_FAILED', {})])
      );

      collector.addFromPluginResult(
        'INDEXING',
        'JSModuleIndexer',
        createErrorResult([new LanguageError('Parse error', 'ERR_PARSE_FAILURE', {})])
      );

      collector.addFromPluginResult(
        'ANALYSIS',
        'DataFlowAnalyzer',
        createErrorResult([new AnalysisError('Timeout', 'ERR_ANALYSIS_TIMEOUT', {})])
      );

      assert.strictEqual(collector.count(), 3);
      assert.strictEqual(collector.getByPhase('DISCOVERY').length, 1);
      assert.strictEqual(collector.getByPhase('INDEXING').length, 1);
      assert.strictEqual(collector.getByPhase('ANALYSIS').length, 1);
    });

    it('should correctly identify fatal error requiring analysis stop', () => {
      // First some warnings
      collector.addFromPluginResult(
        'INDEXING',
        'JSModuleIndexer',
        createErrorResult([new LanguageError('Warning 1', 'ERR_UNSUPPORTED_LANG', {})])
      );

      // Then a fatal error
      collector.addFromPluginResult(
        'INDEXING',
        'DatabasePlugin',
        createErrorResult([new DatabaseError('DB corrupted', 'ERR_DATABASE_CORRUPTED', {})])
      );

      assert.strictEqual(collector.hasFatal(), true);
      assert.strictEqual(collector.hasErrors(), true);
      assert.strictEqual(collector.hasWarnings(), true);
      assert.strictEqual(collector.count(), 2);
    });
  });
});
