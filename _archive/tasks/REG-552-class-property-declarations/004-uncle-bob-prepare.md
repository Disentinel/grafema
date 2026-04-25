## Uncle Bob PREPARE Review: REG-552 Class Property Declarations

**Date:** 2026-02-22
**Reviewer:** Robert Martin (Uncle Bob)
**Phase:** STEP 2.5 — Pre-implementation preparation review

---

## File 1: ClassVisitor.ts

**File size:** 839 lines — CRITICAL: exceeds 700-line hard limit. MUST split before implementation.

**Methods to modify:**
- `ClassProperty` handler inside `ClassDeclaration` traversal block — lines 249–335 (87 lines)
- `ClassProperty` handler inside `ClassExpression` traversal block — lines 728–782 (55 lines)

**File-level:**

- CRITICAL: 839 lines. This file has grown beyond acceptable bounds. The `getHandlers()` method alone spans lines 160–838 — 679 lines in a single method. That is an SRP violation of the highest order. However, splitting this file is a separate refactoring concern that must be handled by the team lead as a separate task, NOT as part of REG-552. Splitting a 839-line file safely requires its own planning, tests to lock current behavior, and a dedicated STEP 2.5. **Attempting to split it during REG-552 implementation would couple two unrelated risks.** My recommendation: file the split as a separate backlog item, proceed with REG-552 additions, and accept that the file will be 870+ lines after this task. This is not ideal but it is the correct sequencing.

- Pre-existing technical debt: The `ClassDeclaration` traversal block (lines 175–666) and the `ClassExpression` traversal block (lines 668–836) are near-duplicates. The comment on line 726 even says "same traversal as ClassDeclaration." This duplication is the root cause of why REG-552 requires changes in two places. Extracting a shared `processClassBody(classPath, classNode, className, currentClass, ...)` helper would eliminate this class of future bugs. However, this is again a separate refactoring task — see duplication analysis below.

**Method-level: ClassVisitor.ts — ClassDeclaration ClassProperty handler (lines 249–335)**

- **Recommendation: SKIP refactoring of this specific handler before implementation.**
- The handler is 87 lines but logically coherent: it handles decorators (lines 264–275), then function-valued properties (lines 278–334). The new `else` branch adds one more case. The resulting structure will be: decorator extraction → if function → else non-function. This is a clean conditional decomposition.
- The handler already has the decorator-for-non-function pattern (lines 264–275) which correctly runs before the function/non-function split. The new `else` branch slots in correctly after the existing `if` block at line 278.
- One asymmetry to note: the `ClassDeclaration` handler has decorator extraction for ALL properties (lines 264–275) — it runs even for non-function properties. The `ClassExpression` handler has NO decorator extraction at all. This is pre-existing inconsistency. Do not fix it during REG-552; the task scope does not include decorator handling on class expressions.

**Method-level: ClassVisitor.ts — ClassExpression ClassProperty handler (lines 728–782)**

- **Recommendation: SKIP refactoring before implementation.**
- This handler is 55 lines (shorter than ClassDeclaration's 87) because it lacks decorator handling entirely. It also lacks `legacyId` and `isStatic` tracking on FUNCTION nodes that the ClassDeclaration handler has (lines 285–303 vs 741–757). These are pre-existing omissions — do not fix them in REG-552.
- The else branch to add is structurally identical to what goes into ClassDeclaration, minus the decorator extraction. The implementation diff will be additive only.

**Key question — should we extract a shared `processClassProperty()` helper?**

**RECOMMENDATION: SKIP the extraction.**

Here is the analysis:

The two `ClassProperty` handlers differ in these ways:
1. ClassDeclaration has decorator extraction before the function check; ClassExpression does not.
2. ClassDeclaration computes `legacyId` for FUNCTION nodes; ClassExpression does not.
3. ClassDeclaration has a comment block above the function `if`; ClassExpression is more compact.

A shared helper would need to accept a boolean `hasDecorators` flag or move decorator handling outside, making the signature complex. The closures (`className`, `currentClass`, `module`, `collections`, `scopeTracker`, `functions`, `scopes`, `parameters`, `decorators`, `analyzeFunctionBody`) are all captured from the outer `getHandlers()` closure — passing them as parameters would produce a 10+ argument function. That is worse than the duplication.

The correct fix is extracting `processClassBody(classPath, classNode, className, currentClass)` — unifying the entire traversal block, not just the `ClassProperty` handler. That is a much larger refactoring that belongs in a separate task. Doing a half-extraction (just `processClassProperty`) creates a false sense of deduplication while leaving the outer duplication intact.

**Risk:** MEDIUM
- The 839-line file size is concerning but the targeted change is isolated.
- The two locations to modify (ClassDeclaration line 278, ClassExpression line 738) are identifiable without ambiguity.
- The `typeNodeToString` import must be added to line 30 (currently only `extractTypeParameters` is imported from `TypeScriptVisitor.js`).

**Estimated scope:** ~25 lines added to ClassDeclaration handler, ~20 lines to ClassExpression handler, 1 import line updated. Total: ~46 lines added to ClassVisitor.ts.

---

## File 2: types.ts

**File size:** 1289 lines — CRITICAL: exceeds 700-line hard limit.

**Methods to modify:**
- `VariableDeclarationInfo` interface — lines 247–262 (16 lines)

**File-level:**

- CRITICAL: 1289 lines. This is a types barrel file — all AST analysis types in one place. At this size it is no longer navigable. However, the same sequencing rule applies: splitting a 1289-line type file safely requires its own planning. It must NOT be done during REG-552. Flag for a dedicated refactoring task.
- The file follows a consistent pattern: each interface block is preceded by a `// === TYPE NAME ===` comment section marker. This makes navigation tolerable despite the size.

**Method-level: types.ts — VariableDeclarationInfo interface (lines 247–262)**

- **Recommendation: SKIP refactoring, proceed with additive field additions only.**
- The interface is 16 lines with a clear REG-271 comment block for the existing `isPrivate`, `isStatic`, `isClassProperty` fields. Adding `modifier` and `tsType` is additive and consistent with the existing pattern.
- The current interface has no `metadata` field. The plan correctly calls for adding `modifier?: 'private' | 'public' | 'protected' | 'readonly'` and `tsType?: string` as direct interface fields, with translation to `metadata` happening in GraphBuilder. This is consistent with how `controlFlow: ControlFlowMetadata` lives directly on `FunctionInfo` (line 33) and gets translated during node buffering.
- One concern: `modifier` values `'private'` and `'protected'` overlap with the existing `isPrivate?: boolean` field. The `isPrivate` field was added by REG-271 for JS `#private` syntax fields — it is semantically different from TypeScript `private` modifier. The distinction must be preserved: `isPrivate: true` = JS private `#field`, `modifier: 'private'` = TypeScript `private` keyword. This is unambiguous given the field names and the comment that will accompany `modifier`.

**Risk:** LOW
- The interface change is purely additive.
- No existing consumers of `VariableDeclarationInfo` will break — all new fields are optional.

**Estimated scope:** 3 lines added to `VariableDeclarationInfo` (comment + `modifier?` + `tsType?`).

---

## File 3: GraphBuilder.ts

**File size:** 621 lines — MUST SPLIT range (>500). Warrants attention but does not block this task.

**Methods to modify:**
- Variable buffering loop — lines 275–278 (4 lines)

**File-level:**

- 621 lines. Over the 500-line threshold. However, the file is already architecturally decomposed into domain builders (`CoreBuilder`, `ControlFlowBuilder`, etc.) invoked at lines 326–335. The main `build()` method (lines 177–365) is the remaining monolithic section. It is long (189 lines) but each sub-section is clearly delimited with numbered comments (steps 1 through 4.5). This structure is manageable. No split required before this task.
- The existing pattern at lines 207–226 (FUNCTION node metadata translation for `invokesParamIndexes`) is the exact precedent that REG-552 must follow for variable declarations. The pattern is well-established and the implementation is mechanical.

**Method-level: GraphBuilder.ts — variable buffering loop (lines 275–278)**

- **Recommendation: SKIP refactoring, extend with the established metadata pattern.**
- The loop is currently 4 lines. The REG-552 change expands it to ~12 lines following the exact REG-401 pattern from lines 207–226 (destructure → check → assign metadata → buffer).
- The current code passes `varDecl as unknown as GraphNode` directly. This means every field on `VariableDeclarationInfo` becomes a top-level node field. The existing fields (`id`, `type`, `name`, `file`, `line`, `column`, `parentScopeId`, `isPrivate`, `isStatic`, `isClassProperty`, `semanticId`) are all valid top-level node fields by design. The new `modifier` and `tsType` must NOT go to the top level — they belong in `metadata` — hence the need to destructure them out before passing to `_bufferNode`.
- The implementation is a direct translation of the FUNCTION pattern. No architectural innovation required.

**Risk:** LOW
- The change is a mechanical application of an established pattern.
- No behavioral change to existing variables — only variables that carry the new `modifier`/`tsType` fields (class property declarations added by REG-552) will have their metadata populated. Existing `variableDeclarations` entries do not have these fields so the destructuring produces `undefined` and the metadata block is skipped.

**Estimated scope:** ~8 lines net addition to the loop (destructure line + conditional + metadata assignments).

---

## Summary Table

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `ClassVisitor.ts` | 839 | CRITICAL (>700) | Proceed with additions; file-split is separate backlog item |
| `types.ts` | 1289 | CRITICAL (>700) | Proceed with additions; file-split is separate backlog item |
| `GraphBuilder.ts` | 621 | MUST SPLIT range (>500) | Proceed; file is architecturally manageable |

**Overall pre-implementation verdict:**

No blocking refactoring is required before implementation. The three files all exceed size thresholds, but splitting them safely is out of scope for REG-552 and would introduce unacceptable coupling of risks. The correct action is:

1. File a separate backlog task for splitting `ClassVisitor.ts` (839 lines, single `getHandlers()` method, full traversal duplication).
2. File a separate backlog task for splitting `types.ts` (1289 lines, types barrel).
3. Proceed with REG-552 implementation as planned: additive changes only, following established patterns, in isolated locations.

**Total implementation scope:** ~57 lines across three files. Low risk. Ready for Rob.
