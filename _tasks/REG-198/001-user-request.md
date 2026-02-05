# REG-198: Enforce Branded Nodes in GraphBackend.addNode

**Priority:** Urgent
**Linear:** https://linear.app/reginaflow/issue/REG-198/enforce-branded-nodes-in-graphbackendaddnode

## Context

This is Phase 2 of REG-111 (branded types). Phase 1 is complete:

* Created `BrandedNode<T>` type system in `@grafema/types`
* NodeFactory returns branded nodes
* Build passes, tests pass

## Task

Change GraphBackend.addNode signature to only accept branded nodes:

```typescript
// Current
abstract addNode(node: NodeRecord): Promise<void>;

// Target
abstract addNode(node: AnyBrandedNode): Promise<void>;
```

## Required Changes

When this change is made, ~60 compile errors appear across:

* `GraphBuilder.ts` — uses `GraphNode[]` buffer type
* All analyzers that create inline nodes (ExpressAnalyzer, etc.)
* Tests that create nodes inline

### Approach

1. Update `GraphBuilder` to use branded types internally
2. Add missing factory methods to NodeFactory:
   * `createHttpRoute()` for ExpressAnalyzer
   * `createExpressMount()` for ExpressAnalyzer
   * Any other missing node types
3. Update analyzers to use NodeFactory
4. Update tests or create test helpers

## Acceptance Criteria

- [ ] `GraphBackend.addNode` only accepts `AnyBrandedNode`
- [ ] `plugins.ts` interface matches
- [ ] All analyzers use NodeFactory
- [ ] Build passes
- [ ] Tests pass

## References

* Parent: REG-111
* Implementation report: `_tasks/2025-01-25-reg-111-branded-types/003-rob-implementation-report.md`
