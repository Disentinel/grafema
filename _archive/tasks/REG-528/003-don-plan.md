# REG-528: VS Code Extension Database Selection — Implementation Plan

**Don Melton** (Tech Lead) — 2026-02-20

## Root Cause

The VS Code extension connects to rfdb-server but does NOT select a database after connection. In protocol v3 (current), clients must explicitly call `hello()` and `openDatabase()` after connecting. The extension skips these steps, causing all queries to fail with "No database selected. Use openDatabase first."

## Proposed Solution

**Auto-select "default" database on connection** with graceful fallback to error message.

**Why "default"?**
- rfdb-server creates "default" database from CLI path (line 2461-2464 in `rfdb_server.rs`)
- Standard convention (Docker demo, tests, CLI all use "default")
- Simplest UX: user runs `grafema analyze`, extension auto-connects to result

**Fallback strategy:**
1. Try to open "default" database (most common case)
2. If "default" doesn't exist, list available databases
3. If no databases exist, show clear error message
4. Future enhancement: add command to switch databases (not in this task)

## Files to Modify

### 1. `/Users/vadimr/grafema-worker-1/packages/vscode/src/grafemaClient.ts`

**Current code** (lines 92-150):
```typescript
async connect(): Promise<void> {
  // ... socket/websocket selection ...

  // Unix socket mode:
  this.setState({ status: 'connecting' });
  try {
    await this.tryConnect();  // ← Only pings
    return;
  } catch {
    // ... auto-start server ...
  }
}

private async tryConnect(): Promise<void> {
  const client = new RFDBClient(this.socketPath);
  await client.connect();

  const pong = await client.ping();  // ← Ping only
  if (!pong) {
    await client.close();
    throw new Error('Server did not respond to ping');
  }

  this.client = client;
  this.setState({ status: 'connected' });
  this.startWatching();
}
```

**Proposed changes:**

**Option A: Add `negotiateProtocol()` helper** (cleaner separation)
```typescript
async connect(): Promise<void> {
  // ... existing connection logic ...

  // After successful connection:
  try {
    await this.negotiateProtocol();  // ← NEW: negotiate + select DB
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.setState({
      status: 'error',
      message: `Database selection failed: ${message}`
    });
  }
}

/**
 * Negotiate protocol version and auto-select default database.
 * Called after successful connection to rfdb-server.
 */
private async negotiateProtocol(): Promise<void> {
  if (!this.client) {
    throw new Error('No client connection');
  }

  // Step 1: Negotiate protocol v3
  const hello = await this.client.hello(3);
  console.log('[grafema-explore] Protocol negotiated:', hello);

  // Step 2: Try to open "default" database
  try {
    const result = await this.client.openDatabase('default', 'rw');
    console.log('[grafema-explore] Opened default database:', result);
  } catch (err) {
    // If "default" doesn't exist, check what databases are available
    const { databases } = await this.client.listDatabases();

    if (databases.length === 0) {
      throw new Error(
        'No graph databases found. Run `grafema analyze` to create one.'
      );
    }

    // If other databases exist, show which ones
    const dbNames = databases.map(d => d.name).join(', ');
    throw new Error(
      `Database "default" not found. Available: ${dbNames}\n` +
      'Run `grafema analyze` to create the default database.'
    );
  }
}
```

**Option B: Inline in `tryConnect()` / `connect()`** (simpler, fewer methods)
```typescript
private async tryConnect(): Promise<void> {
  const client = new RFDBClient(this.socketPath);
  await client.connect();

  // Verify connection with ping
  const pong = await client.ping();
  if (!pong) {
    await client.close();
    throw new Error('Server did not respond to ping');
  }

  // Negotiate protocol v3
  await client.hello(3);

  // Auto-select "default" database
  try {
    await client.openDatabase('default', 'rw');
  } catch (err) {
    // Check what databases are available
    const { databases } = await client.listDatabases();
    await client.close();

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

  this.client = client;
  this.setState({ status: 'connected' });
  this.startWatching();
}
```

**Recommendation: Option B** (inline in `tryConnect()`)
- Fewer methods to maintain
- Clear single-responsibility: `tryConnect()` = connect + negotiate + select DB
- Error handling is already in the caller (`connect()`)

**Same pattern for WebSocket mode:**
```typescript
// In connect(), WebSocket branch (lines 96-122):
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

    // ← ADD: Same negotiation logic as Unix socket
    await wsClient.hello(3);
    await wsClient.openDatabase('default', 'rw');

    this.client = wsClient;
    this.setState({ status: 'connected' });
    this.startWatching();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.setState({
      status: 'error',
      message: `WebSocket connection failed: ${message}`,
    });
  }
  return;
}
```

### 2. Error Message Display

**Location:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/extension.ts`

**Current code** (lines 168-174):
```typescript
try {
  await clientManager.connect();
} catch (err) {
  console.error('[grafema-explore] Connection error:', err);
  edgesProvider.setStatusMessage('Connection failed');
}
```

**No user-facing notification** — only internal status message.

**Proposed change:**
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

### 3. Status Provider Updates (Optional Enhancement)

**Location:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/statusProvider.ts`

Currently shows server connection status. Could be enhanced to show:
- Current database name ("default")
- Database node/edge count
- Protocol version

**Not required for bug fix** — can be follow-up enhancement.

## Testing Strategy

### Manual Testing

1. **Happy path: "default" database exists**
   - Run `grafema analyze` in workspace
   - Reload VS Code extension
   - Verify: all panels load data (no "No database selected" error)

2. **Error case: No databases exist**
   - Delete `.grafema/` directory
   - Start rfdb-server manually (no database)
   - Reload extension
   - Verify: clear error message "No graph databases found. Run `grafema analyze`"

3. **Error case: Different database name**
   - Create database named "test" (not "default")
   - Reload extension
   - Verify: error message shows available databases ("Available: test")

4. **WebSocket transport**
   - Set `grafema.rfdbTransport` to `websocket`
   - Run rfdb-server with `--ws-port 7474`
   - Reload extension
   - Verify: same behavior as Unix socket

### Automated Testing (Future)

Add integration tests in `packages/vscode/test/`:
- Test auto-open "default" database on connection
- Test error handling when no databases exist
- Test error handling when "default" doesn't exist

**Not in scope for this bug fix** — manual testing is sufficient.

## Estimated LOC

- `grafemaClient.ts`: +15 lines (protocol negotiation in `tryConnect()`)
- `grafemaClient.ts`: +10 lines (WebSocket branch)
- `extension.ts`: +10 lines (error notification)
- **Total: ~35 LOC**

**Complexity: LOW** — straightforward API calls, clear error handling.

## Deployment Notes

**Breaking change?** No.
- Existing users: extension will now work correctly
- No API changes for other consumers
- No migration needed

**Rollout:** Include in next patch release (v0.2.1)

## Open Questions

1. **Should we add a user command to switch databases?**
   - Not required for bug fix
   - Can be follow-up enhancement (e.g., `grafema.selectDatabase` command)
   - Would use `listDatabases()` + Quick Pick

2. **Should we persist selected database in workspace settings?**
   - Not required for bug fix
   - "default" is sensible default for 99% of cases
   - Can be enhancement if users request it

3. **Should we show current database in Status Bar?**
   - Not required for bug fix
   - Would improve UX (user knows which DB is active)
   - Can be follow-up enhancement

**Decision: Keep scope minimal** — auto-select "default" only. Future enhancements tracked separately.

## Acceptance Criteria

✅ Extension connects to rfdb-server
✅ Extension negotiates protocol v3
✅ Extension auto-selects "default" database
✅ All 7 panels load data (no "No database selected" error)
✅ Clear error message if no databases exist
✅ Clear error message if "default" doesn't exist (shows available databases)
✅ Works for both Unix socket and WebSocket transports

---

**Next step:** Implement changes in `grafemaClient.ts` and `extension.ts`, test manually, create PR.
