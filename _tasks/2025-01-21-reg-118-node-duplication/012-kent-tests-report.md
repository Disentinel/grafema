# Kent Beck: Test Report for REG-118 Clear-and-Rebuild

**Date:** 2025-01-22
**Task:** REG-118 Node Duplication Fix - Test Implementation

---

## Summary

Tests written **FIRST** as per TDD discipline. All tests currently **FAIL**, which is correct behavior - they prove the bug exists. Tests will PASS once the clear-and-rebuild implementation is complete.

**Test file:** `/Users/vadimr/grafema/test/unit/ClearAndRebuild.test.js`

---

## Test Coverage

### Core Requirements (from Technical Spec)

| # | Test Case | Status | Description |
|---|-----------|--------|-------------|
| 1 | Idempotency | FAILING | Re-analysis produces identical graph |
| 2 | Node count stability | FAILING | Repeated analysis doesn't increase node count |
| 3 | MODULE preservation | FAILING | MODULE nodes (from Indexer) survive clear |
| 4 | Cross-file edges | FAILING | Edges between files recreated correctly |
| 5 | Modified file | FAILING | Changing a file updates graph correctly |
| 6 | Deleted code | FAILING | Removing a function removes its node |

### Linus Additions

| # | Test Case | Status | Description |
|---|-----------|--------|-------------|
| 7 | EXTERNAL_MODULE survival | FAILING | External module nodes not deleted/duplicated |
| 8 | Singleton survival (net:stdio) | FAILING | net:stdio singleton not affected |
| 8b | Singleton survival (net:request) | FAILING | net:request singleton not affected |

### Additional Edge Cases

| # | Test Case | Description |
|---|-----------|-------------|
| 9 | Empty file | Empty file produces stable node count |
| 10 | File with only imports | Import-only file is stable |
| 11 | Multiple files | Multiple files analyzed together are stable |
| 12 | Class declarations | Classes don't duplicate on re-analysis |
| 13 | TypeScript interfaces | Interfaces don't duplicate on re-analysis |
| 14 | Variable deletion | Variables properly removed when deleted |

---

## Test Design Decisions

### 1. New Orchestrator Per Analysis

Each re-analysis creates a **new Orchestrator instance** to simulate real CLI usage:

```javascript
// First analysis
const orchestrator1 = createForcedOrchestrator(backend);
await orchestrator1.run(testDir);

// Second analysis with NEW orchestrator (simulates CLI invocation)
const orchestrator2 = createForcedOrchestrator(backend);
await orchestrator2.run(testDir);
```

**Why:** In production, each `grafema analyze` CLI call creates a new Orchestrator. The JSASTAnalyzer has instance-level caching (`analyzedModules` set) that would hide the bug if we reused the same instance.

### 2. forceAnalysis: true

All tests use `forceAnalysis: true` to bypass content-hash caching:

```javascript
function createForcedOrchestrator(backend) {
  return createTestOrchestrator(backend, { forceAnalysis: true });
}
```

**Why:** Without this, the second analysis would be skipped due to hash caching, hiding the duplication bug.

### 3. Separate Backend Per Test

The `beforeEach` hook creates a fresh backend for each test:

```javascript
beforeEach(async () => {
  if (backend) {
    await backend.cleanup();
  }
  backend = createTestBackend();
  await backend.connect();
});
```

**Why:** Ensures test isolation. Each test starts with an empty graph.

---

## Current Test Output (Failing)

The first test demonstrates the bug clearly:

```
Node count should not change on re-analysis. First: 6, Second: 12
```

- First analysis: 6 nodes created
- Second analysis: 12 nodes (doubled!)

This proves:
1. The tests correctly detect the duplication bug
2. The clear-and-rebuild implementation is not yet working

---

## Test Patterns Used

### 1. Count Comparison Pattern

```javascript
const nodeCount1 = state1.nodes.length;
await orchestrator2.run(testDir);
const nodeCount2 = state2.nodes.length;
assert.strictEqual(nodeCount2, nodeCount1, 'Count should not change');
```

### 2. ID Preservation Pattern

```javascript
const moduleIds1 = modules1.map(m => m.id).sort();
await orchestrator2.run(testDir);
const moduleIds2 = modules2.map(m => m.id).sort();
assert.deepStrictEqual(moduleIds2, moduleIds1, 'IDs should be preserved');
```

### 3. Deletion Verification Pattern

```javascript
const barNode = fns2.find(f => f.name === 'bar');
assert.ok(!barNode, 'bar should have been deleted');
```

---

## Running the Tests

```bash
# Run clear-and-rebuild tests
node --test test/unit/ClearAndRebuild.test.js

# Run with verbose output
node --test --test-reporter spec test/unit/ClearAndRebuild.test.js
```

---

## Definition of Done

Tests are COMPLETE when:

- [x] Test file created at `/Users/vadimr/grafema/test/unit/ClearAndRebuild.test.js`
- [x] All 8 required test cases from spec implemented
- [x] Linus's additional tests (EXTERNAL_MODULE, singletons) implemented
- [x] Tests FAIL initially (proving bug exists) - **CONFIRMED**
- [ ] Tests PASS after implementation (pending Rob's work)

---

## Notes for Rob (Implementation)

The tests reveal that the current `_clearFileNodes` implementation in GraphBuilder exists but is not being called effectively. Key observations:

1. **Double Node Creation:** Nodes are being created twice (6 -> 12), indicating clear is not happening
2. **MODULE Duplication:** Even MODULE nodes are being duplicated, suggesting either:
   - The clear is not being called at all, OR
   - The clear is happening after indexing but the indexer is also duplicating

**Recommendation:** Verify that `_clearFileNodes` is being called at the start of `build()` and that it's actually deleting nodes.

---

**Test Engineer:** Kent Beck
**Date:** 2025-01-22
