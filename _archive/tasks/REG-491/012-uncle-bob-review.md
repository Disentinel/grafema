## Uncle Bob — Code Quality Review

**Verdict:** APPROVE

**File sizes:** OK
**Method quality:** OK
**Patterns & naming:** OK

---

### File Sizes

| File | Lines | Status |
|------|-------|--------|
| `packages/core/src/plugins/analysis/ast/types.ts` | 1248 | OK — large but it's a type-only registry, not logic |
| `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts` | 160 | OK |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | 621 | OK — within limits |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | 4116 | Pre-existing issue — not caused by this change. The `traverse_new` block added ~80 lines to an already large file. No regression introduced. |
| `test/unit/ConstructorCallTracking.test.js` | 799 | OK for a test file |

### `ConstructorCallInfo` interface (types.ts)

The addition of `parentScopeId?: string` follows the identical pattern used by every other info type in this file — `ClassInstantiationInfo`, `ScopeInfo`, `BranchInfo`, `LoopInfo`, `TryBlockInfo`, etc. all carry `parentScopeId?: string` as an optional field. The field is correctly placed last among the required fields (before the optional group). Section header comment (`// === CONSTRUCTOR CALL INFO ===`) matches the existing style. Interface is clean and minimal.

No issues.

### `NewExpressionHandler.ts` — parentScopeId addition

The change adds `parentScopeId: ctx.getCurrentScopeId()` to the object literal pushed to `ctx.constructorCalls`. This is a one-line addition at line 51 within the existing object literal. It uses the same `ctx.getCurrentScopeId()` call pattern already used in the same file for `callSites.push` (line 113) and `methodCalls.push` (line 153). The addition is consistent, minimal, and matches existing style exactly.

No issues.

### `GraphBuilder.ts` — step 4.5 CONSTRUCTOR_CALL buffering

The new block (lines 302-323) follows the established pattern for buffering nodes + CONTAINS edges. The pattern:

```typescript
// SCOPE -> CONTAINS -> CONSTRUCTOR_CALL
if (constructorCall.parentScopeId) {
  this._bufferEdge({ type: 'CONTAINS', src: constructorCall.parentScopeId, dst: constructorCall.id });
}
```

matches exactly how `ControlFlowBuilder.ts` creates parent CONTAINS edges for LOOP, TRY_BLOCK, CATCH_BLOCK, etc. — guard on `parentScopeId`, then `bufferEdge`. The comment style `// SCOPE -> CONTAINS -> CONSTRUCTOR_CALL` matches `// Parent -> CONTAINS -> LOOP` from ControlFlowBuilder. The numeric prefix `4.5` fits between the existing step 4 (CALL_SITE) and step 5 (phase 2 delegates) — the decimal suffix is an unusual but pragmatic choice that has precedent in this file.

The `_bufferNode` call spreads the required fields explicitly rather than spreading the whole object — this is deliberate and matches how other buffers here strip internal-only fields (e.g., step 4 strips `targetFunctionName`). Correct.

No issues.

### `JSASTAnalyzer.ts` — getFunctionParent guard in traverse_new

The new `traverse_new` pass (lines 1729-1806) uses the same guard pattern as every other module-level traversal pass in this file:

```typescript
const functionParent = newPath.getFunctionParent();
if (functionParent) return;
```

This is the exact same two-line guard used by `traverse_assignments`, `traverse_updates`, `traverse_callbacks`, `traverse_top_level_await`, `traverse_ifs`, and others. The comment `// Skip in-function calls — handled by NewExpressionHandler in analyzeFunctionBody` clearly explains the responsibility split. The `processedConstructorCalls` Set for dedup is correctly scoped to the traverse and follows the same pattern as `processedMethodCalls` in the file.

The `parentScopeId: module.id` for module-level calls correctly uses the module node's ID as the scope, consistent with how the top-level scope is established elsewhere.

No issues.

### `test/unit/ConstructorCallTracking.test.js` — CONTAINS edges block

The new describe block `'CONTAINS edges for CONSTRUCTOR_CALL nodes'` (lines 599-768) follows existing test structure: describe → it → setupTest → getAllNodes/getAllEdges → targeted assertions. Test names communicate intent precisely:

- `'should create CONTAINS edge from MODULE to module-level assigned constructor call'` — clear
- `'should create CONTAINS edge from function scope to function-scoped assigned constructor call'` — clear
- `'should create CONTAINS edge for thrown unassigned constructor call'` — clear, covers the key fix
- `'should create CONTAINS edge for constructor call passed as argument'` — clear
- `'should create CONTAINS edge for constructor call in return statement'` — clear

Each test has meaningful failure messages in `assert.ok(...)` calls. The test for thrown `new Error()` explicitly verifies there is NO `ASSIGNED_FROM` edge (negative assertion), then verifies there IS a `CONTAINS` edge — this demonstrates understanding of the contract and communicates intent clearly.

The comment `// This is the key fix — unassigned constructor calls need CONTAINS edges.` in the failure message is helpful but could be seen as implementation commentary rather than failure diagnosis. Minor style point, not a blocker.

No duplication between tests — each covers a distinct case (module-level, function-scoped, thrown, argument, return). Tests are cohesive with the pre-existing test file structure.

No issues.

### Duplication check

No duplication introduced. The `parentScopeId` field is defined once in the interface and populated at two call sites (NewExpressionHandler for in-function calls, JSASTAnalyzer for module-level calls) — this is correct given the two-path architecture, not duplication.

### Summary

All five changes are minimal, focused, and consistent with surrounding code. The pattern used for CONTAINS edge creation in GraphBuilder matches the established ControlFlowBuilder convention. The getFunctionParent guard in JSASTAnalyzer is identical to 6 other guards in the same file. The ConstructorCallInfo interface addition follows the exact same form as adjacent interfaces. Tests are clear and cover the key scenarios including the negative assertion.
