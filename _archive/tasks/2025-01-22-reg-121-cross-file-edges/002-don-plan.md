# Don Melton - Analysis Plan for REG-121

## Root Cause Analysis

The problem lies in the **timing and order-dependency of cross-file edge creation**, specifically for `IMPORTS_FROM` edges.

### Current Architecture

1. **Orchestrator.run()** clears the entire graph at start (if `forceAnalysis=true`):
   ```typescript
   // Orchestrator.ts:169-172
   if (this.forceAnalysis && this.graph.clear) {
     await this.graph.clear();
   }
   ```

2. **ANALYSIS phase** processes modules in parallel batches:
   - Each module is analyzed independently by `JSASTAnalyzer.analyzeModule()`
   - `GraphBuilder.build()` creates nodes and edges for each file

3. **GraphBuilder.build()** has two stages:
   - **Synchronous buffered stage**: Nodes and intra-file edges are buffered
   - **Async stage**: Cross-file edges (`createImportExportEdges`) are created AFTER flush

4. **Critical flaw in `createImportExportEdges()`** (GraphBuilder.ts):
   - For each import, queries the graph for target MODULE
   - Then queries for EXPORT nodes in that module
   - **But those nodes may not exist yet** if the target file hasn't been processed

### The Race Condition

When files are processed in parallel batches:

1. **File A (index.js)** imports from **File B (utils.js)**
2. Both files may be in different batches or processed concurrently
3. When `createImportExportEdges` runs for File A, File B's EXPORT nodes may NOT exist yet

This is **not a bug in the clear operation itself** - it's a fundamental **order-dependency problem** in the parallel analysis architecture.

### Why It Worked Before (Sometimes)

The issue is non-deterministic:
- If the exporting file is analyzed BEFORE the importing file, edges are created
- If batch ordering or timing changes, edges may be missing
- First analysis often works because files are discovered in a favorable order

### Architectural Mismatch with Project Vision

The current implementation has cross-file edges created **during per-file analysis**, which violates the principle that the graph should be complete and consistent for querying.

### There Are Actually TWO Places Creating IMPORTS_FROM Edges

1. **GraphBuilder.createImportExportEdges()** - Per-file, async, during ANALYSIS phase
2. **ImportExportLinker** - Enrichment plugin, runs AFTER analysis is complete

**The redundancy is the problem**: `GraphBuilder` tries to create edges immediately (often failing due to timing), while `ImportExportLinker` creates them properly later.

## Proposed Solution

**Remove cross-file edge creation from GraphBuilder entirely. Rely solely on ImportExportLinker.**

This is architecturally correct because:
1. **Single Responsibility**: GraphBuilder handles intra-file graph construction
2. **Correct Timing**: ENRICHMENT phase has all nodes available
3. **Deterministic Results**: No race conditions
4. **Already Implemented**: ImportExportLinker already exists and works

## Implementation Plan

### Phase 1: Remove Redundant Code from GraphBuilder

1. Remove `createImportExportEdges()` method from GraphBuilder
2. Keep `bufferImportNodes()` - still creates IMPORT nodes
3. Remove redundant MODULE -> IMPORTS -> MODULE edge creation

### Phase 2: Ensure ImportExportLinker is Complete

1. Verify ImportExportLinker creates both edge types:
   - `IMPORT -> IMPORTS_FROM -> EXPORT` edges
   - `MODULE -> IMPORTS -> MODULE` edges (may need to add)

2. Add test coverage for cross-file edge consistency after clear

### Phase 3: Similar Cleanup for CLASS Edges

Same pattern exists for `createClassAssignmentEdges()` - should be moved to enrichment

## Files to Modify

1. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
2. `packages/core/src/plugins/enrichment/ImportExportLinker.ts`
3. `test/unit/ClearAndRebuild.test.js`

## Risk Assessment

**Low risk** - This is cleanup/refactoring that:
- Removes race conditions
- Simplifies code
- Uses existing, tested code
- Makes system deterministic
