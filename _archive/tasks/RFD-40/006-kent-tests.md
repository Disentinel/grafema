# Kent Beck -- Test Report: startRfdbServer() (RFD-40 Phase 1)

**Date:** 2026-02-17
**File:** `test/unit/StartRfdbServer.test.js`
**Status:** Tests written, awaiting implementation

---

## Design Decisions

### Dependency Injection via `_deps`

The function under test (`startRfdbServer`) calls `child_process.spawn`, `findRfdbBinary`, `existsSync`, `unlinkSync`, and `writeFileSync` internally. To unit test without spawning real processes, these dependencies must be mockable.

**Options considered:**
1. `node:test` `mock.module()` -- requires `--experimental-test-module-mocks` flag, not used anywhere in the project, experimental API
2. Dependency injection via `_deps` option -- clean, explicit, matches project patterns (`PhaseRunner` uses injected deps)
3. Manual mock objects -- already used in project (e.g., `createMockBackend` in `FileOverview.test.js`)

**Decision:** `_deps` optional parameter on `StartRfdbServerOptions`. The underscore prefix signals it's internal/testing-only. This keeps the public API clean while making the function fully testable.

Rob's implementation must accept:
```typescript
_deps?: {
  spawn?: typeof spawn;
  findRfdbBinary?: () => string | null;
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
  writeFileSync?: (path: string, data: string) => void;
}
```

Each dep defaults to its real import if not provided.

### Test Helpers

- `createFakeProcess(options)` -- creates an EventEmitter-based fake ChildProcess with `.pid`, `.unref()`, `.kill()`, `.on()`. Defaults to `pid: 99999`.
- `createMockSpawn(fakeProcess)` -- returns a mock spawn function that records calls in `.calls[]`.
- `createMockExistsSync(socketPath, appearAfter)` -- simulates socket appearing after N poll iterations. Handles the dual-use of existsSync (stale check before spawn + polling after).
- `createNeverAppearsExistsSync(socketPath)` -- always returns false for socket (timeout scenario).

### Temp Directory Strategy

Each test run gets a unique temp directory under `os.tmpdir()`. Cleaned up in `afterEach` (reset) and `process.on('exit')` (final cleanup).

---

## Tests (9 total)

### 1. Binary not found throws descriptive error
- **Group:** `binary resolution`
- **Setup:** No `binaryPath` option, `findRfdbBinary` returns null
- **Asserts:** Error thrown with message containing "binary" and "not found"; spawn never called

### 2. Uses explicit binaryPath when provided
- **Group:** `binary resolution`
- **Setup:** `binaryPath: '/some/explicit/rfdb-server'`, findRfdbBinary spy
- **Asserts:** spawn called with explicit path; findRfdbBinary NOT called

### 3. Removes stale socket before spawn
- **Group:** `stale socket cleanup`
- **Setup:** Real file created at socketPath, mock unlinkSync tracks calls
- **Asserts:** unlinkSync called with socketPath

### 4. Writes PID file when pidPath provided and process.pid is set
- **Group:** `PID file handling`
- **Setup:** pidPath provided, fake process with `pid: 12345`
- **Asserts:** PID file exists, contains "12345"

### 5. Does NOT write PID file when pidPath absent
- **Group:** `PID file handling`
- **Setup:** No pidPath, mock writeFileSync tracks calls
- **Asserts:** writeFileSync never called

### 6. Does NOT write PID file when process.pid is undefined
- **Group:** `PID file handling`
- **Setup:** pidPath provided, fake process with `pid: undefined`
- **Asserts:** PID file does not exist

### 7. Throws timeout error with binary path and timeout in message
- **Group:** `socket polling and timeout`
- **Setup:** Socket never appears, `waitTimeoutMs: 200`
- **Asserts:** Error thrown containing binary path and timeout duration

### 8. Calls logger.debug during startup
- **Group:** `logger integration`
- **Setup:** Mock logger with `debug` array collector
- **Asserts:** debug called at least once

### 9. Wires process.on("error") handler
- **Group:** `process error handling`
- **Setup:** Intercept `.on()` calls on fake process
- **Asserts:** `.on('error', handler)` called with a function

### Bonus: 10. Spawn arguments verification
- **Group:** `spawn arguments`
- **Setup:** Known dbPath, socketPath, binaryPath
- **Asserts:** spawn called with correct binary, args include dbPath/--socket/socketPath, options include `detached: true`

---

## Implementation Contract for Rob

The tests define the following contract that `startRfdbServer()` must fulfill:

1. **Binary resolution:** `options.binaryPath || _deps.findRfdbBinary()` -- if null, throw with "binary not found"
2. **Stale socket:** Call `_deps.existsSync(socketPath)` then `_deps.unlinkSync(socketPath)` if stale
3. **Spawn:** Call `_deps.spawn(binary, [dbPath, '--socket', socketPath, ...], { detached: true, ... })` then `.unref()`
4. **Error handler:** Call `serverProcess.on('error', handler)`
5. **PID file:** If `pidPath` AND `serverProcess.pid` are both defined, write PID to file via `_deps.writeFileSync`
6. **Socket poll:** Loop checking `_deps.existsSync(socketPath)` up to `waitTimeoutMs / 100` iterations
7. **Timeout error:** Include binary path and timeout duration in error message
8. **Logger:** Call `logger.debug()` at least once during startup
9. **Return:** `serverProcess` (ChildProcess)

---

## Current State

Tests fail with `ERR_MODULE_NOT_FOUND` because `packages/core/dist/utils/startRfdbServer.js` does not exist yet. This is expected TDD state -- tests written first, implementation follows.

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../packages/core/dist/utils/startRfdbServer.js'
```

After Rob implements + `pnpm build`, run:
```bash
node --test test/unit/StartRfdbServer.test.js
```
