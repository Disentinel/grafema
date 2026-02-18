## Dijkstra Plan Verification — RFD-42

**Verdict:** APPROVE (with one mandatory clarification noted below)

---

## Completeness Tables

### Table 1: All possible outcomes of `this.client.hello(3)`

The client's `hello()` calls `_send()`, which can resolve or reject. `_send()` throws synchronously if not connected, and rejects if: the socket closes, a timeout fires, or the server returns `response.error`. The plan accounts for two branches — success and catch — which covers the universe.

| Outcome | How it occurs | Handled by plan? |
|---------|---------------|-----------------|
| Resolves with `HelloResponse` | Server understands `hello`, returns valid JSON | YES — read `hello.serverVersion`, compare |
| Rejects with `Error('Not connected...')` | `_send` guard: client is null/disconnected | YES — falls into catch |
| Rejects with timeout Error | `_send` timeout (default 10 s) fires | YES — falls into catch |
| Rejects with connection-closed Error | Socket closes mid-request | YES — falls into catch |
| Rejects with `Error(response.error)` | Server returns `{ ok: false, error: "..." }` | YES — falls into catch |
| Resolves but `hello.serverVersion` is missing/empty | Protocol bug in server: `serverVersion` is declared `string` in the type but the server could omit it | PARTIAL — see Gap 1 |

All throw/reject paths reach the catch branch. The plan says "warn about unknown server version" in the catch. That is correct.

---

### Table 2: All possible `serverVersion` string formats from the server

The server is a Rust binary. Version strings are produced by cargo (Cargo.toml `version` field). Cargo enforces semver strictly, so the set of possible values is constrained — but the client should still be defensive.

| Format | Example | `getSchemaVersion()` result | Notes |
|--------|---------|-----------------------------|-------|
| Stable semver | `"0.2.11"` | `"0.2.11"` | Normal production case |
| Pre-release semver | `"0.2.11-beta"` | `"0.2.11"` | Expected during development |
| Pre-release with dot segment | `"1.0.0-alpha.1"` | `"1.0.0"` | Covered by existing tests |
| Empty string `""` | (server bug) | `""` | `split('-')[0]` on `""` → `""`. Comparison `"" !== "0.2.11"` → mismatch warning fires. Acceptable behavior — a warning is correct here. |
| Missing field (undefined) | (server bug — field typed `string` but omitted) | Would throw `TypeError` | See Gap 1 below |
| Non-semver garbage | `"dev-build"` | `"dev"` | `split('-')[0]` → `"dev"`. Comparison fires mismatch warning. Acceptable — warns the user. |
| Multi-hyphen string | `"0.2.11-rc.1-hotfix"` | `"0.2.11"` | Only first segment before `-` is kept. Correct. |

**Conclusion:** `getSchemaVersion()` handles all realistic server version strings safely. The only unhandled case is a missing field (undefined), because TypeScript's type says `string` but there is no runtime guard — see Gap 1.

---

### Table 3: All possible `serverVersion` values arriving at the comparison site

This table asks: what can `hello.serverVersion` actually be at the moment the comparison runs?

| Value | Source | `getSchemaVersion(hello.serverVersion)` | Warning fires? | Correct? |
|-------|--------|----------------------------------------|----------------|---------|
| `"0.2.11"` (matches client) | Normal operation | `"0.2.11"` | NO | YES |
| `"0.2.10"` (older server) | Stale server process | `"0.2.10"` | YES | YES |
| `"0.2.12"` (newer server) | Server updated, client not | `"0.2.12"` | YES | YES |
| `"0.2.11-beta"` (pre-release, same base) | Dev build | `"0.2.11"` | depends on client version | YES |
| `""` (empty string) | Bug | `""` | YES — mismatch | Acceptable |
| `undefined` (missing field) | Bug | `TypeError: Cannot read properties of undefined` | CRASH, not warn | NO — Gap 1 |

---

### Table 4: Catch-branch side effects

The existing catch branch today only sets `this.protocolVersion = 2`. The plan adds a `warn()` call there. I enumerate all side effects to check for unintended consequences.

| Side effect | Present before plan | Present after plan | Concern? |
|-------------|--------------------|--------------------|---------|
| `this.protocolVersion = 2` | YES | YES (unchanged) | None |
| Warning log emitted | NO | YES | None — this is the intent |
| Exception re-thrown | NO | NO | Correct — we swallow and fall back |
| Connect flow aborted | NO | NO | Correct — warn only, don't fail |
| Warning on every reconnect | Depends on usage | Depends on usage | See Gap 2 |

---

## Gaps Found

### Gap 1 (MINOR): `hello.serverVersion` is not guarded against `undefined` at runtime

**Input:** A server that responds to `hello` but omits `serverVersion` from the JSON payload (protocol bug, old server that partially implements hello but with wrong shape).

**What happens:** `HelloResponse.serverVersion` is typed `string`, but TypeScript types are erased at runtime. The raw response is cast without validation: `const hello = response as HelloResponse`. If the server sends `{ ok: true, protocolVersion: 3, features: [] }` (no `serverVersion`), then `hello.serverVersion` is `undefined` at runtime.

Calling `getSchemaVersion(undefined)` → `undefined.split('-')` → `TypeError: Cannot read properties of undefined (reading 'split')`.

This TypeError would be thrown inside the `try` block, causing it to fall into the `catch` branch — which would emit "warn about unknown server version." So the crash is actually silently swallowed into the catch path.

**Is this acceptable?** The crash never escapes — the catch branch handles it. The behavior is: warn about unknown version, fall back to protocolVersion 2. That is the correct degraded behavior. **No code change required**, but the plan should acknowledge this path explicitly so implementers don't add a `throw` inside the catch (which would change behavior).

**Recommendation:** In the catch branch, the warning message should say "unknown server version (hello failed or returned unexpected format)" — not just "hello command failed" — to cover this subcase clearly.

---

### Gap 2 (MINOR): Warning fires on every `connect()` call if server is stale

`_negotiateProtocol()` is called from `connect()`. If a connection is dropped and re-established (reconnect pattern), the version mismatch warning will fire on every reconnect, potentially spamming logs.

**Is this a blocker?** No. The behavior is correct — a mismatch IS a mismatch. The warning is appropriate each time. This is a UX concern, not a correctness concern.

**Recommendation:** Note this in implementation comments so a future deduplification (warn once per process) is easy to add.

---

### Gap 3 (NON-ISSUE, confirmed): False-warn when both are same base version, different pre-release tags

**Scenario:** Client is `0.2.11-beta`, server is `0.2.11-rc`. `getSchemaVersion` strips pre-release → both yield `"0.2.11"` → no warning. This is the CORRECT behavior — the plan uses `getSchemaVersion()` precisely to avoid this false positive. Confirmed working.

---

## Precondition Issues

### Precondition 1: `this.client` is not null — GUARANTEED

The plan check `if (!this.client) return;` at the top of `_negotiateProtocol()` already exists and is unchanged. The new comparison code runs only after `hello()` succeeds, i.e., inside the `try` body after `await this.client.hello(3)`. The client cannot become null between the guard check and the `await` in a single-threaded Node.js turn (unless explicit `close()` is called concurrently, which is a pre-existing concern unrelated to this plan).

### Precondition 2: `GRAFEMA_VERSION` is a valid string — GUARANTEED

`version.ts` reads it from `package.json` at module load time. `pkg.version` is always a string (npm enforces semver in `package.json`). `getSchemaVersion(GRAFEMA_VERSION)` will always return a non-empty string. No issue.

### Precondition 3: The comparison is `!==`, not structural semver comparison — INTENTIONAL

The plan uses string equality after stripping pre-release tags. This means `"0.2.9"` vs `"0.2.10"` correctly yields a mismatch warning. Major/minor/patch are all compared as a unit. This is correct for schema compatibility — any version difference could mean schema incompatibility.

### Precondition 4: `getSchemaVersion` is pure and has no side effects — CONFIRMED

The implementation is `version.split('-')[0]`. No I/O, no state mutation, no exceptions for valid string input.

---

## Summary

The plan is sound. All realistic input categories are handled. The two gaps found are minor and do not require plan revision:

- Gap 1 (undefined serverVersion) is silently absorbed by the existing catch — implementers just need to know this so they don't accidentally make the catch branch fatal.
- Gap 2 (repeated warnings on reconnect) is a future UX concern, not a correctness bug.

**Verdict: APPROVE** — proceed to implementation with the two notes above communicated to the implementer.
