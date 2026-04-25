# REG-254: Kent Beck - Test Report

## Summary

Created TDD tests for REG-254 shared query utilities. Tests are written BEFORE implementation per Kent Beck methodology.

## Files Created

### 1. `packages/core/test/unit/queries/findCallsInFunction.test.ts`

Tests for finding CALL and METHOD_CALL nodes within a function scope.

**Test Groups:**

1. **Direct calls (6 tests)**
   - Finding CALL nodes in function scope
   - Finding METHOD_CALL nodes in function scope
   - Not entering nested functions
   - Handling nested scopes (if blocks, loops)
   - Returning empty array for function with no calls
   - Finding both CALL and METHOD_CALL nodes

2. **Resolution status (3 tests)**
   - Marking calls with CALLS edge as resolved=true
   - Marking calls without CALLS edge as resolved=false
   - Handling mix of resolved and unresolved calls

3. **Transitive mode (6 tests)**
   - Following resolved CALLS edges when transitive=true
   - Adding depth field for transitive calls
   - Stopping at transitiveDepth limit
   - Handling recursive functions (A calls A)
   - Handling cycles (A calls B calls A)
   - Returning only direct calls when transitive=false

4. **Edge cases (5 tests)**
   - Handling function without HAS_SCOPE edge
   - Handling non-existent function ID
   - Handling multiple scopes
   - Not entering nested classes

### 2. `packages/core/test/unit/queries/findContainingFunction.test.ts`

Tests for finding the containing FUNCTION, CLASS, or MODULE for a node.

**Test Groups:**

1. **Basic containment (4 tests)**
   - Finding parent FUNCTION for a CALL node
   - Handling multiple scope levels
   - Returning null when no container found
   - Returning null for orphaned node

2. **Container types (3 tests)**
   - Finding CLASS as container
   - Finding MODULE as container
   - Preferring closest FUNCTION container

3. **Edge cases (7 tests)**
   - Returning null for non-existent node ID
   - Handling deep nesting within maxDepth
   - Returning null when maxDepth exceeded
   - Handling anonymous function with default name
   - Handling cycles in graph without infinite loop
   - Finding container for METHOD_CALL node
   - Finding container for VARIABLE node

4. **Complex hierarchies (2 tests)**
   - Finding innermost function container
   - Traversing through try-catch scopes

## Supporting Files Created

### 3. `packages/core/src/queries/types.ts`

Shared types used by query utilities:
- `CallInfo` - Information about a function/method call
- `CallerInfo` - Information about a calling function
- `FindCallsOptions` - Options for findCallsInFunction

### 4. `packages/core/src/queries/findCallsInFunction.ts`

Stub implementation (returns empty array). TDD - implementation comes after tests.

### 5. `packages/core/src/queries/findContainingFunction.ts`

Stub implementation (returns null). TDD - implementation comes after tests.

### 6. `packages/core/src/queries/index.ts`

Public exports for the queries module.

## Test Results (TDD - Expected Failures)

```
# tests 35
# suites 10
# pass 7
# fail 28
```

- **7 tests pass** - Edge cases that expect empty/null returns (stub implementation)
- **28 tests fail** - Main functionality tests (implementation not done yet)

This is the expected TDD behavior: tests fail first, implementation makes them pass.

## Running the Tests

```bash
node --import tsx --test packages/core/test/unit/queries/*.test.ts
```

## Test Design Principles

1. **Uses node:test** (not Jest) per project standards
2. **Mocks GraphBackend interface** with minimal in-memory implementation
3. **Tests are fast** - no real DB operations
4. **Each test tests ONE thing** - single assertion focus
5. **Test names communicate intent** - readable descriptions
6. **WHY comments** explain the reasoning for each test

## Mock Backend Pattern

Created a minimal `MockGraphBackend` class that implements only the required interface:

```typescript
interface GraphBackend {
  getNode(id: string): Promise<MockNode | null>;
  getOutgoingEdges(nodeId: string, edgeTypes: string[] | null): Promise<MockEdge[]>;
  getIncomingEdges(nodeId: string, edgeTypes: string[] | null): Promise<MockEdge[]>;
}
```

This allows testing without RFDBServerBackend dependency.

## Next Steps

Implementation engineer (Rob Pike) should:
1. Read these tests to understand requirements
2. Implement `findCallsInFunction.ts` to make tests pass
3. Implement `findContainingFunction.ts` to make tests pass
4. Run tests to verify implementation

---

*Kent Beck, Test Engineer*
*REG-254: Variable tracing stops at function call boundaries*
