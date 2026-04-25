# Don Melton - Analysis: REG-323 Semantic ID for HANDLED_BY

## Executive Summary

The task is to replace line/column-based handler lookup in ExpressRouteAnalyzer with semantic ID-based lookup. After thorough codebase analysis, I've identified the architectural approach and the key challenge: **computing the same anonymous function index that JSASTAnalyzer uses**.

## Current State Analysis

### ExpressRouteAnalyzer Current Implementation

Location: `/packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`

```typescript
// Lines 378-397: Current line/column lookup
if (handlerLine) {
  for await (const fn of graph.queryNodes({
    type: 'FUNCTION',
    file: module.file
  })) {
    // Проверяем точное совпадение line и column
    if (fn.line === handlerLine && fn.column === handlerColumn) {
      // ENDPOINT -> HANDLED_BY -> FUNCTION
      await graph.addEdge({
        type: 'HANDLED_BY',
        src: endpoint.id,
        dst: fn.id
      });
      edgesCreated++;
      break;
    }
  }
}
```

**Problems with current approach:**
1. O(n) iteration over all FUNCTION nodes per endpoint
2. Line/column can drift with code reformatting
3. Not aligned with semantic ID philosophy

### How JSASTAnalyzer Computes Function Semantic IDs

Key insight from FunctionVisitor (`/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`):

```typescript
// Lines 109-112: Anonymous name generation
const generateAnonymousName = (): string => {
  const index = scopeTracker.getSiblingIndex('anonymous');
  return `anonymous[${index}]`;
};

// Lines 280-288: Name determination for arrow functions
let functionName = generateAnonymousName();

// If arrow function is assigned to variable: const add = () => {}
const parent = path.parent;
if (parent.type === 'VariableDeclarator') {
  const declarator = parent as VariableDeclarator;
  if (declarator.id.type === 'Identifier') {
    functionName = declarator.id.name;
  }
}
```

**Semantic ID format:** `{file}->{scope_path}->FUNCTION->{name}`

Examples:
- Named function: `routes.js->global->FUNCTION->handleUser`
- Anonymous handler: `routes.js->global->FUNCTION->anonymous[0]`
- Nested anonymous: `routes.js->outer->FUNCTION->anonymous[0]`

### The Core Challenge: Anonymous Index Computation

The `anonymous[N]` index is computed by ScopeTracker during AST traversal:

```typescript
// ScopeTracker.ts lines 142-147
getSiblingIndex(name: string): number {
  const key = `${this.getScopePath()}:sibling:${name}`;
  const n = this.counters.get(key) || 0;
  this.counters.set(key, n + 1);
  return n;
}
```

**Critical insight:** The index is determined by traversal order within a scope. If we traverse the same AST in the same order, we get the same indices.

## Proposed Solution

### Architecture Decision: Reuse AST Traversal with ScopeTracker

**Option 1 (REJECTED): Create shared utility function**
- Would duplicate traversal logic
- Hard to guarantee same ordering as JSASTAnalyzer
- Maintenance burden when traversal order changes

**Option 2 (SELECTED): Reuse ScopeTracker pattern locally**
- ExpressRouteAnalyzer already does its own AST traversal
- Add minimal ScopeTracker-like counter during that traversal
- Compute semantic ID directly when finding handler

### Implementation Approach

1. **Track anonymous function index during traversal**
   - When visiting CallExpression for `router.METHOD()`, track scope
   - For each anonymous handler found, increment counter
   - Compute semantic ID immediately

2. **Use direct graph.getNode() lookup**
   - Replace O(n) queryNodes iteration with O(1) getNode()
   - Graph backend already has `getNode(id)` method

3. **Handle both named and anonymous handlers**
   - Named: extract from AST node.id.name
   - Anonymous: use counter with `anonymous[N]` pattern

### Code Changes Summary

**File: `/packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`**

1. Add local counter for anonymous functions per module
2. Modify handler unwrapping to track function name
3. Replace line/column lookup with semantic ID lookup

## Complexity Analysis

| Current | Proposed |
|---------|----------|
| O(n) per endpoint (queryNodes iteration) | O(1) per endpoint (getNode lookup) |
| Fragile (line/column based) | Stable (semantic ID based) |

## Risk Assessment

### Low Risk
- ExpressRouteAnalyzer already parses AST independently
- ScopeTracker pattern is well-tested
- Graph.getNode() is reliable

### Medium Risk
- Anonymous index must match exactly what JSASTAnalyzer produces
- If traversal order differs, IDs won't match

### Mitigation
- Use same visitor pattern as FunctionVisitor
- Add tests verifying semantic ID match between analyzers

## Acceptance Criteria Mapping

| Requirement | Solution |
|------------|----------|
| HANDLED_BY edge via semantic ID | Use `computeSemanticId()` + `graph.getNode()` |
| No line/column for search | Remove `fn.line === handlerLine` check |
| Works for named handlers | Extract name from AST `node.id.name` |
| Works for anonymous handlers | Counter with `anonymous[N]` pattern |

## Alternative Considered: Query by Other Attributes

Instead of computing semantic ID, we could query by `name` + `file`:

```typescript
const handler = await graph.queryNodes({
  type: 'FUNCTION',
  file: module.file,
  name: funcName  // "anonymous[0]" or "handleUser"
});
```

**Why rejected:** `queryNodes` doesn't support name filter directly, and even if it did, multiple functions can have same name in different scopes.

## Recommendation

Proceed with implementing local ScopeTracker-like counter in ExpressRouteAnalyzer. This is the cleanest solution that:

1. Maintains architectural consistency with semantic ID philosophy
2. Improves performance (O(n) -> O(1))
3. Is resilient to code formatting changes
4. Follows established patterns in FunctionVisitor

## Dependencies

- `computeSemanticId` from `/packages/core/src/core/SemanticId.ts`
- `graph.getNode()` from GraphBackend interface

## Estimated Scope

- ~50-80 lines of changes in ExpressRouteAnalyzer
- New test cases in ExpressRouteAnalyzer-HANDLED_BY.test.ts
- No changes to other modules needed
