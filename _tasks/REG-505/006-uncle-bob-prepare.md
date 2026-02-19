# Uncle Bob PREPARE Review: REG-505

Reviewed against Don's plan v2 (`004-don-plan-v2.md`).

---

## Uncle Bob PREPARE Review: `packages/mcp/src/utils.ts`

**File size:** 205 lines — OK

**Methods to modify:**
- `findSimilarTypes` (lines 101–117): 17 lines — OK
- New export `extractQueriedTypes`: ~20 lines (insert after line 117)

**File-level:** OK. Well-organized with section comments. The insertion point (after `findSimilarTypes` at line 117, before the `levenshtein` comment at line 119) is clean.

**Method-level:** `packages/mcp/src/utils.ts:findSimilarTypes`
- **Recommendation:** SKIP (no split needed — 17 lines, single loop)
- The one-line condition fix (`dist > 0` → `dist <= maxDistance && (dist > 0 || queriedType !== type)`) is straightforward.
- `extractQueriedTypes` as specified in the plan is clean: two regexes, two while loops, a return. No hidden complexity. Fits the file's existing pattern of small, focused exports.

**Risk:** LOW
**Estimated scope:** 3 lines changed in `findSimilarTypes` (condition only); ~20 lines added for `extractQueriedTypes`.

---

## Uncle Bob PREPARE Review: `packages/mcp/src/handlers/query-handlers.ts`

**File size:** 287 lines — OK

**Methods to modify:**
- `handleQueryGraph` (lines 28–113): 86 lines — candidate for review, but the growth is constrained to the zero-results block replacement only. Success path is untouched.
- Zero-results block to replace: lines 52–73 (22 lines) → replacement block from plan: ~50 lines.

**File-level:** OK. Clear section structure. The existing zero-results block (lines 52–73) is already isolated by the `if (total === 0)` guard.

**Method-level:** `packages/mcp/src/handlers/query-handlers.ts:handleQueryGraph`
- **Recommendation:** SKIP (no split needed pre-implementation)
- After replacement, `handleQueryGraph` will grow from 86 to approximately 114 lines. This approaches the 50-line method threshold but does not cross any hard limit.
- One concrete issue in the plan's replacement code (lines 256–257 of the plan):

```typescript
const nodeCounts = hasQueriedTypes ? await db.countNodesByType() : await db.countNodesByType();
```

This is a redundant unconditional call — both branches call `countNodesByType()`. The plan itself flags this as a known issue ("implementer should consolidate"). The fix is to hoist the `countNodesByType()` call: declare `nodeCounts` once before the `if (hasQueriedTypes)` block and reuse it for both the hint logic and the `totalNodes` calculation. The implementer must address this; it is not a refactor to do in STEP 2.5, but it must not be shipped as written in the plan.

- Import addition (line 199 of plan): add `extractQueriedTypes` to the existing import from `'../utils.js'` at line 11 of the file. This is a single-line change.
- Emoji removal: existing lines 64, 66, 71 use `💡` and `📊`. These are in the block being replaced entirely — no surgical cleanup needed.

**Risk:** LOW
**Estimated scope:** 1 import line changed; lines 52–73 (22 lines) replaced by ~50 lines.

---

## Uncle Bob PREPARE Review: `packages/cli/src/commands/query.ts`

**File size:** 1177 lines — CRITICAL (exceeds 700-line threshold)

**Methods to modify:**
- `executeRawQuery` (lines 1095–1139): 45 lines — OK for the method itself
- Import block (top of file, lines 12–20): adding one import

**File-level:** CRITICAL size. However, this file is NOT being split as part of this task. The plan's scope is confined to:
1. Adding one import line at the top
2. Adding ~40 lines after line 1137, inside `executeRawQuery`

The PREPARE recommendation is to NOT split this file in STEP 2.5. Splitting a 1177-line file is an architectural change that would expand scope significantly and carries merge risk. This is a pre-existing debt issue. The implementer touches only a localized tail section.

**Method-level:** `packages/cli/src/commands/query.ts:executeRawQuery`
- **Recommendation:** SKIP (no refactor pre-implementation)
- The method is 45 lines and will grow to ~85 lines after the addition. Still under the 100-line practical threshold for a function that is not deeply nested.
- The new suggestion block is inserted inside the `if (limited.length === 0)` block at lines 1131–1137 — the guard is already there. The plan correctly notes that the `if (limited.length === 0)` outer guard (line 1131) wraps both the unknown-predicate warning AND the new suggestion logic.

One naming concern: the plan specifies importing `extractQueriedTypes` and `findSimilarTypes` from `'../utils/queryHints.js'`. The file `packages/cli/src/utils/queryHints.ts` does not yet exist — it is created in Step 5 of the plan. The implementer must create `queryHints.ts` (Step 5) before adding the import in `query.ts` (Step 6), or the build will fail. Execution order matters.

**Risk:** MEDIUM (file is CRITICAL size, increasing collision risk if other work is happening in this file concurrently; but the edit is localized to lines 1131–1139 and the import block)
**Estimated scope:** 1 import line added; ~40 lines added inside `executeRawQuery`.

---

## Uncle Bob PREPARE Review: `test/unit/QueryDebugging.test.js`

**File size:** 229 lines — OK

**Methods to modify:**
- Top-level `describe('QueryDebugging')` block: new `describe('Did You Mean Suggestions')` block added inside it.

**File-level:** OK. Well-structured with clear `describe` blocks. The existing test infrastructure (`createTestDatabase`, `createTestOrchestrator`, `levenshtein` import) is already in place.

**Observation — import alignment:** The plan requires importing `findSimilarTypes` and `extractQueriedTypes` from `@grafema/mcp`. The current test file already imports `levenshtein` from `@grafema/core` (line 19). The new tests will need to import from `@grafema/mcp`:

```javascript
import { findSimilarTypes, extractQueriedTypes } from '@grafema/mcp';
```

Verify that `@grafema/mcp` exports these functions at the package level (check `packages/mcp/src/index.ts` or equivalent). If `extractQueriedTypes` is new, it must be added to the MCP package exports before the test file can import it.

**Observation — existing inline levenshtein logic in tests:** The `Empty Query Stats` describe block at line 101–117 contains inline levenshtein logic that duplicates what `findSimilarTypes` now provides. After this task, that inline logic becomes stale — it still uses `dist > 0` (the old behavior). The plan does not ask to clean this up, and it is correct not to: the old test remains a valid regression test for the levenshtein function itself, not for `findSimilarTypes`. Leave it.

**Method-level:** Not applicable (no methods, only test structure).
- **Recommendation:** SKIP (no refactor needed pre-implementation)

**Risk:** LOW
**Estimated scope:** ~60–80 lines of new tests added.

---

## Summary

| File | Size | Status | Action |
|------|------|--------|--------|
| `packages/mcp/src/utils.ts` | 205 lines | OK | No pre-refactor needed |
| `packages/mcp/src/handlers/query-handlers.ts` | 287 lines | OK | No pre-refactor needed; implementer must fix redundant `countNodesByType()` call during Step 4 |
| `packages/cli/src/commands/query.ts` | 1177 lines | CRITICAL | No split in this task — file debt is pre-existing; edit is localized |
| `test/unit/QueryDebugging.test.js` | 229 lines | OK | Verify MCP package exports before writing test imports |

**One prerequisite to verify before implementation starts:** Confirm that `packages/mcp/src/index.ts` (or equivalent barrel export) exports `findSimilarTypes` and will export `extractQueriedTypes` once it is added. If not, the implementer must add those exports to the barrel as part of Step 3.

**Execution order constraint:** Step 5 (`queryHints.ts` creation) must complete before Step 6 (`query.ts` import addition) or the TypeScript build will fail.

No STEP 2.5 refactoring is required. All four files are ready for implementation as-is.
