# RFD-40: Implementation Plan — RFDB Server Coupling Simplification

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-17
**Status:** Ready for Dijkstra Verification

---

## Overview

Five phases of surgery, all TypeScript except one Rust one-liner. Each phase is atomic and independently committable. The phases are ordered to fix the most critical bug first (socket path mismatch) before touching architecture.

**Total scope estimate:** ~200 LOC changed/added, ~100 LOC removed.

---

## Phase 1: Create `startRfdbServer()` in core — Unify All Spawn Sites

**Goal:** One authoritative function for spawning rfdb-server. All 3 current spawn sites delegate to it.

### What changes

**New file:** `packages/core/src/utils/startRfdbServer.ts`

A single exported async function:

```typescript
export interface StartRfdbServerOptions {
  dbPath: string;
  socketPath: string;
  binaryPath?: string;   // optional override; if absent, findRfdbBinary() is called
  pidPath?: string;      // optional; if provided, PID file is written
  waitTimeoutMs?: number; // default 5000
  logger?: { debug(msg: string): void };
}

export async function startRfdbServer(options: StartRfdbServerOptions): Promise<ChildProcess>
```

Responsibilities (in order):
1. Resolve binary: `options.binaryPath || findRfdbBinary()` — throws if null.
2. Remove stale socket: `if (existsSync(socketPath)) unlinkSync(socketPath)`.
3. Spawn: `spawn(binary, [dbPath, '--socket', socketPath], { stdio: ['ignore', 'ignore', 'inherit'], detached: true })` + `serverProcess.unref()`.
4. Write PID file if `options.pidPath` provided and `serverProcess.pid` is set.
5. Poll socket: loop up to `waitTimeoutMs / 100` iterations × 100ms each.
6. Throw descriptive error if socket never appears: `"RFDB server failed to start after Xms — check binary: Y"`.
7. Return `serverProcess`.

**Why detached+unref always:** All three call sites today detach (they want a persistent daemon). The "parallel runner" mode is the only case that currently does NOT detach (it kills the server when done), but we will handle that by keeping a reference to the returned `ChildProcess` and calling `.kill()` on it explicitly. The function always detaches; callers decide whether to kill later.

### Files to modify

**`packages/core/src/storage/backends/RFDBServerBackend.ts`**
- Lines 218–263: Replace `_startServer()` body with a call to `startRfdbServer()`.
- Remove the internal `_findServerBinary()` method (lines 207–213) — no longer needed.
- Pass `pidPath: undefined` (MCP auto-start does not write PID — that's still intentional; PID file is only for `grafema server start`).

Before (abbreviated):
```typescript
private async _startServer(): Promise<void> {
  // ... finds binary, spawns, unref, polls ...
}
```

After:
```typescript
private async _startServer(): Promise<void> {
  if (!this.dbPath) throw new Error('dbPath required to start RFDB server');
  await startRfdbServer({
    dbPath: this.dbPath,
    socketPath: this.socketPath,
    waitTimeoutMs: 5000,
    logger: this.silent ? undefined : { debug: (m) => this.log(m) },
  });
}
```

**`packages/cli/src/commands/server.ts`**
- Lines 160–177: Replace the inline spawn block with `startRfdbServer()`.
- Pass `pidPath` so PID file is still written.
- Keep the `isServerRunning()` verification call after (no change needed there).
- The `findServerBinary()` wrapper can be removed; pass `binaryPath` directly to `startRfdbServer()`.

Before (abbreviated):
```typescript
const serverProcess = spawn(binaryPath, [dbPath, '--socket', socketPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
serverProcess.unref();
if (serverProcess.pid) {
  writeFileSync(pidPath, String(serverProcess.pid));
}
// poll loop...
```

After:
```typescript
await startRfdbServer({
  dbPath,
  socketPath,
  binaryPath,
  pidPath,
  waitTimeoutMs: 10000,
});
```

**`packages/core/src/ParallelAnalysisRunner.ts`**
- Lines 119–176: Replace `startRfdbServer()` private method body with delegation to the shared `startRfdbServer()` utility.
- The existing check for a running server (lines 120–135) stays — it tries to connect first and returns early if server already running.
- Replace lines 138–154 (own binary search + spawn) with `startRfdbServer({ dbPath, socketPath })`.
- **Fix socket path bug (line 46):** Change `this.parallelConfig.socketPath || '/tmp/rfdb.sock'` to derive from `dbPath` when not configured:

```typescript
// Before (line 46):
const socketPath = this.parallelConfig.socketPath || '/tmp/rfdb.sock';

// After:
const socketPath = this.parallelConfig.socketPath
  || join(dirname(mainDbPath), 'rfdb.sock');
```

Note: `mainDbPath` is computed at line 49. Reorder so `mainDbPath` is computed before `socketPath`.

**`packages/core/src/index.ts`**
- Export `startRfdbServer` from the new utils file (line 129 area, next to `findRfdbBinary`).

### Fix bundled in Phase 1: analysis-worker.ts socket path mismatch (Pain Point 4.7)

**`packages/mcp/src/analysis-worker.ts`** (line 224):

```typescript
// Before (BUG):
const socketPath = config.analysis?.parallel?.socketPath || '/tmp/rfdb.sock';

// After:
const socketPath = config.analysis?.parallel?.socketPath
  || join(projectPath, '.grafema', 'rfdb.sock');
```

This makes the worker's socket path derivation match `RFDBServerBackend`'s derivation from `dbPath` (which is `join(projectPath, '.grafema', 'graph.rfdb')` → dirname → `join(projectPath, '.grafema')` + `/rfdb.sock`).

### Fix bundled in Phase 1: AnalysisQueue socket path (Pain Point 4.3)

**`packages/core/src/core/AnalysisQueue.ts`** (line 145):

The `AnalysisQueue` is always created by `ParallelAnalysisRunner` which passes `socketPath` explicitly (after our fix). The `/tmp/rfdb.sock` fallback on line 145 in `AnalysisQueue` is a defensive fallback. It can be kept as-is since `ParallelAnalysisRunner` will now always pass a correct `socketPath`. Changing it to throw instead of fallback would be safer but is not required for Phase 1.

### Test strategy for Phase 1

**New test file:** `test/unit/StartRfdbServer.test.js`

Tests to write (unit, no actual server spawn):

1. **Binary not found throws descriptive error** — mock `findRfdbBinary` returning null, expect error message to include "binary not found".
2. **Stale socket is removed before spawn** — create a file at socketPath, verify it's removed.
3. **PID file written when pidPath provided** — mock spawn with fake pid, verify file is created.
4. **PID file NOT written when pidPath absent** — verify no file created.
5. **Socket wait timeout error** — if socket never appears, error message includes timeout duration and binary path.
6. **Logger called during startup** — if logger provided, debug messages emitted.

**Existing tests to run:** `test/unit/FindRfdbBinary.test.js` — must still pass (no changes to `findRfdbBinary.ts`).

### Risk / dependencies

- **Low risk.** `startRfdbServer()` is pure extraction of existing behavior.
- No changes to wire protocol or RFDB API.
- The `ParallelAnalysisRunner` socket path change (`/tmp/rfdb.sock` → derived) may break existing configs that rely on the old default. However: any user who has `parallelConfig.socketPath` set explicitly is unaffected. The only affected case is "parallel mode with no explicit socketPath configured" — which was already broken for multi-project scenarios.
- **Dependency:** Phase 2, 3, 4 all depend on Phase 1 being done first.

---

## Phase 2: Rust — Print Version on Startup

**Goal:** When rfdb-server starts, emit version to stderr so operators and logs show what binary is running.

### What changes

**`packages/rfdb-server/src/bin/rfdb_server.rs`**

After line 2140 (`eprintln!("[rfdb-server] Opening default database: {:?}", db_path);`), the server is already printing startup info. We add one line earlier in startup, immediately after arg parsing succeeds and before database open:

Insert at line 2111 (after `let db_path = PathBuf::from(db_path_str);`):

```rust
eprintln!("[rfdb-server] Starting rfdb-server v{}", env!("CARGO_PKG_VERSION"));
```

This is a single `eprintln!` line. It appears in stderr before the "Listening on" message, giving operators clear version info in logs.

**No TypeScript changes needed in Phase 2.** Version is already available via ping response (`Pong { version }`) which the CLI `server status` command already displays. We are not adding version validation in this phase (deferred per task scope decisions).

### Why no version validation yet

The task description says "validate what we have" but also "Defer unifying Cargo vs npm version to a separate issue". The Rust binary reports `0.1.0` while npm is `0.2.11`. Adding strict version validation now would break existing setups. The startup log line is the pragmatic improvement: operators see the version, can debug mismatches manually. Strict validation is a separate RFD.

### Build requirement

`cargo build` must run after this change. This is the only phase requiring a Rust build.

```bash
cd packages/rfdb-server && cargo build --release
```

### Test strategy for Phase 2

No automated test for the Rust change. Manual verification:
```bash
grafema server start
# Check log or .grafema/mcp.log for: [rfdb-server] Starting rfdb-server v0.1.0
```

The `grafema server status` command already displays the version from ping response — that behavior is unchanged.

### Risk / dependencies

- **Very low risk.** Single line addition, no logic change.
- Rust build is the only risk — if Cargo is not available on CI, skip or make conditional.
- No dependency on Phase 1.

---

## Phase 3: Clean Up Dead Code in rfdb-server/index.js

**Goal:** Remove or fix the broken `startServer()` API and the duplicate `getBinaryPath()` in the npm package wrapper.

### Problem recap

`packages/rfdb-server/index.js` has two issues:

1. **`getBinaryPath()`** (lines 16–31): Only checks `prebuilt/{platform}/`. Does not check PATH, env var, monorepo builds, or `~/.local/bin`. Duplicates part of `findRfdbBinary()` with different (incomplete) logic.

2. **`startServer()`** (lines 49–68): Passes args `['--socket', socketPath, '--data-dir', dataDir]` — missing the required `<db-path>` positional argument. The Rust binary would print usage and exit with code 1. This function is NOT called anywhere in production code (verified by grepping all callers) — it is dead broken API.

### What changes

**`packages/rfdb-server/index.js`**

Replace `getBinaryPath()` with a note directing callers to use `findRfdbBinary()` from `@grafema/core`. Since this is a CommonJS file and `@grafema/core` is ESM, we cannot directly import it. Instead:

**Option A (preferred):** Keep `getBinaryPath()` as prebuilt-only lookup (its current behavior) but add a JSDoc comment: `@deprecated Use findRfdbBinary() from @grafema/core for full search`. The function is exported; removing it is a breaking API change for any external consumer.

**Option B:** Remove `getBinaryPath()` and `startServer()` entirely from the public API.

**Decision:** The `packages/rfdb-server/index.js` is the npm package's public API. It can be consumed by external tools. Remove `startServer()` (it is broken and cannot work without db-path). Keep `getBinaryPath()` with deprecation notice. Keep `isAvailable()` and `waitForServer()` (they are useful utilities).

Concrete changes to `packages/rfdb-server/index.js`:

1. Remove `startServer()` function (lines 49–68) — it is broken (wrong Rust CLI args).
2. Remove `startServer` from `module.exports` (line 105).
3. Add JSDoc `@deprecated` to `getBinaryPath()` noting it only checks prebuilt directory.
4. Add a comment above `getBinaryPath()` explaining that `findRfdbBinary()` from `@grafema/core` is the authoritative implementation.

**`packages/rfdb-server/bin/rfdb-server.js`**

The `getBinaryPath()` in `bin/rfdb-server.js` (lines 12–56) searches: prebuilt → cargo release → monorepo release → `~/.local/bin`. This is a reasonable search for the bin entrypoint (a standalone script that can't import from core). Keep as-is. Add a comment noting it's intentionally separate from core's `findRfdbBinary()` for standalone use.

### Test strategy for Phase 3

No new tests. The `packages/rfdb-server/index.js` has no existing tests (it's an npm package helper). Verify by grep that `startServer` is not called anywhere:

```bash
grep -r "startServer" packages/ --include="*.ts" --include="*.js" | grep -v index.js
```

Expected: zero results.

### Risk / dependencies

- **Low risk.** `startServer()` was broken anyway (wrong args). Removing it cannot break existing working functionality.
- No dependency on Phase 1 or 2.

---

## Phase 4: CLI Improvements

**Goal:** Add `grafema server restart` command and convenience pnpm scripts.

### What changes

**`packages/cli/src/commands/server.ts`**

Add new subcommand `restart`:

```typescript
serverCommand
  .command('restart')
  .description('Restart the RFDB server')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-b, --binary <path>', 'Path to rfdb-server binary')
  .action(async (options) => {
    // 1. Run stop logic (reuse stop action, or extract shared function)
    // 2. Run start logic (reuse start action, or extract shared function)
  });
```

To implement cleanly, extract `stopServer(projectPath)` and `startServer(projectPath, binaryPath)` as standalone async functions that both `stop`, `start`, and `restart` actions call. Currently the stop and start logic is inlined in action handlers.

**Important:** The existing `start` action handler has a `findServerBinary` local wrapper. After Phase 1, this wrapper is no longer needed because we call `startRfdbServer()` which handles binary discovery internally. Remove the wrapper and simplify.

**Version info in `status` command:**

The `status` command (lines 258–342) already shows `status.version` when running (lines 325–327). The version comes from `client.ping()` which returns the Rust `CARGO_PKG_VERSION`. No change needed here — it already works.

**`package.json` (root)**

Add convenience scripts:

```json
"scripts": {
  "rfdb:start": "node packages/cli/dist/cli.js server start",
  "rfdb:stop": "node packages/cli/dist/cli.js server stop",
  "rfdb:status": "node packages/cli/dist/cli.js server status",
  "rfdb:restart": "node packages/cli/dist/cli.js server restart"
}
```

These require the CLI to be built first (`pnpm build`). They are convenience aliases, not replacements for `grafema server ...`.

### Test strategy for Phase 4

No unit tests for CLI commands (they require a real Rust server). The `restart` command is composed of existing `stop` + `start` which are already tested implicitly by usage.

**Manual verification:**
```bash
pnpm build
pnpm rfdb:start
pnpm rfdb:status   # should show "running"
pnpm rfdb:restart  # should stop and restart
pnpm rfdb:status   # should show "running" again
pnpm rfdb:stop
```

### Risk / dependencies

- **Low risk.** Additive change (new command) + convenience scripts.
- **Dependency:** Depends on Phase 1 (uses `startRfdbServer()` from core).
- `restart` must handle the case where server is not running (start only, no stop needed).

---

## Phase 5: Documentation Update

**Goal:** Remove stale manual commands from CLAUDE.md and update the dogfooding section.

### What changes

**`CLAUDE.md`** — Dogfooding section, "Setup (per worker)" block:

Current (stale, WRONG):
```bash
# Start RFDB server (from project root)
/Users/vadim/.local/bin/rfdb-server .grafema/graph.rfdb --socket .grafema/rfdb.sock --data-dir .grafema &

# Rebuild graph after switching branches or pulling changes
node packages/cli/dist/cli.js analyze
```

Replace with:
```bash
# Start RFDB server (from project root — auto-discovers binary)
grafema server start
# Or using pnpm convenience script (requires pnpm build first):
pnpm rfdb:start

# Rebuild graph after switching branches or pulling changes
grafema analyze
# Or:
node packages/cli/dist/cli.js analyze
```

Remove the hardcoded path `/Users/vadim/.local/bin/rfdb-server` — that's a personal path, not a project instruction.

**`CLAUDE.md`** — Product Gap Policy section:

Update:
```markdown
**RFDB auto-start:** The MCP server auto-starts RFDB when needed. No manual `rfdb-server` command required...
```

Change "No manual `rfdb-server` command" to clarify the preferred workflow:
```markdown
**RFDB auto-start:** The MCP server auto-starts RFDB when needed. No manual `rfdb-server` command required — `RFDBServerBackend` spawns it on first connection attempt (detached, survives MCP exit). Binary is found via `findRfdbBinary()` (monorepo build, PATH, `~/.local/bin`). For explicit control, use `grafema server start/stop/restart/status`.
```

### Test strategy for Phase 5

No code tests. Review only.

### Risk / dependencies

- **Zero risk.** Documentation only.
- No dependency on any other phase.

---

## Implementation Order and Commit Sequence

```
Phase 1 → Phase 3 → Phase 2 → Phase 4 → Phase 5
```

Rationale:
- Phase 1 first: fixes the socket mismatch bug (critical), creates the shared function that Phases 3 and 4 depend on.
- Phase 3 second: independent of Phases 2 and 4, can go before or after Phase 1 but clean-up is logically grouped here.
- Phase 2 (Rust): can go at any point, but doing it after TypeScript changes means one focused Rust commit.
- Phase 4 fourth: depends on Phase 1 being done.
- Phase 5 last: documentation always last, after code is confirmed working.

### Commit messages (planned)

```
refactor(core): unify rfdb-server spawn into startRfdbServer() utility (RFD-40)
fix(mcp): derive socket path from project path instead of /tmp fallback (RFD-40)
chore(rfdb): remove broken startServer() API from npm package wrapper (RFD-40)
feat(rust): print version on rfdb-server startup (RFD-40)
feat(cli): add grafema server restart command and pnpm rfdb:* scripts (RFD-40)
docs: update CLAUDE.md rfdb startup instructions (RFD-40)
```

---

## Pain Points Addressed per Phase

| Pain Point | Phase | Severity |
|-----------|-------|----------|
| 4.10: 3 spawn sites with duplicate logic | 1 | High |
| 4.3: `/tmp/rfdb.sock` global fallback in ParallelAnalysisRunner | 1 | High |
| 4.7: analysis-worker.ts socket path mismatch (confirmed bug) | 1 | High |
| 4.2: Auto-start lacks PID file (for MCP path) | 1 | Medium (PID optional) |
| 4.1: Duplicate binary discovery in ParallelAnalysisRunner | 1 | Medium |
| 4.9: No lifecycle API / no restart | 4 | Medium |
| 4.4: No version log on startup | 2 | Low |
| 4.8: rfdb-server/index.js broken startServer() | 3 | Low (dead code) |
| 4.6: Stale CLAUDE.md documentation | 5 | Low |

**NOT in scope (per task decisions):**
- Unifying Cargo (0.1.0) vs npm (0.2.11) version numbers — separate issue
- Strict version validation on auto-start — separate issue
- Relative path support — already handled at TS layer
- Converting to system service (launchd) — not the desired model

---

## Files Modified Summary

| File | Phase | Change Type |
|------|-------|-------------|
| `packages/core/src/utils/startRfdbServer.ts` | 1 | **NEW** |
| `packages/core/src/index.ts` | 1 | Export new function |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | 1 | Delegate _startServer() |
| `packages/cli/src/commands/server.ts` | 1, 4 | Delegate spawn, add restart |
| `packages/core/src/ParallelAnalysisRunner.ts` | 1 | Fix socket path + delegate spawn |
| `packages/mcp/src/analysis-worker.ts` | 1 | Fix socket path fallback |
| `packages/core/src/core/AnalysisQueue.ts` | — | No change (caller fixed) |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | 2 | Add one eprintln! |
| `packages/rfdb-server/index.js` | 3 | Remove startServer(), deprecate getBinaryPath() |
| `package.json` (root) | 4 | Add rfdb:* scripts |
| `test/unit/StartRfdbServer.test.js` | 1 | **NEW** tests |
| `CLAUDE.md` | 5 | Update docs |

---

## Edge Cases and Invariants

1. **Server already running when startRfdbServer() is called:** The function removes the stale socket then spawns. If a real server is listening, the spawn will start a second server on the same db (conflict). The callers already check `isServerRunning()` before calling, so this is not startRfdbServer()'s responsibility. Add comment in code.

2. **`serverProcess.pid` is undefined:** `ChildProcess.pid` can be undefined if the process fails to spawn. The PID file write must be conditional on `serverProcess.pid !== undefined`.

3. **Socket appears but server not yet accepting connections:** The current poll loop checks `existsSync(socketPath)` but a connect attempt might still fail briefly. The existing `isServerRunning()` ping check after socket appears handles this — callers do this verification. No change needed in `startRfdbServer()`.

4. **ParallelAnalysisRunner: server started by us vs external server:** When the runner detects an existing server (lines 120–135), it sets `this._serverWasExternal = true` and returns the existing ChildProcess as null. The `stopRfdbServer()` checks `_serverWasExternal` and skips kill if true. This logic is preserved unchanged.

5. **Windows:** Socket paths use Unix socket semantics. This entire codebase is Unix-only (Darwin/Linux per `getPlatformDir()`). No Windows concern.

6. **Concurrent startRfdbServer() calls:** Two callers racing to start the server — both check for socket, both start. Second spawn fails to bind socket (already bound by first). Rust server exits, socket remains from first server. Net result: first server wins, second spawn fails silently. This is the current behavior and is acceptable (not in scope to fix).

---

## Test Plan Summary

| Test | File | Phase | Type |
|------|------|-------|------|
| `startRfdbServer()` throws when binary not found | `StartRfdbServer.test.js` | 1 | Unit |
| `startRfdbServer()` removes stale socket | `StartRfdbServer.test.js` | 1 | Unit |
| `startRfdbServer()` writes PID file when pidPath given | `StartRfdbServer.test.js` | 1 | Unit |
| `startRfdbServer()` does not write PID when no pidPath | `StartRfdbServer.test.js` | 1 | Unit |
| `startRfdbServer()` throws on timeout with binary path in message | `StartRfdbServer.test.js` | 1 | Unit |
| Existing `findRfdbBinary` tests still pass | `FindRfdbBinary.test.js` | — | Unit |
| Manual: `grafema server restart` works | — | 4 | Manual |
| Manual: version appears in stderr on startup | — | 2 | Manual |
| Manual: two projects get separate sockets | — | 1 | Manual |
