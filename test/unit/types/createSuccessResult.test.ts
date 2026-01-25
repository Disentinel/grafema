/**
 * createSuccessResult Tests
 *
 * Tests for the createSuccessResult helper function from @grafema/types.
 *
 * REG-217 Phase 0: Add optional errors parameter to createSuccessResult
 * so validators can return issues through PluginResult.errors[].
 *
 * Key contract:
 * - errors parameter is optional (defaults to [])
 * - Backward compatible - existing calls without errors still work
 * - Allows validators to return success=true with errors array populated
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createSuccessResult, createErrorResult } from '@grafema/types';
import type { PluginResult } from '@grafema/types';

// =============================================================================
// TESTS: createSuccessResult
// =============================================================================

describe('createSuccessResult', () => {
  describe('backward compatibility (no errors parameter)', () => {
    it('should work with no arguments', () => {
      const result = createSuccessResult();

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.created, { nodes: 0, edges: 0 });
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(result.warnings, []);
      assert.deepStrictEqual(result.metadata, {});
    });

    it('should work with only created parameter', () => {
      const result = createSuccessResult({ nodes: 10, edges: 5 });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.created, { nodes: 10, edges: 5 });
      assert.deepStrictEqual(result.errors, []);
    });

    it('should work with created and metadata parameters', () => {
      const result = createSuccessResult(
        { nodes: 3, edges: 2 },
        { summary: { total: 5 } }
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.created, { nodes: 3, edges: 2 });
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(result.metadata, { summary: { total: 5 } });
    });
  });

  describe('with errors parameter', () => {
    it('should accept errors array as third parameter', () => {
      const error = new Error('Validation issue');
      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        {},
        [error]
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0], error);
    });

    it('should accept multiple errors', () => {
      const errors = [
        new Error('Issue 1'),
        new Error('Issue 2'),
        new Error('Issue 3'),
      ];
      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        {},
        errors
      );

      assert.strictEqual(result.errors.length, 3);
      assert.strictEqual(result.errors[0].message, 'Issue 1');
      assert.strictEqual(result.errors[1].message, 'Issue 2');
      assert.strictEqual(result.errors[2].message, 'Issue 3');
    });

    it('should accept empty errors array explicitly', () => {
      const result = createSuccessResult(
        { nodes: 5, edges: 3 },
        { foo: 'bar' },
        []
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it('should preserve metadata when errors are provided', () => {
      const error = new Error('Test');
      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        { issues: [{ type: 'TEST' }], count: 1 },
        [error]
      );

      assert.deepStrictEqual(result.metadata, {
        issues: [{ type: 'TEST' }],
        count: 1,
      });
      assert.strictEqual(result.errors.length, 1);
    });
  });

  describe('return type is PluginResult', () => {
    it('should return valid PluginResult', () => {
      const result = createSuccessResult();

      // Verify all PluginResult fields exist
      assert.ok('success' in result);
      assert.ok('created' in result);
      assert.ok('errors' in result);
      assert.ok('warnings' in result);
      assert.ok('metadata' in result);

      // Verify types
      assert.strictEqual(typeof result.success, 'boolean');
      assert.strictEqual(typeof result.created.nodes, 'number');
      assert.strictEqual(typeof result.created.edges, 'number');
      assert.ok(Array.isArray(result.errors));
      assert.ok(Array.isArray(result.warnings));
      assert.strictEqual(typeof result.metadata, 'object');
    });

    it('should be assignable to PluginResult type', () => {
      const result: PluginResult = createSuccessResult(
        { nodes: 1, edges: 1 },
        {},
        [new Error('test')]
      );

      // TypeScript compilation verifies the type
      assert.strictEqual(result.success, true);
    });
  });

  describe('validator use case', () => {
    it('should support validator returning success with validation errors', () => {
      // This is the key use case for REG-217:
      // Validators complete successfully but report issues via errors array

      // Simulate ValidationError (will be available after implementation)
      class MockValidationError extends Error {
        readonly code: string;
        readonly severity: 'warning' | 'error' | 'fatal';

        constructor(message: string, code: string, severity: 'warning' | 'error' | 'fatal' = 'warning') {
          super(message);
          this.name = 'ValidationError';
          this.code = code;
          this.severity = severity;
        }
      }

      const validationErrors = [
        new MockValidationError('Unresolved call to foo', 'ERR_UNRESOLVED_CALL'),
        new MockValidationError('Unresolved call to bar', 'ERR_UNRESOLVED_CALL'),
      ];

      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        {
          summary: {
            totalCalls: 100,
            resolvedCalls: 98,
            unresolvedCalls: 2,
          },
        },
        validationErrors
      );

      // Validator "succeeded" - it ran to completion
      assert.strictEqual(result.success, true);

      // But it found issues that should be reported
      assert.strictEqual(result.errors.length, 2);

      // Metadata still contains summary info
      const summary = result.metadata?.summary as { unresolvedCalls: number };
      assert.strictEqual(summary.unresolvedCalls, 2);
    });

    it('should allow DiagnosticCollector to process validator errors', () => {
      // Verify the contract that DiagnosticCollector.addFromPluginResult()
      // will iterate over result.errors

      class MockValidationError extends Error {
        readonly code = 'ERR_TEST';
        readonly severity = 'warning' as const;
        readonly context = { plugin: 'TestValidator' };
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      }

      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        {},
        [new MockValidationError('Test issue')]
      );

      // DiagnosticCollector iterates result.errors
      // This verifies errors are accessible
      for (const error of result.errors) {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.message, 'Test issue');
      }
    });
  });
});

// =============================================================================
// TESTS: createErrorResult (for comparison)
// =============================================================================

describe('createErrorResult', () => {
  it('should create result with success=false', () => {
    const error = new Error('Fatal error');
    const result = createErrorResult(error);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0], error);
  });

  it('should differ from createSuccessResult in success flag', () => {
    const error = new Error('Test');

    const errorResult = createErrorResult(error);
    const successResult = createSuccessResult({ nodes: 0, edges: 0 }, {}, [error]);

    // Same errors array
    assert.strictEqual(errorResult.errors.length, successResult.errors.length);

    // Different success flag - this is the key distinction
    assert.strictEqual(errorResult.success, false);
    assert.strictEqual(successResult.success, true);
  });
});
