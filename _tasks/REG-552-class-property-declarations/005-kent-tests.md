## Kent Beck — Test Report: REG-552

**File created:** `test/unit/ClassPropertyDeclarations.test.js`

---

### What was written

7 test cases specifying the expected behavior for class property declaration indexing, following the exact pattern from `ClassPrivateMembers.test.js`:

| # | Test | Status | Why |
|---|------|--------|-----|
| 1 | Three fields with different modifiers (private/public/protected) all indexed | FAIL | `metadata.modifier` is `undefined` — the `else` branch in ClassProperty handler does not exist yet |
| 2 | TypeScript type annotation stored in `metadata.type` | FAIL | `metadata.type` is `undefined` — same root cause |
| 3 | HAS_PROPERTY edge from CLASS to field VARIABLE | PASS | Already works — the existing ClassProperty handler creates VARIABLE nodes for non-function fields (they land in `variableDeclarations`), and `TypeSystemBuilder` already wires HAS_PROPERTY edges |
| 4 | Field has correct file, line, column | PASS | Already works — position data comes from the existing node creation path |
| 5 | readonly modifier | FAIL | `metadata.modifier` is `undefined` — same root cause as #1 |
| 6 | Field with initializer (`count = 0`) still indexed | PASS | Already works — `count = 0` is a non-function ClassProperty, and the existing path does create a VARIABLE node |
| 7 | Function-valued property still creates FUNCTION node (no regression) | FAIL | The FUNCTION node for `handle` exists, but the test also checks `label.metadata.modifier === 'private'` which fails — the modifier metadata is the missing piece |

### Analysis of results

**3 tests pass, 4 tests fail.** This is the correct outcome:

- The 3 passing tests confirm that the existing infrastructure already creates VARIABLE nodes for non-function class properties and wires HAS_PROPERTY edges. The graph structure is already there.
- The 4 failing tests all fail for the same root cause: `metadata.modifier` and `metadata.type` are not being populated. This is exactly the gap REG-552 will fill — the `else` branch in the ClassProperty handler needs to extract `accessibility`, `readonly`, and `typeAnnotation` from the Babel AST node and store them in metadata.

No setup errors. No import failures. No infrastructure issues. Tests fail for the right reason.

### Test run output

```
▶ Class Property Declarations (REG-552)
  ✖ should create VARIABLE nodes for fields with private/public/protected modifiers
      AssertionError: graph modifier should be 'private', got: undefined
  ✖ should store TypeScript type annotation in metadata.type
      AssertionError: db type should be 'Database', got: undefined
  ✔ should create HAS_PROPERTY edge from CLASS to field VARIABLE
  ✔ should record correct source position for field
  ✖ should handle readonly modifier
      AssertionError: modifier should include 'readonly', got: undefined
  ✔ should index field with initializer value
  ✖ should not break function-valued class properties (regression check)
      AssertionError: label modifier should be 'private', got: undefined

ℹ tests 7
ℹ pass 3
ℹ fail 4
ℹ duration_ms 3243
```

### Key insight for implementer

The fact that tests 3, 4, 6 pass means the VARIABLE node creation path for non-function ClassProperty already works. The implementation only needs to enrich the metadata — no new node creation logic, no new edge types. The `else` branch in ClassVisitor.ts just needs to populate `metadata.modifier` and `metadata.type` on the existing `VariableDeclarationInfo` push.
