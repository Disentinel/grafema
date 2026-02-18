# Uncle Bob PREPARE Review: REG-498

Reviewer: Robert Martin (Uncle Bob)
Phase: STEP 2.5 — Prepare

---

## Uncle Bob PREPARE Review: DataFlowValidator.ts

**File size:** 254 lines — OK

**Methods to modify:**
- `execute()` — lines 61–195, 134 lines
- `findPathToLeaf()` — lines 200–253, 53 lines

**File-level:** OK. Single responsibility: validate that variable nodes trace to leaf nodes.

**Method-level:**

`execute()` — 134 lines — REFACTOR.
Current structure packs three concerns into one method: (1) node collection, (2) per-variable validation loop with inline error construction, (3) summary grouping and log emission. The validation loop (lines 97–158) is 61 lines with two levels of nesting and three distinct `if` branches each building a `ValidationError` inline. After the REG-498 changes, `execute()` will stay roughly the same length because the node collection block shrinks but `getNode()` calls are added inside the loop. The inline `ValidationError` construction is duplicated three times with only the code/message fields varying — that duplication should be extracted into a private `buildVariableError()` helper before the implementer touches the method. This is a pre-existing DRY violation that becomes harder to modify safely if left in place.

Specifically: lines 104–117, 123–137, and 143–157 each construct a `ValidationError` with an identical `{ filePath, lineNumber, phase, plugin, variable }` context shape. Extract:
```
private buildVariableError(variable: NodeRecord, message: string, code: string, extra?: Record<string, unknown>, severity?: 'warning' | 'error'): ValidationError
```
This reduces the three blocks to three one-liners and makes the loop readable.

`findPathToLeaf()` — 53 lines — SKIP refactoring beyond the signature change.
The method becomes async with the REG-498 changes (all `allEdges.find()` and `allNodes.find()` calls replaced by `await graph.getOutgoingEdges()` / `await graph.getIncomingEdges()` / `await graph.getNode()`). The logic itself is a recursive DFS with a visited guard — it is correct and the nesting depth is acceptable (2 levels). Do not restructure further; the async conversion is sufficient.

**Risk:** MEDIUM (method is recursive, becoming async — verify visited set prevents infinite recursion on cycles; existing behavior changes for for-of/for-in variables)
**Estimated scope:** ~80 lines modified (execute loop + findPathToLeaf body + new helper ~15 lines)

---

## Uncle Bob PREPARE Review: GraphConnectivityValidator.ts

**File size:** 227 lines — OK

**Methods to modify:**
- `execute()` — lines 54–226, 172 lines

**File-level:** BORDERLINE — 172-line method in a 227-line file. The method does three things: (1) build adjacency maps from allEdges, (2) BFS from roots, (3) emit errors and update manifest. Single-method bloat is a pre-existing issue but the REG-498 change replaces the adjacency-map block with per-node BFS calls, which reduces total line count by ~20. Net result remains a long method but within acceptable range post-change.

**Method-level:**

`execute()` — 172 lines — REFACTOR adjacency-map block only.
The adjacency-map build (lines 86–101) and BFS loop (lines 103–122) will be rewritten anyway. After removal of the adjacency map the BFS becomes an async loop with `await` calls. The error-reporting block (lines 128–210) is a separate concern — 82 lines — with 3 levels of nesting inside the `if (unreachable.length > 0)` branch. That block should be extracted to a private `reportUnreachableNodes()` method BEFORE the implementer rewrites the BFS section. This is the minimum refactor: extract the reporting block so the BFS rewrite touches only the traversal code.

Extract signature:
```
private async reportUnreachableNodes(
  unreachable: NodeRecord[],
  allNodes: NodeRecord[],
  reachable: Set<string>,
  adjacencyOut: Map<string, string[]>,
  adjacencyIn: Map<string, string[]>,
  manifest: ManifestWithValidation,
  logger: ReturnType<typeof this.log>
): Promise<ValidationError[]>
```
After the BFS rewrite the adjacency maps no longer exist, so the `reportUnreachableNodes` parameters will change — but extracting the method now clarifies the boundary between traversal and reporting, which is what matters for the REG-498 implementer.

**Risk:** HIGH (BFS becomes N×2 async IPC calls; largest behavioral change in the task; no existing test)
**Estimated scope:** ~30 lines modified in BFS section; +~15 lines for extracted reporting method

---

## Uncle Bob PREPARE Review: TypeScriptDeadCodeValidator.ts

**File size:** 203 lines — OK

**Methods to modify:**
- `execute()` — lines 58–202, 144 lines

**File-level:** OK. Single responsibility: detect dead TypeScript constructs.

**Method-level:**

`execute()` — 144 lines — SKIP file-level split. The method is long but it is sequential with no branching complexity. The getAllEdges block (lines 89–96) is the only section that changes. The change is a pure mechanical replacement: remove the `allEdges` variable and the `implementedInterfaces` pre-population pass; inline `getIncomingEdges` per interface inside the existing `for (const [id, iface] of interfaces)` loop (lines 103–147). The `implementedInterfaces` Map is eliminated. Total change is ~10 lines.

The stale comment on line 89 ("no queryEdges in GraphBackend yet") must be removed; it becomes misleading after the change.

The issue-push blocks inside the interface loop (lines 108–146) each push an object literal with the same `{ nodeId, name, file, line }` fields. Minor duplication — SKIP, the benefit of extracting a helper does not justify the churn in this location.

**Risk:** LOW (algorithm changes from one-pass to N-requests, but no logic change; no test existed before)
**Estimated scope:** ~12 lines modified, ~8 lines removed (eliminate implementedInterfaces Map and pre-pass)

---

## Uncle Bob PREPARE Review: ShadowingDetector.ts

**File size:** 174 lines — OK

**Methods to modify:**
- `execute()` — lines 71–173, 102 lines

**File-level:** OK. Single responsibility: detect variable shadowing.

**Method-level:**

`execute()` — 102 lines — SKIP structural refactoring.
The change is pure API migration: 4 `getAllNodes()` calls (lines 80–83) become `for await` loops over `queryNodes()`. This expands 4 lines to ~16 lines. The two detection sections (lines 101–147) are logically independent and clear. No duplication, no deep nesting (2 levels max).

The comment at line 18 ("use getAllNodes for arrays") is the prior justification for using `getAllNodes`. Remove it after the change — it becomes incorrect documentation that will mislead future readers.

One naming improvement worth doing while the method is open: `allLocalVars` (line 126) is accurate but `localScopedVars` is clearer since the filter criterion is `parentScopeId` (scope membership), not locality. SKIP if team convention differs — low value.

**Risk:** LOW (pure API migration; existing 6-test suite in ShadowingDetector.test.js covers regression)
**Estimated scope:** ~12 lines modified (4 getAllNodes calls expand to ~16 lines; stale comment removed)

---

## Uncle Bob PREPARE Review: SocketIOAnalyzer.ts

**File size:** 525 lines — MUST SPLIT

**File-level:** MUST SPLIT (525 lines exceeds 500-line hard limit).

The file currently contains three distinct responsibilities:
1. `execute()` + `getModules()` helper — orchestration (implicit; `getModules` is referenced but not shown — must be in the same file or inherited)
2. `analyzeModule()` — AST traversal and Socket.IO pattern detection (lines 252–477, 225 lines)
3. `createEventChannels()` — post-pass graph enrichment (lines 170–250, 80 lines)
4. `getObjectName()` + `extractStringArg()` — AST utility functions (lines 483–524, 41 lines)

**Required split before REG-498 implementation:**

Extract AST utilities to a separate module:
- `packages/core/src/plugins/analysis/socketio/utils.ts` — `getObjectName()` and `extractStringArg()` (41 lines)

Extract the traverse callback logic:
- The `CallExpression` visitor inside `analyzeModule()` (lines 280–400, 120 lines) is the densest section. It handles three patterns (emit, on, join) with repeated `callee.type === 'MemberExpression'` guards. Extract each pattern to a private method:
  - `private detectEmit(node: CallExpression, moduleFile: string): SocketEmitNode | null`
  - `private detectListener(node: CallExpression, moduleFile: string): SocketListenerNode | null`
  - `private detectRoomJoin(node: CallExpression, moduleFile: string): SocketRoomNode | null`

This splits the 120-line traverse callback into three ~25-line methods plus a thin orchestrator (~20 lines), bringing `analyzeModule()` from 225 lines to ~80 lines and making each pattern independently testable.

After these extractions, the remaining class stays in `SocketIOAnalyzer.ts` at approximately 350 lines — still large but each method has a single responsibility and the file stays below the critical 700-line threshold. A further split of `createEventChannels()` to its own class is architecturally desirable but out of scope for STEP 2.5 (no architectural changes in PREPARE phase).

**Methods to modify for REG-498:**
- `createEventChannels()` lines 170–250 (80 lines) — two `getAllNodes()` calls at lines 176–177
- `analyzeModule()` lines 252–477 (225 lines) — one `getAllNodes()` call at lines 432–433

**Method-level:**

`createEventChannels()` — 80 lines — SKIP structural refactoring beyond the getAllNodes replacement. The method is clear. The two `getAllNodes` calls (lines 176–177) become two `for await` loops (~8 lines each). Net +8 lines. The overall structure remains readable.

`analyzeModule()` — 225 lines — REFACTOR (extract pattern detectors as above). The `CallExpression` visitor at lines 280–400 is 120 lines of 3-level nesting with duplicated `callee.type` checks. This is the highest-complexity section in all 6 files. The REG-498 change only touches lines 432–433 (`getAllNodes` for handler lookup), but the method is too long to be safely modified in isolation. Extracting the three pattern detectors first makes the getAllNodes replacement obviously safe.

**Risk:** HIGH (largest file; `analyzeModule` is 225 lines with 3-level nesting; no existing tests for SocketIOAnalyzer)
**Estimated scope:** ~20 lines modified for getAllNodes changes; ~80 lines moved to new file for the extraction

---

## Uncle Bob PREPARE Review: packages/types/src/plugins.ts

**File size:** 382 lines — OK

**Methods to modify:** No methods — one interface member removal.

**File-level:** OK. The file is a type declaration module. It has grown to cover multiple concerns (LogLevel, Logger, PluginPhase, PluginMetadata, IssueSpec, PluginContext, PluginResult, Manifest, OrchestratorConfig, GraphBackend, NodeFilter, IPlugin, helper functions) but this is a types file — co-location of related type declarations is idiomatic TypeScript and does not violate SRP in the same way an implementation file would.

The change for REG-498 is: remove lines 301–303 from the `GraphBackend` interface:
```ts
// For GUI/export - use with caution on large graphs
getAllEdges?(): Promise<EdgeRecord[]>;
```

**Method-level:** N/A — this is a type member, not a method body.

The `NodeFilter` interface (lines 338–344) uses `[key: string]: unknown` as an index signature alongside specific fields — this is a pre-existing design smell (the index signature defeats type safety on the named fields). Out of scope for REG-498.

**Risk:** LOW (2-line removal; TypeScript compiler will catch any remaining callers in plugin code; internal `GraphBackend` abstract class and `RFDBServerBackend` keep their `getAllEdges` implementations)
**Estimated scope:** 2 lines removed

---

## Summary Table

| File | Lines | Status | Refactor Required Before Impl? | Risk |
|------|-------|--------|-------------------------------|------|
| `DataFlowValidator.ts` | 254 | OK | YES — extract `buildVariableError()` helper | MEDIUM |
| `GraphConnectivityValidator.ts` | 227 | OK | YES — extract `reportUnreachableNodes()` | HIGH |
| `TypeScriptDeadCodeValidator.ts` | 203 | OK | NO | LOW |
| `ShadowingDetector.ts` | 174 | OK | NO | LOW |
| `SocketIOAnalyzer.ts` | 525 | MUST SPLIT | YES — extract pattern detectors + AST utils | HIGH |
| `packages/types/src/plugins.ts` | 382 | OK | NO | LOW |

## Mandatory Pre-Implementation Actions

1. **SocketIOAnalyzer.ts — MUST SPLIT (non-negotiable).** File is 525 lines. Extract `getObjectName()` and `extractStringArg()` to `socketio/utils.ts`. Extract three pattern detectors from the `CallExpression` visitor.

2. **DataFlowValidator.ts — extract `buildVariableError()`.** The three identical `ValidationError` construction blocks are a DRY violation that makes the validation loop harder to modify. Extract before touching `execute()`.

3. **GraphConnectivityValidator.ts — extract `reportUnreachableNodes()`.** The 82-line error-reporting block inside `execute()` must be separated from the BFS traversal before the traversal is rewritten. The two concerns must not be modified simultaneously.

Actions 1–3 are STEP 2.5 scope. They are prerequisite to STEP 3 (implementation). Do NOT combine refactoring with the REG-498 logic changes in the same commit.
