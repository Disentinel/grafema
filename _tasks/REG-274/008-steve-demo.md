# REG-274 Demo Report: find_guards MCP Tool

**Demo by:** Steve Jobs (Product Design / Demo)
**Date:** 2026-01-26
**Status:** DOES NOT WORK (Architectural Gap Identified)

## What Was Tested

Created test file `/tmp/guards-demo/src/test-guards.js`:
```javascript
function processUser(user) {
  if (user.isAdmin) {
    if (user.active) {
      deleteAllRecords();  // This should have 2 guards
    }
  }
}
```

## Test Steps

1. **Project setup** - Created service config, ran `grafema analyze`
2. **Found CALL node** - Using `find_nodes` tool:
   - ID: `test-guards.js->processUser->if#0->if#0->CALL->deleteAllRecords#0`
   - Note: The semantic ID correctly embeds the if-nesting (`if#0->if#0`)
3. **Called find_guards** - Expected 2 guards (user.isAdmin, user.active)

## Actual Output

```
No guards found for node: test-guards.js->processUser->if#0->if#0->CALL->deleteAllRecords#0
The node is not protected by any conditional scope (if/else/switch/etc.).
```

## Root Cause Analysis

### Graph Structure Created

**Nodes present (correct):**
```
SCOPE: if:2:2:0 (conditional=true, condition="user.isAdmin")
SCOPE: if:3:4:1 (conditional=true, condition="user.active")
SCOPE: processUser:body (conditional=false)
CALL: deleteAllRecords
```

**Edges present (5 CONTAINS edges exist):**
The CONTAINS edges do NOT connect the conditional SCOPE nodes to the CALL node.

### Why find_guards Fails

The `find_guards` implementation walks up the containment tree via incoming CONTAINS edges:
```typescript
const incomingEdges = await db.getIncomingEdges(currentId, ['CONTAINS']);
```

**Expected graph structure (per test mocks):**
```
SCOPE#if (user.active) --CONTAINS--> CALL
SCOPE#if (user.isAdmin) --CONTAINS--> SCOPE#if (user.active)
```

**Actual graph structure:**
The CALL node's `parentScopeId` is set to the function body scope, NOT the innermost `if` scope.

Looking at `JSASTAnalyzer.ts`:
```typescript
// In analyzeFunctionBody():
CallExpression: (callPath: NodePath<t.CallExpression>) => {
  this.handleCallExpression(
    callPath.node,
    ...
    parentScopeId,  // This is the function body scope, not the if scope!
    ...
  );
```

The `parentScopeId` parameter is fixed when `analyzeFunctionBody` is called - it doesn't dynamically track which conditional block contains the call.

### Evidence

1. CALL semantic ID: `test-guards.js->processUser->if#0->if#0->CALL->deleteAllRecords#0`
   - The `if#0->if#0` in the ID shows the ScopeTracker correctly tracks nesting for ID generation

2. However, the CONTAINS edge uses `parentScopeId` which is `test-guards.js->processUser->SCOPE->body`

**The semantic ID generation and edge creation are disconnected.**

## UX Issues Noticed

1. **Silent failure** - The tool says "no guards found" but doesn't explain WHY
   - Should indicate if this is because: no edges exist, node not found, or node truly unguarded

2. **No diagnostic mode** - Would be helpful to show the actual containment chain
   - e.g., "CALL is contained by SCOPE:function_body (non-conditional)"

3. **Inconsistent ID schemes** - CALL uses arrow notation (`->`) while SCOPE uses hash notation (`#`)
   - Makes manual debugging harder

## Verdict

**Would I show this on stage?** NO

The feature is incomplete. The MCP tool implementation is correct, but the underlying graph structure doesn't support the use case. This is an architectural gap where:

1. Semantic IDs correctly track scope nesting (for identification)
2. CONTAINS edges do NOT follow scope nesting (they use a fixed parent)

## Recommended Fix

The `JSASTAnalyzer.analyzeFunctionBody` needs to:
1. Track the current scope dynamically (not just for ID generation)
2. Update `parentScopeId` when entering/exiting conditional blocks
3. Create CONTAINS edges from the innermost conditional SCOPE to contained nodes

This requires changes to `JSASTAnalyzer.ts`:
- Add dynamic scope tracking in `createIfStatementHandler`
- Update call expression handling to use the current conditional scope

**Estimated effort:** Medium - requires understanding and modifying the visitor pattern flow

## Test Results Summary

| Step | Expected | Actual | Pass |
|------|----------|--------|------|
| Find CALL node | Found | Found | PASS |
| Find SCOPE nodes | 3 scopes | 3 scopes | PASS |
| SCOPEs have conditions | Yes | Yes | PASS |
| CONTAINS edges exist | 5 edges | 5 edges | PASS |
| find_guards returns 2 guards | 2 guards | 0 guards | FAIL |

## Files Involved

- `/Users/vadimr/grafema-worker-3/packages/mcp/src/handlers.ts` - handleFindGuards (correct implementation)
- `/Users/vadimr/grafema-worker-3/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - analyzeFunctionBody (root cause)
- `/Users/vadimr/grafema-worker-3/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - bufferCallSiteEdges (uses parentScopeId)
