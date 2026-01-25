# Kent Beck Test Report: REG-229 RECEIVES_ARGUMENT Tests

## Summary

Created comprehensive test fixtures and test file for RECEIVES_ARGUMENT edge creation. Tests are designed to fail initially since `ArgumentParameterLinker` plugin does not exist yet - this is TDD working as intended.

## Files Created

### Test Fixtures

1. **`test/fixtures/receives-argument/package.json`**
   - ESM module configuration for test fixture

2. **`test/fixtures/receives-argument/index.js`**
   - Main test fixture with 14 test scenarios:
     1. Basic argument binding: `process(userInput)`
     2. Multi-argument binding: `combine(x, y)`
     3. Method call binding: `service.process(userInput)`
     4. Arrow function binding: `double(value)`
     5. Unresolved call: `unknownFunction(userInput)`
     6. Missing arguments: `threeParams(x, y)` - only 2 args for 3 params
     7. Extra arguments: `oneParam(x, y, value)` - 3 args for 1 param
     8. Literal arguments: `processNumber(42)`, `processString('hello')`
     9. Nested call as argument: `outer(inner('test'))`
     10. Function expression: `namedFn({ type: 'click' })`
     11. Rest parameter: `withRest(0, ...nums)`
     12. Callback with parameters: `withCallback('test', (d) => d.trim())`
     13. IIFE parameters
     14. Multiple calls to same method

3. **`test/fixtures/receives-argument/cross-file/package.json`**
   - ESM module for cross-file test

4. **`test/fixtures/receives-argument/cross-file/a.js`**
   - Exported functions: `processData`, `multiParam`, `Handler` class

5. **`test/fixtures/receives-argument/cross-file/b.js`**
   - Imports from a.js and calls functions with arguments
   - Tests cross-file parameter binding

### Test File

**`test/unit/ReceivesArgument.test.js`**

Following `PassesArgument.test.js` pattern exactly:

- Uses `createTestBackend()` and `createTestOrchestrator()` helpers
- Uses Datalog queries via `backend.checkGuarantee()` to find nodes
- Uses `backend.getOutgoingEdges()` to verify edge creation

## Test Suites

| Suite | Tests | Description |
|-------|-------|-------------|
| Basic argument-to-parameter binding | 2 | PARAMETER receives from VARIABLE/LITERAL |
| Multi-argument binding | 1 | Each parameter receives correct arg by index |
| Method call binding | 1 | Class method parameters receive arguments |
| Arrow function binding | 1 | Arrow function parameters receive arguments |
| Unresolved calls | 1 | No crash when CALLS edge missing |
| Missing arguments | 1 | Extra params get no edge |
| Extra arguments | 1 | Extra args get no edge |
| Edge metadata | 2 | argIndex and callId present |
| No duplicates on re-run | 1 | Idempotency check |
| Multiple calls to same function | 1 | Separate edges per call |
| Cross-file argument binding | 1 | Works across import boundaries |

**Total: 13 test cases**

## Key Assertions

1. **Edge direction**: `PARAMETER --RECEIVES_ARGUMENT--> argument_source`
2. **Edge metadata**: Contains `argIndex` (0-based) and `callId`
3. **No edges for unresolved calls**: When no CALLS edge exists
4. **No duplicate edges on re-run**: Idempotency guarantee

## Test Execution Verification

Ran tests to verify they execute and fail as expected:

```
$ node --test test/unit/ReceivesArgument.test.js 2>&1 | head -50

# Found 3 'data' parameters
#   Parameter: data file=/Users/vadimr/grafema-worker-2/test/fixtures/receives-argument/index.js
# Parameter 'data' has 0 RECEIVES_ARGUMENT edges
not ok 1 - should create RECEIVES_ARGUMENT edge: PARAMETER receives from VARIABLE
  error: 'PARAMETER should have at least one RECEIVES_ARGUMENT edge'
```

Tests correctly:
- Find PARAMETER nodes via Datalog queries
- Query for RECEIVES_ARGUMENT edges (returning 0 as expected)
- Fail with clear assertion messages

## Notes for Implementation

When implementing `ArgumentParameterLinker`:

1. **Dependencies**: Must run after `MethodCallResolver` (needs CALLS edges)
2. **Input**: CALL nodes with PASSES_ARGUMENT edges
3. **Resolution**: Follow CALLS edge to get target function
4. **Matching**: Use HAS_PARAMETER edges + PARAMETER.index to match args
5. **Output**: Create RECEIVES_ARGUMENT edges from PARAMETER to argument source

## Compliance

- [x] Tests follow existing patterns (PassesArgument.test.js)
- [x] Uses createTestOrchestrator helper
- [x] Uses TestRFDB helper
- [x] No mocks in production paths
- [x] Tests communicate intent clearly
- [x] Tests will fail initially (TDD)
- [x] Covers all scenarios from Joel's plan
