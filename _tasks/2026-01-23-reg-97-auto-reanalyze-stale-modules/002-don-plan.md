# Don Melton's Analysis and Plan for REG-97

## Understanding the Problem

The core issue is a **trust problem**: users can run `grafema check` on stale data and get false negatives. This undermines the fundamental value proposition of Grafema. If the graph lies, it's worse than useless.

The good news: we already have all the building blocks.

## Current Architecture Analysis

1. **Hash computation exists** in `JSModuleIndexer.calculateFileHash()` and `JSASTAnalyzer.calculateFileHash()`. Both use SHA-256.

2. **Hash comparison exists** in `JSASTAnalyzer.shouldAnalyzeModule()` - this is the exact pattern we need for freshness checking.

3. **Module iteration exists** via `graph.queryNodes({ type: 'MODULE' })` - used in Orchestrator, GuaranteeManager, JSASTAnalyzer.

4. **Incremental analysis** via `IncrementalAnalysisPlugin` uses Git-based detection, which is different. For freshness checking before validation, we need hash-based comparison since:
   - User might have committed changes but not re-analyzed
   - User might not use Git at all
   - Hash comparison is deterministic and reliable

## What's RIGHT vs What's Easy

**Easy approach (WRONG):**
- Add freshness check directly in `check.ts` command
- Duplicate hash calculation logic
- Tightly couple CLI to core logic

**RIGHT approach:**
- Create a reusable `GraphFreshnessChecker` service in `@grafema/core`
- Centralize hash computation (DRY)
- Make it available to all CLI commands and APIs
- Separate concerns: detection vs. action

## Architectural Decision: Where Should Freshness Check Live?

**Option A: In the check command (CLI layer)**
- Pros: Simple, localized change
- Cons: Not reusable, duplication when other commands need it, CLI knows too much

**Option B: In GuaranteeManager (domain layer)**
- Pros: Close to the validation logic
- Cons: Guarantees are a specific feature, freshness is more general

**Option C: New GraphFreshnessChecker service (infrastructure layer)**
- Pros: Reusable, single responsibility, testable, can be used by MCP too
- Cons: New abstraction

**Decision: Option C** - Create `GraphFreshnessChecker` as a new core service. This aligns with the project vision: the graph should be trustworthy. Freshness checking is a fundamental capability, not specific to guarantees.

## High-Level Plan

### Phase 1: Core Infrastructure

1. **Create `GraphFreshnessChecker` class** in `packages/core/src/core/`
   - Method: `checkFreshness(graph, projectPath): Promise<FreshnessResult>`
   - Returns: `{ staleModules: ModuleInfo[], freshCount: number, staleCount: number }`
   - Efficiently iterates all MODULE nodes, compares hashes
   - Performance: batch file reads, use async where possible

2. **Centralize hash computation**
   - Extract `calculateFileHash()` to a shared utility (or use existing pattern from JSASTAnalyzer)
   - Single source of truth for hash algorithm

### Phase 2: Incremental Reanalysis Support

3. **Create `IncrementalReanalyzer` class** (or extend existing)
   - Takes list of stale modules
   - Runs appropriate plugins to update their analysis
   - This might reuse logic from `JSASTAnalyzer` and other analyzers

   **Key insight**: The existing `Orchestrator.run()` with `forceAnalysis=true` is too heavy-handed. We need selective re-analysis.

### Phase 3: CLI Integration

4. **Modify `check.ts` command**
   - Before validation: call `GraphFreshnessChecker.checkFreshness()`
   - If stale modules found AND `--skip-reanalysis` not set:
     - Show warning about stale modules
     - Trigger incremental reanalysis
     - Then proceed with check
   - Add `--skip-reanalysis` flag

5. **Add freshness warnings**
   - Clear output when files were re-analyzed
   - Count and timing information

## Performance Considerations

The acceptance criteria demands `< 1 second for 1000 files` for hash checking.

Analysis:
- SHA-256 of file content: ~5-10ms per file (depends on file size)
- 1000 files sequentially: 5-10 seconds (too slow)
- 1000 files with Promise.all: ~100-500ms (feasible)
- With worker threads: even faster but adds complexity

**Strategy:**
1. Batch file reads with `Promise.all()` in groups of 50-100
2. Skip non-existent files (deleted modules)
3. Cache results if needed for subsequent operations

## Edge Cases

1. **Deleted files**: Module in graph but file doesn't exist
   - Should be flagged as stale (or orphaned)

2. **New files**: File exists but no module in graph
   - Not detectable by freshness check (need full re-index)
   - Out of scope for this feature

3. **Permission errors**: Can't read file
   - Treat as stale with warning

4. **Empty graph**: No modules at all
   - Warning: "Graph empty, run `grafema analyze` first"

5. **CI mode**: Want to fail fast without reanalysis
   - `--skip-reanalysis` + `--fail-on-stale` flags

## Files to Modify/Create

**New files:**
- `packages/core/src/core/GraphFreshnessChecker.ts` - Main service
- `packages/core/src/core/HashUtils.ts` - Centralized hash computation (optional, could inline)
- `test/unit/GraphFreshnessChecker.test.js` - Tests

**Modified files:**
- `packages/core/src/index.ts` - Export new classes
- `packages/cli/src/commands/check.ts` - Integrate freshness check
- `packages/cli/test/cli.test.ts` - Add tests for new flags

## API Design

```typescript
// GraphFreshnessChecker.ts
interface StaleModule {
  id: string;
  file: string;
  storedHash: string;
  currentHash: string | null; // null if file deleted
}

interface FreshnessResult {
  isFresh: boolean;
  staleModules: StaleModule[];
  freshCount: number;
  staleCount: number;
  deletedCount: number;
  checkDurationMs: number;
}

class GraphFreshnessChecker {
  async checkFreshness(
    graph: GraphBackend,
    projectPath: string
  ): Promise<FreshnessResult>;

  async reanalyzeStale(
    graph: GraphBackend,
    staleModules: StaleModule[],
    projectPath: string,
    plugins: Plugin[]
  ): Promise<void>;
}
```

## Alignment with Project Vision

This feature directly supports the core thesis: **AI should query the graph, not read code.**

If the graph can be stale without the user knowing, it undermines trust. The graph must either be fresh or clearly warn that it's not. This is a fundamental integrity requirement.

## What I'm NOT Doing (and Why)

1. **Not using IncrementalAnalysisPlugin** - It's VCS-based, we need hash-based
2. **Not modifying Orchestrator** - It's for full analysis, not freshness checks
3. **Not adding to GuaranteeManager** - Freshness is more general than guarantees
4. **Not checking new files** - That requires re-discovery, different feature

## Critical Files for Implementation

1. `/Users/vadimr/grafema/packages/cli/src/commands/check.ts` - Integration point for freshness check before validation
2. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Pattern to follow for `shouldAnalyzeModule()` and `calculateFileHash()`
3. `/Users/vadimr/grafema/packages/core/src/core/GuaranteeManager.ts` - Example of iterating MODULE nodes via `graph.queryNodes()`
4. `/Users/vadimr/grafema/packages/core/src/index.ts` - Where to export new `GraphFreshnessChecker`
5. `/Users/vadimr/grafema/packages/core/src/plugins/indexing/JSModuleIndexer.ts` - How `contentHash` is stored in MODULE nodes

---

This plan is RIGHT because it:
1. Creates a reusable service, not a one-off hack
2. Separates concerns (detection vs. action)
3. Aligns with existing patterns in the codebase
4. Supports the project vision of trustworthy graph data
5. Has clear performance strategy
6. Handles edge cases explicitly
