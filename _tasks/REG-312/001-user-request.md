# REG-312: Track member expression updates (obj.prop++, arr[i]++)

## Task
Analyze and plan REG-312: Track member expression updates (obj.prop++, arr[i]++).

## Context
REG-288 just landed - it tracks simple identifier updates (i++, --count) with UPDATE_EXPRESSION nodes. Now we need to extend this to member expressions.

## Current Code
Read `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - specifically the `collectUpdateExpression` method which currently skips member expressions:

```typescript
if (updateNode.argument.type !== 'Identifier') {
  return;  // Skip member expressions
}
```

## Cases to Handle
1. `obj.prop++` - static property access
2. `arr[i]++` - computed property (array index)
3. `this.counter++` - this reference
4. `obj.nested.prop++` - chained access

## Questions to Answer
1. What should the UPDATE_EXPRESSION node contain for member expressions?
2. What should MODIFIES edge point to? The object? The property?
3. How to handle computed properties like `arr[i]`?
4. Should we track the base object differently from the property?

## Output
Write plan to `_tasks/REG-312/002-don-plan.md` with:
- Analysis of member expression semantics
- Proposed node/edge structure
- Alignment with existing patterns (ObjectMutation, PropertyAccess)
- Any architectural concerns
