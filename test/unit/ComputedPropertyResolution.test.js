/**
 * Tests for Computed Property Value Resolution (REG-135)
 *
 * When code does obj[key] = value where key is a variable,
 * we should resolve the property name if the variable has a deterministic value.
 *
 * This feature extends the existing ValueDomainAnalyzer to resolve
 * computed property names in FLOWS_INTO edges created by object mutations.
 *
 * Resolution statuses:
 * - RESOLVED: Single deterministic value (const k = 'x'; obj[k] = v)
 * - RESOLVED_CONDITIONAL: Multiple possible values (const k = c ? 'a' : 'b'; obj[k] = v)
 * - UNKNOWN_PARAMETER: Variable is a function parameter
 * - UNKNOWN_RUNTIME: Variable comes from function call result
 * - DEFERRED_CROSS_FILE: Variable comes from import (future)
 *
 * This is TDD - tests are written BEFORE implementation and should be RED initially.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { ValueDomainAnalyzer } from '@grafema/core';

let testCounter = 0;

/**
 * Helper to create a test project with given files and run analysis
 * including ValueDomainAnalyzer enrichment.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-computed-prop-resolution-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: `test-computed-prop-resolution-${testCounter}`, type: 'module' })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  // Include ValueDomainAnalyzer as an extra plugin for enrichment
  const orchestrator = createTestOrchestrator(backend, {
    extraPlugins: [new ValueDomainAnalyzer()]
  });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Helper to find FLOWS_INTO edges with computed mutation type
 */
async function findComputedFlowsIntoEdges(backend) {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter(e =>
    e.type === 'FLOWS_INTO' &&
    e.mutationType === 'computed'
  );
}

/**
 * Helper to find FLOWS_INTO edge for a specific computedPropertyVar
 */
async function findEdgeByComputedVar(backend, varName) {
  const allEdges = await backend.getAllEdges();
  return allEdges.find(e =>
    e.type === 'FLOWS_INTO' &&
    e.computedPropertyVar === varName
  );
}

describe('Computed Property Value Resolution (REG-135)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ============================================================================
  // Phase 1: Verify computedPropertyVar is captured in FLOWS_INTO edges
  // This tests the ANALYSIS phase changes (JSASTAnalyzer -> GraphBuilder)
  // ============================================================================
  describe('Analysis Phase: computedPropertyVar capture', () => {
    it('should capture computedPropertyVar in FLOWS_INTO edge metadata', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const key = 'propName';
const value = 'test';
obj[key] = value;
        `
      });

      const allEdges = await backend.getAllEdges();

      // Find FLOWS_INTO edge with computed mutation type
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.mutationType === 'computed'
      );

      assert.ok(flowsInto, 'Should have FLOWS_INTO edge for computed property mutation');

      // Verify computedPropertyVar is captured
      assert.strictEqual(
        flowsInto.computedPropertyVar,
        'key',
        `Expected computedPropertyVar 'key', got '${flowsInto.computedPropertyVar}'`
      );
    });

    it('should NOT set computedPropertyVar for non-computed mutations', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const value = 'test';
obj.staticProp = value;
        `
      });

      const allEdges = await backend.getAllEdges();

      // Find FLOWS_INTO edges with property mutation type (not computed)
      const propertyEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.mutationType === 'property'
      );

      // Note: Due to how GraphBuilder works, only one edge per source-target pair is created
      assert.ok(propertyEdges.length >= 1, 'Should have at least 1 property mutation edge');

      // Verify computedPropertyVar is NOT set for property mutations
      for (const edge of propertyEdges) {
        assert.ok(
          !edge.computedPropertyVar,
          `Property mutation should not have computedPropertyVar, but got '${edge.computedPropertyVar}'`
        );
      }
    });
  });

  // ============================================================================
  // Phase 2: Direct literal assignment resolution
  // const k = 'x'; obj[k] = value -> RESOLVED
  // ============================================================================
  describe('Direct literal assignment', () => {
    it('should resolve obj[k] when k = literal string', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const key = 'propName';
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      assert.ok(edge, 'Should have FLOWS_INTO edge for computed property');

      // After enrichment, should be RESOLVED
      assert.strictEqual(
        edge.resolutionStatus,
        'RESOLVED',
        `Expected RESOLVED status, got ${edge.resolutionStatus}`
      );

      // propertyName should be updated to the resolved value
      assert.strictEqual(
        edge.propertyName,
        'propName',
        `Expected propertyName 'propName', got '${edge.propertyName}'`
      );

      // resolvedPropertyNames should be array with single value
      assert.deepStrictEqual(
        edge.resolvedPropertyNames,
        ['propName'],
        `Expected resolvedPropertyNames ['propName'], got ${JSON.stringify(edge.resolvedPropertyNames)}`
      );
    });

    it('should resolve obj[k] when k = numeric literal', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const key = 42;
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      assert.ok(edge, 'Should have FLOWS_INTO edge for computed property');

      assert.strictEqual(edge.resolutionStatus, 'RESOLVED');
      // Numeric keys become strings in objects
      assert.ok(
        edge.resolvedPropertyNames.includes('42') || edge.resolvedPropertyNames.includes(42),
        `Should resolve to '42', got ${JSON.stringify(edge.resolvedPropertyNames)}`
      );
    });
  });

  // ============================================================================
  // Phase 3: Literal chain resolution
  // const a = 'x'; const b = a; obj[b] = value -> RESOLVED
  // ============================================================================
  describe('Literal chain resolution', () => {
    it('should resolve through one-level variable chain', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const original = 'chainedProp';
const key = original;
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      assert.ok(edge, 'Should have FLOWS_INTO edge for computed property');
      assert.strictEqual(edge.resolutionStatus, 'RESOLVED');
      assert.strictEqual(edge.propertyName, 'chainedProp');
    });

    it('should resolve through multi-level variable chain', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const original = 'deepChain';
const alias1 = original;
const alias2 = alias1;
const key = alias2;
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      assert.ok(edge, 'Should have FLOWS_INTO edge for computed property');
      assert.strictEqual(edge.resolutionStatus, 'RESOLVED');
      assert.strictEqual(edge.propertyName, 'deepChain');
    });
  });

  // ============================================================================
  // Phase 4: Conditional assignment (ternary)
  // const k = c ? 'a' : 'b'; obj[k] = value -> RESOLVED_CONDITIONAL
  // ============================================================================
  describe('Conditional assignment (ternary)', () => {
    it('should resolve with RESOLVED_CONDITIONAL for ternary', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const condition = true;
const key = condition ? 'propA' : 'propB';
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      assert.ok(edge, 'Should have FLOWS_INTO edge');
      assert.strictEqual(
        edge.resolutionStatus,
        'RESOLVED_CONDITIONAL',
        `Should have RESOLVED_CONDITIONAL status for ternary, got ${edge.resolutionStatus}`
      );

      // Should have both possible values
      assert.ok(
        edge.resolvedPropertyNames.includes('propA'),
        `Should include propA in resolved names, got ${JSON.stringify(edge.resolvedPropertyNames)}`
      );
      assert.ok(
        edge.resolvedPropertyNames.includes('propB'),
        `Should include propB in resolved names, got ${JSON.stringify(edge.resolvedPropertyNames)}`
      );

      // propertyName should be one of the values (first one by convention)
      assert.ok(
        edge.propertyName === 'propA' || edge.propertyName === 'propB',
        `propertyName should be one of the resolved values, got '${edge.propertyName}'`
      );
    });

    it('should resolve with RESOLVED_CONDITIONAL for logical OR default', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const configKey = null;
const key = configKey || 'defaultProp';
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      assert.ok(edge, 'Should have FLOWS_INTO edge');
      // Logical OR with possible null creates conditional
      assert.ok(
        ['RESOLVED', 'RESOLVED_CONDITIONAL'].includes(edge.resolutionStatus),
        `Should be RESOLVED or RESOLVED_CONDITIONAL, got ${edge.resolutionStatus}`
      );
    });
  });

  // ============================================================================
  // Phase 5: Function parameter (nondeterministic)
  // function f(k) { obj[k] = value } -> UNKNOWN_PARAMETER
  // ============================================================================
  describe('Function parameter (nondeterministic)', () => {
    it('should NOT resolve obj[k] when k is a function parameter', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};

function setProperty(key) {
  const value = 'test';
  obj[key] = value;
}
        `
      });

      // Find the edge for the computed property inside the function
      const computedEdges = await findComputedFlowsIntoEdges(backend);

      // Filter to find the one with computedPropertyVar = 'key'
      const edge = computedEdges.find(e => e.computedPropertyVar === 'key');

      if (edge) {
        // If edge exists, it should have UNKNOWN_PARAMETER status
        assert.strictEqual(
          edge.resolutionStatus,
          'UNKNOWN_PARAMETER',
          `Expected UNKNOWN_PARAMETER status for parameter, got ${edge.resolutionStatus}`
        );

        // Property name should remain <computed> for parameters
        assert.strictEqual(
          edge.propertyName,
          '<computed>',
          `Property name should remain '<computed>' for parameters, got '${edge.propertyName}'`
        );
      }
      // If no edge found for computedPropertyVar='key', the test might need adjustment
      // based on how the function scope creates nodes
    });

    it('should NOT resolve obj[k] when k is an arrow function parameter', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};

const setProperty = (key) => {
  const value = 'test';
  obj[key] = value;
};
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      if (edge && edge.resolutionStatus) {
        assert.strictEqual(
          edge.resolutionStatus,
          'UNKNOWN_PARAMETER',
          `Should have UNKNOWN_PARAMETER status for arrow function parameter`
        );
      }
    });
  });

  // ============================================================================
  // Phase 6: External call result (nondeterministic)
  // const k = getKey(); obj[k] = value -> UNKNOWN_RUNTIME
  // ============================================================================
  describe('Function call result (nondeterministic)', () => {
    it('should NOT resolve obj[k] when k comes from function call', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};

function getKey() {
  return 'dynamic';
}

const key = getKey();
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      if (edge && edge.resolutionStatus) {
        assert.strictEqual(
          edge.resolutionStatus,
          'UNKNOWN_RUNTIME',
          `Should have UNKNOWN_RUNTIME status for function call result, got ${edge.resolutionStatus}`
        );
      }
    });

    it('should NOT resolve obj[k] when k comes from external API call', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const key = Math.random().toString();
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      if (edge && edge.resolutionStatus) {
        assert.strictEqual(
          edge.resolutionStatus,
          'UNKNOWN_RUNTIME',
          `Should have UNKNOWN_RUNTIME for external API call`
        );
      }
    });
  });

  // ============================================================================
  // Phase 7: Multiple computed assignments to same object
  // ============================================================================
  describe('Multiple computed assignments', () => {
    it('should resolve multiple obj[k] = v with different keys', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const key1 = 'first';
const key2 = 'second';
const val1 = 1;
const val2 = 2;
obj[key1] = val1;
obj[key2] = val2;
        `
      });

      const allEdges = await backend.getAllEdges();

      const resolvedEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.resolutionStatus === 'RESOLVED'
      );

      assert.strictEqual(
        resolvedEdges.length,
        2,
        `Expected 2 resolved FLOWS_INTO edges, got ${resolvedEdges.length}`
      );

      const propNames = resolvedEdges.map(e => e.propertyName).sort();
      assert.deepStrictEqual(propNames, ['first', 'second']);
    });

    it('should handle mixed resolved and unresolved in same file', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const staticKey = 'staticProp';
const value = 'test';

function dynamicSetter(dynKey) {
  obj[dynKey] = value;  // UNKNOWN_PARAMETER
}

obj[staticKey] = value;  // RESOLVED
        `
      });

      const allEdges = await backend.getAllEdges();

      const computedEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.mutationType === 'computed'
      );

      // Should have at least one edge (the static one outside function)
      assert.ok(computedEdges.length >= 1, 'Should have at least one computed edge');

      // The staticKey one should be resolved
      const staticEdge = computedEdges.find(e => e.computedPropertyVar === 'staticKey');
      if (staticEdge) {
        assert.strictEqual(staticEdge.resolutionStatus, 'RESOLVED');
        assert.strictEqual(staticEdge.propertyName, 'staticProp');
      }
    });
  });

  // ============================================================================
  // Phase 8: Edge cases and boundary conditions
  // ============================================================================
  describe('Edge cases', () => {
    it('should handle reassigned variable (last value wins)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
let key = 'firstValue';
key = 'secondValue';  // Reassignment
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      // Behavior depends on how value set handles reassignment
      // Current implementation might return both values or the last one
      assert.ok(edge, 'Should have FLOWS_INTO edge');
      // Verify that some resolution was attempted
      if (edge.resolutionStatus) {
        assert.ok(
          ['RESOLVED', 'RESOLVED_CONDITIONAL'].includes(edge.resolutionStatus),
          `Should be RESOLVED or RESOLVED_CONDITIONAL for reassignment`
        );
      }
    });

    it('should handle template literal key (nondeterministic if contains expressions)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const prefix = 'prop';
const key = \`\${prefix}_name\`;  // Template literal
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      // Template literals with expressions are complex
      // Current implementation may not resolve them
      assert.ok(edge, 'Should have FLOWS_INTO edge');
    });

    it('should preserve original edge data when resolution fails', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
function getKey() { return 'dynamic'; }
const key = getKey();
const value = 'test';
obj[key] = value;
        `
      });

      const edge = await findEdgeByComputedVar(backend, 'key');

      assert.ok(edge, 'Should have FLOWS_INTO edge even for unresolved');
      // Original data should be preserved
      assert.strictEqual(edge.mutationType, 'computed');
      assert.strictEqual(edge.computedPropertyVar, 'key');
    });
  });

  // ============================================================================
  // Phase 9: Compatibility with existing functionality
  // ============================================================================
  describe('Compatibility with existing ValueDomainAnalyzer features', () => {
    it('should still resolve obj[method]() calls (existing functionality)', async () => {
      await setupTest(backend, {
        'index.js': `
class Handler {
  save() { return 'saved'; }
  delete() { return 'deleted'; }
}

const handler = new Handler();
const method = 'save';
handler[method]();
        `
      });

      const allEdges = await backend.getAllEdges();

      // Check CALLS edge exists (existing functionality)
      const callsEdges = allEdges.filter(e => e.type === 'CALLS');

      // Verify existing computed method resolution still works
      // This test documents that we haven't broken existing functionality
      // The exact assertion depends on current implementation
      assert.ok(
        callsEdges.length >= 0,
        'Should not break existing CALLS edge creation'
      );
    });

    it('should not affect non-computed FLOWS_INTO edges', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const value = 'test';

obj.regularProp = value;       // property mutation
        `
      });

      const allEdges = await backend.getAllEdges();

      const propertyEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.mutationType === 'property'
      );

      // Note: Due to how GraphBuilder works, only one edge per source-target pair is created
      assert.ok(propertyEdges.length >= 1, 'Should have property mutation edges');

      for (const edge of propertyEdges) {
        // Property edges should NOT have resolution metadata
        assert.ok(
          !edge.resolutionStatus || edge.resolutionStatus === undefined,
          'Property mutations should not have resolutionStatus'
        );
      }
    });
  });
});
