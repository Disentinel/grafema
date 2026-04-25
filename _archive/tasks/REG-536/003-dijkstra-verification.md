# Dijkstra Plan Verification: REG-536

**Verdict: CONDITIONAL APPROVE — with required corrections before implementation**

The plan identifies the correct root causes and proposes a structurally sound fix that follows the established patterns of LoopHandler and TryCatchHandler. However, there are several gaps, one architectural inconsistency in the proposed SCOPE parentage, and one critical ordering hazard that must be resolved before implementation begins.

---

## Completeness Tables

### Table 1: Case clause body categories

All possible `SwitchCase` node bodies in the Babel AST:

| Category | `consequent.length` | `test` | Plan handles? | Notes |
|---|---|---|---|---|
| Named case, non-empty body | > 0 | non-null | YES | Standard case |
| Named case, empty body (fall-through) | == 0 | non-null | UNCLEAR | Plan says "create SCOPEs for all cases including empty, for consistency" — but the SwitchCase enter visitor will push an empty scope. This is harmless but wastes IDs. Acceptable per plan. |
| `default:` case, non-empty body | > 0 | null | YES — plan explicitly covers it | Handled identically to named case |
| `default:` case, empty body | == 0 | null | UNCLEAR | Same issue as empty named case — empty scope pushed/popped. Harmless. |
| Switch with zero cases | — | — | YES — loop runs zero iterations | No CASEs created, no scopes pushed. Correct. |
| Switch with only a default, no named cases | > 0 | null | YES | The single case is the default |

**Finding:** The plan's Recommendation 2 (Risk section) says "create SCOPEs for all cases including empty, for consistency." This is internally consistent but inconsistent with the test plan, which says "should NOT create SCOPE for empty case clauses (fall-through)." These two statements directly contradict. Rob must pick one and make the code and tests agree.

**My recommendation:** Skip SCOPE creation for `isEmpty === true` cases. Rationale: pushing a scope and immediately popping it with no nodes inside is pure overhead, and an empty case body has no reachability problem. If the plan intends "create for all," the failing test case must be removed from the test plan.

---

### Table 2: Filter on `ctx.parentScopeId` → `ctx.getCurrentScopeId()` (Step 1)

All contexts in which a SwitchStatement can appear, and whether the fix is correct:

| Context | `ctx.parentScopeId` value | `ctx.getCurrentScopeId()` value | Correct after fix? |
|---|---|---|---|
| Switch at function body top level | function body SCOPE id | function body SCOPE id | YES — no difference, correct |
| Switch nested inside `for` loop | function body SCOPE id (stale) | loop body SCOPE id (current stack top) | YES — fix corrects this |
| Switch nested inside `while` / `do-while` | function body SCOPE id (stale) | loop body SCOPE id | YES |
| Switch nested inside `if` consequent | function body SCOPE id (stale) | if-body SCOPE id | YES |
| Switch nested inside `else` | function body SCOPE id (stale) | else-body SCOPE id | YES |
| Switch nested inside `try` block | function body SCOPE id (stale) | try-body SCOPE id | YES |
| Switch nested inside `catch` block | function body SCOPE id (stale) | catch-body SCOPE id | YES |
| Switch nested inside `finally` block | function body SCOPE id (stale) | finally-body SCOPE id | YES |
| Switch nested inside another switch case body | function body SCOPE id (stale) | case-body SCOPE id (after this fix) | YES — recursive correctness |

**Finding:** The fix to use `ctx.getCurrentScopeId()` is **correct and necessary**. Without it, a switch nested inside any intermediate scope (loop, try, if) creates a BRANCH node whose `parentScopeId` points to the function body rather than the enclosing scope. This causes the BRANCH's CONTAINS edge to be `functionBodyScope -> CONTAINS -> BRANCH` instead of `intermediateScope -> CONTAINS -> BRANCH`. While the BRANCH would still be reachable (the function body scope is always connected), the structural representation is semantically wrong and can break scope-aware analysis.

---

### Table 3: Completeness of `SwitchCase` enter/exit visitor interaction with other handlers

The plan adds a `SwitchCase: { enter, exit }` visitor to `BranchHandler`. Other handlers also react to child nodes of a SwitchStatement:

| Handler | Node type visited | Stack action | Interaction with new SwitchCase visitor |
|---|---|---|---|
| LoopHandler | ForStatement, WhileStatement, etc. | enter: push loop-body SCOPE; exit: pop | Loops inside case bodies: after the proposed fix, they will push on top of the case-body SCOPE. Stack state: `[..., caseScopeId, loopScopeId]`. Correct. |
| TryCatchHandler | TryStatement, CatchClause | enter: push try SCOPE; exit: pop | Try inside case: `[..., caseScopeId, tryScopeId]`. Correct. |
| BranchHandler IfStatement | IfStatement | enter: push if SCOPE; exit: pop | If inside case: `[..., caseScopeId, ifScopeId]`. Correct. |
| BranchHandler BlockStatement | BlockStatement | enter: swap if→else scope or try→finally scope | BlockStatement inside a case body: only triggers if parent is IfStatement (else) or TryStatement (finally). Not triggered for case-body BlockStatements directly. Safe. |
| BranchHandler SwitchStatement | SwitchStatement | calls `handleSwitchStatement` at enter | Nested switch: `handleSwitchStatement` will receive `ctx.getCurrentScopeId()` which is the outer case-body SCOPE. Correct. |
| VariableHandler | VariableDeclaration | uses `ctx.getCurrentScopeId()` | After fix: will use case-body SCOPE. Correct. |
| CallExpressionHandler | CallExpression | uses `ctx.getCurrentScopeId()` | Correct. |

**Finding:** No interaction hazards found between the SwitchCase visitor and existing handlers. The stack discipline (`push on enter` / `pop on exit`) is correctly scoped by Babel's traversal order, which visits `SwitchCase.enter` before any child nodes and `SwitchCase.exit` after all children.

---

### Table 4: Classification of `parentScopeId` on the new case-body SCOPE node

The plan proposes:
```typescript
parentScopeId: caseId   // Parent is CASE node
```

This is then processed by `CoreBuilder.bufferScopeEdges`, which creates:
```
CASE -> CONTAINS -> SCOPE(case_body)
```

Simultaneously, the plan adds in Step 6:
```
CASE -> HAS_BODY -> SCOPE(case_body)
```

Both edges would be created from CASE to the case-body SCOPE:

| Edge | Created by | Rationale |
|---|---|---|
| `CASE -> CONTAINS -> case_body_SCOPE` | `CoreBuilder.bufferScopeEdges` (because `parentScopeId = caseId`) | Structural containment |
| `CASE -> HAS_BODY -> case_body_SCOPE` | `ControlFlowBuilder.bufferCaseEdges` (new code) | Semantic "body" relationship |

**Gap found — architectural inconsistency:** CASE is not a SCOPE node. `CONTAINS` edges in the existing graph schema always originate from SCOPE, MODULE, or FUNCTION nodes. Looking at all existing uses: `SCOPE -> CONTAINS -> FUNCTION`, `SCOPE -> CONTAINS -> BRANCH`, `SCOPE -> CONTAINS -> LOOP`, `SCOPE -> CONTAINS -> CALL_SITE`, `SCOPE -> CONTAINS -> VARIABLE`. A `CASE -> CONTAINS -> SCOPE` edge would be the first `CONTAINS` edge originating from a CASE node. This breaks the schema invariant.

**Compare with established patterns:**
- LOOP → HAS_BODY → loop-body SCOPE, and the loop-body SCOPE has `parentScopeId = loopId`. This creates `LOOP -> CONTAINS -> SCOPE`. **Same schema violation exists for LOOP.** This is already accepted precedent in the codebase.
- TRY_BLOCK → try-body SCOPE: `parentScopeId = tryBlockId`, creates `TRY_BLOCK -> CONTAINS -> SCOPE`. Again the same pattern — pre-existing.

**Conclusion:** The existing code already uses CONTAINS edges from non-SCOPE nodes (LOOP, TRY_BLOCK) to SCOPE nodes. The plan follows this established (if impure) precedent. **This is consistent with existing code.** The schema violation concern is pre-existing and not introduced by this plan.

**However:** Having BOTH `CASE -> CONTAINS -> SCOPE` AND `CASE -> HAS_BODY -> SCOPE` creates a duplicate structural relationship. The `HAS_BODY` edge is the semantically correct one. The `CONTAINS` edge is a side-effect of setting `parentScopeId = caseId`.

**Options:**
1. Set `parentScopeId = undefined` on the case-body SCOPE and rely solely on `HAS_BODY` from CASE. Then the SCOPE has no `CONTAINS` edge from CASE, making it unreachable unless GraphConnectivityValidator traverses `HAS_BODY`. This could disconnect the SCOPE.
2. Keep `parentScopeId = caseId` (current plan) — creates `CONTAINS` from CASE (consistent with LOOP/TRY patterns). Then also add `HAS_BODY`. This means two edges for the same relationship. Redundant but harmless and consistent with precedent.
3. Keep `parentScopeId = caseId`, skip the explicit `HAS_BODY` in `bufferCaseEdges` since `CONTAINS` already covers reachability.

**Recommendation:** Use Option 3 — keep `parentScopeId = caseId` (matching LOOP/TRY_BLOCK precedent exactly), and do NOT add a separate `HAS_BODY` edge in `bufferCaseEdges`. The `CONTAINS` edge from `bufferScopeEdges` is sufficient for connectivity. If `HAS_BODY` is desired for semantic query expressiveness, it can be added as a future graph schema improvement. Adding it now creates redundancy without value.

This means Steps 4 and 6 of the implementation plan can be simplified: `caseScopeId` does NOT need to be stored in `CaseInfo`, and `bufferCaseEdges` requires NO changes. The `CASE -> CONTAINS -> SCOPE` edge from `CoreBuilder.bufferScopeEdges` is enough.

---

### Table 5: Semantic ID correctness for nodes inside case bodies

The plan calls `ctx.scopeTracker.enterCountedScope('case')` in SwitchCase.enter and `exitScope()` in SwitchCase.exit.

| Scenario | Before fix | After fix |
|---|---|---|
| CALL_SITE inside first case | semantic ID generated with switch-level context | semantic ID generated with case[0] context |
| CALL_SITE inside second case | same context as first case (no differentiation) | case[1] context — unique |
| VARIABLE inside case body | switch-level context | case[N] context |
| Nested if inside case body | if scope inside switch-level context | if scope inside case[N] context |

**Gap:** Semantic IDs for ALL nodes inside case bodies will change. This invalidates ALL existing snapshots for any test that contains a switch statement inside a function. The plan acknowledges this (Risk 1) but says only "update all affected snapshots." This is correct — snapshot updates are required and expected. Rob must run the full snapshot update.

**Additional gap — counter naming:** `enterCountedScope('case')` in TryCatchHandler uses `'try'`, `'catch'`, `'finally'`. LoopHandler uses `'for'`, `'for-in'`, etc. The plan uses `'case'` for all case clauses — including the `default:` clause. This means `default:` gets `case[N]` in its semantic ID context rather than `default`. This is a minor inconsistency. Consider using `isDefault ? 'default' : 'case'` as the scope type string for cleaner semantic IDs.

---

### Table 6: `handleSwitchStatement` parameter passing

The plan adds `switchCaseScopeMap` as a new parameter to `handleSwitchStatement`. Current signature:

```typescript
private handleSwitchStatement(
  switchPath: NodePath<t.SwitchStatement>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeTracker: ScopeTracker | undefined,
  controlFlowState?: { branchCount: number; caseCount: number }
): void
```

The call site in BranchHandler:
```typescript
analyzer.handleSwitchStatement(
  switchPath,
  ctx.parentScopeId,      // <-- being changed to ctx.getCurrentScopeId()
  ctx.module,
  ctx.collections,
  ctx.scopeTracker,
  ctx.controlFlowState
);
```

Adding `switchCaseScopeMap` as a parameter means the `AnalyzerDelegate` interface (if it exists) must be updated. Let me check what interface `analyzer` is typed as in BranchHandler:

The plan mentions "Update AnalyzerDelegate interface accordingly" but does not specify which file or what the interface looks like. This is an underspecified change that Rob must identify and implement.

**Precondition unverified:** Rob must locate and update the `AnalyzerDelegate` interface (or equivalent) when adding the `switchCaseScopeMap` parameter.

---

## Gaps Found

### Gap 1: Contradiction between "create SCOPE for all cases" vs. test case "should NOT create SCOPE for empty case clauses"

Risk 2 (plan body) says create for all. Test group 1, third test says do NOT create for empty. These are mutually exclusive. One must be removed before implementation. My recommendation: skip SCOPE for empty cases (`isEmpty === true`). The SwitchCase enter visitor checks `if (!info) return;` — so if no scope is created for empty cases, no push happens. The test case "should NOT create SCOPE for empty case clauses" is then correct and the Risk 2 recommendation must be updated to "do NOT create SCOPE for empty case clauses."

### Gap 2: Missing check for `info` presence before `scopeTracker.enterCountedScope`

In the proposed `SwitchCase.enter`:
```typescript
if (!info) return;
ctx.scopeIdStack.push(info.caseScopeId);
if (ctx.scopeTracker) {
  ctx.scopeTracker.enterCountedScope('case');
}
```

If `info` is undefined (e.g., for an empty case when we decide to skip SCOPE creation), we return early. But if Babel visits a SwitchCase node that has no entry in `switchCaseScopeMap` (e.g., cases from a switch in a DIFFERENT function's nested traversal — which shouldn't happen but is a defensive concern), the early return is correct. This pattern is correct as written.

### Gap 3: `scopeIdStack` out-of-sync risk when Babel raises an exception during traversal

Babel can throw during traversal if a node is malformed. If an exception occurs after `SwitchCase.enter` pushes but before `SwitchCase.exit` pops, the stack becomes permanently out-of-sync for that traversal pass. **This is the same risk that exists for LoopHandler, TryCatchHandler, and IfStatement.** It is a pre-existing systemic risk, not introduced by this plan. No mitigation is needed here specifically, but it is worth noting.

### Gap 4: `handleSwitchStatement` creates CASE nodes BEFORE traversal — scope IDs are pre-allocated

The plan proposes that `handleSwitchStatement` creates the case-body SCOPE nodes (with their IDs) during the `SwitchStatement.enter` phase — before Babel traverses into any of the case bodies. The `switchCaseScopeMap` is populated at this point. Then the SwitchCase visitor uses those pre-allocated IDs when pushing to the stack.

**This is correct** — it mirrors how TryCatchHandler pre-allocates the catch SCOPE ID in `TryStatement.enter` before the `CatchClause` visitor fires. The pattern is proven.

**But there is a subtle ordering issue:** `handleSwitchStatement` is called from `BranchHandler.SwitchStatement` (the simple non-enter/exit form, no exit handler). Babel WILL continue traversing into the switch body after this handler fires. The `SwitchCase.enter` visitor will then fire for each case clause. This ordering is correct.

**However:** The current `SwitchStatement` handler in `BranchHandler` is NOT using enter/exit form — it is a plain function:
```typescript
SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
  analyzer.handleSwitchStatement(...);
}
```

A plain visitor function fires on ENTER. Babel then traverses children, during which `SwitchCase.enter/exit` fires. Then Babel exits the SwitchStatement (no exit handler registered). This is exactly the right behavior. No changes needed to the SwitchStatement registration form.

### Gap 5: `scopeTracker.enterCountedScope` called in `SwitchCase.enter` but NOT in `handleSwitchStatement`

The plan has `handleSwitchStatement` create case-body SCOPE IDs using `computeSemanticId('SCOPE', 'case_body', scopeTracker.getContext(), ...)`. But at the time `handleSwitchStatement` runs, `scopeTracker` has NOT yet entered any case scope — it is still in the enclosing scope's context. So the SCOPE node ID is generated with the pre-case context.

Then, in `SwitchCase.enter`, `scopeTracker.enterCountedScope('case')` is called. The context changes AFTER the SCOPE node was already created and put into `switchCaseScopeMap`.

This means the SCOPE node's ID (generated before `enterCountedScope`) and the semantic IDs of nodes inside the case body (generated after `enterCountedScope`) use DIFFERENT contexts. **This is a semantic ID inconsistency.**

**Compare with the established pattern for loops:** In LoopHandler, the loop-body SCOPE is created and its ID is generated with `generateSemanticId('for-loop', ctx.scopeTracker)`, which calls `scopeTracker.enterCountedScope` and then `exitScope` inside `generateSemanticId` (or a similar wrapper). Let me verify what `generateSemanticId` does:

The LoopHandler calls `analyzer.generateSemanticId(scopeType, ctx.scopeTracker)` to get the SCOPE's semantic ID. This likely calls `enterCountedScope` internally. Then after creating the SCOPE, it calls `ctx.scopeTracker.enterCountedScope(trackerScopeType)` again for children.

This suggests the pattern for case-body SCOPEs should follow suit: generate the SCOPE's semantic ID using a call to `generateSemanticId` (not raw `computeSemanticId`), and separately push the scope for children.

**The plan's proposed ID generation code:**
```typescript
const caseScopeId = ctx.scopeTracker
  ? computeSemanticId('SCOPE', 'case_body', scopeTracker.getContext(), { discriminator: caseCounter })
  : `SCOPE#case-body#${module.file}#${getLine(caseNode)}:${caseCounter}`;
```

This uses `computeSemanticId` directly with `getContext()` (current context before entering any case scope). If `generateSemanticId` internally does enter+generate+exit, then `handleSwitchStatement` would need to call something similar for each case in sequence. But since `handleSwitchStatement` processes ALL cases in a loop (not one at a time as Babel visits them), it cannot rely on Babel's traversal ordering for scope context.

**This is the most significant correctness gap.** The SCOPE node's ID generated in `handleSwitchStatement` will NOT match what `enterCountedScope('case')` in `SwitchCase.enter` would produce, because the counter advances at different times.

**Required resolution:** Rob must decide between two valid approaches:

**Approach A (simpler):** Use legacy-style IDs for case-body SCOPEs (line-based), the same way TryCatchHandler generates try/catch scope IDs with the `SCOPE#try-block#file#line:counter` pattern. This avoids the semantic ID context mismatch entirely. The nodes inside the case body use semantic IDs (via `enterCountedScope` in the SwitchCase visitor), but the SCOPE container itself uses a legacy ID. This is consistent with TryCatchHandler's `tryScopeId = 'SCOPE#try-block#${file}#${line}:${counter}'`.

**Approach B (complex):** Move case SCOPE creation OUT of `handleSwitchStatement` and INTO the `SwitchCase.enter` visitor, after `enterCountedScope('case')` has been called. This matches how LoopHandler creates the body SCOPE inside the loop's enter handler (after all IDs are in the right context). This approach eliminates `handleSwitchStatement` creating case SCOPEs entirely — it only creates the BRANCH and CASE nodes (as it does now). The case-body SCOPE creation moves to `SwitchCase.enter`. The `switchCaseScopeMap` only needs to store the CASE node's ID (already in `collections.cases`) — the SwitchCase visitor can look it up by matching the Babel SwitchCase node to the CaseInfo by line number.

**My recommendation: Approach B.** It produces semantically correct IDs, follows LoopHandler's pattern more closely, and eliminates the need for `caseScopeId` in `CaseInfo` (the SCOPE ID is not pre-computed). The lookup of CaseInfo by line number is straightforward since each `t.SwitchCase` node has a start position.

### Gap 6: `FunctionBodyContext` missing `switchCaseScopeMap` initialization

The plan says add `switchCaseScopeMap: new Map<t.SwitchCase, { caseScopeId: string; branchId: string }>()` to `FunctionBodyContext`. This requires:
1. Adding the field declaration to the `FunctionBodyContext` interface in `FunctionBodyContext.ts`
2. Initializing it in `createFunctionBodyContext` (return object)

Both are explicitly listed in the plan (Steps 4 and 7). However, `FunctionBodyContext` does NOT currently have `switchCaseScopeMap`. **The plan is complete on this point.** Rob must add it to both the interface and the factory.

### Gap 7: `handleSwitchStatement` signature change and the `AnalyzerDelegate` interface

The plan proposes adding `switchCaseScopeMap` as a parameter to `handleSwitchStatement`. The method is `private` on the analyzer class. The `BranchHandler` accesses it via `this.analyzer`. The type of `this.analyzer` in `BranchHandler` must be checked to ensure it exposes `handleSwitchStatement`.

If `analyzer` is typed as `JSASTAnalyzer` directly, adding a parameter is straightforward. If it is typed via an interface (e.g., `AnalyzerDelegate`), that interface must be updated. The plan acknowledges this ("Update AnalyzerDelegate interface accordingly") but does not specify the file. Rob must find it.

---

## Precondition Issues

### Precondition 1: `ctx.getCurrentScopeId()` returns the right value when BranchHandler.SwitchStatement fires

`getCurrentScopeId()` returns `scopeIdStack[scopeIdStack.length - 1]`. The stack is initialized with `[parentScopeId]` (the function body scope). As loops, ifs, and try blocks are entered, they push their SCOPEs. When `SwitchStatement` fires, the stack top is the innermost active scope. This is correct.

**Verified:** `createFunctionBodyContext` line 206: `const scopeIdStack: string[] = [parentScopeId]`. The initial value is always the function body scope. All handlers that create intermediate scopes push/pop correctly. `getCurrentScopeId()` is therefore always valid when any visitor fires.

### Precondition 2: The `SwitchCase.enter` visitor fires for EACH case clause, in order, including the default clause

**Verified from Babel documentation and behavior:** Babel visits `SwitchCase` nodes for ALL cases in a switch statement — named and default. The `caseNode.test === null` check identifies the default case. Babel fires `SwitchCase.enter` before visiting children of each case, and `SwitchCase.exit` after. This is guaranteed behavior.

### Precondition 3: `switchCaseScopeMap` is populated before `SwitchCase.enter` fires

The `SwitchStatement` handler (plain function, fires on enter) calls `handleSwitchStatement`, which populates `switchCaseScopeMap`. Babel then traverses into the switch body, firing `SwitchCase.enter` for each case. Since `SwitchStatement.enter` fires before any child is visited, the map is always populated before `SwitchCase.enter` fires.

**Verified:** This is the same guarantee that TryCatchHandler relies on — `TryStatement.enter` sets up `tryScopeMap` before `CatchClause.enter` fires.

### Precondition 4: Exactly one `pop()` for each `push()` on `scopeIdStack` across case boundaries

Each `SwitchCase.enter` pushes exactly one scope. Each `SwitchCase.exit` pops exactly one scope. There are no "scope swap" operations needed between case clauses (unlike try→catch, where the pop/push swap happens in BlockStatement or CatchClause visitors). Each case clause is a separate, independent SwitchCase node in Babel's AST.

**Verified:** Unlike if/else (which has a single IfStatement node with consequent and alternate, requiring scope-swapping in BlockStatement.enter), switch cases are individual SwitchCase nodes. Babel visits them as siblings: `SwitchCase[0].enter`, children, `SwitchCase[0].exit`, `SwitchCase[1].enter`, children, `SwitchCase[1].exit`, etc. The push/pop pairs are correctly balanced.

### Precondition 5: `bufferScopeEdges` in `CoreBuilder` creates `CASE -> CONTAINS -> SCOPE(case_body)` correctly

`bufferScopeEdges` processes every SCOPE in `data.scopes`. For each scope with `parentScopeId` set, it creates `{ type: 'CONTAINS', src: parentScopeId, dst: scope.id }`. If `caseScopeId`'s `parentScopeId` is set to the CASE node's ID, this creates `CASE -> CONTAINS -> SCOPE(case_body)`.

**Verified:** This works mechanically. The concern is whether CASE nodes are recognized as valid CONTAINS edge sources by the graph database. This is a runtime concern, not a static concern — the schema validation (if any) in RFDB must accept CASE as a CONTAINS source. This is **unverified** by the plan. If RFDB enforces `CONTAINS` only from SCOPE/MODULE/FUNCTION, this will fail at runtime. Rob must check the RFDB schema for edge source constraints.

---

## Summary of Required Actions Before Implementation

1. **Resolve contradiction:** Choose between "create SCOPE for empty cases" OR "skip SCOPE for empty cases." Remove the contradictory option from both the plan text and the test cases.

2. **Resolve semantic ID generation approach:** Use either Approach A (legacy SCOPE IDs in `handleSwitchStatement`) or Approach B (SCOPE creation in `SwitchCase.enter`). Approach B is recommended for semantic correctness.

3. **Verify RFDB schema:** Confirm that `CONTAINS` edges are permitted from CASE nodes, or adjust the approach to use only `HAS_BODY` edges (and ensure GraphConnectivityValidator traverses them).

4. **Locate AnalyzerDelegate interface:** Identify the file and update the method signature before adding the parameter.

5. **Consider using `isDefault ? 'default' : 'case'` as the `enterCountedScope` type string** for cleaner semantic IDs on `default:` clauses.

---

## Answers to Key Questions

**Q1: Does the plan handle EMPTY case bodies correctly (fall-through cases)?**
Partially. The plan contradicts itself — Risk 2 says create SCOPE for all cases, but Test group 1, test 3 says do not create for empty. This must be resolved. My verdict: skip SCOPEs for empty cases.

**Q2: Does the plan handle the `default:` case correctly?**
Yes. The plan treats `default:` identically to named cases for SCOPE creation purposes. The `isDefault` flag on `CaseInfo` is already present and used for `HAS_DEFAULT` vs `HAS_CASE` edge type. No gap here.

**Q3: Does creating a scope for case bodies change semantic IDs for nodes inside them? Is this OK?**
Yes, all semantic IDs for nodes inside case bodies will change. This breaks existing snapshots. It is acceptable — snapshot updates are the correct response. The plan acknowledges this.

**Q4: Does the plan handle switch nested inside switch?**
Yes. After the fix, the outer case-body SCOPE is on the stack when `SwitchStatement` (inner) fires. The inner switch's `handleSwitchStatement` will receive `ctx.getCurrentScopeId()` = outer case-body SCOPE. The inner switch's cases will then push their own case-body SCOPEs on top. The stack correctly represents the nesting.

**Q5: Does the SwitchCase visitor interact correctly with LoopHandler's enter/exit scope?**
Yes. See Table 3. The visitors are independent and each manages their own push/pop pair. They compose correctly because each uses the same `scopeIdStack` and the stack discipline is maintained.

**Q6: Is the `parentScopeId` fix (`ctx.parentScopeId` → `ctx.getCurrentScopeId()`) correct and complete?**
Yes, it is correct. It is also complete — there is no other location in BranchHandler that uses `ctx.parentScopeId` for the switch case. However, there is a pre-existing use of `ctx.parentScopeId` in TryCatchHandler for `CATCH_BLOCK.parentScopeId` (line 99) and `FINALLY_BLOCK.parentScopeId` (line 135). These are pre-existing issues outside the scope of REG-536.

**Q7: Does `bufferScopeEdges` create a CONTAINS edge from CASE to case-body SCOPE correctly?**
Mechanically yes, given `parentScopeId = caseId`. Whether the graph database accepts `CONTAINS` from CASE is unverified.

**Q8: Is there a risk of `scopeIdStack` getting out of sync if Babel skips some nodes?**
The `if (!info) return;` guard in the SwitchCase visitor means: if a SwitchCase node has no entry in `switchCaseScopeMap`, we return without pushing. This could happen if `handleSwitchStatement` fails to populate the map for some case (e.g., due to a thrown exception). In normal operation, all SwitchCase nodes within a given SwitchStatement will have entries. The `ctx.switchCaseScopeMap.delete(caseNode)` in exit is a cleanup measure — it does not affect the pop. The pop happens unconditionally (after the `if (!info) return` — wait, actually, if `info` is undefined in exit, we also return before popping).

**This is a stack balance bug in the plan's proposed SwitchCase.exit:**

```typescript
exit: (casePath: NodePath<t.SwitchCase>) => {
  const caseNode = casePath.node;
  const info = ctx.switchCaseScopeMap.get(caseNode);
  if (!info) return;   // <-- returns WITHOUT popping

  ctx.scopeIdStack.pop();
  ctx.scopeTracker?.exitScope();
  ctx.switchCaseScopeMap.delete(caseNode);
}
```

If `info` is undefined in `exit` but was defined when `enter` ran and pushed, the pop never happens. The map entry is deleted in `enter` (or should it only be deleted in `exit`?). Actually, the plan only deletes in `exit`. So if enter ran (pushed), and then exit runs but `map.get` returns undefined... that cannot happen unless the map was externally modified between enter and exit. **In practice this is safe.** But the pattern of "check map in exit to decide whether to pop" means the pop is conditional on the map lookup, which introduces a logical dependency. The simpler pattern used by LoopHandler (unconditional pop in exit, no map lookup) is more robust. Consider using a per-case boolean flag or simply rely on the fact that if enter ran to completion (pushed), exit will always pop.

**Safest fix:** Store a stack of `caseScopeId`s pushed (or simply rely on the established pattern: if enter pushed, exit always pops unconditionally). The `switchCaseScopeMap.delete` cleanup is fine to keep.

---

**Final verdict: CONDITIONAL APPROVE.** The structural direction is correct and the fix is necessary. Gaps 1 (contradiction on empty cases), 5 (semantic ID generation ordering), and the stack balance issue in exit must be resolved in the implementation. Gaps 3 and 4 are preparatory checks Rob must perform. All other items are clarifications that improve robustness.
