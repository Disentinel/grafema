# Don Melton -- Revised Plan: REG-401 (post Steve Jobs rejection)

## Callback CALLS for User-Defined HOFs via Forward Registration

---

## Steve's Rejection Points (addressed)

1. **O(C) brute-force over ALL CALL nodes** -- FIXED. No enrichment plugin iterates CALL nodes at all.
2. **Missing forward registration** -- FIXED. Analysis phase marks FUNCTION nodes with `invokesParamIndexes` metadata.
3. **Consider extending CallbackCallResolver** -- ADDRESSED. We extend it rather than creating a new plugin.

---

## 1. Core Design: Forward Registration

### 1.1 The Insight

During `analyzeFunctionBody`, we already process every `CallExpression` inside a function's body. At that point, we have:

- `currentFunctionId` -- the function being analyzed
- `_parameters` collection -- all PARAMETER nodes created so far, including this function's params
- The callee name of the call expression

When we encounter `fn()` inside `function apply(fn) { fn(); }`, we can detect that `fn` is a parameter name of the current function. At that moment, we annotate the FUNCTION node's metadata:

```
FUNCTION#apply.metadata.invokesParamIndexes = [0]
```

This is **forward registration**: the analyzer marks the data, the enricher just reads it.

### 1.2 Precedent

This pattern already exists in Grafema. `rejectionPatterns` metadata is stored on FUNCTION nodes during analysis (GraphBuilder.ts, line ~3515-3533) and read by downstream enrichers. We follow the exact same pattern for `invokesParamIndexes`.

---

## 2. Algorithm

### Phase 1: Analysis (forward registration)

**Where:** `JSASTAnalyzer.analyzeFunctionBody()`, in the `CallExpression` handler (around line 4341).

**When:** After `handleCallExpression` creates the CALL node, check if the callee is an Identifier matching a parameter name of the current function.

```
For each CallExpression inside a function body:
  1. calleeName = callNode.callee.name (if Identifier)
  2. Find parameter in _parameters where:
     - parameter.parentFunctionId === currentFunctionId
     - parameter.name === calleeName
  3. If found: record parameterIndex in a local Set<number>

After traverse completes (end of analyzeFunctionBody):
  4. If invokesParamIndexes is non-empty:
     - Store on the FunctionInfo: matchingFunction.invokesParamIndexes = [...set]
```

**Why at FunctionInfo level (not node buffer)?** Because `analyzeFunctionBody` already locates `matchingFunction` from the `functions` collection (line 3718-3728). We just add a field to FunctionInfo. GraphBuilder will then propagate it to node metadata when buffering the FUNCTION node, following the same pattern as `rejectionPatterns`.

**Complexity:** O(0) additional iteration. We piggyback on the existing `CallExpression` traversal inside `analyzeFunctionBody`. The parameter lookup is O(P) where P = parameters of the current function (typically 1-5). We can optimize to O(1) with a pre-built `Set<string>` of current function's parameter names.

### Phase 2: Enrichment (edge creation)

**Where:** Extend `CallbackCallResolver.execute()`.

**Instead of iterating all CALL nodes**, iterate PASSES_ARGUMENT edges that point to FUNCTION nodes (or through VARIABLE/IMPORT chains).

Actually, let me reconsider. CallbackCallResolver currently iterates all CALL/METHOD_CALL nodes. Steve's concern is the O(C) iteration. But the current CallbackCallResolver already does this iteration for whitelist-based resolution. The question is: can we add the parameter invocation check WITHOUT additional iteration?

**Answer: Yes.** Here's how:

The enricher doesn't need to iterate CALL nodes at all for the new feature. Instead, it queries only the small set of FUNCTION nodes that have `invokesParamIndexes` metadata, then follows edges backward:

```
For each FUNCTION node T where T.metadata.invokesParamIndexes is non-empty:
  1. Get incoming CALLS edges to T (these are call sites calling T)
  2. For each call site C:
     a. Get PASSES_ARGUMENT edges from C
     b. For each PASSES_ARGUMENT edge with argIndex in T.invokesParamIndexes:
        - If target is a FUNCTION node F: create CALLS edge C -> F { callType: 'callback' }
        - If target is an IMPORT node: follow IMPORTS_FROM chain to find ultimate FUNCTION (reuse existing CallbackCallResolver logic)
        - If target is a VARIABLE: resolve to FUNCTION if possible
```

**Complexity:** O(H * A) where:
- H = number of FUNCTION nodes with `invokesParamIndexes` metadata (very small -- only user-defined HOFs)
- A = average number of incoming CALLS edges per such function (typically small)

This is dramatically better than O(C) where C = all CALL nodes in the codebase.

**How to find FUNCTION nodes with invokesParamIndexes?**

Option A: Query all FUNCTION nodes and filter by metadata. This is O(F) where F = total functions. Still potentially large.

Option B: During analysis, collect the IDs of functions with invokesParamIndexes into a separate list. The enricher receives this list directly. But enrichment plugins don't have access to analysis-phase data structures.

Option C: Use a metadata query. RFDB supports querying nodes by attributes. If we store `invokesParamIndexes` in node metadata, we can query for FUNCTION nodes that have this field.

**Best approach: Option A with early exit.** We iterate FUNCTION nodes once (which CallbackCallResolver already does for its function index at line 88-96). We simply add a check: if the function has `invokesParamIndexes` metadata, add it to a separate "HOF functions" index. This adds zero extra iteration -- we piggyback on the existing FUNCTION node iteration.

Wait -- CallbackCallResolver already iterates all FUNCTION nodes to build `functionIndex` (line 88-96). We extend this loop to also collect HOFs:

```typescript
const hofFunctions: Array<{ func: FunctionNode; paramIndexes: number[] }> = [];

for await (const node of graph.queryNodes({ nodeType: 'FUNCTION' })) {
  const func = node as FunctionNode;
  // Existing index building...

  // NEW: collect HOFs with invokesParamIndexes
  const indexes = func.metadata?.invokesParamIndexes as number[] | undefined;
  if (indexes && indexes.length > 0) {
    hofFunctions.push({ func, paramIndexes: indexes });
  }
}
```

Then, after the existing whitelist-based resolution loop, add a second pass only for HOF functions:

```typescript
for (const { func, paramIndexes } of hofFunctions) {
  // Get incoming CALLS edges (call sites that call this HOF)
  const incomingCalls = await graph.getIncomingEdges(func.id, ['CALLS']);

  for (const callEdge of incomingCalls) {
    const callNode = await graph.getNode(callEdge.src);
    if (!callNode) continue;

    // Get PASSES_ARGUMENT edges from this call site
    const passesArgEdges = await graph.getOutgoingEdges(callNode.id, ['PASSES_ARGUMENT']);

    for (const paEdge of passesArgEdges) {
      const argIndex = paEdge.metadata?.argIndex ?? paEdge.argIndex;
      if (!paramIndexes.includes(argIndex)) continue;

      // This argument is at an index that the HOF invokes
      const targetNode = await graph.getNode(paEdge.dst);
      if (!targetNode) continue;

      // Check if target is a FUNCTION (same-file callback)
      if (targetNode.type === 'FUNCTION') {
        // Check no existing callback CALLS edge
        await graph.addEdge({
          type: 'CALLS',
          src: callNode.id,
          dst: targetNode.id,
          metadata: { callType: 'callback' }
        });
        edgesCreated++;
      }
      // Check if target is IMPORT (cross-file callback) -- reuse existing chain resolution
      else if (targetNode.type === 'IMPORT') {
        // ... existing import chain resolution logic (same as current lines 157-204)
      }
    }
  }
}
```

**Key property:** `getIncomingEdges` is an indexed O(1) lookup in RFDB. No scanning required.

---

## 3. Detailed Changes

### 3.1 Analysis Phase Changes

**File: `packages/core/src/plugins/analysis/ast/types.ts`**

Add `invokesParamIndexes` to `FunctionInfo`:

```typescript
export interface FunctionInfo {
  // ... existing fields
  invokesParamIndexes?: number[];  // REG-401: Parameter indexes directly invoked as fn()
}
```

**File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**

In `analyzeFunctionBody()`:

1. After locating `matchingFunction` and `currentFunctionId` (line ~3726), build a Map of current function's parameter names to indexes:

```typescript
// REG-401: Build parameter name -> index map for invocation detection
const currentFuncParamNames = new Map<string, number>();
if (currentFunctionId) {
  for (const param of _parameters) {
    if (param.parentFunctionId === currentFunctionId && param.name && param.index !== undefined) {
      currentFuncParamNames.set(param.name, param.index);
    }
  }
}
const invokedParamIndexes = new Set<number>();
```

2. In the `CallExpression` handler (line ~4341), after `handleCallExpression`, add:

```typescript
// REG-401: Detect parameter invocation (forward registration)
if (currentFunctionId && t.isIdentifier(callNode.callee)) {
  const paramIndex = currentFuncParamNames.get(callNode.callee.name);
  if (paramIndex !== undefined) {
    invokedParamIndexes.add(paramIndex);
  }
}
```

3. At the end of `analyzeFunctionBody()` (after the traverse completes), store the metadata:

```typescript
// REG-401: Store invoked parameter indexes on function
if (invokedParamIndexes.size > 0 && matchingFunction) {
  matchingFunction.invokesParamIndexes = [...invokedParamIndexes];
}
```

**File: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`**

In the method that buffers FUNCTION nodes (around line 197), propagate `invokesParamIndexes` to node metadata:

```typescript
// REG-401: Propagate invokesParamIndexes to node metadata
if (func.invokesParamIndexes && func.invokesParamIndexes.length > 0) {
  const nodeInBuffer = this._nodeBuffer[this._nodeBuffer.length - 1]; // just-pushed node
  if (!nodeInBuffer.metadata) nodeInBuffer.metadata = {};
  (nodeInBuffer.metadata as Record<string, unknown>).invokesParamIndexes = func.invokesParamIndexes;
}
```

Actually, better approach: follow the `rejectionPatterns` pattern. The `bufferRejectionEdges` method finds the node in the buffer and sets metadata. We do the same in a dedicated method or inline in the function buffering loop.

Looking at the code more carefully (line 197):
```typescript
const { parentScopeId: _parentScopeId, ...funcData } = func;
```

`funcData` is spread into the node. If `invokesParamIndexes` is on `FunctionInfo`, it will be included in the spread. But we need it in `metadata`, not as a top-level field. Two options:

**Option A:** Strip it from the spread and put in metadata (like `parentScopeId`).
**Option B:** Store directly on the node (RFDB stores arbitrary fields via `#[serde(flatten)]`).

Actually, for consistency with `rejectionPatterns`, let's use `metadata`. But the simpler approach: RFDB flattens extra fields. If `invokesParamIndexes` is on the node, it will be persisted and queryable. Let's just include it in `funcData` spread. It will appear as a top-level field on the FUNCTION node.

Wait -- looking at the existing pattern for `rejectionPatterns`, it's stored in `metadata` sub-object (line 3520-3523). Let's follow that exact pattern. We'll add a method `bufferInvokesParamIndexes` that runs after nodes are buffered, finds FUNCTION nodes in the buffer that have `invokesParamIndexes`, and sets the metadata.

Actually, the simplest approach: strip `invokesParamIndexes` from the spread and store it in metadata during the buffering loop. Let me look at the exact buffering code.

```typescript
// Line 197 (approximate)
const { parentScopeId: _parentScopeId, ...funcData } = func;
this._bufferNode(funcData as unknown as GraphNode);
```

Change to:
```typescript
const { parentScopeId: _parentScopeId, invokesParamIndexes: _invokesParamIndexes, ...funcData } = func;
this._bufferNode(funcData as unknown as GraphNode);

// REG-401: Store invoked parameter indexes in metadata
if (_invokesParamIndexes && _invokesParamIndexes.length > 0) {
  const node = this._nodeBuffer[this._nodeBuffer.length - 1];
  if (!node.metadata) node.metadata = {};
  (node.metadata as Record<string, unknown>).invokesParamIndexes = _invokesParamIndexes;
}
```

### 3.2 Enrichment Phase Changes

**File: `packages/core/src/plugins/enrichment/CallbackCallResolver.ts`**

Extend the existing plugin. No new plugin needed.

1. In the existing FUNCTION node iteration (line 88-96), also collect HOFs:

```typescript
interface HOFInfo {
  func: FunctionNode;
  paramIndexes: number[];
}
const hofFunctions: HOFInfo[] = [];

for await (const node of graph.queryNodes({ nodeType: 'FUNCTION' })) {
  const func = node as FunctionNode;
  if (!func.file || !func.name) continue;

  // Existing index building...
  if (!functionIndex.has(func.file)) {
    functionIndex.set(func.file, new Map());
  }
  functionIndex.get(func.file)!.set(func.name, func);

  // REG-401: Collect HOFs with invokesParamIndexes
  const indexes = (func.metadata as Record<string, unknown>)?.invokesParamIndexes as number[] | undefined;
  if (indexes && indexes.length > 0) {
    hofFunctions.push({ func, paramIndexes: indexes });
  }
}
```

2. After the existing whitelist-based resolution loop (after line 205), add HOF resolution:

```typescript
// REG-401: Resolve callback CALLS for user-defined HOFs via invokesParamIndexes
for (const { func: hofFunc, paramIndexes } of hofFunctions) {
  const incomingCalls = await graph.getIncomingEdges(hofFunc.id, ['CALLS']);

  for (const callEdge of incomingCalls) {
    const callNode = await graph.getNode(callEdge.src);
    if (!callNode) continue;

    const passesArgEdges = await graph.getOutgoingEdges(callNode.id, ['PASSES_ARGUMENT']);

    for (const paEdge of passesArgEdges) {
      const argIndex = paEdge.argIndex ?? (paEdge.metadata?.argIndex as number | undefined);
      if (argIndex === undefined || !paramIndexes.includes(argIndex)) continue;

      const targetNode = await graph.getNode(paEdge.dst);
      if (!targetNode) continue;

      if (targetNode.type === 'FUNCTION') {
        // Check no existing CALLS edge from this call to this function
        const existingCalls = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
        const alreadyLinked = existingCalls.some(e => e.dst === targetNode.id && e.metadata?.callType === 'callback');
        if (!alreadyLinked) {
          await graph.addEdge({
            type: 'CALLS',
            src: callNode.id,
            dst: targetNode.id,
            metadata: { callType: 'callback' }
          });
          edgesCreated++;
        }
      }
      else if (targetNode.type === 'IMPORT') {
        // Follow IMPORTS_FROM chain (reuse existing logic from lines 160-204)
        // Extract into helper method to avoid duplication
      }
    }
  }
}
```

3. Extract the import chain resolution logic (lines 157-204) into a private helper method to reuse between whitelist-based and HOF-based resolution.

### 3.3 Test Changes

**File: `test/unit/CallbackFunctionReference.test.js`**

- Flip test 5 assertion: custom HOF `myHOF(fn)` where `myHOF` invokes `fn()` should NOW create callback CALLS edge
- Keep test 12: store/register pattern should NOT create callback CALLS edge
- Add new test cases:
  - `function apply(fn) { fn(); } apply(handler)` -- CALLS edge created
  - `function store(fn) { registry.push(fn); } store(handler)` -- no CALLS edge
  - `function noop(fn) {} noop(handler)` -- no CALLS edge
  - `function applySecond(a, fn) { fn(); } applySecond(1, handler)` -- CALLS edge for index 1 only
  - `function applyBoth(fn1, fn2) { fn1(); fn2(); } applyBoth(a, b)` -- CALLS edges for both

---

## 4. Complexity Analysis

| Operation | Complexity | Where |
|---|---|---|
| Parameter invocation detection | O(0) extra | Piggybacks on existing CallExpression traversal in analyzeFunctionBody |
| Parameter name lookup | O(1) per call | Pre-built Map<string, number> |
| FUNCTION node iteration (enrichment) | O(F) once | Already done by CallbackCallResolver for functionIndex |
| HOF resolution | O(H * K) | H = HOFs with metadata (tiny), K = avg incoming CALLS per HOF (small) |
| Import chain resolution | O(1) per edge | Graph lookups |

**Total enrichment cost of new feature: O(H * K)** -- negligible compared to existing O(F) function indexing that CallbackCallResolver already performs.

**No iteration over all CALL nodes.** The new code never queries CALL nodes. It only follows edges from known HOF FUNCTION nodes backward.

---

## 5. Files Changed

| File | Change | Scope |
|---|---|---|
| `packages/core/src/plugins/analysis/ast/types.ts` | Add `invokesParamIndexes?: number[]` to FunctionInfo | 1 line |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Forward registration in analyzeFunctionBody | ~15 lines |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Propagate invokesParamIndexes to metadata | ~5 lines |
| `packages/core/src/plugins/enrichment/CallbackCallResolver.ts` | Extend with HOF resolution | ~40 lines |
| `test/unit/CallbackFunctionReference.test.js` | Flip test 5, add new test cases | ~50 lines |

**Total: ~110 lines of production code, ~50 lines of tests.**

No new files. No new plugins. No new iterations over large node sets.

---

## 6. Edge Cases

| Case | Handling | Rationale |
|---|---|---|
| `fn.call(thisArg)` / `fn.apply()` | Not detected | Callee is MemberExpression, not Identifier. Future enhancement. |
| Destructured params `({fn}) => fn()` | Not detected | Destructured params not created yet (createParameterNodes.ts line 29). |
| Rest params `(...fns) => fns[0]()` | Not detected | Array access invocation, not direct call. |
| Aliased params `(fn) => { const f = fn; f(); }` | Not detected | Requires intra-procedural data flow. Future enhancement. |
| Nested invocation `(fn) => setTimeout(fn, 0)` | Not detected by this feature | But whitelist catches `setTimeout` at inner level anyway. |
| Shadowed param name | Correct | analyzeFunctionBody traversal skips nested functions (line 4100-4145: FunctionDeclaration handler calls path.skip). So `fn` inside a nested function won't be attributed to the outer function's parameter. |
| Cross-file HOF | Works | HOF's FUNCTION node gets metadata during analysis of its source file. Enricher reads metadata regardless of file. CALLS edges from call sites to imported HOFs are already resolved. |

---

## 7. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Shadowed parameter name in nested scope | False positive | Very low | Nested functions are traversed recursively via analyzeFunctionBody with their own scope. The outer function's CallExpression handler only sees calls at its own level. |
| Performance regression | None | None | Zero additional iteration. Piggybacks on existing loops. |
| Breaking existing tests | Intentional | Certain | Test 5 assertion flip is the whole point of REG-401. |
| getIncomingEdges not available | Blocks enrichment | Low | Check RFDB API. If not available, use alternative: iterate CALL nodes once (like current code) but only for whitelist AND HOF check in same pass. |

---

## 8. Implementation Order

1. **Kent: Write tests first** -- new test cases + flip test 5 expectation
2. **Rob: Add `invokesParamIndexes` to FunctionInfo type** (types.ts)
3. **Rob: Forward registration in analyzeFunctionBody** (JSASTAnalyzer.ts)
4. **Rob: Propagate metadata in GraphBuilder** (GraphBuilder.ts)
5. **Rob: Extend CallbackCallResolver** (CallbackCallResolver.ts)
6. **Verify: All tests pass**

**Estimated scope:** Small. ~110 lines production, ~50 lines tests. Straightforward graph traversal using existing patterns.

---

## 9. Addressing Steve's Specific Concerns

| Steve's Concern | How Addressed |
|---|---|
| "O(C) brute-force iteration over ALL CALL nodes" | Enricher never iterates CALL nodes for the new feature. It follows edges backward from HOF FUNCTION nodes. |
| "Building Map<parentScopeId, CALL[]> requires scanning ALL CALL nodes" | Eliminated entirely. No such index needed. Forward registration stores metadata on FUNCTION nodes. |
| "Missing forward registration" | Analysis phase detects parameter invocation and stores `invokesParamIndexes` in FUNCTION node metadata. Enricher just reads it. |
| "Consider extending CallbackCallResolver" | Done. Single plugin, no new plugin. HOF resolution added as second pass after existing whitelist pass, sharing the same FUNCTION index. |
| "Grafema doesn't brute-force" | Correct. Forward registration (analyzer marks data) + targeted edge traversal (enricher follows edges from small HOF set). |
