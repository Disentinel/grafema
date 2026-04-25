## Dijkstra Correctness Review (v3)

**Verdict:** APPROVE

**Functions reviewed:**
- `resolveBinaryPath(projectPath, explicitBinary?)` — APPROVE
- `stopRunningServer(socketPath, pidPath)` — APPROVE
- `startRfdbServer` (packages/core/src/utils/startRfdbServer.ts) — no changes from v1/v2, not re-enumerated

---

### Verification Method

For each extracted helper: (1) enumerated all input categories, (2) traced every branch in extracted code, (3) compared branch-by-branch against the original inline code in the diff.

---

### `resolveBinaryPath(projectPath: string, explicitBinary?: string): string | null`

**Input universe (all categories of `explicitBinary`):**

| `explicitBinary` | `loadConfig` outcome | `serverConfig?.binaryPath` | Return value |
|---|---|---|---|
| Provided (non-empty string) | not called | not checked | `findServerBinary(explicitBinary)` — string or null |
| `undefined` | throws (no config) | not checked | catch block → `findServerBinary()` |
| `undefined` | succeeds, no `server` key | `undefined` (falsy) | falls through to `findServerBinary()` |
| `undefined` | succeeds, `server.binaryPath` set | truthy string | `findServerBinary(configPath)` — string or null |

All four cases are covered. No missing branch.

**Semantic equivalence with original inline code:**

Original `start` handler used a `let binaryPath: string | null = null` with nested `if/else if/if (!binaryPath)` structure. The extracted function's `return` at each branch is equivalent — the original code set the variable and either fell through (for config-found case) or continued. In the config-found case, the original set `binaryPath` and then the outer `if (!binaryPath)` was false, so auto-detect was skipped. The extraction returns early from the config branch via `return findServerBinary(serverConfig.binaryPath)`, which is semantically identical — no double-call of `findServerBinary()` occurs.

**Precondition:** `loadConfig` may throw for any reason (no config file, malformed YAML, etc.). The `try/catch` with no re-throw covers all exception types. This is the same behavior as the original.

**Loop/termination:** No loops. N/A.

**Invariant:** Returns either a non-null string (path found) or `null` (not found). Both callers (`start` and `restart`) check for `null` and call `exitWithError`. Correct.

---

### `stopRunningServer(socketPath: string, pidPath: string): Promise<void>`

**Input universe — socket/pid state combinations:**

| Socket exists at call | Client can connect | shutdown throws | Socket disappears | pidPath file exists |
|---|---|---|---|---|
| No (gone before call) | n/a | n/a | loop skips immediately | yes → unlinked |
| No (gone before call) | n/a | n/a | loop skips immediately | no → nothing |
| Yes | Yes | No (or server closes) | within 30 polls | yes → unlinked |
| Yes | Yes | No (or server closes) | never disappears | yes → unlinked |
| Yes | No (ECONNREFUSED etc.) | catch fires | within 30 polls | no → nothing |
| Yes | No | catch fires | never disappears | yes → unlinked |

All six cases handled. No missing branch.

**Loop termination proof:** `while (existsSync(socketPath) && attempts < 30)`. `attempts` initializes to `0`, increments unconditionally on each iteration. `attempts < 30` becomes false after exactly 30 iterations. No dependency on external state for the counter — guaranteed termination in at most 30 * 100ms = 3 seconds regardless of socket behavior.

**Semantic equivalence with original inline code in `stop` handler:**

Original (lines removed in diff):
```
const client = new RFDBClient(socketPath);
client.on('error', () => {});
try { await client.connect(); await client.shutdown(); } catch {}
let attempts = 0;
while (existsSync(socketPath) && attempts < 30) { await sleep(100); attempts++; }
if (existsSync(pidPath)) { unlinkSync(pidPath); }
```

Extracted `stopRunningServer` is line-for-line identical in logic. No semantic change.

**Note on `restart` command:** `stopRunningServer` is also called from the new `restart` command. The `restart` command only calls `stopRunningServer` when `status.running` is true (i.e., `isServerRunning` returned running). This is the same precondition as the `stop` handler — correct usage.

**Invariant after return:** Socket file is either gone (server stopped) or still present (server did not stop within 3 seconds — caller receives no error, but `start`/`restart` will subsequently detect this via `isServerRunning` or `startRfdbServer` failing). This is acceptable behavior and matches the original.

---

### `startRfdbServer` (packages/core/src/utils/startRfdbServer.ts)

No changes from v2 review. Not re-enumerated. Previous APPROVE stands.

---

### Summary

Both extracted helpers are exact semantic extractions of their inline originals. No input category is unhandled. Loop termination is guaranteed. No invariant violations. The v3 refactoring is behaviorally identical to the pre-extraction code.
