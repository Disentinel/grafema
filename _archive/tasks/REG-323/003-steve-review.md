# Steve Jobs Review: REG-323 Semantic ID for HANDLED_BY

**Status: REJECT**

## Vision Alignment Check

The goal of moving from line/column to semantic ID is absolutely correct. This aligns with Grafema's core thesis: stable, meaningful identifiers that survive code reformatting. **However, the proposed implementation has fundamental flaws.**

## Critical Problems

### Problem 1: Duplicating ScopeTracker Logic is DRY Violation

The plan proposes:
> "Add minimal ScopeTracker-like counter during that traversal"

This is **architectural cancer**. We already have a well-tested `ScopeTracker` class that manages:
- Scope stack (`enterScope`, `exitScope`)
- Sibling indices for anonymous functions (`getSiblingIndex`)
- Counter management for various node types

**Why this matters:** If we duplicate this logic in ExpressRouteAnalyzer, we now have TWO places computing `anonymous[N]` indices. When the algorithm changes (and it will), we'll have divergent implementations.

The plan acknowledges this risk:
> "Medium Risk: Anonymous index must match exactly what JSASTAnalyzer produces"

But the proposed mitigation is weak:
> "Add tests verifying semantic ID match between analyzers"

Tests don't solve architectural debt. They just detect when we've broken something.

### Problem 2: Traversal Order Synchronization is Fragile

JSASTAnalyzer's anonymous function indexing depends on AST traversal order. The index `anonymous[0]` vs `anonymous[1]` is determined by which function is visited first during Babel traverse.

ExpressRouteAnalyzer does its own AST traversal with completely different visitor structure:
```typescript
// ExpressRouteAnalyzer - flat traversal
traverse(ast, {
  VariableDeclarator: (path) => { ... },
  CallExpression: (path) => { ... }
});
```

vs JSASTAnalyzer which uses nested visitors with recursive `analyzeFunctionBody` callbacks that affect traversal order.

**Critical question the plan doesn't answer:** How do we guarantee ExpressRouteAnalyzer visits anonymous functions in the **exact same order** as JSASTAnalyzer?

### Problem 3: The Plan Ignores an Obvious Simpler Solution

The current architecture already has the answer:

1. **JSASTAnalyzer runs FIRST** (priority 80)
2. **ExpressRouteAnalyzer runs SECOND** (priority 75)
3. JSASTAnalyzer already creates FUNCTION nodes with semantic IDs
4. FUNCTION nodes have `line`, `column`, `name`, and `file` attributes

**The simple solution:**
```typescript
// Instead of computing semantic ID ourselves, query by file + name
// where name is what we extract from the handler AST
const handlerNode = await graph.getNode(computeSemanticId(...));
```

BUT wait - the plan says this is rejected because:
> "queryNodes doesn't support name filter directly"

This is wrong. Looking at `packages/types/src/plugins.ts`:
```typescript
export interface NodeFilter {
  type?: NodeType;
  name?: string;    // <-- SUPPORTED
  file?: string;    // <-- SUPPORTED
  [key: string]: unknown;
}
```

And the current code already uses it for middleware:
```typescript
// Line 428-432 in ExpressRouteAnalyzer.ts
for await (const fn of graph.queryNodes({
  type: 'FUNCTION',
  file: module.file,
  name: middleware.name  // <-- Already using name!
}))
```

**The plan didn't properly analyze the current code.**

### Problem 4: Scope Path is the Real Challenge

For semantic ID computation, we need the **scope path**, not just the anonymous index. Consider:

```javascript
// File: routes.js
router.get('/a', () => {});         // global->FUNCTION->anonymous[0]
router.get('/b', outer(() => {}));  // What's the scope path here?

function wrapper() {
  router.get('/c', () => {});       // wrapper->FUNCTION->anonymous[0]
}
```

The handler at `/b` is **not** at global scope - it's inside a call expression. But ExpressRouteAnalyzer doesn't track scope transitions when unwrapping.

The plan doesn't address this at all.

## Architectural Recommendation

**Step back and reconsider the approach:**

1. **Option A (Preferred): Enhance JSASTAnalyzer to emit handler metadata**

   JSASTAnalyzer already visits every function. It already has perfect scope tracking. Instead of duplicating this in ExpressRouteAnalyzer, have JSASTAnalyzer detect Express handler patterns and store metadata on the FUNCTION node.

   Then ExpressRouteAnalyzer just looks up by that metadata.

2. **Option B: Store function ID in AST node during JSASTAnalyzer pass**

   Since both analyzers parse the same AST, we could have JSASTAnalyzer annotate AST nodes with their semantic IDs. Then ExpressRouteAnalyzer reads this annotation.

   BUT this is hacky and creates coupling.

3. **Option C: Accept line/column with caveats**

   Line/column works. It's pragmatic. The "code reformatting" concern is theoretical - in practice, code analysis happens on committed code.

   Document the limitation and move on.

## Verdict

**REJECT** this plan. The proposed solution:
1. Violates DRY by duplicating ScopeTracker logic
2. Creates fragile coupling to traversal order
3. Doesn't address scope path computation for nested contexts
4. Ignores simpler alternatives that leverage existing infrastructure

## What I Want to See

Before approving, I need:

1. **Analysis of Option A** - Can JSASTAnalyzer detect Express handlers? What's the cost?
2. **Proof that traversal order will match** - Not tests, but architectural reasoning
3. **Handling of nested scopes** - What happens when handler is inside another function?

Don't bring me code. Bring me architectural clarity.

---

*"Real artists ship, but they don't ship garbage."*
