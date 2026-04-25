## Dijkstra Correctness Review — RFD-40

**Verdict:** APPROVE (with two noted non-blocking observations)

**Functions reviewed:**

| Function / Site | File | Verdict |
|----------------|------|---------|
| `startRfdbServer()` | `packages/core/src/utils/startRfdbServer.ts` | APPROVE with observations |
| `RFDBServerBackend._startServer()` | `packages/core/src/storage/backends/RFDBServerBackend.ts` | APPROVE |
| `RFDBServerBackend constructor` (socket path) | same | APPROVE |
| `server.ts restart` subcommand | `packages/cli/src/commands/server.ts` | APPROVE |
| `server.ts start` subcommand | same | APPROVE |
| `server.ts stop` subcommand | same | APPROVE |
| `ParallelAnalysisRunner.startRfdbServer()` | `packages/core/src/ParallelAnalysisRunner.ts` | APPROVE |
| `ParallelAnalysisRunner.run()` socket path derivation | same | APPROVE |
| `analysis-worker.ts` socket path | `packages/mcp/src/analysis-worker.ts` | APPROVE |
| `StartRfdbServer.test.js` — 10 tests | `test/unit/StartRfdbServer.test.js` | APPROVE with gaps noted |

---

## Enumeration: `startRfdbServer()` (127 lines)

### Input universe for `options`

| Field | Possible values | Handled? |
|-------|----------------|----------|
| `dbPath` | any string (absolute/relative/empty string) | YES — passed to spawn as-is; no validation, but this is a spawn arg, acceptable |
| `socketPath` | any string | YES — used as-is |
| `binaryPath` | string \| undefined | YES — if truthy, used; else `findRfdbBinary()` |
| `pidPath` | string \| undefined | YES — only written if both `pidPath` AND `serverProcess.pid` are truthy |
| `waitTimeoutMs` | number \| undefined | YES — defaults to 5000 |
| `logger` | `{debug}` \| undefined | YES — optional chaining `?.debug` |
| `_deps` | object \| undefined | YES — each dep falls back to real impl |

### Condition completeness: binary resolution (line 65)

```typescript
const binaryPath = options.binaryPath || _findRfdbBinary();
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| `options.binaryPath` = truthy non-empty string | use it | YES |
| `options.binaryPath` = empty string `""` | falsy → call `findRfdbBinary()` | YES — `""` is falsy, correct behaviour |
| `options.binaryPath` = undefined | call `findRfdbBinary()` | YES |
| `findRfdbBinary()` returns null | throw | YES, line 66-72 |
| `findRfdbBinary()` returns a string | use it | YES |

No gap here.

### Condition completeness: stale socket removal (lines 75-77)

```typescript
if (_existsSync(socketPath)) {
  _unlinkSync(socketPath);
}
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| Socket file does not exist | skip unlink | YES |
| Socket file exists (stale) | remove it | YES |
| `unlinkSync` throws (e.g., permission denied) | propagates as unhandled exception | YES — acceptable, spawn cannot proceed if socket is stuck |

No gap here.

### Condition completeness: `dataDir` derivation (line 79)

```typescript
const dataDir = dirname(socketPath);
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| `socketPath` = `/a/b/c.sock` | `dataDir` = `/a/b` | YES |
| `socketPath` = `c.sock` (no directory component) | `dataDir` = `.` | ACCEPTABLE — rfdb-server will interpret `--data-dir .` as cwd; callers always provide absolute paths in practice |
| `socketPath` = empty string | `dataDir` = `.` | Same observation |

**OBSERVATION 1 (non-blocking):** `dataDir` is derived from `socketPath`, not from `dbPath`. If a caller passes a `socketPath` in a different directory from the database (e.g., `/tmp/mysock.sock` with `dbPath` in `/project/.grafema/`), the `--data-dir` argument would point to `/tmp/` rather than `/project/.grafema/`. This is a design choice: the utility trusts callers to align these paths. All current call sites do align them (constructor derives `socketPath` from `dirname(dbPath)`, CLI uses `getProjectPaths()` which derives both from the same `.grafema` dir). Not a defect — but fragile if a new call site is added carelessly.

### Loop termination: socket poll (lines 104-114)

```typescript
const maxAttempts = Math.ceil(waitTimeoutMs / 100);
let attempts = 0;
while (!_existsSync(socketPath) && attempts < maxAttempts) {
  if (state.spawnError) { throw ... }
  await sleep(100);
  attempts++;
}
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| `waitTimeoutMs` = 0 | `maxAttempts` = 0, loop body never executes | YES — falls straight to final check (line 117), throws timeout immediately |
| `waitTimeoutMs` = 100 | `maxAttempts` = 1, one poll attempt | YES |
| `waitTimeoutMs` = 5000 (default) | up to 50 polls | YES |
| `waitTimeoutMs` = negative | `Math.ceil(negative/100)` = negative, condition `attempts < negative` is immediately false | YES — loop never executes, falls to final check, throws immediately. Acceptable. |
| Socket appears before first poll | condition `!existsSync` is false, loop skips | YES |
| `state.spawnError` set during poll | throws with error detail | YES |
| Loop completes with socket never appearing | falls to final check, throws timeout | YES |

Loop always terminates. No infinite loop possible: `attempts` strictly increments, `maxAttempts` is finite.

### Invariant after `startRfdbServer()` returns

**Must be true:** socket file exists AND the returned `ChildProcess` is the spawned process.

Verification: the final `_existsSync(socketPath)` check on line 117 guarantees the socket is present before returning. The function returns `serverProcess` which is the value returned by `_spawn`. **Invariant holds.**

### OBSERVATION 2 (non-blocking): race window between poll success and return

The function verifies `_existsSync(socketPath)` before returning, then returns the process. The CLI `server start` action then calls `isServerRunning()` a second time for verification. This double-check adds robustness. The gap: in the 0ms between `existsSync` returning `true` and the caller connecting, the server could crash and remove the socket. This is an inherent TOCTOU in process management and is acceptable for this domain.

---

## Enumeration: `RFDBServerBackend._startServer()`

```typescript
private async _startServer(): Promise<void> {
  if (!this.dbPath) {
    throw new Error('dbPath required to start RFDB server');
  }
  await startRfdbServer({
    dbPath: this.dbPath,
    socketPath: this.socketPath,
    waitTimeoutMs: 5000,
    logger: this.silent ? undefined : { debug: (m: string) => this.log(m) },
  });
}
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| `this.dbPath` = undefined | throw descriptive error | YES |
| `this.dbPath` = non-empty string | delegate to `startRfdbServer` | YES |
| `this.silent` = true | logger = undefined (no debug output) | YES |
| `this.silent` = false | logger passes to `this.log()` | YES |

Note: `binaryPath` is NOT passed, so `startRfdbServer` will call `findRfdbBinary()`. This is intentional — `RFDBServerBackend` does not expose a binary path option. Consistent with its role as a connection manager, not a lifecycle manager.

**Invariant:** after `_startServer()` returns without throwing, the socket exists and the server is responsive. Guaranteed by `startRfdbServer`'s final `existsSync` check.

---

## Enumeration: `RFDBServerBackend` constructor — socket path

```typescript
if (options.socketPath) {
  this.socketPath = options.socketPath;
} else if (this.dbPath) {
  this.socketPath = join(dirname(this.dbPath), 'rfdb.sock');
} else {
  this.socketPath = '/tmp/rfdb.sock'; // fallback, not recommended
}
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| `socketPath` provided | use it | YES |
| `socketPath` absent, `dbPath` provided | derive from dbPath directory | YES |
| `socketPath` absent, `dbPath` absent | `/tmp/rfdb.sock` fallback | YES — comment says "not recommended", which is correct; used only if caller provides neither |

All branches covered.

---

## Enumeration: `server.ts` restart subcommand

The restart sequence: stop → start. Two key questions:

**Q1: Does the stop phase terminate if the server was NOT running?**

```typescript
const status = await isServerRunning(socketPath);
if (status.running) {
  // stop logic
}
// (always proceeds to start)
```

| Input | Expected | Handled |
|-------|----------|---------|
| Server not running | skip stop, proceed to start | YES |
| Server running | stop it (send shutdown, wait for socket to vanish), proceed to start | YES |
| Socket exists but server crashed (stale) | `isServerRunning` returns `{ running: false }` → skip stop, proceed to start | YES — `startRfdbServer` removes stale socket |

**Q2: Does the stop wait loop terminate?**

```typescript
let attempts = 0;
while (existsSync(socketPath) && attempts < 30) {
  await sleep(100);
  attempts++;
}
```

Bounded at 30 iterations × 100ms = 3 seconds max. Terminates. If server doesn't stop in 3 seconds, code proceeds anyway and `startRfdbServer` will remove the stale socket via `unlinkSync`. Correct.

**Q3: Binary resolution cascade in restart**

```
options.binary → findServerBinary(options.binary)
config.server.binaryPath → findServerBinary(config.binaryPath)
auto-detect → findServerBinary() // no argument
```

`findServerBinary()` wraps `findRfdbBinary()`. When `explicitPath` is given, `findRfdbBinary` resolves it and returns null if it doesn't exist. `findServerBinary` logs an error in that case and returns null. The `if (!binaryPath) { exitWithError(...) }` guard at the end catches all null cases. Correct.

---

## Enumeration: `ParallelAnalysisRunner` socket path

```typescript
const mainDbPath = (this.graph as unknown as { dbPath?: string }).dbPath
  || join(manifest.projectPath, '.grafema', 'graph.rfdb');
const socketPath = this.parallelConfig.socketPath
  || join(dirname(mainDbPath), 'rfdb.sock');
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| `graph.dbPath` set, `parallelConfig.socketPath` absent | socket = sibling of dbPath | YES |
| `graph.dbPath` absent, `parallelConfig.socketPath` absent | dbPath derived from projectPath, socket from its dirname | YES |
| `parallelConfig.socketPath` set explicitly | used directly | YES |

**Previously:** hardcoded `/tmp/rfdb.sock`. **Now:** derived from dbPath directory. Correct fix.

---

## Enumeration: `analysis-worker.ts` socket path

```typescript
const socketPath = config.analysis?.parallel?.socketPath
  || join(projectPath, '.grafema', 'rfdb.sock');
```

| Input category | Expected | Handled |
|---------------|----------|---------|
| config has explicit socketPath | used | YES |
| config absent or no socketPath | `.grafema/rfdb.sock` under projectPath | YES |

**Previously:** hardcoded `/tmp/rfdb.sock`. **Now:** derived from project. Correct fix.

---

## Enumeration: Test coverage gaps

Tests verified against the implementation:

| Behaviour tested | Test exists? | Verdict |
|-----------------|-------------|---------|
| Binary not found → descriptive error | YES (test 1) | OK |
| Explicit binaryPath skips findRfdbBinary | YES (test 2) | OK |
| Stale socket removed before spawn | YES (test 3) | OK |
| PID file written with correct content | YES (test 4) | OK |
| No PID file when pidPath absent | YES (test 5) | OK |
| No PID file when process.pid undefined | YES (test 6) | OK |
| Timeout error contains binary path and timeout | YES (test 7) | OK |
| Logger.debug called | YES (test 8) | OK |
| process.on("error") wired | YES (test 9) | OK |
| Correct spawn arguments | YES (test 10) | OK |

**Gap 1:** No test for `waitTimeoutMs = 0` edge case. Not blocking — the code path is safe (loop never executes, final check fails, throws). But the test for "immediate timeout" uses `waitTimeoutMs: 200` and a never-appearing socket, which exercises the normal timeout path, not the zero-timeout edge case.

**Gap 2:** No test for the case where `state.spawnError` is set mid-poll (i.e., process emits 'error' while polling). The error handler is verified to be wired (test 9), but the effect on the poll loop is not tested. Not blocking — the code reads `state.spawnError` inside the loop and would throw with the specific error detail.

**Gap 3:** The test "uses explicit binaryPath" (test 2) creates a `mockExistsSync` that makes the socket appear immediately. But it passes `findRfdbBinary: () => '/other/path'` to `_deps`. Since `findRfdbBinary` is the injected dep and `options.binaryPath` is set, `findRfdbBinary` is never called — which the test correctly asserts. However, the test does NOT inject `existsSync` for the poll phase with an actual matching path (it uses `createMockExistsSync(socketPath, 0)` which uses `socketPath` as the matching path). This works correctly.

Test coverage is solid. The three gaps are non-blocking minor edge cases.

---

## Issues found

**ISSUE 1 (Observation, non-blocking):** `startRfdbServer.ts:79` — `dataDir` is derived from `socketPath` via `dirname()`, not from `dbPath`. If a caller passes a `socketPath` outside the database directory (e.g., `/tmp/myapp.sock` with `dbPath` at `/project/.grafema/graph.rfdb`), the server's `--data-dir` argument will be wrong (`/tmp/` instead of `/project/.grafema/`). This is not a defect in the current codebase since all call sites correctly align these paths, but it is a latent correctness trap for future callers. Suggest a comment in the function doc.

**ISSUE 2 (Observation, non-blocking):** `server.ts` `stop` command (line 219-222): after sending shutdown, the code polls `existsSync(socketPath)` up to 30 times (3 seconds). If the server removes the socket file but keeps the process alive briefly, the stop command reports "Server stopped" while the process may still be running. This is acceptable for a CLI tool — PID management would be needed for strict guarantees, and PID file support exists for that purpose.

No REJECT-level correctness defects found.

---

## Summary

The implementation is correct. All input categories are handled, all loops terminate, and the post-conditions (socket exists, process returned) are guaranteed before each function returns. The two observations are documentation/design notes, not defects. Test coverage is adequate for the core contract.
