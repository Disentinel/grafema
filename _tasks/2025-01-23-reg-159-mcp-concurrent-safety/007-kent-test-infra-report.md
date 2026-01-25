# Test Infrastructure Report: REG-159 MCP Concurrent Safety

**Author:** Kent Beck (Test Engineer)
**Date:** 2025-01-23
**Status:** Complete

---

## Summary

Created test infrastructure for the MCP package to support concurrency testing.
All 13 tests pass.

---

## Created Files

### 1. Directory Structure

```
packages/mcp/
├── test/
│   ├── mcp.test.ts              # Main test file with infrastructure tests
│   ├── helpers/
│   │   ├── MockBackend.ts       # In-memory backend mock
│   │   └── MCPTestHarness.ts    # Test harness for MCP handlers
│   └── fixtures/
│       └── minimal-project/
│           ├── package.json
│           └── index.js
```

### 2. MockBackend (`test/helpers/MockBackend.ts`)

In-memory mock backend implementing GraphBackend interface subset:

**Key Features:**
- `clearCallCount` - Tracks number of `clear()` calls (for concurrency verification)
- `clearCalled` - Boolean flag for clear() detection
- `analysisDelay` - Configurable delay for simulating slow analysis
- `initialNodeCount` - Pre-populate with mock nodes

**Methods Implemented:**
- `connect()`, `close()` - No-op for mock
- `clear()` - Clears storage, increments counters
- `nodeCount()`, `edgeCount()`
- `addNode()`, `getNode()`
- `countNodesByType()`, `countEdgesByType()`
- `queryNodes()` - AsyncGenerator with filter support
- `getOutgoingEdges()`, `getIncomingEdges()`
- `flush()` - No-op

### 3. MCPTestHarness (`test/helpers/MCPTestHarness.ts`)

Test harness for isolated handler testing:

**Key Features:**
- `analysisCallLog` - Array tracking all analysis calls with timestamps
- `simulateAnalysis(service?, force?)` - Simulates analysis with delay
- `getAnalysisStatus()` - Returns mock status (running computed from log)
- `reset()` - Clears all state between tests

**Tracked per Analysis Call:**
- `startTime` - When analysis began
- `endTime` - When analysis completed (undefined while running)
- `service` - Optional service filter
- `force` - Whether force flag was set

### 4. Minimal Test Fixture

`test/fixtures/minimal-project/`:
- `package.json` - Basic package.json
- `index.js` - Simple function export

### 5. Package.json Updates

Added test scripts:
```json
"test": "node --import tsx --test test/*.test.ts",
"test:watch": "node --import tsx --test --watch test/*.test.ts"
```

Added devDependency:
```json
"tsx": "^4.19.2"
```

### 6. Test File (`test/mcp.test.ts`)

Tests for infrastructure validation:

**MockBackend Tests (6 tests):**
- Initialize with default options
- Initialize with custom analysisDelay
- Initialize with initial nodes
- Track clear() calls
- Add and get nodes
- Return null for non-existent node

**MCPTestHarness Tests (6 tests):**
- Initialize with default values
- Initialize with custom options
- Reset state
- Simulate analysis
- Track force flag in analysis
- Return running status during analysis

**Placeholder Test (1 test):**
- Infrastructure ready indicator

---

## Test Results

```
# tests 13
# suites 4
# pass 13
# fail 0
# cancelled 0
# skipped 0
# duration_ms 1010.784969
```

---

## Design Decisions

### 1. Pattern Matching

Followed existing test patterns from:
- `packages/cli/test/cli.test.ts` - Test script format (`--import tsx`)
- `test/unit/GuaranteeAPI.test.ts` - Test structure (describe/it/beforeEach)
- `test/helpers/TestRFDB.js` - Backend helper pattern

### 2. MockBackend vs TestRFDB

Created separate MockBackend instead of using TestRFDB because:
- MockBackend is synchronous/fast (no real DB)
- `clearCallCount` tracking for concurrency tests
- `analysisDelay` for simulating slow operations
- No external dependencies (RFDB server)

TestRFDB can still be used for integration tests requiring real backend.

### 3. MCPTestHarness Design

The harness tracks analysis calls rather than implementing full handler logic because:
- Simpler to understand and maintain
- Focuses on what we need to verify (call timing, force flag, clear count)
- Actual handler integration will be added when implementing concurrency fix

---

## Ready for Next Phase

The infrastructure is ready for:
1. **Task #2:** Writing concurrency tests that verify serialization behavior
2. **Task #3-4:** Implementing analysis lock (tests will initially fail, then pass after fix)

---

## Notes for Rob Pike (Implementation)

When implementing the concurrency fix:

1. The `MCPTestHarness.simulateAnalysis()` can be extended to:
   - Accept a lock acquire function
   - Track lock acquisition order

2. Tests to add in next phase:
   - Concurrent calls serialization (second waits for first)
   - Force=true during analysis returns error
   - `clearCallCount === 1` even with concurrent force calls
   - Worker coordination (MCP clears, not worker)
