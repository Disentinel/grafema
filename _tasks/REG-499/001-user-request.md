# REG-499: Fix VS Code extension compatibility with current rfdb-server

## Problem

VS Code extension hasn't been updated since Feb 8, while rfdb-server has had 7 releases (v0.2.6 → v0.2.12) with significant changes:

* Deferred indexing (REG-487)
* commitBatch MODULE protection (REG-489)
* Dead `startServer()` removed (RFD-40)
* Version printing on startup (RFD-40)
* Node/edge count dedup after flush (RFD-39)

Extension likely has issues connecting to and working with current server version. Need to verify and fix.

## Audit Checklist

### 1. Connection & startup

- Does auto-start still work? (`startServer()` was removed from @grafema/rfdb — extension uses its own spawn logic, but verify)
- Binary discovery: hardcoded `/Users/vadimr/grafema` fallback in grafemaClient.ts line 180 — must be removed for published extension
- Socket path discovery with current server version
- Reconnection after server restart

### 2. API compatibility

- `getAllNodes({ file })` — extension uses this heavily. Verify response format matches current rfdb-server
- `getNode(id)` — verify with current node ID format (semantic IDs)
- `getOutgoingEdges(id)` / `getIncomingEdges(id)` — verify edge record format
- `nodeCount()` / `edgeCount()` — verify after RFD-39 dedup fix

### 3. Known issues to fix

- Uses `getAllNodes({ file })` — should this use queryNodes instead?
- Hardcoded developer path in binary discovery
- Test with a real project graph (not just ping)

### 4. Build & packaging

- Bundled rfdb-server binary version — is it current?
- Does `pnpm build` for vscode package still work?
- VSIX packaging with current dependencies

## Acceptance Criteria

* Extension connects to rfdb-server v0.2.12
* Node exploration, edge navigation, follow-cursor all work
* No hardcoded developer paths
* Bundled binary matches current release
