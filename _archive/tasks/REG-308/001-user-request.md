# REG-308: Fix server-side file filtering in graph backend

## Problem

FileExplainer had to add client-side filtering as a workaround because server-side file filter "may not work correctly" (per code comment).

From `packages/core/src/core/FileExplainer.ts`:

```typescript
for await (const node of this.graph.queryNodes(filter)) {
  // Client-side filter as backup (server filter may not work correctly)
  if (node.file === filePath) {
    nodes.push(node);
  }
}
```

This is inefficient - we're fetching all nodes and filtering client-side.

## Expected Behavior

When calling `graph.queryNodes({ file: 'path/to/file.ts' })`, the backend should only return nodes for that file.

## Investigation Needed

1. Verify the bug exists (create minimal repro)
2. Identify root cause in RFDB server
3. Fix the filtering logic

## Acceptance Criteria

1. `queryNodes({ file: path })` returns only nodes for that file
2. No client-side filtering needed in FileExplainer
3. Performance improvement confirmed

## Context

Created as follow-up from REG-177 per Kevlin/Linus reviews.
