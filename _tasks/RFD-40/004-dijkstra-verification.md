# RFD-40: Dijkstra Plan Verification

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-17
**Plan reviewed:** `003-don-plan.md`

---

## Dijkstra Plan Verification

**Verdict:** REJECT

**Completeness tables:** 5 built

**Gaps found:** 4 (one critical, three significant)

**Precondition issues:** 2

---

## 1. `startRfdbServer()` — Decision Point Enumeration

### 1.1 Binary resolution

| Input category | Expected behavior | Handled by plan? |
|----------------|------------------|-----------------|
| `binaryPath` option provided, file exists, executable | Use it | YES — `options.binaryPath || findRfdbBinary()` |
| `binaryPath` option provided, file does NOT exist | Should throw with descriptive error | NO — `findRfdbBinary()` receives no explicitPath, falls through to auto-search; caller's explicit path is silently ignored |
| `binaryPath` option absent, `findRfdbBinary()` returns a valid path | Use found path | YES |
| `binaryPath` option absent, `findRfdbBinary()` returns null | Throw descriptive error | YES — plan says "throws if null" |
| `findRfdbBinary()` returns path that exists but is NOT executable (permission bit missing) | Spawn will fail; error surfaces as socket-wait timeout, not "not executable" | NO — plan does not check executability, error message will be misleading |
| `findRfdbBinary()` returns path to wrong binary (old version) | Server starts, wrong protocol version | DEFERRED — plan explicitly defers version validation to separate issue; acceptable |

**Gap 1 (Significant): When the caller passes `binaryPath`, the plan uses `options.binaryPath || findRfdbBinary()`. If the explicit path does not exist, `options.binaryPath` is truthy (it's a non-empty string), so `findRfdbBinary()` is NOT called — the non-existent path is passed directly to `spawn()`. The spawn() call will either fail with ENOENT (surfaces as spawn error event, not thrown) or silently fail since stderr is inherited. The socket wait will time out and the error message says "failed to start after Xms — check binary: Y". This is acceptable since Y shows the path. However, Rob must ensure the `error` event on the process is captured and surfaced before the timeout error, not dropped. The plan shows `_findServerBinary()` being removed and the RFDBServerBackend path passes no `binaryPath` — that path is safe. But CLI server.ts passes `binaryPath` directly, so this must be handled.**

### 1.2 Stale socket removal

| Input category | Expected behavior | Handled by plan? |
|----------------|------------------|-----------------|
| Socket file does not exist | Skip removal, proceed | YES — `if (existsSync) unlinkSync` |
| Socket file exists, no process listening | Remove it, proceed | YES |
| Socket file exists AND a server is actively listening | Remove socket — this disconnects the live server's socket. Server may keep running but accept no new connections. | PARTIALLY — plan acknowledges this in Edge Case 1: "callers already check `isServerRunning()` before calling." This is true for ALL three existing callers in production. |
| Socket file is a regular file (not a socket) | `unlinkSync` removes it regardless — correct | YES |
| Socket file exists but `unlinkSync` fails (permissions) | Exception propagates up from `startRfdbServer()` — caller gets an error | IMPLICIT — unhandled OS error, acceptable for now; error message will come from Node, not from us |

**Assessment: Acceptable. The precondition "caller checks isServerRunning() first" is verified in all three existing callers (RFDBServerBackend._startServer has no such check — see Precondition Issue 1 below).**

### 1.3 Spawn

| Input category | Expected behavior | Handled by plan? |
|----------------|------------------|-----------------|
| Binary crashes immediately after spawn | `serverProcess.on('error')` fires; socket never appears; poll times out; throw timeout error | PARTIAL — plan mentions error handler in existing code (RFDBServerBackend lines 248-251) but does NOT specify whether `startRfdbServer()` utility must wire an error handler. If no handler wired, Node emits unhandled error. Rob must be told to wire it. |
| Binary hangs (never creates socket) | Poll times out (waitTimeoutMs), throw | YES |
| Binary starts but can't bind socket (permissions, disk full) | Binary exits with error; socket never appears; timeout fires | YES (subsumed by "socket never appears") |
| Spawn succeeds but binary prints to stderr and exits | stderr is inherited (stdio: inherit), so user sees it; socket times out | YES — `stderr: 'inherit'` means the user/log sees the message |

**Gap 2 (Significant): The plan does NOT explicitly specify that `startRfdbServer()` must attach a `process.on('error', ...)` handler. Without it, if spawn fails with ENOENT (binary not found at the OS level), Node.js throws an unhandled `error` event that crashes the parent process. The existing `RFDBServerBackend` code (lines 248-251) does wire this handler, but the NEW utility function's design is not specified to include one. The plan's test cases do not cover this. Rob must explicitly wire an error handler inside `startRfdbServer()` that captures the error and makes it available for the timeout error message.**

### 1.4 PID file

| Input category | Expected behavior | Handled by plan? |
|----------------|------------------|-----------------|
| `pidPath` provided, `serverProcess.pid` is defined | Write PID file | YES |
| `pidPath` provided, `serverProcess.pid` is undefined | Do NOT write PID file | YES — plan explicitly covers this in Edge Case 2 |
| `pidPath` provided, parent directory does NOT exist | `writeFileSync` throws ENOENT | NOT COVERED — plan does not address this. The CLI always writes to `.grafema/rfdb.pid`; this directory is always created by the analyze flow. Low risk in practice but unspecified. |
| `pidPath` provided, PID file already exists with stale PID | Overwrite it — correct behavior | YES (implicit — `writeFileSync` overwrites) |
| `pidPath` not provided | No PID file written | YES |

**Assessment: The missing-parent-directory case is low risk because CLI's project setup always creates `.grafema/`. Acceptable.**

### 1.5 Socket polling

| Input category | Expected behavior | Handled by plan? |
|----------------|------------------|-----------------|
| Socket appears within timeout | Return `serverProcess` | YES |
| Socket never appears (timeout) | Throw with binary path in message | YES |
| Socket appears briefly then disappears (server crashes during init) | `existsSync` sees it on iteration N, function RETURNS SUCCESS, but caller's subsequent ping fails | NOT COVERED — plan notes this in Edge Case 3: "Socket appears but server not yet accepting connections" but conflates it with "existing isServerRunning() ping check". The actual scenario here is different: socket APPEARS then DISAPPEARS before the polling loop's next check. `existsSync` returns true, function returns, caller tries to connect, gets ENOENT or ECONNREFUSED. The existing callers (`RFDBServerBackend.connect()`) will then fail with a confusing error. This is a pre-existing race condition, not introduced by this plan, and acceptable to leave. |
| Another process creates a non-socket file at socketPath | `existsSync` returns true, function returns, caller gets ECONNREFUSED | Pre-existing; acceptable |

**Assessment: Pre-existing races are not in scope. Plan's handling is correct within its scope.**

---

## 2. Socket Path Derivation — Consumer Enumeration

The plan changes socket path derivation at multiple sites. All consumers must agree.

| Consumer | Before | After | Match? |
|----------|--------|-------|--------|
| `RFDBServerBackend` | `options.socketPath || dirname(dbPath)/rfdb.sock` | UNCHANGED — uses whatever `this.socketPath` is (set in constructor) | OK — RFDBServerBackend's constructor already derives `.grafema/rfdb.sock` from dbPath correctly |
| `ParallelAnalysisRunner` | `parallelConfig.socketPath || '/tmp/rfdb.sock'` | `parallelConfig.socketPath || join(dirname(mainDbPath), 'rfdb.sock')` | OK — matches RFDBServerBackend derivation |
| `analysis-worker.ts` | `config.analysis?.parallel?.socketPath || '/tmp/rfdb.sock'` | `config.analysis?.parallel?.socketPath || join(projectPath, '.grafema', 'rfdb.sock')` | OK — `dirname(join(projectPath, '.grafema', 'graph.rfdb'))` = `join(projectPath, '.grafema')`, so these are equivalent |
| `AnalysisQueue` | `options.socketPath || '/tmp/rfdb.sock'` | UNCHANGED (plan says "keep as-is, caller now always passes correct socketPath") | OK — true if ParallelAnalysisRunner fix is correct |
| CLI `server start` | `join(projectPath, '.grafema', 'rfdb.sock')` | UNCHANGED | OK |
| MCP `state.ts` | `config.analysis?.parallel?.socketPath || auto from dbPath` | UNCHANGED | OK |
| **VS Code `grafemaClient`** | `this.socketPath` (set in constructor) | **NOT IN PLAN** | **GAP** |

**Gap 3 (Critical): The plan claims there are 3 spawn sites. Code inspection reveals FOUR. `packages/vscode/src/grafemaClient.ts` contains a complete, independent spawn implementation (`startServer()` private method, lines 226-263). This fourth site:**
- Has its own binary discovery (`findServerBinary()`, line 140 area)
- Spawns directly: `spawn(binaryPath, [this.dbPath, '--socket', this.socketPath], ...)`
- Is NOT listed in the plan's "Files Modified Summary"
- Is NOT listed under "Pain Points Addressed"

**The VS Code extension is an independent entry point that duplicates the exact pattern this plan is trying to eliminate. The plan's stated goal — "One authoritative function for spawning rfdb-server. All 3 current spawn sites delegate to it" — is factually wrong: there are 4 spawn sites, not 3.**

The plan MUST either:
(a) Include `packages/vscode/src/grafemaClient.ts` in Phase 1 scope, or
(b) Explicitly acknowledge the VS Code extension as out-of-scope with justification

Leaving it unaddressed means Phase 1's goal of unification is incomplete. The socket path mismatch fix (Pain Point 4.7) is also incomplete if the VS Code extension retains its own socket derivation logic.

---

## 3. Phase Sequencing

**Question: Can Phase 3 run independently of Phase 1?**

The plan states Phase 3 (dead code removal from `rfdb-server/index.js`) has "no dependency on Phase 1 or 2." Verified: Phase 3 removes `startServer()` from `index.js`. The `startServer()` in `index.js` is NOT called by Phase 1's new `startRfdbServer()` utility — they are completely separate symbols. Phase 3 can indeed run independently. The order "Phase 1 → Phase 3 → Phase 2 → Phase 4 → Phase 5" is valid.

**Assessment: CORRECT.**

---

## 4. Concurrent Calls — Risk Assessment

The plan classifies concurrent `startRfdbServer()` calls as "acceptable" (Edge Case 6):

> "Second spawn fails to bind socket (already bound by first). Rust server exits, socket remains from first server. Net result: first server wins, second spawn fails silently."

**Verification of the claim:**

The plan says "second spawn fails silently." This requires that:
1. The first server successfully creates the socket
2. The second server attempts to bind the same socket path
3. The second server exits (not crashes the first)
4. The second server's PID is written to the PID file IF `pidPath` is provided

**Issue with point 4:** If two concurrent CLI `server start` calls race, both will call `startRfdbServer({..., pidPath: '.grafema/rfdb.pid'})`. The second spawn exits, but its `serverProcess.pid` was captured before exit. The PID file is written immediately after spawn. Race condition: both write their respective PIDs. The file contains whichever PID was written last. If the second server's PID was written last but the second server exited, the PID file points to a dead process. `grafema server stop` will find the process not running.

**Assessment:** This is a pre-existing class of race condition, not introduced by this refactoring. The plan correctly labels it "acceptable" for single-project use. For multi-user environments this is a real problem, but that's out of scope. ACCEPTABLE.

---

## 5. Dead Code Removal — startServer() in index.js

**Claim:** "`startServer` is not called anywhere in production code (verified by grepping all callers)."

**Verification:** Running the grep specified in the plan:

```
grep -r "startServer" packages/ --include="*.ts" --include="*.js" | grep -v index.js
```

Results from actual code:
- `packages/vscode/src/grafemaClient.ts:111: await this.startServer();` — this is calling the VS Code client's OWN private method, not `@grafema/rfdb`'s `startServer`. NOT an import of `startServer` from the npm package.
- `packages/api/src/server.ts:123: export function startServer` — GraphQL API server, unrelated to rfdb.
- `packages/cli/src/commands/server.ts:369/379` — imports `startServer` from `@grafema/api`, not `@grafema/rfdb`.
- `packages/core/src/storage/backends/RFDBServerBackend.ts:182` — calls `this._startServer()`, internal method.
- `packages/rfdb-server/index.js:49/105` — the function itself.

**Conclusion: `startServer` from `packages/rfdb-server/index.js` has ZERO callers in production TypeScript/JavaScript code.** The plan's claim is correct.

**However:** The `index.d.ts` exports `startServer` as a TypeScript type declaration. Removing it from `index.js` while keeping `index.d.ts` unchanged creates a type/runtime mismatch. External npm consumers who import and call `startServer()` from `@grafema/rfdb` will get `undefined` at runtime while TypeScript thinks it exists. The plan must also update `index.d.ts` to remove `startServer` and `StartServerOptions`.

**Gap 4 (Significant): Phase 3 must also update `packages/rfdb-server/index.d.ts` to remove the `startServer` export and `StartServerOptions` interface. The plan omits `index.d.ts` from the Files Modified Summary.**

---

## 6. Precondition Issues

### Precondition Issue 1: `RFDBServerBackend._startServer()` does NOT check `isServerRunning()` first

The plan states in Edge Case 1: "Callers already check `isServerRunning()` before calling, so this is not `startRfdbServer()`'s responsibility."

Verification: `RFDBServerBackend._startServer()` is called from `connect()`:

```typescript
// RFDBServerBackend.ts line 182 (inferred from grep context):
await this._startServer();
```

The `connect()` method DOES check: it tries to ping first, and only if ping fails AND `autoStart: true` does it call `_startServer()`. So the precondition holds for `RFDBServerBackend`.

For `ParallelAnalysisRunner.startRfdbServer()`: lines 120-135 show it checks `existsSync(socketPath)` + `ping()` before spawning. So the precondition holds.

For CLI `server.ts`: looking at the plan's description, the CLI does call `isServerRunning()` (verification check after start). But does it check BEFORE start? The plan says "Keep the `isServerRunning()` verification call after." Whether there's a pre-check before calling `startRfdbServer()` is not specified but the CLI probably has its own "already running" guard. This should be verified during implementation.

**Assessment: ACCEPTABLE but Rob must verify CLI server.ts pre-check exists.**

### Precondition Issue 2: `mainDbPath` reordering in `ParallelAnalysisRunner`

The plan states: "Note: `mainDbPath` is computed at line 49. Reorder so `mainDbPath` is computed before `socketPath`."

**Verification:** Looking at the actual code:
```typescript
// Line 46:
const socketPath = this.parallelConfig.socketPath || '/tmp/rfdb.sock';
// Line 47:
const maxWorkers = this.parallelConfig.maxWorkers || null;
// Line 49:
const mainDbPath = (this.graph as unknown as { dbPath?: string }).dbPath || join(manifest.projectPath, '.grafema', 'graph.rfdb');
```

The fix requires computing `mainDbPath` before `socketPath`. The plan correctly identifies this dependency. After reordering:
```typescript
const mainDbPath = (this.graph as unknown as { dbPath?: string }).dbPath || join(manifest.projectPath, '.grafema', 'graph.rfdb');
const socketPath = this.parallelConfig.socketPath || join(dirname(mainDbPath), 'rfdb.sock');
```

**What if `mainDbPath` is undefined?** Impossible: the expression `|| join(manifest.projectPath, '.grafema', 'graph.rfdb')` guarantees a value as long as `manifest.projectPath` is defined. `DiscoveryManifest` always has `projectPath` set (it's the project root). Cannot be undefined.

**Assessment: CORRECT.**

---

## 7. Summary of Gaps

| # | Severity | Description | Blocking? |
|---|---------|-------------|-----------|
| 1 | Significant | Explicit `binaryPath` that doesn't exist: spawn may fail with unhandled error event if Rob doesn't wire error handler in `startRfdbServer()` | YES — must fix in spec |
| 2 | Significant | `startRfdbServer()` spec does not say to wire `process.on('error')` handler; without it, spawn ENOENT = unhandled Node error | YES — must add to spec |
| 3 | **Critical** | Plan says "3 spawn sites" — actual count is 4. `packages/vscode/src/grafemaClient.ts` has its own complete spawn implementation. Not mentioned in plan at all. | YES — must address |
| 4 | Significant | Phase 3 removes `startServer()` from `index.js` but does not update `index.d.ts`, leaving type/runtime mismatch for external consumers | YES — must fix |

---

## 8. Required Plan Amendments Before Approval

The plan must be amended with the following before implementation begins:

**Amendment A (Gap 3 — Critical):** Add `packages/vscode/src/grafemaClient.ts` to Phase 1 scope, OR explicitly declare it out of scope with justification. The claim "3 spawn sites" must be corrected to "4 spawn sites." The VS Code extension's `startServer()` private method should ideally delegate to the new shared utility (if `@grafema/core` can be imported from VS Code extension), or remain as acknowledged tech debt.

**Amendment B (Gap 2):** Add to `startRfdbServer()` specification: "Wire `serverProcess.on('error', handler)` that captures the error for inclusion in the timeout/failure message." Kent's test list must include: "process.on('error') is wired — simulated ENOENT does not cause unhandled rejection."

**Amendment C (Gap 4):** Add `packages/rfdb-server/index.d.ts` to Phase 3 file changes. Remove `startServer` function type and `StartServerOptions` interface from the `.d.ts` file when removing `startServer` from `index.js`.

**Amendment D (Gap 1):** Add to implementation note for CLI path: "If `binaryPath` option is provided but the path does not exist, `spawn()` will fail. The `error` event handler wired per Amendment B will capture this. Acceptable behavior: error message says 'check binary: <path>'. No additional validation needed."

---

If these amendments are incorporated into the plan (by Don or directly by Rob during implementation), all four gaps are resolvable without architectural changes. The core approach is sound.
