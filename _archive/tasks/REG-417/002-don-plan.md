# Don Melton — Plan for REG-417

## Analysis

REG-401 (now merged) added parameter invocation detection for user-defined HOFs.
The `paramNameToIndex` map in `analyzeFunctionBody` (JSASTAnalyzer.ts:3709-3721)
only handles:
- Simple `Identifier` params: `function(fn) { fn(); }`
- Default params with identifier left: `function(fn = default) { fn(); }`

**Missing:**
- ObjectPattern: `function({ fn }) { fn(); }`
- ArrayPattern: `function([fn]) { fn(); }`
- AssignmentPattern with pattern left: `function({ fn } = {}) { fn(); }`
- RestElement: `function(...fns) { fns[0](); }`

Also, the detection side (JSASTAnalyzer.ts:4368) only matches `Identifier` callees.
Rest params with array access (`fns[0]()`) have a `MemberExpression` callee.

## Plan

### Part 1: Extend `paramNameToIndex` for destructured params

In JSASTAnalyzer.ts ~3711-3720, add cases:

1. `t.isObjectPattern(param)` / `t.isArrayPattern(param)` → use `extractNamesFromPattern`
   to get all binding names, add each to `paramNameToIndex` with index `i`
2. `t.isAssignmentPattern(param)` where `param.left` is ObjectPattern/ArrayPattern →
   same treatment via `extractNamesFromPattern(param.left)`
3. `t.isRestElement(param)` → add `param.argument.name` to paramNameToIndex with a
   special flag indicating it's a rest param (for MemberExpression detection)

### Part 2: Extend detection for MemberExpression callee (rest param array access)

In JSASTAnalyzer.ts ~4368, add MemberExpression detection:

```
if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
  // Check if object is a rest param name
  const restParamIndex = restParamNames.get(callee.object.name);
  if (restParamIndex !== undefined) {
    invokedParamIndexes.add(restParamIndex);
  }
}
```

### Files to modify

1. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — extend paramNameToIndex + detection
2. `test/unit/CallbackFunctionReference.test.js` — add test cases

### Complexity

- O(1) per param for adding to map (extractNamesFromPattern is O(k) where k = nested depth)
- No new iteration passes — extends existing forward registration
- Reuses existing `extractNamesFromPattern` utility

### Scope: Mini-MLA (Don → Rob → Steve → Вадим)
