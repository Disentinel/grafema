# REG-322: Don Melton Analysis - HANDLED_BY Edge Wrong Target

## Executive Summary

The root cause is **queryNodes does not support `line` filtering**. The `NodeQuery` interface only supports `nodeType`, `type`, `name`, and `file` fields. When ExpressRouteAnalyzer queries with `line`, this field is silently ignored, causing it to return ALL FUNCTION nodes in the file, and the `break` statement takes the first one - which is not necessarily at the target line.

## How The Current Code Works

### 1. ExpressRouteAnalyzer Detects Routes

When analyzing a file like:
```typescript
router.post('/:id/accept',
  authenticateToken,
  idParamValidation,
  invitationAcceptValidation,
  async (req, res) => {  // line 202 - the handler
    const invitation = await new Promise((resolve, reject) => { // line 205 - nested
      // ...
    });
  }
);
```

ExpressRouteAnalyzer:
1. Identifies `router.post()` as an HTTP route
2. Takes the LAST argument as the handler (correct - line 217-234 in ExpressRouteAnalyzer.ts)
3. Records `handlerLine = 202` (the line of the arrow function)
4. Creates `http:route` node

### 2. ExpressRouteAnalyzer Creates HANDLED_BY Edge

Lines 341-358 in ExpressRouteAnalyzer.ts:
```typescript
if (handlerLine) {
  for await (const fn of graph.queryNodes({
    type: 'FUNCTION',
    file: module.file,
    line: handlerLine  // <-- THIS FIELD IS IGNORED!
  })) {
    await graph.addEdge({
      type: 'HANDLED_BY',
      src: endpoint.id,
      dst: fn.id
    });
    break; // Takes FIRST function returned
  }
}
```

### 3. NodeQuery Interface (The Problem)

From `packages/core/src/storage/backends/RFDBServerBackend.ts` lines 74-79:
```typescript
export interface NodeQuery {
  nodeType?: NodeType;
  type?: NodeType;
  name?: string;
  file?: string;
  // NOTE: No `line` field!
}
```

The `queryNodes` method builds a server query using only these fields:
```typescript
const serverQuery: NodeQuery = {};
if (query.nodeType) serverQuery.nodeType = query.nodeType;
if (query.type) serverQuery.nodeType = query.type;
if (query.name) serverQuery.name = query.name;
if (query.file) serverQuery.file = query.file;
// `line` is never copied!
```

### 4. What Gets Returned

Without `line` filtering, `queryNodes({ type: 'FUNCTION', file: 'invitations.ts' })` returns ALL functions in the file. The order depends on:
- How JSASTAnalyzer traverses the AST (depth-first)
- How RFDB stores and returns nodes

For nested functions, JSASTAnalyzer's FunctionVisitor processes them in AST traversal order. When processing the handler arrow function, it:
1. Creates the outer function node
2. Calls `analyzeFunctionBody` which traverses the body
3. During body traversal, finds nested arrow function in `new Promise((resolve, reject) => ...)`
4. Creates the nested function node

So both functions exist in the graph. When queried, they may be returned in creation order or insertion order - but NOT in line-number order.

## Root Cause

**The `line` parameter to `queryNodes` is silently ignored.** This is a silent contract violation - the caller expects filtering by line, but the backend doesn't support it.

This results in:
1. Query returns ALL FUNCTION nodes in file
2. `break` takes the first one
3. First one is often NOT the target function

## Why Wrong Function is Found

In the example:
- Handler function is at line 202
- Nested Promise callback is at line 205

If nodes are returned in creation order (which is AST traversal order), the handler might come first. But if RFDB returns them in some other order (e.g., by ID hash), the nested function might come first.

The specific behavior depends on:
1. JSASTAnalyzer traversal order (depth-first, so nested callbacks are created AFTER their parent)
2. RFDB storage order
3. Query result order

But regardless of order, **relying on "first result" when `line` filtering is broken is fundamentally wrong**.

## High-Level Fix Approach

### Option A: Add `line` to NodeQuery (Preferred)

1. Extend `NodeQuery` interface to include `line` field
2. Update `RFDBServerBackend.queryNodes` to filter by line
3. Possibly add line index in RFDB for performance

Pros:
- Fixes the root cause
- Benefits other code that might want to query by line
- Clean contract

Cons:
- Requires RFDB changes
- Line-based queries might be slow without index

### Option B: Post-filter in ExpressRouteAnalyzer

1. Remove reliance on `line` in queryNodes
2. Iterate through all FUNCTION nodes in file
3. Filter manually by checking `fn.line === handlerLine`

```typescript
for await (const fn of graph.queryNodes({
  type: 'FUNCTION',
  file: module.file
})) {
  if (fn.line === handlerLine) {
    await graph.addEdge({ ... });
    break;
  }
}
```

Pros:
- Quick fix
- No RFDB changes needed

Cons:
- O(n) iteration over all functions in file
- Duplicates logic that should be in backend

### Option C: Query by Semantic ID Pattern

Since JSASTAnalyzer creates functions with semantic IDs that include position info, we could:
1. Construct expected function ID pattern
2. Use `graph.getNode(id)` directly

But this requires knowing the exact ID format, which couples ExpressRouteAnalyzer to JSASTAnalyzer's ID generation logic.

## Recommendation

**Option B (post-filter)** is the pragmatic short-term fix:
- It's simple and contained within ExpressRouteAnalyzer
- It doesn't require RFDB changes
- The O(n) cost is acceptable since we're already iterating over functions in the file

For Option A, we should create a follow-up issue to add `line` support to NodeQuery - this is a legitimate capability gap that should be addressed, but not necessarily in this bugfix.

## Secondary Issue: Column Disambiguation

Even with line filtering, there could be multiple functions on the same line:
```typescript
const handlers = [() => a, () => b];  // Two functions on line 10
```

The fix should match by BOTH line AND column. JSASTAnalyzer stores `column` on FUNCTION nodes (line 303-304 in FunctionVisitor.ts), so this data is available.

## Files to Modify

1. `packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`
   - Change queryNodes call to post-filter by line
   - Optionally also match by column for precision

2. (Future issue) `packages/core/src/storage/backends/RFDBServerBackend.ts`
   - Add `line` to NodeQuery interface
   - Implement line filtering in queryNodes
