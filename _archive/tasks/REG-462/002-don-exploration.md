# Don's Exploration Report: Orchestrator.ts Analysis

**Date:** 2026-02-15
**File:** `/Users/vadim/grafema-worker-10/packages/core/src/Orchestrator.ts`
**Line count:** 1,248 lines
**Status:** CRITICAL - exceeds 700 line threshold

## Executive Summary

Orchestrator.ts is a 1,248-line orchestration class that has grown far beyond reasonable bounds. It mixes high-level workflow coordination with low-level implementation details across multiple concerns. **This file MUST be split** - it's past the point of "candidate for split" and into "architectural problem" territory.

The good news: PhaseRunner.ts (469 lines) was already successfully extracted (RFD-16), proving that splitting this class is both feasible and beneficial. We need to continue that pattern.

## File Overview

- **Location:** `packages/core/src/Orchestrator.ts`
- **Lines:** 1,248 (CRITICAL - exceeds 700-line hard limit)
- **Exports:** `Orchestrator` class + 6 interfaces/types
- **Dependencies:** 27 imports from 19 different modules
- **Tests:** 3 test files found
  - `test/unit/OrchestratorPluginNodes.test.ts`
  - `test/unit/OrchestratorStrictSuppressed.test.js`
  - `test/unit/OrchestratorMultiRootStrict.test.js`

## Responsibility Analysis

The Orchestrator currently handles **7 distinct concerns**:

### 1. **Workflow Coordination** (Core responsibility - KEEP IN ORCHESTRATOR)
- Lines: 335-611 (`run()` method - 277 lines)
- Lines: 618-789 (`runMultiRoot()` - 172 lines)
- Coordinates 5 phases: DISCOVERY → INDEXING → ANALYSIS → ENRICHMENT → VALIDATION
- Manages batch processing, progress reporting
- Single-root vs multi-root workspace logic
- **Verdict:** This is the TRUE orchestration logic and should remain

### 2. **Discovery Management** (Should be extracted)
- Lines: 805-847 (`buildIndexingUnits()` - 43 lines)
- Lines: 853-997 (`discover()` - 145 lines)
- Lines: 795-799 (`discoverInRoot()` - 5 lines)
- Config-provided services vs plugin-based discovery
- Service/entrypoint manifest building
- **Verdict:** Extract to `DiscoveryManager` class

### 3. **Graph Initialization** (Should be extracted)
- Lines: 236-245 (`createGraphMetaNode()` - 10 lines)
- Lines: 257-306 (`registerPluginNodes()` - 50 lines)
- Lines: 313-330 (`declarePluginFields()` - 18 lines)
- Creates GRAPH_META, grafema:plugin nodes
- Declares metadata fields for indexing
- **Verdict:** Extract to `GraphInitializer` class

### 4. **Parallel Analysis Infrastructure** (Should be extracted)
- Lines: 1087-1160 (`runParallelAnalysis()` - 74 lines)
- Lines: 1167-1228 (`startRfdbServer()` - 62 lines)
- Lines: 1234-1247 (`stopRfdbServer()` - 14 lines)
- RFDB server lifecycle management
- Worker queue setup
- Module queueing and progress tracking
- **Verdict:** Extract to `ParallelAnalysisRunner` class

### 5. **Guarantee Checking** (Should be extracted)
- Lines: 1018-1065 (`runGuaranteeCheck()` - 48 lines)
- Lines: 1073-1077 (`checkCoverageGaps()` - 5 lines)
- GuaranteeManager integration
- Selective vs full checking based on delta
- Diagnostic collection for violations
- **Verdict:** Extract to `GuaranteeChecker` class

### 6. **Phase Delegation** (Already extracted - GOOD)
- Lines: 1002-1004 (`runPhase()` - 3 lines - just delegation)
- Lines: 209-220 (PhaseRunner instantiation in constructor)
- **Verdict:** Already extracted to PhaseRunner.ts (RFD-16) ✓

### 7. **Diagnostic Collection** (Minimal - can stay)
- Lines: 1009-1011 (`getDiagnostics()` - 3 lines - just getter)
- **Verdict:** Getter is fine to keep

## Method Inventory

### Public Methods (5 total)
| Method | Lines | LOC | Responsibility | Keep/Extract |
|--------|-------|-----|----------------|--------------|
| `constructor()` | 173-230 | 58 | Dependency injection, initialization | KEEP (will slim down) |
| `run()` | 335-611 | 277 | Main workflow coordination | KEEP (core) |
| `discover()` | 853-997 | 145 | Service discovery | EXTRACT → DiscoveryManager |
| `runPhase()` | 1002-1004 | 3 | Delegate to PhaseRunner | KEEP (delegation) |
| `getDiagnostics()` | 1009-1011 | 3 | Getter | KEEP |

### Private Methods (11 total)
| Method | Lines | LOC | Responsibility | Extract To |
|--------|-------|-----|----------------|------------|
| `createGraphMetaNode()` | 236-245 | 10 | Graph initialization | GraphInitializer |
| `registerPluginNodes()` | 257-306 | 50 | Graph initialization | GraphInitializer |
| `declarePluginFields()` | 313-330 | 18 | Graph initialization | GraphInitializer |
| `runMultiRoot()` | 618-789 | 172 | Multi-root coordination | KEEP (core workflow) |
| `discoverInRoot()` | 795-799 | 5 | Discovery helper | DiscoveryManager |
| `buildIndexingUnits()` | 805-847 | 43 | Discovery processing | DiscoveryManager |
| `runGuaranteeCheck()` | 1018-1065 | 48 | Guarantee validation | GuaranteeChecker |
| `checkCoverageGaps()` | 1073-1077 | 5 | Coverage monitoring | GuaranteeChecker |
| `runParallelAnalysis()` | 1087-1160 | 74 | Parallel execution | ParallelAnalysisRunner |
| `startRfdbServer()` | 1167-1228 | 62 | RFDB lifecycle | ParallelAnalysisRunner |
| `stopRfdbServer()` | 1234-1247 | 14 | RFDB lifecycle | ParallelAnalysisRunner |

### Constructor State (17 private fields)
Too many dependencies - evidence of multiple concerns:
- Core orchestration: `graph`, `plugins`, `workerCount`, `onProgress`, `logger`
- Options: `forceAnalysis`, `serviceFilter`, `entrypoint`, `indexOnly`, `strictMode`
- Infrastructure: `profiler`, `diagnosticCollector`, `resourceRegistry`, `phaseRunner`
- Workspace: `workspaceRoots`, `configServices`, `routing`
- Parallel: `parallelConfig`, `analysisQueue`, `rfdbServerProcess`, `_serverWasExternal`

## Import/Export Analysis

### What Orchestrator Exports
Public exports from `index.ts`:
- `Orchestrator` class
- `OrchestratorOptions` interface
- `ProgressCallback`, `ProgressInfo` types
- `ParallelConfig` interface
- `ServiceInfo`, `EntrypointInfo`, `DiscoveryManifest`, `IndexingUnit` types

### Who Uses Orchestrator
Direct usage found in:
1. **CLI** (`packages/cli/src/commands/analyzeAction.ts`)
   - Creates Orchestrator instance
   - Calls `orchestrator.run(projectPath)`
   - Retrieves diagnostics via `orchestrator.getDiagnostics()`

2. **MCP Server** (`packages/mcp/src/analysis.ts`)
   - Same pattern: create, run, get diagnostics

3. **Tests** (125 files import Orchestrator)
   - Test helper: `test/helpers/createTestOrchestrator.js`
   - Integration tests, scenario tests, unit tests
   - Most use `analyzeProject()` helper that wraps Orchestrator

**Critical finding:** External API surface is actually **very small**:
- `new Orchestrator(options)` - constructor
- `orchestrator.run(projectPath)` - main entry point
- `orchestrator.getDiagnostics()` - result retrieval

Everything else is internal implementation detail!

## Proposed Split Boundaries

### Option A: Conservative (3 new classes)
Extract the most obvious separable concerns:

```
Orchestrator (coordinator)
├── GraphInitializer (graph setup)
├── DiscoveryManager (service discovery)
└── ParallelAnalysisRunner (parallel infrastructure)
```

**Result:** Orchestrator drops from 1,248 → ~600 lines

### Option B: Aggressive (5 new classes)
Full separation of concerns:

```
Orchestrator (coordinator)
├── GraphInitializer (graph setup)
├── DiscoveryManager (service discovery)
├── ParallelAnalysisRunner (parallel infrastructure)
├── GuaranteeChecker (guarantee validation)
└── WorkflowExecutor (run/runMultiRoot logic)
```

**Result:** Orchestrator drops to ~200-300 lines (pure coordination)

## Recommended Split Strategy: Option A+

**Hybrid approach - extract 4 classes:**

1. **GraphInitializer** - Graph setup logic (78 lines)
   - `createGraphMetaNode()`
   - `registerPluginNodes()`
   - `declarePluginFields()`
   - Called once at start of `run()`

2. **DiscoveryManager** - Discovery orchestration (193 lines)
   - `discover()`
   - `discoverInRoot()`
   - `buildIndexingUnits()`
   - Handles config services vs plugin discovery

3. **ParallelAnalysisRunner** - Parallel execution (150 lines)
   - `runParallelAnalysis()`
   - `startRfdbServer()`
   - `stopRfdbServer()`
   - Gated behind `parallelConfig?.enabled` flag

4. **GuaranteeChecker** - Post-enrichment validation (53 lines)
   - `runGuaranteeCheck()`
   - `checkCoverageGaps()`
   - Called after ENRICHMENT phase

**Orchestrator remains** (coordinator - ~800 lines after extraction):
- Constructor (dependency injection)
- `run()` - main workflow (calls new classes)
- `runMultiRoot()` - multi-root workflow (calls new classes)
- `runPhase()` - delegation to PhaseRunner
- `getDiagnostics()` - getter

This puts Orchestrator at ~800 lines initially, then we can consider extracting `WorkflowExecutor` in a follow-up task if needed.

## Risk Assessment

### Splitting Risks: **MEDIUM**

**Low Risk:**
- GraphInitializer - pure setup, called once, no state interaction
- DiscoveryManager - self-contained, clear input/output
- GuaranteeChecker - independent post-processing step

**Medium Risk:**
- ParallelAnalysisRunner - manages external process lifecycle
  - Server start/stop must be bulletproof
  - Error handling for stale sockets, failed spawns
  - External vs self-started server detection

### Migration Strategy: **SAFE**

1. **All new classes stay in same directory** (`packages/core/src/`)
   - No module structure changes initially
   - Can reorganize into subdirectory later if desired

2. **Public API unchanged**
   - Orchestrator constructor signature identical
   - `run()` method signature identical
   - Return types unchanged
   - Existing tests pass without modification

3. **Gradual extraction**
   - Extract one class at a time
   - Run tests after each extraction
   - Commit atomically per extraction

### Testing Coverage: **GOOD**

- 3 dedicated Orchestrator tests
- 125 files import Orchestrator (mostly via test helper)
- Tests use helper pattern: `createTestOrchestrator()` → `analyzeProject()`
- Test helper needs NO changes (internal implementation detail)

## Dependencies After Split

### Orchestrator will depend on:
- `GraphInitializer` - calls in `run()`
- `DiscoveryManager` - calls in `run()`, `runMultiRoot()`
- `GuaranteeChecker` - calls in `run()`, `runMultiRoot()`
- `ParallelAnalysisRunner` - calls in `run()` (when parallel enabled)
- `PhaseRunner` - already extracted (RFD-16)

### Extracted classes will depend on:
- **GraphInitializer**: `GraphBackend`, `NodeFactory`, `Logger`
- **DiscoveryManager**: `GraphBackend`, `Plugin`, `NodeFactory`, `Logger`, `toposort`
- **GuaranteeChecker**: `GraphBackend`, `GuaranteeManager`, `DiagnosticCollector`, `Logger`, `Profiler`
- **ParallelAnalysisRunner**: `GraphBackend`, `AnalysisQueue`, `ChildProcess`, `Logger`

All dependencies already available - no new external imports needed.

## File Structure After Split

```
packages/core/src/
├── Orchestrator.ts (800 lines - coordinator)
├── PhaseRunner.ts (469 lines - already extracted)
├── orchestrator/
│   ├── GraphInitializer.ts (NEW - ~120 lines with docs)
│   ├── DiscoveryManager.ts (NEW - ~250 lines with docs)
│   ├── GuaranteeChecker.ts (NEW - ~100 lines with docs)
│   └── ParallelAnalysisRunner.ts (NEW - ~200 lines with docs)
```

Alternatively, keep flat structure (no subdirectory):
```
packages/core/src/
├── Orchestrator.ts (800 lines)
├── PhaseRunner.ts (469 lines)
├── GraphInitializer.ts (NEW)
├── DiscoveryManager.ts (NEW)
├── GuaranteeChecker.ts (NEW)
└── ParallelAnalysisRunner.ts (NEW)
```

**Recommendation:** Flat structure for now (simpler). Can organize later if needed.

## Comparison to PhaseRunner Extraction (RFD-16)

PhaseRunner extraction (already done) is a **perfect template** for this work:

| Aspect | PhaseRunner Extraction | Proposed Orchestrator Split |
|--------|------------------------|----------------------------|
| Lines extracted | ~450 lines | ~420 lines (4 classes) |
| Orchestrator before | ~1,200 lines | 1,248 lines |
| Orchestrator after | ~750 lines | ~800 lines |
| Risk level | Medium | Medium |
| Success | ✓ Complete (RFD-16) | To be done |

**Key insight:** PhaseRunner proved that extracting plugin execution logic from Orchestrator is feasible and beneficial. We should continue that pattern.

## Next Steps

If this plan is approved:

1. **STEP 2.5 - PREPARE (Refactoring)**
   - Uncle Bob reviews current Orchestrator structure
   - No changes yet - just identify extraction points

2. **STEP 3 - EXECUTE**
   - Kent: Write tests that lock current behavior
   - Rob: Extract classes one by one
     1. GraphInitializer (simplest, no state)
     2. GuaranteeChecker (self-contained)
     3. DiscoveryManager (medium complexity)
     4. ParallelAnalysisRunner (highest complexity - external process)
   - Tests must pass after each extraction
   - Atomic commits per extraction

3. **Verification**
   - All 125 test files still pass
   - CLI and MCP still work
   - No public API changes

## Conclusion

**Verdict: MUST SPLIT**

- File is 1,248 lines (77% over 700-line CRITICAL threshold)
- Contains 7 distinct concerns
- Clear extraction boundaries exist
- Prior art: PhaseRunner extraction was successful
- Risk: Medium (manageable with atomic commits)
- Benefit: HIGH - prevents further growth, improves maintainability

**Recommendation: Proceed with Option A+ (4 class extraction)**

This brings Orchestrator down to ~800 lines (still needs follow-up, but below CRITICAL threshold). We can extract `WorkflowExecutor` later to get under 500 lines if desired.

**Question for user:** Should we proceed with this split plan?
