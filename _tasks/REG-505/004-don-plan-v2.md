# REG-505: Don Melton Plan v2 — "Did You Mean" Suggestions on Empty Datalog Results

## Revision History

v2 incorporates all three gaps identified by Dijkstra's verification:
1. `type()` removed from scope (broken predicate — separate issue to file)
2. Case-insensitive exact match handled as suggestion
3. CLI `--json` mode sends suggestions to stderr
4. Empty graph guard added
5. `explain=true` early-return behavior documented explicitly

---

## 1. Summary of Findings

### levenshtein() — two implementations exist

**Primary export (canonical):**
- `packages/core/src/storage/backends/typeValidation.ts`, line 64
- Exported from `packages/core/src/index.ts`, line 151
- API: `levenshtein(a: string, b: string): number`
- Also exports `checkTypoAgainstKnownTypes()` and `checkTypoAgainstKnownEdgeTypes()` — these check against a static hardcoded set, NOT the live graph. Wrong tool for this task.

**Duplicate (MCP-local):**
- `packages/mcp/src/utils.ts`, line 120
- Also exports `findSimilarTypes(queriedType, availableTypes, maxDistance=2): string[]` (line 101)
- This `findSimilarTypes` is the right building block for MCP — it accepts an arbitrary live-graph list.

### countNodesByType() / countEdgesByType()

**RFDB client:** `packages/rfdb/ts/client.ts`, lines 651–662 — returns `Promise<Record<string, number>>`.

**RFDBServerBackend wrapper:** `packages/core/src/storage/backends/RFDBServerBackend.ts`, lines 649–660 — delegates to client.

**MCP GraphBackend interface:** `packages/mcp/src/types.ts`, lines 179–180 — both methods declared on `GraphBackend`, available on `db` in handlers.

**Test helper:** `test/helpers/TestRFDB.js`, lines 506–512 — available for integration tests.

### Datalog query execution paths

**MCP path:**
- `packages/mcp/src/handlers/query-handlers.ts`, function `handleQueryGraph()`, line 28
- Uses `db.checkGuarantee(query)` (line 49)
- **Partial implementation exists** (lines 52–73): when `total === 0`, calls `countNodesByType()` and runs regex `/node\([^,]+,\s*"([^"]+)"\)/` to extract one queried node type.
- Gap 1: regex only matches one `node()` predicate — multi-predicate queries not handled.
- Gap 2: no edge type suggestion at all.
- Gap 3: the existing regex matches only `node()` — this is now correct (see Section 2 below).
- Gap 4: empty graph shows "Available types: " with empty string.

**CLI path:**
- `packages/cli/src/commands/query.ts`, function `executeRawQuery()`, line 1095
- Uses `backend.executeDatalog(query)` (line 1112).
- Zero results: checks for unknown predicates (lines 1131–1137) and prints to stderr via `console.error`.
- **No type suggestion logic exists.** The CLI raw query path has zero "did you mean" coverage.

**Explain mode interaction:**
- In the CLI, `executeRawQuery()` checks `if (explain)` first (line 1102) and returns early after rendering the explain output (line 1109). The zero-results suggestion block (lines 1118–1128) is in the non-explain branch. Therefore `explain=true` never reaches the suggestion logic. This is **correct behavior**: when explain mode is active, the user is debugging query mechanics, not looking for type suggestions. Do not change this.
- In the MCP handler `handleQueryGraph()`, the explain check is at line 42–46 and returns before reaching the `total === 0` block at line 52. Same correct early-return — do not change this.

### existing `findSimilarTypes` bug: case-insensitive mismatch

`findSimilarTypes` at `packages/mcp/src/utils.ts`, line 111:

```typescript
const dist = levenshtein(queriedLower, type.toLowerCase());
if (dist > 0 && dist <= maxDistance) {
```

The condition `dist > 0` means that if the user writes `function` and the graph has `FUNCTION`, levenshtein distance is 0 (both lowercased), so no suggestion is generated. The fallback shows "Available types: FUNCTION, ..." which is technically correct but not the UX-ideal "did you mean FUNCTION?".

**Fix:** Change the condition to check original-casing mismatch: `dist === 0` should still suggest when `queriedType !== type` (casing differs). Specifically, replace `dist > 0 && dist <= maxDistance` with `dist <= maxDistance && (dist > 0 || queriedType !== type)`.

### `type()` predicate is broken in the Rust evaluator (OUT OF SCOPE)

Dijkstra found that `packages/rfdb-server/src/datalog/eval.rs`, lines 178–190, has no `"type"` branch:

```rust
match atom.predicate() {
    "node" => self.eval_node(atom),
    "edge" => self.eval_edge(atom),
    "incoming" => self.eval_incoming(atom),
    // ... no "type" branch
    _ => self.eval_derived(atom),  // "type" falls here, returns empty
}
```

The CLI help text (`packages/cli/src/commands/query.ts`, lines 95–96) incorrectly documents `type()` as the primary predicate and `node()` as the alias. The actual evaluator only implements `node()`.

**Decision for this task:** `type()` is excluded from the regex scope. The `extractQueriedTypes` function only handles `node()`, `edge()`, and `incoming()`. A separate Linear issue must be filed to either fix the Rust evaluator or correct the CLI documentation.

---

## 2. Architectural Decisions

### Where suggestion logic lives

The `extractQueriedTypes` pure function goes in `packages/mcp/src/utils.ts`. It is a pure string function — no graph dependency — making it testable in isolation. It is imported in `query-handlers.ts`.

The CLI cannot import from `@grafema/mcp` (dependency direction: CLI depends on core, not on MCP). Solution: create `packages/cli/src/utils/queryHints.ts` with a private copy of `extractQueriedTypes` and a private `findSimilarTypes` wrapper using `levenshtein` from `@grafema/core`. The CLI already imports `@grafema/core`.

The duplication of `extractQueriedTypes` between MCP and CLI is pragmatically correct given the dependency constraint. Document it with a comment.

### Suggestions are plain text, not structured

Suggestions are appended as plain text to the empty-result message (MCP) or printed to stderr (CLI). No new structured response type. This matches the existing partial implementation in `handleQueryGraph()`.

### JSON mode output destination

When CLI is in `--json` mode, the JSON result goes to stdout. Suggestions (type hints) go to **stderr** via `console.error`. This is consistent with the existing unknown-predicate warning at line 1136 which already uses `console.error`. JSON consumers of the CLI read stdout — stderr is safe.

---

## 3. Step-by-Step Implementation Plan

### Step 1: Write tests first (TDD mandate)

**File: `test/unit/QueryDebugging.test.js`**

Add a new `describe('Did You Mean Suggestions')` block covering:

**a. `extractQueriedTypes()` unit tests (pure, no DB):**
- `node(X, "FUNCTON")` → `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }`
- `node(_, "FUNCTON")` → `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }`
- `edge(X, Y, "CALS")` → `{ nodeTypes: [], edgeTypes: ["CALS"] }`
- `incoming(X, Y, "CALS")` → `{ nodeTypes: [], edgeTypes: ["CALS"] }`
- Multi-type: `node(X, "FUNCTON"), edge(X, Y, "CALS")` → both extracted
- Two node types: `node(X, "FUNCTON"), node(Y, "CALASS")` → both in nodeTypes
- Rule form: `violation(X) :- node(X, "FUNCTON").` → extracts node type
- `attr(X, "name", "foo")` → `{ nodeTypes: [], edgeTypes: [] }` (no false positive)
- Variable type `node(X, T)` (no quotes) → `{ nodeTypes: [], edgeTypes: [] }`
- **`type(X, "FUNCTON")` → `{ nodeTypes: [], edgeTypes: [] }` (excluded intentionally)**
- Empty string → `{ nodeTypes: [], edgeTypes: [] }`

**b. `findSimilarTypes()` case-sensitivity unit tests:**
- `findSimilarTypes("function", ["FUNCTION", "CLASS"])` → `["FUNCTION"]` (case mismatch, dist=0 but differs in casing)
- `findSimilarTypes("FUNCTION", ["FUNCTION", "CLASS"])` → `[]` (exact match, no suggestion)
- `findSimilarTypes("FUNCTON", ["FUNCTION", "CLASS"])` → `["FUNCTION"]` (dist=1)
- `findSimilarTypes("xyz123", ["FUNCTION", "CLASS"])` → `[]` (dist > 2)
- `findSimilarTypes("FUNCTON", [])` → `[]` (empty graph)

**c. Integration tests (with DB + fixture, using existing test infrastructure):**
- MCP path: `node(X, "FUNCTON")` → 0 results → response text contains "FUNCTION"
- MCP path: `edge(X, Y, "CALS")` → 0 results → response text contains "CALLS"
- MCP path: completely alien type → response lists available types (fallback)
- MCP path: empty graph (no nodes) → response shows "Graph has no nodes"
- CLI path: `node(X, "FUNCTON")` → 0 results, plain mode → stderr or stdout contains suggestion
- CLI path: `node(X, "FUNCTON")` → 0 results, `--json` mode → stdout is `[]`, suggestion on stderr

### Step 2: Fix `findSimilarTypes()` in `packages/mcp/src/utils.ts`

**Location:** Line 111 — the condition inside the `for` loop.

Current code (line 111):
```typescript
if (dist > 0 && dist <= maxDistance) {
```

Replace with:
```typescript
if (dist <= maxDistance && (dist > 0 || queriedType !== type)) {
```

This ensures that a case-only mismatch (`function` vs `FUNCTION`, dist=0 but strings differ) produces a suggestion, while a perfect case-sensitive match (`FUNCTION` vs `FUNCTION`) produces no suggestion.

### Step 3: Add `extractQueriedTypes()` to `packages/mcp/src/utils.ts`

**Location:** After the closing brace of `findSimilarTypes` at line 117, before the `levenshtein` function definition.

New export:

```typescript
export function extractQueriedTypes(query: string): { nodeTypes: string[]; edgeTypes: string[] } {
  const nodeTypes: string[] = [];
  const edgeTypes: string[] = [];

  // Match node(VAR, "TYPE") — the only working node predicate in the Rust evaluator.
  // Note: type(VAR, "TYPE") is intentionally excluded: the Rust evaluator has no "type"
  // branch and silently returns empty results. See separate issue for the root cause fix.
  const nodeRegex = /\bnode\([^,)]+,\s*"([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRegex.exec(query)) !== null) {
    nodeTypes.push(m[1]);
  }

  // Match edge(SRC, DST, "TYPE") and incoming(DST, SRC, "TYPE")
  const edgeRegex = /\b(?:edge|incoming)\([^,)]+,\s*[^,)]+,\s*"([^"]+)"\)/g;
  while ((m = edgeRegex.exec(query)) !== null) {
    edgeTypes.push(m[1]);
  }

  return { nodeTypes, edgeTypes };
}
```

### Step 4: Fix/extend `handleQueryGraph()` in `packages/mcp/src/handlers/query-handlers.ts`

**Location:** Replace the entire zero-results block, lines 52–73 (current partial implementation).

Add `extractQueriedTypes` to the import from `'../utils.js'` at line 12 (currently imports `findSimilarTypes` but not `extractQueriedTypes`).

Replace lines 52–73 with:

```typescript
if (total === 0) {
  const { nodeTypes, edgeTypes } = extractQueriedTypes(query);
  const hasQueriedTypes = nodeTypes.length > 0 || edgeTypes.length > 0;

  let hint = '';
  if (hasQueriedTypes) {
    const nodeCounts = nodeTypes.length > 0 ? await db.countNodesByType() : {};
    const edgeCounts = edgeTypes.length > 0 ? await db.countEdgesByType() : {};
    const availableNodeTypes = Object.keys(nodeCounts);
    const availableEdgeTypes = Object.keys(edgeCounts);

    const hintLines: string[] = [];

    if (nodeTypes.length > 0 && availableNodeTypes.length === 0) {
      hintLines.push('Graph has no nodes');
    } else {
      for (const queriedType of nodeTypes) {
        if (!nodeCounts[queriedType]) {
          const similar = findSimilarTypes(queriedType, availableNodeTypes);
          if (similar.length > 0) {
            hintLines.push(`Did you mean: ${similar.join(', ')}? (node type)`);
          } else {
            const typeList = availableNodeTypes.slice(0, 10).join(', ');
            const more = availableNodeTypes.length > 10 ? '...' : '';
            hintLines.push(`Available node types: ${typeList}${more}`);
          }
        }
      }
    }

    if (edgeTypes.length > 0 && availableEdgeTypes.length === 0) {
      hintLines.push('Graph has no edges');
    } else {
      for (const queriedType of edgeTypes) {
        if (!edgeCounts[queriedType]) {
          const similar = findSimilarTypes(queriedType, availableEdgeTypes);
          if (similar.length > 0) {
            hintLines.push(`Did you mean: ${similar.join(', ')}? (edge type)`);
          } else {
            const typeList = availableEdgeTypes.slice(0, 10).join(', ');
            const more = availableEdgeTypes.length > 10 ? '...' : '';
            hintLines.push(`Available edge types: ${typeList}${more}`);
          }
        }
      }
    }

    if (hintLines.length > 0) {
      hint = '\n' + hintLines.map(l => `Hint: ${l}`).join('\n');
    }
  }

  const nodeCounts = hasQueriedTypes ? await db.countNodesByType() : await db.countNodesByType();
  const totalNodes = Object.values(nodeCounts).reduce((a, b) => a + b, 0);

  return textResult(`Query returned no results.${hint}\nGraph: ${totalNodes.toLocaleString()} nodes`);
}
```

**Implementation note on totalNodes:** The `countNodesByType()` call for `totalNodes` should be deduplicated — if it was already called for node type checking, reuse the result. The implementer should consolidate the two `countNodesByType()` calls into one.

**Implementation note on the emoji removal:** The existing implementation uses `💡` and `📊` emoji. Per project style, avoid emojis in production code. Replace with plain text `Hint:` and `Graph:`.

### Step 5: Create `packages/cli/src/utils/queryHints.ts`

New file. The CLI cannot import from `@grafema/mcp`. This file is a private CLI utility.

```typescript
/**
 * Query hint utilities for the CLI raw query path.
 *
 * Note: extractQueriedTypes() is intentionally duplicated from packages/mcp/src/utils.ts.
 * The CLI cannot import @grafema/mcp (dependency direction). If the Datalog syntax changes,
 * both copies must be updated.
 */
import { levenshtein } from '@grafema/core';

export function extractQueriedTypes(query: string): { nodeTypes: string[]; edgeTypes: string[] } {
  const nodeTypes: string[] = [];
  const edgeTypes: string[] = [];

  // Match node(VAR, "TYPE") — only working node predicate.
  // type(VAR, "TYPE") is excluded: Rust evaluator has no "type" branch.
  const nodeRegex = /\bnode\([^,)]+,\s*"([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRegex.exec(query)) !== null) {
    nodeTypes.push(m[1]);
  }

  const edgeRegex = /\b(?:edge|incoming)\([^,)]+,\s*[^,)]+,\s*"([^"]+)"\)/g;
  while ((m = edgeRegex.exec(query)) !== null) {
    edgeTypes.push(m[1]);
  }

  return { nodeTypes, edgeTypes };
}

export function findSimilarTypes(
  queriedType: string,
  availableTypes: string[],
  maxDistance: number = 2
): string[] {
  const queriedLower = queriedType.toLowerCase();
  const similar: string[] = [];

  for (const type of availableTypes) {
    const dist = levenshtein(queriedLower, type.toLowerCase());
    if (dist <= maxDistance && (dist > 0 || queriedType !== type)) {
      similar.push(type);
    }
  }

  return similar;
}
```

### Step 6: Add suggestion logic to CLI `executeRawQuery()` in `packages/cli/src/commands/query.ts`

**Location:** After the existing unknown-predicate warning block (lines 1131–1137), still inside the `if (limited.length === 0)` block.

Import at the top of the file: `import { extractQueriedTypes, findSimilarTypes } from '../utils/queryHints.js';`

Add after the unknown-predicate block inside `executeRawQuery`, still guarded by `if (limited.length === 0)`:

```typescript
// Type suggestions: only if there are type literals in the query
const { nodeTypes, edgeTypes } = extractQueriedTypes(query);
if (nodeTypes.length > 0 || edgeTypes.length > 0) {
  const nodeCounts = nodeTypes.length > 0 ? await backend.countNodesByType() : {};
  const edgeCounts = edgeTypes.length > 0 ? await backend.countEdgesByType() : {};
  const availableNodeTypes = Object.keys(nodeCounts);
  const availableEdgeTypes = Object.keys(edgeCounts);

  if (nodeTypes.length > 0 && availableNodeTypes.length === 0) {
    console.error('Note: graph has no nodes');
  } else {
    for (const queriedType of nodeTypes) {
      if (!nodeCounts[queriedType]) {
        const similar = findSimilarTypes(queriedType, availableNodeTypes);
        if (similar.length > 0) {
          console.error(`Note: unknown node type "${queriedType}". Did you mean: ${similar.join(', ')}?`);
        } else {
          const typeList = availableNodeTypes.slice(0, 10).join(', ');
          const more = availableNodeTypes.length > 10 ? '...' : '';
          console.error(`Note: unknown node type "${queriedType}". Available: ${typeList}${more}`);
        }
      }
    }
  }

  if (edgeTypes.length > 0 && availableEdgeTypes.length === 0) {
    console.error('Note: graph has no edges');
  } else {
    for (const queriedType of edgeTypes) {
      if (!edgeCounts[queriedType]) {
        const similar = findSimilarTypes(queriedType, availableEdgeTypes);
        if (similar.length > 0) {
          console.error(`Note: unknown edge type "${queriedType}". Did you mean: ${similar.join(', ')}?`);
        } else {
          const typeList = availableEdgeTypes.slice(0, 10).join(', ');
          const more = availableEdgeTypes.length > 10 ? '...' : '';
          console.error(`Note: unknown edge type "${queriedType}". Available: ${typeList}${more}`);
        }
      }
    }
  }
}
```

All output uses `console.error` — this is safe in both plain and `--json` modes. In JSON mode, stdout contains only the JSON result `[]`; stderr contains the suggestion. This matches the pattern already established by the unknown-predicate warning at line 1136.

**`explain=true` is not affected:** The suggestion block is inside the `if (!explain)` branch of `executeRawQuery` (line 1102 returns early for explain mode). No change needed to the explain path.

### Step 7: File a separate issue for `type()` predicate bug

After this task is complete, create a Linear issue in REG with:
- Title: "`type()` predicate not implemented in Rust evaluator — returns empty results"
- Description: The CLI help text (`packages/cli/src/commands/query.ts`, lines 95–96) documents `type()` as primary and `node()` as alias, but `packages/rfdb-server/src/datalog/eval.rs` (line 189) has no `"type"` branch. `type(X, "FUNCTION")` silently returns zero results via `eval_derived`. Either add `"type" => self.eval_node(atom)` to the Rust dispatch table, or correct the CLI documentation to remove `type()` entirely.

### Step 8: Build and run tests

```bash
pnpm build
node --test test/unit/QueryDebugging.test.js
node --test --test-concurrency=1 'test/unit/*.test.js'
```

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `packages/mcp/src/utils.ts` | (1) Fix `findSimilarTypes` condition at line 111: `dist > 0` → `dist <= maxDistance && (dist > 0 \|\| queriedType !== type)`. (2) Add `extractQueriedTypes()` export after line 117. |
| `packages/mcp/src/handlers/query-handlers.ts` | (1) Add `extractQueriedTypes` to import at line 12. (2) Replace zero-results block lines 52–73 with multi-type suggestion logic. |
| `packages/cli/src/commands/query.ts` | (1) Add import for `extractQueriedTypes`, `findSimilarTypes` from `../utils/queryHints.js`. (2) Add suggestion logic to `executeRawQuery()` zero-results branch after existing unknown-predicate warning. |
| `packages/cli/src/utils/queryHints.ts` | **New file:** private `extractQueriedTypes()` + `findSimilarTypes()` for CLI use. |
| `test/unit/QueryDebugging.test.js` | Add `describe('Did You Mean Suggestions')` tests (see Step 1). |

**No changes to:**
- `packages/core/` — `levenshtein` already exported; `countNodesByType`/`countEdgesByType` already on backend
- `packages/rfdb/` or `packages/rfdb-server/` — `type()` fix is a separate issue
- `packages/types/` — no new structured types needed

---

## 5. Behavior Specification

### Scenario matrix

| Query | Graph state | Expected behavior |
|-------|-------------|-------------------|
| `node(X, "FUNCTON")` | FUNCTION type exists | Hint: Did you mean: FUNCTION? |
| `node(X, "function")` | FUNCTION type exists | Hint: Did you mean: FUNCTION? (case mismatch) |
| `node(X, "FUNCTION")` | FUNCTION type exists | No hint (type exists, 0 results from query filter) |
| `node(X, "XYZABC123")` | multiple types exist | Hint: Available node types: FUNCTION, CLASS, ... |
| `node(X, "FUNCTON")` | no nodes in graph | Hint: Graph has no nodes |
| `edge(X, Y, "CALS")` | CALLS edge type exists | Hint: Did you mean: CALLS? |
| `node(X, "FUNCTON"), edge(X, Y, "CALS")` | both exist | Two hint lines, one per type |
| `attr(X, "name", "foo")` | any | No hint (no type literals) |
| `type(X, "FUNCTON")` | any | No hint (`type()` not in regex — separate bug) |
| explain=true, any query, 0 results | any | No hint (explain returns early — correct behavior) |
| `--json`, `node(X, "FUNCTON")`, 0 results | FUNCTION exists | stdout: `[]`, stderr: `Note: unknown node type "FUNCTON". Did you mean: FUNCTION?` |

---

## 6. Risk Assessment

### Low risk
- `extractQueriedTypes` is pure string parsing. Wrong regex → silent degradation, not a crash.
- MCP handler change replaces only the zero-results block. Success path (results > 0) is untouched. Explain path is untouched.
- `findSimilarTypes` condition change: the only behavioral change is adding case-mismatch suggestions. Existing behavior for typo suggestions is unchanged.

### Medium risk
- CLI `executeRawQuery` is now async if `countNodesByType`/`countEdgesByType` calls are added. The function is already async (it awaits `backend.executeDatalog`). No signature change needed.
- Duplication of `extractQueriedTypes` between MCP and CLI. Documented. Acceptable given dependency constraints.

### Non-risks
- The `levenshtein()` duplication between `typeValidation.ts` and `mcp/utils.ts` — pre-existing, out of scope.
- `checkTypoAgainstKnownTypes` / `checkTypoAgainstKnownEdgeTypes` — used for write-time validation, not touched.
