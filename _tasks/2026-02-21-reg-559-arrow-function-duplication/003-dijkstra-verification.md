## Dijkstra Plan Verification — v2 (Updated)

**Date:** 2026-02-21
**Author:** Edsger Dijkstra (Plan Verifier)
**Verdict:** APPROVE (with conditions — see below)

---

### Summary

Don's revised plan (v2) correctly addresses both gaps raised in my original REJECT:

1. **Class field initializer arrow** — Don's investigation is accurate. The duplication for
   `class A { field = x => x }` is a **pre-existing bug** not introduced by this fix. The
   proposed `getFunctionParent()` guard leaves this case unchanged: FunctionVisitor still fires
   (guard does not trigger), ClassVisitor.ClassProperty still fires. Behavior before and after
   the fix is identical for class field arrows. The fix does not make this case worse.

2. **Default parameter arrow** — Don's investigation is accurate. `funcPath.traverse()` in
   `analyzeFunctionBody` (JSASTAnalyzer.ts line 3286) visits the entire subtree rooted at the
   function node, which includes `node.params` and their children. An arrow in a default
   parameter value (`cb = x => x`) is reached by this traversal. `NestedFunctionHandler`
   handles it correctly. The fix is safe for this case.

The plan is approved. Both gaps are resolved.

---

## Verification of Don's Gap 1: Class Field Arrow (Pre-existing Bug)

### What ClassVisitor.ClassProperty actually does

Code inspection of `ClassVisitor.ts` lines 277–334 confirms:

```typescript
// Lines 286, 291–304
const functionId = computeSemanticIdV2('FUNCTION', propName, module.file, scopeTracker.getNamedParent());

(functions as ClassFunctionInfo[]).push({
  id: functionId,
  type: 'FUNCTION',
  name: propName,
  file: module.file,
  line: propLine,
  column: propColumn,
  // ...
  isClassProperty: true,
  className: className,
});
```

`ClassVisitor.ClassProperty` unconditionally creates a FUNCTION node when the property value is
an `ArrowFunctionExpression` or `FunctionExpression`. This is confirmed by direct code reading.

### Why the proposed fix does NOT change this case

The proposed fix adds `if (path.getFunctionParent()) return;` to `FunctionVisitor.ArrowFunctionExpression`.

For `class A { field = x => x }`:
- `getFunctionParent()` traverses up: ClassProperty → ClassBody → ClassDeclaration → Program.
  No function boundary is encountered. Returns `null`.
- The guard does NOT trigger.
- `FunctionVisitor.ArrowFunctionExpression` still fires (same as today, before the fix).
- `ClassVisitor.ClassProperty` also still fires (unrelated to the fix).

Therefore: the number of FUNCTION nodes created for a class field arrow is identical before and
after the fix. The fix is **neutral** for this case — it neither introduces nor removes the
duplication.

### Is this truly pre-existing?

Yes. The two creation paths are:
- **Path A** (FunctionVisitor, runs during `traverse_functions` at line 1863): `scopeTracker`
  at global scope → `getNamedParent()` returns module-level named parent (or undefined).
- **Path B** (ClassVisitor.ClassProperty, runs during `traverse_classes` at line 1969):
  `scopeTracker` at class scope → `getNamedParent()` returns `className`.

Both call `computeSemanticIdV2('FUNCTION', propName, module.file, getNamedParent())` with
different `getNamedParent()` values. They produce different IDs. Two FUNCTION nodes exist today,
regardless of this fix.

**Don's decision to scope this out and file a follow-up is correct.** The regression anchor test
(asserting 2 FUNCTION nodes for `class A { field = x => x }`) is the right approach — it
documents the pre-existing behavior and will flag the fix when the follow-up issue is addressed.

---

## Verification of Don's Gap 2: Default Parameter Arrow

### What `funcPath.traverse()` actually visits

`analyzeFunctionBody` at JSASTAnalyzer.ts line 3286:
```typescript
funcPath.traverse(mergedVisitor);
```

`funcPath` is a `NodePath<t.Function | t.StaticBlock>`. For a `FunctionDeclaration`, the Babel
AST node has:
- `node.params` — array of parameters (may include `AssignmentPattern` nodes for defaults)
- `node.body` — the `BlockStatement`

Babel's `path.traverse()` visits the **entire subtree** rooted at `funcPath.node`. The `params`
array is part of that subtree. For `function f(cb = x => x) {}`:
- `params[0]` is an `AssignmentPattern` with `right: ArrowFunctionExpression`
- `funcPath.traverse()` walks into `params[0].right` and fires `ArrowFunctionExpression`
- `NestedFunctionHandler.ArrowFunctionExpression` (line 115) handles it

After the proposed fix:
- `FunctionVisitor` skips the arrow (guard triggers: `getFunctionParent()` returns `FunctionDeclaration`)
- `NestedFunctionHandler` handles it during `analyzeFunctionBody`

**Don's conclusion is correct.** Don's required test case (`function f(cb = x => x) {}` → exactly
1 FUNCTION node) will serve as the verification anchor.

---

## Updated Completeness Table

| # | Arrow context | `getFunctionParent()` | FunctionVisitor after fix | NestedFunctionHandler | ClassVisitor.ClassProperty | Result |
|---|---------------|-----------------------|---------------------------|-----------------------|---------------------------|--------|
| 1 | Module-level: `const fn = x => x` | null | fires | does not fire | does not fire | CORRECT |
| 2 | Module-level callback: `arr.map(x => x)` at module scope | null | fires | does not fire | does not fire | CORRECT |
| 3 | Arrow inside named function body: `function f() { arr.map(x => x) }` | FunctionDeclaration | skips | fires | does not fire | CORRECT (BUG FIXED) |
| 4 | Arrow inside class METHOD body: `class A { m() { arr.map(x => x) } }` | ClassMethod | skips | fires | does not fire | CORRECT (BUG FIXED, REG-559 primary) |
| 5 | Outer arrow in curried: `const g = () => x => x` | null | fires | does not fire | does not fire | CORRECT |
| 6 | Inner arrow in curried: `const g = () => x => x` (inner) | ArrowFunctionExpression | skips | fires (via outer's analyzeFunctionBody) | does not fire | CORRECT |
| 7 | Arrow inside if/for/try at MODULE level: `if (true) { const fn = x => x }` | null | fires | does not fire | does not fire | CORRECT |
| 8 | Class field initializer: `class A { field = x => x }` | null | fires | does not fire | fires | PRE-EXISTING BUG (unchanged by fix, tracked by follow-up) |
| 9 | Default parameter: `function f(cb = x => x) {}` | FunctionDeclaration | skips | fires (params in traverse scope) | does not fire | CORRECT |
| 10 | Arrow as class field method: `class A { m = (x) => x }` — same as #8 | null | fires | does not fire | fires | PRE-EXISTING BUG (unchanged by fix, same as #8) |

---

## Precondition Re-verification

### Precondition 1: `getFunctionParent() === null` means the arrow is not inside a function body

**Status: CONFIRMED SUFFICIENT** (with known caveat).

The precondition correctly identifies all arrows that should be handled by `NestedFunctionHandler`
(cases 3, 4, 6, 9) — they all have non-null `getFunctionParent()`. The caveat is case 8 (class
field arrows), where `getFunctionParent() === null` but the arrow is NOT at module level in the
semantic sense. However, Don correctly establishes this is a pre-existing bug that the fix does not
affect. The precondition is sufficient for the scope of REG-559.

### Precondition 2: Every arrow that `FunctionVisitor` skips is handled by `NestedFunctionHandler`

**Status: CONFIRMED SUFFICIENT** (for REG-559 scope).

For all cases where `getFunctionParent() !== null` (cases 3, 4, 6, 9), `NestedFunctionHandler`
handles the arrow via `analyzeFunctionBody`. The exception (class field, case 8) has
`getFunctionParent() === null`, so `FunctionVisitor` does NOT skip it — the precondition is not
violated for that case.

---

## Conditions for Approval

1. **Class field regression anchor test required.** The test suite MUST include the case
   `class A { field = x => x }` asserting the current pre-existing behavior (2 FUNCTION nodes),
   with a comment explicitly naming the follow-up Linear issue tracking the bug. Don's v2 plan
   includes this.

2. **Default parameter test required.** The test suite MUST include `function f(cb = x => x) {}`
   asserting exactly 1 FUNCTION node. Don's v2 plan includes this.

3. **Follow-up Linear issue must be filed** for the class field arrow duplication before or
   immediately after the PR lands. Don's v2 plan specifies this.

All three conditions are present in Don's v2 plan. No blocking changes are required.

---

## What Remains Correct (Unchanged from v1 Assessment)

- Root cause identification: correct. `FunctionVisitor` fires on all arrows without scope guard.
- Fix location: correct. The guard belongs in `FunctionVisitor.ArrowFunctionExpression`.
- Guard condition `path.getFunctionParent()`: correct for the ClassMethod and named-function cases.
- Analysis of `NestedFunctionHandler` and why it should not be changed: correct.
- `FunctionDeclaration` analogy and callbacks-traverse reference: correct.
- `FunctionExpression` handling does not need changes: correct.
- The two-file change set (FunctionVisitor.ts + new test file): correct and minimal.

---

## Conclusion

The revised plan (v2) is complete and correct for the scope of REG-559. Both gaps from the
original REJECT have been addressed with code-inspection evidence:

- Gap 1 (class field arrow): pre-existing bug, fix does not affect it, regression anchor test
  documents current behavior, follow-up issue to be filed.
- Gap 2 (default parameter arrow): confirmed safe via Babel traversal semantics.

The fix is a minimal, targeted change (~3 lines) with low risk. The expanded test suite provides
adequate coverage for the fixed case (4) and safety verification for the adjacent cases (3, 9).

**VERDICT: APPROVE**
