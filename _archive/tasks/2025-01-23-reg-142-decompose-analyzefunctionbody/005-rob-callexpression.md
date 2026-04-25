# Rob Pike - CallExpression Handler Extraction Report

## Task
Extract CallExpression handler from `analyzeFunctionBody` into a separate private method.

## Implementation

### Created Method: `handleCallExpression()`

**Location:** `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 2105-2219)

**Signature:**
```typescript
private handleCallExpression(
  callNode: t.CallExpression,
  processedCallSites: Set<string>,
  processedMethodCalls: Set<string>,
  callSites: CallSiteInfo[],
  methodCalls: MethodCallInfo[],
  module: VisitorModule,
  callSiteCounterRef: CounterRef,
  scopeTracker: ScopeTracker | undefined,
  parentScopeId: string,
  collections: VisitorCollections
): void
```

### Method Responsibilities

The extracted method handles:

1. **Direct function calls** (Identifier callee) - `greet()`, `main()`
   - Deduplication via `processedCallSites` Set
   - Semantic ID generation via `scopeTracker` or fallback to legacy ID
   - Adds to `callSites` collection

2. **Method calls** (MemberExpression callee) - `obj.method()`, `data.process()`
   - Deduplication via `processedMethodCalls` Set
   - Handles both `Identifier` and `ThisExpression` objects
   - Handles computed properties (`obj[prop]()`)
   - Semantic ID generation
   - Adds to `methodCalls` collection

3. **Array mutation detection** - `arr.push()`, `arr.unshift()`, `arr.splice()`
   - Delegates to `detectArrayMutationInFunction()` for specific handling
   - Initializes `collections.arrayMutations` if needed

4. **Object.assign() detection**
   - Delegates to `detectObjectAssignInFunction()`
   - Initializes `collections.objectMutations` if needed

### Updated CallExpression Handler

**Before:** 107 lines of inline logic
**After:** 13 lines delegating to the new method

```typescript
// Function call expressions
CallExpression: (callPath: NodePath<t.CallExpression>) => {
  this.handleCallExpression(
    callPath.node,
    processedCallSites,
    processedMethodCalls,
    callSites,
    methodCalls,
    module,
    callSiteCounterRef,
    scopeTracker,
    parentScopeId,
    collections
  );
},
```

## Verification

### Build
```
npm run build - PASSED
```

### Tests
Ran CallExpression-related tests:
- `CallSiteNodeSemanticId.test.js`
- `MethodCallNodeSemanticId.test.js`
- `CallExpressionVisitorSemanticIds.test.js`
- `ArrayMutationTracking.test.js`
- `ObjectMutationTracking.test.js`

**Results:** 89 passed, 0 failed, 2 skipped

## Design Notes

1. **Parameter count:** The method has 10 parameters, which is on the higher side. This is a direct consequence of extracting logic that uses many contextual variables. Alternative approaches considered:
   - Context object pattern - would require defining a new interface
   - Method binding with partial application - adds complexity
   - Current approach is explicit and matches existing patterns (`createLoopScopeHandler` has 7 params)

2. **Method placement:** Added before `detectArrayMutationInFunction()` since it calls that method, keeping related code together.

3. **JSDoc:** Added comprehensive documentation explaining all parameters and the method's responsibilities.

## Lines Changed

- **Removed:** ~107 lines of inline code from `analyzeFunctionBody`
- **Added:** ~115 lines for the new `handleCallExpression` method (including JSDoc)
- **Net:** ~94 line reduction in `analyzeFunctionBody`

## Status: COMPLETE

Pure refactoring with no behavior change. All tests pass.
