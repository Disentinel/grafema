# REG-254: Linus Torvalds - Plan Review

**Status:** CHANGES NEEDED

## TL;DR

Joel's plan is mostly sound but has **critical architectural concerns** that must be fixed before implementation:

1. **Missing graph structure case** - Handler doesn't check FUNCTION -> CONTAINS directly
2. **Incomplete call type coverage** - Only looks for 'CALL', ignores 'METHOD_CALL'
3. **Duplication of existing code** - CLI already has `findCallsInFunction()` that we should reuse
4. **No HAS_SCOPE edge traversal** - Handler assumes FUNCTION -> CONTAINS but graph uses FUNCTION -> HAS_SCOPE -> SCOPE -> CONTAINS

These aren't hacks - they're missing pieces that will cause silent failures in production.

---

## High-Level Assessment

### What's RIGHT

1. **Correctly identified this as product gap, not a bug** - Don and Joel both nailed the diagnosis. The graph HAS the data, we just don't expose it.

2. **TDD approach** - Writing tests first is correct.

3. **Type-first design** - Defining types before implementation is clean.

4. **Comprehensive test cases** - Joel listed all the important scenarios (same-file, cross-file, method calls, async).

### What's WRONG

Joel's handler implementation has architectural problems that violate the "do it right, not quick" principle:

---

## Critical Issues

### Issue 1: Graph Structure Misunderstanding

**Current handler logic (lines 274-338 in Joel's plan):**

```typescript
// Step 2: Find function's scope
const hasScopeEdges = await db.getOutgoingEdges(targetFunction.id, ['HAS_SCOPE']);

// Step 3: Collect all calls within the function
async function collectCallsFromScope(scopeId: string) {
  const containsEdges = await db.getOutgoingEdges(scopeId, ['CONTAINS']);
  // ...
}

// Start from function's direct scope(s)
for (const edge of hasScopeEdges) {
  await collectCallsFromScope(edge.dst);
}

// Also check CONTAINS edges directly from function (alternative structure)
const directContains = await db.getOutgoingEdges(targetFunction.id, ['CONTAINS']);
for (const edge of directContains) {
  const childNode = await db.getNode(edge.dst);
  if (childNode?.type === 'SCOPE') {
    await collectCallsFromScope(childNode.id);
  }
}
```

**Problem:** The "alternative structure" check at lines 332-338 is WRONG.

**Actual graph structure (from GraphBuilder.ts:343-359):**

```
FUNCTION -> HAS_SCOPE -> SCOPE (function_body)
SCOPE -> CONTAINS -> SCOPE (nested blocks)
SCOPE -> CONTAINS -> CALL (call sites)
```

FUNCTION nodes do NOT have CONTAINS edges. Only SCOPE nodes have CONTAINS edges.

The "alternative structure" code is checking for a pattern that NEVER EXISTS in the graph.

**Fix Required:**

Remove lines 332-338 from Joel's plan. The graph structure is consistent - there's only ONE way:

```
FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL
```

---

### Issue 2: Missing METHOD_CALL Node Type

**Current handler (line 290):**

```typescript
if (childNode.type === 'CALL') {
  // ... collect call info
}
```

**Problem:** This IGNORES METHOD_CALL nodes.

From the user's original example:
```javascript
async function fetchInvitations() {
  const response = await authFetch('/api/invitations')
  return await response.json()  // <-- This is a METHOD_CALL, not CALL
}
```

The handler will miss `response.json()` completely.

**Evidence from GraphBuilder.ts:**

- Line 490-508: buffers CALL nodes (function calls)
- Line 511+: buffers METHOD_CALL nodes (method calls)

Both are created separately and stored with different node types.

**Fix Required:**

Change line 290 to:

```typescript
if (childNode.type === 'CALL' || childNode.type === 'METHOD_CALL') {
```

And update the type detection logic:

```typescript
calls.push({
  id: childNode.id,
  name: childNode.name,
  type: childNode.type === 'METHOD_CALL' ? 'METHOD_CALL' : 'CALL',
  object: childNode.object as string | undefined,
  // ...
});
```

---

### Issue 3: Code Duplication

**What Joel wrote (lines 280-324):**

```typescript
async function collectCallsFromScope(scopeId: string) {
  if (visitedScopes.has(scopeId)) return;
  visitedScopes.add(scopeId);

  const containsEdges = await db.getOutgoingEdges(scopeId, ['CONTAINS']);

  for (const edge of containsEdges) {
    const childNode = await db.getNode(edge.dst);
    if (!childNode) continue;

    if (childNode.type === 'CALL') {
      // ... collect call
    }

    if (childNode.type === 'SCOPE') {
      await collectCallsFromScope(childNode.id);
    }
  }
}
```

**What ALREADY EXISTS in packages/cli/src/commands/query.ts (lines 565-613):**

```typescript
async function findCallsInFunction(
  backend: RFDBServerBackend,
  nodeId: string,
  maxDepth: number = 10
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    try {
      const edges = await backend.getOutgoingEdges(id, ['CONTAINS']);

      for (const edge of edges) {
        const child = await backend.getNode(edge.dst);
        if (!child) continue;

        if (child.type === 'CALL') {  // <-- BUG: also misses METHOD_CALL!
          calls.push({ /* ... */ });
        }

        // Continue searching in children (but not into nested functions)
        if (child.type !== 'FUNCTION' && child.type !== 'CLASS') {
          queue.push({ id: child.id, depth: depth + 1 });
        }
      }
    } catch (error) {
      // ...
    }
  }

  return calls;
}
```

**Problem:** We're writing the SAME algorithm twice. And BOTH have the same bug (missing METHOD_CALL).

This violates DRY principle and creates maintenance burden - if we fix a bug in one place, we have to remember to fix it in the other.

**CRITICAL:** The CLI code ALSO has the METHOD_CALL bug. This is a systemic issue, not just Joel's oversight.

**Decision Required:**

Should we:
1. **Extract shared logic** into a common package (e.g., `@grafema/graph-queries`)
2. **Accept duplication** for now (MCP and CLI are separate tools with different interfaces)
3. **Wait until we have 3 instances** of the same pattern (rule of three)

I lean toward **Option 2** for now - MCP and CLI serve different purposes and their coupling might be harmful. But we should document this as known duplication and create a Linear issue for "Extract common graph traversal utilities" tagged v0.3 (refactoring milestone).

---

### Issue 4: Missing HAS_SCOPE in findContainingFunction Logic

**Joel's code (lines 356-370):**

```typescript
const containsEdges = await db.getIncomingEdges(currentId, ['CONTAINS', 'HAS_SCOPE']);
```

**This is CORRECT** - but it's inconsistent with the forward traversal logic.

In the forward direction (finding calls FROM a function), Joel only follows CONTAINS.
In the backward direction (finding function that CONTAINS a call), Joel follows CONTAINS + HAS_SCOPE.

**Why is this correct?**

Because the graph structure is:
```
CALL <- CONTAINS <- SCOPE <- HAS_SCOPE <- FUNCTION
```

To walk UP from CALL to FUNCTION, you need BOTH edge types.

To walk DOWN from FUNCTION to CALL, you need:
1. HAS_SCOPE (FUNCTION -> SCOPE)
2. CONTAINS (SCOPE -> CALL or SCOPE -> nested SCOPE -> CALL)

Joel's forward logic DOES follow HAS_SCOPE at line 327 (`for (const edge of hasScopeEdges)`), so this is actually fine.

But the comment at line 332 "alternative structure" suggests Joel isn't confident about the graph structure - and that uncertainty led to defensive code that checks for non-existent patterns.

**Fix Required:**

Add a comment explaining WHY we need both edge types:

```typescript
// Graph structure:
//   FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL
//   SCOPE -[CONTAINS]-> SCOPE (nested blocks)
//
// Forward traversal: HAS_SCOPE (once), then CONTAINS (recursive)
// Backward traversal: CONTAINS* (multiple hops), then HAS_SCOPE (once)
```

This documents the architecture for future developers.

---

## Tests Review

Joel's test cases (Phase 1) look good, but are INCOMPLETE.

**Missing test cases:**

1. **Arrow functions** - do they create HAS_SCOPE edges?
2. **Class methods** - different structure than standalone functions?
3. **Nested function definitions** - `function outer() { function inner() {} inner(); }`
4. **Generator functions** - `function* gen() { yield foo(); }`
5. **Immediately Invoked Function Expressions** - `(function() { bar(); })()`

Without these tests, we're guessing whether the handler works for all function types.

**Recommendation:**

Add these test cases to Phase 1. If any fail, we'll discover architectural assumptions that don't hold.

---

## Missing from Joel's Plan

### 1. What About Transitive Calls?

**User requirement (from 001-user-request.md line 32):**

> - [ ] Transitive calls available (A calls B calls C)

**Joel's plan:** DOES NOT address this.

The `get_function_details` tool returns direct calls only. If A calls B calls C, you get:
- `get_function_details('A')` → shows B
- `get_function_details('B')` → shows C

But user wants "transitive calls" - presumably one query that returns BOTH B and C when querying A.

**Question for User:**

Should `get_function_details` have a `transitive: boolean` parameter?

```typescript
{
  name: "fetchInvitations",
  transitive: true  // Follow call chain recursively
}

// Returns:
{
  calls: [
    { name: "authFetch", depth: 1 },
    { name: "fetch", depth: 2 },  // authFetch calls fetch
    { name: "response.json", depth: 1 }
  ]
}
```

Or should this be a SEPARATE tool (`get_call_chain`)?

**Decision Required Before Implementation.**

If we punt on transitive calls for V1, we need to update acceptance criteria in Linear and create a follow-up issue.

---

### 2. Performance Implications

**Joel's handler does:**

1. Query all nodes with type='FUNCTION', filter by name
2. For each scope, recursively traverse CONTAINS edges
3. For each call, query CALLS edges
4. For each target, fetch node details

**For a large function with 100 calls, this is:**
- 1 node query (find function)
- 1 edge query (HAS_SCOPE)
- ~10-20 edge queries (recursive CONTAINS traversal)
- 100 edge queries (CALLS for each call)
- 100 node queries (get target details)

**Total: ~220 database operations.**

Is this acceptable? Probably yes for MCP (interactive use), but we should add a comment about performance characteristics.

**Recommendation:**

Add to handler documentation:

```typescript
/**
 * Performance: O(C) where C = number of calls in function
 * For functions with 100+ calls, expect ~220 DB operations.
 * This is acceptable for MCP interactive use but may need
 * optimization if used in bulk queries.
 */
```

---

## Verdict

**CHANGES NEEDED** before implementation.

### Required Changes

1. **Remove "alternative structure" code** (lines 332-338) - this pattern doesn't exist
2. **Add METHOD_CALL support** - change `if (childNode.type === 'CALL')` to include METHOD_CALL
3. **Fix the SAME bug in CLI** - `packages/cli/src/commands/query.ts:590` also misses METHOD_CALL
4. **Document known duplication** - create Linear issue for future deduplication (v0.3)
5. **Add missing test cases** - arrow functions, class methods, nested functions, generators, IIFE
6. **Add architecture comment** - explain graph structure (HAS_SCOPE + CONTAINS)
7. **Clarify transitive calls requirement** - separate tool or parameter? Update acceptance criteria

### Decision Points for User

1. **Transitive calls:**
   - Option A: Add `transitive: boolean` parameter to `get_function_details`
   - Option B: Create separate `get_call_chain` tool
   - Option C: Punt to v0.2, update acceptance criteria

2. **Code duplication:**
   - Accept for now, create Linear issue for v0.3?
   - Or extract shared utilities immediately?

---

## Alignment with Vision

Does this align with "AI should query the graph, not read code"?

**YES.** This is exactly the right kind of feature.

The graph HAS the information. We're making it accessible via a clean query interface. AI agents can now answer "what does this function do?" without reading source code.

This is NOT a hack. This is NOT a workaround. This is proper product development.

**BUT** - we can't ship it with silent failures (missing METHOD_CALL nodes) or wrong assumptions (alternative structure that doesn't exist).

Do it right. Fix the issues above. Then ship.

---

## Next Steps

1. Joel revises plan based on feedback
2. Don reviews revised plan
3. If approved by Don → back to Linus for final approval
4. Then proceed to Kent (tests) + Rob (implementation)

---

**Linus Torvalds**
*High-Level Reviewer, REG-254*
