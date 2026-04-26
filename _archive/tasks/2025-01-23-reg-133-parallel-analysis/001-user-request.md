# User Request: REG-133

## Issue
Tech Debt: Remove or properly implement worker-based parallel analysis

## Context
During REG-131 (Semantic ID Migration), we discovered that the worker files (AnalysisWorker.ts, QueueWorker.ts, ASTWorker.ts, ParallelAnalyzer.ts) are dead code:
- `ParallelAnalyzer` is NOT exported from `@grafema/core`
- CLI `analyze` command uses `Orchestrator` with single-threaded `JSASTAnalyzer`
- No production code imports these workers

## Problem
These files still contain legacy `FUNCTION#` ID format and are not consistent with the semantic ID migration. If they were ever used, they would produce inconsistent output.

## User's Decision
**Properly implement parallel analysis** — Add scopeTracker support to workers and export the parallel analyzer.

## Files Affected
- `packages/core/src/core/AnalysisWorker.ts`
- `packages/core/src/core/QueueWorker.ts`
- `packages/core/src/core/ASTWorker.ts`
- `packages/core/src/analysis/ParallelAnalyzer.ts` (if exists)

## Related
- REG-131 (discovered this during semantic ID migration)
