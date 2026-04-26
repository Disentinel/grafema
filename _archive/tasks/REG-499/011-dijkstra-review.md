## Dijkstra Correctness Review — REG-499

**Verdict:** APPROVE (with noted limitations that are acceptable in context)

**Functions reviewed:**
- `constructor` — APPROVE
- `socketPath` getter — APPROVE (with caveat on relative paths)
- `startWatching()` — APPROVE (with noted silent degradation)
- `findServerBinary()` — APPROVE
- `extension.ts` activation — APPROVE

---

### Input Enumeration Per Function

#### `constructor(workspaceRoot, explicitBinaryPath?, explicitSocketPath?)`

| `explicitSocketPath` value | After `|| null` | Correct? |
|---------------------------|-----------------|----------|
| `undefined` (not passed) | `null` | YES — uses default |
| `""` (empty string, VS Code default) | `null` | YES — falsy, uses default |
| `"/absolute/path/to.sock"` | `"/absolute/path/to.sock"` | YES |
| `"/path with spaces/to.sock"` | `"/path with spaces/to.sock"` | YES — `path.join` handles spaces |
| `"./relative.sock"` | `"./relative.sock"` | STORED AS-IS — see socketPath getter |
| `"relative.sock"` (bare name) | `"relative.sock"` | STORED AS-IS — see socketPath getter |

**Verdict:** Correct. The `|| null` pattern correctly collapses the two falsy cases (undefined, empty string) into the default path branch.

---

#### `socketPath` getter

```typescript
return this.explicitSocketPath || join(this.workspaceRoot, GRAFEMA_DIR, SOCKET_FILE);
```

| `explicitSocketPath` value | Returned value | Correct? |
|---------------------------|----------------|----------|
| `null` | `join(workspaceRoot, ".grafema", "rfdb.sock")` | YES — default behavior preserved |
| `"/absolute/custom.sock"` | `"/absolute/custom.sock"` | YES |
| `"./relative.sock"` | `"./relative.sock"` | PARTIAL — relative path is resolved against CWD at use-site, not against workspaceRoot. In VS Code extension host, CWD is not guaranteed to equal workspaceRoot. Result is unpredictable. |
| `"rfdb.sock"` (bare) | `"rfdb.sock"` | PARTIAL — same CWD issue |

**Finding (non-blocking):** A relative path in `grafema.rfdbSocketPath` produces a relative socket path that will be passed to `existsSync()`, `unlinkSync()`, `watch()`, and `RFDBClient`. These will resolve against the process CWD, not the workspace. This is an edge case: the setting description says "Path to RFDB unix socket" which implies the user should supply an absolute path. No code enforces this, but the degradation is predictable (path just won't resolve to the expected location). Since VS Code settings UI and documentation can steer users toward absolute paths, this is a tolerable limitation rather than a correctness bug.

---

#### `startWatching()`

```typescript
const watchDir = dirname(this.socketPath);
const socketFilename = basename(this.socketPath);
if (!existsSync(watchDir)) { return; }
this.socketWatcher = watch(watchDir, (eventType, filename) => {
  if (filename === socketFilename || filename === DB_FILE) { ... }
});
```

| `socketPath` value | `watchDir` | `socketFilename` | Correct? |
|-------------------|------------|-----------------|----------|
| `"/ws/.grafema/rfdb.sock"` (default) | `"/ws/.grafema"` | `"rfdb.sock"` | YES |
| `"/tmp/grafema/rfdb.sock"` (custom) | `"/tmp/grafema"` | `"rfdb.sock"` | YES — watcher placed correctly |
| `"/tmp/custom.sock"` (custom, different name) | `"/tmp"` | `"custom.sock"` | YES — socket file event detected |
| `"rfdb.sock"` (bare relative) | `"."` | `"rfdb.sock"` | RISKY — watches CWD, not workspace |

**Finding 1 (non-blocking):** When a custom socket path is provided, the `DB_FILE` check (`filename === DB_FILE`) watches for `"graph.rfdb"` in `watchDir` (the directory of the custom socket). If the custom socket is in a different directory than the database file (e.g., socket is `/tmp/rfdb.sock`, DB is `/workspace/.grafema/graph.rfdb`), the DB_FILE condition will never match in the custom-socket watcher. The watcher only detects DB changes in the default workflow where socket and DB are co-located in `.grafema/`. This is silent degradation (reconnect on DB change won't trigger), not a crash. Acceptable in context of this PR scope.

**Finding 2 (non-blocking):** If `watchDir` does not exist (new custom directory, server not yet started), `existsSync(watchDir)` returns false and `startWatching()` returns early — no watcher is set up. This means the extension will NOT auto-reconnect when the server later creates the socket. The user would need to trigger a manual reconnect. This is consistent with the existing behavior for the default `.grafema/` directory (same early-return exists there). Not a regression.

---

#### `findServerBinary()`

Removed path: `'/Users/vadimr/grafema'` (developer-specific hardcode).

Remaining search order:
1. Explicit path from VS Code setting (`this.explicitBinaryPath`) — checked with `existsSync`
2. Bundled extension binary (`join(__dirname, '..', 'binaries', 'rfdb-server')`)
3. `GRAFEMA_RFDB_SERVER` environment variable — checked with `existsSync`
4. Monorepo roots via `__dirname` traversal (3 levels: `../../../`, `../../../../`, `../../../../../`)
5. `@grafema/rfdb` npm package — platform-specific binary

| User scenario | Before removal | After removal | Regression? |
|---------------|---------------|---------------|-------------|
| Production install (bundled binary) | Found at step 2 | Found at step 2 | NO |
| npm `@grafema/rfdb` install | Found at step 5 | Found at step 5 | NO |
| Monorepo dev (non-vadimr) | Found at step 4 | Found at step 4 | NO |
| Monorepo dev (vadimr) | Found at step 6 (hardcoded) | Found at step 4 (traversal) | NO — `__dirname` traversal covers it |
| Explicit path configured | Found at step 1 | Found at step 1 | NO |

**Verdict:** No regression. The removed path was a developer-specific fallback that would only match on the original developer's machine. For that developer, the monorepo traversal from `__dirname` reaches the same location. Removal is correct.

**Edge case — all steps fail:** Returns `null`. `startServer()` throws `Error('RFDB server binary not found...')`. This is handled: `startServer()` propagates the error, `connect()` catches it and calls `setState({ status: 'error', message })`. Correct error propagation, no crash.

---

#### `extension.ts` activation — config reading

```typescript
const rfdbSocketPath = config.get<string>('rfdbSocketPath') || undefined;
clientManager = new GrafemaClientManager(workspaceRoot, rfdbServerPath, rfdbSocketPath);
```

| Config value | `config.get<string>()` | After `|| undefined` | Passed to constructor | Result |
|-------------|----------------------|---------------------|----------------------|--------|
| Not set (default `""`) | `""` | `undefined` | `undefined` | `null` in field — uses default path. CORRECT |
| `""` (explicitly set to empty) | `""` | `undefined` | `undefined` | Same as above. CORRECT |
| `"/valid/path.sock"` | `"/valid/path.sock"` | `"/valid/path.sock"` | `"/valid/path.sock"` | Used as socket. CORRECT |
| `null` (type mismatch, shouldn't happen) | `undefined` (VS Code returns undefined for null) | `undefined` | `undefined` | `null` in field — uses default. CORRECT |

**Verdict:** Correct. The two-stage falsiness collapse (`|| undefined` then `|| null`) is redundant but harmless — both stages catch the empty string case.

---

### Issues found

**Non-blocking (noted, not requiring rejection):**

- `socketPath getter` — A relative path stored in `grafema.rfdbSocketPath` would be passed as-is to all file system APIs, resolving against VS Code extension host CWD rather than workspace root. No validation or warning is provided. Mitigation: acceptable because the setting description implies an absolute path and relative paths are an unusual input. Suggested future improvement: validate the path in the constructor or in `extension.ts`.

- `startWatching()` — When `explicitSocketPath` is set to a directory different from the workspace `.grafema/` dir, the `filename === DB_FILE` branch of the watcher callback will never fire (DB file is in a different directory). Auto-reconnect on graph re-analysis will not work in this configuration. Silent degradation, not a crash. Scope of this PR is to support custom socket paths; full watcher support for the custom case would require tracking a separate `dbDir`. Acceptable limitation for v1 of this feature.

- `startWatching()` — If the custom socket directory does not exist at connect time (server not yet started, or server is remote), the early-return means no watcher is ever started. The extension will not auto-detect when the server comes up. Same behavior exists for the default `.grafema/` case — not a regression introduced by this PR.

**No crash paths found.** All error states are handled (existsSync guards, try/catch in startWatching, null return from findServerBinary, error propagation in connect/startServer).

---

### Precondition Issues

None found. The code makes no unverified assumptions about the state of the file system beyond what it checks with `existsSync()` before acting.

---

### Summary

The changes are structurally correct. The `|| null` / `|| undefined` patterns correctly handle VS Code's default empty-string config values. The `dirname`/`basename` decomposition in `startWatching()` correctly generalizes the watch directory. The removal of the hardcoded developer path from `findServerBinary()` introduces no regression for any non-developer-machine scenario. The three non-blocking findings are acceptable limitations given the PR's scope and are not regressions over the prior behavior.
