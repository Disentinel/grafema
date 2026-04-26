# Don Melton Analysis - REG-233

## Issue Diagnosis

The bug report title is misleading. `console.log()` is NOT being matched as a network request.

**Actual root cause:** The `net:request` singleton node is created unconditionally in `FetchAnalyzer.execute()` at line 70-73, BEFORE analyzing any modules:

```typescript
// Create net:request singleton (GraphBackend handles deduplication)
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);
this.networkNodeCreated = true;
```

When a codebase has no HTTP requests:
- `net:request` singleton gets created
- No `http:request` nodes are created (correctly - no patterns match)
- No CALLS edges connect to `net:request`
- Result: disconnected `net:request` node fails connectivity validation

## Pattern Analysis

The 4 patterns in FetchAnalyzer correctly do NOT match `console.log()`:
1. Pattern 1 (line 153): Only matches `fetch` identifier
2. Pattern 2 (line 179): Only matches `axios.method()` member expressions
3. Pattern 3 (line 209): Only matches `axios(config)` calls
4. Pattern 4 (line 254): Matches identifiers containing 'fetch' or 'request' - neither present in `console.log`

`console.log()` has callee type `MemberExpression`, not `Identifier`, so Pattern 4 never sees it.

## Fix Strategy

**Create `net:request` singleton lazily** - only when first HTTP request is detected.

Changes required:
1. Remove unconditional singleton creation from `execute()`
2. Track if singleton exists
3. Create singleton on-demand when first `http:request` node is created
4. Update metrics accordingly

## Impact Assessment

- **Scope**: Single file change (`FetchAnalyzer.ts`)
- **Risk**: Low - lazy initialization is straightforward
- **Tests needed**: Unit test confirming no `net:request` created when no HTTP requests exist

## Recommendation

This is a Mini-MLA task (Don → Rob → Linus). Single module, clear fix, low complexity.
