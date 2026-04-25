# Don Melton - High-Level Plan

## Current State Analysis

**ForStatement IS already partially tracked:**
- `createLoopScopeHandler` in JSASTAnalyzer.ts handles `ForStatement`
- LOOP node IS created with `loopType: 'for'`
- HAS_BODY edge IS created from LOOP to body SCOPE
- Tests exist in `test/unit/plugins/analysis/ast/loop-nodes.test.ts`

## What's Missing (per Acceptance Criteria)

For classic `for` loops, we're NOT tracking the three key parts:
- `init`: `let i = 0` (needs HAS_INIT edge)
- `test`: `i < items.length` (needs HAS_CONDITION edge)
- `update`: `i++` (needs HAS_UPDATE edge)

These are important for:
- Analyzing loop bounds
- Detecting off-by-one patterns
- Understanding loop control flow

## Files to Modify

1. **`packages/types/src/edges.ts`** - Add `HAS_INIT` and `HAS_UPDATE` edge types
2. **`packages/core/src/plugins/analysis/ast/types.ts`** - Extend `LoopInfo` interface
3. **`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`** - Extract init/condition/update in `createLoopScopeHandler`
4. **`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`** - Create edges in `bufferLoopEdges`

## Existing Patterns to Follow

1. **HAS_CONDITION for BRANCH nodes** - `BranchInfo` has discriminant expression fields
2. **`extractDiscriminantExpression` method** - Extracts expression metadata
3. **GraphBuilder's `bufferBranchEdges`** - Shows how to create HAS_CONDITION edges

## Concerns

1. HAS_CONDITION already exists for BRANCH nodes - reuse for LOOP
2. HAS_INIT and HAS_UPDATE are new edge types - need to add to types
3. Must handle nullable parts (init/condition/update can all be omitted in for loop)
