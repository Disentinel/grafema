# RFD-40: Rob Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2026-02-17
**Status:** Implementation complete, build passes

---

## Summary

All 5 phases implemented. Build passes cleanly (`pnpm build` — all 8 workspace packages). Dijkstra amendments A-D incorporated.

---

## Phase 1: Create `startRfdbServer()` utility + unify spawn sites

### New file: `packages/core/src/utils/startRfdbServer.ts`

Single authoritative function for spawning rfdb-server. Key decisions:

- **Error handler wired on spawn** (Dijkstra amendment B): Uses a `state` object to capture async spawn errors. The `serverProcess.on('error')` handler stores the error, and the poll loop checks for it before each sleep. This surfaces ENOENT immediately rather than waiting for the full timeout.
- **`--data-dir` passed to spawn args**: `dirname(socketPath)` (= `.grafema/`), matching the Rust server's expectations.
- **Detached + unref always**: All callers want a persistent daemon. `ParallelAnalysisRunner` keeps a reference and calls `.kill()` explicitly when done.
- **PID file conditional**: Only written if both `pidPath` AND `serverProcess.pid` are defined.

### Modified files

**`packages/core/src/storage/backends/RFDBServerBackend.ts`**:
- Removed `_findServerBinary()` method entirely
- Replaced `_startServer()` body (46 lines) with 8-line delegation to `startRfdbServer()`
- Cleaned up imports: removed `existsSync`, `unlinkSync`, `spawn`, `sleep`; `ChildProcess` kept as type-only import

**`packages/cli/src/commands/server.ts`**:
- Replaced inline spawn block (lines 114-186) with `startRfdbServer()` call
- Kept binary resolution logic (CLI flag > config > auto-detect) — this is CLI-specific
- Removed `writeFileSync` and `spawn` imports
- PID file and socket polling now handled by the shared utility

**`packages/core/src/ParallelAnalysisRunner.ts`**:
- Fixed socket path: `'/tmp/rfdb.sock'` -> `join(dirname(mainDbPath), 'rfdb.sock')`
- Reordered: `mainDbPath` computed before `socketPath` (was computed after)
- Replaced hardcoded binary search (release/debug paths + `execSync('cargo build')`) with `findRfdbBinary()`
- Replaced inline spawn with `startRfdbServer()` delegation
- Kept existing server check (ping before spawn) and external server tracking (`_serverWasExternal`)
- Removed unused imports: `fileURLToPath`, `execSync`, `unlinkSync`

**`packages/mcp/src/analysis-worker.ts`** (line 224):
- Fixed socket path: `'/tmp/rfdb.sock'` -> `join(projectPath, '.grafema', 'rfdb.sock')`

**`packages/core/src/index.ts`**:
- Added export of `startRfdbServer` and `StartRfdbServerOptions`

### TS build fix

Initial build failed because TypeScript narrows `let spawnError: Error | null = null` to `never` inside the while loop (it doesn't track async callback mutations). Fixed by using a mutable state object: `const state = { spawnError: null as Error | null }`.

---

## Phase 2: Rust version on startup

**`packages/rfdb-server/src/bin/rfdb_server.rs`** (line 2112):
- Added `eprintln!("[rfdb-server] Starting rfdb-server v{}", env!("CARGO_PKG_VERSION"));`
- Inserted after `let db_path = PathBuf::from(db_path_str);`, before socket/data-dir parsing
- Rust build passes with only pre-existing warnings

---

## Phase 3: Clean up dead code

**`packages/rfdb-server/index.js`**:
- Removed `startServer()` function (was broken — missing db-path positional arg)
- Removed `startServer` from `module.exports`
- Removed unused `spawn` import
- Added `@deprecated` JSDoc to `getBinaryPath()` directing users to `findRfdbBinary()`

**`packages/rfdb-server/index.d.ts`** (Dijkstra amendment C):
- Removed `startServer` function type
- Removed `StartServerOptions` interface
- Added `@deprecated` JSDoc to `getBinaryPath()` type declaration

---

## Phase 4: CLI improvements

**`packages/cli/src/commands/server.ts`**:
- Added `restart` subcommand: stops server if running (shutdown + wait), then starts
- Accepts same options as `start` (`-p, --project` and `-b, --binary`)
- Handles case where server is not running (skip stop, just start)
- Uses `startRfdbServer()` for the start portion

**`package.json` (root)**:
- Added convenience scripts: `rfdb:start`, `rfdb:stop`, `rfdb:status`, `rfdb:restart`
- All alias to `node packages/cli/dist/cli.js server <subcommand>`

---

## Phase 5: Documentation

**`CLAUDE.md`**:
- Replaced hardcoded `/Users/vadim/.local/bin/rfdb-server ...` command with `grafema server start`
- Added `pnpm rfdb:start` as convenience alternative
- Simplified the analyze command example
- Updated Product Gap Policy section to mention `grafema server start/stop/restart/status`

---

## Files changed summary

| File | Change |
|------|--------|
| `packages/core/src/utils/startRfdbServer.ts` | **NEW** — shared spawn utility |
| `packages/core/src/index.ts` | Export new function |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | Delegate `_startServer()`, remove `_findServerBinary()` |
| `packages/core/src/ParallelAnalysisRunner.ts` | Fix socket path, delegate spawn, remove cargo build fallback |
| `packages/cli/src/commands/server.ts` | Delegate spawn, add `restart` subcommand |
| `packages/mcp/src/analysis-worker.ts` | Fix socket path fallback |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Add version eprintln |
| `packages/rfdb-server/index.js` | Remove `startServer()`, deprecate `getBinaryPath()` |
| `packages/rfdb-server/index.d.ts` | Remove `startServer` type, `StartServerOptions` interface |
| `package.json` (root) | Add `rfdb:*` scripts |
| `CLAUDE.md` | Update dogfooding setup docs |

## Dijkstra amendments addressed

| Amendment | Status |
|-----------|--------|
| A (VS Code 4th spawn site) | Out of scope per plan — VS Code extension acknowledged as tech debt |
| B (wire `process.on('error')`) | Implemented via `state.spawnError` pattern |
| C (update `index.d.ts`) | Done — removed `startServer` and `StartServerOptions` |
| D (explicit binaryPath validation) | Handled — spawn error surfaces via error handler, timeout message includes binary path |
