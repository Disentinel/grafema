# Don Melton's Analysis: REG-402 — Callback Resolution for Method References (`this.handler`)

## Executive Summary

REG-400 handles callback resolution for **identifier references** (`forEach(handler)`). REG-402 extends this to **method references** (`forEach(this.handler)`). The pattern already exists in the codebase—MemberExpression arguments are partially handled but NOT resolved for callbacks.

**Approach:** Extend `GraphBuilder.bufferArgumentEdges` to handle `this.method` in the same-file analysis phase, following the exact pattern established by REG-400. Cross-file and `obj.method` require type inference and should be deferred.

## 1. Current State

### What Works (REG-400)

```javascript
function handler() { return 1; }
arr.forEach(handler);
```

Creates:
- `PASSES_ARGUMENT: forEach -> FUNCTION(handler)`
- `CALLS: forEach -> FUNCTION(handler)` with `metadata: { callType: 'callback' }`

### What Doesn't Work (REG-402)

```javascript
class MyClass {
  handler(x) { return x * 2; }

  process(arr) {
    arr.forEach(this.handler);        // MemberExpression, NOT Identifier
    arr.map(this.handler.bind(this)); // CallExpression wrapping MemberExpression
  }
}
```

**Problem:** `this.handler` is a `MemberExpression`, not an `Identifier`. CallExpressionVisitor correctly identifies it as `targetType='EXPRESSION'` with `objectName='this'` and `propertyName='handler'`, but GraphBuilder does NOT resolve it to a FUNCTION node.

## 2. Architecture Analysis

### CallExpressionVisitor.extractArguments (lines 427-438)

**ALREADY CORRECT:**

```typescript
else if (actualArg.type === 'MemberExpression') {
  const memberExpr = actualArg as MemberExpression;
  argInfo.targetType = 'EXPRESSION';
  argInfo.expressionType = 'MemberExpression';
  if (memberExpr.object.type === 'Identifier') {
    argInfo.objectName = memberExpr.object.name;  // "this"
  }
  if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
    argInfo.propertyName = memberExpr.property.name;  // "handler"
  }
}
```

This extracts `objectName='this'` and `propertyName='handler'` for `this.handler`.

### GraphBuilder.bufferArgumentEdges (lines 1838-1948)

**MISSING BRANCH:** No handling for `targetType === 'EXPRESSION'` with `expressionType === 'MemberExpression'`.

Current branches:
1. `targetType === 'VARIABLE'` → check functions, create CALLS if HOF (REG-400)
2. `targetType === 'FUNCTION'` → direct inline callback
3. `targetType === 'CALL'` → nested call
4. `targetType === 'LITERAL' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL'` → literal arguments

**Need to add:** Branch for `targetType === 'EXPRESSION'` with `expressionType === 'MemberExpression'`.

### Class Methods Storage

**ClassVisitor.ts (lines 342-356):**

```typescript
const funcData: ClassFunctionInfo = {
  id: functionId,
  type: 'FUNCTION',
  name: methodName,
  file: module.file,
  line: methodLine,
  column: methodColumn,
  async: methodNode.async || false,
  generator: methodNode.generator || false,
  isClassMethod: true,        // ← KEY FIELD
  className: className,       // ← KEY FIELD
  methodKind: methodNode.kind,
  legacyId
};
(functions as ClassFunctionInfo[]).push(funcData);
```

Class methods are stored in the same `functions` array with `isClassMethod: true` and `className` set.

### ScopeTracker.getEnclosingScope

Already used for `this.prop` assignment tracking (JSASTAnalyzer.ts lines 5690, 5815):

```typescript
if (scopeTracker) {
  enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
}
```

Returns the current class name from the scope stack.

## 3. Proposed Solution

### 3a. Extract Class Name in CallExpressionVisitor

**PROBLEM:** When we buffer the ArgumentInfo, we don't have access to ScopeTracker in CallExpressionVisitor to get the enclosing class name.

**INVESTIGATION NEEDED:** Check how CallExpressionVisitor is called and whether scopeTracker is available.

Looking at the visitor pattern, CallExpressionVisitor is instantiated with `collections` but may not have `scopeTracker` available. The class name resolution will need to happen in GraphBuilder where we have access to both:
- The callId scope information (via `call.parentScopeId`)
- The functions collection with `className` metadata

**DECISION:** Do NOT modify CallExpressionVisitor. The ArgumentInfo already contains `objectName='this'` and `propertyName='handler'`. Resolution happens in GraphBuilder.

### 3b. Add Branch in GraphBuilder.bufferArgumentEdges

After line 1895, add new branch:

```typescript
// REG-402: MemberExpression callbacks (this.method)
else if (targetType === 'EXPRESSION' && arg.expressionType === 'MemberExpression') {
  const { objectName, propertyName } = arg;

  // Only handle this.method for now (same-file resolution)
  if (objectName === 'this' && propertyName) {
    // Extract class name from the call's scope
    const callScopeId = call && 'parentScopeId' in call
      ? (call as CallSiteInfo).parentScopeId as string
      : '';

    // Find class name from scope ID (format: SCOPE#ClassName#file#line or similar)
    // Or use functions array to find the calling function's className
    const callingFunc = functions.find(f =>
      f.file === file && callScopeId && callScopeId.includes(f.id)
    );
    const className = callingFunc?.className;

    if (className) {
      // Find method in same class
      const methodNode = functions.find(f =>
        f.isClassMethod === true &&
        f.className === className &&
        f.name === propertyName &&
        f.file === file
      );

      if (methodNode) {
        targetNodeId = methodNode.id;

        // Create CALLS edge for known HOFs
        const callName = call && 'method' in call
          ? (call as MethodCallInfo).method
          : call?.name;
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

**ISSUE:** How to get the class name from the call scope? The `parentScopeId` might not directly contain the class name.

**BETTER APPROACH:** Use the functions array differently. When we're processing arguments for a METHOD_CALL inside a class method, the METHOD_CALL node should have metadata linking it to its containing FUNCTION, which has `className`.

**REVISED APPROACH:** Extract class name from the scope chain:

```typescript
// Get the calling context's class name
// For this.method, we need to know which class "this" refers to
// This is determined by the enclosing FUNCTION's className field

// Find the function that contains this call
const containingFunc = functions.find(f =>
  f.isClassMethod === true &&
  f.file === file &&
  callScopeId && (
    callScopeId === f.id ||
    callScopeId.includes(f.name)
  )
);

const className = containingFunc?.className;
```

**PROBLEM:** This relies on callScopeId format and may be brittle.

**ALTERNATIVE:** Store the enclosing class name IN the ArgumentInfo when extracting arguments. This would require passing scopeTracker to CallExpressionVisitor, which changes the visitor API.

## 4. Research: How Do Other Tools Handle This?

From web search ([Static Analysis for JavaScript](https://arxiv.org/pdf/1901.03575), [Practical Static Analysis](https://www.doc.ic.ac.uk/~livshits/papers/pdf/fse13.pdf)):

1. **Context Sensitivity:** Most tools use call-site sensitivity or object sensitivity to track `this` binding
2. **Class-based Analysis:** TypeScript compiler resolves `this.method` by maintaining class context during traversal
3. **Scope-based Lookup:** ESLint and similar tools track scope chains with class information

**Key Insight:** We need class context available when processing the argument. Two options:
- **Option A:** Pass scopeTracker to CallExpressionVisitor and store `enclosingClass` in ArgumentInfo
- **Option B:** Infer class from call site scope in GraphBuilder (more complex, potentially brittle)

**Recommendation:** Option A is cleaner and follows the pattern already used for `this.prop` assignments in JSASTAnalyzer.

## 5. ROOT CAUSE: Missing Class Context in Argument Extraction

The real issue: **CallExpressionVisitor extracts arguments without class context.**

When we see `this.handler`, we record `objectName='this'` but don't record **which class `this` refers to**. This information exists in ScopeTracker but isn't captured.

### Implications of Passing ScopeTracker to Visitor

**Check:** Does CallExpressionVisitor already have access to scopeTracker?

Looking at the visitor instantiation pattern, I need to check how visitors are called. Let me verify this assumption.

**Finding:** After checking the codebase, CallExpressionVisitor is a utility class that operates on collections, not the full AST traversal context. It doesn't have direct access to scopeTracker.

### Alternative: Two-Phase Resolution

**Phase 1 (Visitor):** Extract `objectName='this'`, `propertyName='handler'` (ALREADY DONE)

**Phase 2 (GraphBuilder):** Resolve class context using the call site's parentScopeId

This is actually what REG-400 does for variable references! It extracts the variable name in the visitor, then resolves it in GraphBuilder using scope information.

## 6. Final Architecture Decision

**Follow the REG-400 pattern exactly:**

1. **CallExpressionVisitor:** Extract metadata (ALREADY DONE)
   - `objectName = 'this'`
   - `propertyName = 'handler'`
   - `targetType = 'EXPRESSION'`
   - `expressionType = 'MemberExpression'`

2. **GraphBuilder.bufferArgumentEdges:** Resolve using scope information
   - Get call's parentScopeId
   - Find containing function in functions array
   - Extract className from containing function
   - Find method with matching className + propertyName
   - Create CALLS edge if HOF

### Implementation Details

```typescript
// In bufferArgumentEdges, after line 1895:
else if (targetType === 'EXPRESSION' && arg.expressionType === 'MemberExpression') {
  const { objectName, propertyName } = arg;

  if (objectName === 'this' && propertyName) {
    // Get the call's scope to find containing function
    const callScopeId = call && 'parentScopeId' in call
      ? (call as CallSiteInfo).parentScopeId as string
      : '';

    // Find the function that contains this call (must be a class method)
    const containingFunc = this.findContainingClassMethod(functions, file, callScopeId);

    if (containingFunc?.className) {
      // Look up method in same class
      const methodNode = functions.find(f =>
        f.isClassMethod === true &&
        f.className === containingFunc.className &&
        f.name === propertyName &&
        f.file === file
      );

      if (methodNode) {
        targetNodeId = methodNode.id;

        // Create CALLS edge for known HOFs (same pattern as REG-400)
        const callName = call && 'method' in call
          ? (call as MethodCallInfo).method
          : call?.name;
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

**Helper method:**

```typescript
private findContainingClassMethod(
  functions: FunctionInfo[],
  file: string,
  scopeId: string
): FunctionInfo | undefined {
  // The scopeId points to a SCOPE node, we need to find the function that owns it
  // Strategy: Find class methods in same file, check if scopeId contains their ID or name
  return functions.find(f =>
    f.isClassMethod === true &&
    f.file === file &&
    scopeId && (
      scopeId.includes(f.id) ||
      scopeId.includes(`${f.className}.${f.name}`)
    )
  );
}
```

## 7. Scope and Limitations

### In Scope
- `this.method` as callback within same class
- Same-file resolution only
- Works for all HOFs in KNOWN_CALLBACK_INVOKERS whitelist

### Out of Scope (Technical Limitations)
| Pattern | Why Not | What's Needed |
|---------|---------|---------------|
| `obj.method` where obj is instance | Need type inference to know obj's class | Type system / INSTANCE_OF resolution |
| `this.method.bind(this)` | Argument is CallExpression, not MemberExpression | Separate handling for bind() wrapping |
| Cross-file `this.method` | Method might be defined in superclass in different file | Inheritance chain traversal |
| `super.method` | Different object reference | Superclass resolution |

**Note on `bind()`:** When we see `arr.forEach(this.handler.bind(this))`, the actual argument is a `CallExpression` (the `bind()` call), not a `MemberExpression`. We would need to:
1. Detect CallExpression with callee being MemberExpression where `property.name === 'bind'`
2. Extract the `object` from that MemberExpression
3. Resolve that object

This is a separate feature (REG-40X candidate) and should NOT block REG-402.

### MVP Acceptance Criteria

```javascript
class MyClass {
  handler(item) { return item * 2; }

  process(arr) {
    arr.forEach(this.handler);  // ✓ Creates CALLS edge
    arr.map(this.handler);      // ✓ Creates CALLS edge
  }
}
```

Must create:
- `PASSES_ARGUMENT: forEach -> FUNCTION(handler)`
- `CALLS: forEach -> FUNCTION(handler)` with `metadata: { callType: 'callback' }`

## 8. Complexity Analysis

**Time Complexity:**
- Per argument: O(f) where f = functions in file (filtered to class methods)
- Total: O(a × f) where a = MemberExpression arguments
- In practice: f is small per file (typically <100 functions, <20 methods per class)

**Space Complexity:** O(1) per argument, no new indices needed

**Comparison to REG-400:**
REG-400 uses `findFunctionByName` which is O(f) per lookup. REG-402 uses similar pattern.

## 9. Test Plan

### New Tests (add to CallbackFunctionReference.test.js)

```javascript
describe('Method reference callbacks (this.method)', () => {
  it('should create CALLS edge from forEach to this.handler in class', async () => {
    await setupTest(backend, {
      'index.js': `
class MyClass {
  handler(item) { return item * 2; }

  process(arr) {
    arr.forEach(this.handler);
  }
}
`
    });

    const handlerFunc = allNodes.find(n =>
      n.type === 'FUNCTION' &&
      n.name === 'handler' &&
      n.isClassMethod === true
    );
    assert.ok(handlerFunc);

    const forEachCall = allNodes.find(n =>
      n.type === 'METHOD_CALL' && n.method === 'forEach'
    );
    assert.ok(forEachCall);

    const callsEdge = allEdges.find(e =>
      e.type === 'CALLS' &&
      e.src === forEachCall.id &&
      e.dst === handlerFunc.id
    );
    assert.ok(callsEdge);
    assert.strictEqual(callsEdge.metadata.callType, 'callback');
  });

  it('should create PASSES_ARGUMENT edge for this.handler', async () => {
    // Similar test for PASSES_ARGUMENT edge
  });

  it('should handle multiple methods in same class', async () => {
    // Test class with handler1, handler2 used in different HOFs
  });

  it('should NOT resolve obj.method (out of scope)', async () => {
    // Verify we don't create false positive for obj.method
    await setupTest(backend, {
      'index.js': `
const parser = getParser();
arr.forEach(parser.parse);  // Should NOT create CALLS edge (no type info)
`
    });
    // Assert no CALLS edge created
  });
});
```

### Regression Tests
- Existing CallbackFunctionReference.test.js must still pass
- MethodCallResolver.test.js must still pass (this.method() calls)

## 10. Files to Modify

1. **packages/core/src/plugins/analysis/ast/GraphBuilder.ts**
   - Add branch in `bufferArgumentEdges` for `targetType === 'EXPRESSION'`
   - Add helper method `findContainingClassMethod`

2. **test/unit/CallbackFunctionReference.test.js**
   - Add new test suite for `this.method` callbacks

## 11. Risks and Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| scopeId format mismatch | Medium | High | Test with real code, add debug logging |
| Performance regression | Low | Medium | Use same O(f) pattern as REG-400 |
| False positives (wrong class) | Low | High | Strict matching on className AND file |
| `obj.method` accidental resolution | Low | High | Explicit check for `objectName === 'this'` |

## 12. Open Questions for Joel

1. **Scope ID format:** What is the exact format of `parentScopeId` for method bodies? Is it reliable for extracting class context?

2. **Helper method placement:** Should `findContainingClassMethod` be near `findFunctionByName` or inline in the branch?

3. **Bind handling:** Should we handle `this.method.bind(this)` in REG-402 or defer to separate task?

4. **Cross-file:** When should we tackle cross-file `this.method` resolution? Requires EXTENDS edge traversal.

## 13. Alignment with Project Vision

**"AI should query the graph, not read code."**

This feature enables querying callback relationships for class methods:

```
MATCH (call:METHOD_CALL)-[:CALLS {callType: 'callback'}]->(method:FUNCTION)
WHERE method.isClassMethod = true
RETURN call, method
```

Without REG-402, users must manually inspect class method bodies to find `this.handler` patterns. With REG-402, Grafema captures this automatically.

**Product gap filled:** Impact analysis for class methods used as callbacks now works correctly.

---

## Sources

Research on static analysis approaches for JavaScript callback resolution:

- [Static Analysis for Asynchronous JavaScript Programs](https://arxiv.org/pdf/1901.03575) - Academic paper on callback analysis challenges in JS
- [Practical Static Analysis of JavaScript Applications](https://www.doc.ic.ac.uk/~livshits/papers/pdf/fse13.pdf) - Microsoft Research on real-world JS static analysis
- [Practical Static Analysis of JavaScript Applications (MSR)](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-7.pdf) - Additional resource on JS analysis frameworks
