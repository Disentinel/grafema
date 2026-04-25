# Don Melton — High-Level Plan for REG-297: Track Top-Level Await

## Analysis Summary

MODULE nodes are created by JSModuleIndexer during INDEXING phase. Additional metadata is added during ANALYSIS phase using the upsert pattern (see REG-300's `updateModuleImportMetaMetadata`).

This follows the **metadata-on-MODULE-node** pattern (like REG-300), not a data-flow-edge pattern (like REG-270/yield).

## Approach

Two deliverables:
1. **`hasTopLevelAwait: true`** — Boolean flag on MODULE node
2. **`topLevelAwaits`** — Array of `{ line, column, expressionType }` for each top-level await expression

### Detection Strategy

Add a traverse pass in `analyzeModule()` that:
- Visits `AwaitExpression` nodes where `getFunctionParent()` returns null (top-level)
- Also visits `ForOfStatement` with `await: true` where `getFunctionParent()` is null (`for await...of`)
- Collects location + expression type info

### GraphBuilder Update

Following REG-300 pattern exactly:
- New `updateModuleTopLevelAwaitMetadata()` method
- Called after existing `updateModuleImportMetaMetadata` in `build()`
- Uses upsert pattern to add metadata to MODULE node

## Files to Change

1. **`JSASTAnalyzer.ts`** — Add top-level await detection in `analyzeModule()`
2. **`ast/types.ts`** — Add `topLevelAwaits` to `ASTCollections`
3. **`GraphBuilder.ts`** — Add `updateModuleTopLevelAwaitMetadata()`, call from `build()`
4. **`ModuleNode.ts`** — Add optional fields to `ModuleNodeRecord`
5. **New test** — `test/unit/TopLevelAwait.test.js`

## Test Cases

1. Module with `const data = await fetchData();` → hasTopLevelAwait: true
2. Module with `await import('./module.js');` → Detected
3. Module with `for await (const item of stream) {}` → Detected (ForOfStatement.await)
4. Module with await inside function only → No hasTopLevelAwait
5. Module with multiple top-level awaits → All captured
6. Module with no await → No hasTopLevelAwait property

## Risks

1. **`for await...of`** uses `ForOfStatement.await: true`, not `AwaitExpression` — needs separate check
2. **Parallel path (ASTWorkerPool)** — must include `topLevelAwaits` in worker collections

## Scope

**Small.** ~50-80 lines production code, ~150-200 lines tests. Follows REG-300 pattern exactly.
