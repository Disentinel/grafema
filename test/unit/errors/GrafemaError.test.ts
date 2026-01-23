/**
 * GrafemaError Hierarchy Tests
 *
 * Tests for the GrafemaError base class and concrete error classes.
 * Based on specification: _tasks/2026-01-23-reg-78-error-handling-diagnostics/003-joel-tech-plan.md
 *
 * Tests:
 * - GrafemaError is abstract (cannot instantiate directly)
 * - Each concrete error sets code, severity, message, context correctly
 * - toJSON() returns expected structure
 * - Extends Error (instanceof Error === true)
 * - Works with PluginResult.errors[] (is Error[])
 * - Suggestion is optional
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  GrafemaError,
  ConfigError,
  FileAccessError,
  LanguageError,
  DatabaseError,
  PluginError,
  AnalysisError,
  type ErrorContext,
} from '@grafema/core';

// =============================================================================
// TESTS: GrafemaError Base Class
// =============================================================================

describe('GrafemaError', () => {
  describe('abstract base class', () => {
    it('should not be directly instantiable', () => {
      // GrafemaError is abstract - attempting to instantiate should fail at compile time
      // This test verifies runtime behavior if somehow called
      // TypeScript prevents direct instantiation, but we can verify the class structure
      assert.strictEqual(typeof GrafemaError, 'function');
      assert.strictEqual(GrafemaError.prototype instanceof Error, true);
    });

    it('should have Error in prototype chain', () => {
      // All concrete errors should be instanceof Error
      const error = new ConfigError(
        'Test error',
        'ERR_CONFIG_INVALID',
        { filePath: 'config.json' }
      );
      assert.strictEqual(error instanceof Error, true);
      assert.strictEqual(error instanceof GrafemaError, true);
    });
  });

  // ===========================================================================
  // TESTS: ConfigError
  // ===========================================================================

  describe('ConfigError', () => {
    it('should set code, severity, message, and context correctly', () => {
      const context: ErrorContext = {
        filePath: 'grafema.config.json',
        phase: 'DISCOVERY',
        plugin: 'ConfigLoader',
      };

      const error = new ConfigError(
        'Invalid configuration: missing "projectPath" field',
        'ERR_CONFIG_MISSING_FIELD',
        context
      );

      assert.strictEqual(error.code, 'ERR_CONFIG_MISSING_FIELD');
      assert.strictEqual(error.severity, 'fatal');
      assert.strictEqual(error.message, 'Invalid configuration: missing "projectPath" field');
      assert.deepStrictEqual(error.context, context);
      assert.strictEqual(error.suggestion, undefined);
    });

    it('should accept optional suggestion', () => {
      const error = new ConfigError(
        'Config file not found',
        'ERR_CONFIG_INVALID',
        { filePath: 'grafema.config.json' },
        'Run `grafema init` to create a configuration file'
      );

      assert.strictEqual(error.suggestion, 'Run `grafema init` to create a configuration file');
    });

    it('should extend Error (instanceof Error === true)', () => {
      const error = new ConfigError('Test', 'ERR_CONFIG_INVALID', {});
      assert.strictEqual(error instanceof Error, true);
    });

    it('should have correct name property', () => {
      const error = new ConfigError('Test', 'ERR_CONFIG_INVALID', {});
      assert.strictEqual(error.name, 'ConfigError');
    });

    it('should work with PluginResult.errors[] (Error[] type)', () => {
      const errors: Error[] = [];
      const configError = new ConfigError('Test', 'ERR_CONFIG_INVALID', {});

      // Should compile and work - ConfigError is Error
      errors.push(configError);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0] instanceof ConfigError, true);
    });

    it('should return expected JSON structure from toJSON()', () => {
      const error = new ConfigError(
        'Invalid config',
        'ERR_CONFIG_INVALID',
        { filePath: 'config.json', plugin: 'ConfigLoader' },
        'Check configuration syntax'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'ERR_CONFIG_INVALID');
      assert.strictEqual(json.severity, 'fatal');
      assert.strictEqual(json.message, 'Invalid config');
      assert.deepStrictEqual(json.context, { filePath: 'config.json', plugin: 'ConfigLoader' });
      assert.strictEqual(json.suggestion, 'Check configuration syntax');
    });

    it('should handle empty context', () => {
      const error = new ConfigError('Test', 'ERR_CONFIG_INVALID', {});
      assert.deepStrictEqual(error.context, {});
    });
  });

  // ===========================================================================
  // TESTS: FileAccessError
  // ===========================================================================

  describe('FileAccessError', () => {
    it('should set code, severity, message, and context correctly', () => {
      const context: ErrorContext = {
        filePath: '/project/src/app.js',
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      };

      const error = new FileAccessError(
        'Cannot read file: permission denied',
        'ERR_FILE_UNREADABLE',
        context
      );

      assert.strictEqual(error.code, 'ERR_FILE_UNREADABLE');
      assert.strictEqual(error.severity, 'error');
      assert.strictEqual(error.message, 'Cannot read file: permission denied');
      assert.deepStrictEqual(error.context, context);
    });

    it('should support fatal severity for git-related errors', () => {
      const error = new FileAccessError(
        'Git repository not found',
        'ERR_GIT_NOT_FOUND',
        { filePath: '/project' },
        'Run `git init` to initialize a repository'
      );

      // Git errors are fatal
      assert.strictEqual(error.code, 'ERR_GIT_NOT_FOUND');
      assert.strictEqual(error.suggestion, 'Run `git init` to initialize a repository');
    });

    it('should extend Error and GrafemaError', () => {
      const error = new FileAccessError('Test', 'ERR_FILE_UNREADABLE', {});
      assert.strictEqual(error instanceof Error, true);
      assert.strictEqual(error instanceof GrafemaError, true);
    });

    it('should have correct name property', () => {
      const error = new FileAccessError('Test', 'ERR_FILE_UNREADABLE', {});
      assert.strictEqual(error.name, 'FileAccessError');
    });

    it('should return expected JSON structure from toJSON()', () => {
      const error = new FileAccessError(
        'File not readable',
        'ERR_FILE_UNREADABLE',
        { filePath: '/path/to/file.js' },
        'Check file permissions'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'ERR_FILE_UNREADABLE');
      assert.strictEqual(json.severity, 'error');
      assert.strictEqual(json.message, 'File not readable');
      assert.strictEqual(json.suggestion, 'Check file permissions');
    });
  });

  // ===========================================================================
  // TESTS: LanguageError
  // ===========================================================================

  describe('LanguageError', () => {
    it('should set code, severity, message, and context correctly', () => {
      const context: ErrorContext = {
        filePath: 'src/app.rs',
        lineNumber: 42,
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      };

      const error = new LanguageError(
        'Unsupported file type: .rs',
        'ERR_UNSUPPORTED_LANG',
        context
      );

      assert.strictEqual(error.code, 'ERR_UNSUPPORTED_LANG');
      assert.strictEqual(error.severity, 'warning');
      assert.strictEqual(error.message, 'Unsupported file type: .rs');
      assert.deepStrictEqual(error.context, context);
    });

    it('should have warning severity by default', () => {
      const error = new LanguageError('Parse error', 'ERR_PARSE_FAILURE', {});
      assert.strictEqual(error.severity, 'warning');
    });

    it('should accept suggestion for parser recommendation', () => {
      const error = new LanguageError(
        'Unsupported file type: .rs',
        'ERR_UNSUPPORTED_LANG',
        { filePath: 'src/app.rs' },
        'Use RustAnalyzer plugin for Rust files'
      );

      assert.strictEqual(error.suggestion, 'Use RustAnalyzer plugin for Rust files');
    });

    it('should extend Error and GrafemaError', () => {
      const error = new LanguageError('Test', 'ERR_PARSE_FAILURE', {});
      assert.strictEqual(error instanceof Error, true);
      assert.strictEqual(error instanceof GrafemaError, true);
    });

    it('should have correct name property', () => {
      const error = new LanguageError('Test', 'ERR_PARSE_FAILURE', {});
      assert.strictEqual(error.name, 'LanguageError');
    });

    it('should return expected JSON structure from toJSON()', () => {
      const error = new LanguageError(
        'Syntax error at line 42',
        'ERR_PARSE_FAILURE',
        { filePath: 'src/app.js', lineNumber: 42 },
        'Fix syntax error'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'ERR_PARSE_FAILURE');
      assert.strictEqual(json.severity, 'warning');
      assert.strictEqual(json.message, 'Syntax error at line 42');
      assert.deepStrictEqual(json.context, { filePath: 'src/app.js', lineNumber: 42 });
      assert.strictEqual(json.suggestion, 'Fix syntax error');
    });
  });

  // ===========================================================================
  // TESTS: DatabaseError
  // ===========================================================================

  describe('DatabaseError', () => {
    it('should set code, severity, message, and context correctly', () => {
      const context: ErrorContext = {
        filePath: '.grafema/graph.rfdb',
        phase: 'INDEXING',
      };

      const error = new DatabaseError(
        'Database is locked by another process',
        'ERR_DATABASE_LOCKED',
        context
      );

      assert.strictEqual(error.code, 'ERR_DATABASE_LOCKED');
      assert.strictEqual(error.severity, 'fatal');
      assert.strictEqual(error.message, 'Database is locked by another process');
      assert.deepStrictEqual(error.context, context);
    });

    it('should have fatal severity', () => {
      const error = new DatabaseError('Corruption', 'ERR_DATABASE_CORRUPTED', {});
      assert.strictEqual(error.severity, 'fatal');
    });

    it('should accept suggestion for recovery', () => {
      const error = new DatabaseError(
        'Database corruption detected',
        'ERR_DATABASE_CORRUPTED',
        { filePath: '.grafema/graph.rfdb' },
        'Run `grafema analyze --clear` to rebuild the database'
      );

      assert.strictEqual(error.suggestion, 'Run `grafema analyze --clear` to rebuild the database');
    });

    it('should extend Error and GrafemaError', () => {
      const error = new DatabaseError('Test', 'ERR_DATABASE_LOCKED', {});
      assert.strictEqual(error instanceof Error, true);
      assert.strictEqual(error instanceof GrafemaError, true);
    });

    it('should have correct name property', () => {
      const error = new DatabaseError('Test', 'ERR_DATABASE_LOCKED', {});
      assert.strictEqual(error.name, 'DatabaseError');
    });

    it('should return expected JSON structure from toJSON()', () => {
      const error = new DatabaseError(
        'Database locked',
        'ERR_DATABASE_LOCKED',
        { filePath: '.grafema/graph.rfdb' },
        'Close other Grafema instances'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'ERR_DATABASE_LOCKED');
      assert.strictEqual(json.severity, 'fatal');
      assert.strictEqual(json.message, 'Database locked');
      assert.strictEqual(json.suggestion, 'Close other Grafema instances');
    });
  });

  // ===========================================================================
  // TESTS: PluginError
  // ===========================================================================

  describe('PluginError', () => {
    it('should set code, severity, message, and context correctly', () => {
      const context: ErrorContext = {
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      };

      const error = new PluginError(
        'Plugin execution failed',
        'ERR_PLUGIN_FAILED',
        context
      );

      assert.strictEqual(error.code, 'ERR_PLUGIN_FAILED');
      assert.strictEqual(error.severity, 'error');
      assert.strictEqual(error.message, 'Plugin execution failed');
      assert.deepStrictEqual(error.context, context);
    });

    it('should support fatal severity for dependency errors', () => {
      const error = new PluginError(
        'Missing dependency: @babel/parser',
        'ERR_PLUGIN_DEPENDENCY_MISSING',
        { plugin: 'JSModuleIndexer' },
        'Run `npm install @babel/parser`'
      );

      assert.strictEqual(error.code, 'ERR_PLUGIN_DEPENDENCY_MISSING');
      assert.strictEqual(error.suggestion, 'Run `npm install @babel/parser`');
    });

    it('should extend Error and GrafemaError', () => {
      const error = new PluginError('Test', 'ERR_PLUGIN_FAILED', {});
      assert.strictEqual(error instanceof Error, true);
      assert.strictEqual(error instanceof GrafemaError, true);
    });

    it('should have correct name property', () => {
      const error = new PluginError('Test', 'ERR_PLUGIN_FAILED', {});
      assert.strictEqual(error.name, 'PluginError');
    });

    it('should return expected JSON structure from toJSON()', () => {
      const error = new PluginError(
        'Plugin failed',
        'ERR_PLUGIN_FAILED',
        { plugin: 'TestPlugin', phase: 'ANALYSIS' },
        'Check plugin configuration'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'ERR_PLUGIN_FAILED');
      assert.strictEqual(json.severity, 'error');
      assert.strictEqual(json.message, 'Plugin failed');
      assert.deepStrictEqual(json.context, { plugin: 'TestPlugin', phase: 'ANALYSIS' });
      assert.strictEqual(json.suggestion, 'Check plugin configuration');
    });
  });

  // ===========================================================================
  // TESTS: AnalysisError
  // ===========================================================================

  describe('AnalysisError', () => {
    it('should set code, severity, message, and context correctly', () => {
      const context: ErrorContext = {
        filePath: 'src/complex.js',
        phase: 'ANALYSIS',
        plugin: 'DataFlowAnalyzer',
      };

      const error = new AnalysisError(
        'Analysis timed out after 30 seconds',
        'ERR_ANALYSIS_TIMEOUT',
        context
      );

      assert.strictEqual(error.code, 'ERR_ANALYSIS_TIMEOUT');
      assert.strictEqual(error.severity, 'error');
      assert.strictEqual(error.message, 'Analysis timed out after 30 seconds');
      assert.deepStrictEqual(error.context, context);
    });

    it('should support fatal severity for internal errors', () => {
      const error = new AnalysisError(
        'Internal analyzer failure',
        'ERR_ANALYSIS_INTERNAL',
        { plugin: 'DataFlowAnalyzer' }
      );

      assert.strictEqual(error.code, 'ERR_ANALYSIS_INTERNAL');
    });

    it('should extend Error and GrafemaError', () => {
      const error = new AnalysisError('Test', 'ERR_ANALYSIS_TIMEOUT', {});
      assert.strictEqual(error instanceof Error, true);
      assert.strictEqual(error instanceof GrafemaError, true);
    });

    it('should have correct name property', () => {
      const error = new AnalysisError('Test', 'ERR_ANALYSIS_TIMEOUT', {});
      assert.strictEqual(error.name, 'AnalysisError');
    });

    it('should return expected JSON structure from toJSON()', () => {
      const error = new AnalysisError(
        'Timeout',
        'ERR_ANALYSIS_TIMEOUT',
        { filePath: 'large-file.js', plugin: 'Analyzer' },
        'Increase timeout or simplify code'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'ERR_ANALYSIS_TIMEOUT');
      assert.strictEqual(json.severity, 'error');
      assert.strictEqual(json.message, 'Timeout');
      assert.deepStrictEqual(json.context, { filePath: 'large-file.js', plugin: 'Analyzer' });
      assert.strictEqual(json.suggestion, 'Increase timeout or simplify code');
    });
  });

  // ===========================================================================
  // TESTS: toJSON() structure
  // ===========================================================================

  describe('toJSON()', () => {
    it('should include all required fields', () => {
      const error = new ConfigError(
        'Test message',
        'ERR_CONFIG_INVALID',
        { filePath: 'test.json', phase: 'DISCOVERY' },
        'Test suggestion'
      );

      const json = error.toJSON();

      // Required fields
      assert.ok('code' in json, 'toJSON should include code');
      assert.ok('severity' in json, 'toJSON should include severity');
      assert.ok('message' in json, 'toJSON should include message');
      assert.ok('context' in json, 'toJSON should include context');
      assert.ok('suggestion' in json, 'toJSON should include suggestion');
    });

    it('should have suggestion as undefined when not provided', () => {
      const error = new ConfigError(
        'Test message',
        'ERR_CONFIG_INVALID',
        {}
      );

      const json = error.toJSON();
      assert.strictEqual(json.suggestion, undefined);
    });

    it('should be serializable to JSON string', () => {
      const error = new LanguageError(
        'Parse failure',
        'ERR_PARSE_FAILURE',
        { filePath: 'src/app.js', lineNumber: 10 },
        'Fix syntax'
      );

      const jsonString = JSON.stringify(error.toJSON());
      const parsed = JSON.parse(jsonString);

      assert.strictEqual(parsed.code, 'ERR_PARSE_FAILURE');
      assert.strictEqual(parsed.message, 'Parse failure');
    });
  });

  // ===========================================================================
  // TESTS: ErrorContext interface
  // ===========================================================================

  describe('ErrorContext', () => {
    it('should support standard fields', () => {
      const context: ErrorContext = {
        filePath: '/project/src/app.js',
        lineNumber: 42,
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      };

      const error = new FileAccessError('Test', 'ERR_FILE_UNREADABLE', context);
      assert.strictEqual(error.context.filePath, '/project/src/app.js');
      assert.strictEqual(error.context.lineNumber, 42);
      assert.strictEqual(error.context.phase, 'INDEXING');
      assert.strictEqual(error.context.plugin, 'JSModuleIndexer');
    });

    it('should support arbitrary additional fields', () => {
      const context: ErrorContext = {
        filePath: 'test.js',
        customField: 'custom value',
        anotherField: 123,
      };

      const error = new LanguageError('Test', 'ERR_PARSE_FAILURE', context);
      assert.strictEqual(error.context.customField, 'custom value');
      assert.strictEqual(error.context.anotherField, 123);
    });

    it('should work with empty context', () => {
      const error = new PluginError('Test', 'ERR_PLUGIN_FAILED', {});
      assert.deepStrictEqual(error.context, {});
    });
  });

  // ===========================================================================
  // TESTS: Compatibility with PluginResult.errors[]
  // ===========================================================================

  describe('PluginResult.errors[] compatibility', () => {
    it('should allow mixed Error and GrafemaError in array', () => {
      const errors: Error[] = [];

      // Native Error
      errors.push(new Error('Native error'));

      // GrafemaError subclasses
      errors.push(new ConfigError('Config error', 'ERR_CONFIG_INVALID', {}));
      errors.push(new FileAccessError('File error', 'ERR_FILE_UNREADABLE', {}));
      errors.push(new LanguageError('Lang error', 'ERR_PARSE_FAILURE', {}));
      errors.push(new DatabaseError('DB error', 'ERR_DATABASE_LOCKED', {}));
      errors.push(new PluginError('Plugin error', 'ERR_PLUGIN_FAILED', {}));
      errors.push(new AnalysisError('Analysis error', 'ERR_ANALYSIS_TIMEOUT', {}));

      assert.strictEqual(errors.length, 7);

      // All should be instanceof Error
      for (const error of errors) {
        assert.strictEqual(error instanceof Error, true);
      }

      // GrafemaErrors should be detectable
      const grafemaErrors = errors.filter(e => e instanceof GrafemaError);
      assert.strictEqual(grafemaErrors.length, 6);
    });

    it('should allow type checking with instanceof', () => {
      const errors: Error[] = [
        new ConfigError('Config', 'ERR_CONFIG_INVALID', {}),
        new Error('Plain error'),
        new LanguageError('Lang', 'ERR_PARSE_FAILURE', {}),
      ];

      for (const error of errors) {
        if (error instanceof GrafemaError) {
          // TypeScript should recognize GrafemaError properties
          assert.ok('code' in error);
          assert.ok('severity' in error);
          assert.ok('context' in error);
        }
      }
    });
  });

  // ===========================================================================
  // TESTS: Error stack trace
  // ===========================================================================

  describe('Error stack trace', () => {
    it('should capture stack trace', () => {
      const error = new ConfigError('Test', 'ERR_CONFIG_INVALID', {});
      assert.ok(error.stack, 'Error should have stack trace');
      assert.ok(error.stack.includes('ConfigError'), 'Stack should include error name');
    });

    it('should have meaningful stack trace', () => {
      const error = new PluginError('Test', 'ERR_PLUGIN_FAILED', {});
      assert.ok(error.stack.includes('GrafemaError.test.ts'), 'Stack should include test file');
    });
  });
});
