# Kent Beck -- Test Report for REG-498

## Test File

`test/unit/DataFlowValidator.test.js`

## Test Strategy

**Mock-based unit tests.** The DataFlowValidator is tested in isolation with a mock GraphBackend that supplies pre-built nodes and edges. No RFDB server needed. This gives fast, deterministic tests that verify the validator's logic directly.

The mock backend also tracks method call counts, enabling performance contract assertions.

## Test Coverage

### Bug Fix #1: DERIVES_FROM edges (3 tests)

| Test | What it verifies |
|------|-----------------|
| for-of loop variable with DERIVES_FROM | Variable with `DERIVES_FROM` edge to array should NOT trigger `ERR_MISSING_ASSIGNMENT` |
| for-in loop variable with DERIVES_FROM | Variable with `DERIVES_FROM` edge to object should NOT trigger `ERR_MISSING_ASSIGNMENT` |
| for-of with non-Identifier source | `for (const x of getItems())` -- DERIVES_FROM to CALL node should not false-positive |

### Bug Fix #2: Node type filter (3 tests)

| Test | What it verifies |
|------|-----------------|
| VARIABLE nodes are found | Validator detects `type='VARIABLE'`, not `VARIABLE_DECLARATION` |
| CONSTANT nodes are found | Const declarations still validated |
| PARAMETER nodes NOT validated | Explicit lock: parameters are excluded from validation |

### Bug Fix #3: Performance contract (2 tests)

| Test | What it verifies |
|------|-----------------|
| No getAllEdges calls | Mock tracks calls; validator must use `getOutgoingEdges`/`getIncomingEdges` |
| No unfiltered getAllNodes | Must use `queryNodes` or `getAllNodes(filter)`, not bare `getAllNodes()` |

### findPathToLeaf (3 tests)

| Test | What it verifies |
|------|-----------------|
| Cycle detection | A -> B -> A chain terminates without infinite recursion |
| Literal leaf tracing | ASSIGNED_FROM -> LITERAL is a valid leaf path |
| Function leaf tracing | ASSIGNED_FROM -> FUNCTION is a valid leaf path |

### Integration (1 test)

| Test | What it verifies |
|------|-----------------|
| Mixed variable scenario | Assigned, derived, and unassigned variables classified correctly in one pass |

## Total: 12 tests

## Expected Behavior

All 12 tests define the **fixed** behavior. They will fail against the current buggy `DataFlowValidator` and pass after Rob implements the three bug fixes.

## Run Command

```bash
node --test test/unit/DataFlowValidator.test.js
```

Note: requires `pnpm build` first (tests import from `dist/`).
