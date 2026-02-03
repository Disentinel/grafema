/**
 * StrictModeError Tests (REG-330)
 *
 * Tests for the StrictModeError class used to report unresolved references
 * during enrichment when strict mode is enabled.
 *
 * StrictModeError is reported when strictMode=true and an enricher
 * cannot resolve a reference. Unlike other errors, StrictModeError
 * is used to collect issues that would normally be silently skipped.
 *
 * Error codes:
 * - STRICT_UNRESOLVED_METHOD: Method call cannot be resolved to definition
 * - STRICT_UNRESOLVED_CALL: Function call cannot be resolved to definition
 * - STRICT_UNRESOLVED_ARGUMENT: Argument cannot be linked to parameter
 * - STRICT_ALIAS_DEPTH_EXCEEDED: Alias chain too deep (potential cycle)
 * - STRICT_BROKEN_IMPORT: Import/re-export chain broken
 *
 * These tests are written TDD-style - they will fail until implementation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// NOTE: These imports will fail until StrictModeError is implemented
// This is intentional - tests first!
import {
  GrafemaError,
  StrictModeError,
} from '@grafema/core';

// =============================================================================
// TESTS: StrictModeError Class
// =============================================================================

describe('StrictModeError', () => {
  describe('basic construction', () => {
    it('should extend GrafemaError', () => {
      const error = new StrictModeError(
        'Test message',
        'STRICT_TEST',
        { filePath: 'test.js', lineNumber: 10 }
      );

      assert.ok(error instanceof GrafemaError);
      assert.ok(error instanceof Error);
    });

    it('should set code, message, and context correctly', () => {
      const context = {
        filePath: 'service.js',
        lineNumber: 42,
        phase: 'ENRICHMENT',
        plugin: 'MethodCallResolver',
      };

      const error = new StrictModeError(
        'Cannot resolve method call: obj.method',
        'STRICT_UNRESOLVED_METHOD',
        context
      );

      assert.strictEqual(error.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(error.message, 'Cannot resolve method call: obj.method');
      assert.deepStrictEqual(error.context, context);
    });

    it('should have severity=fatal (always)', () => {
      const error = new StrictModeError('Test', 'STRICT_TEST', {});
      assert.strictEqual(error.severity, 'fatal');
    });

    it('should accept optional suggestion', () => {
      const error = new StrictModeError(
        'Cannot resolve method',
        'STRICT_UNRESOLVED_METHOD',
        { filePath: 'service.js' },
        'Check if the class is imported'
      );

      assert.strictEqual(error.suggestion, 'Check if the class is imported');
    });

    it('should handle empty context', () => {
      const error = new StrictModeError('Test', 'STRICT_TEST', {});
      assert.deepStrictEqual(error.context, {});
    });

    it('should have correct name property', () => {
      const error = new StrictModeError('Test', 'STRICT_TEST', {});
      assert.strictEqual(error.name, 'StrictModeError');
    });
  });

  describe('error codes', () => {
    it('should support STRICT_UNRESOLVED_METHOD code', () => {
      const error = new StrictModeError(
        'Cannot resolve method call: User.save',
        'STRICT_UNRESOLVED_METHOD',
        {
          filePath: 'app.js',
          lineNumber: 10,
          phase: 'ENRICHMENT',
          plugin: 'MethodCallResolver',
          object: 'User',
          method: 'save',
        },
        'Check if class "User" is imported and has method "save"'
      );

      assert.strictEqual(error.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(error.context.object, 'User');
      assert.strictEqual(error.context.method, 'save');
    });

    it('should support STRICT_UNRESOLVED_CALL code', () => {
      const error = new StrictModeError(
        'Cannot resolve function call: processData',
        'STRICT_UNRESOLVED_CALL',
        {
          filePath: 'handler.js',
          lineNumber: 25,
          phase: 'ENRICHMENT',
          plugin: 'FunctionCallResolver',
          calledFunction: 'processData',
        },
        'Ensure the function is imported or defined'
      );

      assert.strictEqual(error.code, 'STRICT_UNRESOLVED_CALL');
      assert.strictEqual(error.context.calledFunction, 'processData');
    });

    it('should support STRICT_UNRESOLVED_ARGUMENT code', () => {
      const error = new StrictModeError(
        'Call with arguments has no resolved target',
        'STRICT_UNRESOLVED_ARGUMENT',
        {
          filePath: 'api.js',
          lineNumber: 15,
          phase: 'ENRICHMENT',
          plugin: 'ArgumentParameterLinker',
          callId: 'call-123',
        },
        'Ensure the called function is imported or defined'
      );

      assert.strictEqual(error.code, 'STRICT_UNRESOLVED_ARGUMENT');
      assert.strictEqual(error.context.callId, 'call-123');
    });

    it('should support STRICT_ALIAS_DEPTH_EXCEEDED code', () => {
      const error = new StrictModeError(
        'Alias chain exceeded max depth (12): handler',
        'STRICT_ALIAS_DEPTH_EXCEEDED',
        {
          filePath: 'utils.js',
          phase: 'ENRICHMENT',
          plugin: 'AliasTracker',
          aliasName: 'handler',
          chainLength: 12,
        },
        'Possible circular alias reference. Chain: a -> b -> c...'
      );

      assert.strictEqual(error.code, 'STRICT_ALIAS_DEPTH_EXCEEDED');
      assert.strictEqual(error.context.aliasName, 'handler');
      assert.strictEqual(error.context.chainLength, 12);
    });

    it('should support STRICT_BROKEN_IMPORT code', () => {
      const error = new StrictModeError(
        'Cannot resolve re-export chain for: helper',
        'STRICT_BROKEN_IMPORT',
        {
          filePath: 'index.js',
          lineNumber: 5,
          phase: 'ENRICHMENT',
          plugin: 'FunctionCallResolver',
          calledFunction: 'helper',
          importSource: './utils',
        },
        'Check if the module "./utils" exists and exports "helper"'
      );

      assert.strictEqual(error.code, 'STRICT_BROKEN_IMPORT');
      assert.strictEqual(error.context.importSource, './utils');
    });
  });

  describe('toJSON()', () => {
    it('should return expected JSON structure', () => {
      const error = new StrictModeError(
        'Cannot resolve method call: obj.method',
        'STRICT_UNRESOLVED_METHOD',
        { filePath: 'app.js', lineNumber: 42, plugin: 'MethodCallResolver' },
        'Check if the class is imported'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(json.severity, 'fatal');
      assert.strictEqual(json.message, 'Cannot resolve method call: obj.method');
      assert.deepStrictEqual(json.context, {
        filePath: 'app.js',
        lineNumber: 42,
        plugin: 'MethodCallResolver',
      });
      assert.strictEqual(json.suggestion, 'Check if the class is imported');
    });

    it('should have suggestion as undefined when not provided', () => {
      const error = new StrictModeError('Test', 'STRICT_TEST', {});

      const json = error.toJSON();
      assert.strictEqual(json.suggestion, undefined);
    });

    it('should be serializable to JSON string', () => {
      const error = new StrictModeError(
        'Method not found',
        'STRICT_UNRESOLVED_METHOD',
        { filePath: 'src/app.js', lineNumber: 10 },
        'Fix the import'
      );

      const jsonString = JSON.stringify(error.toJSON());
      const parsed = JSON.parse(jsonString);

      assert.strictEqual(parsed.code, 'STRICT_UNRESOLVED_METHOD');
      assert.strictEqual(parsed.message, 'Method not found');
      assert.strictEqual(parsed.severity, 'fatal');
    });
  });

  describe('PluginResult.errors[] compatibility', () => {
    it('should work with Error[] type', () => {
      const errors = [];
      const strictError = new StrictModeError('Test', 'STRICT_TEST', {});

      // Should compile and work - StrictModeError is Error
      errors.push(strictError);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0] instanceof StrictModeError, true);
    });

    it('should allow mixing with other GrafemaError types', () => {
      const errors = [];

      errors.push(new StrictModeError('Strict error', 'STRICT_TEST', {}));
      errors.push(new Error('Plain error'));

      assert.strictEqual(errors.length, 2);

      // Can filter for StrictModeError
      const strictErrors = errors.filter(e => e instanceof StrictModeError);
      assert.strictEqual(strictErrors.length, 1);
    });
  });

  describe('stack trace', () => {
    it('should capture stack trace', () => {
      const error = new StrictModeError('Test', 'STRICT_TEST', {});
      assert.ok(error.stack, 'Error should have stack trace');
      assert.ok(error.stack.includes('StrictModeError'), 'Stack should include error name');
    });
  });

  // ===========================================================================
  // TESTS: Real Enricher Error Scenarios
  // ===========================================================================

  describe('real enricher error scenarios', () => {
    it('should create actionable error for unresolved method call', () => {
      const error = new StrictModeError(
        'Cannot resolve method call: userService.findById',
        'STRICT_UNRESOLVED_METHOD',
        {
          filePath: 'src/controllers/UserController.js',
          lineNumber: 42,
          phase: 'ENRICHMENT',
          plugin: 'MethodCallResolver',
          object: 'userService',
          method: 'findById',
        },
        'Check if class "userService" is imported and has method "findById"'
      );

      // Error message is actionable - tells developer what is wrong
      assert.ok(error.message.includes('userService.findById'));

      // Context provides debugging information
      assert.strictEqual(error.context.filePath, 'src/controllers/UserController.js');
      assert.strictEqual(error.context.lineNumber, 42);

      // Suggestion helps fix the issue
      assert.ok(error.suggestion?.includes('imported'));
    });

    it('should create actionable error for broken re-export chain', () => {
      const error = new StrictModeError(
        'Cannot resolve re-export chain for: formatDate',
        'STRICT_BROKEN_IMPORT',
        {
          filePath: 'src/index.js',
          lineNumber: 3,
          phase: 'ENRICHMENT',
          plugin: 'FunctionCallResolver',
          calledFunction: 'formatDate',
          importSource: './utils',
        },
        'Check if the module "./utils" exists and exports "formatDate"'
      );

      // Error identifies the broken import
      assert.ok(error.message.includes('formatDate'));
      assert.strictEqual(error.context.importSource, './utils');

      // Suggestion is actionable
      assert.ok(error.suggestion?.includes('./utils'));
    });

    it('should create actionable error for alias depth exceeded', () => {
      const error = new StrictModeError(
        'Alias chain exceeded max depth (12): dbQuery',
        'STRICT_ALIAS_DEPTH_EXCEEDED',
        {
          filePath: 'src/db.js',
          phase: 'ENRICHMENT',
          plugin: 'AliasTracker',
          aliasName: 'dbQuery',
          chainLength: 12,
        },
        'Possible circular alias reference. Chain: dbQuery -> query -> q...'
      );

      // Error shows the problem
      assert.ok(error.message.includes('12'));
      assert.ok(error.message.includes('dbQuery'));

      // Suggestion mentions circular reference
      assert.ok(error.suggestion?.includes('circular'));
    });
  });
});
