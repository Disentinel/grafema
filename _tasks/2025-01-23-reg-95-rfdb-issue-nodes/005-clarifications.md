# Clarifications on Linus's Questions

## Q1: Issue Lifecycle - Which Option?

**Answer: Option C for MVP** - Issues accumulate forever, duplicates prevented by hash.

Rationale:
- Simplest approach that works
- Hash-based IDs prevent duplicates on re-run
- `createdAt` timestamp allows future "issue trends" feature
- Issue clearing can be added in Phase 2 (REG-96)
- No orchestrator changes needed for MVP

**Simplification:** Remove `lastSeenAt` for MVP. Only `createdAt` needed.

## Q2: reportIssue() - Required or Optional?

**Answer: Optional** - `reportIssue?(issue: IssueSpec): Promise<string>;`

Rationale:
- Backward compatible with existing plugins
- Plugins can check if available before calling
- Document as experimental, may become required in future version
- Clean migration path: plugins opt-in now, become required later

## Q3: Query API Design

**Answer: Use existing `queryNodes()` for MVP.**

No new `getIssues()` method needed. Issues are just nodes:

```typescript
// Get all security issues
for await (const issue of graph.queryNodes({ nodeType: 'issue:security' })) {
  console.log(issue);
}

// Get issues for specific node via AFFECTS edge
const edges = await graph.getIncomingEdges(nodeId, ['AFFECTS']);
for (const edge of edges) {
  const issue = await graph.getNode(edge.src);
}
```

Phase 2 can add convenience methods if needed.

## Summary of MVP Scope Reduction

1. ~~`lastSeenAt` timestamp~~ → Only `createdAt`
2. Issue lifecycle → Accumulate forever (duplicates prevented by hash)
3. Query API → Use existing `queryNodes()` infrastructure
4. `reportIssue` → Optional for backward compatibility

## Ready to Proceed

With these clarifications, the plan is ready for Kent Beck to write tests and Rob Pike to implement.
