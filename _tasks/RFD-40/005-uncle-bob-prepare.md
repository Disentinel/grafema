# Uncle Bob PREPARE Review: RFD-40 Phase 1

---

## Uncle Bob PREPARE Review: RFDBServerBackend.ts

**File size:** 880 lines — OK (below 500-line MUST SPLIT threshold; large but well-structured with clear section separators)
**Methods to modify:** `_startServer()` — lines 218–264 (46 lines)

**File-level:**
- File is large but organized by logical section comments (`// === Node Operations ===`, etc.). Single responsibility: graph backend over socket. No SRP violation.
- `_startServer()` is the only method Phase 1 will touch. All other methods are simple delegators to `this.client`.

**Method-level:** `RFDBServerBackend::_startServer` (lines 218–264, 46 lines)

Current structure:
1. Guard: `if (!this.dbPath)` throw
2. Binary lookup via `_findServerBinary()`
3. Stale socket removal
4. `spawn()` server
5. `unref()` + error handler
6. Poll loop: wait for socket file (50 × 100ms = 5s max)
7. Final check: throw if socket never appeared

Phase 1 change: pass additional args to `spawn()` — specifically `--data-dir` flag. The method is 46 lines, one nesting level in the poll loop, no hidden complexity.

- **Recommendation:** SKIP refactoring. The method is at 46 lines (just under the 50-line threshold), linear in structure, one responsibility. Adding a single argument to the `spawn()` call at line 240 is safe as-is.
- Nesting depth: 1 (the while loop). Acceptable.
- The poll loop could be extracted (`_waitForSocket(path, attempts, intervalMs)`), but that is speculative cleanup — not needed for safety of the Phase 1 change.

**Risk:** LOW
**Estimated scope:** 1–3 lines changed (the `spawn()` call argument list)

---

## Uncle Bob PREPARE Review: packages/cli/src/commands/server.ts

**File size:** 396 lines — OK (below 500-line threshold)
**Methods to modify:** `start` action handler — lines 92–204 (112 lines, inline anonymous function)

**File-level:**
- File follows commander subcommand pattern: one file for all `grafema server *` subcommands. Multiple responsibilities (start, stop, status, graphql) in one file, but this is an idiomatic commander pattern — each subcommand is a self-contained action. No SRP issue worth addressing in PREPARE.
- Helper functions at top (`findServerBinary`, `isServerRunning`, `getProjectPaths`) are well-extracted and reusable.

**Method-level:** `start` action handler (lines 92–204, 112 lines)

This is the longest single block in the file. It does:
1. Resolve paths
2. Guard: grafema initialized?
3. Guard: server already running?
4. Remove stale socket
5. Binary resolution (CLI flag → config → auto-detect) — 3-branch if/else, ~20 lines
6. Spawn server
7. Poll for socket
8. Verify responsiveness
9. Print success

The binary resolution block (lines 120–141) is somewhat tangled — it has a nested if/else with a try/catch inside. This is the part Phase 1 will touch: we need to pass `--data-dir` to the spawn call at line 160.

The actual spawn call is at lines 160–163 — 4 lines, trivial to modify. The complexity around it (binary detection, PID file) is pre-existing and does not affect the safety of adding an argument.

- **Recommendation:** SKIP refactoring. The binary resolution block is complex but self-contained. Extracting it would be `resolveBinaryPath(options, projectPath): string | null` — a valid improvement, but unnecessary for the Phase 1 change which only touches line 160. Doing it now risks regressions with no test coverage on the action handlers.

**Risk:** LOW
**Estimated scope:** 1–2 lines changed (the spawn argument array at line 160)

---

## Uncle Bob PREPARE Review: packages/core/src/ParallelAnalysisRunner.ts

**File size:** 195 lines — OK
**Methods to modify:** `startRfdbServer()` — lines 119–176 (57 lines)

**File-level:**
- Small, focused class. Single responsibility: orchestrate parallel file analysis queue. Good.

**Method-level:** `ParallelAnalysisRunner::startRfdbServer` (lines 119–176, 57 lines — 7 lines over the 50-line candidate threshold)

This method has a structural problem that Phase 1 directly exposes: it contains its own hardcoded binary search logic (lines 137–149) that duplicates `findRfdbBinary()` from `packages/core/src/utils/findRfdbBinary.ts`. Specifically:

```typescript
// Lines 137–149 (current code)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const serverBinary = join(projectRoot, 'packages/rfdb-server/target/release/rfdb-server');
const debugBinary = join(projectRoot, 'packages/rfdb-server/target/debug/rfdb-server');

let binaryPath = existsSync(serverBinary) ? serverBinary : debugBinary;

if (!existsSync(binaryPath)) {
  this.logger.debug('RFDB server binary not found, building', { path: binaryPath });
  execSync('cargo build --bin rfdb-server', { ... });
  binaryPath = debugBinary;
}
```

This is a DRY violation — it ignores `GRAFEMA_RFDB_SERVER` env var, `~/.local/bin`, and `@grafema/rfdb` npm package. Phase 1 needs to add `--data-dir` to the spawn call in this same method. If we add the flag here without fixing the binary search, the method grows more divergent from the shared utility.

- **Recommendation:** REFACTOR — replace the hardcoded binary search (lines 137–149) with a call to `findRfdbBinary()`. This:
  1. Eliminates DRY violation
  2. Shrinks the method from 57 lines to ~45 lines (back under threshold)
  3. Makes the Phase 1 `--data-dir` addition to `spawn()` the only meaningful change
  4. The `execSync('cargo build ...')` fallback at line 145 is unusual in production code — a user-facing error is better, consistent with what `RFDBServerBackend._startServer()` and `CLI server start` do

The refactor is safe: `findRfdbBinary()` is already used by `RFDBServerBackend` and the CLI. Its behavior is a superset of the current local search (it checks monorepo release and debug builds in the same relative order).

**Refactor plan for `startRfdbServer()`:**
- Remove lines 137–150 (hardcoded binary search + cargo build)
- Import `findRfdbBinary` from `../../utils/findRfdbBinary.js`
- Replace with: `const binaryPath = findRfdbBinary(); if (!binaryPath) throw new Error('RFDB server binary not found');`
- Then Phase 1 adds `--data-dir` to the existing `spawn()` call at line 153

**Risk:** LOW (findRfdbBinary is stable, well-tested utility; behavior is a superset)
**Estimated scope:** ~12 lines removed, 2 lines added

---

## Uncle Bob PREPARE Review: packages/mcp/src/analysis-worker.ts

**File size:** 307 lines — OK (below 500-line threshold)
**Methods to modify:** socket path resolution — line 224 (1 line inside `run()`)

**File-level:**
- This is a worker script, not a class. It has a module-level `run()` function as the entry point, plus several helper functions (`sendProgress`, `sendComplete`, `sendError`, `loadConfig`, `loadCustomPlugins`). The separation is reasonable.
- The `run()` function is 148 lines (lines 151–299). This is over the 50-line method threshold and deserves attention.

**Method-level:** `run()` (lines 151–299, 148 lines)

`run()` does too many things:
1. Load config (delegates to `loadConfig()`)
2. Load custom plugins (delegates to `loadCustomPlugins()`)
3. Build the `builtinPlugins` map (lines 162–190, 28-line block)
4. Merge plugins from config (lines 192–210)
5. Connect to RFDB backend (lines 222–228)
6. Run orchestrator (lines 239–255)
7. Collect final stats (lines 258–267)
8. Flush and close (lines 269–283)

The Phase 1 fix is at line 224 — changing the hardcoded `/tmp/rfdb.sock` fallback to a project-relative socket path. This is a 1-line change inside a large function.

The `builtinPlugins` block (lines 162–190) is a 28-line plain object literal that could be extracted to module level as a `const BUILTIN_PLUGINS`. But this is not blocking for Phase 1.

- **Recommendation:** SKIP refactoring. The 1-line socket path fix at line 224 is fully safe inside the large `run()` function. Splitting `run()` is a legitimate improvement but would take >20% of Phase 1 time and has no test coverage to lock behavior before refactoring. Defer to tech debt.

**Risk:** LOW
**Estimated scope:** 1 line changed (line 224, the socketPath fallback)

---

## Uncle Bob PREPARE Review: packages/core/src/utils/findRfdbBinary.ts

**File size:** 176 lines — OK (reference only, no changes)
**Methods to modify:** none

**File-level:**
- Clean, single-responsibility utility. Well-documented search order. All code paths return by end of function. No issues.

**Method-level:** `findRfdbBinary()` (lines 56–118, 62 lines)

Slightly over the 50-line threshold, but the length is justified: it's a linear sequence of fallback checks, each clearly commented. No branching complexity. Not being modified.

- **Recommendation:** No action needed. Reference only.

**Risk:** N/A
**Estimated scope:** 0 lines

---

## Summary

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `RFDBServerBackend.ts` | 880 | OK | SKIP — `_startServer()` is 46 lines, safe to modify directly |
| `server.ts` | 396 | OK | SKIP — spawn call is isolated, surrounding complexity not in our way |
| `ParallelAnalysisRunner.ts` | 195 | OK | **REFACTOR** — replace duplicate binary search with `findRfdbBinary()` |
| `analysis-worker.ts` | 307 | OK | SKIP — 1-line socket path change, `run()` split deferred to tech debt |
| `findRfdbBinary.ts` | 176 | OK | Reference only, no changes |

**One refactoring before Phase 1 begins:** `ParallelAnalysisRunner::startRfdbServer` — remove the hardcoded binary search block (lines 137–149) and delegate to `findRfdbBinary()`. Low risk, eliminates DRY violation, keeps the method under the 50-line threshold.

All other files are safe to modify directly without preparatory refactoring.
