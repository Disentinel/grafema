## Don's Plan: REG-368 - Make brandNode() internal and update GraphBackend interface

### Executive Summary

This is an infrastructure change to enforce type safety: make `brandNode()` internal so only NodeFactory can create branded nodes, and update GraphBackend to require `AnyBrandedNode` instead of loose `InputNode`.

**Expected outcome:** ~50 TypeScript errors across the codebase (expected, will be fixed in downstream tasks REG-369 through REG-377).

### Current State Analysis

**brandNode() location and usage:**
- Defined in: `/packages/types/src/branded.ts:72`
- Exported via: `/packages/types/src/index.ts:9` (barrel export from `./branded.js`)
- Called in: `NodeFactory.ts` (35 times - all legitimate uses)
- NOT currently called in: `GraphBuilder._flushNodes()` or `RFDBServerBackend._parseNode()`

**GraphBackend interface:**
- Defined in: `/packages/types/src/plugins.ts:276-319`
- Current signature: `addNode(node: InputNode): Promise<void> | void`
- InputNode is flexible: `{ id: string; type?: string; ... [key: string]: unknown }`
- Need to change to: `addNode(node: AnyBrandedNode): Promise<void> | void`

**GraphBuilder behavior:**
- `_flushNodes()` casts `GraphNode[]` to `NodeRecord[]` before calling `graph.addNodes()`
- GraphNode is the internal buffer type (unbranded)
- After this change, will need to brand these nodes before flushing

**RFDBServerBackend behavior:**
- `_parseNode()` converts `WireNode` (from database) to `BaseNodeRecord`
- Returns plain objects, not branded
- Used by `getNode()`, `queryNodes()`, `getAllNodes()`
- After this change, will need to re-brand nodes coming from database

### Grafema CLI Dogfooding Results

| Query | Command | Result | Fallback |
|-------|---------|--------|----------|
| Find brandNode definition | `query "brandNode"` | ❌ No results | Grep → found in 23 files |
| Find AnyBrandedNode | `query "AnyBrandedNode"` | ❌ No results | Grep → found in 13 files |
| Find GraphBackend | `query "GraphBackend"` | ❌ No results | Grep → found in 16 files |
| Check @grafema/types exports | `file "packages/types/src/index.ts"` | ❌ NOT_ANALYZED | Read → saw barrel exports |

**Verdict:** Graph was NOT useful for this task. All queries failed because:
1. Type symbols aren't extracted as nodes (types, interfaces, functions)
2. The packages/types directory wasn't analyzed (entry point limitation)

**Product gaps:**
- Type definitions should be extractable (INTERFACE, TYPE nodes exist but not populated)
- Package exports should be queryable (would help with public API analysis)
- Function definitions in non-entry-point files should be indexed

### Implementation Plan

#### Changes Required

**File 1: `/packages/types/src/branded.ts`**
- Remove `export` from `brandNode()` function (line 72)
- Keep `@internal` JSDoc comment for clarity
- Function remains in the file, just not exported

**File 2: `/packages/types/src/index.ts`**
- Change line 9 from `export * from './branded.js'` to selective exports:
  ```typescript
  export type { BrandedNode, AnyBrandedNode, UnbrandedNode } from './branded.js';
  export { isBrandedNode } from './branded.js';
  ```
- This exports types and the type guard, but NOT `brandNode()`

**File 3: Create `/packages/core/src/core/brandNodeInternal.ts`**
```typescript
/**
 * Internal branding helper for legitimate uses outside NodeFactory.
 * DO NOT import this in analyzers or plugins - use NodeFactory instead.
 *
 * Legitimate uses:
 * - GraphBuilder._flushNodes() - batches validated nodes from builders
 * - RFDBServerBackend._parseNode() - re-brands nodes from database
 *
 * @internal
 */
import type { BaseNodeRecord, BrandedNode } from '@grafema/types';

export function brandNodeInternal<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return node as BrandedNode<T>;
}
```

**File 4: `/packages/core/src/core/NodeFactory.ts`**
- Add import: `import { brandNodeInternal } from './brandNodeInternal.js';`
- Replace all 35 calls to `brandNode()` with `brandNodeInternal()`
- Remove import of `brandNode` from `@grafema/types`

**File 5: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`**
- Add import: `import { brandNodeInternal } from '../../../core/brandNodeInternal.js';`
- Modify `_flushNodes()` (line 102-111):
  ```typescript
  private async _flushNodes(graph: GraphBackend): Promise<number> {
    if (this._nodeBuffer.length > 0) {
      // Brand nodes before flushing - they're validated by builders
      const brandedNodes = this._nodeBuffer.map(node => brandNodeInternal(node));
      await graph.addNodes(brandedNodes);
      const count = this._nodeBuffer.length;
      this._nodeBuffer = [];
      return count;
    }
    return 0;
  }
  ```

**File 6: `/packages/core/src/storage/backends/RFDBServerBackend.ts`**
- Add import: `import { brandNodeInternal } from '../../core/brandNodeInternal.js';`
- Modify `_parseNode()` (line 450-488):
  ```typescript
  private _parseNode(wireNode: WireNode): AnyBrandedNode {
    const metadata: Record<string, unknown> = wireNode.metadata ? JSON.parse(wireNode.metadata) : {};

    // ... existing parsing logic ...

    const parsed = {
      id: humanId,
      type: wireNode.nodeType,
      name: wireNode.name,
      file: wireNode.file,
      exported: wireNode.exported,
      ...safeMetadata,
    };

    // Re-brand nodes coming from database
    return brandNodeInternal(parsed);
  }
  ```
- Update return type in signature from `BaseNodeRecord` to `AnyBrandedNode`

**File 7: `/packages/types/src/plugins.ts`**
- Update GraphBackend interface (line 276-280):
  ```typescript
  export interface GraphBackend {
    addNode(node: AnyBrandedNode): Promise<void> | void;
    addEdge(edge: InputEdge): Promise<void> | void;
    addNodes(nodes: AnyBrandedNode[]): Promise<void> | void;
    addEdges(edges: InputEdge[]): Promise<void> | void;
    // ... rest unchanged
  }
  ```
- Remove `InputNode` interface definition (lines 258-266) - no longer needed
- Keep `InputEdge` for now (edges don't have branding yet)

### Order of Operations (Commits)

**Commit 1: Create internal branding helper**
- Create `packages/core/src/core/brandNodeInternal.ts`
- Self-contained, no breaking changes yet

**Commit 2: Update NodeFactory to use internal helper**
- Modify `packages/core/src/core/NodeFactory.ts`
- Switch from `brandNode` (public) to `brandNodeInternal`
- Tests should still pass (no behavior change)

**Commit 3: Update GraphBuilder and RFDBServerBackend**
- Modify `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
- Modify `packages/core/src/storage/backends/RFDBServerBackend.ts`
- Add branding to `_flushNodes()` and `_parseNode()`
- Tests should still pass (still using old GraphBackend signature)

**Commit 4: Make brandNode() internal (BREAKING)**
- Modify `packages/types/src/branded.ts` (remove export)
- Modify `packages/types/src/index.ts` (selective exports)
- Build will fail with ~50 errors (expected)

**Commit 5: Update GraphBackend interface (MORE BREAKING)**
- Modify `packages/types/src/plugins.ts`
- Change `InputNode` to `AnyBrandedNode` in interface
- Remove `InputNode` type
- Build errors will shift but remain ~50

### Expected Errors After This Task

TypeScript will complain in:
1. Test files creating inline nodes: `graph.addNode({ id: 'x', type: 'Y', ... })`
2. Plugins creating nodes without NodeFactory
3. Backend implementations with wrong signatures
4. Any analyzer code creating nodes manually

**This is intentional.** Downstream tasks (REG-369 through REG-377) will fix these by:
- Updating tests to use NodeFactory
- Adding NodeFactory calls in plugins
- Fixing backend implementations

### Risk Assessment

**Low risk:**
- Changes are type-level only (runtime behavior unchanged)
- Branding is phantom type (no runtime cost)
- NodeFactory already exists and works
- Test coverage is good

**Medium risk:**
- GraphBuilder._flushNodes branding adds map() overhead
  - Mitigation: Array.map is fast for small batches (~100-1000 nodes)
  - Benefit: Type safety catches bugs at compile time

**Rollback plan:**
- Revert commits in reverse order
- Each commit is atomic and tested

### Success Criteria

✅ `brandNode()` not importable from `@grafema/types`
✅ Internal helper exists at `packages/core/src/core/brandNodeInternal.ts`
✅ NodeFactory uses internal helper
✅ GraphBuilder._flushNodes() brands nodes before flushing
✅ RFDBServerBackend._parseNode() returns branded nodes
✅ GraphBackend.addNode signature requires `AnyBrandedNode`
✅ Build fails with ~50 TypeScript errors (blocking inline node creation)
✅ All commits are atomic with clear messages

### Timeline Estimate

- Commit 1: 5 min (create helper)
- Commit 2: 10 min (update NodeFactory)
- Commit 3: 15 min (update GraphBuilder + RFDBServerBackend)
- Commit 4: 5 min (make brandNode internal)
- Commit 5: 10 min (update GraphBackend interface)
- Testing: 10 min (verify errors appear)

**Total: 55 minutes**

### Notes for Implementation Agents

**For Kent (Tests):**
- No new tests needed - this task intentionally breaks existing tests
- Verify that ~50 errors appear after commits 4-5
- Don't fix the errors - that's for downstream tasks

**For Rob (Implementation):**
- Follow commit order strictly
- Run `pnpm build` after each commit to verify it compiles
- Commits 1-3 should build cleanly
- Commits 4-5 will have errors (expected)
- Use exact type names: `AnyBrandedNode` not `BrandedNode<NodeRecord>`
