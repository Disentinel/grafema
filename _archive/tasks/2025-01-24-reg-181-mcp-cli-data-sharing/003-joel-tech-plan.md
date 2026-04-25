# REG-181: Technical Implementation Plan

**Implementation Planner: Joel Spolsky**
**Date: 2025-01-24**
**Based on: Don's analysis (002-don-analysis.md)**

## Summary

Implement **Option A** as immediate fix: remove server kill from `RFDBServerBackend.close()`. This allows the RFDB server to persist between CLI and MCP sessions, preserving analyzed data.

## The Change

### File: `packages/core/src/storage/backends/RFDBServerBackend.ts`

**Current code (lines 288-300):**
```typescript
async close(): Promise<void> {
  if (this.client) {
    await this.client.close();
    this.client = null;
  }
  this.connected = false;

  // Kill server process if we started it
  if (this.serverProcess) {
    this.serverProcess.kill('SIGTERM');
    this.serverProcess = null;
  }
}
```

**New code:**
```typescript
async close(): Promise<void> {
  // Request server flush before disconnecting
  if (this.client) {
    try {
      await this.client.flush();
    } catch {
      // Ignore flush errors on close - best effort
    }
    await this.client.close();
    this.client = null;
  }
  this.connected = false;

  // NOTE: We intentionally do NOT kill the server process.
  // The server continues running to serve other clients (MCP, other CLI invocations).
  // This is by design for multi-client architecture.
  // Server lifecycle is managed separately (system process, or manual grafema server stop).
  this.serverProcess = null;
}
```

### Key Changes:

1. **Remove `this.serverProcess.kill('SIGTERM')`** - server continues running
2. **Add flush before close** - ensure data is persisted before disconnect
3. **Clear serverProcess reference** - release our reference but don't kill
4. **Add documentation comment** - explain the intentional design

## Design Decisions

### Why flush() before close()?

Currently, CLI calls `backend.flush()` explicitly at line 228 of analyze.ts:
```typescript
await orchestrator.run(projectPath);
await backend.flush();  // <-- explicit flush
```

Adding flush in `close()` provides defense-in-depth:
- If caller forgets to flush, close() handles it
- Matches expected behavior: "close = save and exit"
- Flush is idempotent - calling twice is safe

### What about orphan server processes?

**Current behavior:** Server is killed on close, no orphans.

**New behavior:** Server continues running. This is intentional:
- Server serves multiple clients (CLI, MCP, future tools)
- Server eventually receives SIGTERM on system shutdown
- Server can be manually stopped via system signals

**For now (MVP fix):** Accept that server runs "forever" until:
1. System shutdown
2. User manually kills the process
3. Future: `grafema server stop` command (Option B from Don's analysis)

**Acceptable tradeoff:** Memory usage is minimal (~10MB per RFDB server). One server per project.

### What if server crashes?

No change from current behavior:
- Next `connect()` will detect dead socket
- Start new server automatically
- Reconnect

### Thread safety / race conditions?

Not a concern for this change:
- `close()` only affects the calling client
- Other clients connected to same server are unaffected
- Server handles concurrent connections already

## Implementation Steps

### Step 1: Modify close() method

Edit `packages/core/src/storage/backends/RFDBServerBackend.ts`:

1. Add flush() call before client.close()
2. Remove server kill
3. Add documentation comment

### Step 2: Verify existing tests pass

Run:
```bash
node --test test/helpers/TestRFDB.js  # Uses close()
node --test test/unit/ValueDomainAnalyzer.test.js  # Heavy backend usage
```

The tests should pass because:
- Each test uses unique socket/db paths (via TestRFDB helper)
- Server orphans in /tmp don't affect subsequent tests

### Step 3: Manual verification

**Test scenario: CLI analysis followed by MCP query**

```bash
# Terminal 1: Run CLI analysis
cd /path/to/test/project
rm -rf .grafema  # Clean start
grafema analyze

# Verify nodes created
# Should see output like "Nodes: 9674"

# Terminal 2: Start MCP and query
grafema mcp --project /path/to/test/project

# In MCP client (or via test):
# Call get_stats tool
# Should return same node count (9674), NOT 0 or 1
```

### Step 4: Add E2E test

Create test file: `test/e2e/cli-mcp-data-sharing.test.js`

```javascript
/**
 * E2E Test: CLI -> MCP Data Sharing
 *
 * Verifies that data from CLI analysis is visible to MCP server.
 * This is the core use case: analyze with CLI, query with MCP.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, execSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { RFDBServerBackend } from '@grafema/core';

const TEST_PROJECT = '/tmp/grafema-e2e-test-project';

describe('CLI to MCP Data Sharing', () => {
  before(() => {
    // Create minimal test project
    rmSync(TEST_PROJECT, { recursive: true, force: true });
    mkdirSync(join(TEST_PROJECT, 'src'), { recursive: true });

    // Create a simple JS file
    writeFileSync(
      join(TEST_PROJECT, 'src', 'index.js'),
      `
      function hello() {
        console.log("Hello");
      }
      module.exports = { hello };
      `
    );
  });

  after(() => {
    // Cleanup
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  it('should preserve data between CLI analyze and backend reconnect', async () => {
    const dbPath = join(TEST_PROJECT, '.grafema', 'graph.rfdb');

    // Step 1: Run CLI analyze
    execSync('npx grafema analyze', {
      cwd: TEST_PROJECT,
      stdio: 'pipe',
    });

    // Step 2: Connect with new backend instance (simulating MCP)
    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    // Step 3: Verify data is present
    const nodeCount = await backend.nodeCount();
    assert.ok(nodeCount > 0, `Expected nodes from CLI analysis, got ${nodeCount}`);

    // Step 4: Verify we can query specific node types
    const functions = [];
    for await (const node of backend.queryNodes({ nodeType: 'FUNCTION' })) {
      functions.push(node);
    }

    assert.ok(functions.length > 0, 'Should find FUNCTION nodes');

    await backend.close();
  });
});
```

## Verification Checklist

- [ ] Unit tests pass (especially those using backend.close())
- [ ] Manual test: CLI analyze -> new backend connect -> nodeCount > 0
- [ ] Manual test: CLI analyze -> MCP start -> get_stats shows same count
- [ ] No regression: Existing tests don't fail due to orphan servers

## Notes for Follow-up

**Option C (RFDB server flush on SIGTERM):**

Even with Option A, ensuring server flushes on SIGTERM is good defensive practice. Track as separate Rust improvement:

- Modify `rust-engine/rfdb-server/src/main.rs`
- Add SIGTERM handler that calls `db.flush()` before exit
- This protects against `kill -TERM <pid>` from user

**Option B (Explicit server management):**

Future enhancement:
- `grafema server start` - start server in background
- `grafema server stop` - gracefully stop server
- `grafema server status` - show if server is running

This gives users control over server lifecycle.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Server memory usage | Low | Low | ~10MB per server, one per project |
| Orphan processes | Medium | Low | Killed on system shutdown |
| Test interference | Low | Low | Each test uses unique paths |
| User confusion ("why is server running?") | Medium | Low | Document in FAQ |

## Estimated Time

- Implementation: 15 minutes
- Testing: 30 minutes
- Total: 45 minutes

This is a minimal, focused fix. No refactoring, no new features.
