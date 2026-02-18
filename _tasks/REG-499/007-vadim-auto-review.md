# Вадим auto — Completeness Review: REG-499 (Round 2)

## Вадим auto — Completeness Review

**Verdict:** REJECT

**Feature completeness:** ISSUES — watcher does not honor `explicitSocketPath`; original acceptance criteria still unverified
**Test coverage:** ISSUES — no tests for the new configurable socket path; functional verification still not done
**Commit quality:** ISSUES — changes are not committed

---

## Issues

### 1. `startWatching()` ignores `explicitSocketPath` — inconsistent behavior

The prompt claims "all uses go through the getter, so the override works throughout." This is incorrect.

`startWatching()` at line 363 hardcodes:
```typescript
const grafemaDir = join(this.workspaceRoot, GRAFEMA_DIR);
```

And watches for:
```typescript
if (filename === SOCKET_FILE || filename === DB_FILE) {
```

Where `SOCKET_FILE = 'rfdb.sock'` is the constant, not derived from `this.socketPath`.

When `explicitSocketPath` is set to, say, `/tmp/myproject/rfdb.sock`, the watcher watches `{workspaceRoot}/.grafema/` for `rfdb.sock` — the wrong directory for the wrong filename. Server restarts or re-analysis events will never trigger reconnection. The feature is broken for its primary use case: connecting to an external server at a custom socket location.

Three of the four `startServer()` uses correctly go through `this.socketPath`. But `startWatching()` does not. The claim in the prompt is factually wrong.

### 2. Changes not committed

The current `git status` shows all three modified files as unstaged working-tree changes. There are zero commits on this branch (`task/REG-499`) — the branch points to the same commit as `origin/main`. A task cannot be complete with uncommitted work.

### 3. Original acceptance criteria remain unverified from Round 1

The first REJECT (005) called out three unmet criteria that are still unaddressed:

| Criterion | Status |
|-----------|--------|
| Extension connects to rfdb-server v0.2.12 | NOT VERIFIED |
| Node exploration, edge navigation, follow-cursor all work | NOT VERIFIED |
| Bundled binary matches current release | NOT ADDRESSED |

Adding the socket path feature in Round 2 does not resolve these. The round 1 REJECT issues about functional verification and bundled binary are still open.

### 4. No tests for the new `rfdbSocketPath` feature

The configurable socket path is new behavior with observable effects (constructor stores it, getter returns it, passed to `RFDBClient`). There are no unit tests verifying:
- `new GrafemaClientManager(root, undefined, '/tmp/custom.sock').socketPath` returns `'/tmp/custom.sock'`
- Default behavior unchanged when `explicitSocketPath` is `undefined` or empty string
- `extension.ts` reads the config key `'rfdbSocketPath'` correctly

Given the codebase uses `node --test` test files, basic unit coverage is expected for new constructor behavior.

---

## What Was Done Well

- The `explicitSocketPath` field + constructor + getter pattern is clean and correct for `tryConnect()` and `startServer()`.
- `extension.ts` reads the setting correctly using `config.get<string>('rfdbSocketPath') || undefined` (converts empty string to undefined).
- `package.json` setting definition is properly structured with type, default, and description.
- The hardcoded `/Users/vadimr/grafema` removal from Round 1 remains correct.

---

## Required Before APPROVE

1. **Fix `startWatching()`** to derive the watch directory and filename from `this.socketPath` (use `dirname(this.socketPath)` and `basename(this.socketPath)`) so reconnection works when `explicitSocketPath` is set.
2. **Commit** all changes atomically (or as two logical commits: path removal + socket feature).
3. **Address Round 1 open criteria**: Either perform functional verification with v0.2.12 (preferred) or explicitly descope bundled binary and functional testing with justification and a follow-up Linear issue.
