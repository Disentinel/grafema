# REG-528: Dijkstra Plan Verification

**Edsger Dijkstra** (Plan Verifier) — 2026-02-20

## Verdict: REJECT

**Summary:** Don's plan has correct happy path but contains **5 critical gaps** in error handling and state management. The inline approach (Option B) concentrates too much complex error handling in a single method, making it fragile and hard to maintain.

---

## Completeness Analysis

### Table 1: Connection State Transitions

| Initial State | hello() Result | openDatabase() Result | Final State | Handled? |
|--------------|----------------|----------------------|-------------|----------|
| disconnected | success (v3) | success ("default") | connected | ✅ YES |
| disconnected | success (v3) | fail (DATABASE_NOT_FOUND) | error | ✅ YES |
| disconnected | success (v3) | fail (network error) | ? | ❌ GAP 1 |
| disconnected | success (v3) | fail (permission denied) | ? | ❌ GAP 1 |
| disconnected | success (v2 only) | N/A | ? | ❌ GAP 2 |
| disconnected | fail (network error) | N/A | ? | ❌ GAP 3 |
| disconnected | timeout | N/A | ? | ❌ GAP 3 |

**GAP 1: Non-DATABASE_NOT_FOUND errors from openDatabase()**

Don's plan catches **all errors** from `openDatabase()` and calls `listDatabases()`. What if the error is not "database doesn't exist" but:
- Network disconnection during openDatabase
- Server crash mid-request
- Permission denied
- Disk I/O error

**Current plan behavior:**
```typescript
try {
  await client.openDatabase('default', 'rw');
} catch (err) {
  // Assumes err is always DATABASE_NOT_FOUND
  const { databases } = await client.listDatabases();  // ← May fail too!
  await client.close();
  // ...
}
```

**Problem:** If `openDatabase()` fails with network error, calling `listDatabases()` will also fail. The error message will be misleading.

**Fix needed:** Check error type before calling `listDatabases()`:
```typescript
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);

  // Only list databases if this is a "not found" error
  if (!message.includes('not found') && !message.includes('DATABASE_NOT_FOUND')) {
    await client.close();
    throw err;  // Re-throw non-database-not-found errors
  }

  // Now safe to call listDatabases()
  const { databases } = await client.listDatabases();
  // ...
}
```

---

**GAP 2: Protocol version mismatch**

Don's plan calls `await client.hello(3)` without checking the response. What if:
- Server only supports protocol v2?
- Server returns `{ ok: false, error: "Unsupported protocol version" }`?

**Current plan:**
```typescript
await client.hello(3);  // ← No response capture, no error check
```

**Problem:** If server rejects v3, we continue to `openDatabase()` which will fail cryptically.

**Fix needed:**
```typescript
const helloResponse = await client.hello(3);
if (!helloResponse.ok) {
  await client.close();
  throw new Error(`Protocol negotiation failed: ${helloResponse.error || 'Unknown error'}`);
}
```

**Note:** Looking at base-client.ts:471-473, `hello()` returns `HelloResponse` which should have an `ok` field. We should check it.

---

**GAP 3: hello() failure handling**

Don's plan calls `hello(3)` right after ping, with no try-catch around it. If `hello()` throws:
- Network disconnection
- Server crash
- Timeout

**Current plan:**
```typescript
const pong = await client.ping();
if (!pong) { /* ... */ }

await client.hello(3);  // ← No try-catch, error bubbles to caller
```

**Problem:** The outer `try-catch` in `connect()` will catch this, but:
1. WebSocket branch has no try-catch around hello/openDatabase (lines 96-122)
2. Error message won't distinguish "hello failed" vs "openDatabase failed"

**Fix needed:** Wrap protocol negotiation in its own try-catch to provide clear error context:
```typescript
try {
  await client.hello(3);
} catch (err) {
  await client.close();
  throw new Error(`Protocol negotiation failed: ${err.message}`);
}

try {
  await client.openDatabase('default', 'rw');
} catch (err) {
  // ... database-specific error handling
}
```

---

### Table 2: Database Existence Scenarios

| "default" exists? | Other DBs exist? | listDatabases() result | Error message | Correct? |
|------------------|------------------|----------------------|---------------|----------|
| YES | N/A | N/A (not called) | N/A | ✅ YES |
| NO | NO | `{ databases: [] }` | "No graph databases found. Run \`grafema analyze\`" | ✅ YES |
| NO | YES (["test"]) | `{ databases: [...] }` | "Available: test" | ✅ YES |
| NO | YES (["a", "b", "c"]) | `{ databases: [...] }` | "Available: a, b, c" | ✅ YES |

**This table is complete.** ✅

---

### Table 3: WebSocket Branch Parity

| Feature | Unix Socket Branch | WebSocket Branch | Parity? |
|---------|-------------------|------------------|---------|
| ping() | ✅ YES (line 160) | ✅ YES (line 105) | ✅ |
| hello(3) | ✅ YES (proposed line 129) | ✅ YES (proposed line 181) | ✅ |
| openDatabase() | ✅ YES (proposed line 133) | ✅ YES (proposed line 182) | ✅ |
| Error handling | try-catch in `tryConnect()` caller | ❓ Inline try-catch | ❌ GAP 4 |

**GAP 4: WebSocket branch lacks database-specific error handling**

Don's plan for WebSocket mode (lines 164-196):
```typescript
try {
  const wsClient = new RFDBWebSocketClient(wsUrl);
  await wsClient.connect();

  const pong = await wsClient.ping();
  if (!pong) { /* ... */ }

  await wsClient.hello(3);
  await wsClient.openDatabase('default', 'rw');  // ← No database-specific error handling!

  this.client = wsClient;
  this.setState({ status: 'connected' });
  this.startWatching();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  this.setState({
    status: 'error',
    message: `WebSocket connection failed: ${message}`,  // ← Generic message
  });
}
```

**Problem:** WebSocket branch does NOT check for "database not found" or call `listDatabases()`. It shows generic "WebSocket connection failed" for all errors.

**Unix socket has separate error path:**
- `tryConnect()` throws error
- `connect()` catches it, shows specific message via `setState({ status: 'error', message })`

**WebSocket has inline try-catch** — no separation between "connection failed" and "database not found".

**Fix needed:** Extract database selection logic into shared helper:
```typescript
/**
 * Negotiate protocol and select database.
 * Throws specific errors for each failure mode.
 */
private async negotiateAndSelectDatabase(client: RFDBClient | RFDBWebSocketClient): Promise<void> {
  // Protocol negotiation
  try {
    await client.hello(3);
  } catch (err) {
    throw new Error(`Protocol negotiation failed: ${err.message}`);
  }

  // Database selection
  try {
    await client.openDatabase('default', 'rw');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Only list databases if this is a "not found" error
    if (!message.includes('not found') && !message.includes('DATABASE_NOT_FOUND')) {
      throw err;  // Re-throw other errors (network, permission, etc.)
    }

    // Check available databases
    const { databases } = await client.listDatabases();

    if (databases.length === 0) {
      throw new Error(
        'No graph databases found. Run `grafema analyze` to create one.'
      );
    }

    const dbNames = databases.map(d => d.name).join(', ');
    throw new Error(
      `Database "default" not found. Available: ${dbNames}\n` +
      'Run `grafema analyze` to create the default database.'
    );
  }
}
```

Then both branches use it:
```typescript
// Unix socket
await client.connect();
await client.ping();
await this.negotiateAndSelectDatabase(client);

// WebSocket
await wsClient.connect();
await wsClient.ping();
await this.negotiateAndSelectDatabase(wsClient);
```

---

### Table 4: Reconnection Flow

| Scenario | reconnect() behavior | Correct? |
|----------|---------------------|----------|
| User calls reconnect() | Calls `this.connect()` (line 340) | ✅ YES |
| connect() → tryConnect() | Runs new negotiation flow | ✅ YES |
| connect() → WebSocket | Runs new negotiation flow | ✅ YES |
| Watcher triggers reconnect() | Calls `this.connect()` (line 421) | ✅ YES |
| Session state after reconnect() | No database selected? | ❌ GAP 5 |

**GAP 5: Session state not preserved across reconnections**

**Scenario:**
1. Extension connects to server, selects "default" database
2. Server restarts (user runs `grafema analyze` again)
3. Watcher detects socket change → `reconnect()` → `connect()` → `tryConnect()`
4. NEW connection is established, but does it select "default" again?

**Current plan:** YES, it does select "default" again. ✅

**But what if user had selected a DIFFERENT database?** (future enhancement mentioned in Don's plan, line 306-307)

**Current plan:** Extension ALWAYS selects "default" on reconnect. No persistence of user choice.

**This is acceptable for v1** (as Don noted, "default" is 99% use case), but should be documented as known limitation.

**Recommendation:** Add comment in code:
```typescript
// TODO: Persist selected database in workspace settings (REG-XXX)
// For now, always reconnect to "default"
await client.openDatabase('default', 'rw');
```

---

### Table 5: Auto-start Flow (Unix Socket Only)

| Scenario | Flow | Database negotiation | Correct? |
|----------|------|---------------------|----------|
| DB exists, server running | `tryConnect()` → success | YES | ✅ |
| DB exists, server NOT running | `tryConnect()` → fail → `startServer()` → `tryConnect()` | YES (2nd tryConnect) | ✅ |
| Server just started (empty) | `tryConnect()` → `openDatabase("default")` → fail | ✅ Shows "No databases" | ✅ |

**This table is complete.** ✅

**Edge case:** Server just started with `--no-default` flag (hypothetical). Would show correct "No databases found" message. ✅

---

## Architectural Issues

### Issue 1: Option B concentrates too much logic in tryConnect()

Don recommends **Option B** (inline in `tryConnect()`), arguing:
> "Fewer methods to maintain"

**Counter-argument:**

`tryConnect()` now does **4 things**:
1. Connect to socket
2. Ping verification
3. Protocol negotiation
4. Database selection (with complex error handling)

This violates Single Responsibility Principle.

**Problems with Option B:**
- Error handling for "database not found" vs "network error" is complex
- `listDatabases()` call is deep in error path
- Hard to test database selection logic independently
- WebSocket branch must duplicate ALL this logic (or we extract it anyway)

**Recommendation: Modify Option A**

Extract negotiation into helper (as shown in GAP 4 fix above):
```typescript
private async tryConnect(): Promise<void> {
  const client = new RFDBClient(this.socketPath);
  await client.connect();

  const pong = await client.ping();
  if (!pong) {
    await client.close();
    throw new Error('Server did not respond to ping');
  }

  // Delegate to shared helper
  await this.negotiateAndSelectDatabase(client);

  this.client = client;
  this.setState({ status: 'connected' });
  this.startWatching();
}
```

**Benefits:**
- `tryConnect()` stays focused on connection mechanics
- Database selection logic is testable in isolation
- WebSocket branch reuses same logic (DRY)
- Error messages are consistent across transports

---

### Issue 2: Error notification in extension.ts is incomplete

Don's plan (lines 214-236):
```typescript
try {
  await clientManager.connect();
} catch (err) {
  console.error('[grafema-explore] Connection error:', err);
  const message = err instanceof Error ? err.message : 'Unknown error';
  edgesProvider.setStatusMessage(`Connection failed: ${message}`);

  // Show user notification for database selection errors
  if (message.includes('No graph databases found')) {
    vscode.window.showErrorMessage(
      'Grafema: No graph database found. Run `grafema analyze` to create one.',
      'Run Analyze'
    ).then(selection => {
      if (selection === 'Run Analyze') {
        vscode.commands.executeCommand('workbench.action.terminal.new');
      }
    });
  }
}
```

**Problem:** Only shows notification for "No graph databases found", but NOT for:
- "Database 'default' not found. Available: test"
- Protocol negotiation errors
- Network errors

**Fix needed:** Check for ALL database-related errors:
```typescript
if (message.includes('No graph databases found') ||
    message.includes('not found. Available:') ||
    message.includes('Protocol negotiation failed')) {
  vscode.window.showErrorMessage(
    `Grafema: ${message}`,
    'Open Terminal'
  ).then(selection => {
    if (selection === 'Open Terminal') {
      vscode.commands.executeCommand('workbench.action.terminal.new');
    }
  });
}
```

---

## Missing Test Cases

Don's manual testing plan (lines 249-283) is good but missing:

### Critical Missing Tests:

1. **Protocol negotiation failure**
   - Mock server that rejects hello(3)
   - Verify error message

2. **Non-DATABASE_NOT_FOUND error from openDatabase**
   - Mock server that returns permission denied
   - Verify error is NOT caught by database-not-found handler

3. **listDatabases() failure during error handling**
   - Mock server: openDatabase fails, listDatabases also fails
   - Verify error message is clear

4. **Reconnection after database deletion**
   - Connect → delete .grafema/ → trigger reconnect
   - Verify "No databases" message

5. **WebSocket database-not-found**
   - WebSocket transport + no "default" database
   - Verify error message matches Unix socket

---

## Gap Summary

| Gap # | Description | Severity | Fix Complexity |
|-------|-------------|----------|----------------|
| GAP 1 | Non-DATABASE_NOT_FOUND errors from openDatabase | HIGH | Medium (error type checking) |
| GAP 2 | Protocol version mismatch not checked | MEDIUM | Low (check hello response) |
| GAP 3 | hello() failure not explicitly handled | MEDIUM | Low (add try-catch) |
| GAP 4 | WebSocket lacks database-specific error handling | HIGH | Medium (extract shared helper) |
| GAP 5 | Session state not documented | LOW | Low (add TODO comment) |

**Total critical gaps: 2** (GAP 1, GAP 4)

---

## Recommendations

### 1. Extract Shared Helper (addresses GAP 1, 3, 4)

Create `negotiateAndSelectDatabase()` method as shown above. Use in both Unix socket and WebSocket branches.

### 2. Check hello() Response (addresses GAP 2)

Capture and validate `HelloResponse`:
```typescript
const helloResponse = await client.hello(3);
if (!helloResponse.ok) {
  throw new Error(`Protocol negotiation failed: ${helloResponse.error || 'Unknown'}`);
}
```

### 3. Improve Error Type Detection (addresses GAP 1)

Check error message content before calling `listDatabases()`:
```typescript
if (!message.includes('not found') && !message.includes('DATABASE_NOT_FOUND')) {
  throw err;  // Re-throw non-database-not-found errors
}
```

### 4. Document Session State Limitation (addresses GAP 5)

Add TODO comment for future database persistence.

### 5. Expand Manual Testing

Add 5 test cases listed in "Missing Test Cases" section.

---

## Revised LOC Estimate

Don's estimate: ~35 LOC

**Revised estimate with fixes:**
- `grafemaClient.ts`: `negotiateAndSelectDatabase()` helper: +25 lines (not +15)
- `grafemaClient.ts`: Update both `tryConnect()` and WebSocket branch: +5 lines each = +10 lines
- `extension.ts`: Improved error notification: +15 lines (not +10)
- **Total: ~50 LOC**

Increase: +15 LOC (+43% from original estimate)

Reason: Shared helper method is more complex due to error type checking.

---

## Final Verdict: REJECT

**Don's plan has correct vision** (auto-select "default", graceful fallback) **but incomplete implementation.**

**Critical issues:**
1. Error handling doesn't distinguish DATABASE_NOT_FOUND from other errors
2. WebSocket branch lacks database-specific error handling
3. Protocol negotiation response not validated
4. Architectural choice (Option B) creates duplication and fragility

**Recommendation:** Implement **modified Option A** with shared `negotiateAndSelectDatabase()` helper. This addresses all 5 gaps and maintains DRY principle.

**Estimated rework:** +15 LOC, +30 minutes implementation time.

---

**Next step:** Don should revise plan to include shared helper and error type checking, then pass to Uncle Bob for architecture review.
