# REG-505: Don Melton Plan — "Did You Mean" Suggestions on Empty Datalog Results

## 1. Summary of Findings

### levenshtein() — two implementations exist

**Primary export (used by tests, canonical):**
- `packages/core/src/storage/backends/typeValidation.ts`, line 64
- Exported from `packages/core/src/index.ts`, line 151
- API: `levenshtein(a: string, b: string): number`
- Also exports `checkTypoAgainstKnownTypes()` and `checkTypoAgainstKnownEdgeTypes()` — but these check against a static hardcoded set, NOT against the live graph. Wrong tool for this task.

**Duplicate (MCP-local, not exported):**
- `packages/mcp/src/utils.ts`, line 120
- Also exports `findSimilarTypes(queriedType, availableTypes, maxDistance=2): string[]` (line 101)
- This `findSimilarTypes` is the correct building block — it takes an arbitrary list of types from the live graph.

### countNodesByType() / countEdgesByType()

**RFDB client:** `packages/rfdb/ts/client.ts`, lines 651-662
- Returns `Promise<Record<string, number>>` — map of type name to count.

**RFDBServerBackend wrapper:** `packages/core/src/storage/backends/RFDBServerBackend.ts`, lines 649-660
- Delegates to `this.client.countNodesByType()` / `this.client.countEdgesByType()`.

**MCP GraphBackend interface:** `packages/mcp/src/types.ts`, lines 179-180
- Both methods declared on `GraphBackend`. Available on `db` in handlers.

**Test helper:** `test/helpers/TestRFDB.js`, lines 506-512 — available for testing.

### Datalog query execution paths

**MCP path:**
- `packages/mcp/src/handlers/query-handlers.ts`, function `handleQueryGraph()`, line 28
- Uses `db.checkGuarantee(query)` (line 49) — legacy name, now backed by `executeDatalog`.
- **Partial implementation already exists** (lines 52-73): when `total === 0`, it calls `countNodesByType()` and runs a regex `/node\([^,]+,\s*"([^"]+)"\)/` to extract the queried node type.
- **Gap 1:** The regex only matches one `node()` predicate. Multi-predicate queries with several node types are not handled.
- **Gap 2:** No edge type suggestion — `edge(X, Y, "CALS")` is not handled at all.
- **Gap 3:** The regex only matches `node()`, not the `type()` alias (which is the same predicate per RFDB docs and CLI help text).

**CLI path:**
- `packages/cli/src/commands/query.ts`, function `executeRawQuery()`, line 1095
- Uses `backend.executeDatalog(query)` (line 1112).
- When `results.length === 0`, it checks for unknown predicates (`getUnknownPredicates`) and prints a warning to stderr (lines 1131-1137).
- **No type suggestion logic exists here at all.** The CLI raw query path has zero "did you mean" coverage.

### QueryDebugging.test.js

`test/unit/QueryDebugging.test.js`
- Already has `describe('Empty Query Stats')` block (lines 78-118) with tests for `countNodesByType()`, checking that misspelled types don't exist, and simulating Levenshtein matching.
- The test at line 101 directly implements the suggestion logic inline (not using `findSimilarTypes` from utils) — it proves the pattern works but the production code doesn't match the test's intent yet.
- Test file imports `levenshtein` from `@grafema/core` (line 19) for ad-hoc use.

### Existing query response format

- `checkGuarantee()` returns `Array<{ bindings: Array<{ name: string; value: string }> }>` — plain binding arrays.
- `executeDatalog()` returns the same format.
- No structured `suggestions` field in the response — suggestions are injected as plain text into the `textResult()` string. This is the existing pattern in `handleQueryGraph()`.

### Regex gap analysis

Current MCP regex: `/node\([^,]+,\s*"([^"]+)"\)/`

What it misses:
1. `type(X, "FUNCTON")` — the `type()` alias is not matched
2. `edge(X, Y, "CALS")` — edge types not matched at all
3. Multiple node types in one query: `node(X, "FUNCTON"), node(Y, "CALASS")` — only first match returned
4. Rules with head: `violation(X) :- node(X, "FUNCTON").` — this actually DOES match because the regex searches the whole string, so it finds it. But only the first match.

---

## 2. Architectural Decision: Where Should Suggestion Logic Live?

**Decision: in a shared utility function in `packages/mcp/src/utils.ts`, called from both the MCP handler and the CLI raw query path.**

Rationale:

1. `findSimilarTypes()` already exists in `packages/mcp/src/utils.ts` and is already imported in `query-handlers.ts`. This is the right home.

2. A new function `extractQueriedTypes(query: string): { nodeTypes: string[]; edgeTypes: string[] }` should be added to `packages/mcp/src/utils.ts`. It extracts all type literals from `node()`/`type()` predicates and all edge type literals from `edge()`/`incoming()` predicates in the query string. This is a pure string function with no graph dependency — testable in isolation.

3. The suggestion generation — fetching counts, running Levenshtein, formatting hints — stays in each call site (MCP handler and CLI command). Each site formats output differently (MCP returns a `textResult`, CLI writes to stdout/stderr).

4. We do NOT move suggestions into the RFDB backend or RFDBServerBackend. The task explicitly says "Logic can be at JS level." Putting it in the graph backend would violate separation of concerns — the graph layer has no business formatting user-facing hints.

5. We do NOT add a new structured response type. The existing pattern of appending hint text to the empty-result message is correct and consistent with the codebase. The acceptance criteria says `suggestions: ["FUNCTION"]` conceptually; the actual format should match what already exists in `handleQueryGraph()`.

---

## 3. Step-by-Step Implementation Plan

### Step 1: Write tests first (TDD mandate)

**File: `test/unit/QueryDebugging.test.js`**

Add a new `describe('Did You Mean Suggestions')` block covering:

a. `extractQueriedTypes()` unit tests (pure function, no DB needed):
   - `node(X, "FUNCTON")` extracts `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }`
   - `type(X, "FUNCTON")` extracts `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }` (alias)
   - `edge(X, Y, "CALS")` extracts `{ nodeTypes: [], edgeTypes: ["CALS"] }`
   - `incoming(X, Y, "CALS")` extracts `{ nodeTypes: [], edgeTypes: ["CALS"] }`
   - Multiple: `node(X, "FUNCTON"), edge(X, Y, "CALS")` extracts both
   - Rule form: `violation(X) :- node(X, "FUNCTON").` extracts the node type
   - Direct form: `node(X, "FUNCTON")` (no `:-`) extracts it too
   - No type literals: `attr(X, "name", "foo")` extracts nothing

b. Integration tests (with DB + fixture):
   - MCP path: when `node(X, "FUNCTON")` returns 0 results, response text includes "FUNCTION" suggestion
   - MCP path: when `edge(X, Y, "CALS")` returns 0 results, response text includes "CALLS" suggestion
   - MCP path: when a completely alien type is queried, response lists available types instead
   - CLI path: same scenarios via `executeRawQuery` output (capture stdout/stderr)

### Step 2: Add `extractQueriedTypes()` to `packages/mcp/src/utils.ts`

New export function at the end of the TYPE HELPERS section (after `findSimilarTypes`, around line 117):

```typescript
export function extractQueriedTypes(query: string): { nodeTypes: string[]; edgeTypes: string[] } {
  const nodeTypes: string[] = [];
  const edgeTypes: string[] = [];

  // Match node(VAR, "TYPE") and type(VAR, "TYPE") predicates
  // Handles: node(X, "FOO"), type(X, "FOO"), node(_, "FOO")
  const nodeRegex = /\b(?:node|type)\([^,)]+,\s*"([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRegex.exec(query)) !== null) {
    nodeTypes.push(m[1]);
  }

  // Match edge(SRC, DST, "TYPE") and incoming(DST, SRC, "TYPE") predicates
  const edgeRegex = /\b(?:edge|incoming)\([^,)]+,\s*[^,)]+,\s*"([^"]+)"\)/g;
  while ((m = edgeRegex.exec(query)) !== null) {
    edgeTypes.push(m[1]);
  }

  return { nodeTypes, edgeTypes };
}
```

Note: `attr(X, "name", "foo")` has the same positional pattern as edge, but only matches 2-arg predicates for node/type and 3-arg predicates for edge/incoming. The regex correctly distinguishes these.

### Step 3: Fix/extend `handleQueryGraph()` in `packages/mcp/src/handlers/query-handlers.ts`

Replace the current zero-results block (lines 52-73) with logic that:

1. Calls `extractQueriedTypes(query)` to get all queried node types and edge types.
2. Calls `countNodesByType()` and `countEdgesByType()` (only if there are queried types to check — avoid unnecessary DB calls if no types found).
3. For each queried node type not present in the node counts, calls `findSimilarTypes()` against `Object.keys(nodeCounts)`.
4. For each queried edge type not present in the edge counts, calls `findSimilarTypes()` against `Object.keys(edgeCounts)`.
5. Builds a multi-line hints string, one hint per missing type.
6. Falls back to showing available types if no similar types found (existing behavior, just generalized).

The `db.countEdgesByType()` call is gated behind "only if edge types were queried" to avoid performance overhead.

### Step 4: Add suggestion logic to CLI `executeRawQuery()` in `packages/cli/src/commands/query.ts`

Currently `executeRawQuery()` only checks for unknown predicates. Add after the existing unknown-predicate check (around line 1137):

1. Import `extractQueriedTypes` from `@grafema/mcp` utils, OR duplicate the function inline. Given the CLI imports from `@grafema/core` but not `@grafema/mcp`, and since `extractQueriedTypes` is pure string logic with no deps, the cleanest option is to move `extractQueriedTypes` to `@grafema/core` exports so both MCP and CLI can import it. However, this would require adding it to the core package which is a broader change.

   **Alternative (simpler, no new exports):** Keep `extractQueriedTypes` in `packages/mcp/src/utils.ts` and add a parallel private copy in `query.ts`. These are simple regex functions — duplication here is acceptable given they live in different packages with different dependency directions. The CLI cannot depend on `@grafema/mcp`.

   **Decision:** Inline a private `extractQueriedTypes` in `query.ts` (or extract to a local `cli/src/utils/queryHints.ts`). Given CLI already has `utils/` subdirectory, create `packages/cli/src/utils/queryHints.ts` with the shared logic — cleaner than inline.

2. Call `backend.countNodesByType()` and `backend.countEdgesByType()` after getting zero results.
3. Use `findSimilarTypes` — but `findSimilarTypes` lives in `@grafema/mcp` which CLI can't import. **Solution:** Inline the levenshtein similarity check in `queryHints.ts`, using `levenshtein` from `@grafema/core` (already imported in the test file this way).

### Step 5: Build and run tests

```bash
pnpm build
node --test test/unit/QueryDebugging.test.js
node --test --test-concurrency=1 'test/unit/*.test.js'
```

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `packages/mcp/src/utils.ts` | Add `extractQueriedTypes()` export (after line 117) |
| `packages/mcp/src/handlers/query-handlers.ts` | Replace lines 52-73 with extended suggestion logic using `extractQueriedTypes` and adding edge type support |
| `packages/cli/src/commands/query.ts` | Add suggestion logic to `executeRawQuery()` at the zero-results branch |
| `packages/cli/src/utils/queryHints.ts` | New file: `extractQueriedTypes()` + `findSimilarNodeTypes()` / `findSimilarEdgeTypes()` helpers for CLI use |
| `test/unit/QueryDebugging.test.js` | Add `describe('Did You Mean Suggestions')` tests |

**No changes to:**
- `packages/core/` — Levenshtein is already exported; `countNodesByType`/`countEdgesByType` already available via backend
- `packages/rfdb/` — no Rust changes needed
- `packages/types/` — no new types needed (suggestions are plain text, not structured data)

---

## 5. Risk Assessment

### Low risk
- **Pure string parsing (`extractQueriedTypes`):** No graph interaction. Pure regex extraction. Isolated, fully testable. If the regex is wrong it produces empty suggestions — silent degradation, not a crash.
- **MCP handler change is additive:** The existing partial implementation in `handleQueryGraph` is replaced with a more complete version. The success path (results > 0) is completely untouched.
- **No schema changes:** No new response types, no new protocol fields.

### Medium risk
- **Regex coverage for query syntax variations:** The Datalog syntax is flexible. The regex must handle: whitespace variations, variable names with underscores, the `_` wildcard, quoted strings. The proposed regex handles these. However, if new predicate forms are added in the future (e.g., a `node_type(X, T)` predicate), the regex won't match them. This is acceptable — suggestions degrade gracefully to "no hint".
- **CLI path: `countNodesByType` / `countEdgesByType` are async calls added to the zero-results path.** These are fast RFDB queries (return counts only, not data). Performance impact is negligible. But the `executeRawQuery` function currently has no access to the backend's `countEdgesByType` — it only holds `backend: RFDBServerBackend`. `RFDBServerBackend` exposes both methods (lines 649-660 confirmed). No interface change needed.
- **Duplicate `extractQueriedTypes` between MCP and CLI packages:** The CLI can't import from `@grafema/mcp` (would create a dependency cycle). Keeping separate implementations is pragmatically correct but introduces maintenance risk if the Datalog syntax evolves. Acceptable for now, document the duplication.

### Non-risks
- **The existing `checkTypoAgainstKnownTypes` / `checkTypoAgainstKnownEdgeTypes` in `typeValidation.ts`** — these are used for WRITE-TIME validation (preventing bad types being added to the graph). They are NOT the right tool for this task (they check against a static hardcoded set, not the live graph). We do not touch them.
- **The `levenshtein()` duplication between `typeValidation.ts` and `mcp/utils.ts`** — this is a pre-existing issue. We do not resolve it as part of this task (out of scope).
