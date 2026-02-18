## Uncle Bob — Code Quality Review

**Verdict:** APPROVE (with noted pre-existing tech debt)

**File sizes:** Pre-existing issue, not introduced by this PR
**Method quality:** OK
**Patterns & naming:** OK

---

### File Size: RFDBServerBackend.ts

`RFDBServerBackend.ts` is **850 lines** — well above the 500-line hard limit. This is **pre-existing tech debt**, not introduced by RFD-42. The changes in this PR add approximately 30 lines total (two new private methods `_negotiateProtocol` and `_checkServerVersion`, plus minor modifications to `connect()`).

The file size issue must be tracked, but it is not a reason to REJECT this specific PR.

---

### Method Quality

**`_negotiateProtocol()` (lines 224–235):** Clean. Single responsibility — negotiate the protocol version and delegate version checking. The catch-all error handling is appropriate here: any failure to `hello` is correctly treated as a legacy server (v2 fallback). The fallback warning message is actionable. Length: ~12 lines. OK.

**`_checkServerVersion()` (lines 241–252):** Clean. Pure side-effect method: reads two values, compares, logs warning if they differ. Guard clause at the top (`if (!serverVersion) return`) handles the empty case correctly. Warning message includes both versions and a remediation command — good UX. Length: ~11 lines. OK.

**`connect()` (lines 149–193):** The `_negotiateProtocol()` call is correctly inserted in both the direct-connect path (line 166) and the auto-start path (line 191). The duplication of the connect + ping + negotiate sequence is a pre-existing pattern issue (not introduced here). The new integration of version checking does not worsen it.

---

### Naming

- `_negotiateProtocol` — clear, conventional underscore prefix for private methods in this file. OK.
- `_checkServerVersion` — unambiguous. The "check" verb correctly signals this is a validation that may warn, not a transformation. OK.
- `getSchemaVersion` (imported from `version.ts`) — correctly named: it derives a schema-comparable version string by stripping pre-release tags. OK.
- `serverVersion` / `clientSchema` / `actual` / `expected` — in `_checkServerVersion`, local variable names are descriptive. OK.

---

### Patterns Match

The private method naming convention (`_negotiateProtocol`, `_checkServerVersion`) matches existing private methods in the class (`_startServer`, `_cachedNodeCounts`). The logging pattern `this.log('[RFDBServerBackend] WARNING: ...')` matches the established pattern used throughout the file. OK.

---

### Test Quality: RFDBServerBackend.version-check.test.js

**Structure:** Two `describe` groups with clear separation — pure unit tests for `getSchemaVersion()` and an integration test for the connect-time warning. Clean, communicates intent. OK.

**Unit tests for `getSchemaVersion()`:** Cover: no pre-release tag, simple pre-release, multi-segment pre-release, non-standard version (`0.2`), empty string, and build metadata format. Six cases — good coverage of the documented behavior. Each test name is a sentence that reads as a statement of behavior. OK.

**Integration test `should log a version mismatch warning...`:**

- `console.log` monkey-patching is in a `try/finally` block that always restores the original. Correct and safe. OK.
- Precondition assertion (`clientSchema !== '0.1.0'`) makes the test self-validating: it will fail with a clear message if the test assumption is invalidated by a version bump. Good defensive testing. OK.
- The assertion message on failure includes captured log messages — excellent diagnostics. OK.

**Integration test `should still connect successfully...`:** Verifies that version mismatch is non-fatal and the backend is functional. Tests `nodeCount()` to confirm actual RPC works, not just that `connected` flag was set. This is meaningful, not trivially passing. OK.

**Cleanup:** The `after()` hook uses `lsof` to find and SIGTERM the server, then removes the temp directory. The `try/catch` blocks suppress cleanup errors without silently masking real test failures. Platform-specific (`lsof`) — acceptable for a macOS-first project, but worth noting as a potential issue in CI on Linux. The `|| true` in the shell command prevents exit-code failures. OK.

**One minor note:** The second integration test reuses `testPaths` from the `before()` hook — relying on the server started by the first test to still be running. This creates an implicit ordering dependency between the two `it()` blocks within the same `describe`. This is a common pattern in integration test suites and acceptable given the cleanup is in `after()`, but it means the second test will behave unexpectedly if run in isolation (the server may not be running). Not a blocking issue, but worth awareness.

---

### Pre-existing Tech Debt (not blocking this PR)

- **File size:** `RFDBServerBackend.ts` at 850 lines needs to be split. The file implements: connection management, server lifecycle, CRUD operations (nodes, edges), query execution, and statistics. These are distinct responsibilities. A tech debt issue should be filed for `v0.2`.
- **`connect()` duplication:** The connect-ping-negotiate sequence appears twice (direct connect path and auto-start path). Pre-existing; extract to private `_connectAndNegotiate()` would clean it up.
