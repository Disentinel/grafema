## Uncle Bob PREPARE Review: REG-547

### File: NewExpressionHandler.ts
**File size:** 176 lines — OK
**Methods to modify:** `getHandlers()` — 155 lines (lines 17–174), contains the `NewExpression` handler closure
**File-level:** Single responsibility — handles NewExpression nodes only. Clean.
**Method-level:**
- `getHandlers()` is 155 lines. That is above the 50-line threshold, but the body is dominated by a single large inline handler closure. The closure itself does two distinct things: (1) creates a CONSTRUCTOR_CALL node (lines 22–103), and (2) pushes a CALL/isNew entry to callSites or methodCalls (lines 105–171). After the planned deletion of lines 105–171, the method drops to approximately 86 lines. The remaining body is a single coherent responsibility: build the CONSTRUCTOR_CALL node and its argument/Promise edges. That is acceptable.
- No parameter count concerns. `ctx` is captured from closure, not passed.
- Nesting depth in the Promise executor block reaches level 4 (`if className / if arguments / if Promise / if ArrowFunction / if params`). This is pre-existing and outside the change scope; it does not worsen after deletion.
- No duplication introduced by the change.
- Naming is clear and intentional.
- **Recommendation:** SKIP — deletion only, no refactoring needed before implementation.
**Risk:** LOW

---

### File: CallExpressionVisitor.ts
**File size:** 568 lines — OK (under 700, under 500 ideal threshold)
**Methods to modify:** `handleNewExpression()` (lines 472–567) — 95 lines. This entire method is to be removed. `getHandlers()` registration of `NewExpression` (line 202) is also to be removed.
**File-level:** The class handles direct calls, method calls, event listeners, and new-expressions at module level. After removing `handleNewExpression`, it handles three things (direct, member, event) — a tighter single responsibility. Good direction.
**Method-level:**
- `handleNewExpression()` is 95 lines — well above the 50-line rule. Removing it entirely is the right move. No need to refactor before deletion.
- `handleSimpleMethodCall()` is 117 lines (lines 277–394). This is the largest remaining method and a pre-existing concern. It is outside the current change scope. Flag for future tech debt.
- `handleDirectCall()` (lines 207–253) and `handleNestedMethodCall()` (lines 397–469) are 46 and 72 lines respectively. The latter is slightly above threshold but acceptable.
- ID generation pattern (`sharedIdGenerator ? generateV2 : idGenerator.generate`) is repeated verbatim in `handleDirectCall`, `handleSimpleMethodCall`, and `handleNestedMethodCall`. That is three occurrences of the same 10-line block — this meets the "extract helper" threshold. This is a pre-existing issue, outside scope of REG-547, but worth noting for future cleanup.
- **Recommendation:** SKIP — deletion only, no refactoring needed before this implementation.
**Risk:** LOW

---

### File: call-expression-types.ts
**File size:** 180 lines — OK
**Methods to modify:** Two interfaces — `CallSiteInfo` (lines 103–115) and `MethodCallInfo` (lines 120–137). Remove `isNew?: boolean` from each.
**File-level:** Pure type definitions file extracted from CallExpressionVisitor (REG-424). Single responsibility: type declarations for call-related visitor data. Clean.
**Method-level:** N/A (interfaces, no methods).
- `CallSiteInfo.isNew` (line 112) — one removal.
- `MethodCallInfo.isNew` (line 132) — one removal.
- Both interfaces are small and well-structured. After deletion, the files remain valid.
- No naming, nesting, or duplication concerns.
- **Recommendation:** SKIP — trivial field removals.
**Risk:** LOW

---

### File: types.ts
**File size:** 1284 lines — CRITICAL by raw count, but this is a pure type-declaration file. It is a catalog of interfaces and types for the entire analysis pipeline. By the Single Responsibility criterion this file has one role: define the shared type contract for `ASTCollections` and all its members. There is no logic. The standard line-count rule does not trigger a mandatory split for pure type-declaration files unless there is an actual SRP violation, but this file is approaching the point where it warrants an organizational split (e.g., by domain: control-flow types, call types, data-flow types, etc.). This is a pre-existing concern; do not block REG-547 for it. Create a tech debt issue.
**Methods to modify:** Two interfaces — `CallSiteInfo` (lines 292–311) and `MethodCallInfo` (lines 314–339). Remove `isNew?: boolean` from each.
**File-level:** Pre-existing debt: 1284 lines. Flag for future split. Does not block this change.
**Method-level:** N/A (interfaces).
- `CallSiteInfo.isNew` (line 302) — one removal.
- `MethodCallInfo.isNew` (line 328) — one removal.
- Both interfaces are well-structured. Surrounding fields are clearly commented.
- **Recommendation:** SKIP — trivial field removals. Tech debt issue recommended for file split (separate task).
**Risk:** LOW

---

### Overall Recommendation

**Proceed with implementation.** All four files are safe to modify as described. The planned changes are pure deletions of dead code — no structural risk, no new debt introduced.

**Pre-existing concerns to track as separate tech debt (do NOT address in REG-547):**

1. `types.ts` at 1284 lines should be split into domain-grouped type modules (call types, control-flow types, data-flow types, etc.). Consider a dedicated tech debt issue.
2. `handleSimpleMethodCall()` in `CallExpressionVisitor.ts` is 117 lines — candidate for decomposition in a future refactor task.
3. The ID-generation block (`sharedIdGenerator ? generateV2 : generate`) is duplicated 3+ times in `CallExpressionVisitor.ts` — extract to a private helper when refactoring that file.

None of these block the current task.
