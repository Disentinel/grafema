# REG-507: Implementation Report

## Summary

Added `count: true` parameter to the `query_graph` MCP tool. When set, the tool runs the Datalog query normally but returns only the total count as text (`"Count: N"`) instead of enriched node data.

## Changes

### 1. `packages/mcp/src/types.ts`

Added `count?: boolean` with JSDoc to `QueryGraphArgs` interface:

```ts
export interface QueryGraphArgs {
  query: string;
  limit?: number;
  offset?: number;
  format?: 'table' | 'json' | 'tree';
  explain?: boolean;
  /** When true, returns only the count of matching results instead of the full result list */
  count?: boolean;
}
```

### 2. `packages/mcp/src/definitions.ts`

Added `count` property to `query_graph` tool's `inputSchema.properties`:

```ts
count: {
  type: 'boolean',
  description: 'When true, returns only the count of matching results instead of the full result list',
},
```

### 3. `packages/mcp/src/handlers/query-handlers.ts`

- Destructured `count` from `args`
- Added count branch after `const total = results.length` and before `if (total === 0)`:

```ts
if (count) {
  return textResult(`Count: ${total}`);
}
```

## Priority rules

1. `explain: true` returns early before the query even runs in normal mode (line 43), so it always wins
2. `count: true` returns early after query execution but before zero-result hints and enrichment (line 53)
3. Default path (neither explain nor count) proceeds to enrichment as before

## Build verification

`pnpm build` completed successfully with zero TypeScript errors across all packages.
