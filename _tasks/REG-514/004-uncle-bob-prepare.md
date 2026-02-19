# Uncle Bob PREPARE Review: REG-514

---

## Uncle Bob PREPARE Review: extension.ts

**File size:** 499 lines — MUST SPLIT (at threshold; will reach ~600 lines after REG-514)
**Methods to modify:** `registerCommands` (lines 156–459, 304 lines), `findAndTraceAtCursor` (lines 465–491, 27 lines); new `findAndSetCallersAtCursor` will be added

**File-level:**

- CRITICAL: `extension.ts` is exactly at the 500-line threshold. Adding +100 LOC for REG-514 will push it to ~600 lines — a clear violation. This file is already doing too many things: (1) extension lifecycle (activate/deactivate), (2) command registration for 15 commands, (3) cursor tracking/delegation logic. Single Responsibility is already broken; REG-514 makes it worse.
- `registerCommands()` is 304 lines long — nearly two-thirds of the whole file. It registers 15 independent commands inline, bundles status bar setup, and attaches the cursor listener. This is not a function; it is a module in disguise.
- The `searchNodes` command handler (lines 184–334, ~151 lines) lives entirely inside `registerCommands`. It has its own state variables (`nodeIdMap`, `activeAbort`, `debounceTimer`), timeout constants, query-building logic, result-rendering logic, and two nested callbacks. At 151 lines, it is the most complex thing in the file and deserves extraction.
- The cursor listener (lines 447–456) calls both `findAndSetRoot` and `findAndTraceAtCursor`. After REG-514 it will also call `findAndSetCallersAtCursor`. That is three panel updates wired together in a single debounced callback — acceptable for now but fragile if a fourth panel arrives.
- **Required split before implementation:** Extract the `searchNodes` command body (lines 184–334) into a standalone function `registerSearchCommand(disposables, clientManager, edgesProvider, debugProvider)` in the same file or a new `commands/searchCommand.ts`. This reclaims ~130 lines in `registerCommands` and keeps the post-REG-514 total under 570 lines — still high but no longer critical.
- Alternative minimal split: move `registerCommands()` entirely into a new file `commandRegistry.ts`, exporting `registerCommands`. `extension.ts` then contains only `activate`, `deactivate`, module-level state, and the two cursor-tracker functions (~160 lines). This is the cleanest structural boundary and costs zero functional change.

**Method-level: extension.ts:registerCommands**
- **Recommendation:** REFACTOR (mandatory before implementation)
- Length: 304 lines — far exceeds 50-line guideline. Non-negotiable.
- Nesting depth: The `searchNodes` handler has 4 levels of nesting (`registerCommands` → `onDidChangeValue` callback → `setTimeout` callback → `for await` body). This is 2 levels past the limit.
- Duplication: `if (abort.signal.aborted) return` appears three times within the `searchNodes` callback. Extract as a guard.
- Minimal recommended action: Extract the `searchNodes` inline implementation (lines 184–334) into a separate named function `registerSearchCommand`. This is the single highest-impact change. All other command registrations are small (3–21 lines) and acceptable inline.

**Method-level: extension.ts:activate**
- **Recommendation:** SKIP
- Length: 116 lines — over the 50-line guideline, but the structure is clear: setup, registration, connect, subscribe. Each section is a short sequential block with a comment header. Splitting further would scatter related initialization across files with no readability gain. Risk of split > benefit.
- No excessive nesting, no duplication, naming is clear.

**Method-level: extension.ts:findAndTraceAtCursor**
- **Recommendation:** SKIP
- Length: 27 lines — clean, single purpose, appropriate depth. No action needed.
- REG-514 will add a parallel `findAndSetCallersAtCursor`. These two functions share the same structure (get editor → resolve path → find node → delegate to provider). After REG-514 there will be three such functions (including `findAndSetRoot`). If a fourth appears, extract the shared cursor-resolution block into a helper. For now: acceptable.

**Risk:** HIGH
**Estimated scope:** Without the mandatory `registerCommands` split, the implementor is adding ~100 LOC into an already-overloaded function in an already-critical file. The `searchNodes` extraction is approximately 130 lines moved; it touches nothing functionally. Moving `registerCommands` to its own file touches ~8 lines in `extension.ts` (one import, one call). Either action is safe and reversible.

---

## Uncle Bob PREPARE Review: types.ts

**File size:** 180 lines — OK
**Methods to modify:** New `CallersItem` union type will be added (+60 LOC)

**File-level:**

- File is well-structured: interfaces and types grouped by domain (graph items, connection state, value trace types). The section comment `// === VALUE TRACE TYPES ===` at line 95 establishes a clean pattern.
- At 180 + 60 = 240 lines after REG-514, it stays comfortably below all thresholds.
- The incoming `CallersItem` union should follow the same pattern: add a `// === CALLERS TYPES ===` section comment, then the new types. No structural change needed.

**Method-level: types.ts (utility functions)**
- `parseNodeMetadata` (lines 51–57), `parseEdgeMetadata` (lines 62–68), `formatNodeLabel` (lines 73–75), `formatEdgeLabel` (lines 82–93) — all short, single-purpose. No action needed.

**Risk:** LOW
**Estimated scope:** +60 LOC as planned. No pre-work required.

---

## Uncle Bob PREPARE Review: package.json

**File size:** 253 lines — OK (configuration only, no code quality concern)

**File-level:**

- The `grafemaCallers` view is already declared in `views` (line 33) and has a `viewsWelcome` placeholder (lines 42–44). REG-514 just needs to register the activation event and commands — no structural concern.
- Adding `grafema.findCallers` command, `grafema.refreshCallers` command, and toolbar menu entries will add approximately 30–40 lines. Stays well under any threshold.

**Risk:** LOW
**Estimated scope:** +35 LOC as planned. No pre-work required.

---

## Summary: Required Pre-Implementation Actions

| Action | File | Type | Non-Negotiable? |
|--------|------|------|-----------------|
| Extract `searchNodes` handler OR move `registerCommands` to `commandRegistry.ts` | extension.ts | Split | YES — file crosses 500-line threshold after REG-514 |
| None | types.ts | — | — |
| None | package.json | — | — |

**Decision for implementor:** Choose one of these two equivalent options:

**Option A (minimal):** Extract the `searchNodes` inline body (lines 184–334 inside `registerCommands`) into a standalone function `registerSearchNodesCommand(disposables, ...)` defined below `registerCommands` in the same file. Saves ~130 lines inside `registerCommands`. Post-REG-514 file size: ~570 lines — still high but below critical.

**Option B (clean):** Move `registerCommands` and `findAndTraceAtCursor` (and new `findAndSetCallersAtCursor`) into a new file `commandRegistry.ts`. `extension.ts` shrinks to ~160 lines; `commandRegistry.ts` starts at ~350 lines (still needs future splitting as panels grow). This is the correct structural boundary.

**Recommendation: Option B.** The responsibility split is obvious — `extension.ts` owns lifecycle, `commandRegistry.ts` owns commands. Option A defers the problem by one task. Option B solves it permanently.
