# Rob Implementation Report: REG-559

## Change

**File:** `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

**Lines changed:** Added 4 lines after line 292 (the `ArrowFunctionExpression` handler opening).

**Diff:**
```typescript
// Arrow functions (module-level, assigned to variables or as callbacks)
ArrowFunctionExpression: (path: NodePath) => {
+  // Skip arrow functions nested inside other functions — those are handled
+  // by NestedFunctionHandler during analyzeFunctionBody traversal.
+  const functionParent = path.getFunctionParent();
+  if (functionParent) return;
+
   const node = path.node as ArrowFunctionExpression;
```

This guard matches the existing pattern in `JSASTAnalyzer.ts` (line 1983-1984) where `FunctionExpression` uses the same `getFunctionParent()` check to skip nested functions.

## Build Result

Build succeeded with zero errors.

## Test Results

- **2254 pass, 0 fail, 5 skipped, 22 todo**
- Snapshot `03-complex-async` required update: the fix correctly changed anonymous function counter values because nested arrow functions are no longer double-processed at module level. Scope IDs shifted (e.g., `SCOPE:else:139:13:1` -> `SCOPE:else:139:13:9`) reflecting the corrected traversal order.
- All other tests unaffected.

## Committed Files

1. `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` -- the fix
2. `test/snapshots/03-complex-async.snapshot.json` -- updated snapshot
