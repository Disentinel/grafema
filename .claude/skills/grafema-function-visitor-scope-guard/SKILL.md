---
name: grafema-function-visitor-scope-guard
description: |
  Fix duplicate FUNCTION nodes in Grafema when FunctionVisitor's full-AST traversal
  and NestedFunctionHandler's function-body traversal both create nodes for the same
  arrow/function expression. Use when: (1) same arrow function appears twice in "Nodes
  in File" at the same source position, (2) PASSES_ARGUMENT and DERIVES_FROM edges
  point to what look like identical FUNCTION nodes, (3) duplicate FUNCTION nodes appear
  only for arrows/functions nested inside class methods or other functions, (4) adding
  getFunctionParent() guard fixes the issue. Root cause: FunctionVisitor has no scope
  guard, fires for ALL arrows in the AST; NestedFunctionHandler also fires for the same
  arrows with a different ID format. Solution: add getFunctionParent() early-return guard
  to the FunctionVisitor handler.
author: Claude Code
version: 1.0.0
date: 2026-02-22
---

# Grafema FunctionVisitor Scope Guard Pattern

## Problem

Duplicate FUNCTION nodes appear for arrow functions (and function expressions) that are
nested inside class methods or other function bodies. The same source position has two
separate FUNCTION nodes with different semantic IDs.

**Symptom in UI:**
```
FUNCTION anonymous[1] L155:43
FUNCTION anonymous[1] L155:43  ← duplicate
```

**Symptom in graph:**
- `CALL "this.plugins.some" --PASSES_ARGUMENT--> FUNCTION "anonymous[1]"`
- `CALL "this.plugins.some" --DERIVES_FROM--> FUNCTION "anonymous[1]"`
- These look like they point to the same node, but they are TWO separate nodes with
  different IDs that happen to have the same display name.

## Root Cause

Two traversal paths create FUNCTION nodes independently:

**Path 1: `FunctionVisitor.ArrowFunctionExpression`**
- Runs during `traverse(ast, functionVisitor.getHandlers())` in `JSASTAnalyzer.ts`
- This is a **full-AST traversal** — visits ALL arrow functions regardless of nesting
- If no `getFunctionParent()` guard is present, fires for nested arrows too
- Uses `computeSemanticIdV2` at module scope → `file->FUNCTION->name[in:ClassName]`

**Path 2: `NestedFunctionHandler.ArrowFunctionExpression`**
- Runs during `analyzeFunctionBody()` → called for each class method / function body
- Uses `computeSemanticId` (v1) with full scope path → `file->ClassName->methodName->FUNCTION->name`
- This is the CORRECT path for function-body arrows

Both paths fire for `class A { m() { arr.map(x => x) } }`. They produce different
IDs → two distinct RFDB nodes at the same source coordinates.

## Solution

Add `getFunctionParent()` guard at the **very top** of `FunctionVisitor.ArrowFunctionExpression`:

```typescript
ArrowFunctionExpression: (path: NodePath) => {
  // Skip arrow functions nested inside other functions — those are handled
  // by NestedFunctionHandler during analyzeFunctionBody traversal.
  const functionParent = path.getFunctionParent();
  if (functionParent) return;

  const node = path.node as ArrowFunctionExpression;
  // ... rest of handler unchanged
```

**Why this works:**
- `path.getFunctionParent()` returns the nearest enclosing FunctionDeclaration,
  FunctionExpression, ArrowFunctionExpression, or ClassMethod
- If non-null → arrow is nested, will be handled by NestedFunctionHandler → skip
- If null → arrow is at module level, only FunctionVisitor should handle it → continue

## Existing Pattern to Match

`JSASTAnalyzer.ts` around line 1983 already uses this pattern for FunctionExpression:

```typescript
FunctionExpression: (funcPath) => {
  const functionParent = funcPath.getFunctionParent();
  if (functionParent) return;
  // ...
```

`CallExpressionVisitor` also uses the same guard. When adding a new handler to
`FunctionVisitor`, always check if a `getFunctionParent()` guard is needed.

## Critical Babel Gotcha: ClassProperty is NOT a Function Boundary

`path.getFunctionParent()` returns `null` for arrows in **class field initializers**:

```javascript
class A {
  field = x => x;  // getFunctionParent() = null ← ClassProperty is not a function
}
```

This means the `getFunctionParent()` guard will NOT skip class field arrows.
`ClassVisitor.ClassProperty` ALSO creates FUNCTION nodes for them → separate
duplication bug tracked as **REG-562**.

**Do NOT** try to fix REG-562 with the same guard — a different fix is needed.
The regression anchor test should assert 2 FUNCTION nodes for class field arrows
to document the pre-existing behavior.

## Diagnostic Steps

When seeing duplicate FUNCTION nodes:

1. **Identify the two IDs** — Query nodes at the same position and compare their full IDs
2. **Check ID format:**
   - v2 format: `file->TYPE->name[in:parent]` → created by FunctionVisitor
   - v1 format: `file->scope->TYPE->name` → created by NestedFunctionHandler
3. **Confirm nesting** — Is the arrow inside a class method or function body?
4. **Check for guard** — Does `FunctionVisitor.ArrowFunctionExpression` have `getFunctionParent()`?
5. **Apply guard** — Add the guard at the very top of the handler

## Test Pattern

```javascript
// Test 1: Arrow inside class method → exactly 1 FUNCTION node (the bug fix)
class MyClass {
  run() {
    const result = this.items.map(x => x);
  }
}
// Assert: queryNodes({nodeType: 'FUNCTION'}).filter(isAnonymousArrow).length === 1

// Test 2: Module-level arrow → still exactly 1 FUNCTION node (smoke test)
const fn = x => x * 2;
// Assert: 1 FUNCTION node (FunctionVisitor still handles module-level correctly)

// Test 3: Class field arrow → 2 FUNCTION nodes (REG-562 regression anchor)
class A { field = x => x; }
// Assert: 2 FUNCTION nodes (pre-existing bug, NOT fixed by getFunctionParent guard)
// Comment: "REG-562: pre-existing bug — ClassVisitor.ClassProperty + FunctionVisitor"
```

## Verification

After adding the guard:
1. `pnpm build`
2. Run the ArrowFunctionArgDedup tests: `node --test test/unit/ArrowFunctionArgDedup.test.js`
3. Run full suite: all tests pass (snapshot may need update — anonymous counter values shift)

## Notes

- The snapshot update (if needed) is expected and correct: removing the duplicate changes
  the counter numbering of anonymous functions in the affected file
- `FunctionExpression` in FunctionVisitor may have the same issue — check for a guard there too
- The architectural boundary is: FunctionVisitor = module-level functions,
  NestedFunctionHandler = function-body functions. Guards enforce this boundary.
