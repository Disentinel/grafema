## Uncle Bob — Code Quality Review

**Verdict:** REJECT

**File sizes:** CRITICAL — RFDBServerBackend.ts at 830 lines exceeds hard limit
**Method quality:** Issues found
**Patterns & naming:** OK with minor notes

---

### File Sizes

| File | Lines | Status |
|------|-------|--------|
| `packages/core/src/utils/startRfdbServer.ts` | 127 | OK |
| `test/unit/StartRfdbServer.test.js` | 440 | OK |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | 830 | **CRITICAL — must split** |
| `packages/cli/src/commands/server.ts` | 476 | OK (under 500) |
| `packages/core/src/ParallelAnalysisRunner.ts` | 170 | OK |
| `packages/mcp/src/analysis-worker.ts` | 306 | OK (just over 300, no hard violation) |
| `packages/rfdb-server/index.js` | 79 | OK |

**RFDBServerBackend.ts is 830 lines — CRITICAL.** This file existed before RFD-40 and
was not split as part of this task. However, the task added new public exports
(`startRfdbServer`, `findRfdbBinary`) to `packages/core/src/index.ts` and imports
`RFDBServerBackend.ts` as a core dependency. If we are touching this file's public
interface as part of this task (removing the old embedded spawn logic, adding
`_startServer()` delegation), we triggered STEP 2.5 scope: this file must be reviewed.

The file does three distinct things that warrant splitting:

1. **Connection lifecycle** (`connect`, `close`, `_startServer`, `_negotiateProtocol`,
   `initialize`) — roughly lines 108–255
2. **Data operations** (addNode/addNodes/addEdge/addEdges/getNode/findNodes/queryNodes,
   deleteNode/deleteEdge, batch operations) — roughly lines 285–795
3. **Stat queries + Datalog** (nodeCount, edgeCount, getStats, countNodesByType,
   datalogQuery, executeDatalog, checkGuarantee) — roughly lines 595–705

A 830-line class is how 6k-line files happen. The hard limit is 500 lines — this file
is 66% over. It must be split before or as part of this task, or a tech debt issue must
be filed.

---

### Method Quality

#### `connect()` — duplicate client setup block (lines 148–192)

The `connect()` method sets up the RFDBClient twice with identical code:

```typescript
// First attempt (lines 152–157):
this.client = new RFDBClient(this.socketPath);
this.client.on('error', (err: Error) => {
  this.logError('[RFDBServerBackend] Client error:', err.message);
});

// After auto-start (lines 183–186):
this.client = new RFDBClient(this.socketPath);
this.client.on('error', (err: Error) => {
  this.logError('[RFDBServerBackend] Client error:', err.message);
});
```

The connection + ping + protocol negotiation sequence is also duplicated (lines
160–167 vs 187–191). A private `_createAndConnectClient()` helper would eliminate
this. The method is 44 lines total, which is under the 50-line limit, but the internal
duplication is a clean-code violation.

#### `server.ts` — stop/shutdown logic duplicated across `stop` and `restart` actions

The "send shutdown, wait for socket to disappear, clean up PID file" sequence appears
identically in both the `stop` action (lines 201–228) and the `restart` action
(lines 337–358). This is the "same pattern 3+ times = extract helper" rule violated
(it appears twice here, but it's non-trivial duplicated logic — 20 lines each).

```typescript
// In stop action (lines 210–228):
try {
  await client.connect();
  await client.shutdown();
} catch { }
let attempts = 0;
while (existsSync(socketPath) && attempts < 30) {
  await sleep(100);
  attempts++;
}
if (existsSync(pidPath)) { unlinkSync(pidPath); }

// In restart action (lines 341–359): IDENTICAL
```

A `stopRunningServer(socketPath, pidPath)` helper function would remove this
duplication. The server.ts `start` and `restart` actions also duplicate the
binary-resolution block (CLI flag → config → auto-detect, lines 113–135 vs 363–382).
That is also 20+ lines repeated verbatim. A `resolveBinaryPath(options, projectPath)`
helper is missing.

#### `_parseNode()` in RFDBServerBackend.ts — 43 lines, acceptable but dense

The method is 43 lines (lines 402–445) and handles three distinct concerns: metadata
parsing, JSON string unescaping, and ID resolution. It is under the 50-line limit but
the comment on line 406–414 shows it has a nested heuristic loop that iterates all
metadata keys and tries to JSON-parse string values. This is a smell but not a
hard violation; flagging for awareness.

#### `addEdges()` / `batchEdge()` — duplicated edge normalization

The wire-format normalization for edges appears in both `addEdges()` (lines 344–361)
and `batchEdge()` (lines 758–768):

```typescript
// In addEdges (line 350–351):
const flatMetadata = useV3
  ? { ...rest, ...(typeof metadata === 'object' && metadata !== null ? metadata : {}) }
  : { _origSrc: String(src), _origDst: String(dst), ...rest, ... }

// In batchEdge (line 762):
const flatMetadata = { ...rest, ...(typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {}) };
```

These are similar but not identical (batchEdge lacks the v2 _origSrc/_origDst path),
which is itself a correctness smell: batchEdge does not apply the v2 backward-compat
metadata hack that addEdges does. This divergence could produce inconsistent data
depending on which path is used. Should be extracted to a single `_normalizeEdgeMetadata()`
helper to enforce consistency.

---

### Patterns & Naming

- `_deps` injection pattern in `startRfdbServer.ts` is well-established in this codebase
  and correctly documented. Good.
- `_serverWasExternal` in `ParallelAnalysisRunner` is clear and the flag is correctly
  used to gate shutdown. Good.
- Inconsistent error message suffix: some `!this.client` guards say `'Not connected'`
  (35 occurrences) and some say `'Not connected to RFDB server'` (5 occurrences).
  Should use one form. Minor, but inconsistency in error messages makes debugging harder
  for LLM agents querying error logs.
- `findServerBinary()` wrapper in `server.ts` (lines 27–33) is a thin wrapper that adds
  minimal value — it just calls `findRfdbBinary()` and logs one error case. This is fine
  given the CLI-specific logging concern.
- `@deprecated` marker on `getBinaryPath()` in `rfdb-server/index.js` is correct
  and appreciated.

---

### Summary of Issues Requiring Fix

**Must fix before APPROVE:**

1. **RFDBServerBackend.ts — 830 lines.** File is CRITICAL (>700 lines). Either:
   (a) Split into `RFDBServerBackend.ts` (connection + lifecycle, ~200 lines) +
       `RFDBServerBackendOps.ts` or `RFDBServerBackendData.ts` (~400 lines) +
       possibly a `RFDBServerBackendDatalog.ts` (~100 lines); OR
   (b) File a Linear issue with label `Improvement`, `v0.2`, and get explicit user
       acknowledgment that the split is deferred. Per STEP 2.5 rules: "If file is too
       messy for safe refactoring → skip, create tech debt issue."

2. **server.ts — duplicated stop/shutdown logic (lines 201–228 and 337–358).**
   Extract `stopRunningServer()` helper. ~20 lines of identical logic in two action
   handlers is a maintenance hazard.

**Should fix (clean code):**

3. **server.ts — duplicated binary resolution block (lines 113–135 and 363–382).**
   Extract `resolveBinaryPath(options, projectPath)` helper.

4. **RFDBServerBackend.ts `connect()` — duplicated client setup.**
   Extract `_createAndConnectClient()` private method.

5. **Inconsistent `!this.client` error messages** — standardize to one string.

**Defer (file a note):**

6. **`addEdges()` vs `batchEdge()` metadata normalization divergence** — the v2
   `_origSrc/_origDst` metadata is applied in `addEdges()` but not in `batchEdge()`.
   This may be intentional (batch mode may only be used with v3+) but is not documented.
   Add a comment or unify.
