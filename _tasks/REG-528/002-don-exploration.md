# REG-528: VS Code Extension Database Selection — Exploration Findings

**Don Melton** (Tech Lead) — 2026-02-20

## Problem Summary

The VS Code extension connects to rfdb-server successfully but does NOT auto-select a database. All queries fail with "No database selected. Use openDatabase first." All 7 panels show placeholders instead of data.

## Root Cause Analysis

### 1. Connection Flow

**Current behavior:**
- Extension connects to rfdb-server via Unix socket (`GrafemaClientManager.connect()`)
- Connection is established successfully (ping works)
- Extension shows "connected" status
- **BUT**: No database is selected after connection

**Location:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/grafemaClient.ts`
- Line 92-150: `connect()` method
- Line 155-171: `tryConnect()` method — only pings, does NOT select database

### 2. Protocol Evolution: v1 (legacy) vs v3 (current)

**rfdb-server behavior** (`/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/bin/rfdb_server.rs`):

**Protocol v1 (legacy mode):**
- Line 2105-2111: Server auto-opens "default" database when `legacy_mode = true`
- Backwards-compatible behavior for old clients

**Protocol v3 (current):**
- Client must explicitly call `hello(protocolVersion: 3)` to negotiate
- Client must then call `openDatabase(name, mode)` to select a database
- Server creates "default" database from CLI path (line 2461-2464)
- **BUT**: Client MUST explicitly open it

**Current VS Code extension behavior:**
- Does NOT call `hello()` on connection
- Does NOT call `openDatabase()` on connection
- Relies on legacy auto-open behavior (which no longer happens for protocol v3 clients)

### 3. RFDBClient API

**Available methods** (`/Users/vadimr/grafema-worker-1/packages/rfdb/ts/base-client.ts`):

```typescript
// Protocol v2+ multi-database commands (lines 471-502)
async hello(protocolVersion: number = 3): Promise<HelloResponse>
async createDatabase(name: string, ephemeral: boolean = false): Promise<CreateDatabaseResponse>
async openDatabase(name: string, mode: 'rw' | 'ro' = 'rw'): Promise<OpenDatabaseResponse>
async closeDatabase(): Promise<RFDBResponse>
async dropDatabase(name: string): Promise<RFDBResponse>
async listDatabases(): Promise<ListDatabasesResponse>
async currentDatabase(): Promise<CurrentDatabaseResponse>
```

**All methods are available** — they just aren't being called.

### 4. Error Origin

**Error message location:** `/Users/vadimr/grafema-worker-1/packages/rfdb-server/src/bin/rfdb_server.rs`

```rust
// Helper function (around line 850-860)
fn with_engine_read<F>(session: &ClientSession, f: F) -> Response
where F: FnOnce(&dyn GraphStore) -> Response
{
    match &session.current_db {
        Some(db) => {
            let engine = db.engine.read().unwrap();
            f(&**engine)
        }
        None => Response::ErrorWithCode {
            error: "No database selected. Use openDatabase first.".to_string(),
```

**ALL data queries** (`getNode`, `queryNodes`, `getOutgoingEdges`, etc.) use `with_engine_read()` or `with_engine_write()`, which check for `session.current_db`. If None, they return this error.

### 5. Extension Activation Flow

**Location:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/extension.ts`

```typescript
// Line 42-198: activate() function
async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ... setup providers ...

  // Line 60: Initialize client manager
  clientManager = new GrafemaClientManager(workspaceRoot, rfdbServerPath, rfdbSocketPath);

  // Line 168-174: Connect to RFDB
  try {
    await clientManager.connect();  // ← Only pings, does NOT select database
  } catch (err) {
    console.error('[grafema-explore] Connection error:', err);
    edgesProvider.setStatusMessage('Connection failed');
  }
}
```

**Missing:** After `connect()`, the extension should call:
```typescript
const client = clientManager.getClient();
await client.hello(3);  // Negotiate protocol v3
await client.openDatabase('default', 'rw');  // Open default database
```

### 6. Configuration / Settings

**VS Code settings** (`/Users/vadimr/grafema-worker-1/packages/vscode/package.json` lines 312-368):
- `grafema.rfdbServerPath` — path to rfdb-server binary
- `grafema.rfdbSocketPath` — socket path
- `grafema.rfdbTransport` — unix / websocket
- `grafema.rfdbWebSocketUrl` — WebSocket URL

**NO setting for database name/path** — extension assumes "default" database should exist.

### 7. Demo Configuration

**Docker demo** (`/Users/vadimr/grafema-worker-1/demo/README.md`):
- Runs `rfdb-server` with pre-built graph
- Uses WebSocket transport (`--ws-port 7432`)
- Creates "default" database from CLI path
- **Still requires client to explicitly open it**

## VS Code Extension Patterns (Web Research)

Checked standard patterns for VS Code extensions that need to select a resource on activation.

**Sources:**
- [Activation Events | Visual Studio Code Extension API](https://code.visualstudio.com/api/references/activation-events)
- [Extension Anatomy | Visual Studio Code Extension API](https://code.visualstudio.com/api/get-started/extension-anatomy)

**Standard pattern:**
1. **Auto-select default resource** on activation (if only one exists or if "default" exists)
2. **Show command palette** if multiple resources available
3. **Show welcome message** if no resources exist

**Examples:**
- Git extension: auto-selects first repository if workspace has one
- Docker extension: auto-connects to Docker daemon if running
- Database extensions: auto-open "default" connection if configured

**Best practice for Grafema:**
- Auto-select "default" database on connection (most common case)
- Fallback to command if "default" doesn't exist or if user wants to switch
- Show clear error message if no databases exist

## Summary

**Gap identified:**
1. Extension connects to server ✅
2. Extension pings server ✅
3. **Extension DOES NOT call `hello()` to negotiate protocol v3** ❌
4. **Extension DOES NOT call `openDatabase('default')` to select database** ❌
5. All queries fail because `session.current_db` is None

**Why this wasn't caught earlier:**
- Protocol v3 is relatively new (multi-database support)
- Legacy clients (protocol v1) get auto-opened to "default" database
- VS Code extension was likely last tested before protocol v3 changes
- Server creates "default" database but doesn't auto-open it for v3 clients

**Design decision needed:**
- Should extension call `hello(3)` explicitly, or rely on default protocol?
- Should extension ALWAYS open "default", or check `listDatabases()` first?
- Should there be a user-facing command to switch databases?

---

**Next step:** Create implementation plan in `003-don-plan.md`.
