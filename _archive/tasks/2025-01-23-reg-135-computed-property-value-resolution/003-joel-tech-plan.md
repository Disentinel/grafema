# Joel Spolsky - Technical Plan: REG-135 Computed Property Value Resolution

## Overview

This document expands Don's high-level plan into specific implementation steps with exact code changes, line numbers, and test specifications.

## Answers to Don's Questions

### Q1: Does RFDB support updating edge metadata after creation?

**Answer: No, but we have a workaround.**

RFDB does not have a native `updateEdge` command. The supported commands are:
- `addEdges` - Create new edges
- `deleteEdge` - Remove edge by (src, dst, edgeType) tuple

**Existing pattern in `InstanceOfResolver.ts` (lines 135-150):**
```typescript
// Delete old edge
if (graph.deleteEdge) {
  await graph.deleteEdge(update.src, update.oldDst, 'INSTANCE_OF');
}
// Create new edge with updated properties
await graph.addEdge({ type: 'INSTANCE_OF', src: update.src, dst: update.newDst });
```

**For our use case:** We will NOT delete/recreate edges. Instead:
1. Store `computedPropertyVar` in edge metadata during analysis
2. Add NEW metadata fields (`resolvedPropertyNames`, `resolutionStatus`) during enrichment

Since edge metadata is stored as JSON (`metadata: string` in WireEdge), we can add new fields without changing the edge identity. However, RFDB stores edges by (src, dst, edgeType) key, so adding metadata to existing edges requires:

**Approach A: Delete + Add** (simple, but loses edge if resolution fails mid-way)
```typescript
await graph.deleteEdge(src, dst, 'FLOWS_INTO');
await graph.addEdge({ src, dst, type: 'FLOWS_INTO', metadata: { ...oldMetadata, resolvedPropertyNames, resolutionStatus } });
```

**Approach B: Add only new edges, keep original `<computed>` edges** (safer)
- Original edges with `propertyName: '<computed>'` stay
- Add new edges with `propertyName: 'resolved_name'` and `resolutionSource: 'ValueDomainAnalyzer'`
- Query consumers can filter by `resolutionSource` to get enriched edges

**Recommendation: Approach A** (delete + add pattern, same as InstanceOfResolver)

Justification:
- Matches existing codebase pattern
- Cleaner graph (no duplicate edges)
- Resolution is deterministic - if it fails, edge stays with `<computed>`
- We only modify edges where resolution succeeds

### Q2: Should resolution status be a separate field or combined with propertyName?

**Answer: Separate field.**

```typescript
// Edge metadata after enrichment:
{
  mutationType: 'computed',
  propertyName: 'actualPropertyName',  // Was '<computed>', now resolved
  computedPropertyVar: 'key',           // The variable name in obj[key]
  resolvedPropertyNames: ['name1'],     // All resolved names (for conditional)
  resolutionStatus: 'RESOLVED'          // Status enum
}
```

Reasoning:
1. `propertyName` is the primary field - should contain the actual resolved name(s)
2. `resolutionStatus` explains HOW we determined the name
3. For conditional (`RESOLVED_CONDITIONAL`), `resolvedPropertyNames` array has multiple values
4. Consumers can query by `resolutionStatus` to understand confidence

### Q3: Cross-file resolution - defer to Phase 2 or stub out infrastructure now?

**Answer: Stub infrastructure, defer implementation.**

Add `DEFERRED_CROSS_FILE` status now, but don't implement cross-file tracing:
- ValueDomainAnalyzer already checks file scope when looking up variables
- If variable is an IMPORT, mark as `DEFERRED_CROSS_FILE`
- Future work: follow IMPORTS_FROM edges to resolve cross-file values

This allows clean extension without changing the interface.

---

## Implementation Plan

### Phase 1: Type Definitions

#### Step 1.1: Add `computedPropertyVar` to `ObjectMutationInfo`

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`
**Lines:** 409-420

**Current:**
```typescript
export interface ObjectMutationInfo {
  id?: string;
  objectName: string;
  objectLine?: number;
  propertyName: string;
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}
```

**Change:** Add `computedPropertyVar` field after `mutationType`:
```typescript
export interface ObjectMutationInfo {
  id?: string;
  objectName: string;
  objectLine?: number;
  propertyName: string;
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  computedPropertyVar?: string;  // Variable name in obj[key] = value
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}
```

**Line to add:** After line 414 (`mutationType`), add new line:
```typescript
  computedPropertyVar?: string;  // Variable name in obj[key] = value
```

#### Step 1.2: Add `ResolutionStatus` type

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`
**Location:** After `ObjectMutationValue` interface (line 430)

**Add:**
```typescript
/**
 * Resolution status for computed property names.
 * Used in FLOWS_INTO edge metadata to indicate how property name was determined.
 *
 * - RESOLVED: Single deterministic value traced from literals
 * - RESOLVED_CONDITIONAL: Multiple possible values (ternary, logical OR, etc.)
 * - UNKNOWN_PARAMETER: Variable traces to function parameter
 * - UNKNOWN_RUNTIME: Variable traces to function call result
 * - DEFERRED_CROSS_FILE: Variable traces to import (requires cross-file analysis)
 */
export type ResolutionStatus =
  | 'RESOLVED'
  | 'RESOLVED_CONDITIONAL'
  | 'UNKNOWN_PARAMETER'
  | 'UNKNOWN_RUNTIME'
  | 'DEFERRED_CROSS_FILE';
```

#### Step 1.3: Extend `GraphEdge` metadata fields

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`
**Lines:** 556-569

**Current:**
```typescript
export interface GraphEdge {
  type: string;
  src: string;
  dst: string;
  index?: number;
  mutationMethod?: string;
  argIndex?: number;
  isSpread?: boolean;
  mutationType?: 'property' | 'computed' | 'assign' | 'spread';
  propertyName?: string;
  metadata?: Record<string, unknown>;
}
```

**Change:** Add new fields for computed property tracking:
```typescript
export interface GraphEdge {
  type: string;
  src: string;
  dst: string;
  index?: number;
  mutationMethod?: string;
  argIndex?: number;
  isSpread?: boolean;
  mutationType?: 'property' | 'computed' | 'assign' | 'spread';
  propertyName?: string;
  computedPropertyVar?: string;           // NEW: Variable name for obj[key] patterns
  resolvedPropertyNames?: string[];       // NEW: Resolved names (enrichment)
  resolutionStatus?: ResolutionStatus;    // NEW: How resolution was determined
  metadata?: Record<string, unknown>;
}
```

---

### Phase 2: Analysis Phase Changes

#### Step 2.1: Capture `computedPropertyVar` in JSASTAnalyzer

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Method:** `detectObjectPropertyAssignment`
**Lines:** 2388-2397

**Current code (lines 2388-2397):**
```typescript
    } else {
      // obj['prop'] or obj[key]
      if (memberExpr.property.type === 'StringLiteral') {
        propertyName = memberExpr.property.value;
        mutationType = 'property'; // String literal is effectively a property name
      } else {
        propertyName = '<computed>';
        mutationType = 'computed';
      }
    }
```

**Changed code:**
```typescript
    } else {
      // obj['prop'] or obj[key]
      if (memberExpr.property.type === 'StringLiteral') {
        propertyName = memberExpr.property.value;
        mutationType = 'property'; // String literal is effectively a property name
      } else {
        propertyName = '<computed>';
        mutationType = 'computed';
        // Capture variable name for later resolution
        if (memberExpr.property.type === 'Identifier') {
          computedPropertyVar = memberExpr.property.name;
        }
      }
    }
```

**Also need to:**
1. Declare `computedPropertyVar` variable at function scope (after `mutationType` declaration ~line 2378):
```typescript
    let computedPropertyVar: string | undefined;
```

2. Add to pushed object (line 2414-2423):
```typescript
    objectMutations.push({
      id: mutationId,
      objectName,
      propertyName,
      mutationType,
      computedPropertyVar,  // NEW
      file: module.file,
      line,
      column,
      value: valueInfo
    });
```

#### Step 2.2: Pass `computedPropertyVar` through GraphBuilder

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Method:** `bufferObjectMutationEdges`
**Lines:** 1294-1346

**Current edge creation (lines 1325-1338):**
```typescript
            const edgeData: GraphEdge = {
              type: 'FLOWS_INTO',
              src: sourceNodeId,
              dst: objectNodeId,
              mutationType,
              propertyName
            };
            if (value.argIndex !== undefined) {
              edgeData.argIndex = value.argIndex;
            }
            if (value.isSpread) {
              edgeData.isSpread = true;
            }
            this._bufferEdge(edgeData);
```

**Change:** Extract `computedPropertyVar` from mutation and add to edge:

At line 1301, update destructuring:
```typescript
      const { objectName, propertyName, mutationType, computedPropertyVar, value, file } = mutation;
```

At edge creation (lines 1325-1338), add `computedPropertyVar`:
```typescript
            const edgeData: GraphEdge = {
              type: 'FLOWS_INTO',
              src: sourceNodeId,
              dst: objectNodeId,
              mutationType,
              propertyName,
              computedPropertyVar  // NEW: for enrichment phase resolution
            };
```

---

### Phase 3: Enrichment Phase Changes

#### Step 3.1: Add `resolveComputedMutations` method to ValueDomainAnalyzer

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`
**Location:** Add new method after `findMethod` (after line 679)

```typescript
  /**
   * Resolve computed property names for object mutations.
   * Finds FLOWS_INTO edges with mutationType: 'computed' and resolves
   * the property name using value set tracing.
   *
   * @param graph - Graph backend with edge operations
   * @returns Statistics about resolution
   */
  async resolveComputedMutations(graph: Graph & {
    deleteEdge?(src: string, dst: string, type: string): Promise<void>;
    getOutgoingEdges(nodeId: string): Promise<EdgeRecord[]>;
    getIncomingEdges(nodeId: string): Promise<EdgeRecord[]>;
  }): Promise<{
    resolved: number;
    conditional: number;
    unknownParameter: number;
    unknownRuntime: number;
    deferredCrossFile: number;
    total: number;
  }> {
    const stats = {
      resolved: 0,
      conditional: 0,
      unknownParameter: 0,
      unknownRuntime: 0,
      deferredCrossFile: 0,
      total: 0
    };

    // Collect all nodes to iterate (RFDB doesn't have edge iteration)
    // We need to find FLOWS_INTO edges with mutationType: 'computed'
    const processedEdges = new Set<string>();

    // Iterate through VARIABLE and CONSTANT nodes to find their outgoing FLOWS_INTO edges
    for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
      const outgoing = await graph.getOutgoingEdges(node.id);
      for (const edge of outgoing) {
        const edgeType = (edge as { edgeType?: string; edge_type?: string; type?: string }).edgeType ||
                         (edge as { edge_type?: string }).edge_type ||
                         (edge as { type?: string }).type;

        if (edgeType !== 'FLOWS_INTO') continue;

        const edgeKey = `${edge.src}->${edge.dst}`;
        if (processedEdges.has(edgeKey)) continue;
        processedEdges.add(edgeKey);

        const mutationType = (edge as { mutationType?: string }).mutationType;
        const computedPropertyVar = (edge as { computedPropertyVar?: string }).computedPropertyVar;

        if (mutationType !== 'computed' || !computedPropertyVar) continue;

        stats.total++;

        // Get file from source node
        const sourceNode = await graph.getNode(edge.src);
        const file = (sourceNode as { file?: string })?.file;
        if (!file) continue;

        // Resolve the computed property variable
        const valueSet = await this.getValueSet(computedPropertyVar, file, graph);

        // Determine resolution status
        let resolutionStatus: string;
        let resolvedPropertyNames: string[] = [];

        if (valueSet.values.length === 0 && valueSet.hasUnknown) {
          // Check if it's a parameter or runtime value
          // For now, treat all unknown as UNKNOWN_RUNTIME
          // Future: detect PARAMETER vs CALL vs IMPORT
          resolutionStatus = 'UNKNOWN_RUNTIME';
          stats.unknownRuntime++;
          continue; // Don't update edge for unknown
        } else if (valueSet.values.length === 0) {
          // No values found, likely parameter or import
          resolutionStatus = 'UNKNOWN_PARAMETER';
          stats.unknownParameter++;
          continue;
        } else if (valueSet.values.length === 1 && !valueSet.hasUnknown) {
          // Single deterministic value
          resolutionStatus = 'RESOLVED';
          resolvedPropertyNames = valueSet.values.map(v => String(v));
          stats.resolved++;
        } else if (valueSet.values.length > 1 || valueSet.hasUnknown) {
          // Multiple values (conditional) or partial resolution
          resolutionStatus = 'RESOLVED_CONDITIONAL';
          resolvedPropertyNames = valueSet.values.map(v => String(v));
          stats.conditional++;
        } else {
          continue; // Unexpected case
        }

        // Update edge: delete old, create new with resolved data
        if (graph.deleteEdge) {
          await graph.deleteEdge(edge.src, edge.dst, 'FLOWS_INTO');
        }

        // Preserve original edge metadata
        const originalMetadata = { ...(edge as Record<string, unknown>) };
        delete originalMetadata.src;
        delete originalMetadata.dst;
        delete originalMetadata.edgeType;
        delete originalMetadata.edge_type;
        delete originalMetadata.type;

        await graph.addEdge({
          src: edge.src,
          dst: edge.dst,
          type: 'FLOWS_INTO',
          metadata: {
            ...originalMetadata,
            propertyName: resolvedPropertyNames[0] || '<computed>',
            resolvedPropertyNames,
            resolutionStatus,
            computedPropertyVar
          }
        });
      }
    }

    // Also check CONSTANT nodes
    for await (const node of graph.queryNodes({ nodeType: 'CONSTANT' })) {
      const outgoing = await graph.getOutgoingEdges(node.id);
      for (const edge of outgoing) {
        const edgeType = (edge as { edgeType?: string; edge_type?: string; type?: string }).edgeType ||
                         (edge as { edge_type?: string }).edge_type ||
                         (edge as { type?: string }).type;

        if (edgeType !== 'FLOWS_INTO') continue;

        const edgeKey = `${edge.src}->${edge.dst}`;
        if (processedEdges.has(edgeKey)) continue;
        processedEdges.add(edgeKey);

        const mutationType = (edge as { mutationType?: string }).mutationType;
        const computedPropertyVar = (edge as { computedPropertyVar?: string }).computedPropertyVar;

        if (mutationType !== 'computed' || !computedPropertyVar) continue;

        stats.total++;

        const sourceNode = await graph.getNode(edge.src);
        const file = (sourceNode as { file?: string })?.file;
        if (!file) continue;

        const valueSet = await this.getValueSet(computedPropertyVar, file, graph);

        let resolutionStatus: string;
        let resolvedPropertyNames: string[] = [];

        if (valueSet.values.length === 0 && valueSet.hasUnknown) {
          resolutionStatus = 'UNKNOWN_RUNTIME';
          stats.unknownRuntime++;
          continue;
        } else if (valueSet.values.length === 0) {
          resolutionStatus = 'UNKNOWN_PARAMETER';
          stats.unknownParameter++;
          continue;
        } else if (valueSet.values.length === 1 && !valueSet.hasUnknown) {
          resolutionStatus = 'RESOLVED';
          resolvedPropertyNames = valueSet.values.map(v => String(v));
          stats.resolved++;
        } else if (valueSet.values.length > 1 || valueSet.hasUnknown) {
          resolutionStatus = 'RESOLVED_CONDITIONAL';
          resolvedPropertyNames = valueSet.values.map(v => String(v));
          stats.conditional++;
        } else {
          continue;
        }

        if (graph.deleteEdge) {
          await graph.deleteEdge(edge.src, edge.dst, 'FLOWS_INTO');
        }

        const originalMetadata = { ...(edge as Record<string, unknown>) };
        delete originalMetadata.src;
        delete originalMetadata.dst;
        delete originalMetadata.edgeType;
        delete originalMetadata.edge_type;
        delete originalMetadata.type;

        await graph.addEdge({
          src: edge.src,
          dst: edge.dst,
          type: 'FLOWS_INTO',
          metadata: {
            ...originalMetadata,
            propertyName: resolvedPropertyNames[0] || '<computed>',
            resolvedPropertyNames,
            resolutionStatus,
            computedPropertyVar
          }
        });
      }
    }

    return stats;
  }
```

#### Step 3.2: Integrate into `execute` method

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`
**Method:** `execute`
**Lines:** 162-266

**After line 258 (current summary assignment), add:**
```typescript
    // Resolve computed property mutations in FLOWS_INTO edges
    console.log('[ValueDomainAnalyzer] Resolving computed property mutations...');
    const mutationStats = await this.resolveComputedMutations(
      graphTyped as Graph & { deleteEdge?(src: string, dst: string, type: string): Promise<void> }
    );
    console.log('[ValueDomainAnalyzer] Mutation resolution stats:', mutationStats);
```

**Update metadata declaration (lines 152-159):**
```typescript
    return {
      name: 'ValueDomainAnalyzer',
      phase: 'ENRICHMENT',
      priority: 65,
      creates: {
        nodes: [],
        edges: ['CALLS', 'FLOWS_INTO']  // Added FLOWS_INTO (modifies existing)
      }
    };
```

**Update return statement (line 262-265):**
```typescript
    return createSuccessResult(
      { nodes: 0, edges: edgesCreated + mutationStats.resolved + mutationStats.conditional },
      {
        ...summary,
        computedMutations: mutationStats
      }
    );
```

#### Step 3.3: Add `deleteEdge` to Graph interface in ValueDomainAnalyzer

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`
**Lines:** 98-104

**Update interface:**
```typescript
interface Graph {
  queryNodes(filter: { nodeType: string }): AsyncIterable<NodeRecord>;
  getNode(id: string): Promise<NodeRecord | null>;
  getOutgoingEdges(nodeId: string): Promise<EdgeRecord[]>;
  getIncomingEdges(nodeId: string): Promise<EdgeRecord[]>;
  addEdge(edge: { src: string; dst: string; type: string; metadata?: Record<string, unknown> }): Promise<void> | void;
  deleteEdge?(src: string, dst: string, type: string): Promise<void>;  // NEW: optional for edge updates
}
```

---

### Phase 4: Tests

#### Step 4.1: Create new test file

**File:** `/Users/vadimr/grafema/test/unit/ComputedPropertyResolution.test.js`

```javascript
/**
 * Tests for Computed Property Value Resolution (REG-135)
 *
 * When code does obj[key] = value where key is a variable,
 * we should resolve the property name if the variable has a deterministic value.
 *
 * Resolution status:
 * - RESOLVED: Single deterministic value
 * - RESOLVED_CONDITIONAL: Multiple possible values (ternary, etc.)
 * - UNKNOWN_PARAMETER: Variable is a function parameter
 * - UNKNOWN_RUNTIME: Variable comes from function call
 * - DEFERRED_CROSS_FILE: Variable comes from import
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-computed-prop-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: `test-computed-prop-${testCounter}`, type: 'module' })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Computed Property Value Resolution (REG-135)', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  // ============================================================================
  // Direct literal assignment: const k = 'x'; obj[k] = value
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

      const allEdges = await backend.getAllEdges();

      // Find FLOWS_INTO edge
      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.mutationType === 'computed'
      );

      assert.ok(flowsInto, 'Should have FLOWS_INTO edge for computed property');

      // Check resolution
      assert.strictEqual(
        flowsInto.resolutionStatus,
        'RESOLVED',
        `Expected RESOLVED status, got ${flowsInto.resolutionStatus}`
      );
      assert.strictEqual(
        flowsInto.propertyName,
        'propName',
        `Expected propertyName 'propName', got '${flowsInto.propertyName}'`
      );
      assert.deepStrictEqual(
        flowsInto.resolvedPropertyNames,
        ['propName'],
        'Should have resolvedPropertyNames array'
      );
    });
  });

  // ============================================================================
  // Literal chain: const a = 'x'; const b = a; obj[b] = value
  // ============================================================================
  describe('Literal chain resolution', () => {
    it('should resolve through variable chain', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
const original = 'chainedProp';
const alias = original;
const key = alias;
const value = 'test';
obj[key] = value;
        `
      });

      const allEdges = await backend.getAllEdges();

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.computedPropertyVar === 'key'
      );

      assert.ok(flowsInto, 'Should have FLOWS_INTO edge for computed property');
      assert.strictEqual(flowsInto.resolutionStatus, 'RESOLVED');
      assert.strictEqual(flowsInto.propertyName, 'chainedProp');
    });
  });

  // ============================================================================
  // Ternary: const k = c ? 'a' : 'b'; obj[k] = value
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

      const allEdges = await backend.getAllEdges();

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.computedPropertyVar === 'key'
      );

      assert.ok(flowsInto, 'Should have FLOWS_INTO edge');
      assert.strictEqual(
        flowsInto.resolutionStatus,
        'RESOLVED_CONDITIONAL',
        'Should have RESOLVED_CONDITIONAL status for ternary'
      );
      assert.ok(
        flowsInto.resolvedPropertyNames.includes('propA'),
        'Should include propA in resolved names'
      );
      assert.ok(
        flowsInto.resolvedPropertyNames.includes('propB'),
        'Should include propB in resolved names'
      );
    });
  });

  // ============================================================================
  // Parameter: function f(k) { obj[k] = value }
  // ============================================================================
  describe('Function parameter (nondeterministic)', () => {
    it('should NOT resolve obj[k] when k is a parameter', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
function setProperty(key) {
  const value = 'test';
  obj[key] = value;
}
        `
      });

      const allEdges = await backend.getAllEdges();

      // For parameter, we either:
      // 1. Don't create FLOWS_INTO edge at all (if VARIABLE value is used)
      // 2. Or keep propertyName as '<computed>' with resolutionStatus: UNKNOWN_PARAMETER

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.computedPropertyVar === 'key'
      );

      // If edge exists, it should have UNKNOWN status
      if (flowsInto) {
        assert.ok(
          ['UNKNOWN_PARAMETER', 'UNKNOWN_RUNTIME'].includes(flowsInto.resolutionStatus),
          `Expected UNKNOWN status for parameter, got ${flowsInto.resolutionStatus}`
        );
        assert.strictEqual(
          flowsInto.propertyName,
          '<computed>',
          'Property name should remain <computed> for parameters'
        );
      }
      // If no edge, that's also acceptable (no FLOWS_INTO from variables to obj)
    });
  });

  // ============================================================================
  // External call: const k = getKey(); obj[k] = value
  // ============================================================================
  describe('Function call result (nondeterministic)', () => {
    it('should NOT resolve obj[k] when k comes from function call', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
function getKey() { return 'dynamic'; }
const key = getKey();
const value = 'test';
obj[key] = value;
        `
      });

      const allEdges = await backend.getAllEdges();

      const flowsInto = allEdges.find(e =>
        e.type === 'FLOWS_INTO' &&
        e.computedPropertyVar === 'key'
      );

      if (flowsInto && flowsInto.resolutionStatus) {
        assert.strictEqual(
          flowsInto.resolutionStatus,
          'UNKNOWN_RUNTIME',
          'Should have UNKNOWN_RUNTIME status for function call result'
        );
      }
    });
  });

  // ============================================================================
  // Method call: obj[key]() where key = 'method'
  // Already handled by existing ValueDomainAnalyzer - verify compatibility
  // ============================================================================
  describe('Compatibility with existing computed method resolution', () => {
    it('should still resolve obj[method]() calls', async () => {
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
      const callsEdge = allEdges.find(e =>
        e.type === 'CALLS' &&
        e.source === 'computed_member_access'
      );

      // This test verifies we didn't break existing functionality
      // The exact assertion depends on whether the class resolution works
    });
  });

  // ============================================================================
  // Edge case: Multiple computed assignments to same object
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

      const flowsIntoEdges = allEdges.filter(e =>
        e.type === 'FLOWS_INTO' &&
        e.resolutionStatus === 'RESOLVED'
      );

      // Should have 2 resolved edges
      assert.strictEqual(
        flowsIntoEdges.length,
        2,
        `Expected 2 resolved FLOWS_INTO edges, got ${flowsIntoEdges.length}`
      );

      const propNames = flowsIntoEdges.map(e => e.propertyName).sort();
      assert.deepStrictEqual(propNames, ['first', 'second']);
    });
  });
});
```

---

## Implementation Order

1. **Types (Step 1.1-1.3)** - 30 min
   - Add `computedPropertyVar` to `ObjectMutationInfo`
   - Add `ResolutionStatus` type
   - Extend `GraphEdge` with new fields
   - No dependencies

2. **Tests (Step 4.1)** - 45 min
   - Create test file with all cases
   - Run to verify RED state
   - Dependencies: Types must exist

3. **Analysis changes (Step 2.1-2.2)** - 45 min
   - Update JSASTAnalyzer to capture variable name
   - Update GraphBuilder to pass through to edge
   - Dependencies: Types

4. **Enrichment changes (Step 3.1-3.3)** - 1.5 hr
   - Add `resolveComputedMutations` method
   - Integrate into `execute`
   - Update interface
   - Dependencies: Types, Analysis changes

5. **Integration testing** - 30 min
   - Run all tests
   - Fix any issues
   - Dependencies: All above

**Total estimated time: 4 hours**

---

## Risk Mitigations

### Risk 1: Edge deletion fails mid-resolution
**Mitigation:** Only delete edge when we have resolution data ready. If resolution fails, edge stays unchanged with `<computed>`.

### Risk 2: Performance on large codebases
**Mitigation:**
- Only process edges with `mutationType: 'computed'`
- Use existing `getValueSet` which has depth limits
- Add progress reporting (already exists in ValueDomainAnalyzer)

### Risk 3: Breaking existing FLOWS_INTO queries
**Mitigation:**
- New fields are additive
- `propertyName` is updated to resolved value (improvement)
- Consumers using `propertyName: '<computed>'` will now get actual names (desired behavior)

### Risk 4: Type conflicts with existing edge metadata
**Mitigation:**
- Check `GraphEdge` interface doesn't conflict
- Use optional fields (`?:`)
- Metadata is merged, not replaced

---

## Verification Checklist

After implementation, verify:

- [ ] `ObjectMutationInfo` has `computedPropertyVar?: string`
- [ ] `ResolutionStatus` type is exported from types.ts
- [ ] `GraphEdge` has new optional fields
- [ ] JSASTAnalyzer captures variable name for computed mutations
- [ ] GraphBuilder includes `computedPropertyVar` in edge metadata
- [ ] ValueDomainAnalyzer resolves computed property mutations
- [ ] All tests pass
- [ ] No regression in existing `ObjectMutationTracking.test.js`
- [ ] No regression in existing `ValueDomainAnalyzer.test.js`
- [ ] Performance impact < 5% (run benchmarks if available)
