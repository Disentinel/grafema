# REG-554: Test Report — PROPERTY_ASSIGNMENT Node Type

**Author:** Kent Beck (Test Engineer)
**Date:** 2026-02-22

---

## Test File

`test/unit/PropertyAssignmentTracking.test.js`

---

## Test Cases (6 total)

| # | Test Name | What It Verifies |
|---|-----------|-----------------|
| 1 | Constructor with 3 field assignments | 3 PROPERTY_ASSIGNMENT nodes created with correct names, className='Config', CLASS --CONTAINS--> each PA, each PA --ASSIGNED_FROM--> corresponding PARAMETER |
| 2 | Single this.x = parameter in constructor | PROPERTY_ASSIGNMENT "dep" exists, ASSIGNED_FROM -> PARAMETER "dep" |
| 3 | this.x = local variable in method | PROPERTY_ASSIGNMENT "helper" exists, ASSIGNED_FROM -> VARIABLE "helper" |
| 4 | this.x = literal -- no ASSIGNED_FROM | PROPERTY_ASSIGNMENT "port" created, zero ASSIGNED_FROM edges from it |
| 5 | this.x outside class -- no PROPERTY_ASSIGNMENT | Zero PROPERTY_ASSIGNMENT nodes when `this.x = value` is in a standalone function |
| 6 | CONTAINS edge direction | Edge is CLASS (src) -> PROPERTY_ASSIGNMENT (dst), not reversed |

---

## Patterns Used

- **Test structure:** Follows `ObjectMutationTracking.test.js` exactly -- `beforeEach` creates a fresh test database, `setupTest` writes files and runs the orchestrator.
- **Assertions:** Uses `backend.getAllNodes()` + `backend.getAllEdges()` with `.find()` and `.filter()` to locate nodes and edges, consistent with all existing integration tests.
- **Error messages:** Every assertion includes diagnostic context (listing actual nodes/edges found) to make failures easy to debug.
- **Cleanup:** Uses `cleanupAllTestDatabases` in `after()` hook, same as all other test files.

## Assumptions

1. **PROPERTY_ASSIGNMENT node has `.className` attribute** -- the plan specifies `className` in the `PropertyAssignmentNodeRecord` interface. Tests assert `pa.className === 'Config'`.
2. **`const helper = () => {}` creates a VARIABLE or CONSTANT node** -- consistent with existing behavior where `const` declarations produce CONSTANT-type nodes. Test uses `(n.type === 'VARIABLE' || n.type === 'CONSTANT')` to match both.
3. **Literal RHS (e.g., `this.port = 3000`) still creates the PROPERTY_ASSIGNMENT node** -- the plan states the node is always created when inside a class, only the ASSIGNED_FROM edge is conditional on the RHS type.
4. **No PROPERTY_ASSIGNMENT for standalone functions** -- the plan states the guard `objectName === 'this' && enclosingClassName` prevents creation when there is no enclosing class scope.

## Status

All 6 tests are expected to be RED until implementation is complete. This is correct TDD workflow.
