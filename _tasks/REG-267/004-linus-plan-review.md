# REG-267: Control Flow Layer - Linus Torvalds' Plan Review

**Date:** 2026-02-01
**Role:** High-Level Reviewer
**Status:** APPROVED WITH NOTES

---

## Verdict: APPROVED

The plan is architecturally sound and well-reasoned. Joel's tech spec is detailed enough for implementation. Proceed with the work.

---

## Vision Alignment: GOOD

This change directly serves Grafema's core thesis: **"AI should query the graph, not read code."**

Don's analysis nailed it:
```datalog
-- Before: Complex query to find all loops
?[id, file, line] := *nodes[id, type, name, file, line, metadata],
                     type = "SCOPE",
                     get(metadata, "scopeType", st),
                     starts_with(st, "for") or ...

-- After: Simple, obvious query
?[id, file, line] := *nodes[id, type, name, file, line, _], type = "LOOP"
```

Query ergonomics matter. If the graph structure forces complex queries, we've failed. Dedicated node types are the RIGHT abstraction.

---

## Architectural Review

### 1. Extending Existing Handlers vs. New ControlFlowVisitor

**Decision: Extend existing handlers. CORRECT.**

Don and Joel made the right call here. The codebase already has:
- `createLoopScopeHandler()` - handles all loop types
- `createTryStatementHandler()` - handles try/catch/finally
- `createIfStatementHandler()` - handles if/else
- `handleSwitchStatement()` - handles switch (already creates BRANCH nodes)

Creating a parallel `ControlFlowVisitor` would:
1. Duplicate AST traversal (performance hit)
2. Create coordination problems between visitors
3. Fragment the logic that should be cohesive

The existing handlers are the RIGHT place. They already traverse these structures.

### 2. Backward Compatibility Strategy

**Decision: Keep SCOPE nodes alongside new types. ACCEPTABLE BUT WATCH IT.**

The plan creates:
```
LOOP
  |
  +-- SCOPE (body)
```

This means:
- LOOP node represents the control flow construct
- SCOPE node represents the body scope (for variable declarations, etc.)
- Existing queries on SCOPE with `scopeType` continue to work

This is a reasonable transition strategy. However:

**WARNING:** Don't let this become permanent technical debt. The dual representation adds cognitive load. Track this for potential cleanup in v0.3+.

### 3. Semantic ID Strategy

Joel's spec shows semantic IDs like:
```typescript
computeSemanticId('LOOP', loopType, scopeTracker.getContext(), { discriminator: loopCounter })
```

This follows the existing pattern (see how BRANCH nodes are created in `handleSwitchStatement`). Good - consistency matters.

### 4. Hierarchy: Who Contains Whom?

The spec proposes:
```
FUNCTION
  |
  +-- CONTAINS --> LOOP
                     |
                     +-- HAS_BODY --> SCOPE (loop body)
                                        |
                                        +-- CONTAINS --> nested stuff
```

For try/catch:
```
FUNCTION
  |
  +-- CONTAINS --> TRY_BLOCK
                     |
                     +-- HAS_CATCH --> CATCH_BLOCK
                     |
                     +-- HAS_FINALLY --> FINALLY_BLOCK
```

This makes sense. Control flow nodes are CONTAINED by their parent scope. Their body scopes are linked via semantic edges (HAS_BODY, HAS_CATCH, etc.).

---

## Concerns and Risks

### 1. Cyclomatic Complexity Calculation - MINOR CONCERN

Joel's formula:
```
M = 1 + branches + cases + loops + logicalOps
```

This is a simplification. True McCabe complexity has edge cases:
- `case` fall-throughs shouldn't add to complexity
- Ternary operators (`? :`) should count
- `catch` blocks add paths

For v0.2, the simplified version is FINE. But document that it's "cyclomatic complexity (simplified)" - don't claim precision we don't have.

### 2. ITERATES_OVER Edge Resolution

Joel's spec says:
```typescript
const collectionVar = variableDeclarations.find(v =>
  v.name === loop.iteratesOverName &&
  v.file === loop.file
);
```

This will find the WRONG variable if there are multiple variables with the same name in different scopes. The lookup should scope-aware.

**FIX:** Either:
1. Pass `parentScopeId` to the lookup and filter by scope
2. Or defer this edge creation to the enrichment phase (where we have full graph)

This is a BLOCKING issue for Phase 2. Fix the design before implementing.

### 3. If-Branch Scope Type Names

Joel uses `scopeType: 'if_statement'` and `scopeType: 'else_statement'` in the spec, but the existing code (line 2332-2333 in JSASTAnalyzer.ts) might use different names. Verify the actual scope type strings before implementing.

### 4. Test Coverage

The spec lists test scenarios but doesn't mention edge cases:
- Empty loops (`for (;;) {}`)
- Labeled statements (`outer: for (...)`)
- Async iteration (`for await (const x of ...)`)
- Destructuring in loops (`for (const [a, b] of ...)`)
- Optional catch binding (`catch { ... }` without parameter)

These should be in the test plan.

---

## Implementation Order Review

Joel proposes: 1 -> 2 -> 4 -> 3 -> 5 -> 6

Let me verify the dependency graph:
- Phase 1 (Types): No deps. Foundation.
- Phase 2 (Loops): Depends on 1
- Phase 3 (If): Depends on 1, uses existing BRANCH type
- Phase 4 (Try): Depends on 1
- Phase 5 (GraphBuilder): Depends on 2, 3, 4
- Phase 6 (Metadata): Depends on 2, 3, 4 for counters

The proposed order is CORRECT. Doing 4 before 3 makes sense because try/catch is a simpler migration (existing handler already creates scopes, just need to add node types), while if-statements require more extensive changes to create BRANCH nodes.

---

## What NOT to Screw Up

1. **Don't break existing tests.** Run the full suite after each phase.

2. **Don't change the switch statement implementation.** REG-275 already works. Leave it alone.

3. **Don't make the GraphBuilder a mess.** The spec adds 4 new buffer methods. Group them logically, keep the method order consistent.

4. **Don't forget to update ASTCollections.** The interface needs the new collection types AND counter refs.

---

## Questions for Implementation

1. **ITERATES_OVER scope resolution:** How will you handle the case where the iterated variable has the same name in multiple scopes? This needs a clear answer before Phase 2.

2. **Early return detection:** Joel mentions "if not the last statement in function body" for early return detection. How exactly will you determine this? The traversal is bottom-up, so you need to track statement positions.

---

## Final Assessment

| Aspect | Rating | Notes |
|--------|--------|-------|
| Vision alignment | GOOD | Improves query ergonomics |
| Architecture | GOOD | Extends existing patterns |
| Implementation order | CORRECT | Dependencies respected |
| Risk management | ACCEPTABLE | Main risks identified |
| Test coverage | NEEDS WORK | Add edge cases |

**VERDICT: APPROVED**

The plan is solid. The ITERATES_OVER scope issue needs resolution, but it's a detail that can be fixed during implementation. The overall approach is right.

Proceed with implementation. Kent should write tests first (TDD), then Rob implements.

---

*"Talk is cheap. Show me the code."*

But in this case, the talk was good enough. Now show me the code.
