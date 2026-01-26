/**
 * ClosureCaptureEnricher Tests
 *
 * Tests for transitive closure capture resolution (REG-269)
 *
 * Problem: CAPTURES edges only exist for immediate parent scope (depth=1).
 * Multi-level captures (grandparent, great-grandparent) are not tracked.
 *
 * Solution: Walk scope chains upward to find ALL captured variables,
 * creating CAPTURES edges with depth metadata.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RFDBServerBackend, ClosureCaptureEnricher } from '@grafema/core';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ClosureCaptureEnricher', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `grafema-test-captures-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));
    writeFileSync(join(testDir, 'index.js'), '// Empty');

    const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
    await backend.connect();
    return { backend, testDir };
  }

  describe('Transitive captures', () => {
    it('should create CAPTURES edge with depth=2 for grandparent variable', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // Simulate: function outer() { const x = 1; function inner() { function deepest() { return x; } } }
        // outer -> inner -> deepest, variable x is in outer
        await backend.addNodes([
          // Scopes
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 3, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 4, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          // Variable x in outer scope
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 2, parentScopeId: 'scope-outer' }
        ]);

        // Existing edge: inner CAPTURES x (depth=1 from JSASTAnalyzer)
        await backend.addEdge({ src: 'scope-inner', dst: 'var-x', type: 'CAPTURES' });
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // Should create: deepest CAPTURES x with depth=2
        assert.strictEqual(result.metadata.capturesCreated, 1, 'Should create 1 new CAPTURES edge');

        const captureEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        assert.strictEqual(captureEdges.length, 1, 'Deepest should have 1 CAPTURES edge');
        assert.strictEqual(captureEdges[0].dst, 'var-x', 'Should capture var-x');

        // Verify depth metadata
        const edge = captureEdges[0];
        const depth = edge.depth ?? edge.metadata?.depth;
        assert.strictEqual(depth, 2, 'Should have depth=2 for grandparent capture');
      } finally {
        await backend.close();
      }
    });

    it('should handle 3-level deep capture (depth=3)', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // outer -> inner -> deeper -> deepest
        // Variable x is in outer, accessed by deepest (depth=3)
        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deeper', type: 'SCOPE', scopeType: 'closure', name: 'deeper:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 4, parentScopeId: 'scope-deeper', capturesFrom: 'scope-deeper' },
          // Variable in outer
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' }
        ]);

        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // deeper should capture x at depth=2
        const deeperEdges = await backend.getOutgoingEdges('scope-deeper', ['CAPTURES']);
        assert.ok(deeperEdges.length >= 1, 'deeper should have CAPTURES edge');
        const deeperDepth = deeperEdges[0].depth ?? deeperEdges[0].metadata?.depth;
        assert.strictEqual(deeperDepth, 2, 'deeper should capture at depth=2');

        // deepest should capture x at depth=3
        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        assert.ok(deepestEdges.length >= 1, 'deepest should have CAPTURES edge');
        const deepestDepth = deepestEdges[0].depth ?? deepestEdges[0].metadata?.depth;
        assert.strictEqual(deepestDepth, 3, 'deepest should capture at depth=3');
      } finally {
        await backend.close();
      }
    });

    it('should create edges for multiple variables at same depth', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // outer has x and y, inner captures both, deepest should capture both at depth=2
        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 3, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 5, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 2, parentScopeId: 'scope-outer' },
          { id: 'var-y', type: 'VARIABLE', name: 'y', file: 'test.js', line: 2, parentScopeId: 'scope-outer' }
        ]);

        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        assert.strictEqual(deepestEdges.length, 2, 'Deepest should capture both x and y');

        const capturedVars = deepestEdges.map(e => e.dst).sort();
        assert.deepStrictEqual(capturedVars, ['var-x', 'var-y'], 'Should capture both variables');
      } finally {
        await backend.close();
      }
    });
  });

  describe('No duplicates', () => {
    it('should not create duplicate CAPTURES edges', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // Setup: outer -> inner -> deepest (3 levels needed for depth=2 capture)
        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' }
        ]);

        // Pre-existing depth=2 edge (deepest -> var-x)
        // Simulate as if enricher already ran once
        await backend.addEdge({ src: 'scope-deepest', dst: 'var-x', type: 'CAPTURES', metadata: { depth: 2 } });
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // Should skip existing depth=2 edge from scope-deepest to var-x
        assert.strictEqual(result.metadata.existingCapturesSkipped, 1, 'Should skip 1 existing edge');
        assert.strictEqual(result.metadata.capturesCreated, 0, 'Should create 0 new edges');

        // Run again - should not create duplicates
        const result2 = await enricher.execute({ graph: backend });
        assert.strictEqual(result2.metadata.capturesCreated, 0, 'Should not create duplicates on re-run');
      } finally {
        await backend.close();
      }
    });

    it('should track edges across multiple enrichment runs', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' }
        ]);
        await backend.flush();

        // First run creates edges
        const result1 = await enricher.execute({ graph: backend });
        const edgesAfterRun1 = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);

        // Second run should find all edges as existing
        const result2 = await enricher.execute({ graph: backend });
        const edgesAfterRun2 = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);

        assert.strictEqual(edgesAfterRun1.length, edgesAfterRun2.length,
          'Edge count should not increase on re-run');
        assert.strictEqual(result2.metadata.capturesCreated, 0,
          'Should create no new edges on re-run');
      } finally {
        await backend.close();
      }
    });
  });

  describe('MAX_DEPTH limit', () => {
    it('should respect MAX_DEPTH limit (10)', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();
        const nodes = [];

        // Create 15 nested closures (exceeds MAX_DEPTH=10)
        for (let i = 0; i < 15; i++) {
          nodes.push({
            id: `scope-${i}`,
            type: 'SCOPE',
            scopeType: i === 0 ? 'function' : 'closure',
            name: `func${i}:body`,
            file: 'test.js',
            line: i + 1,
            parentScopeId: i > 0 ? `scope-${i - 1}` : undefined,
            capturesFrom: i > 0 ? `scope-${i - 1}` : undefined
          });
        }

        // Variable at root scope (scope-0)
        nodes.push({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-0' });

        await backend.addNodes(nodes);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // MAX_DEPTH=10 means we should only create edges up to depth 10
        assert.ok(result.metadata.closuresProcessed > 0, 'Should process closures');

        // Closure at depth 11+ should NOT capture x (would require depth > 10)
        // scope-11 is at depth 11 from scope-0
        const scope11Edges = await backend.getOutgoingEdges('scope-11', ['CAPTURES']);
        const hasXCapture = scope11Edges.some(e => e.dst === 'var-x');

        // x is in scope-0, scope-11 needs depth=11 to reach it, which exceeds MAX_DEPTH
        // So scope-11 should NOT have a CAPTURES edge to var-x
        assert.ok(!hasXCapture || (scope11Edges[0]?.depth ?? scope11Edges[0]?.metadata?.depth) <= 10,
          'Should not create edges beyond MAX_DEPTH');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle scope without parentScopeId (orphan scope)', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'scope-orphan', type: 'SCOPE', scopeType: 'closure', name: 'orphan:body', file: 'test.js', line: 1 }
          // No parentScopeId, no capturesFrom
        ]);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // Should not crash, should create 0 edges
        assert.strictEqual(result.metadata.capturesCreated, 0, 'Should handle orphan scope gracefully');
        assert.ok(result.metadata.closuresProcessed >= 1, 'Should process the orphan closure');
      } finally {
        await backend.close();
      }
    });

    it('should handle closure with no variables in ancestor scopes', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' }
          // No variables in scope-outer
        ]);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.metadata.capturesCreated, 0, 'Should create no edges when no variables exist');
      } finally {
        await backend.close();
      }
    });

    it('should handle cycle in scope chain (cycle protection)', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // Create a cycle: scope-a -> scope-b -> scope-a (invalid but should not crash)
        await backend.addNodes([
          { id: 'scope-a', type: 'SCOPE', scopeType: 'closure', name: 'a:body', file: 'test.js', line: 1, parentScopeId: 'scope-b', capturesFrom: 'scope-b' },
          { id: 'scope-b', type: 'SCOPE', scopeType: 'closure', name: 'b:body', file: 'test.js', line: 2, parentScopeId: 'scope-a', capturesFrom: 'scope-a' },
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-a' }
        ]);
        await backend.flush();

        // Should not hang or crash due to cycle protection
        const result = await enricher.execute({ graph: backend });

        assert.ok(result, 'Should not crash on cycle');
      } finally {
        await backend.close();
      }
    });
  });

  describe('CONSTANT nodes', () => {
    it('should capture CONSTANT nodes same as VARIABLE', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          // CONSTANT (const x = ...) in outer scope
          { id: 'const-x', type: 'CONSTANT', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' }
        ]);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // Should capture CONSTANT same as VARIABLE
        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        assert.ok(deepestEdges.some(e => e.dst === 'const-x'), 'Should capture CONSTANT nodes');
      } finally {
        await backend.close();
      }
    });

    it('should capture both VARIABLE and CONSTANT in same scope', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 3, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 5, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          // Mix of VARIABLE and CONSTANT
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' },
          { id: 'const-y', type: 'CONSTANT', name: 'y', file: 'test.js', line: 2, parentScopeId: 'scope-outer' }
        ]);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        const capturedIds = deepestEdges.map(e => e.dst).sort();
        assert.deepStrictEqual(capturedIds, ['const-y', 'var-x'], 'Should capture both VARIABLE and CONSTANT');
      } finally {
        await backend.close();
      }
    });
  });

  describe('PARAMETER nodes', () => {
    it('should capture PARAMETER nodes from ancestor function scopes', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // function outer(x) { function inner() { function deepest() { return x; } } }
        // PARAMETER x belongs to FUNCTION outer via parentFunctionId
        // FUNCTION outer HAS_SCOPE scope-outer
        await backend.addNodes([
          // Function with parameter
          { id: 'func-outer', type: 'FUNCTION', name: 'outer', file: 'test.js', line: 1 },
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'param-x', type: 'PARAMETER', name: 'x', file: 'test.js', line: 1, parentFunctionId: 'func-outer' },
          // Nested closures
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' }
        ]);

        // Link function to scope
        await backend.addEdge({ src: 'func-outer', dst: 'scope-outer', type: 'HAS_SCOPE' });
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // deepest should capture param-x at depth=2
        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        assert.ok(deepestEdges.some(e => e.dst === 'param-x'), 'Should capture PARAMETER nodes');

        // Verify depth
        const paramEdge = deepestEdges.find(e => e.dst === 'param-x');
        const depth = paramEdge?.depth ?? paramEdge?.metadata?.depth;
        assert.strictEqual(depth, 2, 'Should capture parameter at correct depth');
      } finally {
        await backend.close();
      }
    });

    it('should handle multiple parameters in outer function', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'func-outer', type: 'FUNCTION', name: 'outer', file: 'test.js', line: 1 },
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'param-a', type: 'PARAMETER', name: 'a', file: 'test.js', line: 1, parentFunctionId: 'func-outer' },
          { id: 'param-b', type: 'PARAMETER', name: 'b', file: 'test.js', line: 1, parentFunctionId: 'func-outer' },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' }
        ]);

        await backend.addEdge({ src: 'func-outer', dst: 'scope-outer', type: 'HAS_SCOPE' });
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        const capturedParams = deepestEdges.filter(e => e.dst.startsWith('param-'));
        assert.strictEqual(capturedParams.length, 2, 'Should capture both parameters');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Control flow scopes', () => {
    it('should handle if/for/while scopes in the chain', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // function outer() { const x = 1; if (cond) { function inner() { function deepest() { return x; } } } }
        // Chain: outer -> if-scope -> inner -> deepest
        // x is in outer, deepest needs depth=3 to reach it
        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-if', type: 'SCOPE', scopeType: 'block', name: 'if:2', file: 'test.js', line: 2, parentScopeId: 'scope-outer' },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 3, parentScopeId: 'scope-if', capturesFrom: 'scope-if' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 4, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' }
        ]);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // deepest should capture x
        // Depth calculation: deepest -> inner -> if -> outer = depth 3
        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        assert.ok(deepestEdges.some(e => e.dst === 'var-x'), 'Should capture variable through control flow scopes');

        const xEdge = deepestEdges.find(e => e.dst === 'var-x');
        const depth = xEdge?.depth ?? xEdge?.metadata?.depth;
        assert.strictEqual(depth, 3, 'Depth should count all scopes including control flow');
      } finally {
        await backend.close();
      }
    });

    it('should capture variables from intermediate control flow scope', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // Variable y is in if-scope, not outer
        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-if', type: 'SCOPE', scopeType: 'block', name: 'if:2', file: 'test.js', line: 2, parentScopeId: 'scope-outer' },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 3, parentScopeId: 'scope-if', capturesFrom: 'scope-if' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 4, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          // y is in the if-scope
          { id: 'var-y', type: 'VARIABLE', name: 'y', file: 'test.js', line: 2, parentScopeId: 'scope-if' }
        ]);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // deepest should capture y at depth=2 (deepest -> inner -> if)
        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);
        assert.ok(deepestEdges.some(e => e.dst === 'var-y'), 'Should capture variable from control flow scope');

        const yEdge = deepestEdges.find(e => e.dst === 'var-y');
        const depth = yEdge?.depth ?? yEdge?.metadata?.depth;
        assert.strictEqual(depth, 2, 'Depth should be 2 for variable in immediate parent of inner');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Plugin metadata', () => {
    it('should have correct plugin metadata', async () => {
      const enricher = new ClosureCaptureEnricher();
      const metadata = enricher.metadata;

      assert.strictEqual(metadata.name, 'ClosureCaptureEnricher', 'Should have correct name');
      assert.strictEqual(metadata.phase, 'ENRICHMENT', 'Should be in ENRICHMENT phase');
      assert.ok(metadata.creates.edges.includes('CAPTURES'), 'Should declare CAPTURES edge creation');
      assert.ok(metadata.dependencies.includes('JSASTAnalyzer'), 'Should depend on JSASTAnalyzer');
    });
  });

  describe('Result reporting', () => {
    it('should report correct counts in result metadata', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'scope-deepest', type: 'SCOPE', scopeType: 'closure', name: 'deepest:body', file: 'test.js', line: 3, parentScopeId: 'scope-inner', capturesFrom: 'scope-inner' },
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' }
        ]);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // Check result structure
        assert.ok(result.metadata !== undefined, 'Should have metadata');
        assert.ok(typeof result.metadata.closuresProcessed === 'number', 'Should report closuresProcessed');
        assert.ok(typeof result.metadata.capturesCreated === 'number', 'Should report capturesCreated');
        assert.ok(typeof result.metadata.existingCapturesSkipped === 'number', 'Should report existingCapturesSkipped');

        // Verify counts
        assert.strictEqual(result.metadata.closuresProcessed, 2, 'Should process 2 closures (inner and deepest)');
        assert.ok(result.metadata.capturesCreated > 0, 'Should create at least one edge');
      } finally {
        await backend.close();
      }
    });
  });
});
