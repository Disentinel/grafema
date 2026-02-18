# RFD-40: Exploration Report — RFDB Server Coupling

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-17
**Task:** Simplify RFDB binary discovery, startup, and path handling

---

## 1. Current Architecture (Text Diagram)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         RFDB Binary Discovery                                    │
│                                                                                  │
│  findRfdbBinary()  [packages/core/src/utils/findRfdbBinary.ts]                  │
│                                                                                  │
│  Priority order:                                                                 │
│  1. explicitPath (from config.binaryPath or --binary flag)                       │
│  2. GRAFEMA_RFDB_SERVER env var                                                   │
│  3. monorepo target/release/rfdb-server  (dev build)                            │
│  4. monorepo target/debug/rfdb-server   (dev build)                             │
│  5. PATH lookup                                                                   │
│  6. @grafema/rfdb npm package prebuilt                                           │
│  7. ~/.local/bin/rfdb-server                                                     │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                       Entry Points (3 separate spawn sites)                      │
│                                                                                  │
│  1. RFDBServerBackend._startServer()   [core]        — auto-start, detached    │
│  2. grafema server start               [cli/server]  — explicit start, detached │
│  3. ParallelAnalysisRunner.startRfdbServer() [core]  — parallel mode, detached  │
│                                                                                  │
│  Each site calls findRfdbBinary() independently and spawns independently         │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                       Path Configuration (fragmented)                            │
│                                                                                  │
│  Socket path derivation:                                                         │
│  - RFDBServerBackend: options.socketPath || dirname(dbPath)/rfdb.sock           │
│    fallback: '/tmp/rfdb.sock'  ← PROBLEM: /tmp is shared globally              │
│  - AnalysisQueue: parallelConfig.socketPath || '/tmp/rfdb.sock' ← PROBLEM      │
│  - ParallelAnalysisRunner: parallelConfig.socketPath || '/tmp/rfdb.sock'        │
│  - analysis-worker.ts: config.analysis.parallel.socketPath || '/tmp/rfdb.sock' │
│  - CLI server command: always .grafema/rfdb.sock  (correct)                     │
│  - doctor checks: always .grafema/rfdb.sock       (correct)                     │
│                                                                                  │
│  DB path: always absolute: join(projectPath, '.grafema', 'graph.rfdb')          │
│                                                                                  │
│  Socket passed to Rust: rfdb-server <db-path> --socket <socket-path>            │
│  Rust default if no --socket given: /tmp/rfdb.sock                              │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                     End-to-End Flow: grafema analyze                             │
│                                                                                  │
│  User runs: grafema analyze                                                      │
│    → analyzeAction.ts                                                            │
│    → new RFDBServerBackend({ dbPath, autoStart: false })                         │
│    → backend.connect()                                                           │
│       → tries to ping .grafema/rfdb.sock                                        │
│       → if not running AND autoStart=false → error: "run grafema server start" │
│    ← user must run "grafema server start" first                                  │
│                                                                                  │
│  grafema analyze --auto-start (or CI mode):                                      │
│    → analyzeAction.ts                                                            │
│    → new RFDBServerBackend({ dbPath, autoStart: true })                          │
│    → backend.connect()                                                           │
│       → tries to ping → fails                                                    │
│       → _startServer()                                                           │
│          → findRfdbBinary() — searches 7 locations                               │
│          → spawn(binary, [dbPath, '--socket', socketPath], { detached: true })  │
│          → serverProcess.unref() — parent can exit, server keeps running        │
│          → poll 5 seconds for socket to appear                                   │
│       → connect again, ping, negotiate protocol                                  │
│    → run orchestrator                                                             │
│    → backend.close() — server continues running (by design)                     │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                     End-to-End Flow: MCP server                                  │
│                                                                                  │
│  Claude uses MCP tool → MCP server handles request                               │
│    → getOrCreateBackend()   [packages/mcp/src/state.ts]                         │
│    → new RFDBServerBackend({ socketPath: config.socketPath || auto, dbPath })   │
│    → rfdbBackend.connect()  — autoStart defaults to TRUE                        │
│       → if server not running → auto-starts (detached, survives MCP exit)       │
│    → initialize GuaranteeManager, GuaranteeAPI                                   │
│                                                                                  │
│  MCP socketPath source: config.analysis.parallel.socketPath or auto (dbPath)   │
│  Note: MCP uses RFDB autoStart=true by default (no user visible)                │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                     Binary locations (7 locations searched)                      │
│                                                                                  │
│  A. prebuilt in @grafema/rfdb npm package                                        │
│     packages/rfdb-server/prebuilt/{platform}/rfdb-server                        │
│                                                                                  │
│  B. monorepo target/release (Cargo release build)                                │
│     packages/rfdb-server/target/release/rfdb-server                             │
│                                                                                  │
│  C. monorepo target/debug (Cargo debug build)                                   │
│     packages/rfdb-server/target/debug/rfdb-server                               │
│                                                                                  │
│  D. npm bin wrapper (rfdb-server.js → resolves A, B, then ~/.local)             │
│     bin/rfdb-server.js  (installed via npm bin)                                 │
│                                                                                  │
│  E. ~/.local/bin/rfdb-server (user-installed)                                   │
│                                                                                  │
│  F. System PATH lookup                                                            │
│                                                                                  │
│  G. Explicit config: server.binaryPath in config.yaml                           │
│                                                                                  │
│  Additionally: rfdb-server package has its OWN getBinaryPath() in index.js      │
│  (separate from findRfdbBinary() in core — duplicate logic!)                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. All Relevant Files with Key Code Snippets

### 2.1 Binary Discovery

**File:** `packages/core/src/utils/findRfdbBinary.ts`

Search order (7 locations):
```typescript
export function findRfdbBinary(options: FindBinaryOptions = {}): string | null {
  // 1. explicitPath
  // 2. GRAFEMA_RFDB_SERVER env var
  // 3. monorepo target/release/rfdb-server
  // 4. monorepo target/debug/rfdb-server
  // 5. PATH lookup
  // 6. @grafema/rfdb npm package prebuilt
  // 7. ~/.local/bin/rfdb-server
}
```

Monorepo root detection walks from `__dirname` upward, checking for `packages/core` + `packages/rfdb-server/Cargo.toml`.

**Callers:**
- `RFDBServerBackend._findServerBinary()` (delegates to findRfdbBinary())
- `packages/cli/src/commands/server.ts` — `findServerBinary()` wraps findRfdbBinary()
- (ParallelAnalysisRunner has its OWN duplicate binary search — NOT using findRfdbBinary)

### 2.2 Auto-Start Hack (RFDBServerBackend)

**File:** `packages/core/src/storage/backends/RFDBServerBackend.ts`

```typescript
// Auto-start: detached process, parent unref()s it
this.serverProcess = spawn(binaryPath, [this.dbPath, '--socket', this.socketPath], {
  stdio: ['ignore', 'ignore', 'inherit'], // stdin/stdout ignored, stderr inherited
  detached: true, // Allow server to outlive this process
});
this.serverProcess.unref(); // Parent can exit, server keeps running

// Wait for socket to appear (5 seconds max)
while (!existsSync(this.socketPath) && attempts < 50) {
  await sleep(100);
  attempts++;
}
```

Key observations:
- No version check of started binary
- No `--data-dir` argument passed (Rust defaults data-dir to dirname(db_path))
- No PID file written by RFDBServerBackend (only CLI server writes PID file)
- `autoStart` defaults to `true` for backwards compat
- On `close()`, server is NOT killed — intentionally continues running

### 2.3 Duplicate Spawn in ParallelAnalysisRunner

**File:** `packages/core/src/ParallelAnalysisRunner.ts`

```typescript
// Line 46: hardcoded /tmp/rfdb.sock default
const socketPath = this.parallelConfig.socketPath || '/tmp/rfdb.sock';

// Line 119-175: private async startRfdbServer()
// Has its OWN binary search — execSync to find via PATH + ~/.local/bin
// Does NOT use findRfdbBinary() from core utils
private async startRfdbServer(socketPath: string, dbPath: string): Promise<void> {
  // Checks existing server first, then spawns new one
}
```

This is a full duplicate of spawn logic with its own binary search strategy.

### 2.4 Analysis Worker Socket Path

**File:** `packages/mcp/src/analysis-worker.ts` (line 224)

```typescript
// BUG: Falls back to /tmp/rfdb.sock instead of deriving from projectPath
const socketPath = config.analysis?.parallel?.socketPath || '/tmp/rfdb.sock';
```

This is inconsistent with `RFDBServerBackend` which derives socket from `dirname(dbPath)`.

### 2.5 CLI Server Command

**File:** `packages/cli/src/commands/server.ts`

- `start`: finds binary, spawns detached, writes PID file to `.grafema/rfdb.pid`
- `stop`: sends shutdown command via RFDBClient, removes PID file
- `status`: pings socket, reads PID, reports node/edge counts
- `graphql`: starts GraphQL API on top of running RFDB

Socket path is always `join(projectPath, '.grafema', 'rfdb.sock')` — correct per-project.

Spawn args:
```typescript
spawn(binaryPath, [dbPath, '--socket', socketPath], { detached: true })
// Note: NO --data-dir arg. Rust defaults data-dir to dirname(db_path).
```

### 2.6 MCP State

**File:** `packages/mcp/src/state.ts`

```typescript
// Socket from config OR auto-derived from dbPath
const socketPath = (config as any).analysis?.parallel?.socketPath;
const rfdbBackend = new RFDBServerBackend({ socketPath, dbPath });
// autoStart defaults to TRUE — MCP auto-starts without user notice
```

### 2.7 Rust Server Binary

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs`

CLI interface:
```
rfdb-server <db-path> [--socket <socket-path>] [--data-dir <dir>] [--metrics]
```

- Supports `--version` / `-V` → prints `rfdb-server 0.1.0` and exits
- Does NOT print version on startup (only via Hello protocol ping response)
- Does NOT accept relative paths — Rust uses paths as-is from args (absolute expected)
- Prints to `eprintln!` (stderr): `[rfdb-server] Listening on {socket_path}`
- Default socket if no `--socket`: `/tmp/rfdb.sock`
- Default data-dir if no `--data-dir`: `dirname(db_path)`

**Version mismatch:** Cargo.toml says `version = "0.1.0"` but npm package.json says `"version": "0.2.11"`. The `env!("CARGO_PKG_VERSION")` in the Rust code returns `"0.1.0"`, not the npm version.

### 2.8 rfdb-server npm package (wrapper)

**File:** `packages/rfdb-server/index.js`

Has its OWN `getBinaryPath()` — checks only `prebuilt/{platform}/` (no ~/.local/bin, no PATH). Used in `startServer()` which constructs different args than the main launch path:

```javascript
// index.js startServer() uses different args than production spawn!
const args = ['--socket', socketPath, '--data-dir', dataDir];
// No db-path positional arg! This would fail with current CLI interface.
```

This interface is stale relative to the Rust binary's current CLI which requires `<db-path>` as first positional argument.

### 2.9 bin/rfdb-server.js (npm bin wrapper)

**File:** `packages/rfdb-server/bin/rfdb-server.js`

Searches: prebuilt → cargo release → monorepo release → `~/.local/bin`. Passes all args through transparently.

### 2.10 Config Schema

**File:** `packages/core/src/config/ConfigLoader.ts`

`GrafemaConfig` does NOT have an `rfdb` or `server` section. The socket path is stored under:
```
config.analysis.parallel.socketPath  (used by MCP and analysis-worker)
```

The `server.binaryPath` field is mentioned in CLI help text but is not in the `GrafemaConfig` TypeScript type — it's cast as `(config as unknown as { server?: ServerConfig }).server`.

---

## 3. Current Flow End-to-End

### Flow A: Normal user workflow (recommended)

```
1. grafema server start
   → findRfdbBinary() — 7 locations searched
   → spawn(binary, [dbPath, '--socket', .grafema/rfdb.sock], { detached: true })
   → write .grafema/rfdb.pid
   → poll socket, verify ping
   → server runs as background process

2. grafema analyze
   → new RFDBServerBackend({ dbPath, autoStart: false })
   → connect() → ping .grafema/rfdb.sock → success
   → run analysis, flush, close (server stays running)
```

### Flow B: Auto-start (legacy / CI)

```
1. grafema analyze --auto-start
   → new RFDBServerBackend({ dbPath, autoStart: true })
   → connect() → ping fails
   → _startServer()
     → findRfdbBinary() — 7 locations
     → spawn(binary, [dbPath, '--socket', .grafema/rfdb.sock], { detached: true })
     → NO PID file written
     → poll 5 seconds for socket
   → connect, ping, negotiate protocol
   → run analysis
```

### Flow C: MCP server (auto-start default)

```
1. Claude tool invoked
   → getOrCreateBackend()
   → new RFDBServerBackend({ socketPath: config.analysis?.parallel?.socketPath || auto, dbPath })
   → autoStart defaults to TRUE
   → if server not running → auto-starts silently
   → backend shared across all MCP tool calls (singleton)
```

### Flow D: Parallel analysis (queue-based)

```
1. Orchestrator detects parallel config enabled
   → ParallelAnalysisRunner.run()
   → socketPath = config.socketPath || '/tmp/rfdb.sock'  ← WRONG for multi-project
   → ParallelAnalysisRunner.startRfdbServer()  ← duplicate spawn logic
   → AnalysisQueue workers connect to same socket
```

---

## 4. Pain Points Confirmed and Discovered

### 4.1 Too Many Binary Locations (CONFIRMED)

7 search locations in `findRfdbBinary()`, plus duplicate logic in:
- `packages/rfdb-server/index.js` `getBinaryPath()` (only checks prebuilt)
- `packages/rfdb-server/bin/rfdb-server.js` `getBinaryPath()` (4 locations)
- `ParallelAnalysisRunner.startRfdbServer()` (own binary search, does NOT use findRfdbBinary)

Result: 3 separate binary discovery implementations. They disagree on search order and locations.

### 4.2 Auto-Start is Fragile (CONFIRMED)

- Spawns detached, `unref()`d — zombie process if socket creation fails
- No PID file written during auto-start (only CLI `server start` writes PID)
- No version validation of spawned binary
- Poll-wait (50 × 100ms = 5 seconds) with no backoff or progress feedback
- If binary crashes immediately, error is "socket not created after Xms" with no root cause

### 4.3 `/tmp/rfdb.sock` Global Fallback (DISCOVERED/CONFIRMED)

Four places hardcode `/tmp/rfdb.sock` as fallback:
1. `RFDBServerBackend` constructor (when no socketPath AND no dbPath)
2. `AnalysisQueue` (line 145): `this.socketPath = options.socketPath || '/tmp/rfdb.sock'`
3. `ParallelAnalysisRunner` (line 46): `parallelConfig.socketPath || '/tmp/rfdb.sock'`
4. `analysis-worker.ts` (line 224): `config.analysis?.parallel?.socketPath || '/tmp/rfdb.sock'`

This breaks multi-project isolation: two projects running in parallel share one socket.

### 4.4 No Version Validation on Auto-Start (CONFIRMED)

The binary is discovered and launched without version check. Version is available via:
- Rust binary: `rfdb-server --version` → `rfdb-server 0.1.0`
- Protocol: ping response includes `version` field

But auto-start never checks if the binary version matches what Grafema expects.

**Additional discovery:** Rust Cargo.toml `version = "0.1.0"` does not match npm `"version": "0.2.11"`. Two separate versioning schemes with no validation between them.

### 4.5 Absolute Paths Only (PARTIALLY CONFIRMED)

The Rust binary accepts the db-path argument as a string and uses it as-is. If a relative path is passed, Rust's `PathBuf::from()` will accept it but the path resolves relative to the server's working directory (not the user's). The TS layer always constructs absolute paths via `resolve()` or `join(projectPath, ...)`, so this is mitigated in practice. But configuration (e.g., `config.yaml server.binaryPath`) that accepts user-provided paths uses `resolve()` only in the CLI path — the `findRfdbBinary()` with `explicitPath` does `resolve(options.explicitPath)` which handles relative paths correctly.

Socket path from CLI `server start` is always absolute. **Risk area:** analysis-worker.ts uses `config.analysis.parallel.socketPath` directly without resolve.

### 4.6 Stale Documentation in CLAUDE.md (CONFIRMED)

CLAUDE.md says:
```bash
# Start RFDB server (from project root)
/Users/vadim/.local/bin/rfdb-server .grafema/graph.rfdb --socket .grafema/rfdb.sock --data-dir .grafema &
```

This is the OLD manual start approach. Current workflow has `grafema server start` command which is the correct way. The manual command is also wrong: it passes `.grafema/rfdb.sock` (relative path) which resolves relative to wherever the command runs — only correct if run from project root.

### 4.7 `analysis-worker.ts` Socket Path Mismatch (DISCOVERED)

The analysis worker uses:
```typescript
const socketPath = config.analysis?.parallel?.socketPath || '/tmp/rfdb.sock';
```

But the MCP state creates RFDBServerBackend with:
```typescript
const socketPath = (config as any).analysis?.parallel?.socketPath;
// If undefined, RFDBServerBackend derives: dirname(dbPath) + '/rfdb.sock' = .grafema/rfdb.sock
```

If `config.analysis.parallel.socketPath` is not set, the MCP server uses `.grafema/rfdb.sock` but the analysis worker falls back to `/tmp/rfdb.sock`. They would connect to DIFFERENT servers.

### 4.8 rfdb-server/index.js `startServer()` Has Wrong CLI Interface (DISCOVERED)

The `startServer()` function in `packages/rfdb-server/index.js` passes:
```javascript
const args = ['--socket', socketPath, '--data-dir', dataDir];
// Missing: <db-path> positional argument (REQUIRED by current Rust binary)
```

The Rust binary requires `<db-path>` as first positional arg. This function would cause the Rust server to print usage and exit with error code 1. It appears `startServer()` from `index.js` is not used in the production code path — but it's dead/broken API.

### 4.9 No Clean Lifecycle API (CONFIRMED)

- `grafema server start/stop/status` exist for the explicit lifecycle
- But `RFDBServerBackend` (used by MCP and analysis-worker) has no `stopServer()` method
- The `close()` method explicitly does NOT kill the server process:
  ```typescript
  // NOTE: We intentionally do NOT kill the server process.
  this.serverProcess = null;
  ```
- No `restart` command in CLI

### 4.10 Three Spawn Sites with Duplicate Logic (DISCOVERED)

Three places independently spawn rfdb-server:
1. `RFDBServerBackend._startServer()` — auto-start path
2. `packages/cli/src/commands/server.ts` start command — explicit path
3. `packages/core/src/ParallelAnalysisRunner.ts` — parallel mode

Each has slightly different behavior:
- PID file: only CLI server writes it
- `--data-dir`: none of them pass it explicitly (rely on Rust default)
- socket wait timeout: RFDBServerBackend=5s, CLI=10s, ParallelAnalysisRunner=3s
- binary search: #1 uses `findRfdbBinary()`, #2 wraps `findRfdbBinary()`, #3 has own search

---

## 5. Questions for Planning Phase

### Q1: What is the desired server lifecycle model?
Options:
- A) System service (launchd/systemd) — start once at OS boot, always available
- B) Per-project daemon — `grafema server start` per project, survives shell
- C) Per-process auto-start — each grafema invocation ensures server is running

Currently: mix of B and C. CLAUDE.md auto-start policy says "MCP auto-starts RFDB". Desired outcome says "one command startup" — implies B.

### Q2: Should MCP continue to auto-start silently, or require explicit `grafema server start`?
MCP currently auto-starts by default (`autoStart: true`). If we move to explicit lifecycle, MCP may need to fail with a helpful error if server is not running. This affects UX for Claude Code users.

### Q3: Version validation: how strict?
- Match exact CARGO_PKG_VERSION? (currently `0.1.0` for Rust, `0.2.11` for npm)
- Validate via protocol Hello response? (server returns version on every ping)
- Validate Rust version only, or also npm wrapper version?
- Currently there's a versioning mismatch: npm says `0.2.11`, Rust says `0.1.0` — should they be unified?

### Q4: Should we eliminate auto-start from RFDBServerBackend entirely?
The `autoStart: true` default is described as "for backwards compat" in the code. Is backwards compat still needed, or can we make explicit start the only mode?

### Q5: Relative path support — where exactly?
The task says "relative path support". What paths need to be relative?
- `config.yaml server.binaryPath` — currently must be absolute (resolved via `resolve()`)
- socket path — currently derived as absolute from dbPath
- `config.yaml services[].path` — already validates must be relative to project root
- CLI flags `--project` — currently uses `resolve(options.project)`

The Rust binary itself does not need relative path support since the TS layer always resolves before passing. Where does the user feel the pain of absolute paths?

### Q6: Single source of truth for binary — is @grafema/rfdb the canonical package?
The desired outcome implies one place to get the binary. The `@grafema/rfdb` npm package already ships prebuilt binaries. Should `findRfdbBinary()` be simplified to: prebuilt (from @grafema/rfdb) > explicit config > ~/.local/bin, removing the monorepo dev paths and PATH lookup? Or should dev workflow (building from source) remain supported?

### Q7: PID file — who owns it?
Currently only `grafema server start` writes `.grafema/rfdb.pid`. Auto-start (RFDBServerBackend) does not. Should all start paths write a PID file? This enables `grafema server stop` to work regardless of how the server was started.

### Q8: The analysis-worker.ts socket path mismatch — is this a bug?
The worker uses `/tmp/rfdb.sock` as fallback while the MCP backend uses `.grafema/rfdb.sock`. If `config.analysis.parallel.socketPath` is not set, they connect to different servers. This appears to be a real bug — should it be fixed as part of RFD-40 or a separate issue?

### Q9: Dead API in rfdb-server/index.js — remove or fix?
`startServer()` in `packages/rfdb-server/index.js` passes wrong args to the Rust binary (no positional `<db-path>`). Should it be removed, fixed, or left as-is?

---

## 6. Summary of Key Files

| File | Purpose | Pain Points |
|------|---------|-------------|
| `packages/core/src/utils/findRfdbBinary.ts` | Binary discovery (7 locations) | 7 locations, duplicate of index.js and bin/rfdb-server.js |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | Auto-start + client | Auto-start hack, no PID, no version check |
| `packages/cli/src/commands/server.ts` | Explicit lifecycle CLI | start/stop/status/graphql subcommands |
| `packages/core/src/ParallelAnalysisRunner.ts` | Parallel analysis spawn | Own binary search, `/tmp/rfdb.sock` fallback |
| `packages/mcp/src/state.ts` | MCP backend init | Silent auto-start, socket from wrong config path |
| `packages/mcp/src/analysis-worker.ts` | MCP analysis worker | Wrong socket fallback (`/tmp/rfdb.sock`) |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Rust server binary | No version at startup, default `/tmp/rfdb.sock` |
| `packages/rfdb-server/index.js` | npm package wrapper | Broken startServer() args, separate getBinaryPath() |
| `packages/rfdb-server/bin/rfdb-server.js` | npm bin entrypoint | 4-location search, separate from findRfdbBinary() |
| `packages/core/src/config/ConfigLoader.ts` | Config schema | No rfdb section, binaryPath is untyped hack |
| `CLAUDE.md` | Docs | Stale manual rfdb-server command |

---

## 7. Metrics Snapshot

The current system has:
- **3 binary discovery implementations** (findRfdbBinary, index.js getBinaryPath, bin/rfdb-server.js getBinaryPath)
- **3 spawn sites** (RFDBServerBackend, CLI server, ParallelAnalysisRunner)
- **4 places with `/tmp/rfdb.sock` hardcoded** (potential multi-project conflicts)
- **0 version checks** on binary before starting
- **1 broken API** (index.js startServer with wrong args)
- **2 version numbering schemes** out of sync (Rust: 0.1.0, npm: 0.2.11)
- **1 confirmed socket mismatch bug** (analysis-worker vs MCP state)
