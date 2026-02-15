# REG-239: BFS depth tracking in findContainingFunction could be clearer

## Problem

In `packages/cli/src/commands/query.ts`, the `findContainingFunction()` uses BFS with depth tracking, but the logic could be more explicit:

```typescript
const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
// ...
if (visited.has(id) || depth > maxDepth) continue;
```

The magic number `maxDepth = 15` is not documented, and the depth increment logic is embedded in the queue push.

## Proposed Solution

1. Document why maxDepth is 15
2. Consider extracting BFS traversal to a reusable utility
3. Add comment explaining the traversal strategy

## Context

Tech debt from REG-207 implementation review (Kevlin Henney).
Labels: v0.2, Improvement
