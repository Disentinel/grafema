## Steve Jobs — Vision Review (Round 3)

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

### Analysis

Round 3 adds one new change on top of what was already approved in round 2: `startWatching()` now derives the watch directory and socket filename from `this.socketPath` instead of hardcoding `GRAFEMA_DIR` and `SOCKET_FILE` constants.

**The fix is correct.**

Before:
```typescript
const grafemaDir = join(this.workspaceRoot, GRAFEMA_DIR);
// ...
if (filename === SOCKET_FILE || filename === DB_FILE) {
```

After:
```typescript
const watchDir = dirname(this.socketPath);
const socketFilename = basename(this.socketPath);
// ...
if (filename === socketFilename || filename === DB_FILE) {
```

This is exactly what Вадим auto's round 2 rejection called for. The watcher now correctly monitors the right directory when `explicitSocketPath` is configured. Without this fix, the socket path override would silently fail to trigger reconnection on server restart — the most critical event the watcher exists to handle.

**Minor observation on DB_FILE:** The watcher still checks `filename === DB_FILE` regardless of custom socket path. Since `dbPath` is not configurable (always `{workspace}/.grafema/graph.rfdb`), the DB_FILE check will never fire when watching a custom socket directory. This is acceptable: DB_FILE watching is a secondary trigger, the primary socket reconnection logic is correct, and `dbPath` being workspace-relative is by design (you analyze the workspace). Not a reason to reject.

**Vision alignment:** The VS Code extension is the visual surface for graph exploration — "AI should query the graph, not read code" requires humans and agents to be able to navigate the graph. Broken reconnection after server restart would silently leave users on stale or disconnected state. This fix ensures the extension stays connected across server restarts, which is essential for any real workflow.

**Architecture:** Three changes total across the branch — each is minimal, focused, and follows existing patterns:
1. Path removal (one entry from an array) — no new logic
2. Socket override (getter with string-or-default) — mirrors existing `rfdbServerPath` pattern exactly
3. Watcher fix (two variable extractions, one constant replacement) — no new branching

The implementation is clean and does not introduce new abstraction layers, new iteration, or architectural departures.

**Would shipping this embarrass us?** No. This is a necessary correctness fix. The alternative — shipping a configurable socket path that silently fails to reconnect — would embarrass us.
