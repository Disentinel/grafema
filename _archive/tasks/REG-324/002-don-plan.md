# Don Plan - REG-324: responseDataNode links to wrong response.json()

## Analysis

### Current Behavior
`findResponseJsonCall()` returns the FIRST `response.json()` call in the file that matches the variable name, regardless of which function it's in.

### Root Cause
```typescript
for await (const node of graph.queryNodes({ type: 'CALL' })) {
  if (node.file !== file) continue;
  if (callNode.object !== responseVarName) continue;
  // Returns FIRST match - wrong!
}
```

### Solution
Add `fetchLine` parameter and filter to find the `response.json()` call that:
1. Is in the same file
2. Has matching object name
3. Has `line > fetchLine` (comes AFTER the fetch call)
4. Is the CLOSEST to the fetch (smallest line number among matches)

This ensures we get the response.json() from the same function scope.

## Implementation

1. Update `findResponseJsonCall()` signature to include `fetchLine: number`
2. Collect all matching CALL nodes
3. Filter to `line > fetchLine`
4. Return the one with smallest line number (closest to fetch)

## Complexity
O(n) where n = CALL nodes in file. Same as before, just with post-filtering.

## Lens
Mini-MLA: straightforward local fix similar to REG-322 pattern.
