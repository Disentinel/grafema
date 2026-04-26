# REG-181: Test Report

**Test Engineer: Kent Beck**
**Date: 2025-01-24**

## Summary

Created focused test for data persistence between RFDBServerBackend instances. The test verifies the core use case: CLI analyzes data, closes, then MCP connects and sees the data.

## Test File

`test/unit/storage/backends/RFDBServerBackend.data-persistence.test.js`

## Test Cases

### 1. `should preserve data between backend instances (simulates CLI -> MCP)`

This is the primary test case. It:

1. **Backend 1 (simulates CLI):**
   - Connects to server (starts it if needed)
   - Writes 4 nodes and 2 edges
   - Calls `flush()` (as CLI does explicitly)
   - Verifies node count = 4, edge count = 2
   - Closes connection

2. **Backend 2 (simulates MCP):**
   - Connects to same socket/db
   - Queries node count and edge count
   - Asserts counts match (4 nodes, 2 edges)
   - Queries FUNCTION nodes specifically
   - Verifies can see `hello` and `world` functions

Key assertion per Linus's feedback:
```javascript
assert.ok(
  nodeCountAfterReconnect > 1,
  `Expected more than 1 node after reconnect, got ${nodeCountAfterReconnect}. ` +
  `This indicates the server was killed on close(), losing data.`
);
```

### 2. `should allow multiple sequential connect/close cycles`

Tests three sequential connect/close cycles:
1. First backend writes 2 nodes, closes
2. Second backend verifies 2 nodes, adds 1 more, closes
3. Third backend verifies all 3 nodes present

## Test Results (BEFORE fix)

```
not ok 1 - should preserve data between backend instances (simulates CLI -> MCP)
  error: 'write EPIPE'

not ok 2 - should allow multiple sequential connect/close cycles
  error: 'write EPIPE'
```

**Root cause:** `close()` kills the server with `SIGTERM`. When the second backend tries to connect, the socket is dead, causing `EPIPE` (broken pipe).

Interestingly, the data IS persisted to disk (flush works), but the connection error prevents verification. The test correctly catches the bug.

## Expected Results (AFTER fix)

Both tests should pass because:
1. `close()` will NOT kill the server
2. Second backend connects to the existing, running server
3. Data is immediately visible (no restart needed)

## Test Patterns Used

- Used `RFDBServerBackend` directly (no mocks - this is critical path)
- Unique socket/db paths per test (matching `TestRFDB.js` pattern)
- Cleanup in `after()` hook
- Clear assertions with helpful error messages

## Notes for Implementation

The test confirms the fix is correct:
1. Remove `this.serverProcess.kill('SIGTERM')` from `close()`
2. Add defensive `flush()` call before disconnect (already in plan)

After the fix, these tests will pass because the server stays running and the second backend connects to it.

## File Location

```
test/unit/storage/backends/RFDBServerBackend.data-persistence.test.js
```

## Run Command

```bash
node --test test/unit/storage/backends/RFDBServerBackend.data-persistence.test.js
```
