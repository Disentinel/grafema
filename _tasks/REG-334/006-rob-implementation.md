# REG-334: Implementation Report

## Summary

Implemented Promise dataflow tracking through resolve() calls. The feature creates RESOLVES_TO edges from resolve/reject CALL nodes to their parent Promise CONSTRUCTOR_CALL nodes, enabling traceValues to follow Promise-based data flow.

## Implementation Details

### Problem

When tracing data flow through code like:
```javascript
const result = await new Promise((resolve) => {
  resolve(42);
});
```
Grafema couldn't connect the Promise's resolved value (42) back to the variable `result`. There was no edge linking the resolve() call to the Promise constructor.

### Solution

Implemented a forward registration pattern:

1. **Promise executor detection in FunctionVisitor**: Before analyzing a function body, we check if the function is a Promise executor callback (first argument to `new Promise(...)`). If so, we register the context containing:
   - The CONSTRUCTOR_CALL ID for the Promise
   - The resolve/reject parameter names
   - A unique key based on function AST position

2. **Resolve/reject call detection in analyzeFunctionBody**: When processing CallExpression nodes, we walk up the function parent chain to find if we're inside a Promise executor context. If the callee name matches the resolve/reject parameter name, we create:
   - A RESOLVES_TO edge from the CALL node to the CONSTRUCTOR_CALL node
   - LITERAL nodes for literal arguments (like `resolve(42)`)
   - PASSES_ARGUMENT edges from the CALL to its arguments

3. **traceValues integration**: The existing CONSTRUCTOR_CALL handling in traceValues now follows incoming RESOLVES_TO edges to find what values are passed to resolve/reject.

### Files Changed

#### `/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`
- Added `detectPromiseExecutorContext` method to detect Promise executor callbacks
- Added imports for FunctionExpression, NewExpression, PromiseExecutorContext, ConstructorCallNode
- Called detection method before `analyzeFunctionBody` for arrow functions

#### `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- Added resolve/reject call detection in CallExpression handler (lines 4291-4391)
- Creates LITERAL nodes for literal arguments to resolve/reject calls
- Properly populates callArguments for PASSES_ARGUMENT edge creation
- Added `promiseResolutions` and `callArguments` to GraphBuilder.build() call

#### `/packages/core/src/plugins/analysis/ast/types.ts`
- Added `line`, `column`, `literalValue`, `expressionType` fields to CallArgumentInfo interface

#### `/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`
- Added `getIncomingEdges` method to the backend adapter for traceValues CONSTRUCTOR_CALL handling

### Key Design Decisions

1. **Forward registration pattern**: Promise executor context is registered BEFORE analyzing the function body, not during. This ensures context is available when resolve/reject calls are processed.

2. **Function parent chain traversal**: Resolve calls can be inside nested callbacks (e.g., `db.query((err, data) => { resolve(data); })`). We walk up the `getFunctionParent()` chain to find the Promise executor context.

3. **Position-based context key**: Using `${funcNode.start}:${funcNode.end}` as the map key allows handling nested Promises correctly - each has its own unique context.

4. **LITERAL node creation for arguments**: To enable traceValues to find the actual resolved values, we create LITERAL nodes for literal arguments and proper PASSES_ARGUMENT edges.

## Test Results

All 11 tests passing:

```
ok 1 - Promise Resolution Detection (REG-334)
  - should create RESOLVES_TO edge from resolve CALL to Promise CONSTRUCTOR_CALL
  - should have PASSES_ARGUMENT edge from resolve CALL to the argument
  - should create RESOLVES_TO edges for both resolve and reject calls
  - should create RESOLVES_TO edge even from deeply nested resolve call
  - should link each resolve to its own Promise (no cross-linking)
  - should handle Promise with no resolve parameter (no crash)
  - should handle Promise with non-inline executor (out of scope)
  - should handle multiple resolve calls in same executor

ok 2 - traceValues with RESOLVES_TO edges (REG-334)
  - should trace variable through Promise to literal value
  - should trace variable through Promise to find multiple resolve values
  - should handle Promise without RESOLVES_TO as unknown
```

## Known Limitations (Out of Scope)

1. **Non-inline executors**: `new Promise(myExecutorFunction)` doesn't create RESOLVES_TO edges because we can't determine which Promise the resolve inside `myExecutorFunction` belongs to. This would require inter-procedural analysis.

2. **Dynamic resolve references**: If resolve is passed around (`const r = resolve; r(42);`), we don't track this aliasing.

## Complexity Analysis

- O(1) for Promise executor detection (single parent check)
- O(depth) for resolve/reject detection where depth is function nesting level (typically 1-3)
- No new iteration over all nodes - all work happens during existing AST traversal
