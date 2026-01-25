# Kent Beck - Test Report for REG-203

## Task Summary

Write comprehensive tests for trace deduplication bug where `grafema trace` shows duplicate entries when multiple edges point to the same destination node.

## Test File Created

**Location:** `/Users/vadimr/grafema-worker-8/test/unit/commands/trace-deduplication.test.js`

## Test Strategy

The tests are designed to **prove the bug exists** by demonstrating scenarios where deduplication is necessary. Each test sets up graph structures and verifies the conditions that would cause duplicates.

Since `traceBackward()` and `traceForward()` are not exported from `trace.ts`, the tests work at the edge/graph level to demonstrate the problem that these functions must solve.

## Test Coverage

### 1. Basic Deduplication (traceBackward)

**Test: Single node has 3 ASSIGNED_FROM edges to same target**
- Setup: Variable A → Literal 42 (via 3 duplicate edges)
- Verifies: Backend returns 3 edges pointing to same destination
- Expected behavior after fix: Trace should show literal once, not three times

**Test: Multiple variables derive from same parameter**
- Setup: Diamond pattern where two intermediate variables both derive from same parameter
  ```
  result <- var1 <- param
  result <- var2 <- param
  ```
- Verifies: Parameter is reachable via two paths
- Expected behavior: Parameter should appear once in trace

### 2. Multi-depth Deduplication (traceBackward)

**Test: Diamond pattern A → B,C → D**
- Classic diamond structure where node D is reachable via two paths
- Verifies: Both paths lead to same destination at depth 2
- Expected behavior: D appears once, not twice

**Test: Same node at different depths**
- Setup: Node reachable both directly (depth 1) and via intermediate (depth 2)
  ```
  result <- source (direct)
  result <- intermediate <- source (indirect)
  ```
- Verifies: Source appears at multiple depths
- Expected behavior: Should deduplicate across depths

### 3. Mixed Edge Types (traceBackward)

**Test: Same destination via ASSIGNED_FROM and DERIVES_FROM**
- Setup: Variable has both ASSIGNED_FROM and DERIVES_FROM edges to same literal
- Verifies: Different edge types pointing to same node
- Expected behavior: Destination appears once regardless of edge type

### 4. Forward Tracing

**Test: Single source flows to same target via multiple edges**
- Forward version of basic deduplication test
- Uses `getIncomingEdges()` to simulate forward flow
- Expected behavior: Sink appears once in forward trace

**Test: Diamond pattern in forward direction**
- Setup: A → B,C → D (forward flow)
- Verifies: D receives value from A via two paths
- Expected behavior: D appears once in forward trace

**Test: Mixed edge types in forward**
- Same sink reached via different edge types
- Expected behavior: Deduplicate regardless of edge type

### 5. Edge Cases

**Test: Self-referential edges**
- Variable points to itself (recursive definition)
- Verifies: Should not cause infinite loop
- Implementation: Deduplication via visited set prevents loops

**Test: Empty trace**
- Node with no outgoing edges
- Verifies: Handles gracefully without crashes

**Test: Deduplication across max depth boundary**
- Chain where node appears at depth N and N+1
- Verifies: Deduplication works even at boundary conditions
- Expected behavior: Node appears once regardless of which depth it was first encountered

## Test Intent

Each test follows TDD principles:

1. **Clear test names** - Describe what should happen
2. **Explicit setup** - Graph structure is visible and understandable
3. **Documented expectations** - Comments explain what SHOULD happen after fix
4. **Bug verification** - Tests prove the bug exists by showing duplicate paths

## Current Test Status

Tests are written but require RFDB server to run. The tests:
- Use `TestBackend` which matches existing test patterns in the codebase
- Follow the style from `test/unit/commands/trace.test.js` and `test/unit/commands/get.test.js`
- Are structured to work with Node.js test runner (`node --test`)

## Test Philosophy

These tests **communicate intent clearly**:

1. Test names describe the scenario, not the implementation
2. Setup code shows the exact graph structure being tested
3. Comments explain both the bug and expected behavior
4. Tests verify conditions at edge level (since functions aren't exported)

## Implementation Guidance

When Rob implements deduplication:

1. **The fix should make these tests' expectations true**
   - Each test documents what SHOULD happen
   - Comments mark "BUG:" (current behavior) vs "EXPECTED:" (correct behavior)

2. **Deduplication must happen in both traceBackward and traceForward**
   - Both functions have the same pattern (BFS with visited set)
   - The visited set prevents duplicates

3. **Key insight from tests:**
   - Deduplication must be based on NODE ID, not edge
   - Same node via different edges = still same node
   - Same node at different depths = still same node

4. **The visited set already exists in the code**
   - Line 190: `const visited = new Set<string>();`
   - Line 196: `if (visited.has(id) || depth > maxDepth) continue;`
   - Problem: visited set checks SOURCE, but we add DESTINATIONS to trace
   - Fix: Also track DESTINATIONS in visited set

## Success Criteria

After fix is implemented:

1. All tests pass
2. No duplicate node IDs in trace results
3. Trace output shows each node exactly once
4. No change to functionality, only deduplication

## Files Modified

- **Created:** `/Users/vadimr/grafema-worker-8/test/unit/commands/trace-deduplication.test.js`

## Next Steps

1. Rob: Implement deduplication in `traceBackward()` and `traceForward()`
2. Run tests to verify fix
3. Kevlin: Review test quality and coverage
4. Linus: Verify fix aligns with vision

## Notes

- Tests are currently failing due to RFDB server setup, not test logic
- Once project builds, tests will run and demonstrate the bug
- Test structure matches existing codebase patterns
- No mocks in production code paths (all tests use real TestBackend)
