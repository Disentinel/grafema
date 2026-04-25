# Steve Jobs — Vision Review (Round 2, Post-DRY-Fixes)

**Reviewer:** Steve Jobs (Vision Review)
**Date:** 2026-02-19
**Task:** REG-521 — Add raw graph traversal primitives to MCP
**Review Focus:** Vision alignment, architecture, "query the graph, not read code"

---

## Verdict: APPROVE

**Summary:** After DRY fixes, this implementation aligns perfectly with Grafema's core vision and architecture. The three graph traversal primitives (`get_node`, `get_neighbors`, `traverse_graph`) provide exactly what AI agents need: direct, composable access to the code graph without forcing them to read source files. This is strategic work that moves us forward.

---

## Vision Analysis

### Core Thesis: "AI should query the graph, not read code"

**Question:** Does this implementation advance or retard that thesis?

**Answer:** ADVANCES. Strong alignment.

#### Before REG-521:
- Agents had high-level query tools (find_nodes, trace_dataflow, query_graph)
- But no **direct graph primitives**
- Agents couldn't do fine-grained graph navigation
- Agents couldn't answer "what's immediately connected to this node?" without invoking Datalog or complex traversal

#### After REG-521:
- Agents have three primitives that expose the graph directly:
  1. **`get_node`** — lookup any node by semantic ID
  2. **`get_neighbors`** — explore direct edges (one level)
  3. **`traverse_graph`** — systematic exploration (BFS, depth-controlled)

- These are **composable building blocks** that agents can use to construct:
  - Reachability analysis (traverse)
  - Dependency impact analysis (traverse + filtering)
  - Neighbor inspection (get_neighbors)
  - Full node metadata retrieval (get_node)

**Vision impact:** Instead of agents thinking "I'll read the source code to understand this," they now think "I'll query the graph, start at node X, explore neighbors, traverse to find dependencies." That's the win.

---

## Complexity & Architecture Checklist

### 1. Iteration Space: What can agents do with these tools?

**Cartesian product of possibilities:**
- `get_node` — unbounded (any semantic ID)
- `get_neighbors` — 3 directions × 74+ edge types = 222+ combinations
- `traverse_graph` — 2 directions × unlimited edge type combinations × depth 0-20 = massive iteration space

**Risk:** Unbounded graph traversal can explode.

**Mitigation present:**
- `MAX_DEPTH = 20` — hard limit on traversal depth ✓
- `MAX_TRAVERSAL_RESULTS = 10_000` — hard limit on result set size ✓
- `edgeTypes` required (not optional) — agents must specify what they're looking for ✓
- Input validation in all three handlers ✓

**Verdict:** ACCEPTABLE. Limits are sane and enforced.

---

### 2. Plugin Architecture: Does it use existing abstractions?

**Question:** Did we build a new traversal engine, or extend existing Grafema components?

**Answer:** Extended existing components. Clean integration.

**Evidence:**
- Uses existing `GraphBackendLike` interface (lines 18-22)
- No new index structures — uses existing `getNode()`, `getOutgoingEdges()`, `getIncomingEdges()`
- BFS implementation is manual but simple — reuses existing edge API ✓
- No hardcoded numeric edge type mapping — uses string EdgeType[] directly ✓
- Handlers follow existing MCP pattern:
  - Split `xLogic()` (testable) + `handleX()` (calls ensureAnalyzed)
  - Use existing `textResult()`, `errorResult()` helpers
  - Return MCP-compliant `ToolResult` ✓

**DRY fixes applied:**
- Extracted `groupEdgesByType()` helper — eliminates 32 lines of edge processing duplication ✓
- Removed duplicate validation from logic functions — validation now only in public handlers ✓

**Verdict:** CLEAN. Integrates with existing infrastructure without hacks or workarounds.

---

### 3. Extensibility: Is adding new feature support just about writing analyzers?

**Question:** If we want to add new edge types in the future, how hard is it?

**Answer:** Trivial. Only requires changing data, not code.

**How it works:**
- Tools accept `edgeTypes: string[]` — no numeric mapping in handler code
- BFS accepts `EdgeType[]` from `@grafema/types` — all 74+ types already defined
- Adding a new edge type in RFDB automatically becomes available in these tools
- No code changes needed in MCP handlers

**Example scenario:**
1. RFDB adds new `ASYNC_PARENT` edge type
2. Frontend or analyzer plugin creates edges of that type
3. `traverse_graph` tools immediately see it — no MCP changes needed

This is exactly right. The tools are **data-driven**, not code-driven.

**Verdict:** EXCELLENT. Perfect extensibility model.

---

### 4. Grafema Doesn't Brute-Force: Anti-Pattern Check

**Question:** Does the implementation avoid scanning "all nodes" to find patterns?

**Answer:** YES. Clean by default.

**How:**
- `get_node` — direct lookup, O(1) ✓
- `get_neighbors` — uses existing index, O(k) where k = direct edge count ✓
- `traverse_graph` — BFS with explicit edge types, doesn't scan all nodes ✓

**Example: Finding callers**
- **Brute-force (WRONG):** "Scan all FUNCTION nodes, check their CALLS edges for our target"
- **Graph-query (CORRECT):** `traverse_graph(startNode, edgeTypes=['CALLED_BY'], direction='incoming')`

The implementation **forces** the right approach through its API design. You can't brute-force all nodes because the API doesn't expose "all nodes." You must specify starting points and edge types.

**Verdict:** EXCELLENT. Architecture prevents the anti-pattern.

---

## Strategic Value Assessment

### Would shipping this embarrass us?

**Question:** Is this production-ready? Would we be proud to expose it to users/agents?

**Answer:** YES, after fixes. APPROVE for merge.

**Criteria:**

| Dimension | Status | Notes |
|-----------|--------|-------|
| **Vision alignment** | ✓ | Enables "query graph" workflow, not "read code" |
| **Documentation** | ✓ | Tool descriptions are agent-ready (when/why/use cases) |
| **API design** | ✓ | Minimal, composable, forced-right pattern |
| **Code quality** | ✓ | Clean after DRY fixes, well-tested |
| **Error handling** | ✓ | Clear validation, helpful error messages |
| **Performance** | ✓ | Limits enforced, won't DoS the database |
| **Extensibility** | ✓ | Supports future edge types without code changes |
| **Architecture** | ✓ | Uses existing abstractions, no hacks |

**Minor observations (not blockers):**
- GraphBackendLike interface is minimal but intentional — good for testability
- Manual BFS in `traverseGraphLogic` is 70 lines — exceeds 50-line guideline but justified (algorithm is sequential, extracting steps hurts clarity)
- Tests are comprehensive (23 tests covering happy path, errors, edge cases)

---

## Root Cause Analysis: Is this the right solution?

**Question:** The user asked for "raw graph traversal." Did we build the right thing, or just follow prescriptions?

**Answer:** This is the RIGHT THING.

**Evidence:**

1. **Problem:** Agents had no way to do fine-grained graph navigation
   - High-level query tools exist (find_nodes, query_graph)
   - But no "just tell me edges from node X" tool
   - Agents were forced to use find_nodes → semantic ID → then...stuck

2. **Solution:** Expose the three minimal primitives
   - `get_node` — node data by ID
   - `get_neighbors` — immediate edges (both directions)
   - `traverse_graph` — controlled BFS exploration

3. **Why these three?**
   - Not arbitrary — they map to fundamental graph operations
   - Composable — agents can chain them for complex queries
   - Non-prescriptive — agents control depth, direction, edge types
   - Defensible limits — max depth, result count

4. **Why NOT over-engineer?**
   - Could have added pre-built "find all callers" tool — but that's just `traverse_graph` with specific parameters
   - Could have added DFS option — but BFS is "good enough" for most analysis
   - Could have added path reconstruction — but agents don't need intermediate path info for impact analysis

This is **exactly** the right scope. No over-engineering. Minimal, defensible, composable.

**Verdict:** APPROVE. This solves the root problem correctly.

---

## DRY Fixes Verification

**Uncle Bob's review identified two DRY violations.** Confirm both are fixed:

### Fix 1: Extract `groupEdgesByType()` helper

**Before:** 32 lines of duplicated edge processing (outgoing + incoming)
**After:** Extracted helper function (20 lines) + two 3-line callers
**Status:** ✓ FIXED in current implementation (lines 26-46)

```typescript
// Single source of truth for edge grouping
async function groupEdgesByType(
  edges: EdgeRecord[],
  db: GraphBackendLike,
  getNodeId: (edge: EdgeRecord) => string,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  // ... unified logic
}

// Used in both directions
result.outgoing = await groupEdgesByType(edges, db, (e) => e.dst);
result.incoming = await groupEdgesByType(edges, db, (e) => e.src);
```

✓ No duplication. Clean. Testable.

### Fix 2: Remove duplicate validation

**Before:** Validation in both `getNodeLogic()` and `handleGetNode()`
**After:** Validation only in `handleGetNode()`, logic functions trust inputs
**Status:** ✓ FIXED

```typescript
// Logic function assumes valid input
export async function getNodeLogic(db: GraphBackendLike, args: GetNodeArgs): Promise<ToolResult> {
  const node = await db.getNode(args.semanticId);
  if (!node) {
    return errorResult(`Node not found: "${args.semanticId}". Use find_nodes...`);
  }
  return textResult(JSON.stringify(node, null, 2));
}

// Public handler validates
export async function handleGetNode(args: GetNodeArgs): Promise<ToolResult> {
  if (!args.semanticId || args.semanticId.trim() === '') {
    return errorResult('semanticId must be a non-empty string');
  }
  const db = await ensureAnalyzed();
  return getNodeLogic(db as unknown as GraphBackendLike, args);
}
```

✓ Clear separation of concerns. Single validation boundary.

---

## Test Coverage Assessment

**Test file:** `test/unit/mcp-graph-handlers.test.js` (23 tests)

**Coverage areas:**
- ✓ `get_node` — lookup exists, lookup missing, empty semanticId
- ✓ `get_neighbors` — outgoing/incoming/both, edge filtering, empty edgeTypes
- ✓ `traverse_graph` — BFS depth control, start node validation, result limiting, direction filter
- ✓ Edge grouping helper tests

**Quality:**
- Clear fixture functions (linearChainGraph, mixedEdgeGraph, cyclicGraph)
- Mock backend implements minimal interface
- Tests verify both structure and content
- Edge cases covered (cycles, deduplication, limits)

**Verdict:** SOLID. Tests lock behavior, enable future refactoring.

---

## Final Verdict

**APPROVE** ✓

### Reasoning:

1. **Vision alignment:** Enables "query graph" workflow. Agents now have direct graph access without reading code. GOOD.

2. **Architecture:** Uses existing abstractions, no hacks, defensible design decisions. GOOD.

3. **Extensibility:** Data-driven (edge types come from data, not hardcoded). New edge types work automatically. GOOD.

4. **Code quality:** DRY violations fixed. Clear separation of concerns. Well-tested. GOOD.

5. **Strategic value:** Minimal, composable, non-prescriptive. Right scope. GOOD.

6. **Would we ship this?** Yes. Proudly. GOOD.

---

## Recommendations for Merge

- ✓ All DRY fixes applied
- ✓ All tests passing
- ✓ Documentation complete (tool descriptions + JSDoc)
- ✓ No architectural gaps
- ✓ No vision misalignment

**Ready for:**
1. Final CI check (pnpm build && node --test)
2. Merge to main
3. Linear → Done

---

## Quote

> "The best code is the code you don't write. The second-best code is the code that's minimal, intentional, and defensible. This is second-best code. That's excellence."
>
> — Steve Jobs, Vision Review

**This work advances Grafema toward the vision. Merge it.**

---

**Steve Jobs**
*Vision, not solutions. Architecture, not features.*
