## Don's Plan: Split Orchestrator.ts (REG-462)

**Config:** Mini-MLA
**Target:** 1,248 lines → < 500 lines

### Current Structure

| Section | Lines | LOC |
|---------|-------|-----|
| Imports | 1-28 | 28 |
| Types/interfaces | 29-141 | 113 |
| Class fields + constructor | 143-230 | 88 |
| Graph initialization (3 methods) | 232-330 | 99 |
| `run()` | 335-611 | 277 |
| `runMultiRoot()` | 618-789 | 172 |
| Discovery (3 methods) | 791-997 | 207 |
| `runPhase()` + `getDiagnostics()` | 999-1011 | 13 |
| Guarantee checking (2 methods) | 1013-1077 | 65 |
| Parallel analysis (3 methods) | 1079-1248 | 170 |
| **Total** | | **1,248** |

### Extraction Plan (6 steps, ordered by risk)

#### Step 1: Extract types → `OrchestratorTypes.ts` (-113 lines)

Move all interfaces/types that don't need to be in the class file:
- `ParallelConfig`, `OrchestratorOptions`, `ServiceInfo`, `EntrypointInfo`
- `DiscoveryManifest`, `IndexingUnit`, `UnitManifest`

Re-export from Orchestrator.ts for backward compatibility (existing `index.ts` exports).

**Risk:** ZERO — pure type movement, no runtime change.

#### Step 2: Extract `GraphInitializer.ts` (-99 lines, +3 line call site)

Move:
- `createGraphMetaNode()` — 10 lines
- `registerPluginNodes()` — 50 lines
- `declarePluginFields()` — 18 lines

Interface: `new GraphInitializer(graph, plugins, logger)` → `init(projectPath)`

**Risk:** LOW — pure setup, called once, no state interaction.

#### Step 3: Extract `DiscoveryManager.ts` (-207 lines, +3 line call site)

Move:
- `discover()` — 145 lines (config services + plugin discovery)
- `discoverInRoot()` — 5 lines
- `buildIndexingUnits()` — 43 lines
- Entrypoint override logic from `run()` (lines 371-391) — ~20 lines

Interface: `new DiscoveryManager(plugins, graph, config, logger)` → `discover(projectPath, entrypoint?)` → `DiscoveryManifest`

**Risk:** LOW — self-contained, clear input/output.

#### Step 4: Extract `GuaranteeChecker.ts` (-65 lines, +1 line call site)

Move:
- `runGuaranteeCheck()` — 48 lines
- `checkCoverageGaps()` — 5 lines

Interface: `new GuaranteeChecker(graph, diagnosticCollector, profiler, onProgress, logger)` → `check(changedTypes, projectPath)`

**Risk:** LOW — independent post-processing step.

#### Step 5: Extract `ParallelAnalysisRunner.ts` (-170 lines, +1 line call site)

Move:
- `runParallelAnalysis()` — 74 lines
- `startRfdbServer()` — 62 lines
- `stopRfdbServer()` — 14 lines
- Related state: `rfdbServerProcess`, `_serverWasExternal`, `analysisQueue`

Interface: `new ParallelAnalysisRunner(graph, plugins, parallelConfig, onProgress, logger)` → `run(manifest)`

**Risk:** MEDIUM — external process lifecycle. Mitigated: no logic changes, just moving code.

#### Step 6: DRY batch processing + pipeline epilogue

After steps 1-5, `run()` and `runMultiRoot()` still have duplicated patterns:

**Batch processing** (indexing + analysis phases both do the same batch loop):
- Extract `runBatchPhase(phaseName, units, manifest)` private method (~35 lines, saves ~80)

**Pipeline epilogue** (enrichment → strict barrier → guarantee → validation → flush → cleanup):
- Extract `runPipelineEpilogue(manifest, projectPath)` private method (~35 lines, saves ~40)

**Risk:** LOW — internal DRY refactoring, no API change.

### Line Count Estimate After All Steps

| What | Lines |
|------|-------|
| Imports (reduced) | ~15 |
| Re-exports from OrchestratorTypes | ~5 |
| Class fields (reduced — parallel/discovery state moved) | ~12 |
| Constructor (creates extracted classes) | ~35 |
| `run()` (simplified — discovery/batch/epilogue delegated) | ~80 |
| `runMultiRoot()` (simplified — per-root loop + epilogue call) | ~70 |
| `runBatchPhase()` (new DRY helper) | ~35 |
| `runPipelineEpilogue()` (new DRY helper) | ~35 |
| `runPhase()` delegation | 3 |
| `getDiagnostics()` getter | 3 |
| **Estimated total** | **~293** |

Conservative buffer: **350-400 lines** (accounting for comments, whitespace, error handling I may have missed).

### New Files

All in `packages/core/src/` (flat, matching PhaseRunner.ts precedent):

| File | Estimated Lines | Exports |
|------|-----------------|---------|
| `OrchestratorTypes.ts` | ~130 | Types + interfaces |
| `GraphInitializer.ts` | ~120 | GraphInitializer class |
| `DiscoveryManager.ts` | ~260 | DiscoveryManager class |
| `GuaranteeChecker.ts` | ~100 | GuaranteeChecker class |
| `ParallelAnalysisRunner.ts` | ~210 | ParallelAnalysisRunner class |

### Public API Impact: ZERO

External callers only use:
- `new Orchestrator(options)` → unchanged
- `orchestrator.run(projectPath)` → unchanged
- `orchestrator.getDiagnostics()` → unchanged

Types re-exported from `OrchestratorTypes.ts` → `index.ts` exports unchanged.

### Execution Order

1. Kent: Write behavior-locking tests BEFORE any refactoring
2. Rob: Extract one class at a time, tests pass after each commit
   - Step 1 (types) → Step 2 (GraphInitializer) → Step 3 (DiscoveryManager) → Step 4 (GuaranteeChecker) → Step 5 (ParallelAnalysisRunner) → Step 6 (DRY)
3. Each step = atomic commit

### Tests

Existing test coverage:
- `test/unit/OrchestratorPluginNodes.test.ts` — plugin node registration
- `test/unit/OrchestratorStrictSuppressed.test.js` — strict mode
- `test/unit/OrchestratorMultiRootStrict.test.js` — multi-root strict
- ~125 integration tests use Orchestrator via `analyzeProject()` helper

Kent will write additional unit tests locking:
- Discovery with config services
- Discovery with plugins
- buildIndexingUnits deduplication
- Entrypoint override behavior
- Batch processing order
- Guarantee check integration

### Prior Art

PhaseRunner.ts extraction (RFD-16) succeeded with identical approach:
- Same class, same pattern
- Extracted ~450 lines → PhaseRunner.ts (469 lines)
- Zero breakage, atomic commits
