# REG-528: Kent Test Report — negotiateAndSelectDatabase()

## Summary

Wrote 10 unit tests for `GrafemaClientManager.negotiateAndSelectDatabase()` covering all 5 specified scenarios plus call ordering verification. All tests pass.

## Test File

`packages/vscode/test/unit/grafemaClient.test.ts`

## Test Strategy

Since `negotiateAndSelectDatabase()` is a **private** method, tests exercise it through the public `connect()` flow. To isolate the negotiation logic from filesystem concerns (DB file existence, server binary discovery, socket watching), all tests use **WebSocket transport mode** — this gives a clean path from `connect()` directly into `negotiateAndSelectDatabase()` without filesystem side effects.

### Mock Architecture

1. **`vscode` module** — mocked via `require.cache` injection (same pattern as existing tests). Configuration values are controllable per test via `setMockConfig()`.

2. **`@grafema/rfdb-client` module** — mocked via `require.cache` injection. Both `RFDBClient` and `RFDBWebSocketClient` constructors return a controllable mock client instance (`mockWsClient`) that exposes `connect()`, `close()`, `ping()`, `hello()`, `openDatabase()`, and `listDatabases()`.

3. **`createMockClient(overrides)`** — factory function that provides sensible defaults for all client methods. Individual tests override only the methods relevant to their scenario.

## Tests (10 total, 6 describe blocks)

### Section 1: Happy path (1 test)
| Test | Asserts |
|------|---------|
| `hello()` + `openDatabase("default")` succeed | `hello()` called, `openDatabase` called with `("default", "rw")`, state is `connected`, `isConnected()` returns true |

### Section 2: Database not found, others available (2 tests)
| Test | Asserts |
|------|---------|
| Multiple databases available | Error message includes `"Available: test, staging"` and `"grafema analyze"` |
| Single database available | Error message includes `"Available: myproject"` |

### Section 3: No databases at all (1 test)
| Test | Asserts |
|------|---------|
| Empty databases list | Error message includes `"No graph databases found"` and `"grafema analyze"` |

### Section 4: Network error during openDatabase (2 tests)
| Test | Asserts |
|------|---------|
| "Connection reset by peer" | Error re-thrown as-is, `listDatabases` NOT called |
| "Request timeout" | Error re-thrown as-is, `listDatabases` NOT called |

### Section 5: hello() failure (2 tests)
| Test | Asserts |
|------|---------|
| Protocol version mismatch | State is error, error includes original message, `openDatabase` NOT called |
| ECONNREFUSED | State is error, error includes original message |

### Section 6: Call ordering (2 tests)
| Test | Asserts |
|------|---------|
| Success path | `hello` called before `openDatabase` |
| Not-found recovery path | Order is `hello` -> `openDatabase` -> `listDatabases` |

## Run Command

```bash
npx tsx --test packages/vscode/test/unit/grafemaClient.test.ts
```

## Result

```
# tests 10
# suites 7
# pass 10
# fail 0
# cancelled 0
# skipped 0
# duration_ms 1322ms
```
