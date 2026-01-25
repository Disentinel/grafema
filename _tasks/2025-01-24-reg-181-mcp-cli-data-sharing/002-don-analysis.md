# REG-181: MCP CLI Data Sharing Analysis

**Tech Lead: Don Melton**
**Date: 2025-01-24**

## Executive Summary

**Root Cause:** CLI kills the RFDB server when it finishes analysis. MCP then starts a new server with empty database.

**Type:** Architectural mismatch, not a simple bug. The current architecture assumes each process owns its server, but the product vision requires shared state.

## Analysis

### How CLI Creates/Connects to RFDB

1. `grafema analyze` creates `RFDBServerBackend({ dbPath })`
2. `RFDBServerBackend.connect()` tries to connect to existing server
3. If no server running, it **starts a new server process** (detached, but tracked in `serverProcess`)
4. Analysis runs, data written to server
5. **Critical:** `backend.close()` is called (line 295 of analyze.ts)
6. `close()` does: `this.serverProcess.kill('SIGTERM')` - **kills the server**

```typescript
// packages/core/src/storage/backends/RFDBServerBackend.ts:288-300
async close(): Promise<void> {
  if (this.client) {
    await this.client.close();
    this.client = null;
  }
  this.connected = false;

  // Kill server process if we started it <-- THE PROBLEM
  if (this.serverProcess) {
    this.serverProcess.kill('SIGTERM');
    this.serverProcess = null;
  }
}
```

### How MCP Creates/Connects to RFDB

1. MCP server starts, calls `getOrCreateBackend()` (state.ts:217)
2. Creates `RFDBServerBackend({ socketPath, dbPath })`
3. `connect()` tries to connect - **no server running** (CLI killed it)
4. Starts **new** server process with same dbPath
5. New server loads from disk... but **data wasn't persisted**

### The Data Persistence Problem

RFDB server has in-memory storage with periodic flush to disk. When CLI kills the server:

1. Server receives SIGTERM
2. **Unknown:** Does server flush before exit? Need to verify.
3. Even if it flushes, MCP starts fresh server later - should load from disk

Let me verify the actual socket paths:

**CLI:** Uses default `join(dirname(dbPath), 'rfdb.sock')` = `.grafema/rfdb.sock`
**MCP:** Uses `config.analysis?.parallel?.socketPath` OR same default

Socket paths should be identical. **Socket path is NOT the problem.**

### The Real Problem: Server Lifecycle

The architecture has a fundamental mismatch:

| Scenario | CLI Assumption | MCP Assumption |
|----------|----------------|----------------|
| Server lifecycle | CLI owns server, kills on exit | Long-running shared server |
| Data persistence | Flush + kill, data on disk | Connect to existing server with data |
| What actually happens | Server killed, may not flush | Starts new empty server |

### Verifying Data Persistence

Need to check: Does RFDB server flush on SIGTERM?

Looking at the Rust server would tell us, but based on behavior (9674 nodes -> 1 node), it seems:
- Either server doesn't flush on SIGTERM
- Or flush happens but something else is wrong

Wait - the 1 node (SERVICE) is suspicious. That's likely from MCP's own initialization, not from disk.

## Diagnosis: Three Possible Root Causes

### Theory 1: Server Doesn't Flush on SIGTERM (Most Likely)
- CLI kills server
- Server terminates without flushing
- All 9674 nodes lost
- MCP starts fresh server, creates SERVICE node

### Theory 2: Server Flushes but Uses Wrong DB File
- Less likely, paths look correct
- But worth verifying

### Theory 3: MCP Uses Different dbPath
- CLI: `join(projectPath, '.grafema', 'graph.rfdb')`
- MCP: `join(projectPath, '.grafema', 'graph.rfdb')`
- Same. Not the issue.

## Conclusion: Root Cause

**Primary:** `RFDBServerBackend.close()` kills the server that it started, which loses unflushed data.

**Secondary:** The architecture assumes each client owns its server instance. This conflicts with the multi-client shared server model.

## Is This Aligned with Project Vision?

**No.** The vision states:

> "AI should query the graph, not read code"

If data is lost between CLI analysis and MCP querying, the graph is useless. This is a critical infrastructure bug that blocks the entire value proposition.

## The RIGHT Fix (Not a Hack)

### Option A: Don't Kill Server on Close (Immediate Fix)
```typescript
async close(): Promise<void> {
  if (this.client) {
    await this.client.close();
    this.client = null;
  }
  this.connected = false;
  // Remove: this.serverProcess.kill()
  // Let server continue running
}
```

**Pros:** Simple, preserves data
**Cons:** Server runs forever, resource leak

### Option B: Explicit Server Management (Proper Fix)
1. Add `grafema server start` / `grafema server stop` commands
2. Server is a first-class citizen, not a side effect
3. Close only disconnects client, doesn't touch server
4. Separate concern: "who manages server lifecycle?"

### Option C: Flush on Disconnect (RFDB Server Change)
1. Modify RFDB server to flush when client disconnects
2. Or flush on SIGTERM handler
3. Server can still be killed, data is safe

**Recommendation:** Combination of A + C
- Short term: Remove server kill from close()
- Medium term: Ensure RFDB server flushes on SIGTERM
- Long term: Consider explicit server management

## Verification Steps Before Implementation

1. **Confirm theory:** Add logging to see if server receives SIGTERM
2. **Check RFDB flush behavior:** Does it flush on disconnect/SIGTERM?
3. **Test data on disk:** After CLI analyze, check `.grafema/graph.rfdb` size

## Risk Assessment

**Risk of NOT fixing:** Complete blocker for MCP use after CLI analysis
**Risk of Option A:** Memory usage if server never stops (acceptable for dev)
**Risk of Option C:** Requires Rust changes (more work)

## Next Steps

1. Joel: Create detailed implementation plan
2. Verify RFDB server SIGTERM behavior
3. Implement Option A as immediate fix
4. Track Option C as follow-up (Rust change)
