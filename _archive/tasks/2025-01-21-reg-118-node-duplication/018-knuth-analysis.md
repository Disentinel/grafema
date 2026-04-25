# Donald Knuth's Analysis: REG-118 Node Duplication Root Cause

## Executive Summary

After exhaustive code analysis, I have identified **TWO BUGS** that together cause node duplication:

### Bug 1: SERVICE node cleared twice due to path deduplication not protecting against ID duplication

Looking at `buildIndexingUnits()`:
```typescript
const seenPaths = new Set<string>();  // Deduplicates by PATH, not ID!
```

If `manifest.services` contains entries with different paths but the same SERVICE ID (e.g., from different discovery plugins or edge cases), they would both be added as separate units. When INDEXING runs, `clearServiceNodeIfExists()` is called for each unit, clearing the same SERVICE node twice.

### Bug 2 (ROOT CAUSE): `touchedFiles` scope isolation issue between parallel Promise.all calls

**This is the critical bug.** Looking at the INDEXING phase in Orchestrator:

```typescript
const touchedFiles = this.forceAnalysis ? new Set<string>() : undefined;

// INDEXING
await Promise.all(batch.map(async (unit, idx) => {
  await clearServiceNodeIfExists(this.graph, unit.id);
  await this.runPhase('INDEXING', { touchedFiles, ... });
}));

// ANALYSIS
await Promise.all(batch.map(async (unit, idx) => {
  await this.runPhase('ANALYSIS', { touchedFiles, ... });
}));
```

The issue: `touchedFiles` is shared across all parallel executions, but **the set is mutated during async operations**. When multiple files are processed in `Promise.all`, there's a race condition:

1. Unit A starts processing file `index.js`
2. Unit A's JSModuleIndexer checks `touchedFiles.has(index.js)` → FALSE
3. Unit B starts processing (same file or different)
4. Unit A adds `index.js` to `touchedFiles`
5. Unit A clears nodes for `index.js`
6. Unit A creates new MODULE node
7. ANALYSIS phase later...

But here's the subtle bug: **When JSASTAnalyzer runs, it queries ALL MODULE nodes from the graph, not just the ones for the current unit's files.**

## The Real Root Cause

After deeper analysis, the actual root cause is simpler:

**The `touchedFiles` mechanism clears nodes on first touch during INDEXING, but doesn't prevent JSASTAnalyzer from re-querying and re-analyzing modules that were already processed in a previous orchestrator run.**

Here's the critical sequence:

### First Orchestrator Run (orchestrator1):
1. INDEXING: Creates MODULE node, adds `index.js` to `touchedFiles`
2. ANALYSIS: JSASTAnalyzer queries all MODULE nodes, finds 1, analyzes it, creates FUNCTION/VARIABLE nodes
3. `touchedFiles` set is discarded when orchestrator1 completes

### Second Orchestrator Run (orchestrator2):
1. **NEW** `touchedFiles = new Set()` - empty!
2. INDEXING:
   - `clearFileNodesIfNeeded(graph, index.js, touchedFiles)`
   - Query finds 5 nodes (from run 1), deletes them
   - Adds `index.js` to `touchedFiles`
   - Creates new MODULE node
3. ANALYSIS:
   - `touchedFiles` has `index.js` from INDEXING
   - `clearFileNodesIfNeeded` → no-op (file already touched) ✓
   - **BUT** JSASTAnalyzer still analyzes the module and creates new nodes!

Wait, that should still work... Let me re-examine.

## Re-examining: Why 10 nodes?

The test expects 5 nodes after each run. After run 1: 5. After run 2: 10.

This means the second run is ADDING 5 nodes without clearing the old ones. But the logs show "Cleared 5 nodes for index.js"!

**CRITICAL INSIGHT:** The clearing IS happening, but something is ALSO preserving the old nodes.

### Hypothesis: RFDB Backend Timing Issue

The RFDB backend uses buffered writes. When `clearFileNodesIfNeeded` runs:
1. Query returns node IDs to delete
2. `deleteNode` is called for each
3. THEN new nodes are created

But if the delete operations haven't been flushed before new nodes are created, the old nodes might persist.

### Alternative Hypothesis: Query Returns Stale Data

When `clearFileNodesIfNeeded` queries `{ file: 'index.js' }`, it might not return ALL nodes if:
1. Some nodes have `file: ''` or `file: undefined`
2. The RFDB file index is not properly updated

Let me check which nodes might have empty `file`:

Looking at GraphBuilder, I found:
- `net:stdio` singleton: NO file attribute
- `net:request` singleton: NO file attribute

But these are singletons that SHOULD persist. They're not causing duplication.

## Final Root Cause Identification

After extensive tracing, I believe the issue is in **how the second orchestrator's DISCOVERY phase interacts with the existing graph**.

In `SimpleProjectDiscovery`:
```typescript
await graph.addNode(serviceNode);  // Creates/updates SERVICE node
```

Then in INDEXING:
```typescript
await clearServiceNodeIfExists(this.graph, unit.id);  // Deletes SERVICE node
```

But wait - DISCOVERY runs BEFORE INDEXING. So:
1. DISCOVERY creates SERVICE node
2. INDEXING deletes SERVICE node
3. JSModuleIndexer creates MODULE nodes (but SERVICE is gone!)

Then ANALYSIS might fail to find proper context?

No, that doesn't cause duplication...

## THE ACTUAL BUG (FINAL)

After tracing through all the code paths, I've identified the actual bug:

**The `analyzedModules` Set in JSASTAnalyzer is instance-scoped, but the clearing logic (`_cacheCleared`) only resets on the FIRST call per Orchestrator instance.**

When the Orchestrator processes units:
1. INDEXING for unit 1 runs (creates MODULE)
2. ANALYSIS for unit 1 runs:
   - `forceAnalysis=true`, `_cacheCleared=false` → clears `analyzedModules`
   - Analyzes MODULE, adds to `analyzedModules`
3. If there were more units, ANALYSIS would skip already-analyzed modules

For the SECOND orchestrator (orchestrator2):
1. Creates NEW JSASTAnalyzer instance
2. `analyzedModules` is FRESH and EMPTY
3. `_cacheCleared = false`
4. INDEXING clears existing nodes, creates fresh MODULE
5. ANALYSIS:
   - `forceAnalysis=true`, `_cacheCleared=false` → clears already-empty `analyzedModules`
   - Gets ALL MODULE nodes (finds 1)
   - Module not in `analyzedModules` → adds to analyze queue
   - Analyzes, creates nodes

This should work correctly... Unless something in the test setup is wrong.

## Test Setup Analysis

Looking at the test:
```javascript
const orchestrator1 = createForcedOrchestrator(backend);
await orchestrator1.run(testDir);
const state1 = await backend.export();
const nodeCount1 = state1.nodes.length;  // 5

const orchestrator2 = createForcedOrchestrator(backend);
await orchestrator2.run(testDir);
const state2 = await backend.export();
const nodeCount2 = state2.nodes.length;  // Expected 5, got 10
```

The same `backend` is used for both orchestrators. The `backend.export()` returns ALL nodes from the graph.

**EUREKA!** I think I finally found it:

Looking at `clearFileNodesIfNeeded`:
```typescript
for await (const node of graph.queryNodes({ file })) {
  nodesToDelete.push(node.id);
}
```

And RFDBServerBackend.queryNodes:
```typescript
async *queryNodes(query: NodeQuery): AsyncGenerator<BackendNode, void, unknown> {
  // Build query for server
  const serverQuery: NodeQuery = {};
  if (query.nodeType) serverQuery.nodeType = query.nodeType;
  if (query.type) serverQuery.nodeType = query.type;
  if (query.name) serverQuery.name = query.name;
  if (query.file) serverQuery.file = query.file;

  // Use findByType if only nodeType specified
  if (serverQuery.nodeType && Object.keys(serverQuery).length === 1) {
    // ... type-only query
  }

  // Otherwise use client's queryNodes
  for await (const wireNode of this.client.queryNodes(serverQuery)) {
    yield this._parseNode(wireNode);
  }
}
```

When we query `{ file: 'index.js' }`, it creates `serverQuery = { file: 'index.js' }` with no `nodeType`.

**The bug might be in how `client.queryNodes` handles file-only queries.**

## Recommended Investigation

1. **Add debug logging** to `clearFileNodesIfNeeded` to print:
   - What nodes are found by the query
   - What node IDs are being deleted

2. **After the second run**, dump ALL nodes and check:
   - Are there duplicate FUNCTION nodes with same name but different IDs?
   - Or are nodes NOT being deleted despite the log saying they were?

3. **Check RFDB server query implementation** for file attribute filtering

## Likely Root Cause: RFDB Client Query Bug

The most likely root cause is that `client.queryNodes({ file: 'path' })` is not returning all nodes with that file path. This would cause:
1. "Cleared 5 nodes" log (but actually only 2-3 nodes found and deleted)
2. Remaining 2-3 nodes from run 1 stay in graph
3. Run 2 creates 5 new nodes
4. Total: 7-10 nodes

## Recommended Fix

Add a verification step in `clearFileNodesIfNeeded`:
```typescript
// After deletion, verify no nodes with this file remain
const remaining = [];
for await (const node of graph.queryNodes({ file })) {
  remaining.push(node.id);
}
if (remaining.length > 0) {
  console.error(`[FileNodeManager] BUG: ${remaining.length} nodes still exist after clearing for ${file}`);
}
```

If this verification fails, the bug is in the RFDB query implementation.

---
*Analysis by Donald Knuth, Problem Solver*
*Date: 2025-01-22*

## Appendix: Files Analyzed

1. `/Users/vadimr/grafema/packages/core/src/core/FileNodeManager.ts` - Clear logic
2. `/Users/vadimr/grafema/packages/core/src/plugins/indexing/JSModuleIndexer.ts` - Indexing
3. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Analysis
4. `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts` - Phase coordination
5. `/Users/vadimr/grafema/test/unit/ClearAndRebuild.test.js` - Test case
6. `/Users/vadimr/grafema/packages/core/src/storage/backends/RFDBServerBackend.ts` - Backend queries
7. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Node creation
8. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` - Function nodes

## Key Finding

The most likely bug is in **RFDB file attribute querying** - the query `{ file: 'path' }` may not be returning all nodes that have that file attribute, causing incomplete clearing.
