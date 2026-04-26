## Uncle Bob PREPARE Review: REG-556

---

### JSASTAnalyzer.ts
**File size:** 4624 lines — CRITICAL (9x over the 500-line limit)

**Methods to modify:**
- `handleCallExpression` (~lines 3385–3602)
- `extractMethodCallArguments` (~lines 3612–3697)

**File-level:** This file is a pre-existing catastrophe — a 4624-line god object. It is far outside scope to fix here. Acknowledged and set aside. The changes for REG-556 are additions of a small number of lines to these two methods; that is manageable without making the situation worse.

**Method-level:**
- `handleCallExpression`: ~217 lines — MUST SPLIT in isolation, but it is the call-dispatch switch that has been accreting for years. REG-556 touches only the `Identifier` branch (lines 3401–3435, ~34 lines) and the nested `MemberExpression` branch argument extraction calls. The actual change is a few lines. **Recommendation: SKIP refactoring** — splitting this method is a significant architectural project. Create a tech debt issue instead. The targeted insertion is low risk.
- `extractMethodCallArguments`: ~85 lines — above the 50-line candidate threshold. It is a simple `forEach` over argument types with a flat if/else chain. Readable despite its size. REG-556 may add a branch here. **Recommendation: SKIP refactoring** — the method is cohesive (single responsibility: classify arguments). Adding one branch preserves that cohesion.

**Risk:** MEDIUM — the file is large and the methods are long, but the changes are small and localised to well-defined branches. The risk is accidental scope creep or touching dedup logic incorrectly.

**Estimated scope:** ~5–15 lines added across two locations in this file.

---

### CallExpressionVisitor.ts
**File size:** 666 lines — MUST SPLIT (>500 line limit)

**Methods to modify:**
- `handleNewExpression` (~lines 566–665)

**File-level:** Over the 500-line limit. Pre-existing issue. Not introduced by REG-556.

**Method-level:**
- `handleNewExpression`: ~99 lines — split candidate (>50 lines). The method has two parallel branches: `Identifier` callee and `MemberExpression` callee. Each branch is ~35 lines and duplicates the ID-generation pattern. However, REG-556 may add argument extraction calls to this method (mirroring what the function-body handler already does). The targeted addition is ~5 lines at most. **Recommendation: SKIP refactoring** — extracting the two branches into private helpers would be a legitimate improvement but is out of REG-556 scope. Adding the argument extraction call does not increase nesting or reduce clarity.

**Risk:** LOW — method is structurally clean; the two branches are independent and clearly delimited. Insertion point is after each `callSites.push` / `methodCalls.push` call, matching the established pattern from `handleCallExpression`.

**Estimated scope:** ~4–8 lines added (one `ArgumentExtractor.extract()` call per branch, guarded by `newNode.arguments.length > 0`).

---

### NewExpressionHandler.ts
**File size:** 179 lines — OK

**Methods to modify:**
- `getHandlers()` containing the inline `NewExpression` visitor (~lines 17–178)

**File-level:** OK. Purpose-specific handler, appropriate size.

**Method-level:**
- `getHandlers()` inline `NewExpression` handler: ~160 lines — the handler closure itself is large, but it is a well-structured three-concern block: CONSTRUCTOR_CALL creation (lines 34–67), Promise executor registration (lines 69–100), and the legacy CALL/method-call emit block (lines 105–175). REG-556 may require adding argument extraction to the legacy CALL block (lines 122–133 and 160–173) to match what `NewExpressionHandler` already does for `CONSTRUCTOR_CALL` arguments at lines 57–67. The insertion is symmetric with existing code. **Recommendation: SKIP refactoring** — the three-section structure is already commented and readable. Splitting would require passing more context through the handler boundary.

**Risk:** LOW — the `ArgumentExtractor.extract()` pattern is already used in this same file at lines 61–66. The addition is a copy of that existing pattern adapted for the CALL/method-call IDs.

**Estimated scope:** ~6–10 lines added (two guarded `ArgumentExtractor.extract()` calls, one per constructor branch).

---

### ArgumentExtractor.ts
**File size:** 307 lines — OK

**Methods to modify:**
- `extract` (static, ~lines 27–259)

**File-level:** OK. Single-responsibility class.

**Method-level:**
- `extract`: ~232 lines — well above the 50-line threshold. However, this is a large flat dispatch over argument node types. It is a classification table, not deeply nested logic. Maximum nesting depth is 3 (forEach → else-if branch → inner conditional). REG-556 does NOT appear to modify this method directly; it is called by the methods above. **Recommendation: SKIP refactoring** — this method is read-only for REG-556.

**Risk:** LOW — no changes planned.

**Estimated scope:** 0 lines changed.

---

### CallFlowBuilder.ts
**File size:** 263 lines — OK

**Methods to modify:**
- `bufferArgumentEdges` (~lines 58–206)

**File-level:** OK.

**Method-level:**
- `bufferArgumentEdges`: ~148 lines — above 50-line threshold. It is a `for` loop over argument edges with type-dispatch branches. Maximum nesting depth is 3. REG-556 may require this method to handle `CONSTRUCTOR_CALL` node IDs in the same lookup pass as `callSites` and `methodCalls`. The change would be a small addition to the existing `call` lookup (line 84–85) — adding a third collection to the `||` chain, or passing `constructorCalls` as a new parameter. **Recommendation: SKIP refactoring** — the method is cohesive. Parameter count is already 6; adding a 7th is not ideal but acceptable for a targeted fix. If Kent tests the PASSES_ARGUMENT edge creation for constructor calls, locking that behavior first is sufficient.

**Risk:** LOW — change is additive. Existing logic is unaffected.

**Estimated scope:** ~3–5 lines added (extend the `call` lookup to include constructor calls, if needed).

---

## Decision Summary

**No refactoring required before implementation.**

All files have pre-existing size violations that are out of REG-556 scope. The changes are small, targeted insertions following established patterns already present in the same files.

**SKIP 2.5 refactoring — proceed to implementation.**

### What Kent must lock with tests first

Since we are adding argument extraction to `new` expression handling paths, Kent should write tests that verify:

1. `new Foo(arg1, arg2)` at module level produces `PASSES_ARGUMENT` edges from the CALL node to arg nodes — currently absent for module-level `new` (gap REG-556 is fixing).
2. `new ns.Constructor(arg)` at module level likewise produces `PASSES_ARGUMENT` edges.
3. `new Foo(arg)` inside function bodies — confirm existing behavior is not regressed (this path is already covered by `NewExpressionHandler` + `ArgumentExtractor`).
4. `new Foo()` with no arguments — confirm no argument edges are created (guard on `arguments.length > 0` must hold).

These four cases lock the current and target behavior boundary cleanly before any code changes.
