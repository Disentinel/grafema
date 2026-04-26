## Uncle Bob PREPARE Review: REG-536

### BranchHandler.ts
**File size:** 337 lines — OK
**Methods to modify:** `getHandlers()` (SwitchStatement handler inline, lines 31-40, ~10 lines)

**File-level:**
- OK. Well-structured, single responsibility per handler factory.

**Method-level:** BranchHandler.ts:getHandlers (SwitchStatement inline)
- **Recommendation:** SKIP
- Inline arrow at lines 31-40 simply delegates to `analyzer.handleSwitchStatement(...)` with 6 args. The fix will move this delegation into a handler method inside this class (matching the pattern of `createIfStatementVisitor`, etc.). No pre-cleanup needed — implementation will naturally extend existing pattern.

**Risk:** LOW
**Estimated scope:** ~10 lines (replacing delegation call + new handler method)

---

### JSASTAnalyzer.ts
**File size:** 4,277 lines — CRITICAL

**Methods to modify:** `handleSwitchStatement` (lines 2231–2378, **148 lines**)

**File-level:**
- CRITICAL size. However, splitting JSASTAnalyzer is explicitly out of scope for this task — it is a known pre-existing debt and would be a major architectural refactor. Do NOT split as part of REG-536.

**Method-level:** JSASTAnalyzer.ts:handleSwitchStatement
- **Length:** 148 lines — exceeds 50-line threshold significantly.
- **Recommendation:** SKIP pre-refactor. The method is already scheduled to be fully migrated into BranchHandler as part of REG-536's implementation. The fix involves pulling the logic out of JSASTAnalyzer entirely and moving it to BranchHandler — that migration IS the cleanup.
- The 11-variable discriminant extraction block (lines 2284–2317) duplicates the pattern from `if`/`ternary` handlers. After migration, `extractDiscriminantExpression` result should be spread directly into the branch object (as done in BranchHandler for ternary at lines 258-284), eliminating the intermediate variables.
- Parameter count: 6 parameters — above threshold. After migration into BranchHandler, parameters are replaced by `this.ctx` and `this.analyzer`, resolving this automatically.

**Risk:** LOW (migration is the implementation, not extra work)
**Estimated scope:** 148 lines migrated/replaced

---

### FunctionBodyContext.ts
**File size:** 291 lines — OK
**Methods to modify:** `createFunctionBodyContext` factory function (lines 146–291, 145 lines)

**File-level:**
- OK. The function is long but is a straightforward initialization list — no logic branching.

**Method-level:** FunctionBodyContext.ts:createFunctionBodyContext
- **Recommendation:** SKIP
- `cases` and `caseCounterRef` are currently NOT in `FunctionBodyContext` interface (lines 54–136) or extracted in `createFunctionBodyContext`. They are initialized ad-hoc inside `handleSwitchStatement` via `collections.cases` / `collections.caseCounterRef` guards (JSASTAnalyzer lines 2256–2269). If the migrated handler uses `this.ctx`, `cases` and `caseCounterRef` must be added to `FunctionBodyContext`. This is additive (2 fields) — no complexity increase.

**Risk:** LOW
**Estimated scope:** +2 fields to interface, +2 lines to factory function

---

### types.ts (CaseInfo interface)
**File size:** 1,283 lines — CRITICAL

**Methods to modify:** `CaseInfo` interface (lines 119–130, 12 lines)

**File-level:**
- CRITICAL size. Pre-existing debt, out of scope for REG-536.

**Method-level:** types.ts:CaseInfo
- **Recommendation:** SKIP
- Interface is clean and minimal (10 fields). The fix may add a `parentScopeId?: string` field to enable CONTAINS edge from the switch's parent scope to each CASE node (which is the disconnection bug). Additive, no impact on existing consumers.

**Risk:** LOW
**Estimated scope:** +1 field to interface

---

### ControlFlowBuilder.ts (bufferCaseEdges)
**File size:** 697 lines — CRITICAL (1 line over 700 threshold boundary, effectively borderline)

**Methods to modify:** `bufferCaseEdges` (lines 386–396, **11 lines**)

**File-level:**
- 697 lines — borderline. Pre-existing debt, out of scope for REG-536. Do not split.

**Method-level:** ControlFlowBuilder.ts:bufferCaseEdges
- **Recommendation:** SKIP pre-refactor
- Method is clean and minimal. The fix will add a CONTAINS edge from `caseInfo.parentScopeId` to `caseInfo.id` inside this loop — a straightforward 4-line addition matching the pattern already in `bufferBranchEdges` (lines 291–298). No complexity added.

**Risk:** LOW
**Estimated scope:** +4–5 lines

---

### Summary

| File | Size | Pre-refactor needed? |
|------|------|----------------------|
| BranchHandler.ts | 337 | No |
| JSASTAnalyzer.ts | 4,277 | No (migration IS the fix) |
| FunctionBodyContext.ts | 291 | No (additive only) |
| types.ts | 1,283 | No (additive only) |
| ControlFlowBuilder.ts | 697 | No (additive only) |

**No blocking pre-cleanup required.** The implementation itself (migrating `handleSwitchStatement` into BranchHandler) resolves the primary structural issues (6-param method, 148-line method). Proceed directly to implementation.
