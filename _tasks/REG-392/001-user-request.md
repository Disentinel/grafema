# REG-392: FLOWS_INTO edges for non-variable values in indexed array assignments

## Problem

`bufferArrayMutationEdges` in GraphBuilder creates FLOWS_INTO edges only for VARIABLE types. Literals, objects, arrays, and function calls do not create edges:

```javascript
const arr = [];
arr[0] = 'test';           // ❌ No FLOWS_INTO edge (LITERAL)
arr[1] = { name: 'foo' };  // ❌ No FLOWS_INTO edge (OBJECT_LITERAL)
arr[2] = [1, 2, 3];        // ❌ No FLOWS_INTO edge (ARRAY_LITERAL)
arr[3] = getValue();       // ❌ No FLOWS_INTO edge (CALL)

const value = 42;
arr[4] = value;             // ✅ Works (VARIABLE)
```

## Acceptance Criteria

- FLOWS_INTO edge for `arr[i] = 'literal'`
- FLOWS_INTO edge for `arr[i] = { obj }`
- FLOWS_INTO edge for `arr[i] = [array]`
- FLOWS_INTO edge for `arr[i] = func()`
- All tests in `IndexedArrayAssignmentRefactoring.test.js` pass
- All edges have `mutationMethod: 'indexed'` and `argIndex: 0`

## Related

- REG-113 (Done) — Track array mutations
- REG-116 (Done) — Extract indexed assignment helper
- REG-154 — Fix skipped tests (5 tests blocked by this)
