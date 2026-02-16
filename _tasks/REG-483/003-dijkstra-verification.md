# REG-483: Plan Verification — Dijkstra

**Date:** 2026-02-16
**Verdict:** REJECT

## Core Principle

"I don't THINK it handles all cases — I PROVE it, by enumeration."

## Verification Summary

The plan contains **three critical gaps** that will cause runtime failures or incorrect behavior:

1. **Graph closure is stale** — lazy builder initialization captures `graph` from first `build()` call, but that graph object can change
2. **`_bufferNode` classification is incomplete** — plan checks `node.type === 'FUNCTION'` but domain builders create non-FUNCTION nodes that need the same deferred logic
3. **Branding timing breaks metadata** — branding happens BEFORE ModuleRuntimeBuilder mutates metadata, but branding creates a NEW object reference

## Gap #1: Graph Closure Staleness (CRITICAL)

### Input Universe: What happens on multiple `build()` calls?

GraphBuilder is instantiated ONCE by JSASTAnalyzer (line 35 of GraphBuilder.ts), then its `build()` method is called MULTIPLE times:
- Once per module in worker pool path (JSASTAnalyzer.ts:526)
- Once per module in single-file fallback path (JSASTAnalyzer.ts:1860)

| Call # | graph parameter | ctx.bufferNode closure references | Result |
|--------|-----------------|-----------------------------------|--------|
| 1 (first module) | graphA | graphA (captured) | OK — writes go to graphA |
| 2 (second module) | graphA | graphA (stale) | OK — same object |
| 3 (different backend?) | graphB | graphA (stale!) | BROKEN — writes go to wrong backend |

**Plan's assumption:** "graph is always the same object across calls"

**Reality check:** JSASTAnalyzer creates GraphBuilder once in constructor, then calls `build()` for each module. The graph OBJECT is the same across calls **within a single analysis run**. BUT:

1. If analyzer is reused across different projects (edge case), graph could change
2. Test suites that reuse GraphBuilder instance with different backends will break
3. The closure captures graph on FIRST call — if `build()` errors on first call and succeeds on second, closure still references failed backend

**Verdict:** MEDIUM RISK — unlikely in production, but test brittleness is real.

**Fix needed:** Don't use closure. Two options:
- **Option A:** Store `graph` as private field, update it on every `build()` call (NOT lazy)
- **Option B:** Pass `graph` to domain builders via BuilderContext (NOT via closure)

**Recommended:** Option B — BuilderContext already has methods; add a `graph` field.

## Gap #2: `_bufferNode` Classification is Incomplete (CRITICAL)

### Input Universe: What node types go through `_bufferNode()`?

#### Direct calls in GraphBuilder.build() (lines 157-264):

| Node Type | Created at line | Goes through _bufferNode? |
|-----------|----------------|---------------------------|
| FUNCTION | 175 | YES (directly) |
| SCOPE | 181 | YES |
| BRANCH | 188 | YES |
| CASE | 194 | YES |
| LOOP | 205 | YES |
| TRY_BLOCK | 210 | YES |
| CATCH_BLOCK | 216 | YES |
| FINALLY_BLOCK | 222 | YES |
| VARIABLE | 227 | YES |
| PARAMETER | 234 | YES |
| CALL_SITE | 249 | YES |
| CONSTRUCTOR_CALL | 254 | YES |

#### Indirect calls via domain builders (through `ctx.bufferNode`):

**ModuleRuntimeBuilder** creates:
- IMPORT nodes (lines 73, 121)
- EXTERNAL_MODULE nodes (lines 89, 137)
- EXPORT nodes (lines 165, 187, 204, 224)
- STDIO nodes (net:stdio singleton, line 245)
- EVENT_LISTENER nodes (line 264)
- HTTP_REQUEST nodes (net:request singleton, line 295)
- EVENT_LISTENER nodes (line 302)

**Other builders** (not exhaustively checked, but pattern holds):
- CoreBuilder: creates MODULE, CLASS nodes
- TypeSystemBuilder: creates INTERFACE, TYPE_ALIAS, ENUM nodes
- ControlFlowBuilder: likely creates control flow expression nodes
- etc.

### Plan's Classification Rule

```typescript
if (node.type === 'FUNCTION') {
  // defer to _pendingFunctions
} else {
  // write directly
}
```

### Completeness Table

| Node Type | Needs findBufferedNode? | Handled by plan? | Gap? |
|-----------|------------------------|------------------|------|
| FUNCTION | YES (ModuleRuntimeBuilder mutates metadata at line 405-419) | YES | ✓ |
| IMPORT | NO | YES (direct write) | ✓ |
| EXPORT | NO | YES (direct write) | ✓ |
| EXTERNAL_MODULE | NO | YES (direct write) | ✓ |
| STDIO | NO | YES (direct write) | ✓ |
| HTTP_REQUEST | NO | YES (direct write) | ✓ |
| EVENT_LISTENER | NO | YES (direct write) | ✓ |
| SCOPE | NO | YES (direct write) | ✓ |
| VARIABLE | NO | YES (direct write) | ✓ |
| PARAMETER | NO | YES (direct write) | ✓ |
| CALL_SITE | NO | YES (direct write) | ✓ |
| CONSTRUCTOR_CALL | NO | YES (direct write) | ✓ |
| BRANCH | NO | YES (direct write) | ✓ |
| CASE | NO | YES (direct write) | ✓ |
| LOOP | NO | YES (direct write) | ✓ |
| TRY_BLOCK | NO | YES (direct write) | ✓ |
| CATCH_BLOCK | NO | YES (direct write) | ✓ |
| FINALLY_BLOCK | NO | YES (direct write) | ✓ |
| MODULE | NO | YES (direct write, not in _bufferNode) | ✓ |
| CLASS | NO | YES (direct write, CoreBuilder) | ✓ |
| INTERFACE | NO | YES (direct write, TypeSystemBuilder) | ✓ |
| TYPE_ALIAS | NO | YES (direct write, TypeSystemBuilder) | ✓ |
| ENUM | NO | YES (direct write, TypeSystemBuilder) | ✓ |

**Verdict:** Plan's rule is CORRECT for all known node types. Only FUNCTION nodes need deferral.

**BUT:** The plan doesn't explicitly document WHY only FUNCTION. If future code adds metadata mutation for other node types (e.g., CLASS metadata), the rule will break silently.

**Recommendation:** Add a comment explaining the invariant:
```typescript
// Only FUNCTION nodes are deferred because ModuleRuntimeBuilder mutates their
// metadata (rejectionPatterns) after buffering. If other node types need
// post-buffer mutation in the future, add them to _pendingFunctions.
```

## Gap #3: Branding Timing Breaks Metadata Mutation (CRITICAL)

### The Problem

Plan says (lines 86-88):
```typescript
const branded = brandNodeInternal(node as unknown as NodeRecord);
this._pendingFunctions.set(node.id, branded as unknown as GraphNode);
```

**Sequence:**
1. FUNCTION node created (line 175 in build())
2. `_bufferNode()` called → brands node → stores in `_pendingFunctions`
3. Domain builders run (line 276) → ModuleRuntimeBuilder.bufferRejectionEdges()
4. ModuleRuntimeBuilder calls `ctx.findBufferedNode(functionId)` (line 405)
5. Mutates node: `node.metadata.rejectionPatterns = ...` (lines 408-418)
6. Later: `_flushPendingFunctions()` writes branded node to graph

**The question:** Does branding preserve the object reference, or does it create a new object?

### Checking brandNodeInternal implementation

From `/Users/vadimr/grafema/packages/core/src/core/brandNodeInternal.ts`:

```typescript
export function brandNodeInternal<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return node as BrandedNode<T>;
}
```

**Verdict:** Branding is a TYPE-ONLY cast. No new object created. The mutation will affect the same object reference.

**BUT:** The plan casts the result:
```typescript
const branded = brandNodeInternal(node as unknown as NodeRecord);
this._pendingFunctions.set(node.id, branded as unknown as GraphNode);
```

If `branded` is stored and `node` is mutated later, does the mutation affect `branded`?

**Answer:** YES — they're the same object reference (TypeScript casting is compile-time only).

**Verdict:** Plan is CORRECT on branding timing. Mutation will work.

## Gap #4: Return Value Counting (MINOR)

Plan proposes counters (section 1.10):

```typescript
private _directNodeCount = 0;
private _directEdgeCount = 0;
```

### Completeness Table for Counters

| Operation | Increments counter? | Included in return? |
|-----------|-------------------|---------------------|
| FUNCTION nodes written directly in build() | NO | NO (deferred) |
| FUNCTION nodes flushed from _pendingFunctions | YES (functionsCreated) | YES |
| Non-FUNCTION nodes written directly in build() | YES (_directNodeCount++) | YES |
| Nodes created by domain builders (ctx.bufferNode) | YES (_directNodeCount++) | YES |
| Edges created directly in build() | YES (_directEdgeCount++) | YES |
| Edges created by domain builders (ctx.bufferEdge) | YES (_directEdgeCount++) | YES |
| CLASS assignment edges (post-flush) | NO | YES (classAssignmentEdges) |

**Problem:** Domain builders call `ctx.bufferNode()`, which now writes directly to graph. The counter increments are inside `_bufferNode()`, so they COUNT builder-created nodes.

**Verdict:** Counting is CORRECT if counters increment for ALL paths through `_bufferNode()` and `_bufferEdge()`.

**But:** Plan doesn't show where domain builder nodes increment counters. The code says:

```typescript
// In _bufferNode():
if (node.type === 'FUNCTION') {
  // ... store in map
} else {
  this._directNodeCount++;
  // ... write to graph
}
```

This increments for nodes created in `build()` directly AND for nodes from domain builders (they go through the same `_bufferNode()` method).

**Verdict:** Plan is CORRECT on counting.

## Preconditions & Invariants

### Precondition 1: PhaseRunner wraps all plugins in beginBatch/commitBatch

**Check:** PhaseRunner.ts lines 91-94:
```typescript
graph.beginBatch();
try {
  const result = await plugin.execute(pluginContext);
  const delta = await graph.commitBatch(tags);
```

**Verdict:** ✓ Confirmed. All plugin executions are wrapped.

**BUT:** What if `graph.beginBatch` is undefined? Line 81 checks:
```typescript
if (!graph.beginBatch || !graph.commitBatch || !graph.abortBatch) {
  const result = await plugin.execute(pluginContext);
  return { result, delta: null };
}
```

If backend doesn't support batching, direct execution (no batch). In that case, `_bufferNode()` calls `graph.addNode()` OUTSIDE a batch.

**Does RFDBServerBackend support batching?** YES (line 764-776 in RFDBServerBackend.ts).

**Does InMemoryBackend support batching?** Need to check tests.

**Risk:** If tests use a mock backend without batching, direct writes will fail.

**Verdict:** MEDIUM RISK — production is safe, but test mocks must implement batching.

### Precondition 2: `graph` object is the same across calls

Already covered in Gap #1. REJECT.

### Invariant 1: Function nodes written AFTER domain builders run

Plan says (line 281-282):
```typescript
// FLUSH: Write pending function nodes (domain builders already wrote everything else directly)
const functionsCreated = await _flushPendingFunctions(graph);
```

**Sequence in build():**
1. Lines 157-264: Buffer nodes (functions deferred, others direct to graph)
2. Lines 267-276: Domain builders run (write directly to graph)
3. Line 282: Flush pending functions

**Invariant:** All non-function nodes are in graph BEFORE function nodes.

**Does this matter?** Not for correctness — nodes don't reference each other's IDs during creation. Edges are separate.

**But:** ModuleRuntimeBuilder mutates function metadata DURING domain builder phase (line 405). If function isn't in `_pendingFunctions` yet, mutation fails.

**Check sequence:**
1. Line 175: FUNCTION nodes added to `_pendingFunctions` (via `_bufferNode`)
2. Line 276: ModuleRuntimeBuilder runs → finds function in `_pendingFunctions` → mutates metadata
3. Line 282: Functions flushed to graph

**Verdict:** ✓ Sequence is correct. Functions are in `_pendingFunctions` BEFORE ModuleRuntimeBuilder runs.

### Invariant 2: Edges can reference nodes not yet written

**Current behavior:** All nodes flushed first (line 279), then all edges (line 280).

**New behavior:** Nodes/edges interleave in RFDBClient batch arrays:
- Direct nodes written as they're buffered
- Edges written as they're buffered
- Function nodes written at end

**Example sequence:**
1. IMPORT node written → `graph.addNode()` → batched
2. MODULE→IMPORT edge written → `graph.addEdge()` → batched
3. FUNCTION node deferred
4. FUNCTION→PARAMETER edge written → `graph.addEdge()` → batched
5. Function node flushed → `graph.addNodes()` → batched

**Question:** Does `commitBatch()` validate edge references?

From RFDBServerBackend.ts line 121:
```typescript
await (graph as GraphBackend & { addEdges(e: GraphEdge[], skip?: boolean): Promise<void> })
  .addEdges(this._edgeBuffer, true /* skip_validation */);
```

Plan removes `_edgeBuffer`, so edges go directly to `graph.addEdge()` during buffering. Does `addEdge()` validate immediately or defer to commitBatch?

**Need to check:** Does RFDBClient batch `addEdge()` calls?

From RFDBServerBackend.ts line 376-377:
```typescript
async addEdge(edge: InputEdge): Promise<void> {
  return this.addEdges([edge]);
}
```

And line 383:
```typescript
async addEdges(edges: InputEdge[], skipValidation = false): Promise<void> {
  if (!this.client) throw new Error('Not connected');
  if (!edges.length) return;
```

So `addEdge()` delegates to `addEdges()`, which delegates to `client.addEdges()`.

**Does client buffer during batch?** The plan assumes YES (PhaseRunner wraps in beginBatch/commitBatch), but doesn't verify.

**Critical assumption:** RFDBClient's `addNodes()`/`addEdges()` MUST buffer during batch, not send immediately.

**Verdict:** NEEDS VERIFICATION — plan doesn't prove client batching behavior.

**Risk:** If client sends immediately, edges referencing deferred functions will fail validation.

## Edge Cases by Construction

### Empty input
- `functions = []` → `_pendingFunctions` stays empty → flush returns 0
- `data = {}` → no nodes, no edges → counters return 0

**Verdict:** ✓ Handled.

### Single function, no other nodes
- Function deferred → domain builders run → function flushed
- Edges written directly during buffer calls

**Verdict:** ✓ Handled.

### All nodes are functions
- All deferred → domain builders run → all flushed at end

**Verdict:** ✓ Handled.

### build() called twice (reuse)

**Current plan:**
```typescript
// In build():
if (!this._coreBuilder) {
  // initialize context with closure over graph
  const ctx: BuilderContext = {
    bufferNode: (node) => this._bufferNode(node, graph), // closure!
    // ...
  };
  this._coreBuilder = new CoreBuilder(ctx);
  // ...
}
```

**Second call:**
- Builders already exist → context NOT recreated → closures still reference FIRST graph

**Verdict:** BROKEN — see Gap #1.

### build() errors on first call

**Sequence:**
1. First `build()` call → initializes builders → errors before flush
2. Second `build()` call → builders exist → skips initialization → uses old closure

**Verdict:** BROKEN — same as Gap #1.

## Summary of Gaps

| Gap | Severity | Impact |
|-----|----------|--------|
| #1: Graph closure staleness | CRITICAL | Will break if graph changes between calls (tests, multi-project) |
| #2: _bufferNode classification | OK | Rule is correct, but needs documentation |
| #3: Branding timing | OK | Branding is type-only cast, mutation works |
| #4: Return value counting | OK | Counters are correct |
| Precondition: Batch wrapping | OK | PhaseRunner wraps, but test mocks need batching support |
| Precondition: Graph stability | CRITICAL | See Gap #1 |
| Invariant: Function ordering | OK | Functions flushed after domain builders |
| Invariant: Edge validation | NEEDS VERIFICATION | Client batching behavior not proven |

## Verdict: REJECT

**Critical issues:**

1. **Graph closure staleness** — Lazy initialization captures `graph` on first call, but reused on subsequent calls. If graph changes (different backend, test reuse), writes go to wrong backend.

2. **Client batching behavior not verified** — Plan assumes RFDBClient buffers `addNode()`/`addEdge()` calls during batch, but doesn't prove it. If client sends immediately, edges referencing deferred functions will fail validation.

## Required Changes Before Implementation

### Fix #1: Remove closure, use field or context

**Option A:** Store graph as field, update on every build():
```typescript
private _graph?: GraphBackend;

async build(module, graph, projectPath, data) {
  this._graph = graph; // update every call
  // ... rest
}

private _bufferNode(node: GraphNode): void {
  if (!this._graph) throw new Error('build() not called yet');
  if (node.type === 'FUNCTION') {
    // ...
  } else {
    void this._graph.addNode(branded);
  }
}
```

**Option B (RECOMMENDED):** Pass graph via BuilderContext:
```typescript
// In BuilderContext interface:
interface BuilderContext {
  graph: GraphBackend; // NEW field
  bufferNode: (node) => void;
  bufferEdge: (edge) => void;
  // ...
}

// In build():
const ctx: BuilderContext = {
  graph, // pass directly, no closure
  bufferNode: (node) => this._bufferNode(node, ctx),
  bufferEdge: (edge) => this._bufferEdge(edge, ctx),
  // ...
};

// Create builders ONCE in constructor with placeholder ctx:
constructor() {
  this._ctx = null; // will be initialized in build()
}

async build(module, graph, projectPath, data) {
  if (!this._ctx) {
    this._ctx = this._createContext(graph);
    this._coreBuilder = new CoreBuilder(this._ctx);
    // ...
  } else {
    // Update graph in existing context
    this._ctx.graph = graph;
  }
  // ...
}
```

**Preferred:** Option B — keeps graph in context, avoids field sprawl.

### Fix #2: Verify client batching behavior

**Add explicit check in plan:**
- Document that RFDBClient MUST buffer during `beginBatch()`/`commitBatch()`
- Add test case: verify nodes/edges not sent until `commitBatch()`
- If client doesn't batch, plan is invalid

**OR:** Read RFDBClient source to confirm batching behavior, document findings in plan.

### Fix #3: Add documentation for future maintainers

**In `_bufferNode()` comment:**
```typescript
/**
 * Buffer a node for batched writing.
 *
 * INVARIANT: Only FUNCTION nodes are deferred (stored in _pendingFunctions).
 * This is because ModuleRuntimeBuilder mutates function metadata after buffering
 * (see bufferRejectionEdges, line 405 in ModuleRuntimeBuilder.ts).
 *
 * If future code needs to mutate metadata for other node types, add them to
 * _pendingFunctions as well. All other nodes write directly to graph.
 */
```

## Next Steps for Don

1. **Fix graph closure issue** — use Option B (BuilderContext with graph field)
2. **Verify client batching** — read RFDBClient source or add test
3. **Update plan with fixes** — resubmit for verification
4. **Add documentation** — explain why only FUNCTION is deferred

After fixes, I'll re-verify the plan.
