# Don Melton - Analysis and Plan for REG-189

## Current State Analysis

### How RFDB Server Works Now

**Architecture Overview:**
- `rfdb-server` is a Rust binary (`rust-engine/src/bin/rfdb_server.rs`)
- Communicates via Unix socket using MessagePack protocol
- Multiple clients can connect to the same server instance
- Server persists after clients disconnect (since REG-181)

**Server Lifecycle:**
1. `RFDBServerBackend.connect()` tries to connect to existing server at socket path
2. If no server running, `_startServer()` spawns `rfdb-server` with `detached: true` and `unref()`
3. Server runs until explicitly killed or receives `Shutdown` command
4. `backend.close()` only closes the client connection, NOT the server

**Key Paths:**
- Socket: `.grafema/rfdb.sock` (per-project, next to database)
- Database: `.grafema/graph.rfdb`
- No PID file currently exists

**Existing Shutdown Mechanism:**
- `RFDBClient.shutdown()` method exists (line 564-571 in `packages/rfdb/ts/client.ts`)
- Sends `Request::Shutdown` to server
- Server handles it by calling `std::process::exit(0)` (line 667-669 in `rfdb_server.rs`)
- This is a clean shutdown - server responds "ok" then exits

**Current Pain Point:**
- No way to discover/manage orphan servers
- No visibility into running server state
- No PID tracking for external management

## Where Changes Should Be Made

### Files to Create

1. **`packages/cli/src/commands/server.ts`** - New command file
   - Contains `grafema server` command with subcommands
   - Follows Commander.js pattern from other commands

### Files to Modify

1. **`packages/cli/src/cli.ts`** - Register the new `server` command

### Files to Leave Alone

- `RFDBServerBackend.ts` - No changes needed, shutdown already works via client
- `rfdb_server.rs` - Already handles Shutdown command correctly
- `RFDBClient.ts` - Already has `shutdown()` method

## High-Level Approach

### Command Structure

```bash
grafema server start   # Start detached server for current project
grafema server stop    # Stop server gracefully via shutdown command
grafema server status  # Show server status
```

### `grafema server start`

**Approach:**
1. Resolve project path and derive socket/db paths
2. Check if server already running (try to ping socket)
3. If running, print status and exit
4. If not running, use existing `RFDBServerBackend._startServer()` logic
5. Optionally write PID file to `.grafema/rfdb.pid` for tracking

**Key decisions:**
- Reuse existing `_findServerBinary()` logic from RFDBServerBackend
- Use `spawn()` with `detached: true` and `unref()` (existing pattern)
- Server should be started via the CLI command, not by importing the full backend

### `grafema server stop`

**Approach:**
1. Connect to server via socket
2. Call `client.shutdown()` - this sends the Shutdown command
3. Server will flush data and exit cleanly
4. Clean up PID file if present

**Key insight:** We already have `RFDBClient.shutdown()` method - just need to expose it via CLI.

### `grafema server status`

**Approach:**
1. Check if socket file exists
2. Try to connect and ping
3. If successful: print "running" + socket path + node/edge counts
4. If socket exists but can't connect: print "stale socket" (server crashed)
5. If no socket: print "not running"

**Optional enhancement:**
- Read PID file if present and show PID
- Could use `kill(pid, 0)` to verify process exists (but socket ping is more reliable)

## Implementation Notes

### Reusing Existing Code

The tricky part is that `_startServer()` and `_findServerBinary()` are private methods in `RFDBServerBackend`. Options:

**Option A (Recommended):** Extract server management into a separate module
- Create `packages/cli/src/utils/rfdbServer.ts`
- Move server discovery and start logic there
- Import in both CLI command and (optionally) refactor RFDBServerBackend

**Option B:** Make the methods public/protected in RFDBServerBackend
- Quick but couples CLI to backend internals

**Option C:** Duplicate the logic in CLI command
- Violates DRY but keeps changes minimal

I recommend Option A for clean separation.

### PID File Consideration

PID files are traditional but have issues:
- Can become stale if server crashes
- Requires cleanup on shutdown
- Socket ping is more reliable than PID check

**Decision:** Socket-based detection is primary. PID file is optional metadata for visibility.
- Write PID to `.grafema/rfdb.pid` on start
- Read it for `status` display, but don't rely on it for detection
- Clean up on `stop` (best effort)

### Error Handling

- `start`: If server already running, report success (idempotent)
- `stop`: If server not running, report success (idempotent)
- `status`: Always succeeds, reports current state

## What NOT To Do (Scope Limits)

1. **Don't add SIGTERM signal handling to server** - That's a separate issue (REG-190)
2. **Don't modify the wire protocol** - Shutdown command already exists
3. **Don't add daemon mode / systemd support** - Out of scope
4. **Don't add auto-restart or health checks** - Out of scope
5. **Don't make server management required** - Other commands should continue to auto-start server as needed

## Test Strategy

1. Unit tests for `rfdbServer.ts` utility module (mock spawn)
2. Integration tests:
   - `start` when no server running
   - `start` when server already running (idempotent)
   - `stop` when server running
   - `stop` when server not running (idempotent)
   - `status` in all states

## Summary

This is a straightforward feature that mostly exposes existing functionality via CLI:
- Server start: Reuse existing spawn logic
- Server stop: Use existing `RFDBClient.shutdown()`
- Server status: Connect and ping

The main work is:
1. Creating the CLI command structure
2. Extracting server management utilities for reuse
3. Adding PID tracking for visibility (optional but useful)

This aligns with project vision: giving users explicit control over the server lifecycle while maintaining the multi-client architecture established in REG-181.
