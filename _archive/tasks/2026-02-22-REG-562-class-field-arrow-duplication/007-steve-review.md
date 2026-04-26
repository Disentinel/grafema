# Steve Jobs Vision Review: REG-562

**Verdict: APPROVE**

---

## The Core Question

Grafema's entire value proposition is this: the graph is the truth. When you query a function in this graph, you get one node. One source of truth. The moment you have two FUNCTION nodes at the same source position, the graph lies. Agents get confused. Users lose trust. And trust, once lost in a tool like this, does not come back.

REG-562 fixed a lie in the graph. That matters.

---

## Vision Alignment

**Does this fix align with accurate code graphs?**

Yes. A class field arrow (`field = x => x`) is one function. The graph must have one FUNCTION node for it. Two nodes at the same position is a correctness defect — not a performance issue, not a cosmetic issue. A correctness defect. This fix eliminates it cleanly.

The framing of the fix is also architecturally correct: ClassVisitor is the authoritative owner of class member semantics. It knows the field name, the class scope, the correct parent. FunctionVisitor operates at module-level scope and has no business touching something it cannot name correctly. Deferring to authority is the right call.

---

## Is the Fix Minimal and Surgical?

Three lines of production code:

```typescript
// Skip arrow functions used as class field initializers — ClassVisitor is authoritative (REG-562)
const parent = path.parent;
if (parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') return;
```

Plus removing a now-redundant `const parent = path.parent` declaration that was previously lower in the handler. The hoisting was not a choice — it was forced by TypeScript's `const` scoping rules. This is not padding. This is the minimum correct change.

The guard placement is precise: it comes after the `getFunctionParent()` check (which handles the nested-function case from REG-559) and before any FUNCTION node creation. The two guards together form a clean decision tree:

1. Is this arrow nested inside another function? → skip (NestedFunctionHandler owns it)
2. Is this arrow a class field initializer? → skip (ClassVisitor owns it)
3. Otherwise → FunctionVisitor owns it

That is clear. That is correct. That is the kind of code that does not surprise you six months later.

---

## Would Shipping This Embarrass Us?

No. The code comment is precise and references the ticket. The logic is immediately understandable to any reader of the file. There are no workarounds, no `// TODO`, no hacks.

One observation worth noting: the `parent` variable is now declared earlier in the handler than the existing `VariableDeclarator` check that uses it. This is strictly cleaner — the variable is declared once, used in two places. The implementation report from Rob confirms this was handled correctly.

---

## Does the Test Coverage Actually Protect the Fix?

The test suite is thorough and well-structured. Eight dedicated test cases in `ClassFieldArrowDedup.test.js` cover the relevant surface area:

- Basic class field arrow: 1 node, not 2.
- Multi-param field arrow: correct.
- Multiple class fields: each gets exactly one node.
- Static field: covered.
- Private field (`#privateField`): covered, with correct name assertion.
- Nested inner arrow inside class field body: correctly expects 2 nodes (outer + inner), not 1. This case is easy to over-restrict and the test guards against it.
- Method + field together: verifies no cross-contamination.
- Class expression (not declaration): covered.

The update to `ArrowFunctionArgDedup.test.js` adds a regression anchor — Test 4 explicitly documents that the REG-562 class field arrow case produces exactly 1 node after the fix. This is the kind of test that catches a future developer accidentally reverting the guard.

A regression would be caught immediately by at minimum two test files. The coverage is not ceremonial.

---

## One Observation (Not a Blocker)

The test for the nested inner arrow case (Test 6) asserts `allFunctions.length === 2` but does not verify the name of the inner anonymous arrow. If the inner arrow ever becomes misnamed or mis-scoped, this test would still pass as long as the count is 2. A tighter assertion checking that the inner function has the expected scope (e.g., its ID contains `field`) would catch that class of regression. This is a minor gap — the important invariant (no duplicates at the outer level) is well-protected. Not a reason to hold this back.

---

## Summary

The bug was real. The fix is correct. The authority model (ClassVisitor owns class members) is respected, not worked around. The test coverage protects the fix from both direct regression and cross-case contamination. The code is readable by any engineer who picks up this file in the future.

**APPROVE.**
