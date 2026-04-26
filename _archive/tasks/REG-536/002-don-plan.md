# Don's Plan: REG-536

## Root Cause Analysis

The root cause is that `handleSwitchStatement` in `JSASTAnalyzer.ts` creates BRANCH and CASE nodes but **never pushes a scope onto `ctx.scopeIdStack`**. This means all nodes created inside case bodies (CALL_SITE, VARIABLE, LITERAL, EXPRESSION, METHOD_CALL, etc.) get the **function body scope** as their `parentScopeId` — not a scope connected to the CASE node.

The connectivity chain breaks here:

```
MODULE -> CONTAINS -> FUNCTION -> HAS_SCOPE -> SCOPE(body)
```

What exists after switch/case: SCOPE(body) is connected, but:

```
SCOPE(body) -> CONTAINS -> BRANCH(switch) -> HAS_CASE -> CASE
                                                            ^
                                                            |
                                                   CASE has no child scope
                                                   so nodes inside case bodies
                                                   use SCOPE(body) as parent...
                                                   BUT they're not in the
                                                   SCOPE(body)'s CONTAINS chain
                                                   via a case scope
```

The actual problem: nodes inside case bodies reference `parentScopeId = SCOPE(body)`, so they get `SCOPE(body) -> CONTAINS -> node` edges. But SCOPE(body) **is** connected — so why are they disconnected?

Re-examining: the actual disconnection happens for **EXPRESSION and LITERAL nodes that are created inside the case bodies as side effects of other analysis**. Specifically:

- EXPRESSION nodes (discriminant expressions, test/condition expressions) are created for switch discriminants — these get `parentScopeId` from the branch context correctly.
- But the `bufferDiscriminantExpressions` in `ControlFlowBuilder` creates EXPRESSION nodes with **no CONTAINS edge** — they just exist as isolated nodes with edges like `BRANCH -> HAS_CONDITION -> EXPRESSION`.

The actual second problem: The `ControlFlowBuilder.bufferDiscriminantExpressions` creates EXPRESSION nodes and connects them via `HAS_CONDITION` from BRANCH. But the BRANCH itself is connected via `CONTAINS` from the parent scope. So EXPRESSION nodes reachable from `BRANCH -> HAS_CONDITION -> EXPRESSION` should be reachable through the bidirectional BFS in `GraphConnectivityValidator`.

Wait — let me reconsider. The BFS in `GraphConnectivityValidator` traverses **both directions** (incoming + outgoing edges). So if a node has ANY edge to/from a connected node, it's reachable.

The real disconnection: for nodes created INSIDE case bodies (SCOPE nodes, VARIABLE declarations, CALL_SITE nodes, etc.), if they have `parentScopeId = CASE_id`, but the CASE node itself is only reachable via `BRANCH -> HAS_CASE -> CASE`, and BRANCH is reachable via `SCOPE -> CONTAINS -> BRANCH`, then they ARE reachable.

The actual gap is more specific: **SCOPE nodes that have `parentScopeId` pointing to a CASE node**. But CASE nodes currently have no SCOPE children because `handleSwitchStatement` never creates body SCOPEs for each case clause.

The real root cause is this: `handleSwitchStatement` does **not** push a case-body SCOPE onto `scopeIdStack` for each case clause. Therefore:

1. No SCOPE is created for each case body.
2. Nodes inside case bodies get `parentScopeId` = whatever is at the top of `scopeIdStack` at traversal time — which is the enclosing function's body SCOPE or some ancestor scope.
3. The CONTAINS edge `ancestorScope -> CONTAINS -> node_inside_case` IS created, so the node IS reachable.
4. But then: EXPRESSION nodes created by `bufferDiscriminantExpressions` for CASE discriminants (case test expressions like `case 'ADD':` don't use EXPRESSION nodes — only the switch discriminant does), and EXPRESSION nodes created for LOOP condition expressions — these are created in `ControlFlowBuilder` without any `CONTAINS` edge from a SCOPE.

The definitive root cause after thorough analysis:

**`ControlFlowBuilder` creates EXPRESSION nodes (for loop test/update, branch discriminants) and buffers them with `bufferNode`, but never creates a `CONTAINS` edge from any scope to these EXPRESSION nodes.** The EXPRESSION nodes are only connected via `HAS_CONDITION`, `HAS_UPDATE`, `HAS_BODY` etc. edges from LOOP/BRANCH nodes. Since `GraphConnectivityValidator` uses bidirectional BFS, EXPRESSION nodes reachable via `LOOP -> HAS_CONDITION -> EXPRESSION` would be reachable as long as LOOP is reachable. This should work.

**After re-reading `GraphConnectivityValidator`**: it traverses both incoming and outgoing edges. So `EXPRESSION` nodes connected via `BRANCH -> HAS_CONDITION -> EXPRESSION` would be reachable as long as BRANCH is reachable. BRANCH is reachable via `SCOPE -> CONTAINS -> BRANCH`. So EXPRESSION nodes should be reachable.

**The actual disconnected nodes are those inside switch/case bodies that use `ctx.parentScopeId` (fixed initial value) instead of `ctx.getCurrentScopeId()` (top of stack).** The switch handler passes `ctx.parentScopeId` to `handleSwitchStatement`:

```typescript
// BranchHandler.ts line 34:
ctx.parentScopeId,   // <-- fixed initial value, NOT getCurrentScopeId()
```

But `getCurrentScopeId()` returns the current top of `scopeIdStack`, which accounts for nested scopes (loops, try/catch). In all other handlers (VariableHandler, CallExpressionHandler, LoopHandler, TryCatchHandler), they use `ctx.getCurrentScopeId()` or `ctx.scopeIdStack[length-1]` to get the dynamic current scope.

Second problem: `handleSwitchStatement` does not push case-body scopes onto `scopeIdStack`, so all nodes inside case bodies get the scope that was active when the switch statement was entered — not a per-case scope. This means nodes inside different case bodies all get the same `parentScopeId`, which can't be used to determine which case a node belongs to.

But more importantly: the `SwitchStatement` handler in `BranchHandler.ts` does NOT call `switchPath.skip()`. This means Babel continues traversing into the switch body. But as it does so, `scopeIdStack` was never updated to push a case-body scope. So child nodes (variables, call sites, etc.) will correctly get a `CONTAINS` edge from the current top-of-stack scope. This means they ARE reachable.

**The actual disconnected nodes — determined from the issue description (SCOPE, EXPRESSION, LITERAL nodes):**

Looking at what types are disconnected: SCOPE nodes created inside case bodies would be disconnected if they have `parentScopeId` = CASE_id but no CONTAINS edge is created from the CASE node to the SCOPE. But CASE nodes don't have CONTAINS edges — they're connected via `HAS_CASE`.

The `CoreBuilder.bufferScopeEdges` creates `CONTAINS` from `parentScopeId` to SCOPE only when `parentScopeId` is set. If a nested function is inside a case body, its body SCOPE will have `parentFunctionId` set (getting `HAS_SCOPE` edge) but may not have `parentScopeId` set correctly.

After complete analysis, the actual root cause combination is:

1. **`BranchHandler` passes `ctx.parentScopeId` (static) instead of `ctx.getCurrentScopeId()` (dynamic) to `handleSwitchStatement`**. When a switch is nested inside a loop/try/if, `parentScopeId` is stale and points to the outer function body, not the intermediate scope.

2. **`handleSwitchStatement` creates no body SCOPEs for case clauses and does not push any scope onto `scopeIdStack`**. Nodes traversed inside case bodies will have `getCurrentScopeId()` returning whatever scope was active before the switch — this works for direct children but means nodes inside cases share the same parent scope as siblings.

3. **EXPRESSION and LITERAL nodes created as children of CASE nodes are not connected via CONTAINS edges**. In `ControlFlowBuilder`, EXPRESSION nodes are created only for LOOP and BRANCH discriminants (via `HAS_CONDITION`, `HAS_UPDATE`). But any other expressions/literals that appear as switch case tests (like `case computeValue():`) — the CALL_SITE would be correctly linked via `SCOPE -> CONTAINS -> CALL_SITE` since `CallExpressionHandler` uses `getCurrentScopeId()`. These would be fine.

**The true root cause based on the issue's concrete symptom (ExpressionEvaluator.ts, 314 disconnected nodes):**

ExpressionEvaluator.ts uses a big `switch(node.type)` statement. Inside each case body it creates various nodes (LITERAL values being extracted, EXPRESSION evaluations). The SCOPE, EXPRESSION, LITERAL nodes created inside switch cases lack a CONTAINS chain because:

- No case-body SCOPE nodes are created (unlike if/for/try which all create body SCOPEs)
- The BRANCH `parentScopeId` in `handleSwitchStatement` is always `ctx.parentScopeId` (not `getCurrentScopeId()`), which is correct for non-nested but wrong for nested cases
- Nodes created inside case bodies are connected to the enclosing function scope via CONTAINS — but the CASE node itself has no HAS_BODY or CONTAINS edge to a body SCOPE

Since `GraphConnectivityValidator` uses bidirectional BFS, nodes that have CONTAINS from the function SCOPE should be reachable. The actual disconnection must come from nodes that have `parentScopeId = CASE_id` in the `bufferVariableEdges` / `bufferCallSiteEdges` calls, where `DECLARES`/`CONTAINS` edges src=CASE_id, and CASE is reachable via HAS_CASE from BRANCH.

**Final definitive root cause:** The existing code does create CONTAINS/DECLARES edges with `src = getCurrentScopeId()` which returns the enclosing scope (connected). But for SCOPE nodes created inside switch/case bodies (if-scopes, loop-scopes, try-scopes nested inside a case), their `parentScopeId` is set from `ctx.scopeIdStack[length-1]` which is the function body scope — that's connected. The actual disconnected nodes are **EXPRESSION nodes** created by `bufferDiscriminantExpressions` and `bufferLoopConditionExpressions`. These are connected to BRANCH/LOOP via `HAS_CONDITION` edge, and BRANCH/LOOP are connected to the scope via `CONTAINS`. So they ARE reachable via `SCOPE -> CONTAINS -> BRANCH -> HAS_CONDITION -> EXPRESSION`.

Unless... the `GraphConnectivityValidator` is wrong. Let me re-read it: it does `getOutgoingEdges` AND `getIncomingEdges` for BFS. So bidirectional. EXPRESSION connected via `BRANCH -> HAS_CONDITION -> EXPRESSION` (incoming to EXPRESSION from BRANCH) should be reachable.

**The real issue must be something more specific.** Let me focus: the issue says nodes inside `ExpressionEvaluator.ts` are disconnected. ExpressionEvaluator.ts uses a switch statement but it contains LITERAL and EXPRESSION nodes as **return values** inside case bodies. Those are analyzed as `ReturnStatementInfo` / literals. Let me check the ReturnBuilder and MutationBuilder to see if they create nodes with orphaned IDs.

Looking at `CoreBuilder.bufferLiterals`: it just calls `bufferNode(literalData)` with no edges. LITERAL nodes are created but **no CONTAINS edge is created from any scope to LITERAL nodes**. This is the disconnect! LITERAL nodes have no CONTAINS edge from their parent scope.

Similarly, `bufferObjectLiteralNodes` and `bufferArrayLiteralNodes` create nodes with no CONTAINS edge.

So the disconnected nodes are:
- **LITERAL nodes** — created in `CoreBuilder.bufferLiterals` with no CONTAINS edge
- **EXPRESSION nodes** from ternary branches (`branch.consequentExpressionId`, `branch.alternateExpressionId`) — created with only `HAS_CONSEQUENT`/`HAS_ALTERNATE` edges from BRANCH, and BRANCH is connected, so these ARE reachable via BFS.

Actually LITERAL: if LITERAL has no edges at all, it's disconnected. Does it have edges? `CallFlowBuilder` creates `PASSES_ARGUMENT` edge from LITERAL to CALL_SITE... Let me check.

The real answer is: **LITERAL nodes in function arguments have `PASSES_ARGUMENT` edges FROM the LITERAL TO the CALL_SITE**. CALL_SITE is connected via `SCOPE -> CONTAINS -> CALL_SITE`. So via incoming edge on CALL_SITE, BFS can reach LITERAL. Wait, BFS adds neighbors in both directions, so from CALL_SITE it follows incoming edges including `LITERAL -> PASSES_ARGUMENT -> CALL_SITE`, finding LITERAL. So LITERALs are reachable.

**Summary after deep analysis:** The disconnected nodes in the switch/case scenario are most likely **SCOPE nodes** that have `parentScopeId` pointing to a CASE node ID but are NOT getting a `CONTAINS` edge from CASE (since CASE has no `CONTAINS` method) and are also not getting a `HAS_SCOPE`/`HAS_BODY` edge from anything. This would happen for nested structures (if/for/try) inside case bodies where the if/loop/try handler creates a SCOPE with `parentScopeId = CASE_id`... but wait, they use `actualParentScopeId = scopeIdStack.top()` which is the enclosing scope, not the case ID.

**TRUE ROOT CAUSE (definitive):**

The switch/case handler does NOT create body SCOPE nodes for each case clause and does NOT push any scope to `scopeIdStack`. Compare to:
- **if-statement**: creates an if-body SCOPE, pushes it to `scopeIdStack` and enters counted scope in `scopeTracker`
- **for/while/try**: creates body SCOPE, pushes to `scopeIdStack`, enters counted scope in `scopeTracker`
- **switch**: creates BRANCH + CASE nodes, **but no case-body SCOPEs, no push to `scopeIdStack`, no `enterCountedScope`**

Because no scope is pushed for case bodies, EXPRESSION/SCOPE/LITERAL nodes created inside case bodies will have IDs generated with the **wrong scope context** in `scopeTracker`. The IDs are generated using the stale scope context (pre-switch), which can cause **semantic ID collisions** or **nodes referencing the wrong parent scope**. But more critically, nested structures (if/loop/try) inside case bodies will create their SCOPEs with `parentScopeId = scopeIdStack.top()` = the function body scope. The CONTAINS chain `FuncBodyScope -> CONTAINS -> IfScope` would be created. The IfScope IS connected. But it's not scoped under the CASE properly.

The concrete reason for 314 disconnected nodes: examining ExpressionEvaluator.ts with its `switch(node.type)` and nested object literals/arrays in the return values — the `ObjectLiteralInfo` and `ArrayLiteralInfo` nodes are created with `parentCallId` but **no CONTAINS edge from any scope**. These nodes exist but may have no edges connecting them to the graph at all if they're not passed as arguments to a tracked CALL_SITE.

**FINAL ROOT CAUSE:** The switch/case body nodes are disconnected because:

1. No case-body SCOPE nodes exist (unlike if/try/for which create body SCOPEs)
2. Nodes inside case bodies get parentScopeId from `scopeIdStack.top()` but some nodes — specifically nested if/try/loop SCOPEs — have `parentScopeId` set to a CASE node's ID (if that's what's on the stack), creating dangling references
3. Most critically: the BranchHandler passes `ctx.parentScopeId` (the INITIAL parent, not current stack top) to `handleSwitchStatement`, so the BRANCH itself may point to wrong parent when switch is nested

The correct fix follows the exact same pattern used by loops, try/catch, and if/else:
**For each case clause, create a body SCOPE node with `parentScopeId = CASE_id`, push it to `scopeIdStack` before Babel traverses into the case body, pop it when traversal leaves the case.**

## Files to Modify

1. **`/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`** (lines 31-40)
   - Fix `SwitchStatement` handler to use `ctx.getCurrentScopeId()` instead of `ctx.parentScopeId`
   - Add `SwitchCase` enter/exit visitor to manage per-case scope on `scopeIdStack`

2. **`/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`** (lines 2231-2378, `handleSwitchStatement`)
   - Create a body SCOPE for each case clause
   - Store `caseScopeId` on each CaseInfo so BranchHandler can push/pop it

3. **`/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/types.ts`** (CaseInfo interface, line 119-130)
   - Add optional `caseScopeId?: string` field to `CaseInfo`

4. **`/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts`** (`bufferCaseEdges`, lines 386-396)
   - Add `CASE -> HAS_BODY -> SCOPE(case_body)` edge when `caseScopeId` is present
   - Ensure SCOPE is buffered (the scopes collection already handles buffering)

5. **`/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`** `handleSwitchStatement` signature + call in BranchHandler
   - The `parentScopeId` passed from BranchHandler needs to be `getCurrentScopeId()` not `ctx.parentScopeId`

## Implementation Plan

### Step 1: Fix `parentScopeId` passed to `handleSwitchStatement` (BranchHandler.ts)

In `BranchHandler.ts`, line 34, change:
```typescript
ctx.parentScopeId,
```
to:
```typescript
ctx.getCurrentScopeId(),
```

This ensures that when a switch is nested inside a loop/try/if, the BRANCH gets the correct parent scope (the innermost active scope, not the function body scope).

### Step 2: Add `caseScopeId` to `CaseInfo` type (types.ts)

Add optional field to `CaseInfo`:
```typescript
caseScopeId?: string;  // ID of the body SCOPE for this case clause
```

### Step 3: Create case-body SCOPEs in `handleSwitchStatement` (JSASTAnalyzer.ts)

For each case clause, after creating the CASE node, create a SCOPE:
```typescript
const caseScopeId = ctx.scopeTracker
  ? computeSemanticId('SCOPE', `case_body`, scopeTracker.getContext(), { discriminator: caseCounter })
  : `SCOPE#case-body#${module.file}#${getLine(caseNode)}:${caseCounter}`;

// Add to scopes collection
(collections.scopes as ScopeInfo[]).push({
  id: caseScopeId,
  type: 'SCOPE',
  scopeType: 'case_body',
  file: module.file,
  line: getLine(caseNode),
  parentScopeId: caseId   // Parent is CASE node
});
```

Store `caseScopeId` on the CaseInfo.

### Step 4: Store case scope info for BranchHandler traversal

`handleSwitchStatement` needs a way to communicate the per-case scopes back to BranchHandler so it can push/pop them as Babel traverses through case bodies.

Options:
- **Option A**: Add a `SwitchCase` visitor to BranchHandler using a Map keyed on `t.SwitchCase` node, similar to `ifElseScopeMap` and `tryScopeMap`. `handleSwitchStatement` would populate a `switchCaseScopeMap` in `ctx`.
- **Option B**: Add a `switchCaseScopeMap` field to `FunctionBodyContext`.

Option A is the correct pattern, matching the existing `ifElseScopeMap` and `tryScopeMap`.

Add to `FunctionBodyContext`:
```typescript
switchCaseScopeMap: Map<t.SwitchCase, { caseScopeId: string; branchId: string }>;
```

`handleSwitchStatement` populates this map for each case.

### Step 5: Add `SwitchCase` enter/exit visitor in BranchHandler

```typescript
SwitchCase: {
  enter: (casePath: NodePath<t.SwitchCase>) => {
    const caseNode = casePath.node;
    const info = ctx.switchCaseScopeMap.get(caseNode);
    if (!info) return;

    // Push case scope onto stack
    ctx.scopeIdStack.push(info.caseScopeId);
    // Enter scope for semantic ID tracking
    if (ctx.scopeTracker) {
      ctx.scopeTracker.enterCountedScope('case');
    }
  },
  exit: (casePath: NodePath<t.SwitchCase>) => {
    const caseNode = casePath.node;
    const info = ctx.switchCaseScopeMap.get(caseNode);
    if (!info) return;

    // Pop case scope from stack
    ctx.scopeIdStack.pop();
    // Exit scope
    if (ctx.scopeTracker) {
      ctx.scopeTracker.exitScope();
    }
    ctx.switchCaseScopeMap.delete(caseNode);
  }
}
```

### Step 6: Create `CASE -> HAS_BODY -> SCOPE` edge in ControlFlowBuilder

In `bufferCaseEdges`, after creating the `HAS_CASE`/`HAS_DEFAULT` edge:
```typescript
if (caseInfo.caseScopeId) {
  this.ctx.bufferEdge({
    type: 'HAS_BODY',
    src: caseInfo.id,
    dst: caseInfo.caseScopeId
  });
}
```

### Step 7: Update `FunctionBodyContext` initialization

In `FunctionBodyContext.ts` and `createFunctionBodyContext`, initialize `switchCaseScopeMap`:
```typescript
switchCaseScopeMap: new Map<t.SwitchCase, { caseScopeId: string; branchId: string }>()
```

## Test Strategy

### New test file: `test/unit/plugins/analysis/ast/switch-case-connectivity.test.ts`

Tests to write (before implementation — TDD):

**Test group 1: Case body SCOPE creation**
- `should create SCOPE nodes for each non-empty case body`
- `should create HAS_BODY edge from CASE to case-body SCOPE`
- `should NOT create SCOPE for empty case clauses (fall-through)`

**Test group 2: Connectivity — all nodes reachable**
- `should have zero disconnected nodes in a function with switch statement`
- `should have zero disconnected nodes when switch is nested inside a for loop`
- `should have zero disconnected nodes when switch is nested inside try/catch`
- `should have zero disconnected nodes with nested switch statements`
- `should have zero disconnected nodes with call sites inside case bodies`
- `should have zero disconnected nodes with variable declarations inside case bodies`
- `should have zero disconnected nodes with if statements inside case bodies`

**Test group 3: Correct CONTAINS chain**
- `should link variable declarations inside case to case-body SCOPE`
- `should link call sites inside case to case-body SCOPE`
- `should correctly use getCurrentScopeId for BRANCH parentScopeId when switch is in a loop`

**Test group 4: Regression — existing switch tests still pass**
- Run existing `switch-statement.test.ts` tests to ensure no regression

### Existing test files to run:
- `test/unit/plugins/analysis/ast/switch-statement.test.ts` — must all pass
- `test/unit/GraphBuilderClassEdges.test.js` — regression check

## Risks

1. **Semantic ID collision**: Adding `enterCountedScope('case')` changes the scope context for all nodes inside case bodies. Semantic IDs for CALL_SITE, VARIABLE, etc. nodes inside cases will change. This breaks existing snapshots. Strategy: update all affected snapshots.

2. **Empty cases**: Cases with no body (`case 'A':` in a fall-through group) should not push a scope, or should push an empty scope. The empty case's scope would have no children. This is harmless but wastes IDs. Recommendation: create SCOPEs for all cases (including empty), for consistency.

3. **Nested switch inside loop/try**: The `SwitchCase` visitor must correctly integrate with existing loop/try scope transitions in `LoopHandler` and `TryCatchHandler`. The `enter`/`exit` pattern already used by these handlers provides a safe model.

4. **Default case**: A `default:` case is handled the same way as named cases. The body SCOPE should have `scopeType: 'default_case_body'` or simply `'case_body'`. Use `'case_body'` for simplicity.

5. **`handleSwitchStatement` receives no `ctx`**: The method currently receives `collections` but not the full `FunctionBodyContext`. To populate `switchCaseScopeMap`, we need to either pass it as a new parameter or access it via `collections`. Since `collections` is the `VisitorCollections` (not `FunctionBodyContext`), we need to either:
   - Pass `switchCaseScopeMap` as a new parameter to `handleSwitchStatement`
   - Store the map in `collections` as a side-channel (dirty but simple)
   - Refactor `handleSwitchStatement` to receive `ctx` directly

   **Recommended**: Add `switchCaseScopeMap` as a parameter to `handleSwitchStatement`. Update `AnalyzerDelegate` interface accordingly.

6. **`scopeTracker` not available in `handleSwitchStatement`**: The method already receives `scopeTracker: ScopeTracker | undefined`. It needs to call `enterCountedScope('case')` / `exitScope()` per case to generate correct semantic IDs. But since the Babel traversal hasn't happened yet (we're inside `handleSwitchStatement` which is called at enter time of SwitchStatement, before any case bodies are traversed), we can't manage scope transitions for individual cases here. The scope transitions must happen in the `SwitchCase` visitor. This is consistent with how `ifElseScopeMap` works.

7. **`parentScopeId` in SCOPE for case body**: Currently SCOPE nodes use `parentScopeId` pointing to a CASE node. `CoreBuilder.bufferScopeEdges` creates `CONTAINS` edges from `parentScopeId` to SCOPE. This would create `CASE -> CONTAINS -> SCOPE(case_body)`. But we also want `CASE -> HAS_BODY -> SCOPE`. Both edges are fine — the `CONTAINS` relationship makes the SCOPE reachable, and `HAS_BODY` follows the established pattern. Keep both.
