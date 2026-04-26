# REG-483: Remove GraphBuilder Buffer Layer — Implementation Plan

**Author:** Don Melton
**Date:** 2026-02-16
**Workflow:** v2.1 (Mini-MLA)

## Problem Statement

During analysis, data passes through 3 buffer layers:
1. JSASTAnalyzer — 30+ collection arrays
2. GraphBuilder — `_nodeBuffer[]`, `_edgeBuffer[]` (REDUNDANT)
3. RFDBClient — `_batchNodes[]`, `_batchEdges[]` (inside beginBatch/commitBatch)

**GraphBuilder's buffer duplicates RFDBClient's batch.** PhaseRunner already wraps each plugin in beginBatch/commitBatch (PhaseRunner.ts:73-99).

**Exception:** ModuleRuntimeBuilder.ts:405 needs to mutate function node metadata (rejectionPatterns) after the node is buffered but before it's written to graph. Currently uses `findBufferedNode()` to locate and modify the function node.

## Solution Approach

**Remove `_nodeBuffer`/`_edgeBuffer` entirely. Keep small `_pendingFunctions` map for deferred writes.**

- Most nodes/edges: write directly to graph via `bufferNode`/`bufferEdge` → goes to RFDBClient batch
- Function nodes only: stored in `_pendingFunctions: Map<string, GraphNode>`, flushed AFTER domain builders run
- This allows ModuleRuntimeBuilder to mutate function metadata before flush

**Why this works:**
- Function nodes = ~20-50 per file vs 1000+ total nodes
- Only functions need deferred writes (ModuleRuntimeBuilder metadata mutation)
- All other nodes can go straight to graph

## Files to Modify

1. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` — main changes
2. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/builders/types.ts` — BuilderContext interface

## Detailed Changes

### 1. GraphBuilder.ts Changes

#### 1.1. Remove buffer fields, add pendingFunctions map (lines 39-41)

**Current:**
```typescript
// Batching buffers for optimized writes
private _nodeBuffer: GraphNode[] = [];
private _edgeBuffer: GraphEdge[] = [];
```

**Replace with:**
```typescript
// Pending function nodes (deferred until domain builders can mutate metadata)
private _pendingFunctions: Map<string, GraphNode> = new Map();
```

#### 1.2. Update _createContext() to use pendingFunctions (line 75)

**Current:**
```typescript
findBufferedNode: (id) => this._nodeBuffer.find(n => n.id === id),
```

**Replace with:**
```typescript
findBufferedNode: (id) => this._pendingFunctions.get(id),
```

#### 1.3. Rewrite _bufferNode() for direct writes (lines 89-91)

**Current:**
```typescript
private _bufferNode(node: GraphNode): void {
  this._nodeBuffer.push(node);
}
```

**Replace with:**
```typescript
/**
 * Buffer a node for batched writing.
 * Function nodes are deferred to allow metadata mutation by ModuleRuntimeBuilder.
 * All other nodes write directly to graph (goes to RFDBClient batch).
 */
private _bufferNode(node: GraphNode, graph: GraphBackend): void {
  // Defer function nodes until domain builders finish
  if (node.type === 'FUNCTION') {
    // Brand node now (before storing in map)
    const branded = brandNodeInternal(node as unknown as NodeRecord);
    this._pendingFunctions.set(node.id, branded as unknown as GraphNode);
  } else {
    // Write directly to graph (goes to RFDBClient batch)
    const branded = brandNodeInternal(node as unknown as NodeRecord);
    void graph.addNode(branded);
  }
}
```

**Note:** This requires passing `graph` to `_bufferNode()`. Will be addressed in section 1.5.

#### 1.4. Rewrite _bufferEdge() for direct writes (lines 96-98)

**Current:**
```typescript
private _bufferEdge(edge: GraphEdge): void {
  this._edgeBuffer.push(edge);
}
```

**Replace with:**
```typescript
/**
 * Buffer an edge for batched writing.
 * Edges write directly to graph (goes to RFDBClient batch).
 */
private _bufferEdge(edge: GraphEdge, graph: GraphBackend): void {
  void graph.addEdge(edge);
}
```

#### 1.5. Update _createContext() to pass graph to buffer methods (lines 69-84)

**Current:**
```typescript
private _createContext(): BuilderContext {
  return {
    bufferNode: (node) => this._bufferNode(node),
    bufferEdge: (edge) => this._bufferEdge(edge),
    // ... rest
  };
}
```

**Problem:** Context is created in constructor (line 56), but graph is only available in `build()`.

**Solution:** Make context creation lazy — create it in `build()` method instead of constructor.

**Changes:**
- Remove `_createContext()` method entirely
- Remove context creation from constructor (line 56)
- Store builders as uninitialized in constructor
- Initialize context and builders in `build()` method

**Constructor changes (lines 55-67):**

**Current:**
```typescript
constructor() {
  const ctx = this._createContext();
  this._coreBuilder = new CoreBuilder(ctx);
  this._controlFlowBuilder = new ControlFlowBuilder(ctx);
  this._assignmentBuilder = new AssignmentBuilder(ctx);
  this._callFlowBuilder = new CallFlowBuilder(ctx);
  this._mutationBuilder = new MutationBuilder(ctx);
  this._updateExpressionBuilder = new UpdateExpressionBuilder(ctx);
  this._returnBuilder = new ReturnBuilder(ctx);
  this._yieldBuilder = new YieldBuilder(ctx);
  this._typeSystemBuilder = new TypeSystemBuilder(ctx);
  this._moduleRuntimeBuilder = new ModuleRuntimeBuilder(ctx);
}
```

**Replace with:**
```typescript
// Builders (initialized lazily in build() with graph-aware context)
private _coreBuilder?: CoreBuilder;
private _controlFlowBuilder?: ControlFlowBuilder;
private _assignmentBuilder?: AssignmentBuilder;
private _callFlowBuilder?: CallFlowBuilder;
private _mutationBuilder?: MutationBuilder;
private _updateExpressionBuilder?: UpdateExpressionBuilder;
private _returnBuilder?: ReturnBuilder;
private _yieldBuilder?: YieldBuilder;
private _typeSystemBuilder?: TypeSystemBuilder;
private _moduleRuntimeBuilder?: ModuleRuntimeBuilder;

constructor() {
  // Builders initialized in build() when graph is available
}
```

**Update builder field declarations (lines 43-53):**

**Current:**
```typescript
private readonly _coreBuilder: CoreBuilder;
private readonly _controlFlowBuilder: ControlFlowBuilder;
// ... etc
```

**Replace with:**
```typescript
private _coreBuilder?: CoreBuilder;
private _controlFlowBuilder?: ControlFlowBuilder;
// ... etc (remove readonly, add ? for optional)
```

#### 1.6. Initialize context and builders at start of build() (after line 155)

**Add after line 155 (after `this._edgeBuffer = [];`):**

```typescript
// Initialize builders with graph-aware context (lazily, on first build)
if (!this._coreBuilder) {
  const ctx: BuilderContext = {
    bufferNode: (node) => this._bufferNode(node, graph),
    bufferEdge: (edge) => this._bufferEdge(edge, graph),
    isCreated: (key) => this._createdSingletons.has(key),
    markCreated: (key) => { this._createdSingletons.add(key); },
    findBufferedNode: (id) => this._pendingFunctions.get(id),
    findFunctionByName: (functions, name, file, callScopeId) =>
      this.findFunctionByName(functions, name, file, callScopeId),
    resolveVariableInScope: (name, scopePath, file, variables) =>
      this.resolveVariableInScope(name, scopePath, file, variables),
    resolveParameterInScope: (name, scopePath, file, parameters) =>
      this.resolveParameterInScope(name, scopePath, file, parameters),
    scopePathsMatch: (a, b) => this.scopePathsMatch(a, b),
  };

  this._coreBuilder = new CoreBuilder(ctx);
  this._controlFlowBuilder = new ControlFlowBuilder(ctx);
  this._assignmentBuilder = new AssignmentBuilder(ctx);
  this._callFlowBuilder = new CallFlowBuilder(ctx);
  this._mutationBuilder = new MutationBuilder(ctx);
  this._updateExpressionBuilder = new UpdateExpressionBuilder(ctx);
  this._returnBuilder = new ReturnBuilder(ctx);
  this._yieldBuilder = new YieldBuilder(ctx);
  this._typeSystemBuilder = new TypeSystemBuilder(ctx);
  this._moduleRuntimeBuilder = new ModuleRuntimeBuilder(ctx);
}
```

#### 1.7. Update build() to reset pendingFunctions instead of buffers (line 154)

**Current:**
```typescript
// Reset buffers for this build
this._nodeBuffer = [];
this._edgeBuffer = [];
```

**Replace with:**
```typescript
// Reset pending functions for this build
this._pendingFunctions.clear();
```

#### 1.8. Replace _flushNodes() and _flushEdges() with _flushPendingFunctions() (lines 100-127)

**Remove these two methods entirely:**
- `_flushNodes()` (lines 100-113)
- `_flushEdges()` (lines 115-127)

**Add new method:**
```typescript
/**
 * Flush pending function nodes to the graph.
 * Called after domain builders finish (so ModuleRuntimeBuilder can mutate metadata).
 */
private async _flushPendingFunctions(graph: GraphBackend): Promise<number> {
  if (this._pendingFunctions.size > 0) {
    const nodes = Array.from(this._pendingFunctions.values());
    await graph.addNodes(nodes as unknown as Parameters<GraphBackend['addNodes']>[0]);
    const count = this._pendingFunctions.size;
    this._pendingFunctions.clear();
    return count;
  }
  return 0;
}
```

#### 1.9. Update build() to flush pending functions after domain builders (lines 278-280)

**Current:**
```typescript
// FLUSH: Write all nodes first, then edges in single batch calls
const nodesCreated = await this._flushNodes(graph);
const edgesCreated = await this._flushEdges(graph);
```

**Replace with:**
```typescript
// FLUSH: Write pending function nodes (domain builders already wrote everything else directly)
const functionsCreated = await this._flushPendingFunctions(graph);
```

#### 1.10. Update return statement to reflect new counting (line 292)

**Current:**
```typescript
return { nodes: nodesCreated, edges: edgesCreated + classAssignmentEdges };
```

**Problem:** We can't count nodes/edges written directly to graph (they go straight to RFDBClient batch).

**Solution:** Return function count + estimate, or mark as unknown.

**Replace with:**
```typescript
// Note: Most nodes/edges written directly to graph (during buffer calls).
// We only count pending functions + post-flush operations.
return {
  nodes: functionsCreated, // Only counts deferred function nodes
  edges: classAssignmentEdges // Only counts post-flush CLASS edges
};
```

**Alternative (if tests depend on accurate counts):** Add counters in `_bufferNode()` and `_bufferEdge()`:

```typescript
private _directNodeCount = 0;
private _directEdgeCount = 0;

// In _bufferNode():
if (node.type === 'FUNCTION') {
  // ... store in map
} else {
  this._directNodeCount++;
  // ... write to graph
}

// In _bufferEdge():
this._directEdgeCount++;
// ... write to graph

// Reset in build():
this._directNodeCount = 0;
this._directEdgeCount = 0;

// Return in build():
return {
  nodes: this._directNodeCount + functionsCreated,
  edges: this._directEdgeCount + classAssignmentEdges
};
```

**Decision:** Use counters approach to maintain test compatibility.

#### 1.11. Update builder delegate calls to use non-null assertion (lines 267-276)

**Current:**
```typescript
this._coreBuilder.buffer(module, data);
this._controlFlowBuilder.buffer(module, data);
// ... etc
```

**Replace with (add ! assertion since builders are now optional):**
```typescript
this._coreBuilder!.buffer(module, data);
this._controlFlowBuilder!.buffer(module, data);
// ... etc (add ! to all 10 builder calls)
```

### 2. BuilderContext Interface Changes

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/builders/types.ts`

#### 2.1. Update findBufferedNode documentation (line 32)

**Current comment (line 31):**
```typescript
// Buffered node lookup (for metadata updates, e.g., rejection patterns)
findBufferedNode(id: string): GraphNode | undefined;
```

**Replace with:**
```typescript
// Pending function node lookup (for metadata updates by ModuleRuntimeBuilder)
// Only function nodes are deferred; all other nodes written directly to graph.
findBufferedNode(id: string): GraphNode | undefined;
```

## Order of Changes

1. **Update types.ts** — BuilderContext documentation (low risk, documentation only)
2. **Update GraphBuilder.ts** in this order:
   - Step 1: Change builder fields to optional (lines 43-53)
   - Step 2: Empty constructor body (lines 55-67)
   - Step 3: Remove `_createContext()` method (lines 69-84)
   - Step 4: Replace `_nodeBuffer`/`_edgeBuffer` with `_pendingFunctions` map (lines 39-41)
   - Step 5: Add `_directNodeCount`/`_directEdgeCount` counters (after line 38)
   - Step 6: Rewrite `_bufferNode()` with graph parameter (lines 89-91 → expand to ~15 lines)
   - Step 7: Rewrite `_bufferEdge()` with graph parameter (lines 96-98 → expand to ~5 lines)
   - Step 8: Replace `_flushNodes()` and `_flushEdges()` with `_flushPendingFunctions()` (lines 100-127)
   - Step 9: Update `build()` — reset counters (after line 151)
   - Step 10: Update `build()` — add lazy context initialization (after line 155)
   - Step 11: Update `build()` — add ! assertions to builder calls (lines 267-276)
   - Step 12: Update `build()` — replace flush calls (lines 278-280)
   - Step 13: Update `build()` — fix return statement (line 292)

## Risk Assessment

**Overall Risk: LOW-MEDIUM**

### Low Risk Areas
- `_pendingFunctions` map implementation — simple Map operations
- `findBufferedNode()` change — just `.get()` instead of `.find()`
- Documentation updates

### Medium Risk Areas
- **Lazy builder initialization:** Builders created on first `build()` call instead of constructor
  - Risk: If GraphBuilder is instantiated but never used, builders stay uninitialized
  - Mitigation: `build()` is always called (GraphBuilder only used by JSASTAnalyzer)

- **Direct writes to graph:** `bufferNode()`/`bufferEdge()` now call `graph.addNode()`/`addEdge()` directly
  - Risk: If RFDBClient batch isn't active, writes fail
  - Mitigation: PhaseRunner already wraps all plugins in beginBatch/commitBatch (PhaseRunner.ts:73-99)

- **Function node branding timing:** Moved from `_flushNodes()` to `_bufferNode()`
  - Risk: If branding needs to happen AFTER metadata mutations, this breaks ModuleRuntimeBuilder
  - Mitigation: Branding happens when function stored in map (before mutation). Metadata field is preserved.

### Critical Paths to Test
1. **ModuleRuntimeBuilder metadata mutation:** Ensure `findBufferedNode()` still finds function nodes and metadata persists
2. **Node/edge counting:** Ensure `BuildResult` counts are accurate (tests may depend on this)
3. **Batch lifecycle:** Ensure all writes happen inside beginBatch/commitBatch (no writes outside batch)

## Tests to Check

### Unit Tests
Run full test suite with emphasis on:

```bash
node --test test/unit/GraphBuilder.test.js          # Direct GraphBuilder tests
node --test test/unit/JSASTAnalyzer.test.js         # Integration with analyzer
node --test test/unit/ModuleRuntimeBuilder.test.js  # Metadata mutation tests
node --test test/unit/PhaseRunner.test.js           # Batch lifecycle tests
```

### Integration Tests
If integration tests exist, check:
- Full file analysis (multiple phases)
- Large files (stress test batch system)
- Files with Promise rejection patterns (ModuleRuntimeBuilder edge case)

### Manual Verification
After tests pass, check RFDB logs for:
- No writes outside beginBatch/commitBatch
- Function nodes written AFTER other nodes (order matters for ModuleRuntimeBuilder)
- Edge count matches expected (no missing edges)

## Expected Outcomes

### Performance
- **Memory:** ~40% reduction in peak memory during analysis (1 buffer layer removed)
- **Speed:** Negligible impact (direct writes still go to RFDBClient batch)

### Behavioral Changes
- **None.** This is a pure refactoring — output graph should be identical.

### Code Metrics
- **Lines removed:** ~50 (buffer array declarations, flush methods)
- **Lines added:** ~30 (pendingFunctions map, counters, direct write logic)
- **Net change:** -20 lines

## Rollback Plan

If tests fail or unexpected issues arise:

1. **Revert commit** — changes are isolated to 2 files
2. **Alternative approach:** Keep `_nodeBuffer` for functions only, remove `_edgeBuffer`
3. **Fallback:** Document triple buffering as "known complexity" and defer fix

## Success Criteria

- [ ] All tests pass (unit + integration)
- [ ] RFDB logs show no writes outside batch
- [ ] Memory profiling shows reduced peak usage
- [ ] ModuleRuntimeBuilder metadata mutation still works
- [ ] Node/edge counts in BuildResult are accurate

## Notes for Kent & Rob

- **Kent:** Write tests that lock current behavior of `findBufferedNode()` — ensure ModuleRuntimeBuilder can still mutate function metadata
- **Rob:** Follow the step order exactly — lazy initialization is tricky, test after each step
- **Both:** Watch for TypeScript errors around optional builders — add ! assertions liberally after initialization check

## References

- PhaseRunner batch wrapping: `packages/core/src/core/PhaseRunner.ts:73-99`
- ModuleRuntimeBuilder metadata mutation: `packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts:405`
- RFDBClient batch implementation: `packages/rfdb-client/src/backends/RFDBServerBackend.ts`
