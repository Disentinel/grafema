# REG-528: Rob Implementation Report

## Summary

Added database auto-selection to the VS Code extension. After connecting to rfdb-server (via Unix socket or WebSocket), the extension now negotiates the protocol version and opens the "default" database automatically. If the database is not found, actionable error messages are shown in the Explorer panel.

## Changes Made

### 1. `packages/vscode/src/grafemaClient.ts`

**A. New `negotiateAndSelectDatabase()` method** (lines 179-212)

Private method called after successful ping, before storing the client reference. Sequence:
1. Calls `client.hello()` to negotiate protocol version.
2. Calls `client.openDatabase('default', 'rw')` to select the default database.
3. On "not found" error: calls `client.listDatabases()` and throws a descriptive error with available database names.
4. On no databases at all: throws an error instructing the user to run `grafema analyze`.
5. Non-"not found" errors are re-thrown as-is.

**B. Negotiation call in `tryConnect()`** (line 170)

Inserted `await this.negotiateAndSelectDatabase(client)` after ping succeeds but before setting `this.client` and emitting `connected` state. This ensures the Unix socket path performs protocol negotiation.

**C. Negotiation call in WebSocket branch of `connect()`** (lines 111-112)

Inserted `await this.negotiateAndSelectDatabase(wsClient)` after ping succeeds but before setting `this.client` and emitting `connected` state. This ensures the WebSocket path also performs protocol negotiation.

### 2. `packages/vscode/src/extension.ts`

**Connection error handler** (lines 168-175)

Changed from logging the raw error object and showing a generic "Connection failed" message to extracting `err.message` (or falling back to `'Connection failed'`). The extracted message is:
- Logged to console via `console.error`
- Displayed in the Explorer panel via `edgesProvider.setStatusMessage(message)`

This means database-not-found errors from `negotiateAndSelectDatabase()` now surface directly in the VS Code panel with actionable instructions.

## Design Decisions

- **No popup (`vscode.window.showErrorMessage`)**: The status message in the Explorer panel is sufficient and less intrusive. The `connect()` method already calls `setState({ status: 'error', message })` which updates the status bar.
- **Negotiation before client assignment**: If `negotiateAndSelectDatabase()` throws, the client is never stored, so `isConnected()` remains false and no queries are attempted against an un-selected database.
- **Error recovery limited to "not found"**: Other errors (permission, protocol mismatch) are re-thrown without attempting `listDatabases()`, avoiding masking of unrelated failures.
