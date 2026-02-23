## Uncle Bob PREPARE Review: REG-570

---

## Uncle Bob PREPARE Review: ClassVisitor.ts

**File size:** 886 lines — MUST SPLIT (exceeds 500-line hard limit)

**Methods to modify:**
- `indexClassFieldDeclaration` — lines 164–201 (38 lines)
- `ClassPrivateProperty` handler (ClassDeclaration traverse) — lines 518–625 (108 lines)
- `ClassExpression` handler's `classPath.traverse()` — lines 772–879 (108 lines, needs new ClassPrivateProperty block added ~80 LOC)

**File-level:**

The file is 886 lines and contains `ClassDeclaration` and `ClassExpression` handlers that each embed a full inline traversal with their own `ClassProperty`, `ClassMethod`, `ClassPrivateProperty`, `ClassPrivateMethod`, and `StaticBlock` sub-handlers. This yields two structurally parallel traversal objects (~290 lines each) living inside a single `getHandlers()` method that spans lines 203–885.

That said: splitting this file NOW is out of scope for REG-570. The 886-line count is pre-existing. The plan adds ~80 LOC net, bringing it to ~966 lines — worse, but the root cause is the existing duplication between `ClassDeclaration` and `ClassExpression` traversals. Splitting requires its own STEP 2.5 task (a dedicated REG). Do NOT split as part of this change.

**Specific observation:** The `ClassExpression` traversal (lines 772–879) is a stripped-down copy of the `ClassDeclaration` traversal (lines 291–707). The copy already lacks: decorator handling for `ClassProperty`, `legacyId` on function-property FUNCTION nodes, `ClassPrivateProperty` handler, `ClassPrivateMethod` handler, `StaticBlock` handler, and type-parameter extraction. REG-570 must add `ClassPrivateProperty` support to `ClassExpression` — this increases the divergence surface, not reduces it. This is acceptable for now but must be logged as technical debt.

**Recommendation:** SKIP file-level split for this PR. Flag for dedicated refactor task.

---

## Uncle Bob PREPARE Review: ClassVisitor.ts — indexClassFieldDeclaration (lines 164–201)

**File size:** 886 lines — MUST SPLIT (pre-existing; out of scope)
**Methods to modify:** `indexClassFieldDeclaration` — 38 lines

**Method-level:** ClassVisitor.ts:indexClassFieldDeclaration

The method is clean and well-scoped: guard clause at top, single responsibility (push one VARIABLE record), 38 lines. Adding the `trackVariableAssignment` call after the push is a natural, localized change. No restructuring required.

One concern: the 7-parameter signature is already wide. Adding the `trackVariableAssignment` callback as a constructor field (rather than a parameter to this method) keeps the call site clean. Don's plan correctly puts it on the instance — that is right.

**Recommendation:** SKIP — method is clean as-is. Add the post-push block as planned.

**Risk:** LOW
**Estimated scope:** +14 LOC in method body; +1 import, +1 field, +1 constructor param at class level

---

## Uncle Bob PREPARE Review: ClassVisitor.ts — ClassPrivateProperty handler in ClassDeclaration traverse (lines 518–625)

**File size:** 886 lines — MUST SPLIT (pre-existing; out of scope)
**Methods to modify:** `ClassPrivateProperty` inline handler — 108 lines (lines 518–625)

**Method-level:** ClassVisitor.ts:ClassDeclaration>ClassPrivateProperty

At 108 lines this handler is long for an inline closure, but it does two distinctly different things branched by the function-or-field check: (a) create a FUNCTION node and analyze its body, (b) create a VARIABLE node. The existing structure is `if (func) { ... } else { ... }` — both branches are cohesive within their scope. Extracting them is reasonable but not required for this change.

The planned addition (14 LOC `trackVariableAssignment` call in the `else` branch) fits cleanly in the existing pattern. No restructuring required before implementation.

**Recommendation:** SKIP — adding 14 LOC to the `else` branch is clean and localized.

**Risk:** LOW
**Estimated scope:** +14 LOC in else branch

---

## Uncle Bob PREPARE Review: ClassVisitor.ts — ClassExpression handler's classPath.traverse() (lines 772–879)

**File size:** 886 lines — MUST SPLIT (pre-existing; out of scope)
**Methods to modify:** `ClassExpression > classPath.traverse()` — 108 lines (lines 772–879), plus new `ClassPrivateProperty` block (~80 LOC)

**Method-level:** ClassVisitor.ts:ClassExpression>classPath.traverse

This is the most significant structural concern in the plan. Adding an 80-LOC `ClassPrivateProperty` handler to the `ClassExpression` traverse deepens the existing duplication problem: the same handler logic already exists verbatim in `ClassDeclaration` (lines 518–625). After this change, the duplicated handler will appear in two places with no shared abstraction.

However, the plan is correct that this gap MUST be filled — private fields in class expressions would not receive `ASSIGNED_FROM` edges without it. The duplication is pre-existing architectural debt, not introduced by REG-570.

**Recommendation:** SKIP refactor of the ClassExpression handler structure for this PR. Add the `ClassPrivateProperty` handler as specified in the plan. The duplication must be addressed in a follow-up refactor task.

**Action required:** After writing the new handler, verify it is a faithful copy of the `ClassDeclaration` version (lines 518–625) including: direct-child guard, `#`-prefixed display name, function vs field branch, `trackVariableAssignment` call in the field branch, and decorator extraction.

**Risk:** MEDIUM — Adding ~80 LOC of duplicated logic increases the maintenance surface. Any future change to `ClassPrivateProperty` handling will require updating two places. Risk to correctness for this change is LOW given clear model to follow.
**Estimated scope:** +80 LOC new handler in ClassExpression traverse

---

## Uncle Bob PREPARE Review: DataFlowValidator.ts

**File size:** 226 lines — OK

**Methods to modify:**
- `leafTypes` set initializer — lines 67–78 (12 lines)
- No-assignment guard — lines 96–110 (15 lines)

**File-level:**
- Clean single-responsibility file. No structural issues.

**Method-level:** DataFlowValidator.ts:execute

**leafTypes addition (Change 3a):** Adding `ARRAY_LITERAL` and `OBJECT_LITERAL` is correct and trivial. These are valid terminal nodes for data flow chains. No concern.

**isClassProperty skip guard (Change 3b):** The `(variable as Record<string, unknown>).isClassProperty` cast is workable but slightly opaque. The issue is that `NodeRecord` from `@grafema/types` does not expose `isClassProperty`. This cast is the right pragmatic approach — adding `isClassProperty` to `NodeRecord` would be a larger type-system change outside scope. The cast must have a comment explaining why it is not in the type. Don's plan includes a comment; Rob must preserve it verbatim.

**Recommendation:** SKIP — no structural work needed. Apply both changes as planned.

**Risk:** LOW
**Estimated scope:** +2 LOC (leafTypes), +5 LOC (skip guard)

---

## Uncle Bob PREPARE Review: JSASTAnalyzer.ts

**File size:** 4685 lines — CRITICAL (pre-existing, architectural, out of scope for REG-570)

**Methods to modify:** `ClassVisitor` instantiation — lines 1969–1974 (6 lines)

**Method-level:** JSASTAnalyzer.ts:analyzeModule (ClassVisitor instantiation site)

The 1-line change (add 5th argument) is mechanical. The pattern already exists at the `VariableVisitor` instantiation nearby. No structural concern for this specific change.

**Recommendation:** SKIP — strictly mechanical, one additional argument following existing pattern.

**Risk:** LOW
**Estimated scope:** +2 LOC

---

## Summary

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `ClassVisitor.ts` | 886 | MUST SPLIT (pre-existing) | SKIP split; implement as planned; flag tech debt |
| `DataFlowValidator.ts` | 226 | OK | Implement as planned |
| `JSASTAnalyzer.ts` | 4685 | CRITICAL (pre-existing) | SKIP; 1-line mechanical change only |

**No blocking refactoring required before implementation.**

**One follow-up task to log:** Extract the shared `ClassProperty`, `ClassMethod`, `ClassPrivateProperty`, `ClassPrivateMethod`, and `StaticBlock` sub-handlers out of the two inline `classPath.traverse()` calls into a shared `buildClassBodyTraversalHandlers()` helper method. This will reduce `ClassVisitor.ts` from ~960 post-REG-570 lines to approximately 500 lines and eliminate all handler duplication. This is a STEP 2.5 task for a future REG, not this one.

**Overall risk for REG-570 implementation:** LOW. All changes are additive, follow established patterns, and are localized to well-understood branches.
