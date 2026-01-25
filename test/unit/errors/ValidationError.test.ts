/**
 * ValidationError Tests
 *
 * Tests for the ValidationError class used by validators to report issues
 * through PluginResult.errors[].
 *
 * REG-217 Phase 0: Fix validator contract so validators return ValidationError
 * in errors array.
 *
 * Key contract:
 * - ValidationError extends GrafemaError
 * - Has configurable severity (unlike other error classes with fixed severity)
 * - Default severity is 'warning'
 * - Used by validators: CallResolverValidator, DataFlowValidator, GraphConnectivityValidator
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// NOTE: These imports will fail until ValidationError is implemented
// This is intentional - tests first!
import {
  GrafemaError,
  ValidationError,
  type ErrorContext,
} from '@grafema/core';

// =============================================================================
// TESTS: ValidationError Class
// =============================================================================

describe('ValidationError', () => {
  describe('basic construction', () => {
    it('should set code, message, and context correctly', () => {
      const context: ErrorContext = {
        filePath: 'src/app.js',
        lineNumber: 42,
        phase: 'VALIDATION',
        plugin: 'CallResolverValidator',
      };

      const error = new ValidationError(
        'Call to "foo" does not resolve to a function definition',
        'ERR_UNRESOLVED_CALL',
        context
      );

      assert.strictEqual(error.code, 'ERR_UNRESOLVED_CALL');
      assert.strictEqual(error.message, 'Call to "foo" does not resolve to a function definition');
      assert.deepStrictEqual(error.context, context);
    });

    it('should default severity to warning', () => {
      const error = new ValidationError(
        'Test validation error',
        'ERR_TEST',
        {}
      );

      assert.strictEqual(error.severity, 'warning');
    });

    it('should accept optional suggestion', () => {
      const error = new ValidationError(
        'Unresolved function call',
        'ERR_UNRESOLVED_CALL',
        { filePath: 'src/app.js' },
        'Ensure the function is defined and exported'
      );

      assert.strictEqual(error.suggestion, 'Ensure the function is defined and exported');
    });

    it('should handle empty context', () => {
      const error = new ValidationError('Test', 'ERR_TEST', {});
      assert.deepStrictEqual(error.context, {});
    });
  });

  describe('configurable severity', () => {
    it('should allow warning severity (default)', () => {
      const error = new ValidationError(
        'Missing assignment',
        'ERR_MISSING_ASSIGNMENT',
        {},
        undefined,
        'warning'
      );

      assert.strictEqual(error.severity, 'warning');
    });

    it('should allow error severity', () => {
      const error = new ValidationError(
        'Broken reference in data flow',
        'ERR_BROKEN_REFERENCE',
        {},
        undefined,
        'error'
      );

      assert.strictEqual(error.severity, 'error');
    });

    it('should allow fatal severity', () => {
      const error = new ValidationError(
        'Critical validation failure',
        'ERR_CRITICAL',
        {},
        undefined,
        'fatal'
      );

      assert.strictEqual(error.severity, 'fatal');
    });
  });

  describe('extends GrafemaError', () => {
    it('should extend Error (instanceof Error === true)', () => {
      const error = new ValidationError('Test', 'ERR_TEST', {});
      assert.strictEqual(error instanceof Error, true);
    });

    it('should extend GrafemaError', () => {
      const error = new ValidationError('Test', 'ERR_TEST', {});
      assert.strictEqual(error instanceof GrafemaError, true);
    });

    it('should have correct name property', () => {
      const error = new ValidationError('Test', 'ERR_TEST', {});
      assert.strictEqual(error.name, 'ValidationError');
    });

    it('should work with PluginResult.errors[] (Error[] type)', () => {
      const errors: Error[] = [];
      const validationError = new ValidationError('Test', 'ERR_TEST', {});

      // Should compile and work - ValidationError is Error
      errors.push(validationError);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0] instanceof ValidationError, true);
    });
  });

  describe('toJSON()', () => {
    it('should return expected JSON structure', () => {
      const error = new ValidationError(
        'Unresolved call to foo',
        'ERR_UNRESOLVED_CALL',
        { filePath: 'src/app.js', lineNumber: 42, plugin: 'CallResolverValidator' },
        'Ensure function is exported',
        'warning'
      );

      const json = error.toJSON();

      assert.strictEqual(json.code, 'ERR_UNRESOLVED_CALL');
      assert.strictEqual(json.severity, 'warning');
      assert.strictEqual(json.message, 'Unresolved call to foo');
      assert.deepStrictEqual(json.context, {
        filePath: 'src/app.js',
        lineNumber: 42,
        plugin: 'CallResolverValidator',
      });
      assert.strictEqual(json.suggestion, 'Ensure function is exported');
    });

    it('should have suggestion as undefined when not provided', () => {
      const error = new ValidationError('Test', 'ERR_TEST', {});

      const json = error.toJSON();
      assert.strictEqual(json.suggestion, undefined);
    });

    it('should be serializable to JSON string', () => {
      const error = new ValidationError(
        'Missing assignment',
        'ERR_MISSING_ASSIGNMENT',
        { filePath: 'src/data.js', lineNumber: 10 },
        'Check variable initialization'
      );

      const jsonString = JSON.stringify(error.toJSON());
      const parsed = JSON.parse(jsonString);

      assert.strictEqual(parsed.code, 'ERR_MISSING_ASSIGNMENT');
      assert.strictEqual(parsed.message, 'Missing assignment');
    });

    it('should preserve severity in JSON', () => {
      const warningError = new ValidationError('Warn', 'ERR_WARN', {}, undefined, 'warning');
      const errorError = new ValidationError('Error', 'ERR_ERROR', {}, undefined, 'error');
      const fatalError = new ValidationError('Fatal', 'ERR_FATAL', {}, undefined, 'fatal');

      assert.strictEqual(warningError.toJSON().severity, 'warning');
      assert.strictEqual(errorError.toJSON().severity, 'error');
      assert.strictEqual(fatalError.toJSON().severity, 'fatal');
    });
  });

  describe('stack trace', () => {
    it('should capture stack trace', () => {
      const error = new ValidationError('Test', 'ERR_TEST', {});
      assert.ok(error.stack, 'Error should have stack trace');
      assert.ok(error.stack.includes('ValidationError'), 'Stack should include error name');
    });
  });

  // ===========================================================================
  // TESTS: Real Validator Error Codes
  // ===========================================================================

  describe('real validator error codes', () => {
    it('should create ERR_UNRESOLVED_CALL for CallResolverValidator', () => {
      const error = new ValidationError(
        'Call to "processData" at src/app.js:42 does not resolve to a function definition',
        'ERR_UNRESOLVED_CALL',
        {
          filePath: 'src/app.js',
          lineNumber: 42,
          phase: 'VALIDATION',
          plugin: 'CallResolverValidator',
        },
        'Ensure the function is defined and exported'
      );

      assert.strictEqual(error.code, 'ERR_UNRESOLVED_CALL');
      assert.strictEqual(error.severity, 'warning');
    });

    it('should create ERR_DISCONNECTED_NODES for GraphConnectivityValidator', () => {
      const error = new ValidationError(
        'Found 15 unreachable nodes (5.2% of total)',
        'ERR_DISCONNECTED_NODES',
        {
          phase: 'VALIDATION',
          plugin: 'GraphConnectivityValidator',
        },
        'Fix analysis plugins to ensure all nodes are connected'
      );

      assert.strictEqual(error.code, 'ERR_DISCONNECTED_NODES');
      assert.strictEqual(error.severity, 'warning');
    });

    it('should create ERR_MISSING_ASSIGNMENT for DataFlowValidator', () => {
      const error = new ValidationError(
        'Variable "config" is used but never assigned a value',
        'ERR_MISSING_ASSIGNMENT',
        {
          filePath: 'src/config.js',
          lineNumber: 10,
          phase: 'VALIDATION',
          plugin: 'DataFlowValidator',
        }
      );

      assert.strictEqual(error.code, 'ERR_MISSING_ASSIGNMENT');
      assert.strictEqual(error.severity, 'warning');
    });

    it('should create ERR_BROKEN_REFERENCE with error severity for DataFlowValidator', () => {
      const error = new ValidationError(
        'Reference to undefined variable "data"',
        'ERR_BROKEN_REFERENCE',
        {
          filePath: 'src/handler.js',
          lineNumber: 25,
          phase: 'VALIDATION',
          plugin: 'DataFlowValidator',
        },
        undefined,
        'error' // Note: error severity, not warning
      );

      assert.strictEqual(error.code, 'ERR_BROKEN_REFERENCE');
      assert.strictEqual(error.severity, 'error');
    });

    it('should create ERR_NO_LEAF_NODE for DataFlowValidator', () => {
      const error = new ValidationError(
        'Data flow trace has no terminal node',
        'ERR_NO_LEAF_NODE',
        {
          phase: 'VALIDATION',
          plugin: 'DataFlowValidator',
        }
      );

      assert.strictEqual(error.code, 'ERR_NO_LEAF_NODE');
      assert.strictEqual(error.severity, 'warning');
    });
  });
});
