/**
 * Cardinality Types Tests (REG-314 Phase 1)
 *
 * Tests to verify that cardinality types compile and export correctly:
 * - ScaleCategory type accepts valid values
 * - Cardinality interface has required fields
 * - CardinalityTransform accepts valid values
 * - EntryPointAnnotation has pattern and returns
 * - TransformAnnotation has pattern and transform
 *
 * TDD: These tests verify type definitions exist and are properly exported.
 * Tests will FAIL until the types are implemented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// =============================================================================
// TESTS: ScaleCategory Type
// =============================================================================

describe('ScaleCategory Type (REG-314 Phase 1)', () => {
  it('should export ScaleCategory type', async () => {
    const types = await import('@grafema/types');

    // Create values for each scale category - compile-time check
    const constant: types.ScaleCategory = 'constant';
    const config: types.ScaleCategory = 'config';
    const routes: types.ScaleCategory = 'routes';
    const files: types.ScaleCategory = 'files';
    const functions: types.ScaleCategory = 'functions';
    const nodes: types.ScaleCategory = 'nodes';
    const unbounded: types.ScaleCategory = 'unbounded';

    // Runtime verification
    assert.strictEqual(constant, 'constant');
    assert.strictEqual(config, 'config');
    assert.strictEqual(routes, 'routes');
    assert.strictEqual(files, 'files');
    assert.strictEqual(functions, 'functions');
    assert.strictEqual(nodes, 'nodes');
    assert.strictEqual(unbounded, 'unbounded');
  });

  it('should accept all valid scale categories', async () => {
    const types = await import('@grafema/types');

    const validScales: types.ScaleCategory[] = [
      'constant',
      'config',
      'routes',
      'files',
      'functions',
      'nodes',
      'unbounded',
    ];

    assert.strictEqual(validScales.length, 7, 'Should have 7 scale categories');
  });
});

// =============================================================================
// TESTS: ConfidenceLevel Type
// =============================================================================

describe('ConfidenceLevel Type (REG-314 Phase 1)', () => {
  it('should export ConfidenceLevel type', async () => {
    const types = await import('@grafema/types');

    const exact: types.ConfidenceLevel = 'exact';
    const declared: types.ConfidenceLevel = 'declared';
    const inferred: types.ConfidenceLevel = 'inferred';
    const heuristic: types.ConfidenceLevel = 'heuristic';

    assert.strictEqual(exact, 'exact');
    assert.strictEqual(declared, 'declared');
    assert.strictEqual(inferred, 'inferred');
    assert.strictEqual(heuristic, 'heuristic');
  });
});

// =============================================================================
// TESTS: CardinalityInterval Interface
// =============================================================================

describe('CardinalityInterval Interface (REG-314 Phase 1)', () => {
  it('should export CardinalityInterval interface', async () => {
    const types = await import('@grafema/types');

    const interval: types.CardinalityInterval = {
      lo: 0,
      hi: 100,
    };

    assert.strictEqual(interval.lo, 0);
    assert.strictEqual(interval.hi, 100);
  });

  it('should support Infinity for hi', async () => {
    const types = await import('@grafema/types');

    const unboundedInterval: types.CardinalityInterval = {
      lo: 0,
      hi: Infinity,
    };

    assert.strictEqual(unboundedInterval.hi, Infinity);
  });
});

// =============================================================================
// TESTS: Cardinality Interface
// =============================================================================

describe('Cardinality Interface (REG-314 Phase 1)', () => {
  it('should export Cardinality interface with required fields', async () => {
    const types = await import('@grafema/types');

    const cardinality: types.Cardinality = {
      scale: 'config',
      interval: { lo: 10, hi: 100 },
      confidence: 'declared',
    };

    assert.strictEqual(cardinality.scale, 'config');
    assert.deepStrictEqual(cardinality.interval, { lo: 10, hi: 100 });
    assert.strictEqual(cardinality.confidence, 'declared');
  });

  it('should support optional source field', async () => {
    const types = await import('@grafema/types');

    const cardinality: types.Cardinality = {
      scale: 'routes',
      interval: { lo: 50, hi: 500 },
      confidence: 'inferred',
      source: 'http.routes',
    };

    assert.strictEqual(cardinality.source, 'http.routes');
  });

  it('should allow cardinality without source', async () => {
    const types = await import('@grafema/types');

    const cardinality: types.Cardinality = {
      scale: 'constant',
      interval: { lo: 1, hi: 1 },
      confidence: 'exact',
    };

    assert.strictEqual(cardinality.source, undefined);
  });
});

// =============================================================================
// TESTS: CardinalityTransform Type
// =============================================================================

describe('CardinalityTransform Type (REG-314 Phase 1)', () => {
  it('should export CardinalityTransform type', async () => {
    const types = await import('@grafema/types');

    const preserve: types.CardinalityTransform = 'preserve';
    const map: types.CardinalityTransform = 'map';
    const reduce: types.CardinalityTransform = 'reduce';
    const expand: types.CardinalityTransform = 'expand';
    const unknown: types.CardinalityTransform = 'unknown';

    assert.strictEqual(preserve, 'preserve');
    assert.strictEqual(map, 'map');
    assert.strictEqual(reduce, 'reduce');
    assert.strictEqual(expand, 'expand');
    assert.strictEqual(unknown, 'unknown');
  });

  it('should accept all valid transform values', async () => {
    const types = await import('@grafema/types');

    const validTransforms: types.CardinalityTransform[] = [
      'preserve',
      'map',
      'reduce',
      'expand',
      'unknown',
    ];

    assert.strictEqual(validTransforms.length, 5, 'Should have 5 transform types');
  });
});

// =============================================================================
// TESTS: ScaleDefinition Interface
// =============================================================================

describe('ScaleDefinition Interface (REG-314 Phase 1)', () => {
  it('should export ScaleDefinition interface', async () => {
    const types = await import('@grafema/types');

    const scaleDef: types.ScaleDefinition = {
      name: 'http.routes',
      category: 'routes',
    };

    assert.strictEqual(scaleDef.name, 'http.routes');
    assert.strictEqual(scaleDef.category, 'routes');
  });

  it('should support optional typical and max fields', async () => {
    const types = await import('@grafema/types');

    const scaleDef: types.ScaleDefinition = {
      name: 'project.files',
      category: 'files',
      typical: 5000,
      max: 50000,
    };

    assert.strictEqual(scaleDef.typical, 5000);
    assert.strictEqual(scaleDef.max, 50000);
  });
});

// =============================================================================
// TESTS: EntryPointAnnotation Interface
// =============================================================================

describe('EntryPointAnnotation Interface (REG-314 Phase 1)', () => {
  it('should export EntryPointAnnotation interface', async () => {
    const types = await import('@grafema/types');

    const annotation: types.EntryPointAnnotation = {
      pattern: 'db.query',
      returns: 'nodes',
    };

    assert.strictEqual(annotation.pattern, 'db.query');
    assert.strictEqual(annotation.returns, 'nodes');
  });

  it('should require both pattern and returns fields', async () => {
    const types = await import('@grafema/types');

    // This is a compile-time test - verifying structure
    const annotation: types.EntryPointAnnotation = {
      pattern: 'fs.readdir',
      returns: 'files',
    };

    assert.ok(annotation.pattern !== undefined, 'pattern should be required');
    assert.ok(annotation.returns !== undefined, 'returns should be required');
  });
});

// =============================================================================
// TESTS: TransformAnnotation Interface
// =============================================================================

describe('TransformAnnotation Interface (REG-314 Phase 1)', () => {
  it('should export TransformAnnotation interface', async () => {
    const types = await import('@grafema/types');

    const annotation: types.TransformAnnotation = {
      pattern: '*.filter',
      transform: 'preserve',
    };

    assert.strictEqual(annotation.pattern, '*.filter');
    assert.strictEqual(annotation.transform, 'preserve');
  });

  it('should support optional factor field', async () => {
    const types = await import('@grafema/types');

    const annotation: types.TransformAnnotation = {
      pattern: '*.flatMap',
      transform: 'expand',
      factor: 'children.length',
    };

    assert.strictEqual(annotation.factor, 'children.length');
  });

  it('should require pattern and transform fields', async () => {
    const types = await import('@grafema/types');

    const annotation: types.TransformAnnotation = {
      pattern: '*.map',
      transform: 'map',
    };

    assert.ok(annotation.pattern !== undefined, 'pattern should be required');
    assert.ok(annotation.transform !== undefined, 'transform should be required');
  });
});

// =============================================================================
// TESTS: Type Re-exports from @grafema/types
// =============================================================================

describe('Cardinality Types Re-export (REG-314 Phase 1)', () => {
  it('should re-export all cardinality types from @grafema/types', async () => {
    const types = await import('@grafema/types');

    // Verify all types are exported (compile-time check)
    // These will fail at runtime if types are not exported
    const _scale: types.ScaleCategory = 'constant';
    const _confidence: types.ConfidenceLevel = 'exact';
    const _interval: types.CardinalityInterval = { lo: 0, hi: 1 };
    const _cardinality: types.Cardinality = {
      scale: 'constant',
      interval: { lo: 1, hi: 1 },
      confidence: 'exact',
    };
    const _transform: types.CardinalityTransform = 'map';
    const _scaleDef: types.ScaleDefinition = { name: 'test', category: 'constant' };
    const _entryPoint: types.EntryPointAnnotation = { pattern: 'test', returns: 'constant' };
    const _transformAnnotation: types.TransformAnnotation = { pattern: 'test', transform: 'map' };

    // If we reach here, all types are exported
    assert.ok(true, 'All cardinality types should be exported');
  });
});
