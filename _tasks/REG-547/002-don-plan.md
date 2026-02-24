# Don's Plan: REG-547

## Exploration Summary

### Two Separate Processing Pipelines for NewExpression

Every `new X()` expression in the codebase flows through **two independent pipelines simultaneously**. Both pipelines are triggered from the same AST traversal but serve different purposes. The bug is that only one pipeline emits the correct node type.

---

### Pipeline 1: CONSTRUCTOR_CALL (correct path)

**Where it fires:** `NewExpressionHandler.getHandlers()` (inside function bodies) and `JSASTAnalyzer` (module-level, ~line 1764). There is also `FunctionVisitor.ts` for the special Promise executor case.

**What it does:** Creates a `ConstructorCallInfo` record pushed to `ctx.constructorCalls[]` / `constructorCalls[]`. These records have `type: 'CONSTRUCTOR_CALL'`, `className`, `isBuiltin`, `file`, `line`, `column`, `parentScopeId`.

**GraphBuilder consumption (GraphBuilder.ts lines 302-323):** Step 4.5 buffers each `constructorCalls` entry as a proper `CONSTRUCTOR_CALL` node, then emits a `CONTAINS` edge from `parentScopeId` to it.

**Result:** Correct. Produces `CONSTRUCTOR_CALL` nodes with `name: "new ClassName()"`, `className`, `isBuiltin`.

---

### Pipeline 2: CALL with isNew:true (wrong path)

**Where it fires — 4 locations:**

1. **`NewExpressionHandler.ts` lines 106-131 (Identifier callee):**
   - `new Foo()` → pushes to `ctx.callSites[]` with `type: 'CALL'`, `name: constructorName`, `isNew: true`
   - Uses `computeSemanticId('CALL', ...)` for ID generation

2. **`NewExpressionHandler.ts` lines 133-170 (MemberExpression callee):**
   - `new ns.Foo()` → pushes to `ctx.methodCalls[]` with `type: 'CALL'`, `name: 'ns.Foo'`, `isNew: true`
   - Uses `computeSemanticId('CALL', ...)` for ID generation

3. **`CallExpressionVisitor.ts` lines 486-519 (`handleNewExpression`, Identifier callee):**
   - Module-level `new Foo()` → pushes to `s.callSites[]` with `type: 'CALL'`, `isNew: true`
   - This is the module-level visitor (only runs when NOT inside a function — `if (functionParent) return`)

4. **`CallExpressionVisitor.ts` lines 520-564 (`handleNewExpression`, MemberExpression callee):**
   - Module-level `new ns.Foo()` → pushes to `s.methodCalls[]` with `type: 'CALL'`, `isNew: true`

**GraphBuilder consumption:**
- `callSites` are buffered in GraphBuilder step 4 (lines 297-300): node type comes directly from the record's `type` field → emitted as `CALL`
- `methodCalls` are buffered in `CoreBuilder.bufferMethodCalls()` (line 166): also emitted as `CALL`
- `CoreBuilder.bufferCallSiteEdges()` creates `CONTAINS` and `CALLS` edges for these `CALL` nodes

**Result:** Wrong. Produces duplicate `CALL` nodes (type: `CALL`, isNew: true) for every `new` expression that already has a correct `CONSTRUCTOR_CALL` node.

---

### What GraphBuilder Already Does Correctly

GraphBuilder step 4 (lines 296-300) buffers call sites without filtering by `isNew`:
```typescript
for (const callSite of callSites) {
  const { targetFunctionName: _targetFunctionName, ...callData } = callSite;
  this._bufferNode(callData as GraphNode);  // emits CALL node with isNew:true
}
```

The `callData` has `type: 'CALL'` from the `CallSiteInfo` interface (types.ts line 295: `type: 'CALL'`). It never becomes `CONSTRUCTOR_CALL`.

---

### Snapshot Confirmation

From `test/snapshots/03-complex-async.snapshot.json`:
- **46 `CALL` nodes with `isNew: true`** — the duplicates
- **46 `CONSTRUCTOR_CALL` nodes** — the correct nodes
- Exact 1:1 correspondence (with minor name variation for `mongoose.Schema` vs `Schema`)

Every `new X()` expression currently creates **two nodes**: one correct `CONSTRUCTOR_CALL` and one spurious `CALL(isNew)`.

---

### Why Both Pipelines Exist

The `CALL(isNew)` path was likely the **original implementation** before `CONSTRUCTOR_CALL` was introduced (REG-200). When `CONSTRUCTOR_CALL` was added, the old `CALL(isNew)` code was not removed. Both pipelines now coexist in `NewExpressionHandler` and `CallExpressionVisitor`.

---

## Root Cause

**In `NewExpressionHandler.ts`:** After correctly creating a `CONSTRUCTOR_CALL` node via `ctx.constructorCalls.push(...)`, the handler continues to **also** push to `ctx.callSites` (Identifier callee) or `ctx.methodCalls` (MemberExpression callee) with `type: 'CALL'` and `isNew: true`. The handler has two logical sections for the same `NewExpression` node — the first is correct, the second is redundant and wrong.

**In `CallExpressionVisitor.ts`:** `handleNewExpression()` for module-level new expressions also pushes to `callSites`/`methodCalls` as `type: 'CALL'` with `isNew: true`. This visitor has no CONSTRUCTOR_CALL creation path at all — it only creates the wrong CALL nodes for module-level new expressions.

**In `JSASTAnalyzer.ts`:** Module-level new expressions are handled by `JSASTAnalyzer` which already creates correct `CONSTRUCTOR_CALL` entries (line 1762-1770), but also invokes the `CallExpressionVisitor` path (through the same traversal). Need to verify whether JSASTAnalyzer independently also creates CALL(isNew) nodes.

The fix is: **remove the CALL(isNew) emission in both places**. The `CONSTRUCTOR_CALL` path handles the full job.

---

## Implementation Plan

### Files to Modify

- `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts` — Remove the second half (lines 105-171) that pushes to `ctx.callSites` and `ctx.methodCalls` with `isNew: true`
- `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts` — Remove `handleNewExpression()` method (lines 472-567) and its registration at line 202
- `packages/core/src/plugins/analysis/ast/visitors/call-expression-types.ts` — Remove `isNew?: boolean` from `CallSiteInfo` and `MethodCallInfo` interfaces
- `packages/core/src/plugins/analysis/ast/types.ts` — Remove `isNew?: boolean` from `CallSiteInfo` and `MethodCallInfo` interfaces
- `test/snapshots/*.snapshot.json` — Regenerate: remove CALL nodes with `isNew: true` (46 in complex-async, and counts in other snapshots)
- `test/unit/CallExpressionVisitorSemanticIds.test.js` — Likely has tests referencing `isNew: true` that need updating

### Step-by-step

**Step 1: Remove CALL(isNew) from NewExpressionHandler**

In `NewExpressionHandler.ts`, delete lines 105-171 entirely. These are the two blocks:
- `// Handle simple constructor: new Foo()` (lines 106-131)
- `// Handle namespaced constructor: new ns.Constructor()` (lines 133-171)

The `CONSTRUCTOR_CALL` creation (lines 34-103) is complete and correct — it handles both Identifier and MemberExpression callees, creates `CONSTRUCTOR_CALL` nodes, extracts arguments for `PASSES_ARGUMENT`/`DERIVES_FROM` edges, and handles Promise executor contexts. Nothing from the deleted blocks is needed.

**Step 2: Remove handleNewExpression from CallExpressionVisitor**

In `CallExpressionVisitor.ts`:
- Delete the `NewExpression` handler registration at line 202: `NewExpression: (path: NodePath) => this.handleNewExpression(path, s),`
- Delete the entire `handleNewExpression()` method (lines 472-567)

Verify: does `CallExpressionVisitor` have CONSTRUCTOR_CALL creation? If not, the module-level new expressions still need to create `CONSTRUCTOR_CALL` nodes. The `JSASTAnalyzer` and the `NewExpressionHandler` (used via `analyzeFunctionBody`) handle this. Need to verify the module-level path.

**Step 3: Verify module-level CONSTRUCTOR_CALL coverage**

Check that module-level `new Foo()` (outside any function) still creates a `CONSTRUCTOR_CALL` node. The `CallExpressionVisitor.handleNewExpression()` was creating CALL(isNew) but not CONSTRUCTOR_CALL. The corresponding CONSTRUCTOR_CALL creation for module-level new expressions needs to be traced:
- `JSASTAnalyzer.ts` line 1762-1770: This creates CONSTRUCTOR_CALL at `parentScopeId: module.id` — this is the module-level path.
- Confirm that `JSASTAnalyzer`'s NewExpression traversal fires for module-level expressions (i.e., is not guarded by `getFunctionParent()`).

**Step 4: Remove isNew from type interfaces**

In `packages/core/src/plugins/analysis/ast/types.ts`:
- Remove `isNew?: boolean` from `CallSiteInfo` (line 302)
- Remove `isNew?: boolean` from `MethodCallInfo` (line 328)

In `packages/core/src/plugins/analysis/ast/visitors/call-expression-types.ts`:
- Remove `isNew?: boolean` from `CallSiteInfo` (line 112)
- Remove `isNew?: boolean` from `MethodCallInfo` (line 132)

**Step 5: Update snapshot files**

Run `pnpm build` then update snapshots. Each snapshot should lose its CALL(isNew) nodes and retain the CONSTRUCTOR_CALL nodes.

**Step 6: Fix any test assertions that check for isNew:true on CALL nodes**

Search for `isNew` in test files and update assertions that were testing the wrong behavior.

---

### Edge Cases

| Input | Expected node type | Handled by |
|-------|-------------------|------------|
| `new Foo()` (in function) | CONSTRUCTOR_CALL, className=Foo | NewExpressionHandler lines 34-103 |
| `new Foo()` (module-level) | CONSTRUCTOR_CALL, className=Foo | JSASTAnalyzer lines 1756-1770 |
| `new Foo<T>()` (TypeScript generic) | CONSTRUCTOR_CALL, className=Foo | Same — Babel strips type params before visiting |
| `new Foo(args)` | CONSTRUCTOR_CALL + PASSES_ARGUMENT/DERIVES_FROM edges | NewExpressionHandler ArgumentExtractor (lines 57-67) |
| `new ns.Foo()` (MemberExpression) | CONSTRUCTOR_CALL, className=Foo | NewExpressionHandler lines 29-32 (className = property.name) |
| `new Foo()` not assigned to var | CONSTRUCTOR_CALL (no ASSIGNED_FROM) | NewExpressionHandler always creates CONSTRUCTOR_CALL regardless of assignment |
| `throw new Error()` | CONSTRUCTOR_CALL | NewExpressionHandler; ThrowHandler handles throw metadata separately |
| `new Promise((res) => ...)` | CONSTRUCTOR_CALL + promiseExecutorContext | NewExpressionHandler lines 71-101 |
| `const x = new Foo()` | VARIABLE + ASSIGNED_FROM → CONSTRUCTOR_CALL | VariableAssignment sourceType='CONSTRUCTOR_CALL' handled in AssignmentBuilder lines 78-96 |

**Critical: Module-level CONSTRUCTOR_CALL gap check**

The `CallExpressionVisitor.handleNewExpression()` had a guard: `if (functionParent) return;` — meaning it **only runs for module-level** new expressions. Removing it means module-level new expressions lose their CALL(isNew) nodes. We must confirm JSASTAnalyzer's traversal covers module-level new expressions for CONSTRUCTOR_CALL creation.

Looking at JSASTAnalyzer lines 1740-1770: this is inside `analyzeFunctionBody()` which handles function-scoped expressions. A separate traversal handles module-level. Need to verify `CallExpressionVisitor`'s `handleNewExpression` removal does NOT leave a gap in module-level CONSTRUCTOR_CALL creation.

**Action:** Before removing `handleNewExpression` from `CallExpressionVisitor`, check the module-level traversal in `JSASTAnalyzer` or wherever module-level code is analyzed. If there's a gap, the module-level CONSTRUCTOR_CALL creation needs to be added to `CallExpressionVisitor` properly (i.e., `CONSTRUCTOR_CALL` type, not `CALL`).

---

## Test Plan

### New tests to write (in `test/unit/ConstructorCallTracking.test.js` or new file)

1. **No CALL(isNew) duplicates:** Assert that for `new Foo()`, no node with `type === 'CALL'` and `isNew === true` exists in the graph. The only node representing the new expression should be `CONSTRUCTOR_CALL`.

2. **Module-level new expressions:** Assert that `const x = new Foo()` at module level produces a `CONSTRUCTOR_CALL` node (not just when inside a function).

3. **CONSTRUCTOR_CALL count equals new expression count:** For a file with 3 new expressions, assert exactly 3 CONSTRUCTOR_CALL nodes and 0 CALL nodes with isNew:true.

4. **Namespaced constructor:** `new ns.Foo()` produces CONSTRUCTOR_CALL with className='Foo', not a CALL with name='ns.Foo'.

### Existing tests to update

- `test/unit/CallExpressionVisitorSemanticIds.test.js` — likely has tests that assert `isNew: true` on CALL nodes or count CALL nodes including constructor calls
- `test/unit/GraphSnapshot.test.js` — snapshot counts will change

---

## Risk Assessment

### High risk: Module-level CONSTRUCTOR_CALL gap

The most dangerous part. `CallExpressionVisitor.handleNewExpression()` is the ONLY place that currently processes module-level new expressions for the CALL pipeline. If we remove it, and JSASTAnalyzer does NOT cover module-level new expressions in its CONSTRUCTOR_CALL creation, module-level `new X()` will produce no call node at all. Must verify coverage before removing.

**Mitigation:** Write a test first (TDD) that asserts CONSTRUCTOR_CALL exists for module-level `new Foo()`, run it, and confirm it's green before touching `CallExpressionVisitor`.

### Medium risk: Snapshot regeneration

59 CALL(isNew) nodes across snapshots need to disappear. Any test checking snapshot node counts will fail. The snapshot tests must be regenerated.

### Low risk: AssignmentBuilder

`AssignmentBuilder` already looks up CONSTRUCTOR_CALL by coordinates (line 84-95) and creates `ASSIGNED_FROM` edges. This path is NOT affected by removing the CALL(isNew) nodes — it uses `NodeFactory.generateConstructorCallId()` which targets the CONSTRUCTOR_CALL node directly.

### Low risk: CallFlowBuilder PASSES_ARGUMENT edges

`CallFlowBuilder.bufferArgumentEdges()` currently resolves argument targets using `callSites.find(c => c.id === callId)` where `callId` is the CONSTRUCTOR_CALL's id (set by `ArgumentExtractor` using `constructorCallId`). This is independent of the CALL(isNew) nodes. The argument extraction in `NewExpressionHandler` correctly uses the `constructorCallId` as the call node. No change needed.

### Low risk: CONTAINS edges

Currently, both CALL(isNew) and CONSTRUCTOR_CALL get CONTAINS edges from their parent scope. After the fix, only CONSTRUCTOR_CALL gets CONTAINS edges. The existing tests in `ConstructorCallTracking.test.js` already test CONTAINS edges on CONSTRUCTOR_CALL nodes and should pass without change.

### Low risk: isNew field removal

No consumer code checks `isNew` on CALL nodes to drive logic (verified by grep — the only uses are in visitors/handlers that emit isNew, and in snapshots). Safe to remove.
