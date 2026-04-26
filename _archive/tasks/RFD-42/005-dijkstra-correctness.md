## Dijkstra Correctness Review

**Verdict:** APPROVE

**Functions reviewed:**
- `getSchemaVersion(version: string): string` — APPROVE (with noted edge cases — all benign)
- `_checkServerVersion(serverVersion: string): void` — APPROVE
- `_negotiateProtocol(): Promise<void>` — APPROVE

---

## Input Enumeration

### `getSchemaVersion(version: string): string`

Implementation: `version.split('-')[0]`

**All possible input categories:**

| Input | Result | Correct? |
|-------|--------|---------|
| `"0.2.5-beta"` | `"0.2.5"` | YES — pre-release stripped |
| `"0.2.5"` | `"0.2.5"` | YES — stable version unchanged |
| `"1.0.0-alpha.1"` | `"1.0.0"` | YES — compound pre-release stripped |
| `"0.2.5-beta.3"` | `"0.2.5"` | YES — only first split segment returned |
| `""` (empty string) | `""` | BENIGN — caller guards prevent empty reaching here |
| `"-beta"` (leading hyphen) | `""` | BENIGN — pathological input, not from real version |
| `"not-a-version"` | `"not"` | BENIGN — produces non-matching string, warning fires correctly |
| `"0.2.5-beta-rc1"` | `"0.2.5"` | YES — only first segment kept |

**Verdict on `getSchemaVersion`:** Correct for all realistic inputs. Pathological inputs (empty string, leading hyphen) are unreachable in practice because `GRAFEMA_VERSION` comes from `package.json` and `serverVersion` is guarded by the `!serverVersion` check before calling this function.

---

### `_checkServerVersion(serverVersion: string): void`

**All possible inputs for `serverVersion`:**

| Input | Behavior | Correct? |
|-------|----------|---------|
| `undefined` | Early return via `!serverVersion` guard | YES |
| `null` | Early return via `!serverVersion` guard | YES — `null` is falsy |
| `""` (empty string) | Early return via `!serverVersion` guard | YES — `""` is falsy |
| `"0.2.5"` matching `GRAFEMA_VERSION` `"0.2.5"` | No warning | YES |
| `"0.2.5-beta"` with `GRAFEMA_VERSION` `"0.2.5-beta"` | No warning (both strip to `"0.2.5"`) | YES |
| `"0.2.5-beta"` with `GRAFEMA_VERSION` `"0.2.5"` | No warning (both strip to `"0.2.5"`) | YES — schema versions match, pre-release suffix ignored correctly |
| `"0.2.4"` with `GRAFEMA_VERSION` `"0.2.5"` | Warning logged | YES |
| `"0.3.0"` with `GRAFEMA_VERSION` `"0.2.5"` | Warning logged | YES |
| `"garbage"` | `getSchemaVersion("garbage")` → `"garbage"`, `expected` ≠ `"garbage"` → warning | BENIGN — correct behavior |

**Can `_checkServerVersion` throw?**

Analyzing every expression:

1. `!serverVersion` — cannot throw, safe boolean check.
2. `getSchemaVersion(GRAFEMA_VERSION)` — `GRAFEMA_VERSION` is always a string from `package.json`. `split('-')[0]` cannot throw on a string. Cannot throw.
3. `getSchemaVersion(serverVersion)` — `serverVersion` is typed `string`. By the time we reach this line, we have confirmed `serverVersion` is truthy (non-empty, non-null, non-undefined). `split('-')[0]` cannot throw. Cannot throw.
4. `actual !== expected` — comparison of two strings. Cannot throw.
5. `this.log(...)` — calls `console.log` if `!this.silent`. Cannot throw under normal conditions.

**Conclusion: `_checkServerVersion` cannot throw.** The function is entirely composed of operations that are safe on truthy string inputs. The `!serverVersion` guard eliminates all falsy cases before any string operation is performed.

**Consequence of being called inside the `try` block in `_negotiateProtocol`:** Even if somehow `_checkServerVersion` threw (it cannot), the catch block would swallow the exception and fall back to `protocolVersion = 2`. This would be a silent failure — the version mismatch warning would be lost. However, since the function cannot throw, this is not a real risk.

---

### `_negotiateProtocol(): Promise<void>`

**Condition: `if (!this.client) return`**

| `this.client` value | Behavior |
|---------------------|----------|
| `null` | Early return — correct. This happens if `_negotiateProtocol` is called before `connect()` assigns a client. |
| `RFDBClient instance` | Proceeds — correct. |

**Flow after `hello(3)` succeeds:**

| `hello.protocolVersion` value | `hello.serverVersion` value | Result |
|-------------------------------|----------------------------|--------|
| `3` (or any number) | `"0.2.5"` | `this.protocolVersion = 3`, version check runs |
| `3` | `undefined` | `this.protocolVersion = 3`, `_checkServerVersion` early-returns via `!serverVersion` |
| `3` | `""` | `this.protocolVersion = 3`, `_checkServerVersion` early-returns via `!serverVersion` |
| `2` (server downgrades) | any | `this.protocolVersion = 2`, version check runs |

**Flow when `hello(3)` throws (catch branch):**

| Throw reason | Result |
|--------------|--------|
| Server predates `hello` command | `protocolVersion = 2`, warning logged |
| Network error mid-hello | `protocolVersion = 2`, warning logged (misleading message — says "doesn't support hello" but actually network error) |
| Server returns malformed response | `protocolVersion = 2`, warning logged |

**Issue identified (non-blocking):** The catch clause swallows ALL errors indiscriminately. A transient network error during `hello` is treated identically to "server doesn't support hello". The warning message `"Server does not support version negotiation"` will be logged even for network failures. This was pre-existing behavior and does not affect correctness — protocol version 2 is a safe fallback.

**Note on the catch and `_checkServerVersion` interaction:** `_checkServerVersion` is called synchronously inside the `try` block at line 229. If it could throw (it cannot), the catch would absorb it and set `protocolVersion = 2` — incorrectly, since the hello command succeeded. This is a structural fragility worth noting, but given `_checkServerVersion` is provably non-throwing, it is not an active bug.

---

## Invariants After Execution

**After `_negotiateProtocol` completes (success or failure):**
- `this.protocolVersion` is always assigned — either the negotiated value from `hello.protocolVersion`, or `2` as fallback. It is never left at its pre-call value through an unhandled exception path.
- The function never throws — the outer `catch` ensures all code paths complete without propagating exceptions.

**After `_checkServerVersion` completes:**
- `this.protocolVersion` is unchanged — the function is read-only with respect to backend state.
- A warning may or may not have been logged, but no state mutation occurs.

---

## Summary

All inputs are handled correctly. The falsy guard on `serverVersion` (`!serverVersion`) correctly covers `undefined`, `null`, and `""`. The `getSchemaVersion` function is safe for all truthy string inputs. The function cannot throw. The structural fragility of calling `_checkServerVersion` inside the `try/catch` is benign because non-throwing behavior is guaranteed.

**Issues found:** None that affect correctness.

**Observations (informational, not blocking):**
- `_negotiateProtocol` catch clause cannot distinguish network failure from "server too old" — warning message may be misleading in network failure scenarios. Pre-existing behavior, not introduced by this change.
- `_checkServerVersion` placement inside `try` block creates a structural coupling where future modifications to that function that introduce throws would be silently swallowed. The JSDoc comment `"Warns on mismatch but never fails"` is an accurate contract and serves as a guard against this.
