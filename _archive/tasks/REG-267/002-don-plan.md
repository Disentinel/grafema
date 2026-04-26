# REG-267: Control Flow Layer - Don Melton's Analysis and Plan

**Date:** 2026-02-01
**Role:** Tech Lead
**Status:** Analysis Complete

---

## Executive Summary

The request is to implement a comprehensive control flow layer with BRANCH, LOOP, and TRY_BLOCK nodes and their associated edges. After thorough codebase analysis, I've found that **significant work has already been completed** and the remaining work is **less than initially scoped**.

### Current State

| Component | Status | Notes |
|-----------|--------|-------|
| **BRANCH node (switch)** | COMPLETE | REG-275 implemented switch statements |
| **BRANCH node (if)** | NOT IMPLEMENTED | Needs new visitor code |
| **LOOP node** | PARTIALLY COMPLETE | REG-272 added loop scopes, but as SCOPE not LOOP |
| **TRY_BLOCK** | PARTIALLY COMPLETE | Creates SCOPE nodes, not TRY_BLOCK nodes |
| **Function metadata** | NOT IMPLEMENTED | cyclomaticComplexity, etc. |

---

## Architecture Analysis

### 1. Existing Visitor Structure

The codebase uses a **hybrid visitor pattern**:

- **Module-level visitors** (in `packages/core/src/plugins/analysis/ast/visitors/`)
  - `FunctionVisitor.ts` - top-level function declarations
  - `VariableVisitor.ts` - top-level variable declarations (REG-272 added loop scope creation)
  - `ClassVisitor.ts` - class declarations
  - `CallExpressionVisitor.ts` - call tracking
  - `ImportExportVisitor.ts` - imports/exports
  - `TypeScriptVisitor.ts` - TS-specific (interfaces, enums, types)

- **Function-level traversal** (in `JSASTAnalyzer.analyzeFunctionBody()`)
  - Handles all statements inside function bodies
  - Uses inline handlers for: VariableDeclaration, CallExpression, IfStatement, ForStatement, WhileStatement, TryStatement, SwitchStatement, ReturnStatement, etc.

**KEY INSIGHT:** Control flow inside functions is handled by `analyzeFunctionBody()`, NOT by separate visitors. The existing `createLoopScopeHandler`, `createTryStatementHandler`, and `handleSwitchStatement` methods already handle the traversal.

### 2. Current Control Flow Implementation

#### What REG-275 Built (Switch Statements)

```
BRANCH (type='BRANCH', branchType='switch')
  |
  +--[HAS_CONDITION]--> EXPRESSION (discriminant)
  |
  +--[HAS_CASE]--> CASE (value, isDefault, fallsThrough, isEmpty)
  |
  +--[HAS_DEFAULT]--> CASE (isDefault=true)
```

Files modified:
- `packages/types/src/nodes.ts` - Added BRANCH, CASE types
- `packages/types/src/edges.ts` - Added HAS_CONDITION, HAS_CASE, HAS_DEFAULT
- `packages/core/src/plugins/analysis/ast/types.ts` - BranchInfo, CaseInfo interfaces
- `GraphBuilder.ts` - bufferBranchEdges(), bufferCaseEdges()
- `JSASTAnalyzer.ts` - handleSwitchStatement()

#### What REG-272 Built (Loop Variables)

- Loop scopes are created for for-in/for-of loops
- But they're created as **SCOPE nodes**, not LOOP nodes
- Variable assignments within loops use DERIVES_FROM edges

#### What's Currently Missing

1. **LOOP node type** - loops create SCOPE nodes, not LOOP nodes
2. **TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK** - try/catch creates SCOPE nodes, not specific block types
3. **BRANCH node for if statements** - no IfStatement tracking beyond scope creation
4. **ITERATES_OVER edge** - for-of/for-in don't track what collection they iterate
5. **HAS_CONSEQUENT, HAS_ALTERNATE** - if statements don't track branches
6. **HAS_BODY** - loops don't link to their body
7. **HAS_CATCH, HAS_FINALLY** - try blocks don't link to handlers
8. **Function metadata** - no cyclomaticComplexity, hasBranches, etc.

---

## Architectural Concerns

### 1. SCOPE vs Dedicated Node Types

**Current approach:** Everything creates SCOPE nodes with different `scopeType`:
- `scopeType: 'for-of-loop'`, `scopeType: 'try-block'`, etc.

**Linear issue asks for:** Dedicated node types:
- LOOP, TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK

**Analysis:**

The current SCOPE-based approach is **semantically correct but harder to query**. To answer "find all loops", you need:
```datalog
?[id, file, line] := *nodes[id, type, name, file, line, metadata],
                     type = "SCOPE",
                     get(metadata, "scopeType", st),
                     starts_with(st, "for") or starts_with(st, "while") or st = "do-while-loop"
```

With dedicated LOOP nodes:
```datalog
?[id, file, line] := *nodes[id, type, name, file, line, _], type = "LOOP"
```

**RECOMMENDATION:** Migrate to dedicated node types for query ergonomics. This aligns with project vision: "AI should query the graph, not read code."

### 2. Integration Strategy

**Option A: Create New ControlFlowVisitor**
- Pros: Clean separation, matches visitor pattern
- Cons: Duplicates traversal, needs coordination with analyzeFunctionBody

**Option B: Extend analyzeFunctionBody Handlers**
- Pros: Single traversal, proven pattern, lower risk
- Cons: Makes analyzeFunctionBody larger

**RECOMMENDATION:** Option B. The existing handlers (`createLoopScopeHandler`, `createTryStatementHandler`, `handleSwitchStatement`) are the right place. We should **modify** them to create the right node types, not add a parallel system.

### 3. Nested Control Flow

Nested structures like `if (x) { for (y of z) { try { ... } catch {} } }` are already handled correctly by:
- `scopeIdStack` - tracks current scope for CONTAINS edges
- `scopeTracker` - tracks scope path for semantic IDs

No architectural changes needed for nesting.

### 4. Function Metadata (cyclomaticComplexity)

This requires counting:
- Each if/else adds +1
- Each case in switch adds +1
- Each loop adds +1
- Each && or || adds +1

**Options:**
1. Count during traversal (pass counters through analyzeFunctionBody)
2. Post-process: query the graph for control flow nodes

**RECOMMENDATION:** Option 1 is simpler and more accurate. Add counters to the function traversal, then attach metadata to FUNCTION node before it's written to graph.

---

## The RIGHT Way to Implement This

### Phase 1: Node Type Migration (Foundation)

1. **Add new node types** to `packages/types/src/nodes.ts`:
   - `LOOP` (with loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while')
   - `TRY_BLOCK`
   - `CATCH_BLOCK`
   - `FINALLY_BLOCK`

2. **Add new edge types** to `packages/types/src/edges.ts`:
   - `HAS_CONSEQUENT` (BRANCH -> then block)
   - `HAS_ALTERNATE` (BRANCH -> else block)
   - `HAS_BODY` (LOOP -> body scope)
   - `HAS_CATCH` (TRY_BLOCK -> CATCH_BLOCK)
   - `HAS_FINALLY` (TRY_BLOCK -> FINALLY_BLOCK)
   - `ITERATES_OVER` (LOOP -> collection variable)

3. **Add info interfaces** to `packages/core/src/plugins/analysis/ast/types.ts`:
   - `LoopInfo` (parallel to BranchInfo)
   - `TryBlockInfo`, `CatchBlockInfo`, `FinallyBlockInfo`

### Phase 2: Loop Nodes

Modify `createLoopScopeHandler()` to:
1. Create LOOP node (not SCOPE)
2. Create SCOPE for loop body (as child)
3. Track ITERATES_OVER for for-in/for-of
4. Create HAS_BODY edge

### Phase 3: If Statement Nodes

Add `handleIfStatement()` similar to `handleSwitchStatement()`:
1. Create BRANCH node (branchType: 'if')
2. Create HAS_CONDITION edge to condition expression
3. Create SCOPE for consequent, link via HAS_CONSEQUENT
4. If else exists: create SCOPE for alternate, link via HAS_ALTERNATE
5. Handle else-if chains properly

### Phase 4: Try/Catch/Finally Nodes

Modify `createTryStatementHandler()` to:
1. Create TRY_BLOCK node (not SCOPE)
2. Create CATCH_BLOCK node (not SCOPE), link via HAS_CATCH
3. Create FINALLY_BLOCK node (not SCOPE), link via HAS_FINALLY
4. Keep catch parameter handling (variable declarations)

### Phase 5: GraphBuilder Updates

Add buffer methods for new node types:
- `bufferLoopNodes()`
- `bufferTryBlockNodes()`
- `bufferCatchBlockNodes()`
- `bufferFinallyBlockNodes()`

### Phase 6: Function Metadata

Add to FunctionInfo interface:
```typescript
controlFlow?: {
  hasBranches: boolean;
  hasLoops: boolean;
  hasTryCatch: boolean;
  hasEarlyReturn: boolean;
  hasThrow: boolean;
  cyclomaticComplexity: number;
}
```

Compute during analyzeFunctionBody traversal.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing tests | Medium | High | Run full test suite after each phase |
| Semantic ID format changes | Low | Medium | Keep current format for LOOP/TRY_BLOCK |
| Performance regression | Low | Low | Node creation is already batched |
| Query compatibility | Medium | Medium | SCOPE nodes still exist for body scopes |

---

## What NOT to Do

1. **Do NOT create a separate ControlFlowVisitor** - it would duplicate traversal
2. **Do NOT change semantic ID format** - keep backward compatibility
3. **Do NOT remove SCOPE nodes** - they're still needed for body scopes
4. **Do NOT modify REG-275's switch implementation** - it's correct

---

## Recommendation

Implement in this order:
1. Types and interfaces (Phase 1) - foundation
2. Loop nodes (Phase 2) - builds on REG-272 work
3. Try/catch nodes (Phase 4) - straightforward migration
4. If statement nodes (Phase 3) - new functionality
5. Function metadata (Phase 6) - depends on all above
6. GraphBuilder (Phase 5) - after all node types exist

Each phase should be a separate PR with tests.

---

## Estimated Complexity

| Phase | LOC Estimate | Test Coverage Needed |
|-------|--------------|----------------------|
| Phase 1 (Types) | ~100 | Type tests |
| Phase 2 (Loops) | ~150 | Loop tests (extend REG-272 tests) |
| Phase 3 (If) | ~200 | If/else/else-if tests |
| Phase 4 (Try) | ~150 | Try/catch/finally tests |
| Phase 5 (GraphBuilder) | ~200 | Integration tests |
| Phase 6 (Metadata) | ~100 | Metadata tests |

**Total:** ~900 LOC of production code, ~1500 LOC of tests

---

## Questions for User

1. **Priority order:** Do you want all phases, or specific ones first?
2. **Backward compatibility:** Should existing SCOPE nodes with `scopeType` be preserved alongside new node types?
3. **Scope:** Is function metadata (cyclomaticComplexity) needed for v0.2, or can it be v0.3?

---

*"I don't care if it works, is it RIGHT?"*

This plan is right because:
- It builds on existing, working infrastructure
- It doesn't duplicate traversal logic
- It creates the query ergonomics that align with Grafema's vision
- It's testable in phases
