## Uncle Bob PREPARE Review: REG-552

**File size:**
- `ClassVisitor.ts`: 839 lines — CRITICAL (>700)
- `types.ts`: 1293 lines — CRITICAL (>700)

**Methods to modify:**
- `ClassDeclaration > ClassProperty` handler: lines 249–334 (~86 lines, nesting depth 3)
- `ClassExpression > ClassProperty` handler: lines 728–781 (~54 lines, nesting depth 3)

---

**File-level: ClassVisitor.ts**

- CRITICAL: 839 lines. Exceeds the 700-line hard stop. However, this file is a single cohesive visitor class with a clear, unified responsibility — AST traversal for class constructs. It does not do 3+ unrelated things: every handler is a facet of the same concern (class member extraction). The "bigness" comes from symmetric duplication between ClassDeclaration and ClassExpression handlers, not from mixed concerns.
- The real structural issue is that `ClassDeclaration` and `ClassExpression` share near-identical inner traversal logic (ClassProperty, ClassMethod, StaticBlock, ClassPrivateProperty, ClassPrivateMethod) but it is written out twice. This is a DRY violation, not a split-of-concerns violation.
- Recommendation: the correct fix is to extract the shared inner traversal into a private `traverseClassBody(classPath, classNode, className, currentClass)` helper. That would reduce the file to ~500 lines and eliminate the duplication. This is pre-existing debt, not introduced by REG-552.
- This refactor is NOT in scope for REG-552 (it is STEP 2.5 work). Do not do it now. The implementation team must be aware the file is already at critical size and must not grow further without addressing it.

**File-level: types.ts**

- CRITICAL: 1293 lines. Well past the 700-line threshold. This file is a pure type registry — every export is an interface or type alias, no logic whatsoever. It is doing one thing (holding domain type definitions), but it has grown into a monolith by accumulation.
- The types relevant to REG-552 (`VariableDeclarationInfo`, `ClassDeclarationInfo`, `ASTCollections`) are already defined here with appropriate fields (`isClassProperty`, `properties[]`). No new types need to be added to this file for the REG-552 change.
- The file-size issue is pre-existing debt. A proper split (e.g., by domain cluster: class types, control-flow types, mutation types, call types, etc.) would be the right cure. Out of scope for REG-552.

---

**Method-level: ClassVisitor.ts:ClassDeclaration > ClassProperty (lines 249–334)**

Current structure:
- Lines 249–275: Guard + name extraction + decorator extraction (always runs)
- Lines 278–334: `if (propNode.value && isFunctionType)` branch — function-valued property handling
- Missing: `else` branch for non-function properties (this is what REG-552 adds)

Analysis:
- Method length: ~86 lines. Long but not gratuitously so — each block is clearly purposeful.
- Nesting depth: 3 (handler closure → ClassProperty callback → if/for/if). Acceptable.
- Parameter count: 0 explicit (captures from closure). OK.
- The decorator extraction block (lines 265–275) runs unconditionally for ALL properties, even non-function ones. The comment on line 267 already anticipates a future `else` path: `"for regular properties, create a target ID"`. This is the exact path REG-552 will complete.
- The `else` branch will mirror the structure already implemented for `ClassPrivateProperty` non-function path (lines 544–578): compute VARIABLE id, push to `currentClass.properties`, push to `variableDeclarations`, handle decorators.

**Recommendation: SKIP refactor.** The method is long but coherent. The addition of an `else` branch adds ~20–25 lines and does not change nesting depth. The decorator code on line 267–274 already creates a `propertyTargetId` string that is currently unused by the `else` path — the implementation must reuse this ID (not create a second one) for decorator targeting.

---

**Method-level: ClassVisitor.ts:ClassExpression > ClassProperty (lines 728–781)**

Current structure:
- Lines 728–730: Guard + name extraction
- Lines 735–736: Location extraction
- Lines 738–780: `if (propNode.value && isFunctionType)` — function-valued property handling
- Missing: `else` branch (REG-552 adds this)

Analysis:
- Method length: ~54 lines. Shorter than its ClassDeclaration counterpart.
- Nesting depth: 3 (same as above). Acceptable.
- Notable gap: this handler has NO decorator extraction before the function-value check. The ClassDeclaration handler extracts decorators unconditionally (lines 265–275); the ClassExpression handler does not. REG-552 must either add decorator extraction here (to match ClassDeclaration behavior) or explicitly skip it for ClassExpression. This asymmetry is pre-existing debt that REG-552 may expose if the test fixture uses a decorated non-function class property inside a class expression.

**Recommendation: SKIP refactor.** The method is short enough. The `else` branch adds ~15–20 lines. However, the implementation team must be aware of the decorator asymmetry and make an explicit decision: match ClassDeclaration behavior (add decorator pass) or document the omission.

---

**Duplication note (affects both methods)**

The `else` branch being added by REG-552 will be written twice — once in ClassDeclaration's ClassProperty handler, once in ClassExpression's. This mirrors the pre-existing pattern for every other member type in this file. It is not a new problem introduced by REG-552, but it is compounded by it. The proper solution (shared `traverseClassBody` helper) is STEP 2.5 material, not REG-552 material.

---

**Risk:** MEDIUM

The file-level risk is contained — types.ts needs no changes, and ClassVisitor.ts changes are localized to two parallel `else` branches. The medium rating comes from:
1. The decorator handling asymmetry between ClassDeclaration and ClassExpression handlers (risk of silent omission)
2. The `propertyTargetId` already computed in the ClassDeclaration path (lines 268–269) must be reused in the `else` branch — if the implementer creates a second ID with a different format, decorator edges will be inconsistent
3. The `currentClass.properties` array must be initialized with a null-guard (`if (!currentClass.properties) currentClass.properties = []`) matching the pattern established at lines 549–551 — missing this causes a runtime crash

**Estimated scope:** 40–50 lines added total (20–25 per ClassProperty handler). No changes to types.ts.
