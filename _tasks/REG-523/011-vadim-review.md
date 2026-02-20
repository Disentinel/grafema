# REG-523: WebSocket Transport - Вадим auto Completeness Review

**Reviewer:** Вадим auto (Completeness)
**Date:** 2026-02-20
**Verdict:** REJECT

## Summary

The implementation is technically complete and well-executed (as Steve Jobs confirmed), BUT it fails ONE critical acceptance criterion: **Documentation is missing**.

The task explicitly required:
> - [ ] Documentation: "Web / Remote setup" section

This documentation does NOT exist in README.md or any user-facing documentation.

## Acceptance Criteria Check

### ✅ CLI Flag Works
**Criterion:** `rfdb-server ./graph.rfdb --socket /tmp/rfdb.sock --ws-port 7432` starts both transports

**Status:** COMPLETE
- `--ws-port` flag added to CLI parser (`rfdb_server.rs:2423-2437`)
- Port validation: rejects port 0 with clear error
- Help text updated in both `--help` and usage error paths
- WebSocket listener binds to `127.0.0.1:{port}`
- Both transports run simultaneously via `tokio::try_join!`

**Evidence:**
```rust
// packages/rfdb-server/src/bin/rfdb_server.rs:2423-2437
let ws_port: Option<u16> = args.iter()
    .position(|a| a == "--ws-port")
    .and_then(|i| args.get(i + 1))
    .map(|s| {
        match s.parse::<u16>() {
            Ok(0) => {
                eprintln!("[rfdb-server] ERROR: --ws-port 0 is not allowed (port must be 1-65535)");
                std::process::exit(1);
            }
            Ok(port) => port,
            Err(_) => {
                eprintln!("[rfdb-server] ERROR: Invalid --ws-port value '{}' (must be 1-65535)", s);
                std::process::exit(1);
            }
        }
    });
```

### ✅ VS Code Extension Connects
**Criterion:** VS Code web extension connects via `ws://localhost:7432`

**Status:** COMPLETE
- `packages/vscode/package.json`: Added `grafema.rfdbTransport` config (enum: "unix" | "websocket")
- `packages/vscode/package.json`: Added `grafema.rfdbWebSocketUrl` config (default: "ws://localhost:7474")
- `packages/vscode/src/grafemaClient.ts:93-123`: WebSocket connection logic implemented
- Creates `RFDBWebSocketClient`, connects, pings, validates response
- Clear error message if connection fails (tells user to start server with --ws-port)

**Evidence:**
```typescript
// packages/vscode/src/grafemaClient.ts:93-123
const config = vscode.workspace.getConfiguration('grafema');
const transport = config.get<string>('rfdbTransport') || 'unix';

if (transport === 'websocket') {
  const wsUrl = config.get<string>('rfdbWebSocketUrl') || 'ws://localhost:7474';
  this.setState({ status: 'connecting' });

  try {
    const wsClient = new RFDBWebSocketClient(wsUrl);
    await wsClient.connect();

    const pong = await wsClient.ping();
    if (!pong) {
      await wsClient.close();
      throw new Error('Server did not respond to ping');
    }

    this.client = wsClient;
    this.setState({ status: 'connected' });
    this.startWatching();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.setState({
      status: 'error',
      message: `WebSocket connection failed: ${message}\n\nMake sure rfdb-server is running with --ws-port flag.`,
    });
  }
  return;
}
```

### ✅ Protocol Identical
**Criterion:** Protocol is identical (same framing, same commands)

**Status:** COMPLETE
- **Unix socket:** 4-byte length prefix + MessagePack payload (unchanged)
- **WebSocket:** Raw MessagePack in binary frames (no length prefix, WebSocket handles framing)
- Both use same `RequestEnvelope`/`ResponseEnvelope` structs (`rfdb_server.rs:470-485`)
- Both converge to same `handle_request()` function
- Same command names (all 60+ graph operations)
- Same requestId echo-back mechanism
- WebSocket client forces protocol v2 (no streaming, consistent with design)

**Evidence from code:**
```rust
// rfdb_server.rs:2257-2270 (WebSocket)
let (request_id, request) = match rmp_serde::from_slice::<RequestEnvelope>(&msg) {
    Ok(env) => (env.request_id, env.request),
    Err(e) => {
        eprintln!("[rfdb-server] WebSocket client {} invalid MessagePack: {}", client_id, e);
        let envelope = ResponseEnvelope {
            request_id: None,
            response: Response::Error { error: format!("Invalid request: {}", e) },
        };
        if let Ok(resp_bytes) = rmp_serde::to_vec_named(&envelope) {
            let _ = timeout(WS_SEND_TIMEOUT, ws_write.send(Message::Binary(resp_bytes))).await;
        }
        continue;
    }
};
```

```typescript
// websocket-client.ts:119-151 (Client side)
protected async _send(
  cmd: RFDBCommand,
  payload: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RFDBResponse> {
  if (!this.connected || !this.ws) {
    throw new Error('Not connected to RFDB server');
  }

  return new Promise((resolve, reject) => {
    const id = this.reqId++;
    const request = { requestId: `r${id}`, cmd, ...payload };
    const msgBytes = encode(request);  // NO length prefix

    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`Request timed out: ${cmd} (${timeoutMs}ms)`));
    }, timeoutMs);

    this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    this.ws!.send(msgBytes);
  });
}
```

**Protocol equivalence verified:** Both transports send the same MessagePack-encoded command structures, receive the same response structures, just with different framing layers.

### ❌ Documentation Missing
**Criterion:** Documentation: "Web / Remote setup" section

**Status:** INCOMPLETE

**What's missing:**
- No section in README.md explaining how to start server with WebSocket
- No example of connecting VS Code web extension via WebSocket
- No explanation of when to use WebSocket vs Unix socket
- No mention of WebSocket transport in any user-facing documentation

**What exists (NOT sufficient):**
- Task reports in `_tasks/REG-523/` (NOT user-facing documentation)
- Code comments in implementation files (NOT user documentation)
- VS Code config descriptions in `package.json` (helpful but NOT documentation)

**What was required (from Linear issue):**
The acceptance criteria explicitly listed "Documentation: 'Web / Remote setup' section" as a checkbox item. This means user-facing documentation that explains:
1. How to start rfdb-server with WebSocket transport
2. How to configure VS Code extension to use WebSocket
3. When/why to use WebSocket (web environments, remote access, code-server)
4. Example URLs and port configuration

**Where it should be:**
- `README.md` — new section after "VS Code Extension" section
- OR `docs/setup.md` if setup documentation is split out
- OR inline in the "Quick Start" section if WebSocket is considered a primary use case

## Feature Completeness

**Status:** OK (minus documentation)

All acceptance criteria are met EXCEPT documentation:

1. ✅ Server starts both transports simultaneously
2. ✅ VS Code extension can connect via WebSocket
3. ✅ Protocol is identical (same commands, same semantics, different framing)
4. ❌ Documentation missing

## Test Coverage

**Status:** EXCELLENT

Tests are comprehensive and follow TDD principles:

### Locking Tests (STEP 2.5)
**File:** `packages/rfdb/ts/rfdb-client-locking.test.ts` (897 lines)
- Locks existing `RFDBClient` behavior BEFORE refactoring
- Tests constructor, state, framing, all key methods, batch operations, error handling
- Ensures refactoring doesn't break existing behavior

### WebSocket Unit Tests (STEP 3)
**File:** `packages/rfdb/ts/rfdb-websocket-client.test.ts` (570 lines)
- Unit tests for WebSocket client using mock WebSocket
- Tests connection, message encoding/decoding, timeout, error handling
- Tests all IRFDBClient methods call _send() with correct commands
- Tests batch state management
- NO server required (pure unit tests)

### Integration Tests (STEP 3)
**File:** `test/integration/rfdb-websocket.test.ts`
- End-to-end tests that spawn real rfdb-server with --ws-port
- Tests CRUD operations, error handling, concurrent requests
- Skipped if server binary not built (graceful degradation)

### Rust Tests
From implementation report:
- **Rust lib:** 614 pass, 0 fail
- **Rust protocol:** 60 pass, 0 fail
- **Rust crash recovery:** 9 pass, 0 fail

### JavaScript Tests
From implementation report:
- **TypeScript:** 2109 pass, 0 fail, 5 skipped, 22 todo

**Test quality verdict:** Tests cover happy path, error paths, edge cases, timeouts, concurrent requests, and framing correctness. NO test gaps.

## Commit Quality

**Status:** CANNOT VERIFY (no commits yet)

All changes are uncommitted:
- Modified files: 7 (Rust server, TypeScript client, VS Code extension, Cargo files)
- New files: 4 (base-client.ts, websocket-client.ts, 3 test files)

**Expected commit structure (from implementation report):**
1. Locking tests for RFDBClient
2. Extract BaseRFDBClient
3. Add WebSocket client
4. Add Rust server WebSocket support
5. Add VS Code extension WebSocket config
6. Add integration tests

**Missing:** Documentation commit (should have been part of implementation)

**Commit quality cannot be assessed until commits are created.**

## Edge Cases

Checked implementation for edge cases:

✅ **Port validation:** Port 0 rejected with clear error (no auto-assignment surprise)
✅ **Send timeout:** 60-second timeout protects against stalled clients
✅ **Serialization failure:** Fallback error response if main response can't be serialized
✅ **Connection cleanup:** `handle_close_database` called on disconnect
✅ **Concurrent requests:** requestId matching prevents response mixing
✅ **Invalid MessagePack:** Server sends error response, doesn't crash
✅ **Binary vs text frames:** Text frames logged and ignored (WebSocket spec allows both)
✅ **Close frame handling:** Breaks loop cleanly, no resource leak
✅ **Localhost-only binding:** WebSocket binds to 127.0.0.1 (no external exposure)

No edge cases missed.

## Scope Creep

**Status:** NONE

The implementation is laser-focused on the task requirements:
- Added WebSocket transport (minimal scope)
- Deferred streaming support (REG-524)
- Deferred WebSocket config/limits (REG-525)
- Deferred WebSocket security (REG-526)
- Deferred file split refactoring (tech debt, not blocking)

No features added that weren't requested. No "improvements" nobody asked for.

## Regression Risk

**Status:** LOW

1. **Unix socket transport unchanged:** All existing code paths preserved
2. **Base class extraction tested:** 897 lines of locking tests verify no behavior change
3. **All existing tests pass:** 2109 JS tests, 683 Rust tests, 0 failures
4. **Configuration-driven:** WebSocket is opt-in via config (default: unix socket)

Regression risk is minimal. The refactoring (base class extraction) is locked by comprehensive tests.

## Issues Summary

**BLOCKING issue (requires fix before APPROVE):**

1. **Missing documentation** - User-facing documentation required by acceptance criteria does not exist

**File locations checked:**
- `README.md` — NO WebSocket setup section
- `docs/` directory — NO setup documentation
- VS Code extension README — NOT checked (but should also mention WebSocket if it has setup docs)

**What needs to be added:**

```markdown
## Web / Remote Setup (WebSocket Transport)

For browser-based environments (VS Code web, code-server, Gitpod) or remote access scenarios, use WebSocket transport instead of Unix sockets.

### Start Server with WebSocket

```bash
rfdb-server ./path/to/graph.rfdb --socket /tmp/rfdb.sock --ws-port 7474
```

This starts BOTH transports:
- Unix socket at `/tmp/rfdb.sock` (for local CLI/MCP)
- WebSocket at `ws://127.0.0.1:7474` (for web/remote clients)

### Configure VS Code Extension

In VS Code settings (Cmd+, or Ctrl+,):

```json
{
  "grafema.rfdbTransport": "websocket",
  "grafema.rfdbWebSocketUrl": "ws://localhost:7474"
}
```

Or via UI: Search for "Grafema" → Set "RFDB Transport" to "websocket".

### When to Use WebSocket

- **VS Code web (vscode.dev)** - Unix sockets unavailable in browser
- **code-server / Gitpod** - Remote development environments
- **Browser clients** - When building web-based graph explorers
- **Remote access** - Connect to graph database on different machine (via SSH tunnel)

### Security Note

WebSocket binds to `127.0.0.1` only (localhost). For remote access, use SSH tunnel:

```bash
ssh -L 7474:127.0.0.1:7474 user@remote-server
```

Then connect to `ws://localhost:7474` locally.
```

This section should be added to README.md after the "VS Code Extension" section.

## Verdict

**REJECT** — Documentation is missing.

The implementation is complete, tested, and production-ready. BUT acceptance criteria explicitly required "Documentation: 'Web / Remote setup' section", which does not exist.

**What needs to be fixed:**
1. Add "Web / Remote Setup" section to README.md (see suggested content above)
2. Optionally: mention WebSocket in Quick Start if it's considered a primary use case

**Once documentation is added:**
- Feature completeness: ✅
- Test coverage: ✅
- Edge cases: ✅
- Scope: ✅
- Commits: (pending, will verify after docs commit)

**Estimated effort to fix:** 10-15 minutes (write section, add to README, commit)

---

## Additional Notes

1. **Default WebSocket port:** The implementation uses port `7474` in VS Code config default but task request example used `7432`. This is NOT a bug (both are valid), but consider documenting the recommended port in README for consistency.

2. **Integration test skip condition:** Integration tests skip gracefully if `rfdb-server` binary not built. This is good design (tests don't fail in CI before Rust build), but ensure CI pipeline builds Rust BEFORE running integration tests.

3. **Error message quality:** VS Code extension provides helpful error when WebSocket connection fails ("Make sure rfdb-server is running with --ws-port flag"). This is excellent UX.

4. **Protocol v2 forced:** WebSocket client forces protocol v2 (no streaming). This is documented in code comments and design decisions. When streaming is added (REG-524), ensure backward compatibility for clients that don't support v3.

5. **File size observation (from Steve review):** `rfdb_server.rs` is 4800+ lines. Steve correctly noted this is cosmetic, not architectural. Split into modules when adding third transport (HTTP/2?), not now.
