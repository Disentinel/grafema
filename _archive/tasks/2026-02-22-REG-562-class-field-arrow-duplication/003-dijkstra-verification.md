# REG-562: Dijkstra Verification Report

**Date:** 2026-02-22
**Author:** Edsger Dijkstra (Plan Verifier)
**Verdict: REJECT — one gap found (private field guard incomplete)**

---

## Summary

Don's plan is correct in its root-cause diagnosis, traversal-order analysis, and the design of the fix. The core fix (`if (parent.type === 'ClassProperty') return;`) is sound for public class fields. However, the plan does not address `ClassPrivateProperty` — a distinct AST node type for private class fields (`#field = x => x`). The proposed guard is incomplete: private class field arrows pass through FunctionVisitor unguarded, AND the ClassExpression handler in ClassVisitor has no `ClassPrivateProperty` handler at all. This creates a double-duplication risk that is pre-existing but made more visible by this fix.

---

## Section 1: ArrowFunctionExpression parent types — exhaustive enumeration

Verified with Babel 7.28.6 (`@babel/parser`, `@babel/traverse`):

| Source pattern | `path.parent.type` | `path.getFunctionParent()` |
|---|---|---|
| `class A { field = x => x }` | `ClassProperty` | `null` |
| `class A { static field = x => x }` | `ClassProperty` (`.static = true`) | `null` |
| `class A { #field = x => x }` | `ClassPrivateProperty` | `null` |
| `class A { method() { return x => x } }` | `ReturnStatement` | `ClassMethod` (truthy) |
| `class A { field = () => { const f = x => x } }` (outer) | `ClassProperty` | `null` |
| `class A { field = () => { const f = x => x } }` (inner) | `VariableDeclarator` | `ArrowFunctionExpression` (truthy) |
| `const A = class { field = x => x }` | `ClassProperty` | `null` |
| `const A = class { #field = x => x }` | `ClassPrivateProperty` | `null` |

**Key findings:**

1. Public field (including static): `parent.type === 'ClassProperty'` — correctly matched by proposed guard.
2. Private field: `parent.type === 'ClassPrivateProperty'` — NOT matched by proposed guard. **This is the gap.**
3. Arrow inside class method body: `getFunctionParent()` returns the `ClassMethod` (truthy), so the existing REG-559 guard catches it. The new guard is not reached. No regression here.
4. Nested arrow inside class field (outer): `parent.type === 'ClassProperty'` — new guard returns early. No `path.skip()`. Babel continues into body.
5. Nested arrow inside class field (inner): `getFunctionParent()` returns the outer `ArrowFunctionExpression` (truthy) — existing REG-559 guard returns early. Correct.
6. Class expression field: `parent.type === 'ClassProperty'` — same as ClassDeclaration field. Correctly matched.

---

## Section 2: Private class field — GAP ANALYSIS

### 2a. What is the AST node for `#field = x => x`?

`ClassPrivateProperty` — a distinct node type from `ClassProperty`. This is confirmed by Babel source and by live test above.

### 2b. Does the proposed guard skip it?

**No.** The proposed guard is:
```typescript
if (parent.type === 'ClassProperty') return;
```

For `class A { #field = x => x }`, `path.parent.type === 'ClassPrivateProperty'`. The guard does not match. FunctionVisitor proceeds to create a FUNCTION node named `anonymous[N]`.

### 2c. Does ClassVisitor handle it?

**For ClassDeclaration: YES.** ClassVisitor's `ClassDeclaration` handler (line 473) has a `ClassPrivateProperty` sub-handler that correctly creates a FUNCTION node named `#field` with class context.

**For ClassExpression: NO.** ClassVisitor's `ClassExpression` handler (lines 727–832) only registers `ClassProperty` and `ClassMethod` sub-handlers. There is no `ClassPrivateProperty` handler. For `const A = class { #field = x => x }`:
- FunctionVisitor creates: `FUNCTION[anonymous[N]]` (if guard not extended)
- ClassVisitor creates: nothing

### 2d. Resulting error scenarios

**Case A: `class A { #field = x => x }` (ClassDeclaration)**
- With proposed fix (guard only covers `ClassProperty`):
  - FunctionVisitor: sees `ClassPrivateProperty`, guard fails, creates `FUNCTION[anonymous[N]]` — **wrong node created**
  - ClassVisitor: creates `FUNCTION[#field[in:A]]` — correct node
  - Result: **2 FUNCTION nodes for 1 private field arrow (same bug as REG-562, different node type)**

**Case B: `const A = class { #field = x => x }` (ClassExpression)**
- FunctionVisitor: guard fails (same as Case A), creates `FUNCTION[anonymous[N]]`
- ClassVisitor (ClassExpression handler): no `ClassPrivateProperty` handler, creates nothing
- Result: **1 FUNCTION node total, but it is anonymous and wrong — no named node at all**

Both cases are bugs, but they are pre-existing. Don's plan does not introduce them. However, the plan claims to fix "class field arrow duplication" fully; the private field case is excluded without acknowledgment.

---

## Section 3: `path.getFunctionParent()` behavior for class field arrows

Confirmed: Don's claim is accurate. For any arrow function directly assigned as a class field value (public or private), `path.getFunctionParent()` returns `null`. The path walks up: `ArrowFunctionExpression → ClassProperty/ClassPrivateProperty → ClassBody → ClassDeclaration/ClassExpression`. `ClassProperty` and `ClassPrivateProperty` are not function boundaries in Babel's scope model. The REG-559 guard correctly does NOT help here.

---

## Section 4: Nested arrow inside class field — does the fix accidentally over-skip?

**Concern:** If FunctionVisitor does `return` (not `path.skip()`) on the outer class-field arrow, Babel continues traversing into the body. The inner arrow (`const f = x => x`) has `parent.type === 'VariableDeclarator'` and `getFunctionParent() = outer ArrowFunctionExpression` (truthy). The REG-559 guard catches it and returns.

**Verdict:** Safe. The inner arrow is handled by `NestedFunctionHandler` during ClassVisitor's `analyzeFunctionBody` call. No duplication.

The absence of `path.skip()` in the new guard (just `return`) is critical and correct — `path.skip()` would suppress ClassVisitor's nested traversal, which must not happen. Don's plan already uses `return` (not `path.skip()`). Confirmed correct.

---

## Section 5: Static class fields

`class A { static field = x => x }` — `path.parent.type === 'ClassProperty'` with `parent.static === true`. The proposed guard matches exactly. No special handling needed.

ClassVisitor's `ClassProperty` handler (line 249) does not check `propNode.static` — it processes both static and non-static fields identically. This is correct behavior (same FUNCTION node, just marked as static by ClassProperty metadata if needed elsewhere).

**Verdict:** Static fields are correctly handled by the proposed fix.

---

## Section 6: ClassVisitor correctness for all handled paths

**ClassDeclaration handler sub-handlers:**
- `ClassProperty`: public fields (static and non-static) — present and correct
- `ClassMethod`: regular methods — present and correct
- `StaticBlock`: static init blocks — present and correct
- `ClassPrivateProperty`: private fields — present and correct (lines 473–580)
- `ClassPrivateMethod`: private methods — present and correct

**ClassExpression handler sub-handlers:**
- `ClassProperty`: public fields — present and correct (lines 728–782)
- `ClassMethod`: regular methods — present and correct (lines 784–831)
- `ClassPrivateProperty`: **ABSENT** — pre-existing gap, not introduced by REG-562
- `ClassPrivateMethod`: **ABSENT** — pre-existing gap, not introduced by REG-562

Don's plan states: "Both cases are already correct" (referring to ClassDeclaration and ClassExpression handlers). This is **incorrect for ClassExpression with private fields**. However, this is a pre-existing gap unrelated to REG-562.

---

## Section 7: Existing test — Don's claim verified

Don says the test at `test/unit/ArrowFunctionArgDedup.test.js` lines 200–235 "currently expects 2 nodes (documenting the bug)."

**Verified.** Lines 200–235 contain a test labeled `'Class field arrow (REG-562)'` that:
- Sets up `class A { field = x => x; }`
- Asserts `allFunctions.length === 2` with comment "documents pre-existing duplication"
- Also asserts `namedField.length === 1` (the ClassVisitor-created node)

This is the anchor test. Don's update instructions are correct: change the `2` to `1`, add assertion that the single FUNCTION node has `name === 'field'` and correct semantic ID.

---

## Section 8: Downstream impact — does anything depend on FunctionVisitor-created nodes for class field arrows?

No specific downstream consumers checked against source, but the semantic ID produced by FunctionVisitor for a class field arrow is `index.js->FUNCTION->anonymous[N]` — this is wrong and would not be referenced by any other node intentionally. ClassVisitor's ID `index.js->FUNCTION->field[in:A]` is what all other analysis (enrichers, edges, queries) would reference. Removing the FunctionVisitor-created spurious node does not break any downstream consumer — the correct node from ClassVisitor remains.

---

## Section 9: Required fix to the proposed guard

The proposed guard must be extended to cover both node types:

```typescript
// Skip arrow functions used as class field initializers — those are handled
// by ClassVisitor.ClassProperty / ClassVisitor.ClassPrivateProperty, which
// assigns the correct property name and class scope context.
// ClassProperty and ClassPrivateProperty are not function boundaries in Babel,
// so getFunctionParent() above does not catch these cases. (REG-562)
const parent = path.parent;
if (parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') return;
```

This is a one-line change to the guard. It is minimal and does not introduce new risks.

**Implication for test plan:** Add a test case for `class A { #field = x => x }` (ClassDeclaration with private field) → exactly 1 FUNCTION node named `#field`. The ClassExpression + private field case remains a known gap (pre-existing, out of REG-562 scope) and should be tracked as a separate issue.

---

## Verdict: REJECT (minor, fixable)

**Approve after one change:**

In `FunctionVisitor.ArrowFunctionExpression`, change the guard from:
```typescript
if (parent.type === 'ClassProperty') return;
```
to:
```typescript
if (parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') return;
```

And add one additional test case to `ClassFieldArrowDedup.test.js`:
- `class A { #privateField = x => x }` → exactly 1 FUNCTION node named `#privateField`, with ID ending `->FUNCTION->#privateField[in:A]`

Everything else in Don's plan is correct:
- Root cause diagnosis: correct
- Traversal order analysis: correct
- Fix location (FunctionVisitor, not ClassVisitor): correct
- `return` vs `path.skip()`: correct (return, not skip)
- Nested arrow in class field: safe (getFunctionParent guard catches inner)
- Static field: correctly handled by `ClassProperty` guard
- Class expression: correctly handled by `ClassProperty` guard
- Existing test update: correct
- Test cases 1–7: all valid, add case 8 for private field
- No downstream consumer breakage: confirmed

The gap is narrow and the fix is trivial. Once the guard includes `ClassPrivateProperty`, the plan is complete.
