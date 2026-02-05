/**
 * StrictModeFailure Tests (REG-332)
 *
 * Tests for StrictModeFailure class that carries diagnostics
 * for CLI formatting without duplication.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { StrictModeFailure, StrictModeError, type ResolutionStep } from '@grafema/core';
import type { Diagnostic } from '@grafema/core';

// Helper to create test diagnostics
function createDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'STRICT_UNRESOLVED_METHOD',
    severity: 'fatal',
    message: 'Cannot resolve method call: user.processData',
    file: '/tmp/test.js',
    line: 3,
    phase: 'ENRICHMENT',
    plugin: 'MethodCallResolver',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('StrictModeFailure', () => {
  describe('constructor', () => {
    it('should store diagnostics array', () => {
      const diagnostics = [createDiagnostic({ code: 'STRICT_UNRESOLVED_METHOD' })];
      const error = new StrictModeFailure(diagnostics);

      assert.strictEqual(error.diagnostics.length, 1);
      assert.strictEqual(error.count, 1);
      assert.strictEqual(error.diagnostics[0].code, 'STRICT_UNRESOLVED_METHOD');
    });

    it('should have minimal message (no duplication)', () => {
      const diagnostics = [createDiagnostic({ message: 'detailed message here' })];
      const error = new StrictModeFailure(diagnostics);

      // Message should NOT contain the detailed diagnostic message
      assert.ok(!error.message.includes('detailed message here'));
      assert.ok(error.message.includes('1 unresolved reference'));
    });

    it('should pluralize correctly for multiple errors', () => {
      const diagnostics = [
        createDiagnostic({ code: 'ERR_1' }),
        createDiagnostic({ code: 'ERR_2' }),
        createDiagnostic({ code: 'ERR_3' }),
      ];
      const error = new StrictModeFailure(diagnostics);

      assert.strictEqual(error.count, 3);
      assert.ok(error.message.includes('3 unresolved reference'));
    });

    it('should be instanceof Error', () => {
      const error = new StrictModeFailure([]);
      assert.ok(error instanceof Error);
    });

    it('should have correct name property', () => {
      const error = new StrictModeFailure([]);
      assert.strictEqual(error.name, 'StrictModeFailure');
    });

    it('should handle empty diagnostics array', () => {
      const error = new StrictModeFailure([]);
      assert.strictEqual(error.count, 0);
      assert.strictEqual(error.diagnostics.length, 0);
      assert.ok(error.message.includes('0 unresolved'));
    });
  });

  describe('diagnostics with resolution chain', () => {
    it('should preserve resolution chain in diagnostics', () => {
      const chain: ResolutionStep[] = [
        { step: 'getUser() return', result: 'unknown (not declared)', file: '/tmp/test.js', line: 1 },
        { step: 'user variable', result: 'inherits unknown type' },
        { step: 'user.processData', result: 'FAILED (no type information)' },
      ];

      const diagnostics = [createDiagnostic({
        resolutionChain: chain,
        failureReason: 'unknown_object_type',
      })];

      const error = new StrictModeFailure(diagnostics);

      assert.strictEqual(error.diagnostics[0].resolutionChain?.length, 3);
      assert.strictEqual(error.diagnostics[0].resolutionChain?.[0].step, 'getUser() return');
      assert.strictEqual(error.diagnostics[0].failureReason, 'unknown_object_type');
    });
  });

  describe('usage pattern', () => {
    it('should work with instanceof check in catch block', () => {
      // Simulate the catch block pattern
      const diagnostics = [createDiagnostic()];
      const thrown = new StrictModeFailure(diagnostics);

      let caught: StrictModeFailure | null = null;
      try {
        throw thrown;
      } catch (e) {
        if (e instanceof StrictModeFailure) {
          caught = e;
        }
      }

      assert.ok(caught !== null, 'Should catch as StrictModeFailure');
      assert.strictEqual(caught!.count, 1);
    });
  });

  describe('suppression count (REG-332)', () => {
    it('should store suppressedCount when provided', () => {
      const diagnostics = [createDiagnostic()];
      const error = new StrictModeFailure(diagnostics, 5);

      assert.strictEqual(error.suppressedCount, 5);
    });

    it('should default suppressedCount to 0', () => {
      const diagnostics = [createDiagnostic()];
      const error = new StrictModeFailure(diagnostics);

      assert.strictEqual(error.suppressedCount, 0);
    });

    it('should preserve both count and suppressedCount', () => {
      const diagnostics = [
        createDiagnostic(),
        createDiagnostic(),
      ];
      const error = new StrictModeFailure(diagnostics, 3);

      assert.strictEqual(error.count, 2, 'Should have 2 actual errors');
      assert.strictEqual(error.suppressedCount, 3, 'Should have 3 suppressed errors');
    });
  });
});
