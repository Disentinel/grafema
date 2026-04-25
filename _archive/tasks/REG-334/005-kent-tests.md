# Kent Beck - Test Report: REG-334 Promise Dataflow Tracking

**Status: Tests Written - All Failing (TDD Red Phase)**

---

## Summary

Test file created at: `/test/unit/analysis/promise-resolution.test.ts`

Following TDD methodology, all tests are written to FAIL before implementation. This ensures:
1. Tests communicate intent clearly
2. Tests verify the feature doesn't accidentally exist
3. Implementation can be validated against these tests

---

## Tests Written

### Unit Tests: Promise Resolution Detection

| Test | Description | Status |
|------|-------------|--------|
| 1.1 | Simple Promise with inline resolve - RESOLVES_TO edge | FAILING |
| 1.2 | Simple Promise - PASSES_ARGUMENT edge | FAILING |
| 2.1 | Promise with resolve and reject - both edges | FAILING |
| 3.1 | Nested callback inside executor | FAILING |
| 4.1 | Nested Promises - no cross-linking | FAILING |
| 5.1 | Edge case: no resolve parameter | PASSING (graceful) |
| 5.2 | Edge case: non-inline executor (out of scope) | PASSING (graceful) |
| 5.3 | Multiple resolve calls in same executor | FAILING |

### Integration Tests: traceValues with Promises

| Test | Description | Status |
|------|-------------|--------|
| 6.1 | Trace variable through Promise to literal | FAILING |
| 6.2 | Trace multiple resolve values | FAILING |
| 6.3 | Handle Promise without RESOLVES_TO | FAILING |

**Total: 9 tests failing, 2 tests passing (edge cases for graceful handling)**

---

## Key Findings During Test Writing

### 1. CALL Nodes for resolve() Exist

Verified by examining test output: `resolve` calls inside functions DO create CALL nodes through `analyzeFunctionBody` in JSASTAnalyzer. The logs show:
```
[INFO] Analysis complete {"modulesAnalyzed":1,"nodesCreated":7}
```

However, these CALL nodes don't have PASSES_ARGUMENT edges to their arguments, and there are no RESOLVES_TO edges (expected - feature not implemented).

### 2. CONSTRUCTOR_CALL Nodes for Promise Exist

The test setup correctly creates CONSTRUCTOR_CALL nodes for `new Promise()`. This is confirmed by the test finding `promiseNode`.

### 3. traceValues Current Behavior for CONSTRUCTOR_CALL

Before implementation, traceValues returns `no_sources` for CONSTRUCTOR_CALL nodes:
```json
{
  "source": {"id": "...CONSTRUCTOR_CALL:Promise:6:21", ...},
  "isUnknown": true,
  "reason": "no_sources"
}
```

This confirms the traceValues extension is needed to handle CONSTRUCTOR_CALL specifically.

### 4. No RESOLVES_TO Edge Type Yet

The test confirms no RESOLVES_TO edges exist:
```
Should have RESOLVES_TO edge. Found edges: []
```

This is expected - the edge type and creation logic are part of the implementation.

---

## Test File Structure

```
test/unit/analysis/promise-resolution.test.ts
├── Helper functions
│   ├── setupTest() - create temp project and run analysis
│   ├── findPromiseConstructorCall() - find Promise CONSTRUCTOR_CALL node
│   ├── findCallNode() - find CALL node by name
│   ├── findAllCallNodes() - find all CALL nodes by name
│   └── findEdgesByType() - find edges by type
│
├── describe('Promise Resolution Detection')
│   ├── Simple Promise with inline resolve
│   │   ├── should create RESOLVES_TO edge
│   │   └── should have PASSES_ARGUMENT edge
│   ├── Promise with resolve and reject
│   │   └── should create edges for both
│   ├── Nested callback inside executor
│   │   └── should create edge from nested resolve
│   ├── Nested Promises
│   │   └── should not cross-link
│   └── Edge cases
│       ├── no resolve parameter
│       ├── non-inline executor
│       └── multiple resolve calls
│
└── describe('traceValues with RESOLVES_TO')
    ├── trace through Promise to literal
    ├── trace multiple resolve values
    └── handle Promise without RESOLVES_TO
```

---

## Implementation Requirements Verified by Tests

Based on the failing tests, implementation must:

1. **In JSASTAnalyzer**:
   - Detect Promise executor callback in NewExpression handler
   - Track resolve/reject parameter names in context
   - Create RESOLVES_TO edges from resolve/reject CALL to CONSTRUCTOR_CALL
   - Ensure PASSES_ARGUMENT edges exist for resolve/reject arguments

2. **In traceValues.ts**:
   - Handle CONSTRUCTOR_CALL node type
   - Follow incoming RESOLVES_TO edges for Promise constructors
   - Continue tracing through resolve arguments

3. **In typeValidation.ts**:
   - Add RESOLVES_TO to known edge types

---

## Running the Tests

```bash
# Run just this test file
node --import tsx --test test/unit/analysis/promise-resolution.test.ts

# Expected: All tests fail (TDD red phase)
```

---

## Notes for Implementation

1. **CALL node IDs match**: When creating RESOLVES_TO edges, use the same ID generation as existing CALL node creation to ensure edge src matches the node.

2. **Context management**: Use Map keyed by function position (as per Joel's plan) for tracking Promise executor context.

3. **Nested callbacks**: The tests verify resolve() works from deeply nested callbacks - ensure getFunctionParent() walking is implemented correctly.

4. **Multiple resolves**: Each resolve() call should create its own RESOLVES_TO edge pointing to the same Promise CONSTRUCTOR_CALL.

---

**Tests ready for implementation. Proceed to Rob Pike.**

---

**Authored by:** Kent Beck (simulated)
**Date:** 2026-02-04
