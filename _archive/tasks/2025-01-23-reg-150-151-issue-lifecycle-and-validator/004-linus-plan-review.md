# Linus Torvalds - Plan Review

## Verdict: APPROVED WITH MINOR CHANGES

## High-Level Assessment

The plan is fundamentally correct. Joel understands the problem and proposes the right solution: types in `packages/types`, utility class for issue creation, and wiring through Orchestrator. The lifecycle decision (issues clear with all other file nodes via `clearFileNodesIfNeeded`) is the correct call - Don got this right.

The overall approach aligns with the project vision. Issues become queryable graph nodes, which means AI agents can query `issue:security` nodes instead of reading logs. That is exactly what Grafema is for.

## Concerns

### MINOR: IssueReporter Class is Unnecessary Complexity

Joel proposes an `IssueReporter` class that wraps `NodeFactory.createIssue()` and tracks count. This is over-engineering.

**Alternative:** Just add `reportIssue` as a function that calls `NodeFactory.createIssue()` and `graph.addNode()`. No class needed. The plugin can track its own count like every other plugin does.

However, this is not a blocker. If Joel wants the class for future extensibility (logging, batching, etc.), fine.

### MINOR: Type Duplication Strategy Not Clear

The plan says add types to `packages/types/src/nodes.ts`. But it does not say what happens to the types in `IssueNode.ts`.

The right answer: move types to `packages/types`, have `IssueNode.ts` import from `@grafema/types`. Joel should make this explicit.

### MINOR: Missing Lifecycle Tests

Acceptance criteria should include:
- "Test: reanalyze file with issue, verify issue is cleared and re-created with same ID"
- "Test: reanalyze file without issue (code fixed), verify issue is gone"

## What I'd Do Differently

1. Skip `IssueReporter` class. Just use a function inline in Orchestrator:
```typescript
pluginContext.reportIssue = async (issue: IssueSpec): Promise<string> => {
  const node = NodeFactory.createIssue(...);
  await context.graph.addNode(node);
  if (issue.targetNodeId) {
    await context.graph.addEdge({ src: node.id, dst: issue.targetNodeId, type: 'AFFECTS' });
  }
  return node.id;
};
```

2. Be explicit about type migration strategy.

3. Add lifecycle tests to acceptance criteria.

## Summary

The plan is sound. The architecture is right. The lifecycle decision is correct.

**Verdict: APPROVED** - proceed with implementation. Address minor issues during implementation.
