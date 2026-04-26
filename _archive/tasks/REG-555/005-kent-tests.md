# REG-555: Test Report — READS_FROM edges for PROPERTY_ACCESS

**Author:** Kent Beck (Test Engineer)
**Date:** 2026-02-22

---

## Summary

Added 6 test cases in a new `describe('READS_FROM edges for PROPERTY_ACCESS (REG-555)')` block to the existing test file `test/unit/plugins/analysis/ast/property-access.test.ts`.

All 6 tests **pass** because Rob's implementation (006-rob-implementation.md) was already in place in `CoreBuilder.bufferPropertyAccessNodes`.

---

## Test Patterns Used from Existing Tests

1. **Test infrastructure:** Reused the existing `setupTest()`, `findPropertyAccessNode()`, `findAllPropertyAccessNodes()`, `getNodesByType()`, and `getEdgesByType()` helpers already defined at the top of the file.

2. **Node querying:** Same pattern as existing CONTAINS edge tests (TEST 13): query for edges by type, then find the specific edge by matching `src` and `dst` node IDs.

3. **Assertion messages:** Included diagnostic JSON in assertion messages (same pattern as existing tests) to make failures debuggable -- the message shows all found READS_FROM edges when the expected one is missing.

4. **File setup:** Single `index.js` file per test, minimal code to exercise one specific behavior.

---

## Where the Tests Were Added

**File:** `test/unit/plugins/analysis/ast/property-access.test.ts`
**Location:** New describe block at end of the outer `describe('PROPERTY_ACCESS Nodes (REG-395)')`, after the existing `import.meta property access (REG-300)` block.
**Lines:** 1008-1223 (approximately 215 lines added)

---

## Test Cases

| # | Test Name | Code Under Test | Expected Behavior |
|---|-----------|----------------|-------------------|
| 1 | READS_FROM edge to VARIABLE | `let obj = { prop: 42 }; const x = obj.prop;` | PROPERTY_ACCESS "prop" -> READS_FROM -> VARIABLE "obj" |
| 2 | READS_FROM edge to PARAMETER | `function f(options) { return options.graph; }` | PROPERTY_ACCESS "graph" -> READS_FROM -> PARAMETER "options" |
| 3 | this.prop -> CLASS | `class Config { constructor(options) { this.val = options.val; } getVal() { return this.val; } }` | PROPERTY_ACCESS "val" (objectName "this") -> READS_FROM -> CLASS "Config" |
| 4 | Chained access a.b.c | `let a = { b: { c: 42 } }; const x = a.b.c;` | PA "b" (objectName "a") has READS_FROM -> VARIABLE "a"; PA "c" (objectName "a.b") has NO READS_FROM edge |
| 5 | Unknown identifier | `const x = unknownObj.prop;` | No crash, no READS_FROM edge |
| 6 | Module-level access | `let cfg = { timeout: 5000 }; cfg.timeout;` | PROPERTY_ACCESS "timeout" -> READS_FROM -> VARIABLE "cfg" |

---

## Fixture Design Decisions

### `let` vs `const` for variable declarations

Tests 1, 4, and 6 use `let` instead of `const` because:
- `const` with a literal initializer (including `{ prop: 42 }`) creates a **CONSTANT** node, not a VARIABLE node.
- `ExpressionEvaluator.extractLiteralValue` treats `ObjectExpression` with all-literal properties as a literal value.
- The plan's acceptance criteria specifies READS_FROM -> VARIABLE. Using `let` ensures a VARIABLE node is created.

### `this.val` read vs write

Test 3 adds a `getVal()` method that reads `this.val` rather than relying on the constructor's `this.val = options.val`. The constructor assigns to `this.val` (LHS of assignment = write), which does NOT create a PROPERTY_ACCESS node (confirmed by existing test 7: "should skip PROPERTY_ACCESS for assignment LHS"). The read in `getVal()` does produce a PROPERTY_ACCESS node.

---

## Test Output

```
# Subtest: READS_FROM edges for PROPERTY_ACCESS (REG-555)
    ok 1 - should create READS_FROM edge from PROPERTY_ACCESS to VARIABLE
    ok 2 - should create READS_FROM edge from PROPERTY_ACCESS to PARAMETER
    ok 3 - should create READS_FROM edge from this.prop to CLASS node
    ok 4 - should create READS_FROM for base of chain but skip chained intermediate
    ok 5 - should not crash and should not create READS_FROM for unknown identifiers
    ok 6 - should create READS_FROM for module-level property access
ok 17 - READS_FROM edges for PROPERTY_ACCESS (REG-555)
```

All 6 tests pass. The implementation in `CoreBuilder.bufferPropertyAccessNodes` (lines 222-299) correctly handles all cases:
- Variable resolution via `resolveVariableInScope`
- Parameter resolution via `resolveParameterInScope`
- CLASS lookup for `this.prop` using `enclosingClassName` + `basename()` comparison
- Skip for chained objectNames (containing `.`)
- Skip for `import.meta`
- Graceful handling of unknown identifiers (no edge, no crash)

---

## Full Suite Status

```
# tests 41
# pass 40
# fail 1
```

The 1 failure is a pre-existing issue in the `import.meta property access (REG-300)` block (test "should create PROPERTY_ACCESS for import.meta.resolve() intermediate links") -- unrelated to REG-555.
