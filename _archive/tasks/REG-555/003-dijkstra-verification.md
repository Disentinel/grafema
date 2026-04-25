## Dijkstra Plan Verification — REG-555

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-22

**Verdict:** APPROVE with conditions (3 gaps require implementer attention, none are blockers to starting work, but two are correctness risks that must be resolved before merging)

---

## Completeness Tables

### Table 1: `objectName` Decision Tree in CoreBuilder

The plan classifies all possible `objectName` values and routes them through one of four paths: CLASS lookup, skip (import.meta), skip (chained), or variable/parameter resolution.

I enumerate ALL possible values that `objectName` can take, based on `PropertyAccessVisitor.extractChain()` (lines 342–355):

```
baseName sources:
  - Identifier → baseName = identifier.name (any JS identifier string)
  - ThisExpression → baseName = 'this'
  - MetaProperty → baseName = 'import.meta' (from extractMetaProperty: 'new')
  - Other → extractChain returns [] (no PropertyAccessInfo created)
```

After `chainPrefix` construction, `objectName` for each link is the accumulated prefix:
- PA1 of `a.b.c`: objectName = "a" (from Identifier)
- PA2 of `a.b.c`: objectName = "a.b" (contains a dot)

| objectName value | Expected behavior | Handled by plan? |
|---|---|---|
| `'this'` | Lookup CLASS node via enclosingClassName | YES — explicit branch |
| `'import.meta'` | Skip (no node to link to) | YES — explicit early return |
| `'new'` (from `new.target`) | resolveVariableInScope returns null, skip gracefully | YES — edge case 8 documents this |
| Identifier string (e.g., `'options'`, `'config'`) | resolveVariableInScope then resolveParameterInScope | YES — else branch |
| String containing `.` (e.g., `'a.b'`, `'import.meta'`) | Skip (chained object) | YES for dot-containing strings generally; BUT see Gap 1 |
| `'super'` | See below | **PARTIALLY HANDLED — see Gap 1** |
| `'globalThis'`, `'window'`, `'document'` | resolveVariableInScope returns null, skip gracefully | YES — falls into else branch, resolves to nothing, skips gracefully |
| Numeric or other non-identifier | Cannot occur — extractChain only produces Identifier.name, 'this', 'import.meta', 'new' | VERIFIED SAFE |

**Gap 1: `super` keyword**

In Babel's AST, `super.method()` produces a `MemberExpression` where `.object` is a `Super` node (type `'Super'`). The `extractChain` function checks for `Identifier`, `ThisExpression`, and `MetaProperty` at lines 345–354. `Super` matches none of these — it falls to the `else` branch which returns `[]`. Therefore **no PROPERTY_ACCESS node is ever created for `super.prop`** patterns.

Consequence for the plan: The decision tree in CoreBuilder will never receive `objectName = 'super'` because the Visitor already excludes it. The plan's omission of `super` from the decision tree is technically safe, but the **edge case section is incomplete**: it does not document this exclusion, and a future maintainer might not realize why `super.prop` produces no PROPERTY_ACCESS. This is a documentation gap in the plan, not a correctness bug.

The plan should add Edge Case #10: "`super.prop` — Babel AST type `Super` is not Identifier/ThisExpression/MetaProperty, so `extractChain()` returns `[]`. No PROPERTY_ACCESS is created. No action needed in CoreBuilder."

---

### Table 2: `scopePath` population — all callers of `extractPropertyAccesses`

The plan assumes `scopePath` is captured as `scopeTracker?.getContext().scopePath ?? []`. I verify all call sites:

| Call site | File | Passes scopeTracker? | scopeTracker available? |
|---|---|---|---|
| `getHandlers()` module-level handler | `PropertyAccessVisitor.ts` line 71 | YES — `this.scopeTracker` | May be undefined (plan acknowledges Risk 2) |
| `MemberExpression` handler | `PropertyAccessHandler.ts` line 61 | YES — `ctx.scopeTracker` | Available in function body context |
| `OptionalMemberExpression` handler | `PropertyAccessHandler.ts` line 81 | YES — `ctx.scopeTracker` | Available in function body context |

**Verdict:** All three callers of `extractPropertyAccesses` pass `scopeTracker`. The `extractMetaProperty` path also receives `scopeTracker` (lines 101–108 in `PropertyAccessHandler.ts`). No missing callers.

---

### Table 3: `getEnclosingScope` availability on ScopeTracker

This was flagged as Risk 1 in the plan.

**Finding:** `getEnclosingScope(scopeType: string): string | undefined` is a **public method** declared at `ScopeTracker.ts` lines 128–136. It is not private, not protected, not using `as any`. The plan's use of `(scopeTracker as any)?.getEnclosingScope?.('CLASS')` is unnecessarily defensive. The correct call is:

```ts
scopeTracker?.getEnclosingScope('CLASS')
```

The `as any` cast in the plan's Phase 2 code snippet is wrong. The method is public and directly accessible. The implementer must NOT use `as any` — it masks TypeScript errors and is a forbidden pattern in this codebase's standards. This is a **correctness issue in the plan's code snippet** (not the algorithm, but the suggested implementation).

---

### Table 4: `classDeclarations` in CoreBuilder.buffer()

The plan says we need to add `classDeclarations = []` to the destructuring in `CoreBuilder.buffer()` (line 29–43 in `CoreBuilder.ts`).

**Verification:** Current `CoreBuilder.buffer()` destructures from `data`:
```ts
functions, scopes, variableDeclarations, callSites, methodCalls, methodCallbacks,
propertyAccesses, literals, objectLiterals, arrayLiterals, parameters
```

`classDeclarations` is NOT currently destructured. The plan correctly identifies this (Risk 3). The field `classDeclarations?: ClassDeclarationInfo[]` exists in `ASTCollections` (types.ts line 1172), so the destructuring `classDeclarations = []` is valid.

| Precondition | Verified? |
|---|---|
| `classDeclarations` is present in `ASTCollections` | YES — types.ts line 1172 |
| `ClassDeclarationInfo` type is imported in CoreBuilder | NO — currently not imported. Implementer must add this import |
| `classDeclarations` is populated before CoreBuilder runs | YES — ClassVisitor runs during analysis, before builders |

**Gap 2: `ClassDeclarationInfo` import missing in `CoreBuilder.ts`**

`CoreBuilder.ts` currently imports `ParameterInfo` and other types but NOT `ClassDeclarationInfo`. The implementer must add this to the import block (line 8–24 of `CoreBuilder.ts`).

---

### Table 5: File comparison for CLASS node lookup — basename vs full path

This is the most critical gap I found.

The plan says: follow the MutationBuilder precedent for `this.prop` → CLASS lookup:
```ts
const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === fileBasename);
```

**Verification of `ClassDeclarationInfo.file` value:**

`ClassNode.createWithContext()` sets `file: context.file` (ClassNode.ts line 104). The `context` comes from `scopeTracker.getContext()`. `ScopeTracker` is initialized with `file: string` in its constructor (ScopeTracker.ts line 44).

In `ClassVisitor.ts` (lines 190–195), `ClassNode.createWithContext(className, scopeTracker.getContext(), ...)` is called. The `scopeTracker.file` is whatever was passed when ScopeTracker was constructed.

**Key question:** Is `scopeTracker.file` the basename or the full path?

MutationBuilder uses `basename(file)` to compare against `classDecl.file` because it knows CLASS nodes store the basename. This is an existing architectural asymmetry, explicitly commented at MutationBuilder.ts lines 198–200:
```ts
// Compare using basename since classes use scopeTracker.file (basename)
// but mutations use module.file (full path)
```

The plan says "follow the MutationBuilder precedent" for the CLASS lookup — but the plan's pseudocode (lines 91–92 of the plan) just says "lookup CLASS node using enclosingClassName (same pattern as MutationBuilder)" without explicitly mentioning the `basename` requirement.

**Gap 3: The plan's pseudocode does not explicitly include the `basename` transformation for CLASS lookup**

The plan describes the algorithm at a high level and says "same pattern as MutationBuilder," which implies basename should be used. However, the Phase 3 code block does not show this explicitly. If an implementer follows only the pseudocode, they may write:
```ts
const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === propAccess.file);
```
This would silently fail for all `this.prop` accesses because `propAccess.file` is the full path while `classDecl.file` is the basename.

The implementer MUST use `basename(propAccess.file)` when comparing `classDecl.file`, exactly as MutationBuilder does. The plan's Risk 3 section should have surfaced this but does not.

---

### Table 6: `scopePath = []` when scopeTracker is undefined — is this correct?

**Question:** When `scopeTracker` is undefined, the plan defaults `scopePath` to `[]` (empty array). Is this correct for `resolveVariableInScope`?

**Analysis of `resolveVariableInScope` (GraphBuilder.ts lines 422–461):**

The function iterates `for (let i = scopePath.length; i >= 0; i--)`. When `scopePath = []`, this loop runs once with `i = 0`, producing `searchScopePath = []`. This matches module-level variables (where `v.scopePath.length === 0` or `parsed.scopePath[0] === 'global'`).

This is correct: module-level property accesses (where scopeTracker is undefined because there's no function context) would access module-level variables, and `resolveVariableInScope` with `[]` correctly looks up module-level variables.

**Verdict:** The default of `[]` for undefined scopeTracker is semantically correct.

---

### Table 7: Test plan coverage of acceptance criteria

| Acceptance criterion | Test case in plan | Covered? |
|---|---|---|
| `options.graph` → READS_FROM → PARAMETER "options" | Test case 2 | YES |
| Variable access: `const x = obj.prop` → READS_FROM → VARIABLE "obj" | Test case 1 | YES |
| `this.val` inside class method → READS_FROM → CLASS "C" | Test case 3 | YES |
| Chained `a.b.c` — PA1 links to "a", PA2 skips | Test case 4 | YES |
| Unknown identifier → no crash, no edge | Test case 5 | YES |
| Module-level property access (scopeTracker=undefined) | NOT TESTED | **MISSING** |
| `import.meta.prop` skip | NOT TESTED | MISSING (minor — behavior is the same as unknown identifier path at visitor level; no PROPERTY_ACCESS node is even created for the inner access) |
| `new.target` graceful skip | NOT TESTED | MISSING (minor) |

The missing module-level test is the most significant: the plan acknowledges in Risk 2 that `scopeTracker` may be undefined at module level, and the default of `[]` is claimed to be correct. But there is no test that exercises a module-level property access going through the READS_FROM edge path. If the `[]` default is wrong, no test would catch it.

---

## Gaps Found

**Gap 1 (Documentation, Low severity):** The edge case section does not document that `super.prop` produces no PROPERTY_ACCESS node because Babel's `Super` AST type falls through `extractChain()`. Not a correctness bug — the CoreBuilder decision tree never receives `objectName = 'super'`. But it should be documented as Edge Case #10.

**Gap 2 (Implementation, Medium severity):** `ClassDeclarationInfo` is not currently imported in `CoreBuilder.ts`. The implementer must add it to the import statement. The TypeScript compiler will catch this, but the plan should have listed it in the "Files to Modify" table.

**Gap 3 (Correctness, HIGH severity):** The plan's Phase 3 pseudocode for the `this.prop → CLASS` lookup does not explicitly mention the `basename()` transformation. `ClassDeclarationInfo.file` stores the basename (confirmed from `ClassNode.createWithContext` + MutationBuilder comment). `PropertyAccessInfo.file` stores the full path. The implementer must apply `basename(propAccess.file)` when searching `classDeclarations`. If omitted, all `this.prop` READS_FROM edges will silently fail to be created, with no error.

---

## Precondition Issues

**Precondition 1: `(scopeTracker as any)?.getEnclosingScope?.('CLASS')` is unnecessary and incorrect**

`getEnclosingScope` is a documented public method on `ScopeTracker` (line 128). The `as any` cast bypasses TypeScript's type system, which contradicts the codebase's standards and would prevent compile-time detection of signature changes. The implementer should use `scopeTracker?.getEnclosingScope('CLASS')` directly.

**Precondition 2: The plan assumes PropertyAccessVisitor is the only source of PROPERTY_ACCESS nodes**

Confirmed: `extractPropertyAccesses` and `extractMetaProperty` are the only two creation paths. Both are called from all contexts (module-level via `getHandlers()`, function-level via `PropertyAccessHandler.ts`). All callers pass `scopeTracker`. This precondition holds.

**Precondition 3: `resolveVariableInScope` requires the `file` argument to match `VariableDeclarationInfo.file` exactly**

`PropertyAccessInfo.file` is set to `module.file` (full path). `VariableDeclarationInfo.file` is also set from `module.file` (same full path). These match. This precondition holds for variable/parameter resolution.

For CLASS lookup (the `this` case), `classDecl.file` is a basename (see Gap 3). This precondition FAILS if the implementer does not apply `basename()`.

---

## Summary

The plan is algorithmically sound. The decision tree is complete for all inputs that actually reach CoreBuilder (the Visitor's `extractChain()` pre-filters inputs, narrowing `objectName` to a well-defined set). The `resolveVariableInScope`/`resolveParameterInScope` functions exist, are accessible via `BuilderContext`, and have correct scope-chain semantics for `scopePath = []` at module level.

Three issues require implementer attention before or during implementation:

1. **Gap 3** (HIGH): Use `basename(propAccess.file)` in the CLASS lookup, mirroring MutationBuilder.ts line 200.
2. **Gap 2** (MEDIUM): Add `ClassDeclarationInfo` to the import list in `CoreBuilder.ts`.
3. **Precondition 1** (MEDIUM): Remove `as any` cast; call `scopeTracker?.getEnclosingScope('CLASS')` directly.

None of these prevent starting implementation, but Gap 3 in particular will cause silent test failure for test case 3 if not caught.
