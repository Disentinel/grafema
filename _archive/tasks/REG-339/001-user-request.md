# REG-339: Multiple analyzers create nodes without column

## Problem

After REG-337 made `column` REQUIRED for all physical nodes, several analyzers still create nodes without column because they use their own local interfaces instead of node contracts.

## Affected Analyzers

| Analyzer | Local Interface | Has column? |
| -- | -- | -- |
| FetchAnalyzer | HttpRequestNode | No |
| DatabaseAnalyzer | DatabaseQueryNode | No |
| SQLiteAnalyzer | SQLiteQueryNode | No |
| ExpressAnalyzer | EndpointNode, MountPointNode | No |
| ExpressRouteAnalyzer | EndpointNode, MiddlewareNode | No |
| SocketIOAnalyzer | SocketListenerNode, SocketRoomNode | No |
| SocketIOAnalyzer | SocketEmitNode | Yes |

## Impact

VS Code extension node selection is broken because these nodes get `column: 0` by default, making them win specificity contests against correctly positioned VARIABLE/CALL nodes.

Example at `Invitations.tsx:55`:

```typescript
const response = await authFetch(`/api/invitations/...`, {...})
```

* HTTP_REQUEST: column=0 (default, should be ~28)
* VARIABLE: column=12 (where `response` starts)
* CALL: column=28 (where `authFetch` starts)

Clicking on `const` shows HTTP_REQUEST instead of VARIABLE.

## Solution

For each analyzer:

1. Remove local node interface
2. Use node contract `.create()` method OR add `column` field
3. Pass `column` from `node.loc.start.column`

## Files to Change

* `packages/core/src/plugins/analysis/FetchAnalyzer.ts`
* `packages/core/src/plugins/analysis/DatabaseAnalyzer.ts`
* `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts`
* `packages/core/src/plugins/analysis/ExpressAnalyzer.ts`
* `packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`
* `packages/core/src/plugins/analysis/SocketIOAnalyzer.ts`

## Related

* REG-337 (made column REQUIRED for node contracts)
