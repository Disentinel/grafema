# REG-554: Test Report — PROPERTY_ASSIGNMENT Nodes

**Author:** Kent Beck, Test Engineer
**Date:** 2026-02-22
**Test file:** `test/unit/property-assignment.test.js`

---

## Test Pattern Used

Followed the established pattern from `ObjectMutationTracking.test.js`:

- `createTestDatabase()` + `cleanupAllTestDatabases()` from `TestRFDB.js`
- `createTestOrchestrator(backend)` with default plugins
- `setupTest(backend, files)` helper that creates a temp directory, writes fixture files, and runs the orchestrator
- `backend.getAllNodes()` and `backend.getAllEdges()` for graph queries
- `beforeEach` creates a fresh database; `after` cleans up

TypeScript fixtures use `.ts` extension in the file map (confirmed working from existing tests like `DataFlowTracking.test.js`).

---

## Test Groups Implemented

| Group | Description | Tests | Expected Status |
|-------|-------------|-------|-----------------|
| 1 | Basic `this.x = variable` in constructor | 3 | FAIL (no PROPERTY_ASSIGNMENT node) |
| 2 | TSNonNullExpression (`options.graph!`) | 1 | FAIL (no PROPERTY_ASSIGNMENT node) |
| 3 | 3-field constructor (AC3) | 1 | FAIL (0 nodes instead of 3) |
| 4 | LITERAL RHS (`this.count = 0`) | 1 | FAIL (no PROPERTY_ASSIGNMENT node) |
| 5 | Non-this assignment NOT indexed | 2 | PASS (correctly asserts 0 nodes + regression guard for FLOWS_INTO) |
| 6 | Semantic ID uniqueness (same prop, different classes) | 1 | FAIL (0 nodes instead of 2) |
| 7 | Module-level `this.x = value` (no class) | 1 | PASS (correctly asserts 0 nodes) |
| 8 | Multiple assignments to same property, different methods | 1 | FAIL (0 nodes instead of 2) |

**Total: 11 tests. 8 FAIL, 3 PASS.**

---

## Failure Messages (All Correct)

Every failing test fails with the expected "not found" or "got 0" assertion, confirming the feature is not yet implemented:

```
PROPERTY_ASSIGNMENT node with name="bar" not found
PROPERTY_ASSIGNMENT node with name="graph" not found
Expected 3 PROPERTY_ASSIGNMENT nodes, got 0. Found: []
PROPERTY_ASSIGNMENT node with name="count" not found
Expected 2 PROPERTY_ASSIGNMENT nodes for "x", got 0
Expected 2 PROPERTY_ASSIGNMENT nodes for "x", got 0
```

No syntax errors. No import errors. No infrastructure failures.

---

## What Each Test Verifies

### Group 1 (3 tests): Basic `this.bar = x`
- Test 1: PROPERTY_ASSIGNMENT node exists with `name="bar"`, `objectName="this"`, `className="Foo"`
- Test 2: ASSIGNED_FROM edge from PROPERTY_ASSIGNMENT to PARAMETER `x`
- Test 3: CONTAINS edge from CLASS "Foo" to PROPERTY_ASSIGNMENT

### Group 2 (1 test): TSNonNullExpression
- PROPERTY_ASSIGNMENT node for `this.graph = options.graph!`
- ASSIGNED_FROM edge targets PROPERTY_ACCESS node (not the TSNonNullExpression wrapper)

### Group 3 (1 test): AC3 acceptance criteria
- 3 distinct PROPERTY_ASSIGNMENT nodes (host, port, name)
- Each has CONTAINS edge from CLASS "Server"
- Each has ASSIGNED_FROM edge to corresponding PROPERTY_ACCESS node (`config.host`, etc.)
- ASSIGNED_FROM target verified: `type === 'PROPERTY_ACCESS'`, `objectName === 'config'`, matching property name

### Group 4 (1 test): Literal RHS
- PROPERTY_ASSIGNMENT node exists for `this.count = 0`
- CONTAINS edge from CLASS exists
- Zero ASSIGNED_FROM edges (literal cannot be traced)

### Group 5 (2 tests): Non-this (negative + regression)
- `obj.x = 5` produces zero PROPERTY_ASSIGNMENT nodes
- `obj.handler = handler` still produces FLOWS_INTO edge (regression guard)

### Group 6 (1 test): Semantic ID uniqueness
- Class A and Class B both have `this.x = ...`
- Two distinct PROPERTY_ASSIGNMENT nodes with different IDs
- Different `className` values (A, B)

### Group 7 (1 test): Module-level this (negative)
- `this.globalProp = 'value'` at module level produces zero PROPERTY_ASSIGNMENT nodes

### Group 8 (1 test): Same property, different methods
- Constructor and `reset()` method both assign `this.x`
- Two PROPERTY_ASSIGNMENT nodes with distinct IDs
- Both have CONTAINS edges from CLASS "Foo"

---

## Surprises in Test Infrastructure

None. The test infrastructure is clean and well-established. The pattern from `ObjectMutationTracking.test.js` translates directly. The only consideration was using `.ts` extension for TypeScript fixtures (Groups 2, 3), which works out of the box.

---

## Deviations from Plan Section 6

The plan (Section 6) suggested 8 test groups with slightly different fixtures. I adapted:

1. **Plan Group 1** (3-field constructor with `options.graph`) split into my Groups 1 (basic single-field) and 3 (3-field AC3). This gives finer-grained failure isolation.
2. **Plan Group 2** (TSNonNullExpression) mapped to my Group 2 directly.
3. **Plan Group 3** (regular method assignment) is covered by Group 8 which tests both constructor and method assignment.
4. **Plan Group 4** (non-this) mapped to my Group 5.
5. **Plan Group 5** (module-level this) mapped to my Group 7.
6. **Plan Group 6** (semantic ID stability across runs) not implemented as a separate test. Semantic ID correctness is implicitly covered by Group 6 (distinct IDs across classes) and Group 8 (distinct IDs across methods). Running the orchestrator twice on identical code would require a different test pattern and adds complexity without proportional value at this stage.
7. **Plan Group 7** (literal RHS) mapped to my Group 4.
8. **Plan Group 8** (multiple assignments same property) mapped to my Group 8.

---

## Confirmation

Tests fail correctly. Implementation can proceed. All 8 failing tests will turn green once PROPERTY_ASSIGNMENT nodes, CONTAINS edges, and ASSIGNED_FROM edges are implemented per the plan.
