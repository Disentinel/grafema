# Vadim Review: REG-323 Semantic ID for HANDLED_BY

**Decision: REJECT**

---

## Executive Summary

Plan has a fundamental architectural flaw: it proposes to **duplicate** semantic ID computation logic instead of **reusing** existing nodes. This violates DRY and creates fragile coupling between ExpressRouteAnalyzer and JSASTAnalyzer internal implementation details.

---

## Critical Issues

### 1. Why compute what already exists?

Don's plan says:
> "ExpressRouteAnalyzer already parses AST independently"

This is the problem, not the solution.

JSASTAnalyzer **already created** FUNCTION nodes with correct semantic IDs. Why should ExpressRouteAnalyzer:
1. Parse AST again
2. Track anonymous function counters again
3. Compute semantic ID again

When it can simply **use the nodes that already exist**?

### 2. Anonymous Counter Duplication is Fragile

The plan proposes:
```typescript
// Add local counter for anonymous functions per module
```

This counter MUST match exactly what `ScopeTracker.getSiblingIndex('anonymous')` produces in FunctionVisitor. If:
- FunctionVisitor changes traversal order
- New AST node types are handled
- Counter reset behavior changes

...ExpressRouteAnalyzer will silently produce wrong IDs. No test will catch this.

**Root Cause:** We're duplicating state instead of sharing it.

### 3. The Real Question

Current code (lines 378-397):
```typescript
for await (const fn of graph.queryNodes({
  type: 'FUNCTION',
  file: module.file
})) {
  if (fn.line === handlerLine && fn.column === handlerColumn) {
    // Found!
  }
}
```

Problems:
1. O(n) iteration
2. Line/column can drift

Don's solution replaces line/column with semantic ID computation. But the **core assumption** is wrong: we don't need to COMPUTE the ID, we need to FIND the node.

---

## Alternative Approach: Use What We Have

### Option A: Direct node reference during AST traversal

ExpressRouteAnalyzer already traverses AST and finds handler nodes:
```typescript
let actualHandler = mainHandler as Node;
while (actualHandler.type === 'CallExpression') { ... }
```

At this point, `actualHandler` is the exact AST node for the handler function.

**Key insight:** We can get the node's `start` position (byte offset in file). This is:
- Unique per function
- Stable (doesn't change with formatting)
- Available without computing semantic ID

We could:
1. During JSASTAnalyzer: store `start` offset in FUNCTION node metadata
2. During ExpressRouteAnalyzer: query by `file + start`

This is O(1) if we have an index, and doesn't duplicate semantic ID logic.

### Option B: Run ExpressRouteAnalyzer DURING JSASTAnalyzer

If ExpressRouteAnalyzer needs the same AST context as JSASTAnalyzer, maybe it shouldn't be a separate plugin. Express route detection could be a **visitor** within JSASTAnalyzer that has access to:
- ScopeTracker
- Already-created FUNCTION nodes with their IDs

This eliminates:
- Duplicate AST parsing
- Duplicate scope tracking
- Duplicate semantic ID computation

### Option C: Store handler reference in http:route node

When creating `http:route`, we have handler's line/column. Instead of looking up later:
1. Store `handlerStart` (byte offset) in http:route node
2. Store `start` in FUNCTION nodes
3. Create HANDLED_BY edge in a separate enrichment pass that joins on `start`

This is clean separation: analysis creates nodes with positional data, enrichment creates cross-references.

---

## Why Plan Fails Vision Check

Project vision: "AI should query the graph, not read code"

If we compute semantic IDs in multiple places:
- Code understanding is scattered
- Same logic exists in multiple forms
- Changes in one place don't propagate

The graph should be the **single source of truth**, including for ID computation. If ExpressRouteAnalyzer needs a function's ID, it should **ask the graph**, not compute it independently.

---

## Specific Plan Weaknesses

| Plan Statement | Problem |
|---------------|---------|
| "Add local counter for anonymous functions" | Duplicates ScopeTracker state |
| "Compute semantic ID directly when finding handler" | Should use existing node's ID |
| "Use same visitor pattern as FunctionVisitor" | Coupling to internal implementation |
| "~50-80 lines of changes" | Underestimate if we need full scope tracking |

---

## Recommendation

**Do not proceed with current plan.**

Before implementation, answer these questions:

1. **Can we store byte offset (`start`) in FUNCTION nodes and query by that?**
   - If yes: simple index lookup, no semantic ID duplication

2. **Should ExpressRouteAnalyzer be a visitor inside JSASTAnalyzer instead of separate plugin?**
   - If yes: access to ScopeTracker and already-created nodes

3. **Can we defer HANDLED_BY creation to enrichment phase?**
   - If yes: clean separation, enricher can use any lookup strategy

Only after answering these should we design the implementation.

---

## For Don's Review

Please analyze:

1. Is `ast.start` (byte offset) reliable for function identity?
2. Can `graph.getNode()` be called with a query other than semantic ID?
3. What's the cost of making ExpressRouteAnalyzer a visitor vs separate plugin?

The goal: **one place** computes semantic IDs (JSASTAnalyzer). Everyone else uses existing nodes.

---

**Status: REJECT - Needs architectural redesign**

*Vadim Reshetnikov*
*2025-02-05*
