# Dijkstra Correctness Review — REG-521

**Reviewer:** Edsger Dijkstra
**Date:** 2026-02-19
**Task:** REG-521 (Add raw graph traversal primitives to MCP)

---

## Verdict: APPROVE

All functions are correct by enumeration. No inputs produce incorrect output or violate invariants.

---

## Functions Reviewed

1. ✅ `getNodeLogic(db, args)` — CORRECT
2. ✅ `getNeighborsLogic(db, args)` — CORRECT
3. ✅ `traverseGraphLogic(db, args)` — CORRECT
4. ✅ `enrichResults(db, results)` — CORRECT
5. ✅ `handleGetNode(args)` — CORRECT
6. ✅ `handleGetNeighbors(args)` — CORRECT
7. ✅ `handleTraverseGraph(args)` — CORRECT

---

## Detailed Analysis

### 1. `getNodeLogic(db, args)` — Lines 26-40

**Input enumeration:**
- `args.semanticId`: `string | undefined`
  - Case A: undefined → `!semanticId` catches this → error
  - Case B: empty string `""` → `semanticId.trim() === ''` catches this → error
  - Case C: whitespace-only `"  "` → `semanticId.trim() === ''` catches this → error
  - Case D: valid non-empty string → proceeds to `db.getNode()`

**Backend response enumeration:**
- `db.getNode(semanticId)` returns `Record<string, unknown> | null`
  - Case 1: `null` → node not found → error with helpful message
  - Case 2: valid node object → serialized to JSON → success

**Condition completeness:**
```
if (!semanticId || semanticId.trim() === '')  ← catches undefined, null, "", "  "
if (!node)                                     ← catches null result from backend
return textResult(...)                         ← guaranteed to execute if both checks pass
```

**Loop termination:** No loops.

**Invariant verification:**
- **Post-condition:** Returns `ToolResult` where:
  - `isError = true` if input invalid or node not found
  - `isError = false` if node exists, content is valid JSON
- **Guaranteed:** Yes. All paths return `ToolResult` (errorResult or textResult).

**Test coverage:** 3/3 branches tested (valid ID, non-existent ID, empty string).

**Verdict:** CORRECT

---

### 2. `getNeighborsLogic(db, args)` — Lines 42-97

**Input enumeration:**
- `args.semanticId`: same as getNodeLogic (undefined, empty, whitespace, valid)
- `args.direction`: `'outgoing' | 'incoming' | 'both' | undefined`
  - Default: `'both'` (line 43)
  - All three values tested by conditions on lines 62, 79
- `args.edgeTypes`: `string[] | undefined`
  - Case A: `undefined` → `edgeTypes = null` (line 59) → backend gets null (= all types)
  - Case B: `[]` empty array → error on line 49
  - Case C: non-empty array → passed to backend as filter

**Condition completeness:**
```
if (!semanticId || semanticId.trim() === '')          ← validates semanticId
if (edgeTypes !== undefined && edgeTypes.length === 0) ← catches empty array (but NOT undefined)
if (!node)                                             ← validates node exists
if (direction === 'outgoing' || direction === 'both')  ← handles outgoing
if (direction === 'incoming' || direction === 'both')  ← handles incoming
```

**Edge case:** What if `direction` is NOT one of the three expected values?
- TypeScript type system enforces `'outgoing' | 'incoming' | 'both'` at compile time
- At runtime, if caller passes invalid value (e.g., `'sideways'`):
  - Both conditions on lines 62, 79 would be false
  - `result = {}` (line 60)
  - Neither `result.outgoing` nor `result.incoming` would be set
  - Returns empty object `{}`

**Is this correct?** Yes — defensively returns empty structure instead of crashing. Better would be explicit validation, but given TypeScript enforces the type at the MCP boundary, this is acceptable.

**Loop termination:**
- Line 66: `for (const edge of edges)` — terminates when edges exhausted
- Line 83: `for (const edge of edges)` — same

**Edge fetching:**
- `db.getOutgoingEdges(semanticId, edgeFilter)` — backend operation, assumed correct
- `db.getIncomingEdges(semanticId, edgeFilter)` — same

**Invariant verification:**
- **Post-condition:** Returns grouped edge structure `{ outgoing?: {...}, incoming?: {...} }`
- **Guaranteed:** Yes. Either error or valid JSON structure.

**Test coverage:** 7 tests cover all branches (both directions, outgoing only, incoming only, no edges, edge type filter, empty edgeTypes array, non-existent node).

**Verdict:** CORRECT

---

### 3. `traverseGraphLogic(db, args)` — Lines 99-169

**This is the most complex function. I will enumerate exhaustively.**

**Input enumeration:**
- `args.startNodeIds`: `string[] | undefined | null`
  - Case A: `undefined` or `null` → `!startNodeIds` catches → error (line 103)
  - Case B: `[]` → `.length === 0` catches → error (line 103)
  - Case C: non-empty array → validated per node
- `args.edgeTypes`: `string[] | undefined | null`
  - Case A: `undefined` or `null` → `!edgeTypes` catches → error (line 106)
  - Case B: `[]` → `.length === 0` catches → error (line 106)
  - Case C: non-empty array → used as filter
- `args.maxDepth`: `number | undefined`
  - Default: `5` (line 100)
  - Case A: non-integer (e.g., `3.5`) → `!Number.isInteger(maxDepth)` catches → error (line 109)
  - Case B: negative (e.g., `-1`) → `maxDepth < 0` catches → error (line 109)
  - Case C: `0` → valid, returns only start nodes
  - Case D: `1..20` → valid
  - Case E: `> 20` → caught by line 112 → error
- `args.direction`: `'outgoing' | 'incoming' | undefined`
  - Default: `'outgoing'` (line 100)
  - Both values used in ternary on line 138

**Start node validation (lines 120-125):**
```typescript
for (const id of uniqueStartIds) {
  const node = await db.getNode(id);
  if (!node) {
    return errorResult(`Start node not found: "${id}". ...`);
  }
}
```
- **Termination:** Yes, bounded by `uniqueStartIds.length`
- **Invariant:** After this loop, all start nodes are guaranteed to exist in graph

**BFS algorithm (lines 129-161):**

**Initialization:**
```typescript
const visited = new Set<string>(uniqueStartIds);          // line 130
const queue = uniqueStartIds.map(id => ({ id, depth: 0 })); // line 131
const results = uniqueStartIds.map(id => ({ id, depth: 0 })); // line 132
```

**Invariant I1:** `visited` contains exactly the nodes in `results`
- **Initial state:** True (both contain `uniqueStartIds`)
- **Maintenance:** Line 145 adds to visited, line 148 adds to results — atomic operation
- **Conclusion:** Invariant holds throughout

**Loop (lines 134-161):**
```typescript
while (queue.length > 0) {
  const current = queue.shift()!;
  if (current.depth >= maxDepth) continue;

  const edges = direction === 'outgoing'
    ? await db.getOutgoingEdges(current.id, edgeFilter)
    : await db.getIncomingEdges(current.id, edgeFilter);

  for (const edge of edges) {
    const neighborId = direction === 'outgoing' ? edge.dst : edge.src;
    if (!visited.has(neighborId)) {
      visited.add(neighborId);
      const nextDepth = current.depth + 1;
      queue.push({ id: neighborId, depth: nextDepth });
      results.push({ id: neighborId, depth: nextDepth });

      if (results.length >= MAX_TRAVERSAL_RESULTS) {
        // early return with truncated results
      }
    }
  }
}
```

**Loop termination proof:**
1. **Queue decreases:** Line 135 `queue.shift()` removes one element per iteration
2. **Bounded additions:** Line 147 only adds if `!visited.has(neighborId)`
3. **Finite graph:** Graph has finite nodes, `visited` can grow at most N times (N = node count)
4. **Depth limit:** Line 136 prevents processing nodes at depth ≥ maxDepth
5. **Result limit:** Line 150 exits early if results hit 10,000

**Conclusion:** Loop MUST terminate. Either:
- Queue empties naturally (BFS completes)
- Result limit hit → early return
- Depth limit prevents infinite queueing

**Cycle handling:**
- Line 144: `if (!visited.has(neighborId))` — prevents re-visiting nodes
- Cyclic graph A→B→A: First visit to A → visited. B added to queue. B processed, sees edge to A, but A already in visited → skipped.
- **Correct.**

**Depth tracking:**
- Start nodes: depth 0 (line 132)
- Neighbors: depth incremented by 1 (line 146)
- Line 136: nodes at depth ≥ maxDepth are skipped, their neighbors NOT explored
- **Question:** If maxDepth=1, do we get depth-1 nodes?
  - Start nodes at depth 0 enter loop
  - `0 >= 1` is false → proceed
  - Their neighbors get depth 1
  - Neighbors at depth 1 enter loop
  - `1 >= 1` is true → `continue` → NOT explored further
  - **Result:** Start nodes (depth 0) + direct neighbors (depth 1) included. ✅

**maxDepth=0 edge case:**
- Start nodes at depth 0 enter loop
- `0 >= 0` is true → `continue` immediately
- No neighbors explored
- Results contain only start nodes
- **Correct.** Test at line 440 confirms this.

**Direction handling:**
- Line 138: ternary selects outgoing vs incoming edges
- Line 143: ternary extracts dst (for outgoing) or src (for incoming)
- **Consistency check:** If direction='outgoing', we get outgoing edges and extract dst. ✅
- **Consistency check:** If direction='incoming', we get incoming edges and extract src. ✅

**Result limit (lines 150-158):**
```typescript
if (results.length >= MAX_TRAVERSAL_RESULTS) {
  const nodes = await enrichResults(db, results);
  return textResult(JSON.stringify({
    count: nodes.length,
    truncated: true,
    message: ...,
    nodes,
  }, null, 2));
}
```
- Triggers when results.length reaches 10,000
- Immediately enriches and returns
- Prevents OOM on large graphs
- **Correct.**

**Post-condition:**
- Returns nodes reachable from start nodes within maxDepth hops
- Each node annotated with its depth
- No duplicates (enforced by visited set)
- No cycles (enforced by visited set)
- **Guaranteed:** Yes.

**Test coverage:** 14 tests cover:
- Linear chain traversal ✅
- Outgoing direction ✅
- Incoming direction ✅
- maxDepth limits ✅
- Cycle handling ✅
- Start node deduplication ✅
- maxDepth=0 ✅
- maxDepth > 20 validation ✅
- Negative maxDepth validation ✅
- Empty startNodeIds validation ✅
- Empty edgeTypes validation ✅
- Non-existent start node ✅
- Result limit enforcement ✅

**Verdict:** CORRECT

---

### 4. `enrichResults(db, results)` — Lines 171-185

**Input enumeration:**
- `results`: `Array<{ id: string; depth: number }>`
  - Case A: Empty array → `Promise.all([])` → returns `[]` immediately
  - Case B: Non-empty array → maps over all elements

**Loop:**
```typescript
return Promise.all(
  results.map(async ({ id, depth }) => {
    const node = await db.getNode(id);
    return {
      id,
      depth,
      ...(node ? { type: node.type, name: node.name, file: node.file, line: node.line } : { type: 'UNKNOWN' }),
    };
  })
);
```

**Termination:** Yes — `map` iterates exactly `results.length` times.

**Node lookup:**
- If `db.getNode(id)` returns null (node deleted between traversal and enrichment?):
  - Spread operator uses `{ type: 'UNKNOWN' }`
  - No crash, graceful degradation
  - **Correct defensive programming.**

**Invariant:**
- **Input:** Array of `{id, depth}`
- **Output:** Array of `{id, depth, type, name?, file?, line?}` with same length and order
- **Guaranteed:** Yes. `map` preserves array length and order.

**Verdict:** CORRECT

---

### 5. `handleGetNode(args)` — Lines 189-195

**Input enumeration:**
- `args.semanticId`: validated on line 190 (same logic as getNodeLogic line 29)

**Condition completeness:**
```
if (!args.semanticId || args.semanticId.trim() === '') ← early validation
const db = await ensureAnalyzed();                      ← ensures backend ready
return getNodeLogic(db, args);                          ← delegates to logic function
```

**Question:** Why validate twice (here AND in getNodeLogic)?
- **Answer:** Defense in depth. Handler validates before calling `ensureAnalyzed()` (expensive). Logic function validates again for testability (when called directly with mock backend).
- **Correct design.**

**Invariant:** Returns `ToolResult`, either error or success.

**Verdict:** CORRECT

---

### 6. `handleGetNeighbors(args)` — Lines 197-203

**Same pattern as handleGetNode:**
- Early validation of semanticId
- Calls `ensureAnalyzed()`
- Delegates to `getNeighborsLogic`

**Verdict:** CORRECT

---

### 7. `handleTraverseGraph(args)` — Lines 205-208

**Input enumeration:**
- **NO early validation here** — unlike the other two handlers
- Directly calls `ensureAnalyzed()` then `traverseGraphLogic()`

**Question:** Is this a defect?
- `traverseGraphLogic` validates all inputs at lines 103-114
- Early validation would save an unnecessary `ensureAnalyzed()` call if inputs invalid
- **Impact:** Performance only (extra backend initialization for invalid input)
- **Correctness:** Not affected — traverseGraphLogic catches all invalid inputs

**Is this inconsistent with handleGetNode/handleGetNeighbors?**
- Yes, pattern differs
- Those two validate `semanticId` early
- This one does not validate `startNodeIds`/`edgeTypes` early

**Should it be fixed?**
- Ideally yes, for consistency and performance
- But NOT a correctness issue
- I will note this as a minor inconsistency but NOT reject

**Verdict:** CORRECT (with minor style inconsistency)

---

## Issues Found

**NONE.** All functions are correct.

---

## Minor Observations (NOT defects)

### 1. Inconsistent early validation pattern

**Location:** `handleTraverseGraph` (line 205)

**Observation:**
- `handleGetNode` and `handleGetNeighbors` validate their required parameters before calling `ensureAnalyzed()`
- `handleTraverseGraph` does NOT — it calls `ensureAnalyzed()` first, then `traverseGraphLogic()` validates

**Impact:** Performance only — if inputs are invalid, unnecessary backend initialization occurs

**Recommendation:** Add early validation:
```typescript
export async function handleTraverseGraph(args: TraverseGraphArgs): Promise<ToolResult> {
  if (!args.startNodeIds || args.startNodeIds.length === 0) {
    return errorResult('startNodeIds must not be empty');
  }
  if (!args.edgeTypes || args.edgeTypes.length === 0) {
    return errorResult('edgeTypes must not be empty. Use get_schema(type="edges") to see available types.');
  }
  const db = await ensureAnalyzed();
  return traverseGraphLogic(db as unknown as GraphBackendLike, args);
}
```

**Severity:** Low — does not affect correctness, only API ergonomics

---

### 2. Direction validation gap (getNeighborsLogic)

**Location:** `getNeighborsLogic` (line 43)

**Observation:**
- If `direction` is NOT one of `'outgoing' | 'incoming' | 'both'`, function returns `{}`
- TypeScript enforces type at compile time, so this can only happen if:
  - Caller uses `as any` type assertion
  - MCP JSON schema validation fails
  - Runtime deserialization issue

**Current behavior:** Empty object returned (lines 60, 96)

**Alternative:** Explicit runtime validation:
```typescript
if (direction !== 'outgoing' && direction !== 'incoming' && direction !== 'both') {
  return errorResult(`Invalid direction: "${direction}". Must be 'outgoing', 'incoming', or 'both'.`);
}
```

**Why not required?**
- MCP tool definitions enforce schema at the protocol layer
- TypeScript enforces type at compile time
- Defensive empty object return is acceptable fallback

**Severity:** Very Low — only matters if type system bypassed

---

### 3. Test coverage for maxDepth boundary

**Observation:** Tests cover:
- `maxDepth = 0` ✅
- `maxDepth = 1` ✅
- `maxDepth = 5` ✅
- `maxDepth = 10` ✅
- `maxDepth = 21` (exceeds limit) ✅
- `maxDepth = -1` (negative) ✅

**Missing:** `maxDepth = 20` (boundary case — exactly at the limit)

**Why it matters:**
- Line 112: `if (maxDepth > MAX_DEPTH)` uses `>` not `>=`
- `maxDepth = 20` should be VALID
- `maxDepth = 21` should be INVALID

**Current test at line 458:** Uses `maxDepth: 21` → error ✅

**Recommendation:** Add test for `maxDepth: 20` → success (confirms boundary correct)

**Severity:** Very Low — logic is clearly correct (`> 20` not `>= 20`), test would just confirm

---

## Summary

All seven functions reviewed are **CORRECT by enumeration**.

- **Input validation:** Complete, all invalid input categories caught
- **Condition completeness:** All branches covered, no missing cases
- **Loop termination:** All loops proven to terminate (bounded iteration or visited-set cutoff)
- **Invariants:** All post-conditions guaranteed by code structure

**Test quality:** 23 tests provide excellent coverage of all major paths and edge cases.

**Code quality observations:**
- Defensive programming (UNKNOWN type for missing nodes) ✅
- Cycle handling via visited set ✅
- Resource limits (MAX_DEPTH, MAX_TRAVERSAL_RESULTS) ✅
- Helpful error messages with actionable suggestions ✅

**Minor style inconsistencies noted but do NOT affect correctness.**

---

**Final verdict: APPROVE**

— Edsger Dijkstra
