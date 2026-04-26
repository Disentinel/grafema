# Don Melton: Clear-and-Rebuild Implementation Plan

**Date:** 2025-01-22
**Task:** REG-118 Node Duplication Fix
**Approach:** Clear-and-Rebuild (user decision from 008)

---

## Executive Summary

Clear-and-Rebuild is the right call for now. Simple, correct, no edge cases. The implementation is straightforward: before analyzing a file, delete all nodes belonging to that file, then analyze normally.

## Investigation Findings

### Where Analysis Starts

```
Orchestrator.run(projectPath)
  -> runPhase('ANALYSIS', context)
    -> JSASTAnalyzer.execute(context)
      -> analyzeModule(module, graph, projectPath)  // <-- PER-FILE
        -> GraphBuilder.build(module, graph, projectPath, data)
          -> graph.addNodes(nodes)
          -> graph.addEdges(edges)
```

**Key insight:** `analyzeModule()` is already per-file. This is the natural place for "clear before write."

### Current RFDB Capabilities

| Operation | Exists | Location |
|-----------|--------|----------|
| `deleteNode(id)` | YES | RFDBServerBackend, RFDBClient |
| `deleteEdge(src, dst, type)` | YES | RFDBServerBackend, RFDBClient |
| `queryNodes({ file: F })` | PARTIAL | Uses internal iteration, no file index |
| `deleteNodesByFile(file)` | NO | Needs to be added |
| `FileIndex` | EXISTS | Rust: `src/index/mod.rs`, but not connected |

### The Gap

We can delete individual nodes, but we **cannot efficiently find all nodes for a file**. The `FileIndex` exists in Rust code but isn't wired through to the server/client API.

---

## High-Level Plan

### Option A: Use Existing Infrastructure (Recommended for Speed)

Since `queryNodes({ file: F })` exists (it iterates all nodes), we can implement client-side clear:

```typescript
// In GraphBuilder.build() or JSASTAnalyzer.analyzeModule()
async function clearFileNodes(graph: GraphBackend, file: string): Promise<void> {
  const nodesToDelete: string[] = [];

  // Collect node IDs for this file
  for await (const node of graph.queryNodes({ file })) {
    nodesToDelete.push(node.id);
  }

  // Delete each node (edges cascade automatically via soft delete)
  for (const id of nodesToDelete) {
    await graph.deleteNode(id);
  }
}
```

**Pros:**
- Works with current RFDB implementation
- No Rust changes needed
- Can ship TODAY

**Cons:**
- O(N) scan of all nodes to find file's nodes
- For large graphs (100k+ nodes), this could be slow

### Option B: Add Server-Side `deleteNodesByFile` (Better Performance)

Add a new RFDB operation that leverages the `FileIndex`:

1. **Rust Engine** (`graph/engine.rs`):
   ```rust
   fn delete_nodes_by_file(&mut self, file: &str) -> Vec<u128> {
     let node_ids = self.file_index.get_nodes(file);
     for id in &node_ids {
       self.delete_node(*id);
     }
     node_ids
   }
   ```

2. **RFDB Server** (`rfdb_server.rs`):
   ```rust
   Request::DeleteNodesByFile { file } => {
     let deleted = engine.delete_nodes_by_file(&file);
     Response::Ids { ids: deleted.iter().map(id_to_string).collect() }
   }
   ```

3. **RFDBClient**:
   ```typescript
   async deleteNodesByFile(file: string): Promise<string[]>
   ```

4. **RFDBServerBackend**:
   ```typescript
   async deleteNodesByFile(file: string): Promise<string[]>
   ```

**Pros:**
- O(1) lookup via FileIndex
- Atomic operation
- Proper cascading in Rust

**Cons:**
- Requires Rust changes
- FileIndex needs to be populated (currently not used)

---

## Recommendation: Phased Approach

### Phase 1: Ship Fix with Client-Side Clear (Option A)

**Why:** Get REG-118 fixed ASAP. The O(N) scan is acceptable for typical codebases (10k-50k nodes).

**Changes:**

1. **GraphBuilder.ts** - Add `clearFileNodes()` method:
   ```typescript
   private async clearFileNodes(graph: GraphBackend, file: string): Promise<number> {
     let deletedCount = 0;
     const nodesToDelete: string[] = [];

     for await (const node of graph.queryNodes({ file })) {
       nodesToDelete.push(node.id);
     }

     for (const id of nodesToDelete) {
       if (graph.deleteNode) {
         await graph.deleteNode(id);
         deletedCount++;
       }
     }

     return deletedCount;
   }
   ```

2. **GraphBuilder.build()** - Call clear at start:
   ```typescript
   async build(module: ModuleNode, graph: GraphBackend, ...): Promise<BuildResult> {
     // CLEAR FIRST
     const deleted = await this.clearFileNodes(graph, module.file);
     if (deleted > 0) {
       console.log(`[GraphBuilder] Cleared ${deleted} existing nodes for ${module.file}`);
     }

     // Then proceed with normal build...
     this._nodeBuffer = [];
     this._edgeBuffer = [];
     // ... rest of method
   }
   ```

3. **GraphBackend Interface** - Ensure `deleteNode` is optional:
   ```typescript
   interface GraphBackend {
     // ... existing ...
     deleteNode?(id: string): Promise<void>;  // Already optional in types
   }
   ```

### Phase 2: Optimize with Server-Side Clear (Option B) - Future

Track as tech debt:
- [ ] Wire FileIndex through GraphEngine
- [ ] Add `deleteNodesByFile` to RFDB server
- [ ] Benchmark performance difference

---

## Edge Cases and Risks

### 1. Cross-File Edges

**Scenario:** Module A imports from Module B. Edge exists: `IMPORT(A) -> EXPORT(B)`.

**When A is re-analyzed:**
- Node `IMPORT(A)` is deleted
- Edge `IMPORT(A) -> EXPORT(B)` becomes orphaned (source missing)

**Solution:** RFDB already handles this via soft delete. When node is deleted, edges referencing it become invalid. During queries, invalid edges are filtered out.

**Verification needed:** Confirm RFDB's `deleteNode` properly invalidates related edges.

### 2. Concurrent Analysis

**Scenario:** Two workers analyze different files simultaneously, both writing to same graph.

**Risk:** No issue with clear-and-rebuild per se. Each file's clear only affects its own nodes.

**However:** If file A imports from file B, and both are being analyzed simultaneously:
1. Worker 1 clears A's nodes
2. Worker 2 clears B's nodes
3. Worker 1 writes A's nodes (including edge A->B)
4. Edge A->B points to deleted B node

**Mitigation:** This is pre-existing issue with parallel analysis. RFDB handles dangling edges gracefully. The edge simply won't resolve to a target.

**Better solution (future):** Transaction/batch semantics or file-level locking.

### 3. Module Node Preservation

**Important:** MODULE nodes are created by `JSModuleIndexer` in INDEXING phase, not ANALYSIS.

When `JSASTAnalyzer` clears file F, should MODULE node be deleted?

**Answer: NO.**
- MODULE nodes should be preserved
- Only delete nodes WHERE file=F AND type != 'MODULE'

**Update to clearFileNodes:**
```typescript
for await (const node of graph.queryNodes({ file })) {
  if (node.type !== 'MODULE') {
    nodesToDelete.push(node.id);
  }
}
```

### 4. External Module Nodes

Nodes like `EXTERNAL_MODULE:lodash` have no `file` property. They are singletons.

**Impact:** None. They won't match `queryNodes({ file: F })`.

### 5. Singleton Nodes

Nodes like `net:stdio#__stdio__` and `net:request#__network__` are singletons across all files.

**Impact:** None. They have no `file` property.

---

## Atomicity Considerations

**Question:** What if clear succeeds but subsequent insert fails?

**Current state:** Non-atomic. If build crashes after clear, file's nodes are gone.

**Acceptable for now because:**
1. Re-running analysis will recreate them
2. This is development tooling, not production database
3. Partial state is obvious (file has no nodes)

**Future improvement:** Transaction support in RFDB.

---

## Testing Strategy

### Unit Tests

1. **Test: Re-analysis produces identical graph**
   ```javascript
   // Analyze file
   await analyzer.analyzeModule(module, graph);
   const state1 = await graph.export();

   // Analyze same file again
   await analyzer.analyzeModule(module, graph);
   const state2 = await graph.export();

   // Should be identical
   assert.deepEqual(state1, state2);
   ```

2. **Test: Node count doesn't grow on re-analysis**
   ```javascript
   await analyzer.analyzeModule(module, graph);
   const count1 = await graph.nodeCount();

   await analyzer.analyzeModule(module, graph);
   const count2 = await graph.nodeCount();

   assert.equal(count1, count2);
   ```

3. **Test: Cross-file edges handled correctly**
   - Analyze A (imports B)
   - Verify IMPORT edge exists
   - Re-analyze A
   - Verify IMPORT edge still exists (recreated)

4. **Test: MODULE nodes preserved**
   - Analyze file
   - Verify MODULE node exists
   - Re-analyze
   - Verify same MODULE node (by ID)

---

## Implementation Order

1. **Add `clearFileNodes` to GraphBuilder.ts** (30 min)
2. **Call it at start of `build()`** (10 min)
3. **Exclude MODULE nodes from deletion** (10 min)
4. **Write unit tests** (1 hour)
5. **Run full test suite** (10 min)
6. **Manual testing with real project** (30 min)

**Total estimate:** ~2.5 hours

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add `clearFileNodes()`, call in `build()` |
| `packages/types/src/plugins.ts` | No change (deleteNode already optional) |
| `test/unit/GraphBuilder.test.js` | Add re-analysis idempotency tests |

---

## Success Criteria

1. `grafema analyze` twice = identical graph
2. No node count growth on re-analysis
3. All existing tests pass
4. MODULE nodes preserved across re-analysis
5. Cross-file edges work correctly

---

## Open Questions for Joel

1. Should `clearFileNodes` be in `GraphBuilder` or `JSASTAnalyzer`?
   - **Don's opinion:** GraphBuilder, since it owns the write path

2. Do we need to handle RustAnalyzer similarly?
   - **Don's opinion:** Yes, same pattern should apply

3. Should we add a config flag to disable clear-before-write?
   - **Don's opinion:** No, YAGNI. Just make it work correctly.

---

**Ready for Joel's detailed tech plan.**
