# Don Melton Plan: REG-298 -- AST: Track await in loops

## 1. Analysis Summary

### Current Architecture

**Loop handling (REG-267/280/282/284):**
- `JSASTAnalyzer.createLoopScopeHandler()` creates LOOP nodes during AST walk for all loop types (for, for-in, for-of, while, do-while)
- Each LOOP node has: `id`, `loopType`, `file`, `line`, `parentScopeId`
- `GraphBuilder.bufferLoopEdges()` creates: `CONTAINS` (parent -> LOOP), `HAS_BODY` (LOOP -> body SCOPE), `ITERATES_OVER` (LOOP -> collection)
- Loop body is a SCOPE node with `parentScopeId` pointing to the LOOP node's ID
- `controlFlowState` tracks `loopCount` (increment only, no depth tracking)

**Await tracking (REG-311):**
- `isAwaited` flag is set on CALL nodes during the AST walk: `parent?.isAwaitExpression() ?? false`
- `isInsideTry` flag uses O(1) depth counter: `controlFlowState.tryBlockDepth`
- Both flags are stored as metadata on CALL nodes in the graph
- Used by `RejectionPropagationEnricher` to propagate rejection types through call chains

**ISSUE nodes:**
- `NodeFactory.createIssue(category, severity, message, plugin, file, line, column, options)` creates `issue:*` nodes
- Deterministic IDs based on hash of (plugin, file, line, column, message)
- Connected to affected code via `AFFECTS` edges
- Categories: security, performance, style, smell

**Validation plugins (existing patterns):**
- `EvalBanValidator`: queries `CALL` nodes by name, reports violations
- `ShadowingDetector`: queries `VARIABLE`, `CONSTANT`, `IMPORT` nodes, cross-references
- `SQLInjectionValidator`: queries `CALL` nodes, traces data flow
- All extend `Plugin`, phase `VALIDATION`, return `createSuccessResult()`

### Key Insight: Two Possible Approaches

**Approach A -- Forward Registration (Recommended):**
Add `isInsideLoop: boolean` metadata to CALL nodes during the AST walk, analogous to `isInsideTry`. This uses the existing `controlFlowState` pattern with a depth counter. Detection becomes a simple query: find CALL nodes where `isAwaited=true AND isInsideLoop=true`.

**Approach B -- Graph Query (Backward Scanning):**
A validation plugin traverses LOOP nodes, follows HAS_BODY to body SCOPE, then CONTAINS edges to find CALL nodes with `isAwaited=true`. This is O(L) where L = number of LOOP nodes, not O(N) over all nodes.

**Decision: Hybrid approach -- Approach A for marking + Approach B for ISSUE creation.**

Approach A (forward registration during AST walk) is the Grafema way. It marks data during the walk at zero additional cost. Approach B would work but requires graph traversal. The key architectural principle is "Forward registration > backward pattern scanning."

However, we still need a validation plugin to CREATE the ISSUE nodes, because ISSUE creation requires the graph to be built (needs node IDs for AFFECTS edges). The validator's job is trivial: query CALL nodes where `isAwaited=true AND isInsideLoop=true` and create ISSUE nodes.

## 2. Design

### Phase 1: Forward Registration (Analysis Phase)

**File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**

Add `loopDepth` counter to `controlFlowState` (same pattern as `tryBlockDepth`):

```typescript
const controlFlowState = {
  // ... existing fields ...
  tryBlockDepth: 0,
  loopDepth: 0   // NEW: REG-298
};
```

In `createLoopScopeHandler()`, increment/decrement `loopDepth`:
```typescript
enter: (path) => {
  if (controlFlowState) {
    controlFlowState.loopCount++;
    controlFlowState.loopDepth++;  // NEW: REG-298
  }
  // ... existing code ...
},
exit: () => {
  if (controlFlowState) {
    controlFlowState.loopDepth--;  // NEW: REG-298
  }
  // ... existing code ...
}
```

In the `CallExpression` handler (line ~4342), after `isAwaited` and `isInsideTry`:
```typescript
const isInsideLoop = controlFlowState.loopDepth > 0;  // NEW: REG-298
```

Pass `isInsideLoop` to `handleCallExpression()` and store on CALL node when `isAwaited && isInsideLoop`.

**File: `packages/core/src/plugins/analysis/ast/types.ts`**

Add to `CallSiteInfo` and `MethodCallInfo`:
```typescript
/** REG-298: true if awaited call is inside a loop body */
isInsideLoop?: boolean;
```

### Phase 2: Validation Plugin (ISSUE creation)

**New file: `packages/core/src/plugins/validation/AwaitInLoopValidator.ts`**

Uses `context.reportIssue()` API (established pattern from `SQLInjectionValidator`):

```typescript
for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
  if (node.isAwaited && node.isInsideLoop) {
    await context.reportIssue({
      category: 'performance',
      severity: 'warning',
      message: `Sequential await in loop — consider Promise.all() for parallel execution`,
      file: node.file,
      line: node.line,
      column: node.column || 0,
      targetNodeId: node.id,  // Creates AFFECTS edge automatically
      context: {
        callName: node.name,
        suggestion: 'Promise.all'
      }
    });
  }
}
```

The `reportIssue` API (Orchestrator.ts:997-1017) handles:
1. Creating `issue:performance` ISSUE node via `NodeFactory.createIssue()`
2. Adding node to graph
3. Creating `AFFECTS` edge from ISSUE to the target CALL node

**Complexity:** O(C) where C = number of CALL nodes. NOT O(N) over all nodes.

### Phase 3: ISSUE Node Structure

```
ISSUE node:
  type: "issue:performance"
  category: "performance"
  severity: "warning" (not "error" -- sequential await is sometimes intentional)
  message: "Sequential await in loop at {file}:{line} -- consider Promise.all() for parallel execution"
  plugin: "AwaitInLoopValidator"
  context: {
    callName: "fetch",     // name of the awaited function
    loopType: "for-of",    // type of containing loop (requires storing on CALL or looking up)
    suggestion: "Promise.all"
  }

AFFECTS edge: ISSUE -> CALL (the awaited call)
```

### Phase 4: Graph Queryability

After implementation, an AI agent can query:

```
# Find all sequential awaits in loops
query: nodes where type="issue:performance" AND plugin="AwaitInLoopValidator"

# Find affected calls
query: edges where type="AFFECTS" AND src IN (above issues)

# Or directly via CALL metadata:
query: nodes where type="CALL" AND isAwaited=true AND isInsideLoop=true
```

This fulfills Grafema's vision: "AI should query the graph, not read code."

## 3. Files to Change

| File | Change | Scope |
|------|--------|-------|
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Add `loopDepth` to controlFlowState, increment/decrement in loop handler, pass `isInsideLoop` to CALL node creation | ~15 lines changed |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add `isInsideLoop?: boolean` to `CallSiteInfo` and `MethodCallInfo` | 4 lines added |
| `packages/core/src/plugins/validation/AwaitInLoopValidator.ts` | **NEW** -- Validation plugin using `reportIssue` API to flag awaited calls in loops | ~60 lines |
| `test/unit/plugins/analysis/ast/await-in-loop.test.ts` | **NEW** -- Tests for `isInsideLoop` metadata on CALL nodes | ~200 lines |
| `test/unit/plugins/validation/await-in-loop-validator.test.ts` | **NEW** -- Tests for ISSUE node creation | ~100 lines |

## 4. Edge Cases

| Case | Expected Behavior | Rationale |
|------|-------------------|-----------|
| `for await (const x of stream) { await process(x) }` | Flag `await process(x)`, NOT the for-await-of itself | for-await-of is inherently sequential (async iterators). The inner await IS the issue |
| Nested loops: `for { for { await f() } }` | Flag once (the innermost await). `isInsideLoop=true` regardless of nesting depth | Depth counter handles this naturally |
| Conditional await: `for { if (cond) { await f() } }` | Flag it. Still sequential | Conditional doesn't make it parallel |
| await in callback inside loop: `for { arr.map(async x => await f()) }` | Do NOT flag. The callback creates a new function scope | `loopDepth` resets at function boundary (new controlFlowState per function) |
| `while (await condition())` | Flag the condition call. It's awaited in a loop | `isAwaited` is set by parent check, loop handler increments depth before condition is processed |
| Already parallel: `await Promise.all(items.map(async i => ...))` | Do NOT flag. The await is on Promise.all, not inside a loop | Promise.all call is not inside a loop body |
| `for { const p = fetch(); } await Promise.all(...)` | Do NOT flag. fetch() is not awaited inside the loop | `isAwaited=false` for the fetch call |
| `for-await-of` loop itself (no inner await) | Do NOT flag. The loop construct is correct | Only inner awaited calls are flagged |

### Critical edge case: `loopDepth` reset at function boundaries

The `controlFlowState` is created per-function in `JSASTAnalyzer`. When processing a nested function (callback, arrow function), a NEW `controlFlowState` is created with `loopDepth: 0`. This means:

```javascript
for (const item of items) {
  // loopDepth = 1
  items.map(async (x) => {
    // NEW controlFlowState, loopDepth = 0
    await fetch(x);  // isInsideLoop = false -- CORRECT!
  });
}
```

This is the RIGHT behavior. The existing architecture handles this naturally because `controlFlowState` is scoped to the function being analyzed.

## 5. Complexity Analysis

**Analysis phase (forward registration):**
- `loopDepth++/--` in loop handler: O(1) per loop, already visited
- `isInsideLoop` check in CallExpression handler: O(1) per call, already visited
- **Net additional cost: ZERO** -- we're piggybacking on existing AST walk

**Validation phase (ISSUE creation):**
- Iterates CALL nodes: O(C) where C = total CALL nodes
- For each call with `isAwaited && isInsideLoop`: O(1) to create ISSUE node
- **This is the same complexity as existing validators** (EvalBanValidator, etc.)

**NOT O(N) over all nodes.** We only iterate CALL nodes, a subset.

## 6. Prior Art

ESLint's [`no-await-in-loop`](https://eslint.org/docs/latest/rules/no-await-in-loop) rule:
- Detects the same pattern
- Reports as error (we use warning -- more appropriate since sequential await is sometimes intentional)
- No configuration options
- Recommends `Promise.all` pattern
- Acknowledges valid use cases (dependent iterations, retry logic, rate limiting)

OXC implements the [same rule](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-await-in-loop).

**Our approach differs from ESLint's in a key way:** ESLint reports and forgets. Grafema creates queryable graph structures (ISSUE nodes with AFFECTS edges + metadata on CALL nodes). An agent can query the graph to find all sequential awaits, understand their context, and make intelligent decisions about which ones to refactor.

## 7. Implementation Order

1. **Tests first** (Kent Beck): Write tests for `isInsideLoop` metadata on CALL nodes
2. **Types** (Rob Pike): Add `isInsideLoop` to `CallSiteInfo` and `MethodCallInfo`
3. **Forward registration** (Rob Pike): Add `loopDepth` counter, pass `isInsideLoop` to CALL nodes
4. **Build & verify** metadata tests pass
5. **Validator tests** (Kent Beck): Write tests for ISSUE node creation
6. **Validator** (Rob Pike): Create `AwaitInLoopValidator`
7. **Build & verify** all tests pass

## 8. What This Does NOT Include

- **Auto-fix / refactoring suggestions** -- out of scope for AST tracking
- **Detecting already-parallel patterns** (Promise.all, Promise.allSettled) -- separate feature, would need pattern recognition
- **Severity configuration** -- fixed at "warning" for now
- **Suppression via comments** -- could reuse grafema-ignore pattern (REG-332) if needed later
- **Cross-function analysis** -- if an awaited call is in a function called from a loop, we don't flag it. That would require call graph analysis (enrichment phase feature)
