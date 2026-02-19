# Uncle Bob PREPARE Review: REG-507 — Adding `count: true` to query_graph

---

## Uncle Bob PREPARE Review: packages/mcp/src/types.ts

**File size:** 346 lines — OK

**Methods to modify:** `QueryGraphArgs` interface (lines 43–49)

**File-level:**
- Single responsibility: types-only file. Clear and focused. Each section is well-delineated by section comments.
- No logic, no side effects. This is the right place for `QueryGraphArgs`.
- Adding `count?: boolean` is a one-line insertion into an existing 7-line interface. No structural impact.

**Method-level:** types.ts:QueryGraphArgs (lines 43–49)

```
export interface QueryGraphArgs {
  query: string;
  limit?: number;
  offset?: number;
  format?: 'table' | 'json' | 'tree';
  explain?: boolean;
}
```

- Interface has 5 fields (4 optional). Adding one more keeps it at 6 total — still manageable.
- `count?: boolean` follows the same boolean-flag pattern as `explain?: boolean`. Consistent.
- No refactoring needed here.
- **Recommendation:** SKIP refactoring. Add `count?: boolean` directly.

**Risk:** LOW
**Estimated scope:** 1 line added

---

## Uncle Bob PREPARE Review: packages/mcp/src/definitions.ts

**File size:** 665 lines — MUST SPLIT (exceeds 500-line hard limit)

**Methods to modify:** `query_graph` tool definition, the `inputSchema.properties` object (lines 50–69)

**File-level:**
- At 665 lines this file is over the hard limit. However, this is a data-only file: a single exported `TOOLS` array containing ~18 tool definition objects. There is no logic — it is a pure configuration manifest.
- The SRP is borderline: all definitions live in one flat array. A split by domain group (query tools, guarantee tools, admin tools, graph-read tools) would be the clean direction.
- **However:** this is a PREPARE phase review. The task is to add one property to one tool definition. A file split now is an unrelated refactoring that belongs in STEP 2.5 as a separate ticket, not as a blocker for REG-507 implementation.
- **Action required:** File split is non-negotiable per the rules, but it must be scoped correctly. The split should be raised as a separate refactoring task. For this PR, the change is a single `count` property addition — low blast radius regardless of file size.
- **IMMEDIATE CONCERN:** Flag this file for a follow-up split ticket (e.g., REG-definitions-split). Do not block REG-507 on it.

**Method-level:** definitions.ts:query_graph inputSchema.properties (lines 50–69)

```typescript
properties: {
  query: { ... },
  limit: { ... },
  offset: { ... },
  explain: { ... },
},
```

- Currently 4 properties. Adding `count` brings it to 5.
- Each property is a flat SchemaProperty object (2–3 fields). No nesting beyond the expected JSON-Schema shape.
- `count` must sit logically after `explain` or after `offset`, before any unrelated parameters. Placing it after `explain` mirrors the interface ordering.
- Description must be precise: "Return only the count of matching results, without fetching node data (default: false). Use when you only need the number of results."
- No refactoring of the surrounding structure is warranted.
- **Recommendation:** SKIP refactoring. Add `count` property after `explain`.

**Risk:** LOW (data-only change in a large but logic-free file)
**Estimated scope:** 5 lines added (property block)

**Debt note:** File is 665 lines. Log for post-REG-507 cleanup.

---

## Uncle Bob PREPARE Review: packages/mcp/src/handlers/query-handlers.ts

**File size:** 322 lines — OK

**Methods to modify:** `handleQueryGraph` (lines 29–148, 120 lines total)

**File-level:**
- File exports three functions: `handleQueryGraph`, `handleFindCalls`, `handleFindNodes`, plus one private `formatExplainOutput`. Cohesive — all query-related handlers. Single responsibility holds.
- 322 lines is well within limits.

**Method-level:** query-handlers.ts:handleQueryGraph (lines 29–148)

`handleQueryGraph` is 120 lines — above the 50-line candidate-for-split threshold.

Breakdown of existing structure:
1. Lines 30–34: Setup (db, args destructure, limit/offset normalization) — 5 lines
2. Lines 36–40: Backend capability guard — 5 lines
3. Lines 42–47: Explain branch (early return) — 6 lines
4. Lines 49–50: Run query — 2 lines
5. Lines 53–108: Zero-results hint logic — 56 lines ← the bulk
6. Lines 110–143: Paginate, enrich, format and return — 34 lines

The zero-results hint block (lines 53–108) is the clearest candidate for extraction. It:
- Does one discrete thing: builds a diagnostic hint string when results are empty
- Has 2 levels of nesting within the outer `if (total === 0)` block
- Does not interact with the count feature being added

The new `count` branch will add an early-return path immediately after the query executes (after line 50, before line 53). It is a clean insertion point: `if (count) { return textResult(String(total)); }`. This adds approximately 3 lines.

**Recommendation for zero-results block:** SKIP extraction in this PR. The existing nesting depth is acceptable (2 levels deep inside the try block) and the block is cohesive. Extracting it would reduce method length but adds indirection with no payoff for this change. Reserve for a dedicated refactoring pass if the method grows further.

**Recommendation for count addition:** SKIP any surrounding refactoring. Insert the `count` early-return after `const total = results.length;` (line 51). This is the minimal, correct, and obvious place.

The `count` branch must:
- Skip the zero-results hint (no node data fetched)
- Skip pagination (no node data fetched)
- Return a single-line result: total as a number
- Be placed BEFORE the zero-results `if (total === 0)` block to avoid false "no results" messages when count is requested

**Risk:** LOW
**Estimated scope:** 3–5 lines added in `handleQueryGraph`

---

## Summary

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `types.ts` | 346 | OK | Add 1 line to `QueryGraphArgs` |
| `definitions.ts` | 665 | MUST SPLIT (post-PR debt) | Add `count` property, log split ticket |
| `query-handlers.ts` | 322 | OK | Add 3–5 lines to `handleQueryGraph` |

**Overall risk:** LOW — all changes are additive, localized, and follow existing patterns.

**One structural note for implementer:** In `handleQueryGraph`, the `count` path must be an early return placed at line ~52, after `const total = results.length` and BEFORE the `if (total === 0)` hint block. Do not allow the hint logic to execute when `count: true` is passed — it would waste `countNodesByType` and `countEdgesByType` calls.

**Post-PR debt:** Create a follow-up ticket to split `definitions.ts` into domain-grouped files (query defs, guarantee defs, admin defs, graph-read defs). At 665 lines it has crossed the hard limit.
