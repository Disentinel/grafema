/**
 * Tests for toposort utility (REG-367).
 *
 * Verifies Kahn's algorithm for dependency-based plugin ordering:
 * - Empty input, single item
 * - Linear chains, diamond dependencies
 * - Cross-phase deps (missing from set) silently ignored
 * - Cycle detection with clear error
 * - Registration order tiebreaker for independent items
 * - Real-world enrichment phase scenario
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { toposort, CycleError } from '@grafema/core';
import type { ToposortItem } from '@grafema/core';

describe('toposort', () => {
  it('should return empty array for empty input', () => {
    assert.deepStrictEqual(toposort([]), []);
  });

  it('should return single item with no deps', () => {
    const items: ToposortItem[] = [{ id: 'A', dependencies: [] }];
    assert.deepStrictEqual(toposort(items), ['A']);
  });

  it('should sort linear chain A -> B -> C', () => {
    const items: ToposortItem[] = [
      { id: 'C', dependencies: ['B'] },
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
    ];
    const result = toposort(items);
    // A must come before B, B must come before C
    assert.ok(result.indexOf('A') < result.indexOf('B'), 'A before B');
    assert.ok(result.indexOf('B') < result.indexOf('C'), 'B before C');
  });

  it('should handle diamond dependency (A -> B,C -> D)', () => {
    const items: ToposortItem[] = [
      { id: 'D', dependencies: ['B', 'C'] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['A'] },
      { id: 'A', dependencies: [] },
    ];
    const result = toposort(items);
    assert.ok(result.indexOf('A') < result.indexOf('B'), 'A before B');
    assert.ok(result.indexOf('A') < result.indexOf('C'), 'A before C');
    assert.ok(result.indexOf('B') < result.indexOf('D'), 'B before D');
    assert.ok(result.indexOf('C') < result.indexOf('D'), 'C before D');
  });

  it('should silently ignore missing deps (cross-phase)', () => {
    const items: ToposortItem[] = [
      { id: 'Enricher', dependencies: ['JSASTAnalyzer'] }, // JSASTAnalyzer not in set
      { id: 'Validator', dependencies: ['Enricher', 'MissingPlugin'] },
    ];
    const result = toposort(items);
    assert.ok(result.indexOf('Enricher') < result.indexOf('Validator'), 'Enricher before Validator');
  });

  it('should throw CycleError on simple cycle A -> B -> A', () => {
    const items: ToposortItem[] = [
      { id: 'A', dependencies: ['B'] },
      { id: 'B', dependencies: ['A'] },
    ];
    assert.throws(
      () => toposort(items),
      (err: unknown) => {
        assert.ok(err instanceof CycleError, 'should be CycleError');
        assert.ok(err.cycle.length >= 3, 'cycle should include at least 3 elements (A->B->A)');
        assert.ok(err.message.includes('cycle'), 'message mentions cycle');
        return true;
      }
    );
  });

  it('should throw CycleError on self-cycle', () => {
    const items: ToposortItem[] = [
      { id: 'A', dependencies: ['A'] },
    ];
    assert.throws(
      () => toposort(items),
      (err: unknown) => {
        assert.ok(err instanceof CycleError, 'should be CycleError');
        return true;
      }
    );
  });

  it('should throw CycleError on 3-node cycle', () => {
    const items: ToposortItem[] = [
      { id: 'A', dependencies: ['C'] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['B'] },
    ];
    assert.throws(
      () => toposort(items),
      (err: unknown) => {
        assert.ok(err instanceof CycleError, 'should be CycleError');
        return true;
      }
    );
  });

  it('should preserve registration order for independent items', () => {
    const items: ToposortItem[] = [
      { id: 'Third', dependencies: [] },
      { id: 'First', dependencies: [] },
      { id: 'Second', dependencies: [] },
    ];
    // Should come out in input order since there are no dependencies
    assert.deepStrictEqual(toposort(items), ['Third', 'First', 'Second']);
  });

  it('should use registration order as tiebreaker within topological levels', () => {
    // A is a dep of both B and C. B and C are independent of each other.
    // B is registered before C, so B should come before C.
    const items: ToposortItem[] = [
      { id: 'A', dependencies: [] },
      { id: 'C', dependencies: ['A'] },
      { id: 'B', dependencies: ['A'] },
    ];
    const result = toposort(items);
    assert.strictEqual(result[0], 'A');
    // C registered before B, so C should come first among peers
    assert.strictEqual(result[1], 'C');
    assert.strictEqual(result[2], 'B');
  });

  it('should handle real-world enrichment phase scenario', () => {
    const items: ToposortItem[] = [
      { id: 'InstanceOfResolver', dependencies: ['JSASTAnalyzer'] }, // cross-phase
      { id: 'ImportExportLinker', dependencies: ['JSASTAnalyzer'] }, // cross-phase
      { id: 'MountPointResolver', dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer'] }, // all cross-phase
      { id: 'FunctionCallResolver', dependencies: ['ImportExportLinker'] }, // intra-phase
      { id: 'PrefixEvaluator', dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'MountPointResolver'] }, // MountPointResolver is intra
      { id: 'ExternalCallResolver', dependencies: ['FunctionCallResolver'] }, // intra-phase
      { id: 'MethodCallResolver', dependencies: ['ImportExportLinker'] }, // intra-phase
      { id: 'AliasTracker', dependencies: ['MethodCallResolver'] }, // intra-phase
      { id: 'ValueDomainAnalyzer', dependencies: ['AliasTracker'] }, // intra-phase
      { id: 'ArgumentParameterLinker', dependencies: ['JSASTAnalyzer', 'MethodCallResolver'] }, // MethodCallResolver is intra
      { id: 'NodejsBuiltinsResolver', dependencies: ['JSASTAnalyzer', 'ImportExportLinker'] }, // ImportExportLinker is intra
      { id: 'ClosureCaptureEnricher', dependencies: ['JSASTAnalyzer'] }, // cross-phase
    ];

    const result = toposort(items);

    // Verify key ordering constraints
    assert.ok(
      result.indexOf('ImportExportLinker') < result.indexOf('FunctionCallResolver'),
      'ImportExportLinker before FunctionCallResolver'
    );
    assert.ok(
      result.indexOf('FunctionCallResolver') < result.indexOf('ExternalCallResolver'),
      'FunctionCallResolver before ExternalCallResolver'
    );
    assert.ok(
      result.indexOf('ImportExportLinker') < result.indexOf('MethodCallResolver'),
      'ImportExportLinker before MethodCallResolver'
    );
    assert.ok(
      result.indexOf('MethodCallResolver') < result.indexOf('AliasTracker'),
      'MethodCallResolver before AliasTracker'
    );
    assert.ok(
      result.indexOf('AliasTracker') < result.indexOf('ValueDomainAnalyzer'),
      'AliasTracker before ValueDomainAnalyzer'
    );
    assert.ok(
      result.indexOf('MethodCallResolver') < result.indexOf('ArgumentParameterLinker'),
      'MethodCallResolver before ArgumentParameterLinker'
    );
    assert.ok(
      result.indexOf('MountPointResolver') < result.indexOf('PrefixEvaluator'),
      'MountPointResolver before PrefixEvaluator'
    );
    assert.ok(
      result.indexOf('ImportExportLinker') < result.indexOf('NodejsBuiltinsResolver'),
      'ImportExportLinker before NodejsBuiltinsResolver'
    );
  });

  it('should detect cycle even when some items are not in the cycle', () => {
    const items: ToposortItem[] = [
      { id: 'OK1', dependencies: [] },
      { id: 'OK2', dependencies: ['OK1'] },
      { id: 'CycleA', dependencies: ['CycleB'] },
      { id: 'CycleB', dependencies: ['CycleA'] },
    ];
    assert.throws(
      () => toposort(items),
      (err: unknown) => {
        assert.ok(err instanceof CycleError);
        // Cycle should mention CycleA and CycleB, not OK1/OK2
        assert.ok(
          err.cycle.includes('CycleA') && err.cycle.includes('CycleB'),
          'cycle should include the cycle nodes'
        );
        return true;
      }
    );
  });
});
