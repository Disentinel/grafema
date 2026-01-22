# Rob Pike: Implementation Report - Clear-and-Rebuild

**Date:** 2025-01-22
**Task:** REG-118 Node Duplication Fix
**Based on:** Joel's Technical Spec (010)

---

## Summary

Implemented Clear-and-Rebuild logic in GraphBuilder. The solution is simple and follows existing patterns.

---

## Changes Made

### File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

#### 1. Added `_clearFileNodes()` Method (lines 92-137)

```typescript
/**
 * Clear existing nodes for a file before rebuilding.
 * This enables idempotent re-analysis: running twice produces identical results.
 *
 * @param graph - The graph backend
 * @param file - The file path to clear nodes for
 * @returns Number of nodes deleted
 */
private async _clearFileNodes(graph: GraphBackend, file: string): Promise<number> {
  // Skip if backend doesn't support deletion
  if (!graph.deleteNode) {
    return 0;
  }

  let deletedCount = 0;
  const nodesToDelete: string[] = [];

  // Collect node IDs for this file, excluding MODULE and EXTERNAL_MODULE nodes
  // MODULE nodes are created by JSModuleIndexer in INDEXING phase
  // EXTERNAL_MODULE nodes are shared across files
  for await (const node of graph.queryNodes({ file })) {
    // Preserve MODULE nodes - they belong to the indexing phase
    if (node.type === 'MODULE' || node.nodeType === 'MODULE') {
      continue;
    }
    // Preserve EXTERNAL_MODULE nodes - they are shared/singleton
    if (node.type === 'EXTERNAL_MODULE' || node.nodeType === 'EXTERNAL_MODULE') {
      continue;
    }
    nodesToDelete.push(node.id);
  }

  // Delete each collected node
  // RFDB handles edge cleanup via soft delete - edges to deleted nodes are invalidated
  for (const id of nodesToDelete) {
    try {
      await graph.deleteNode(id);
      deletedCount++;
    } catch (err) {
      // Log but don't fail - node might already be deleted
      console.warn(`[GraphBuilder] Failed to delete node ${id}:`, (err as Error).message);
    }
  }

  return deletedCount;
}
```

#### 2. Modified `build()` Method (lines 142-148)

Added clear call at the very start of `build()`:

```typescript
async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections): Promise<BuildResult> {
  // CLEAR EXISTING NODES FIRST - enables idempotent re-analysis
  // This must happen BEFORE we start buffering new nodes
  const deletedCount = await this._clearFileNodes(graph, module.file);
  if (deletedCount > 0) {
    console.log(`[GraphBuilder] Cleared ${deletedCount} existing nodes for ${module.file}`);
  }

  const {
    // ... rest unchanged
```

---

## Design Decisions

### 1. Underscore Prefix for Private Method

Used `_clearFileNodes` to match existing pattern (`_nodeBuffer`, `_edgeBuffer`, `_flushNodes`, `_flushEdges`).

### 2. EXTERNAL_MODULE Exclusion

Added EXTERNAL_MODULE to exclusion list (not in original spec). Reason: these nodes are shared/singleton across files (e.g., `EXTERNAL_MODULE:fs`). If we delete them, the first file re-analyzed wins, but then other files' imports would have dangling references.

### 3. Collect-Then-Delete Pattern

Collecting IDs first, then deleting in separate loop. This avoids modifying the collection while iterating, which can cause issues with async generators.

### 4. Graceful Error Handling

Individual delete failures are logged as warnings, not errors. Analysis continues. This handles edge cases where:
- Node was already deleted by another process
- Concurrent analysis scenarios

### 5. Conditional Logging

Only logs when nodes were actually deleted (`deletedCount > 0`). Fresh analysis won't spam console.

---

## Verification

### TypeScript Compilation

```bash
npx tsc --noEmit -p packages/core/tsconfig.json
# Exit code 0 - no errors
```

### Interface Compatibility

Verified that:
- `GraphBackend.deleteNode` exists as optional method (line 137 in plugins.ts)
- `RFDBServerBackend.deleteNode()` is implemented (line 418 in RFDBServerBackend.ts)
- `queryNodes({ file })` returns nodes with `file` attribute

---

## What's Next

Tests need to be run to verify:
1. Re-analysis produces identical graph
2. Node count doesn't grow on repeated analysis
3. MODULE nodes are preserved
4. EXTERNAL_MODULE nodes are preserved
5. Cross-file edges are recreated correctly

Kent should have tests ready in `test/unit/ReanalysisIdempotency.test.js`.

---

## Files Changed

| File | Lines Changed |
|------|---------------|
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | +53 lines |

---

**Implementation complete. Ready for Kent's tests and Kevlin/Linus review.**
