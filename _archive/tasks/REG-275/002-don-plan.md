# Don Melton: High-Level Plan for REG-275

## Current State Analysis

The current implementation handles `SwitchStatement` minimally in `JSASTAnalyzer.ts` (lines 2261-2274):
- Creates a single `SCOPE` node with `scopeType: 'switch-case'`
- Does NOT track the discriminant expression
- Does NOT track individual case clauses
- Does NOT track fall-through patterns

This is insufficient for analyzing Redux reducers, state machines, and missing case detection.

## What Already Exists That We Can Leverage

1. **ConditionParser** (`packages/core/src/plugins/analysis/ast/ConditionParser.ts`) - Parses conditions, could be extended for switch discriminants

2. **Node Factory Pattern** (`packages/core/src/core/NodeFactory.ts` and `nodes/` directory) - Established pattern for creating node contracts

3. **GraphBuilder Buffer Pattern** (`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`) - `_bufferNode()` and `_bufferEdge()` methods for batched writes

4. **ExpressionNode** (`packages/core/src/core/nodes/ExpressionNode.ts`) - Can be reused for discriminant expressions

5. **ScopeTracker** - Provides semantic ID context for stable node identification

6. **Test Pattern** (see `object-property-edges.test.ts`) - Template for TDD approach using `createTestOrchestrator`

## Key Files That Need Modification

| File | Changes |
|------|---------|
| `packages/types/src/nodes.ts` | Add BRANCH, CASE node types |
| `packages/types/src/edges.ts` | Add HAS_CONDITION, HAS_CASE, HAS_DEFAULT edge types |
| `packages/core/src/core/nodes/BranchNode.ts` | New - BRANCH node contract |
| `packages/core/src/core/nodes/CaseNode.ts` | New - CASE node contract |
| `packages/core/src/core/nodes/index.ts` | Export new nodes |
| `packages/core/src/core/NodeFactory.ts` | Add createBranch, createCase methods |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add BranchInfo, CaseInfo interfaces |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Update SwitchStatement handler |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add buffer methods for BRANCH/CASE |

## High-Level Approach

**Phase 1: Type System Foundation**
1. Add `BRANCH` to `NODE_TYPE` in `packages/types/src/nodes.ts`
2. Add `CASE` to `NODE_TYPE` (or consider namespaced `branch:case`)
3. Add `HAS_CONDITION`, `HAS_CASE`, `HAS_DEFAULT` to `EDGE_TYPE` in `packages/types/src/edges.ts`

**Phase 2: Node Contracts**
4. Create `BranchNode.ts` following `ScopeNode.ts` pattern
   - ID format: `{file}:BRANCH:switch:{line}`
   - Required fields: `file`, `line`, `branchType` (for future: if/switch/ternary)
5. Create `CaseNode.ts`
   - ID format: `{file}:CASE:{value}:{line}` or `{file}:CASE:default:{line}`
   - Required fields: `file`, `line`, `value` (or `isDefault`)
   - Optional: `fallsThrough: boolean`

**Phase 3: Collection Types**
6. Add `BranchInfo` interface to `types.ts`
7. Add `CaseInfo` interface with fall-through tracking
8. Add `branches: BranchInfo[]` and `cases: CaseInfo[]` to `ASTCollections`

**Phase 4: JSASTAnalyzer Implementation**
9. Replace current `SwitchStatement` handler with comprehensive extraction:
   - Create BRANCH node for the switch
   - Extract discriminant expression (reuse ExpressionNode pattern)
   - Iterate `switchNode.cases` and create CASE nodes
   - Track fall-through: case without `break`/`return`

**Phase 5: GraphBuilder Integration**
10. Add `bufferBranchNodes()` method
11. Add `bufferCaseNodes()` method
12. Create edges: BRANCH -[HAS_CONDITION]-> EXPRESSION
13. Create edges: BRANCH -[HAS_CASE]-> CASE
14. Create edges: BRANCH -[HAS_DEFAULT]-> CASE (where `isDefault: true`)

## Open Questions / Architectural Concerns

1. **Backward Compatibility**: Should we keep the old SCOPE#switch-case node in addition to BRANCH, or replace it?
   - Recommendation: Replace, not both. BRANCH is the correct abstraction.

2. **Fall-through Detection**: How to represent?
   - Option A: Boolean `fallsThrough` on CASE node
   - Option B: `FALLS_THROUGH` edge between consecutive cases
   - Recommendation: Option A is simpler; Option B if we need to trace flow

3. **IfStatement Alignment**: Should IfStatement also become BRANCH?
   - This would be a separate task (REG-276?)
   - Important for consistent branching analysis
   - Affects: Redux reducers with nested ifs, state machine patterns

4. **Discriminant Expression**: How complex can it be?
   - Simple: `switch(x)` - variable
   - Medium: `switch(action.type)` - member expression
   - Complex: `switch(getType())` - call expression
   - Recommendation: Reuse ExpressionNode, create EXPRESSION node for discriminant

5. **Empty Cases**: How to handle `case 'A': case 'B': return x;`?
   - Both cases exist, first falls through to second
   - Recommendation: Create both CASE nodes, mark first with `fallsThrough: true`

## Critical Files

1. `packages/types/src/nodes.ts` - Add BRANCH, CASE types
2. `packages/types/src/edges.ts` - Add HAS_CONDITION, HAS_CASE, HAS_DEFAULT
3. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - SwitchStatement handler (lines 2261-2275)
4. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Buffer methods for new nodes/edges
5. `packages/core/src/core/nodes/ScopeNode.ts` - Pattern to follow for BranchNode
