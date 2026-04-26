# JOEL SPOLSKY'S TECHNICAL IMPLEMENTATION PLAN: REG-269

## Overview

Create a new `ClosureCaptureEnricher` plugin that runs during the ENRICHMENT phase to add CAPTURES edges for transitive closure captures (depth > 1). The plugin will:
1. Query all SCOPE nodes with `scopeType='closure'`
2. Walk the scope chain upward via `parentScopeId` pointers
3. Create CAPTURES edges with `metadata: { depth: N }` for variables in ancestor scopes

---

## Files to Create/Modify

### 1. NEW: `/packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts`
Main plugin implementation.

### 2. MODIFY: `/packages/core/src/index.ts`
Add export for the new plugin (line ~196).

### 3. MODIFY: `/packages/core/src/config/ConfigLoader.ts`
Add plugin to default enrichment list (line ~73).

### 4. NEW: `/test/unit/ClosureCaptureEnricher.test.js`
Unit tests for the plugin.

### 5. NEW (optional): `/test/fixtures/closure-captures/deep-capture.js`
Test fixture with 3+ level nested closures.

---

## Step-by-Step Implementation

### Phase 1: Plugin Skeleton

Create `/packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts`:

```typescript
/**
 * ClosureCaptureEnricher - tracks transitive closure captures
 *
 * Problem: CAPTURES edges only exist for immediate parent scope (depth=1).
 * Multi-level captures (grandparent, great-grandparent) are not tracked.
 *
 * Solution: Walk scope chains upward to find ALL captured variables,
 * creating CAPTURES edges with depth metadata.
 *
 * USES:
 * - SCOPE nodes with scopeType='closure'
 * - SCOPE.parentScopeId for scope chain navigation
 * - VARIABLE nodes with parentScopeId
 *
 * CREATES:
 * - SCOPE -> CAPTURES -> VARIABLE (with metadata: { depth: N })
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

interface ScopeNode extends NodeRecord {
  scopeType?: string;
  parentScopeId?: string;
  capturesFrom?: string;
}

interface VariableNode extends NodeRecord {
  parentScopeId?: string;
}

interface ScopeChainEntry {
  scopeId: string;
  depth: number;
}

export class ClosureCaptureEnricher extends Plugin {
  static MAX_DEPTH = 10;

  get metadata(): PluginMetadata {
    return {
      name: 'ClosureCaptureEnricher',
      phase: 'ENRICHMENT',
      priority: 40, // After ImportExportLinker (90), before MethodCallResolver (50)
      creates: {
        nodes: [],
        edges: ['CAPTURES']
      },
      dependencies: ['JSASTAnalyzer'] // Requires SCOPE and VARIABLE nodes
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting transitive capture resolution');

    let closuresProcessed = 0;
    let capturesCreated = 0;
    let existingCapturesSkipped = 0;

    // Step 1: Build scope index for fast lookup
    const scopeIndex = await this.buildScopeIndex(graph);
    logger.debug('Indexed scopes', { count: scopeIndex.size });

    // Step 2: Build variable index (scopeId -> variables)
    const variablesByScopeIndex = await this.buildVariablesByScopeIndex(graph);
    logger.debug('Indexed variables by scope', { scopes: variablesByScopeIndex.size });

    // Step 3: Find all closure scopes
    const closureScopes: ScopeNode[] = [];
    for await (const node of graph.queryNodes({ type: 'SCOPE' })) {
      const scope = node as ScopeNode;
      if (scope.scopeType === 'closure') {
        closureScopes.push(scope);
      }
    }

    logger.info('Found closure scopes', { count: closureScopes.length });

    // Step 4: Build existing CAPTURES edge set to avoid duplicates
    const existingCaptures = await this.buildExistingCapturesSet(graph);
    logger.debug('Existing CAPTURES edges', { count: existingCaptures.size });

    // Step 5: Process each closure
    for (const closure of closureScopes) {
      closuresProcessed++;

      // Progress reporting
      if (onProgress && closuresProcessed % 50 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'ClosureCaptureEnricher',
          message: `Processing closures ${closuresProcessed}/${closureScopes.length}`,
          totalFiles: closureScopes.length,
          processedFiles: closuresProcessed
        });
      }

      // Walk scope chain upward
      const ancestors = this.walkScopeChain(closure.id, scopeIndex);

      // For each ancestor scope (depth > 1), find variables and create edges
      for (const ancestor of ancestors) {
        if (ancestor.depth <= 1) continue; // Skip immediate parent (already handled)

        const variables = variablesByScopeIndex.get(ancestor.scopeId) || [];

        for (const variable of variables) {
          const edgeKey = `${closure.id}:${variable.id}`;

          if (existingCaptures.has(edgeKey)) {
            existingCapturesSkipped++;
            continue;
          }

          await graph.addEdge({
            src: closure.id,
            dst: variable.id,
            type: 'CAPTURES',
            metadata: { depth: ancestor.depth }
          });

          capturesCreated++;
          existingCaptures.add(edgeKey); // Track to avoid duplicates
        }
      }
    }

    const summary = {
      closuresProcessed,
      capturesCreated,
      existingCapturesSkipped,
      maxDepthReached: 0 // TODO: track this
    };

    logger.info('Summary', summary);

    return createSuccessResult({ nodes: 0, edges: capturesCreated }, summary);
  }

  /**
   * Build index: scopeId -> ScopeNode
   */
  private async buildScopeIndex(graph: PluginContext['graph']): Promise<Map<string, ScopeNode>> {
    const index = new Map<string, ScopeNode>();

    for await (const node of graph.queryNodes({ type: 'SCOPE' })) {
      index.set(node.id, node as ScopeNode);
    }

    return index;
  }

  /**
   * Build index: scopeId -> VariableNode[]
   */
  private async buildVariablesByScopeIndex(graph: PluginContext['graph']): Promise<Map<string, VariableNode[]>> {
    const index = new Map<string, VariableNode[]>();

    for await (const node of graph.queryNodes({ type: 'VARIABLE' })) {
      const variable = node as VariableNode;
      if (!variable.parentScopeId) continue;

      const vars = index.get(variable.parentScopeId) || [];
      vars.push(variable);
      index.set(variable.parentScopeId, vars);
    }

    // Also index CONSTANT nodes (const declarations)
    for await (const node of graph.queryNodes({ type: 'CONSTANT' })) {
      const constant = node as VariableNode;
      if (!constant.parentScopeId) continue;

      const vars = index.get(constant.parentScopeId) || [];
      vars.push(constant);
      index.set(constant.parentScopeId, vars);
    }

    return index;
  }

  /**
   * Build set of existing CAPTURES edges: "srcId:dstId"
   */
  private async buildExistingCapturesSet(graph: PluginContext['graph']): Promise<Set<string>> {
    const set = new Set<string>();

    // Query all SCOPE nodes and get their CAPTURES edges
    for await (const node of graph.queryNodes({ type: 'SCOPE' })) {
      const edges = await graph.getOutgoingEdges(node.id, ['CAPTURES']);
      for (const edge of edges) {
        set.add(`${edge.src}:${edge.dst}`);
      }
    }

    return set;
  }

  /**
   * Walk scope chain upward from startScopeId
   * Returns ancestor scopes with depth (1 = immediate parent, 2 = grandparent, etc.)
   */
  private walkScopeChain(
    startScopeId: string,
    scopeIndex: Map<string, ScopeNode>
  ): ScopeChainEntry[] {
    const result: ScopeChainEntry[] = [];
    const visited = new Set<string>();

    let currentScope = scopeIndex.get(startScopeId);
    if (!currentScope) return result;

    // Start walking from the closure's capturesFrom (immediate parent)
    let parentId = currentScope.capturesFrom || currentScope.parentScopeId;
    let depth = 1;

    while (parentId && depth <= ClosureCaptureEnricher.MAX_DEPTH) {
      // Cycle protection
      if (visited.has(parentId)) break;
      visited.add(parentId);

      result.push({ scopeId: parentId, depth });

      // Get parent scope
      const parentScope = scopeIndex.get(parentId);
      if (!parentScope) break;

      // Move up the chain
      parentId = parentScope.parentScopeId;
      depth++;
    }

    return result;
  }
}
```

### Phase 2: Register the Plugin

**Modify `/packages/core/src/index.ts`** (after line 195):
```typescript
export { ClosureCaptureEnricher } from './plugins/enrichment/ClosureCaptureEnricher.js';
```

**Modify `/packages/core/src/config/ConfigLoader.ts`** (line ~73):
```typescript
enrichment: [
  'MethodCallResolver',
  'ArgumentParameterLinker',
  'AliasTracker',
  'ClosureCaptureEnricher',  // ADD THIS LINE
  'ValueDomainAnalyzer',
  'MountPointResolver',
  'PrefixEvaluator',
  'ImportExportLinker',
  'HTTPConnectionEnricher',
],
```

### Phase 3: Unit Tests

Create `/test/unit/ClosureCaptureEnricher.test.js`:

```javascript
/**
 * ClosureCaptureEnricher Tests
 *
 * Tests for transitive closure capture resolution
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { RFDBServerBackend, ClosureCaptureEnricher } from '@grafema/core';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
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
      } finally {
        await backend.close();
      }
    });

    it('should handle 3-level deep capture (depth=3)', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        // outer -> inner -> deeper -> deepest
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

        const deeperEdges = await backend.getOutgoingEdges('scope-deeper', ['CAPTURES']);
        const deepestEdges = await backend.getOutgoingEdges('scope-deepest', ['CAPTURES']);

        assert.ok(deeperEdges.length >= 1, 'deeper should have CAPTURES edge');
        assert.ok(deepestEdges.length >= 1, 'deepest should have CAPTURES edge');
      } finally {
        await backend.close();
      }
    });

    it('should not create duplicate CAPTURES edges', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();

        await backend.addNodes([
          { id: 'scope-outer', type: 'SCOPE', scopeType: 'function', name: 'outer:body', file: 'test.js', line: 1 },
          { id: 'scope-inner', type: 'SCOPE', scopeType: 'closure', name: 'inner:body', file: 'test.js', line: 2, parentScopeId: 'scope-outer', capturesFrom: 'scope-outer' },
          { id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-outer' }
        ]);

        // Pre-existing edge (from JSASTAnalyzer)
        await backend.addEdge({ src: 'scope-inner', dst: 'var-x', type: 'CAPTURES' });
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // Should skip existing edge
        assert.strictEqual(result.metadata.existingCapturesSkipped, 1, 'Should skip 1 existing edge');

        // Run again - should not create duplicates
        const result2 = await enricher.execute({ graph: backend });
        assert.strictEqual(result2.metadata.capturesCreated, 0, 'Should not create duplicates on re-run');
      } finally {
        await backend.close();
      }
    });

    it('should respect MAX_DEPTH limit', async () => {
      const { backend } = await setupBackend();

      try {
        const enricher = new ClosureCaptureEnricher();
        const nodes = [];

        // Create 15 nested closures
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

        // Variable at root
        nodes.push({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'test.js', line: 1, parentScopeId: 'scope-0' });

        await backend.addNodes(nodes);
        await backend.flush();

        const result = await enricher.execute({ graph: backend });

        // MAX_DEPTH=10 means we should only create edges up to depth 10
        assert.ok(result.metadata.closuresProcessed > 0, 'Should process closures');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle scope without parentScopeId', async () => {
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
      } finally {
        await backend.close();
      }
    });

    it('should handle CONSTANT nodes same as VARIABLE', async () => {
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
  });
});
```

### Phase 4: Integration Test (Scenario Test)

Create `/test/fixtures/closure-captures/deep-capture.js`:

```javascript
// Deep closure capture test fixture
function outer() {
  const outerVar = 'outer';

  return function inner() {
    const innerVar = 'inner';

    return function deepest() {
      // Captures outerVar (depth=2) and innerVar (depth=1)
      return outerVar + innerVar;
    };
  };
}

module.exports = { outer };
```

---

## Order of Operations

1. **Phase 1 (Tests First - TDD)**
   - Create `/test/unit/ClosureCaptureEnricher.test.js` with test cases
   - Run tests - they should fail (plugin doesn't exist yet)

2. **Phase 2 (Plugin Implementation)**
   - Create `/packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts`
   - Run unit tests - iterate until passing

3. **Phase 3 (Registration)**
   - Add export to `/packages/core/src/index.ts`
   - Add to default plugins in `/packages/core/src/config/ConfigLoader.ts`
   - Run `npm run build` to verify compilation

4. **Phase 4 (Integration Testing)**
   - Create test fixture `/test/fixtures/closure-captures/deep-capture.js`
   - Run existing scenario tests to ensure no regressions
   - Add integration test for deep captures

5. **Phase 5 (Verification)**
   - Run full test suite: `npm test`
   - Manual test with real codebase using `grafema analyze`
   - Verify CAPTURES edges in graph query output

---

## Potential Challenges

1. **SCOPE node structure variability**
   - Some SCOPEs might have `capturesFrom`, others only `parentScopeId`
   - Solution: Check both fields in `walkScopeChain()`

2. **Edge metadata persistence**
   - RFDBServerBackend flattens metadata into edge attributes
   - Test that `depth` is preserved and queryable

3. **Performance on large codebases**
   - Many closures = many scope chain walks
   - Solution: Index building is O(N) nodes, then lookups are O(1)
   - Chain walks are O(depth) per closure, bounded by MAX_DEPTH

4. **Distinguishing depth=1 edges**
   - JSASTAnalyzer creates depth=1 CAPTURES edges without metadata
   - ClosureCaptureEnricher skips depth=1 to avoid duplicates
   - Future consideration: Update existing depth=1 edges with metadata

---

## Critical Files for Implementation

- `/packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts` - Main plugin
- `/packages/core/src/index.ts` - Plugin export registration
- `/packages/core/src/config/ConfigLoader.ts` - Add to default enrichment plugins
- `/packages/core/src/plugins/enrichment/AliasTracker.ts` - Pattern reference
- `/test/unit/ClosureCaptureEnricher.test.js` - Unit tests (TDD first)
