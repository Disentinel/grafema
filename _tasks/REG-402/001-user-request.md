# User Request: REG-402 — Callback resolution for method references (this.handler)

## Problem

REG-400 handles callback resolution for named function references (`forEach(handler)`). But method references like `this.handler` passed as callbacks are NOT resolved.

```javascript
class MyClass {
  handler(x) { return x * 2; }

  process(arr) {
    arr.forEach(this.handler);        // MemberExpression, not Identifier
    arr.map(this.handler.bind(this)); // bind() wrapping
  }
}
```

## Current Architecture

**CallExpressionVisitor.extractArguments** (lines 263-489):
- MemberExpression args get `targetType='EXPRESSION'`, `expressionType='MemberExpression'`
- Stores `objectName` and `propertyName` but does NOT resolve to method node

**GraphBuilder.bufferArgumentEdges** (lines 1838-1948):
- Only handles `targetType === 'VARIABLE'` for callback resolution
- Does NOT handle EXPRESSION/MemberExpression callbacks

**Key data structures:**
- ClassVisitor creates FUNCTION nodes for class methods with `isClassMethod: true` and `className` fields
- ScopeTracker has `getEnclosingScope('CLASS')` to get current class name
- Functions collection stores class methods alongside regular functions
- Semantic IDs for class methods: `{file}->{className}->FUNCTION->{methodName}`

## Approach

The change should happen in TWO places in the analysis phase (same-file resolution):

1. **CallExpressionVisitor.extractArguments** — When we see `this.methodName` as an argument to a known HOF:
   - Use `scopeTracker.getEnclosingScope('CLASS')` to get the class name
   - Set `objectName = 'this'` (already done), `propertyName = methodName` (already done)
   - Keep as EXPRESSION type but the resolution will happen in GraphBuilder

2. **GraphBuilder.bufferArgumentEdges** — Add a new branch for `targetType === 'EXPRESSION'` with `expressionType === 'MemberExpression'`:
   - If `objectName === 'this'`: find function in `functions` collection where `isClassMethod === true`, `className` matches the class from the callId scope, and `name === propertyName`
   - Create CALLS edge for known HOFs (same whitelist check)
   - Create PASSES_ARGUMENT edge to the resolved function

For cross-file resolution of `obj.method`: this is more complex (requires type resolution via MethodCallResolver). Suggest deferring to a separate task. Focus on `this.method` which is the common pattern.

## Scope

- **In scope:** `this.method` as callback within same class, `this.method.bind(this)`
- **Out of scope:** `obj.method` (requires type inference), cross-file `this.method`

## Questions for Don

1. Is this approach correct? Should we handle this in analysis phase or enrichment?
2. For `.bind(this)`, the actual argument is a CallExpression (`this.handler.bind(this)`). Should we handle this case too or defer?
