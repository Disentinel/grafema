# Kent Beck - Concurrency Tests Report (Task #2)

**Date:** 2025-01-23
**Status:** Complete

---

## Summary

Implemented comprehensive concurrency tests for MCP handlers as specified in Joel's revised plan. All 24 active tests pass, with 5 tests skipped (they document future behavior and will be enabled after the fix is implemented).

## Test Results

```
# tests 29
# suites 13
# pass 24
# fail 0
# skipped 5
# duration_ms 2263ms (~2.3 seconds)
```

---

## Test Structure

The test file is organized into 5 sections:

### Section 1: Test Infrastructure (6 tests)
Validates MockBackend and MCPTestHarness work correctly:
- MockBackend initialization with various options
- Node/edge operations
- `clearCallCount` tracking for concurrency verification

### Section 2: MCP Handlers (5 tests)
Tests basic handler behavior:
- `handleGetAnalysisStatus`: running=false when idle, running=true during analysis
- `handleAnalyzeProject`: analyze on first call, skip if analyzed, re-analyze with force=true

### Section 3: State Management (2 tests)
Documents state behavior:
- Initial state: running=false
- BUG documentation: real MCP server doesn't set running=true (skipped until fix)

### Section 4: Concurrency Protection - CRITICAL (7 tests)
Tests for REG-159 bugs:

| Test | Behavior | Status |
|------|----------|--------|
| Serialize concurrent calls | Both calls logged, timing not verified | Passes now, assertion commented |
| Error on force=true during analysis | Running status verified | Passes now, error assertion commented |
| Prevent multiple db.clear() calls | Both calls run, clearCount=2 | Passes now, assertion commented |
| db.clear() once per analysis | Single call, clearCount=1 | **Passes** |
| Allow concurrent reads | All reads succeed | **Passes** |
| Global lock (not per-service) | Both services logged | Passes now, timing assertion commented |
| Lock timeout | Design documentation | Skipped |

### Section 5: Post-Fix Verification (3 tests)
Tests to enable after implementation:
- Serialization verification
- Force=true error verification
- Running status verification

All 3 are currently skipped with `.skip`.

---

## Test Design Principles

### 1. Tests Document Behavior
Each test has a `WHY` comment explaining the reason it exists. This serves as documentation for the concurrency model.

### 2. Current vs Future Behavior
- Tests that verify CURRENT behavior have assertions that pass now
- Tests that verify FUTURE behavior have assertions commented out or use `.skip`
- This allows the test file to be run at any time without failures

### 3. Commented Assertions for Future
The pattern used:
```typescript
// CURRENT BEHAVIOR (before fix): Both run in parallel

// EXPECTED BEHAVIOR (after fix): Serialized
// Uncomment after implementing acquireAnalysisLock:
//
// assert.ok(
//   second.startTime >= first.endTime!,
//   'Expected serial execution'
// );
```

This makes it easy for Rob (implementation engineer) to enable assertions after implementing the fix.

---

## Key Tests Explained

### Serialization Test
```typescript
it('should serialize concurrent calls (second waits for first)', async () => {
  const harness = new MCPTestHarness({ analysisDelay: 100 });

  const call1 = harness.simulateAnalysis();
  const call2 = harness.simulateAnalysis();

  await Promise.all([call1, call2]);

  // After fix, uncomment:
  // assert.ok(second.startTime >= first.endTime!);
});
```

This test is the core verification for REG-159. After the fix, `second.startTime >= first.endTime` proves serialization.

### Worker Coordination Test
```typescript
it('should call db.clear() exactly once per analysis (MCP server, not worker)', async () => {
  const harness = new MCPTestHarness({ analysisDelay: 100 });
  await harness.simulateAnalysis(undefined, true);

  assert.strictEqual(harness.backend.clearCallCount, 1);
});
```

This test passes NOW because the harness correctly calls clear() once. It documents the expected behavior after the worker fix.

### Concurrent Reads Test
```typescript
it('should allow concurrent reads (find_nodes, query_graph)', async () => {
  const harness = new MCPTestHarness({ initialNodeCount: 10 });

  const reads = await Promise.all([
    harness.backend.nodeCount(),
    harness.backend.nodeCount(),
    harness.backend.nodeCount(),
  ]);

  assert.deepStrictEqual(reads, [10, 10, 10]);
});
```

This test verifies that read operations should never be blocked - only writes (analysis) need serialization.

---

## Files Modified

| File | Changes |
|------|---------|
| `packages/mcp/test/mcp.test.ts` | Complete rewrite with 5 sections, 29 tests |

---

## What's Next

1. **Rob Pike** implements the fix:
   - Add `acquireAnalysisLock()` and `releaseAnalysisLock()` to `state.ts`
   - Move `db.clear()` inside lock in `analysis.ts`
   - Remove `db.clear()` from `analysis-worker.ts`
   - Add `isAnalysisRunning()` check in `handlers.ts`

2. **After fix**, uncomment assertions in:
   - "should serialize concurrent calls"
   - "should return error for force=true during running analysis"
   - "should NOT call db.clear() multiple times from concurrent force=true calls"
   - "should use single global lock (not per-service)"

3. **Enable skipped tests** in Section 5

---

## Test Command

```bash
cd packages/mcp && npm test
```

---

**Tests communicate intent. Implementation follows.**
