/**
 * ValidationError Integration Tests
 *
 * Integration tests verifying that ValidationError flows correctly through
 * the diagnostic pipeline: Validator -> PluginResult.errors -> DiagnosticCollector
 *
 * REG-217 Phase 0: Fix validator contract so validators return ValidationError
 * in errors array.
 *
 * Key integration points tested:
 * 1. ValidationError in PluginResult.errors is processed by DiagnosticCollector
 * 2. DiagnosticCollector extracts code, severity, message, context from ValidationError
 * 3. ValidationError with warning severity is counted as warning (not error)
 * 4. ValidationError with error severity is counted as error
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// NOTE: ValidationError import will fail until implemented - tests first!
import {
  DiagnosticCollector,
  ValidationError,
  GrafemaError,
} from '@grafema/core';
import { createSuccessResult } from '@grafema/types';
import type { PluginResult } from '@grafema/types';

// =============================================================================
// TESTS: ValidationError Integration with DiagnosticCollector
// =============================================================================

describe('ValidationError Integration', () => {
  let collector: DiagnosticCollector;

  beforeEach(() => {
    collector = new DiagnosticCollector();
  });

  describe('DiagnosticCollector.addFromPluginResult() with ValidationError', () => {
    it('should extract ValidationError from PluginResult.errors', () => {
      const error = new ValidationError(
        'Call to "processData" does not resolve',
        'ERR_UNRESOLVED_CALL',
        {
          filePath: 'src/app.js',
          lineNumber: 42,
          plugin: 'CallResolverValidator',
        },
        'Ensure the function is defined and exported'
      );

      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        {},
        [error]
      );

      collector.addFromPluginResult('VALIDATION', 'CallResolverValidator', result);

      assert.strictEqual(collector.count(), 1);

      const diagnostics = collector.getAll();
      assert.strictEqual(diagnostics[0].code, 'ERR_UNRESOLVED_CALL');
      assert.strictEqual(diagnostics[0].message, 'Call to "processData" does not resolve');
      assert.strictEqual(diagnostics[0].file, 'src/app.js');
      assert.strictEqual(diagnostics[0].line, 42);
      assert.strictEqual(diagnostics[0].plugin, 'CallResolverValidator');
      assert.strictEqual(diagnostics[0].phase, 'VALIDATION');
      assert.strictEqual(diagnostics[0].suggestion, 'Ensure the function is defined and exported');
    });

    it('should preserve warning severity from ValidationError', () => {
      const error = new ValidationError(
        'Missing assignment',
        'ERR_MISSING_ASSIGNMENT',
        {},
        undefined,
        'warning'
      );

      const result = createSuccessResult({ nodes: 0, edges: 0 }, {}, [error]);
      collector.addFromPluginResult('VALIDATION', 'DataFlowValidator', result);

      const diagnostics = collector.getAll();
      assert.strictEqual(diagnostics[0].severity, 'warning');
    });

    it('should preserve error severity from ValidationError', () => {
      const error = new ValidationError(
        'Broken reference',
        'ERR_BROKEN_REFERENCE',
        {},
        undefined,
        'error'
      );

      const result = createSuccessResult({ nodes: 0, edges: 0 }, {}, [error]);
      collector.addFromPluginResult('VALIDATION', 'DataFlowValidator', result);

      const diagnostics = collector.getAll();
      assert.strictEqual(diagnostics[0].severity, 'error');
    });

    it('should handle multiple ValidationErrors from one result', () => {
      const errors = [
        new ValidationError('Issue 1', 'ERR_UNRESOLVED_CALL', { filePath: 'file1.js' }),
        new ValidationError('Issue 2', 'ERR_UNRESOLVED_CALL', { filePath: 'file2.js' }),
        new ValidationError('Issue 3', 'ERR_DISCONNECTED_NODES', {}),
      ];

      const result = createSuccessResult({ nodes: 0, edges: 0 }, {}, errors);
      collector.addFromPluginResult('VALIDATION', 'TestValidator', result);

      assert.strictEqual(collector.count(), 3);

      const diagnostics = collector.getAll();
      assert.strictEqual(diagnostics[0].message, 'Issue 1');
      assert.strictEqual(diagnostics[1].message, 'Issue 2');
      assert.strictEqual(diagnostics[2].message, 'Issue 3');
    });
  });

  describe('hasWarnings() with ValidationError', () => {
    it('should return true when ValidationError has warning severity', () => {
      const error = new ValidationError(
        'Unresolved call',
        'ERR_UNRESOLVED_CALL',
        {},
        undefined,
        'warning'
      );

      const result = createSuccessResult({ nodes: 0, edges: 0 }, {}, [error]);
      collector.addFromPluginResult('VALIDATION', 'CallResolverValidator', result);

      assert.strictEqual(collector.hasWarnings(), true);
      assert.strictEqual(collector.hasErrors(), false);
    });
  });

  describe('hasErrors() with ValidationError', () => {
    it('should return true when ValidationError has error severity', () => {
      const error = new ValidationError(
        'Broken reference',
        'ERR_BROKEN_REFERENCE',
        {},
        undefined,
        'error'
      );

      const result = createSuccessResult({ nodes: 0, edges: 0 }, {}, [error]);
      collector.addFromPluginResult('VALIDATION', 'DataFlowValidator', result);

      assert.strictEqual(collector.hasErrors(), true);
    });

    it('should return false when ValidationError has warning severity', () => {
      const error = new ValidationError(
        'Missing assignment',
        'ERR_MISSING_ASSIGNMENT',
        {},
        undefined,
        'warning'
      );

      const result = createSuccessResult({ nodes: 0, edges: 0 }, {}, [error]);
      collector.addFromPluginResult('VALIDATION', 'DataFlowValidator', result);

      assert.strictEqual(collector.hasErrors(), false);
    });
  });

  describe('getByCode() with ValidationError', () => {
    it('should filter by validation error code', () => {
      const errors = [
        new ValidationError('Call 1', 'ERR_UNRESOLVED_CALL', { filePath: 'a.js' }),
        new ValidationError('Call 2', 'ERR_UNRESOLVED_CALL', { filePath: 'b.js' }),
        new ValidationError('Disconnected', 'ERR_DISCONNECTED_NODES', {}),
      ];

      const result = createSuccessResult({ nodes: 0, edges: 0 }, {}, errors);
      collector.addFromPluginResult('VALIDATION', 'MixedValidator', result);

      const unresolvedCalls = collector.getByCode('ERR_UNRESOLVED_CALL');
      assert.strictEqual(unresolvedCalls.length, 2);

      const disconnected = collector.getByCode('ERR_DISCONNECTED_NODES');
      assert.strictEqual(disconnected.length, 1);
    });
  });

  describe('getByPlugin() with ValidationError', () => {
    it('should filter by validator plugin name', () => {
      // Simulate two validators running in sequence
      const callErrors = [
        new ValidationError('Unresolved call', 'ERR_UNRESOLVED_CALL', {}),
      ];
      const dataFlowErrors = [
        new ValidationError('Missing assignment', 'ERR_MISSING_ASSIGNMENT', {}),
        new ValidationError('Broken reference', 'ERR_BROKEN_REFERENCE', {}),
      ];

      collector.addFromPluginResult(
        'VALIDATION',
        'CallResolverValidator',
        createSuccessResult({ nodes: 0, edges: 0 }, {}, callErrors)
      );
      collector.addFromPluginResult(
        'VALIDATION',
        'DataFlowValidator',
        createSuccessResult({ nodes: 0, edges: 0 }, {}, dataFlowErrors)
      );

      const callValidatorDiags = collector.getByPlugin('CallResolverValidator');
      assert.strictEqual(callValidatorDiags.length, 1);

      const dataFlowDiags = collector.getByPlugin('DataFlowValidator');
      assert.strictEqual(dataFlowDiags.length, 2);
    });
  });

  describe('getByPhase() with ValidationError', () => {
    it('should return all validation phase diagnostics', () => {
      const errors = [
        new ValidationError('Issue 1', 'ERR_TEST', {}),
        new ValidationError('Issue 2', 'ERR_TEST', {}),
      ];

      collector.addFromPluginResult(
        'VALIDATION',
        'TestValidator',
        createSuccessResult({ nodes: 0, edges: 0 }, {}, errors)
      );

      const validationDiags = collector.getByPhase('VALIDATION');
      assert.strictEqual(validationDiags.length, 2);

      for (const diag of validationDiags) {
        assert.strictEqual(diag.phase, 'VALIDATION');
      }
    });
  });

  describe('toDiagnosticsLog() with ValidationError', () => {
    it('should serialize ValidationError to JSON lines format', () => {
      const error = new ValidationError(
        'Unresolved call to "foo"',
        'ERR_UNRESOLVED_CALL',
        { filePath: 'src/app.js', lineNumber: 42 },
        'Ensure function is exported',
        'warning'
      );

      collector.addFromPluginResult(
        'VALIDATION',
        'CallResolverValidator',
        createSuccessResult({ nodes: 0, edges: 0 }, {}, [error])
      );

      const log = collector.toDiagnosticsLog();
      const parsed = JSON.parse(log);

      assert.strictEqual(parsed.code, 'ERR_UNRESOLVED_CALL');
      assert.strictEqual(parsed.severity, 'warning');
      assert.strictEqual(parsed.message, 'Unresolved call to "foo"');
      assert.strictEqual(parsed.file, 'src/app.js');
      assert.strictEqual(parsed.line, 42);
      assert.strictEqual(parsed.phase, 'VALIDATION');
      assert.strictEqual(parsed.plugin, 'CallResolverValidator');
      assert.strictEqual(parsed.suggestion, 'Ensure function is exported');
    });
  });

  // ===========================================================================
  // Real-world scenarios
  // ===========================================================================

  describe('real-world validator scenarios', () => {
    it('should handle CallResolverValidator output', () => {
      // Simulate CallResolverValidator returning unresolved calls
      const unresolvedCalls = [
        new ValidationError(
          'Call to "processData" at src/api.js:15 does not resolve to a function definition',
          'ERR_UNRESOLVED_CALL',
          { filePath: 'src/api.js', lineNumber: 15, phase: 'VALIDATION', plugin: 'CallResolverValidator' },
          'Ensure the function is defined and exported'
        ),
        new ValidationError(
          'Call to "formatResponse" at src/api.js:28 does not resolve to a function definition',
          'ERR_UNRESOLVED_CALL',
          { filePath: 'src/api.js', lineNumber: 28, phase: 'VALIDATION', plugin: 'CallResolverValidator' },
          'Ensure the function is defined and exported'
        ),
      ];

      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        {
          summary: {
            totalCalls: 50,
            resolvedInternalCalls: 48,
            unresolvedInternalCalls: 2,
            issues: 2,
          },
        },
        unresolvedCalls
      );

      collector.addFromPluginResult('VALIDATION', 'CallResolverValidator', result);

      // Verify diagnostics were collected
      assert.strictEqual(collector.count(), 2);
      assert.strictEqual(collector.hasWarnings(), true);
      assert.strictEqual(collector.hasErrors(), false);

      // Verify can filter by code
      const byCode = collector.getByCode('ERR_UNRESOLVED_CALL');
      assert.strictEqual(byCode.length, 2);
    });

    it('should handle GraphConnectivityValidator output', () => {
      // Simulate GraphConnectivityValidator finding disconnected nodes
      const disconnectedError = new ValidationError(
        'Found 15 unreachable nodes (5.2% of total)',
        'ERR_DISCONNECTED_NODES',
        { phase: 'VALIDATION', plugin: 'GraphConnectivityValidator' },
        'Fix analysis plugins to ensure all nodes are connected'
      );

      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        {
          totalNodes: 288,
          reachableNodes: 273,
          unreachableNodes: 15,
          reachabilityPercentage: 94.8,
        },
        [disconnectedError]
      );

      collector.addFromPluginResult('VALIDATION', 'GraphConnectivityValidator', result);

      assert.strictEqual(collector.count(), 1);
      assert.strictEqual(collector.getByCode('ERR_DISCONNECTED_NODES').length, 1);
    });

    it('should handle DataFlowValidator output with mixed severities', () => {
      // Simulate DataFlowValidator with different issue types
      const dataFlowErrors = [
        new ValidationError(
          'Variable "config" is used but never assigned',
          'ERR_MISSING_ASSIGNMENT',
          { filePath: 'src/config.js', lineNumber: 5 },
          undefined,
          'warning'
        ),
        new ValidationError(
          'Broken reference to undefined variable "data"',
          'ERR_BROKEN_REFERENCE',
          { filePath: 'src/handler.js', lineNumber: 20 },
          undefined,
          'error' // This one is error severity
        ),
        new ValidationError(
          'Data flow trace has no terminal node',
          'ERR_NO_LEAF_NODE',
          {},
          undefined,
          'warning'
        ),
      ];

      const result = createSuccessResult(
        { nodes: 0, edges: 0 },
        { totalTraces: 100, completeTraces: 97 },
        dataFlowErrors
      );

      collector.addFromPluginResult('VALIDATION', 'DataFlowValidator', result);

      assert.strictEqual(collector.count(), 3);
      assert.strictEqual(collector.hasWarnings(), true);
      assert.strictEqual(collector.hasErrors(), true); // ERR_BROKEN_REFERENCE is error

      // Verify severity distribution
      const warnings = collector.getAll().filter(d => d.severity === 'warning');
      const errors = collector.getAll().filter(d => d.severity === 'error');
      assert.strictEqual(warnings.length, 2);
      assert.strictEqual(errors.length, 1);
    });

    it('should handle all validators running in sequence', () => {
      // Simulate full validation phase
      const callResolverResult = createSuccessResult(
        { nodes: 0, edges: 0 },
        {},
        [new ValidationError('Unresolved call', 'ERR_UNRESOLVED_CALL', {})]
      );

      const connectivityResult = createSuccessResult(
        { nodes: 0, edges: 0 },
        {},
        [new ValidationError('Disconnected nodes', 'ERR_DISCONNECTED_NODES', {})]
      );

      const dataFlowResult = createSuccessResult(
        { nodes: 0, edges: 0 },
        {},
        [
          new ValidationError('Missing assignment', 'ERR_MISSING_ASSIGNMENT', {}),
          new ValidationError('Broken reference', 'ERR_BROKEN_REFERENCE', {}, undefined, 'error'),
        ]
      );

      collector.addFromPluginResult('VALIDATION', 'CallResolverValidator', callResolverResult);
      collector.addFromPluginResult('VALIDATION', 'GraphConnectivityValidator', connectivityResult);
      collector.addFromPluginResult('VALIDATION', 'DataFlowValidator', dataFlowResult);

      // Total diagnostics from all validators
      assert.strictEqual(collector.count(), 4);

      // Verify by plugin
      assert.strictEqual(collector.getByPlugin('CallResolverValidator').length, 1);
      assert.strictEqual(collector.getByPlugin('GraphConnectivityValidator').length, 1);
      assert.strictEqual(collector.getByPlugin('DataFlowValidator').length, 2);

      // Verify by code
      assert.strictEqual(collector.getByCode('ERR_UNRESOLVED_CALL').length, 1);
      assert.strictEqual(collector.getByCode('ERR_DISCONNECTED_NODES').length, 1);
      assert.strictEqual(collector.getByCode('ERR_MISSING_ASSIGNMENT').length, 1);
      assert.strictEqual(collector.getByCode('ERR_BROKEN_REFERENCE').length, 1);
    });
  });
});
