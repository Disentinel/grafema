# Uncle Bob — Code Quality Review (REG-521)

**Reviewer:** Robert Martin (Uncle Bob)
**Date:** 2026-02-19
**Task:** REG-521 — Add raw graph traversal primitives to MCP

---

## Verdict: REJECT

**Summary:** The implementation is clean and well-structured, but contains two clear violations of DRY principle that create maintenance risk. These duplications should be extracted into helper functions before merge.

---

## File-Level Analysis

### File Sizes ✓ PASS

All files are well within limits:

| File | Lines | Limit | Status |
|------|-------|-------|--------|
| `graph-handlers.ts` | 209 | 500 | ✓ OK |
| `graph-tools.ts` | 126 | 500 | ✓ OK |
| `server.ts` | 292 | 500 | ✓ OK |
| `types.ts` | 367 | 500 | ✓ OK |
| `mcp-graph-handlers.test.js` | 579 | 700* | ✓ OK |
| All definition files | <230 each | 500 | ✓ OK |

*Test files have slightly higher tolerance (700 lines) before requiring split.

**Definitions refactor:** Excellent work splitting the 669-line monolith into focused domain modules:
- `types.ts` (22) — shared types
- `query-tools.ts` (228) — 6 query tools
- `analysis-tools.ts` (127) — 5 analysis tools
- `guarantee-tools.ts` (138) — 4 guarantee tools
- `context-tools.ts` (148) — 4 context tools
- `project-tools.ts` (182) — 5 project tools
- `graph-tools.ts` (126) — 3 new graph tools
- `index.ts` (23) — barrel export

Each module has clear responsibility and is well below the 500-line limit. This is a textbook Single Responsibility example.

---

## Method-Level Analysis

### Issue 1: DUPLICATE edge processing logic (CRITICAL) ✗

**Location:** `packages/mcp/src/handlers/graph-handlers.ts`, lines 62-94

**Problem:** The `getNeighborsLogic` function contains identical processing logic for outgoing and incoming edges:

```typescript
// Lines 62-76: Outgoing edges
if (direction === 'outgoing' || direction === 'both') {
  const edges = await db.getOutgoingEdges(semanticId, edgeFilter);
  const grouped: Record<string, Array<Record<string, unknown>>> = {};

  for (const edge of edges) {
    const type = edge.type as string;
    if (!grouped[type]) grouped[type] = [];
    const dstNode = await db.getNode(edge.dst);
    grouped[type].push({
      id: edge.dst,
      ...(dstNode ? { type: dstNode.type, name: dstNode.name, file: dstNode.file, line: dstNode.line } : { type: 'UNKNOWN' }),
      ...(edge.metadata ? { edgeMetadata: edge.metadata } : {}),
    });
  }
  result.outgoing = grouped;
}

// Lines 79-93: Incoming edges (EXACT SAME PATTERN)
if (direction === 'incoming' || direction === 'both') {
  const edges = await db.getIncomingEdges(semanticId, edgeFilter);
  const grouped: Record<string, Array<Record<string, unknown>>> = {};

  for (const edge of edges) {
    const type = edge.type as string;
    if (!grouped[type]) grouped[type] = [];
    const srcNode = await db.getNode(edge.src);
    grouped[type].push({
      id: edge.src,
      ...(srcNode ? { type: srcNode.type, name: srcNode.name, file: srcNode.file, line: srcNode.line } : { type: 'UNKNOWN' }),
      ...(edge.metadata ? { edgeMetadata: edge.metadata } : {}),
    });
  }
  result.incoming = grouped;
}
```

**Impact:**
- 32 lines of duplicated code
- Two places to update if edge enrichment logic changes
- Bug in one block likely means same bug in the other
- Violates DRY principle

**Recommended fix:** Extract a helper function:

```typescript
async function groupEdgesByType(
  edges: EdgeRecord[],
  db: GraphBackendLike,
  getNodeId: (edge: EdgeRecord) => string
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const grouped: Record<string, Array<Record<string, unknown>>> = {};

  for (const edge of edges) {
    const type = edge.type as string;
    if (!grouped[type]) grouped[type] = [];
    const nodeId = getNodeId(edge);
    const node = await db.getNode(nodeId);
    grouped[type].push({
      id: nodeId,
      ...(node ? { type: node.type, name: node.name, file: node.file, line: node.line } : { type: 'UNKNOWN' }),
      ...(edge.metadata ? { edgeMetadata: edge.metadata } : {}),
    });
  }

  return grouped;
}
```

Then use it:

```typescript
if (direction === 'outgoing' || direction === 'both') {
  const edges = await db.getOutgoingEdges(semanticId, edgeFilter);
  result.outgoing = await groupEdgesByType(edges, db, (e) => e.dst);
}

if (direction === 'incoming' || direction === 'both') {
  const edges = await db.getIncomingEdges(semanticId, edgeFilter);
  result.incoming = await groupEdgesByType(edges, db, (e) => e.src);
}
```

This reduces duplication from 32 lines to ~12 lines total, with a single, tested implementation of edge grouping.

---

### Issue 2: DUPLICATE validation logic ✗

**Location:** `packages/mcp/src/handlers/graph-handlers.ts`

**Problem:** `semanticId` validation is duplicated between public handlers and logic functions:

```typescript
// Lines 189-192: handleGetNode
export async function handleGetNode(args: GetNodeArgs): Promise<ToolResult> {
  if (!args.semanticId || args.semanticId.trim() === '') {
    return errorResult('semanticId must be a non-empty string');
  }
  // ...
}

// Lines 26-31: getNodeLogic (SAME VALIDATION)
export async function getNodeLogic(db: GraphBackendLike, args: GetNodeArgs): Promise<ToolResult> {
  const { semanticId } = args;

  if (!semanticId || semanticId.trim() === '') {
    return errorResult('semanticId must be a non-empty string');
  }
  // ...
}
```

Same pattern appears for `handleGetNeighbors`/`getNeighborsLogic`.

**Why this is wrong:**
- Validation happens in TWO places for the same input
- If validation rules change (e.g., add length check), must update both locations
- Logic functions should trust that inputs are already validated
- Public handlers should be the validation boundary

**Recommended fix:** Remove validation from logic functions. Let public handlers be the only validation point:

```typescript
// Logic function assumes valid input
export async function getNodeLogic(db: GraphBackendLike, args: GetNodeArgs): Promise<ToolResult> {
  const node = await db.getNode(args.semanticId);

  if (!node) {
    return errorResult(`Node not found: "${args.semanticId}". Use find_nodes to search by type, name, or file.`);
  }

  return textResult(JSON.stringify(node, null, 2));
}

// Public handler validates before calling logic
export async function handleGetNode(args: GetNodeArgs): Promise<ToolResult> {
  if (!args.semanticId || args.semanticId.trim() === '') {
    return errorResult('semanticId must be a non-empty string');
  }
  const db = await ensureAnalyzed();
  return getNodeLogic(db as unknown as GraphBackendLike, args);
}
```

This establishes a clear contract: public handlers validate inputs, logic functions assume valid inputs and focus on business logic.

**Exception:** `traverseGraphLogic` doesn't have duplicate validation — `handleTraverseGraph` correctly skips validation, trusting the logic function to validate its more complex inputs. This is acceptable because traversal has multiple validation points (startNodeIds, edgeTypes, maxDepth) that are tightly coupled to the algorithm.

---

## Method Quality Review

### traverseGraphLogic (lines 99-169) ✓ ACCEPTABLE

**Length:** 70 lines (exceeds 50-line guideline but justified)

**Complexity:** Manual BFS with cycle detection, depth tracking, and result limit

**Why 70 lines is acceptable here:**
- BFS algorithm is inherently sequential (hard to extract steps without losing clarity)
- Clear sections: validation (15 lines), setup (3 lines), BFS loop (30 lines), result building (5 lines)
- Each section is documented with inline comments
- Extraction would create "BFS step" functions that are harder to understand than the inline loop
- No duplication within the function

**Recommendation:** Keep as-is. This is a case where extracting smaller functions would reduce readability.

### Other methods ✓ PASS

All other functions in `graph-handlers.ts` are under 20 lines and clear:
- `getNodeLogic`: 14 lines (simple lookup + error handling)
- `enrichResults`: 14 lines (simple map operation)
- Public handlers: 5-7 lines each (validation + delegation)

---

## Naming and Clarity ✓ PASS

**Good naming examples:**
- `getNeighborsLogic` — clear separation from `handleGetNeighbors`
- `enrichResults` — verb + noun, describes exactly what it does
- `GraphBackendLike` — interface name signals it's a minimal subset
- `MAX_TRAVERSAL_RESULTS`, `MAX_DEPTH` — uppercase constants, clear intent

**Parameter names:**
- `semanticId` — consistent across all tools
- `edgeTypes` vs `edgeFilter` — both used, but in different contexts (input vs internal)
- `maxDepth` — clear limit parameter

All function names are self-explanatory. Variable names clearly indicate purpose.

---

## Test Quality ✓ PASS

**Test file:** `test/unit/mcp-graph-handlers.test.js` (579 lines)

**Coverage:** 23 tests across 3 tools

**Test organization:**
- Clear fixture functions: `linearChainGraph()`, `mixedEdgeGraph()`, `cyclicGraph()`
- Dedicated mock backend that implements minimal interface
- Helpers: `getText()`, `isError()` — reduce boilerplate
- Good separation: validation tests, happy path tests, edge case tests

**Test quality metrics:**
- Each test has clear purpose in its name
- Tests cover error cases (empty inputs, invalid depth, missing nodes)
- Tests cover edge cases (cycles, deduplication, depth limits)
- Tests verify both structure and content of results

**No duplication issues in tests** — fixture reuse is appropriate and follows DRY.

---

## Pattern Consistency ✓ PASS

**Follows existing MCP handler patterns:**
1. Split into `xLogic()` (testable, accepts backend) and `handleX()` (calls `ensureAnalyzed()`)
2. Uses `errorResult()` and `textResult()` helpers
3. Returns `ToolResult` with MCP-compliant structure
4. Barrel export from `handlers/index.ts`
5. Tool definitions follow existing structure in `definitions/` modules

**Server.ts integration:** Clean switch-case additions, proper type imports, consistent with existing handlers.

**Type definitions:** New interfaces in `types.ts` follow existing conventions (Args suffix, optional parameters marked with `?`).

---

## Issues Summary

| Issue | Severity | Lines Affected | Fix Effort |
|-------|----------|----------------|------------|
| Duplicate edge grouping logic | CRITICAL | 32 | 30 min |
| Duplicate validation logic | MEDIUM | ~10 | 15 min |

**Total technical debt:** ~45 minutes of refactoring to eliminate duplication.

---

## Specific Actions Required

### MUST FIX before merge:

1. **Extract `groupEdgesByType()` helper** from `getNeighborsLogic` (lines 62-94)
   - Create helper function that accepts edges and a node-ID selector
   - Replace both outgoing and incoming blocks with calls to helper
   - Add unit test for the helper function

2. **Remove duplicate validation** from `getNodeLogic` and `getNeighborsLogic`
   - Keep validation only in public `handleX()` functions
   - Logic functions should assume inputs are valid
   - Update JSDoc to clarify that logic functions expect validated inputs

### After fixes:

Re-run tests to ensure behavior unchanged, then request re-review.

---

## Positive Observations

Despite the duplication issues, this is **high-quality work**:

1. **Excellent file organization** — definitions split follows SRP perfectly
2. **Clear separation of concerns** — logic vs handlers is the right pattern
3. **Comprehensive tests** — 23 tests cover happy paths, errors, edge cases
4. **Good documentation** — JSDoc explains when to use each tool
5. **Consistent naming** — follows established conventions throughout
6. **Within size limits** — no files approaching danger zone

The duplication is a **mechanical issue**, not an architectural one. Once the two duplication issues are fixed, this code will be production-ready.

---

## Code Cleanliness Checklist

- ✓ No TODO, FIXME, HACK comments
- ✓ No commented-out code
- ✓ No placeholder implementations
- ✓ All functions have clear purpose
- ✗ **DRY violated** (edge grouping, validation)
- ✓ KISS followed (no over-engineering)
- ✓ Matches existing patterns

---

## Final Recommendation

**REJECT** — Fix duplication issues and resubmit.

**Estimated fix time:** 45 minutes
**Risk level:** Low (fixes are mechanical, well-tested)
**Blocking for merge:** Yes

Once duplication is eliminated:
- This code will be a model of clean MCP handler implementation
- Tests will continue to pass (no behavior change)
- Maintenance burden will be significantly reduced

---

**Uncle Bob**
*"Truth can only be found in one place: the code."*
