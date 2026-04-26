# REG-521: Dijkstra Plan Verification

**Date:** 2026-02-19
**Verifier:** Edsger Dijkstra (Plan Verifier)
**Subject:** Don Melton's plan at `_tasks/REG-521/002-don-plan.md`

---

## Verdict: REJECT

**Completeness tables built:** 5
**Critical gaps found:** 3
**Precondition violations:** 2

---

## Critical Gap #1: Edge Type Mapping is Incomplete

### The Problem

Don's plan includes a HARDCODED edge type mapping at lines 728-736:

```typescript
const EDGE_TYPE_TO_NUMBER: Record<string, number> = {
  'CONTAINS': 1, 'DEPENDS_ON': 2, 'CALLS': 3, 'EXTENDS': 4,
  'IMPLEMENTS': 5, 'USES': 6, 'DEFINES': 7, 'IMPORTS': 8,
  'EXPORTS': 9, 'ROUTES_TO': 10, 'DECLARES': 11, 'HAS_SCOPE': 12,
  'CAPTURES': 13, 'MODIFIES': 14, 'WRITES_TO': 15, 'INSTANCE_OF': 16,
  'HANDLED_BY': 17, 'HAS_CALLBACK': 18, 'MAKES_REQUEST': 19,
  'IMPORTS_FROM': 20, 'EXPORTS_TO': 21, 'ASSIGNED_FROM': 22,
};
```

**This mapping has 22 edge types.**

### Actual Edge Type Count

From `packages/types/src/edges.ts`, I count **74 distinct edge types**:

#### Structure (3)
- CONTAINS, DEPENDS_ON, HAS_SCOPE

#### Branching (3)
- HAS_CONDITION, HAS_CASE, HAS_DEFAULT

#### Loop edges (4)
- HAS_BODY, ITERATES_OVER, HAS_INIT, HAS_UPDATE

#### If statement edges (2)
- HAS_CONSEQUENT, HAS_ALTERNATE

#### Try/catch/finally edges (2)
- HAS_CATCH, HAS_FINALLY

#### Calls (7)
- CALLS, HAS_CALLBACK, PASSES_ARGUMENT, RECEIVES_ARGUMENT, RETURNS, YIELDS, DELEGATES_TO

#### Inheritance (3)
- EXTENDS, IMPLEMENTS, INSTANCE_OF

#### Imports/Exports (4)
- IMPORTS, EXPORTS, IMPORTS_FROM, EXPORTS_TO

#### Variables/Data flow (10)
- DEFINES, USES, DECLARES, MODIFIES, CAPTURES, ASSIGNED_FROM, READS_FROM, WRITES_TO, DERIVES_FROM, FLOWS_INTO

#### Object/Array structure (2)
- HAS_PROPERTY, HAS_ELEMENT

#### HTTP/Routing (6)
- ROUTES_TO, HANDLED_BY, MAKES_REQUEST, MOUNTS, EXPOSES, RESPONDS_WITH

#### Events/Sockets (3)
- LISTENS_TO, EMITS_EVENT, JOINS_ROOM

#### External (3)
- CALLS_API, INTERACTS_WITH, HTTP_RECEIVES

#### Views (1)
- REGISTERS_VIEW

#### Errors (3)
- THROWS, REJECTS, CATCHES_FROM

#### Guarantees/Invariants (2)
- GOVERNS, VIOLATES

#### Issues (1)
- AFFECTS

#### Cross-Layer Edges (USG) (14)
- DEPLOYED_TO, SCHEDULED_BY, EXPOSED_VIA, USES_CONFIG, USES_SECRET, PUBLISHES_TO, SUBSCRIBES_TO, MONITORED_BY, MEASURED_BY, LOGS_TO, INVOKES_FUNCTION, PROVISIONED_BY

#### Unknown/fallback (1)
- UNKNOWN

**Total: 74 edge types**

### Completeness Table: Edge Type Mapping Coverage

| Category | Don's Plan | Actual in edges.ts | Missing |
|----------|------------|-------------------|---------|
| Structure | 3 | 3 | 0 |
| Branching | 0 | 3 | 3 |
| Loop edges | 0 | 4 | 4 |
| If statement | 0 | 2 | 2 |
| Try/catch | 0 | 2 | 2 |
| Calls | 2 (CALLS, HAS_CALLBACK) | 7 | 5 |
| Inheritance | 3 | 3 | 0 |
| Imports/Exports | 4 | 4 | 0 |
| Variables/Data flow | 8 | 10 | 2 (READS_FROM, DERIVES_FROM, FLOWS_INTO) |
| Object/Array structure | 0 | 2 | 2 |
| HTTP/Routing | 3 | 6 | 3 (MOUNTS, EXPOSES, RESPONDS_WITH) |
| Events/Sockets | 0 | 3 | 3 |
| External | 1 (MAKES_REQUEST) | 3 | 2 |
| Views | 0 | 1 | 1 |
| Errors | 0 | 3 | 3 |
| Guarantees | 0 | 2 | 2 |
| Issues | 0 | 1 | 1 |
| Cross-Layer (USG) | 0 | 14 | 14 |
| Unknown | 0 | 1 | 1 |
| **TOTALS** | **22** | **74** | **52** |

### Impact

When `traverse_graph` receives an edge type string not in the mapping, `EDGE_TYPE_TO_NUMBER[type]` returns `undefined`, and the plan uses `|| 0` as fallback.

**What does edge type number 0 mean in RFDB?**

From `GraphBackend.ts` line 263-265:
```typescript
export function edgeTypeToNumber(type: string): number {
  return EDGE_TYPE_TO_NUMBER[type] || 0;
}
```

The same pattern! **But there is NO documentation of what 0 means.**

**Possible interpretations:**
1. 0 = "match all edge types" (optimistic)
2. 0 = "invalid type, match nothing" (pessimistic)
3. 0 = undefined behavior (crash, silent failure)

**Don's plan assumes behavior without verification.**

### The Fix

**Option A (Don's note at line 836):**
```typescript
import { edgeTypeToNumber } from '@grafema/core/GraphBackend.js';
const edgeTypeNumbers = edgeTypes.map(edgeTypeToNumber);
```

**BUT:** This still only covers 22 types! The `EDGE_TYPE_TO_NUMBER` in `GraphBackend.ts` lines 236-258 is ALSO incomplete.

**Option B (Complete Solution):**
1. Build a COMPLETE mapping in `packages/types/src/edges.ts` that covers all 74 types
2. Export `edgeTypeToNumber()` from `@grafema/types`
3. Use it in both `GraphBackend.ts` and `graph-handlers.ts`

**Option C (Dynamic Solution):**
1. RFDB server already knows all edge types (it stores them)
2. Query RFDB for edge type → number mapping at runtime
3. No hardcoding required

**Recommendation:** Option B for now (statically verifiable), with Option C as future improvement when RFDB exposes the mapping via wire protocol.

---

## Critical Gap #2: `bfs()` Method Signature Mismatch

### The Claim (Don's plan, line 739)

```typescript
reachableIds = await db.bfs(startNodeIds, maxDepth, edgeTypeNumbers);
```

### Actual Method Signature

From `packages/core/src/core/GraphBackend.ts` lines 147-154:

```typescript
/**
 * BFS traversal from start nodes
 * @param startIds - Starting nodes
 * @param maxDepth - Maximum depth
 * @param edgeTypes - Edge types to traverse (as numbers)
 * @returns Array of reachable node IDs
 */
abstract bfs(startIds: string[], maxDepth: number, edgeTypes: number[]): Promise<string[]>;
```

### Verification

The signature MATCHES. ✓

**BUT:** What does the return value look like?

Don's plan assumes `bfs()` returns `string[]` — flat list of IDs with NO depth information.

Then at line 777-780:
```typescript
return textResult(JSON.stringify({
  count: nodes.length,
  nodes,
}, null, 2));
```

**Where is the depth field?** The tool description (line 473-474) promises:

> - Array of reachable node IDs
> - Each with depth: 0 = start nodes, 1 = direct neighbors, 2+ = transitive

### Completeness Table: Return Value Structure

| Component | Tool Description Claims | Don's Implementation | Match? |
|-----------|-------------------------|---------------------|--------|
| Node IDs | Yes | Yes | ✓ |
| Depth field | Yes (line 473-474) | **NO** | ✗ |
| Node summaries | Implied (line 763-775) | Yes | ✓ |

### The Problem

For incoming BFS (lines 742-760), Don builds `results: Array<{ id: string; depth: number }>` and includes depth.

For outgoing BFS (line 739), he uses `backend.bfs()` which returns `string[]` with NO depth.

Then at line 763, he calls `Promise.all(reachableIds.map(...))` which LOSES depth info from incoming BFS!

### Input Universe: BFS Directions

| Direction | Implementation | Returns Depth? |
|-----------|---------------|----------------|
| outgoing | `backend.bfs()` | NO |
| incoming | Manual BFS | YES (but lost at line 763) |

### The Fix

**Option A:** Change `backend.bfs()` to return `Array<{ id: string; depth: number }>`
- **Problem:** Breaking change to core API

**Option B:** Keep `backend.bfs()` as-is, reconstruct depth from BFS traversal order
- **Problem:** Fragile, assumes specific traversal order

**Option C:** Change tool description to remove depth promise
- **Problem:** Reduces utility (depth is valuable information!)

**Option D:** Manual BFS for BOTH directions
- **Problem:** Duplicates `backend.bfs()` logic

**Recommendation:** Option A if possible (verify with Rob that RFDB can return depth), otherwise Option D.

---

## Critical Gap #3: Missing Validation - Empty String Edge Types

### The Code (lines 726-738)

```typescript
const edgeTypeNumbers = edgeTypes.map(type => {
  const EDGE_TYPE_TO_NUMBER: Record<string, number> = { ... };
  return EDGE_TYPE_TO_NUMBER[type] || 0;
});
```

### Input Universe: Edge Type Strings

| Input Category | Example | Plan Handles? |
|----------------|---------|---------------|
| Valid edge type | "CALLS" | Yes |
| Invalid edge type | "FOOBARBAZ" | Yes (returns 0) |
| Empty string | "" | **NO** |
| null/undefined | null | **NO** (runtime crash) |
| Number instead of string | 42 | **NO** (type error) |
| Array instead of string | ["CALLS"] | **NO** (type error) |

### TypeScript Type Safety

The parameter is `edgeTypes: string[]`, so TypeScript SHOULD prevent null/number/array.

**BUT:** MCP tool calls come from WIRE PROTOCOL. The `inputSchema` validation happens BEFORE TypeScript sees the data.

### Input Schema Validation (lines 494-498)

```typescript
edgeTypes: {
  type: 'array',
  items: { type: 'string' },
  description: 'Edge types to traverse (e.g., ["CALLS", "DEPENDS_ON"])',
},
```

**JSON Schema guarantees:**
- `edgeTypes` is an array
- Each element is a string

**JSON Schema does NOT guarantee:**
- Elements are non-empty strings
- Elements are valid edge type names

### Completeness Table: Validation Coverage

| Validation Check | inputSchema | Runtime Code | Total Coverage |
|------------------|-------------|--------------|----------------|
| Is array? | ✓ | — | ✓ |
| Elements are strings? | ✓ | — | ✓ |
| Non-empty strings? | ✗ | ✗ | **✗** |
| Valid edge type names? | ✗ | ✗ | **✗** |

### The Attack Vector

```json
{
  "startNodeIds": ["node1"],
  "edgeTypes": ["CALLS", "", "DEPENDS_ON"],
  "maxDepth": 3
}
```

What happens?
1. `edgeTypes[1]` is `""`
2. `EDGE_TYPE_TO_NUMBER[""]` is `undefined`
3. `undefined || 0` is `0`
4. BFS called with edge type number `0`
5. **Undefined behavior** (see Gap #1)

### The Fix

Add validation:

```typescript
// Validate edge types
for (const type of edgeTypes) {
  if (!type || type.trim() === '') {
    return errorResult('edgeTypes must not contain empty strings');
  }
  if (!EDGE_TYPE_TO_NUMBER[type]) {
    return errorResult(`Unknown edge type: ${type}. Use get_schema(type='edges') to see available types.`);
  }
}
```

---

## Precondition Violation #1: Node Existence Check is Incomplete

### The Code (lines 714-719)

```typescript
// Verify all start nodes exist
for (const id of startNodeIds) {
  const node = await db.getNode(id);
  if (!node) {
    return errorResult(`Start node not found: ${id}`);
  }
}
```

### The Problem

What if `startNodeIds` contains **duplicates**?

```json
{
  "startNodeIds": ["node1", "node1", "node1"],
  "edgeTypes": ["CALLS"],
  "maxDepth": 5
}
```

**Expected behavior:** BFS starts from `node1` once (duplicates ignored)

**Actual behavior (outgoing):** `backend.bfs(["node1", "node1", "node1"], 5, [3])` — depends on RFDB implementation

**Actual behavior (incoming):** Manual BFS at lines 742-760 uses `Set<string>(startNodeIds)`, so duplicates are deduplicated ✓

### Completeness Table: Duplicate Handling

| Direction | Deduplicates? | Behavior |
|-----------|---------------|----------|
| outgoing | Unknown (depends on RFDB) | Unverified |
| incoming | Yes (line 742) | Correct |

### The Fix

```typescript
// Deduplicate start nodes
const uniqueStartIds = Array.from(new Set(startNodeIds));
if (uniqueStartIds.length !== startNodeIds.length) {
  // Optional: warn user about duplicates
}

// Verify all start nodes exist
for (const id of uniqueStartIds) {
  const node = await db.getNode(id);
  if (!node) {
    return errorResult(`Start node not found: ${id}`);
  }
}
```

---

## Precondition Violation #2: `maxDepth` Validation is Inconsistent

### The Code (lines 701-703)

```typescript
if (maxDepth > 20) {
  return errorResult('maxDepth must be <= 20 to prevent performance issues');
}
```

### Input Universe: maxDepth Values

| Input | Validation | Behavior |
|-------|------------|----------|
| -1 | **MISSING** | Unknown (negative depth?) |
| 0 | **MISSING** | Unknown (return only start nodes? or error?) |
| 1 | Pass | BFS to depth 1 |
| 5 | Pass | BFS to depth 5 (default) |
| 20 | Pass | BFS to depth 20 (max) |
| 21 | Reject | Error |
| 999999 | Reject | Error |
| null/undefined | Uses default 5 | OK |
| "5" (string) | Depends on TypeScript/schema | Unknown |
| 3.14 (float) | No validation | Unknown |

### Completeness Table: maxDepth Validation

| Check | Implemented? | Should Implement? |
|-------|--------------|-------------------|
| maxDepth > 20 | ✓ | ✓ |
| maxDepth < 0 | ✗ | ✓ |
| maxDepth === 0 | ✗ | ? (define behavior) |
| maxDepth is integer | ✗ | ✓ |

### What SHOULD maxDepth=0 do?

**Option A:** Return only start nodes (depth 0)
**Option B:** Error ("depth must be >= 1")

The tool description says (line 474):
> Each with depth: 0 = start nodes, 1 = direct neighbors, 2+ = transitive

This implies depth=0 is VALID and means "start nodes only".

### The Fix

```typescript
if (maxDepth < 0) {
  return errorResult('maxDepth must be >= 0');
}
if (!Number.isInteger(maxDepth)) {
  return errorResult('maxDepth must be an integer');
}
if (maxDepth > 20) {
  return errorResult('maxDepth must be <= 20 to prevent performance issues');
}
```

---

## Edge Cases Not Covered by Plan

### A. `get_node` Handler

#### Completeness Table: Input Universe

| Input Category | Example | Plan Handles? | Should Handle? |
|----------------|---------|---------------|----------------|
| Valid semantic ID | "module:src/api.js" | ✓ | ✓ |
| Non-existent ID | "module:FOOBARBAZ" | ✓ (returns error) | ✓ |
| Empty string | "" | ✗ | ✓ |
| null | null | ✗ (type error) | ✓ |
| Very long string (10MB) | "x".repeat(10_000_000) | ✗ | ✓ |

#### Edge Cases

1. **Empty string semantic ID:**
   ```typescript
   const node = await db.getNode("");
   ```
   What does RFDB return? Probably null, but unverified.

2. **Semantic ID with special characters:**
   ```typescript
   const node = await db.getNode("module:\u0000\u0001");
   ```
   Does RFDB handle null bytes? Unverified.

3. **Node exists but has no metadata:**
   Plan returns full node, including `node.metadata`. If metadata is `undefined`, JSON.stringify works fine. ✓

#### Recommendation

Add validation:
```typescript
if (!semanticId || semanticId.trim() === '') {
  return errorResult('semanticId must be a non-empty string');
}
```

---

### B. `get_neighbors` Handler

#### Completeness Table: Input Universe

| Input Category | Example | Plan Handles? | Should Handle? |
|----------------|---------|---------------|----------------|
| Valid node, valid direction, valid edge types | "node1", "outgoing", ["CALLS"] | ✓ | ✓ |
| Node has no edges | Valid node, no edges | ✓ (returns empty groups) | ✓ |
| edgeTypes = [] (empty array) | [], direction="both" | ✗ | ✓ |
| edgeTypes = undefined | undefined | ✓ (passes null to backend) | ✓ |
| edgeTypes contains invalid type | ["FOOBARBAZ"] | ✗ | ✓ |
| Connected node was deleted | Edge points to non-existent dst | ✗ | ✓ |

#### Edge Case: Empty edgeTypes Array

```json
{
  "semanticId": "node1",
  "direction": "both",
  "edgeTypes": []
}
```

Line 660:
```typescript
const outgoing = await db.getOutgoingEdges(semanticId, edgeTypes as EdgeType[] || null);
```

**Problem:** `[] as EdgeType[]` is truthy, so `[] || null` returns `[]`, not `null`.

**Does RFDB interpret `[]` as "no filter" or "match no types"?**

Unverified. Most likely "match no types" (return empty), but could be "match all types".

#### Edge Case: Connected Node Deleted

Lines 665-670:
```typescript
for (const edge of outgoing) {
  if (!grouped[edge.type]) grouped[edge.type] = [];
  const dstNode = await db.getNode(edge.dst);
  grouped[edge.type].push({
    dst: edge.dst,
    node: dstNode ? { id: dstNode.id, type: dstNode.type, name: dstNode.name, file: dstNode.file, line: dstNode.line } : null,
    metadata: edge.metadata,
  });
}
```

**If `dstNode` is null, `node: null` is pushed.**

Is this acceptable? The tool description doesn't specify behavior for dangling edges.

**Recommendation:** Either:
1. Filter out dangling edges (skip edges where dst node doesn't exist)
2. Document that `node: null` means "target was deleted"

#### Recommendation

Add validation:
```typescript
if (edgeTypes && edgeTypes.length === 0) {
  return errorResult('edgeTypes must not be an empty array. Omit edgeTypes to get all edge types.');
}
```

---

### C. `traverse_graph` Handler

Already covered in Gaps #1, #2, #3 and Precondition Violations #1, #2.

Additional edge case:

#### Queue Growth Limit (Incoming BFS)

Lines 746-758:
```typescript
while (queue.length > 0) {
  const { id, depth } = queue.shift()!;
  if (depth >= maxDepth) continue;

  const incoming = await db.getIncomingEdges(id, edgeTypes as EdgeType[]);
  for (const edge of incoming) {
    if (!visited.has(edge.src)) {
      visited.add(edge.src);
      queue.push({ id: edge.src, depth: depth + 1 });
      results.push({ id: edge.src, depth: depth + 1 });
    }
  }
}
```

**What if the graph is huge and BFS visits 1,000,000 nodes?**

`queue` and `results` grow unbounded. No limit.

Outgoing BFS uses `backend.bfs()` which MAY have internal limits (unverified).

Incoming BFS has NO limits.

**Attack vector:**
```json
{
  "startNodeIds": ["root-of-huge-subtree"],
  "edgeTypes": ["CONTAINS"],
  "direction": "incoming",
  "maxDepth": 20
}
```

If there are 100,000 nodes that transitively contain this root, BFS visits all of them, allocates huge arrays, possibly OOM.

**Recommendation:** Add result count limit:

```typescript
const MAX_TRAVERSAL_RESULTS = 10000;

// Inside BFS loop:
if (results.length >= MAX_TRAVERSAL_RESULTS) {
  return errorResult(`Traversal exceeded limit of ${MAX_TRAVERSAL_RESULTS} nodes. Use more specific edge types or lower maxDepth.`);
}
```

---

## Missing Descriptions - Are All 8 Weak Tools Covered?

### Audit from `packages/mcp/src/definitions.ts`

**Don claims 8 weak tools (lines 96-313).** Let me verify against actual definitions.ts.

| Tool Name | Current Description | Don's Plan | Status |
|-----------|---------------------|------------|--------|
| `find_nodes` | "Find nodes in the graph by type, name, or file." | 7-line detailed description | ✓ Covered |
| `trace_dataflow` | "Trace data flow from/to a variable or expression." | 12-line detailed description | ✓ Covered |
| `get_stats` | "Get graph statistics: node and edge counts by type." | 9-line detailed description | ✓ Covered |
| `discover_services` | "Discover services in the project without full analysis." | 11-line detailed description | ✓ Covered |
| `analyze_project` | "Run full analysis on the project or a specific service." | 19-line detailed description | ✓ Covered |
| `get_coverage` | "Get analysis coverage for a path." | 11-line detailed description | ✓ Covered |
| `list_guarantees` | "List all defined guarantees." | 13-line detailed description | ✓ Covered |
| `check_guarantees` | "Check all guarantees or specific ones." | 14-line detailed description | ✓ Covered |

### Other Potentially Weak Tools

Let me check OTHER tools not in Don's list:

| Tool Name | Current Description | Weak? |
|-----------|---------------------|-------|
| `find_calls` | "Find all calls to a specific function or method. Returns call sites with file locations and whether they're resolved." | **Borderline** - could add use cases |
| `trace_alias` | "Trace an alias chain to find the original source. For code like: const alias = obj.method; alias(); This traces \"alias\" back to \"obj.method\"." | **Good** - has example |
| `check_invariant` | "Check a code invariant using a Datalog rule. Returns violations if the invariant is broken." | **Weak** - no use cases |
| `get_analysis_status` | "Get the current analysis status and progress." | **Weak** - no use cases |
| `get_schema` | "Get the graph schema: available node and edge types." | **Weak** - no use cases |
| `create_guarantee` | Has examples in description | **Good** |
| `delete_guarantee` | "Delete a guarantee by name." | **Weak** - no use cases |
| `get_documentation` | "Get documentation about Grafema usage." | **Weak** - no use cases |
| `report_issue` | Has detailed guidance | **Good** |
| `find_guards` | Has detailed explanation and use cases | **Good** |
| `get_function_details` | Has detailed explanation of graph structure and use cases | **Good** |
| `get_context` | Has detailed explanation | **Good** |
| `get_file_overview` | Has detailed explanation | **Good** |
| `read_project_structure` | Has explanation of use case | **Good** |
| `write_config` | Has detailed explanation | **Good** |

### Additional Weak Tools Not in Don's List

1. **`check_invariant`** - very similar to `check_guarantees`, just one-off instead of saved
2. **`get_analysis_status`** - no explanation of when/why to use
3. **`get_schema`** - no use cases (should explain it's for discovery/validation)
4. **`delete_guarantee`** - no use cases
5. **`get_documentation`** - no use cases (should explain it's for learning Datalog syntax, etc.)

**Recommendation:** Add these 5 to the improvement list.

---

## Summary of Gaps

### Critical Gaps (Block Implementation)

1. **Edge type mapping incomplete** - 22/74 types covered, missing 52 types
2. **BFS depth information lost** - Tool promises depth field, implementation doesn't provide it
3. **Empty string edge types not validated** - Leads to undefined behavior

### Precondition Violations (Must Fix)

1. **Duplicate start nodes not handled** - Inconsistent between outgoing/incoming
2. **maxDepth validation incomplete** - Negative values, zero, non-integers not checked

### Edge Cases (Should Fix)

1. **`get_node`**: Empty string semantic ID not validated
2. **`get_neighbors`**: Empty edgeTypes array ambiguous, dangling edges not documented
3. **`traverse_graph`**: No limit on result count for incoming BFS (OOM risk)

### Nice-to-Have (Enhancement)

1. **5 additional weak tool descriptions** not in Don's plan

---

## Recommendations

### Must Fix Before Implementation

1. **Edge type mapping:**
   - Build complete mapping of all 74 types in `packages/types/src/edges.ts`
   - Export `edgeTypeToNumber()` from `@grafema/types`
   - Use in both `GraphBackend.ts` and `graph-handlers.ts`
   - Add runtime validation for unknown edge types

2. **BFS depth information:**
   - Option A: Modify `backend.bfs()` to return `Array<{ id: string; depth: number }>`
   - Option D: Implement manual BFS for both directions

3. **Validation additions:**
   - Empty string checks for all string inputs
   - Edge type validation
   - maxDepth range validation (>= 0, <= 20, integer)
   - Deduplicate start nodes
   - Result count limits

### Should Fix

1. Document behavior for dangling edges in `get_neighbors`
2. Add 5 additional tool descriptions (check_invariant, get_analysis_status, get_schema, delete_guarantee, get_documentation)

### Process Recommendations

1. **Define RFDB behavior for edge type 0** - Is it "all types" or "invalid"? Document in RFDB wire protocol spec.
2. **Add integration tests** - Test with REAL RFDB, not mocks, to verify edge type mapping and BFS depth behavior.

---

## Final Verdict: REJECT

**Reason:** Critical gaps #1 (incomplete edge type mapping) and #2 (BFS depth information) are architectural issues that require design decisions before implementation can proceed.

**Next Step:** Don must revise the plan to address:
1. Complete edge type mapping strategy
2. BFS depth information strategy (modify backend.bfs or use manual BFS?)
3. Validation coverage for all input universes

Once these are resolved, Uncle Bob can review for code quality and Kent can begin implementation.
