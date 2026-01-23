# REG-133: Parallel Analysis Architecture Plan

**Author:** Don Melton (Tech Lead)

## Executive Summary

Worker-based parallel analysis code exists but is dead code: `ParallelAnalyzer` is not exported, workers use legacy `FUNCTION#` ID format incompatible with the semantic ID system. The user has decided to **properly implement** parallel analysis rather than remove it.

**Key Insight:** The semantic ID system (`ScopeTracker` + `SemanticId`) is fundamentally file-scoped and stateless between files. This means parallel analysis IS architecturally sound - each worker can have its own `ScopeTracker` instance per file.

## Architecture Analysis

### Current Working Flow (Single-Threaded)

```
Orchestrator.run()
  -> runPhase('ANALYSIS')
    -> JSASTAnalyzer.execute()
      -> for each module:
          -> analyzeModule()
            -> new ScopeTracker(basename(file))  // File-scoped state
            -> traverse AST with scopeTracker
            -> graphBuilder.build(collections)
```

### Worker Files (Dead Code)

| File | Purpose | Legacy Pattern | Issue |
|------|---------|---------------|-------|
| `AnalysisWorker.ts` | Parallel AST parsing + RFDB writes | `FUNCTION#name#file#line` | No ScopeTracker |
| `QueueWorker.ts` | Queue-based plugin execution | `FUNCTION#name#file#line` | No ScopeTracker |
| `ASTWorker.ts` | Parallel AST parsing, returns collections | `FUNCTION#name#file#line` | No ScopeTracker |
| `ParallelAnalyzer.ts` | Worker pool orchestration | Uses AnalysisWorker | Not exported |
| `AnalysisQueue.ts` | Task queue for workers | Uses QueueWorker | Not connected to CLI |

### Why This Is Fixable (Not Architectural Blocker)

**ScopeTracker is file-scoped:**
- Created fresh for each file: `new ScopeTracker(basename(file))`
- No shared state between files
- Counter reset between files

**Implication:** Each worker can have its own `ScopeTracker` per file being analyzed. No synchronization needed.

## Recommended Approach

### Option A: ASTWorker Pattern (Recommended)

**Parse in workers, build graph in main thread.**

```
Workers: Parse AST -> Extract raw collections (with locations)
Main:    ScopeTracker + SemanticId -> GraphBuilder -> Graph writes
```

**Pros:**
- ScopeTracker stays in main thread (simpler)
- Workers are stateless parsers
- Existing GraphBuilder integration preserved
- Easy to test and debug

**Cons:**
- Collections transfer overhead (but minimal - just metadata)
- Graph writes still sequential (but batched)

### Option B: Full Worker Pattern

**Parse AND generate IDs in workers, write to RFDB.**

```
Workers: Parse AST -> ScopeTracker per file -> NodeFactory.createWithContext() -> RFDB writes
Main:    Just orchestration
```

**Pros:**
- Maximum parallelism
- Direct RFDB writes (concurrent safe)

**Cons:**
- More complex implementation
- Must ensure RFDB write concurrency is correct
- Harder to debug

### Recommendation: Option A

**Reason:** The bottleneck in Grafema analysis is Babel parsing, not ID generation or graph writes. Option A addresses the bottleneck while keeping complexity low.

## Implementation Strategy

### Phase 1: Fix ASTWorker (Low Risk)

1. Migrate `ASTWorker.ts` to use `NodeFactory.create()` methods instead of inline ID construction
2. Keep returning collections to main thread
3. Main thread uses `ScopeTracker` + `createWithContext()` for semantic IDs

**Changes:**
- `ASTWorker.ts`: Use node factories, return raw info (name, line, column) not IDs
- `ASTWorkerPool.ts`: No changes needed
- `JSASTAnalyzer.ts`: Add parallel mode using `ASTWorkerPool`

### Phase 2: Enable Parallel Mode in JSASTAnalyzer

Add flag to switch between:
- Sequential: Current behavior (one file at a time)
- Parallel: Use `ASTWorkerPool` for parsing, process collections sequentially

### Phase 3: Cleanup Dead Code

Either:
- Remove `AnalysisWorker.ts`, `QueueWorker.ts`, `ParallelAnalyzer.ts`, `AnalysisQueue.ts`
- Or: Migrate them to semantic IDs if there's a use case for full worker mode

### Phase 4: Export and Document

- Export `ASTWorkerPool` from `@grafema/core` if useful externally
- Add documentation for parallel analysis configuration

## Risk Assessment

### Low Risk
- ASTWorker already returns collections to main thread
- ScopeTracker is file-scoped, no cross-file state
- Existing tests cover semantic ID generation

### Medium Risk
- Worker error handling (crashes, timeouts)
- Memory pressure with large codebases (many collections in flight)

### Mitigations
- Batch size limits (already exist in Orchestrator)
- Worker restart on error
- Collection streaming instead of all-at-once

## Alignment with Grafema Vision

**Does parallel analysis align with Grafema's vision?**

**Yes, conditionally:**
- Target is massive legacy codebases - performance matters
- AI should query the graph, not read code - faster graph building = faster AI feedback loop
- However: Parallel analysis is an implementation detail, not a user-facing feature

**The right way to think about this:**
- Graph quality > graph speed
- But graph speed enables faster iteration
- Semantic IDs are the foundation - parallel analysis must preserve them

## Recommendation

1. **Start with Phase 1** - Fix `ASTWorker.ts` to use node factories
2. **Skip Options B approaches** - `AnalysisWorker.ts` and `QueueWorker.ts` are over-engineered for current needs
3. **Consider removal** of `AnalysisWorker.ts`, `QueueWorker.ts`, `ParallelAnalyzer.ts`, `AnalysisQueue.ts` after Phase 1 proves out
4. **Keep it simple** - The main thread doing ID generation and graph writes is fine for now

## Critical Files for Implementation

- `/packages/core/src/core/ASTWorker.ts` - Primary worker to migrate to node factories
- `/packages/core/src/core/ScopeTracker.ts` - Core semantic ID state management (reference for pattern)
- `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Main analysis plugin, needs parallel mode integration
- `/packages/core/src/core/nodes/FunctionNode.ts` - Pattern for `createWithContext()` usage
- `/packages/core/src/core/ASTWorkerPool.ts` - Worker pool orchestration (already exists)
