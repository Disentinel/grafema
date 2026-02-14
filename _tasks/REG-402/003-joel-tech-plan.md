# Joel's Tech Plan: REG-402 — Callback Resolution for Method References

## Summary

Extend callback resolution (REG-400) to handle `this.method` passed as callbacks to HOFs. Four files to modify.

## Changes

### 1. `packages/core/src/plugins/analysis/ast/types.ts` — Add missing fields to CallArgumentInfo

Add `objectName?` and `propertyName?` to the `CallArgumentInfo` interface. Currently only the internal `ArgumentInfo` in CallExpressionVisitor has these fields, but `CallArgumentInfo` (the shared type) does not.

```typescript
export interface CallArgumentInfo {
  // ... existing fields ...
  objectName?: string;      // NEW: object name for MemberExpression args (e.g., 'this')
  propertyName?: string;    // NEW: property name for MemberExpression args (e.g., 'handler')
}
```

### 2. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — Handle MemberExpression in extractMethodCallArguments

The function-body argument extractor (line 5114) currently falls through to generic `EXPRESSION` for MemberExpression args. Add explicit handling:

```typescript
// After line 5174 (the CallExpression check), add:
} else if (t.isMemberExpression(arg)) {
  argInfo.targetType = 'EXPRESSION';
  argInfo.expressionType = 'MemberExpression';
  if (t.isIdentifier(arg.object)) {
    argInfo.objectName = arg.object.name;
  } else if (t.isThisExpression(arg.object)) {
    argInfo.objectName = 'this';
  }
  if (!arg.computed && t.isIdentifier(arg.property)) {
    argInfo.propertyName = arg.property.name;
  }
}
```

### 3. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` — Add MemberExpression callback resolution

In `bufferArgumentEdges`, after the VARIABLE branch (line 1895), add new branch:

```typescript
else if (targetType === 'EXPRESSION' && arg.expressionType === 'MemberExpression') {
  const { objectName, propertyName } = arg;

  if (objectName === 'this' && propertyName) {
    // Find the containing class method from parentScopeId
    const callScopeId = call && 'parentScopeId' in call
      ? (call as CallSiteInfo).parentScopeId as string : '';

    // parentScopeId IS the function's semantic ID for calls inside function bodies
    const containingFunc = functions.find(f => f.id === callScopeId);
    const className = (containingFunc as ClassFunctionInfo)?.className;

    if (className) {
      const methodNode = functions.find(f =>
        (f as ClassFunctionInfo).isClassMethod === true &&
        (f as ClassFunctionInfo).className === className &&
        f.name === propertyName &&
        f.file === file
      );

      if (methodNode) {
        targetNodeId = methodNode.id;

        const callName = call && 'method' in call
          ? (call as MethodCallInfo).method : call?.name;
        if (callName && KNOWN_CALLBACK_INVOKERS.has(callName)) {
          this._bufferEdge({
            type: 'CALLS',
            src: callId,
            dst: methodNode.id,
            metadata: { callType: 'callback' }
          });
        }
      }
    }
  }
}
```

**Key insight:** The `parentScopeId` for calls inside class method bodies IS the method's semantic ID (e.g., `{file}->{className}->FUNCTION->{methodName}`). So `functions.find(f => f.id === callScopeId)` directly finds the containing method with its `className` field.

### 4. `test/unit/CallbackFunctionReference.test.js` — Add test cases

Add new describe block:

1. `this.handler` passed to `forEach` → CALLS edge created
2. `this.handler` passed to `map` → CALLS + PASSES_ARGUMENT edges
3. Multiple methods in same class used as callbacks
4. `this.handler` in non-HOF → no false-positive CALLS edge
5. `obj.method` → no CALLS edge (out of scope for MVP)

## Complexity

- O(f) per MemberExpression argument where f = functions in file
- Same pattern as REG-400
- No new data structures or indices

## Risks

- `parentScopeId` might not match function ID format in all cases (e.g., nested scopes) — mitigated by strict `functions.find(f => f.id === callScopeId)` check
- Module-level class methods have different scope chain than function-body — both paths need testing
