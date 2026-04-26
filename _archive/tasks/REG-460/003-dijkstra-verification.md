# REG-460: Dijkstra Plan Verification Report

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-24
**Subject:** Don's refactoring plan for JSASTAnalyzer.ts

---

## VERDICT: CONDITIONAL APPROVE

The plan is structurally sound and the dependency analysis is correct in the large. However, I found seven issues that Rob must address before or during implementation. None of them block approval, but all of them will cause incorrect behavior or broken tests if ignored.

---

## 1. Input Universe — All Callers of Each Method

I gripped every call site via `analyzer.methodName` across the entire `ast/` directory.

### Delegate methods: caller enumeration

| Method | Called By | Don Mentioned? |
|--------|-----------|----------------|
| `handleVariableDeclaration` | `VariableHandler.ts:25` | Yes (via VariableHandler) |
| `detectVariableReassignment` | `VariableHandler.ts:73` | Yes |
| `detectIndexedArrayAssignment` | `VariableHandler.ts:84` | Yes |
| `detectObjectPropertyAssignment` | `VariableHandler.ts:103` | Yes |
| `handleSwitchStatement` | `BranchHandler.ts:32` | Yes |
| `countLogicalOperators` | `BranchHandler.ts:63`, `BranchHandler.ts:224` | Yes — but Don lists only "BranchHandler" generically. Actual call count: 2 distinct call sites in the same file. Not a gap, just noting. |
| `extractDiscriminantExpression` | `BranchHandler.ts:97`, `BranchHandler.ts:240`, `LoopHandler.ts:162`, `LoopHandler.ts:185`, `LoopHandler.ts:212` | **PARTIAL GAP** — Don only mentions BranchHandler as the caller. LoopHandler is also a caller at 3 distinct points. See Issue #1 below. |
| `generateSemanticId` | `BranchHandler.ts:138,172,369`, `NestedFunctionHandler.ts:43,90,150`, `TryCatchHandler.ts:64,106,141`, `LoopHandler.ts:267` | Don says "can be removed from the delegate after extraction." But LoopHandler calls `generateSemanticId` — this is NOT mentioned in Don's plan. See Issue #2 below. |
| `generateAnonymousName` | `NestedFunctionHandler.ts:23,70,127` | Yes |
| `extractReturnExpressionInfo` | `ReturnYieldHandler.ts:73,131`, `NestedFunctionHandler.ts:180` | Yes — Don lists ReturnYieldHandler. But `NestedFunctionHandler.ts:180` is an additional caller for arrow functions with expression bodies. Don's Group 6 says "both call sites use the free function" but does not specifically enumerate NestedFunctionHandler. Not a gap per se, but Rob needs to update that call site too. |
| `analyzeFunctionBody` | `NestedFunctionHandler.ts:61,108,168` | Yes |
| `collectUpdateExpression` | `PropertyAccessHandler.ts:25` | **GAP** — Don says this has "no deps from JSASTAnalyzer." He does not enumerate the caller. Don places it in Group 2 (mutation detection). But the caller is `PropertyAccessHandler`, not a mutation-related handler. If Rob re-reads Don's plan looking for callers of `collectUpdateExpression`, he will only find the inline traversal block in `analyzeModule`. `PropertyAccessHandler` is missing from the caller list. See Issue #3 below. |
| `handleCallExpression` | `CallExpressionHandler.ts:27` | Yes |
| `microTraceToErrorClass` | `CallExpressionHandler.ts:238,323`, `ThrowHandler.ts:78` | **PARTIAL GAP** — Don does not mention ThrowHandler as a caller of `microTraceToErrorClass`. Don only says "the delegate entry disappears." If Rob scans only for delegate removal, ThrowHandler will still reference the old delegate interface. See Issue #4 below. |
| `collectCatchesFromInfo` | Called in `analyzeFunctionBody` directly (not via delegate!) | Correct — this is a direct `this.` call within `analyzeFunctionBody`, not a handler call. Don correctly identifies it as a post-traverse call. |
| `memberExpressionToString` | `LoopHandler.ts:63` | Yes |
| `extractVariableNamesFromPattern` | `TryCatchHandler.ts:241`, `ImportExportVisitor.ts:268`, `VariableVisitor.ts:198` (passed as callback) | Don notes `extractVariableNamesFromPattern` should remain in the delegate (last entry). However, **Don does not mention** that `TryCatchHandler.ts:241` calls it for extracting catch-clause parameter names. See Issue #5 below. |

### Non-delegate methods: caller enumeration

| Method | Called By (inside JSASTAnalyzer) | Called By (outside JSASTAnalyzer) |
|--------|----------------------------------|-----------------------------------|
| `trackVariableAssignment` | `handleVariableDeclaration` (internal), also self-recursively | `VariableVisitor` (via callback at line 1800), `ClassVisitor` (via callback at lines 209, 640, 1021), `analyzeModule` inline traversal (line 1982 via ClassVisitor, line 1800 via VariableVisitor) |
| `extractObjectProperties` | `trackVariableAssignment` (mutual recursion) | None (private) |
| `extractVariableNamesFromPattern` | `handleVariableDeclaration` (line 2423), `analyzeModule` inline blocks | `ImportExportVisitor`, `VariableVisitor`, `TryCatchHandler`, `ClassVisitor` |

**Critical finding for `trackVariableAssignment`**: This method is passed as a bound callback to BOTH `VariableVisitor` AND `ClassVisitor`. Don's plan mentions only `VariableVisitor`. `ClassVisitor` at lines 209, 640, and 1021 calls `this.trackVariableAssignment(...)`. After extraction, the wrapper `this.trackVariableAssignment.bind(this)` must remain so that `ClassVisitor` continues to work. Don does address this in the "Implementation Notes for Rob" section (thin wrappers), but does not mention ClassVisitor explicitly.

---

## 2. Dependency Completeness Table

### Group 1: Expression Helpers

| Method | Internal Calls | External Dependencies |
|--------|---------------|----------------------|
| `extractOperandName` | none | `@babel/types` |
| `memberExpressionToString` | none | `@babel/types` |
| `countLogicalOperators` | none | `@babel/types` |
| `extractCaseValue` | none | `@babel/types` |
| `caseTerminates` | `blockTerminates` | `@babel/types` |
| `blockTerminates` | none | `@babel/types` |
| `unwrapAwaitExpression` | `unwrapAwaitExpression` (recursive) | `@babel/types` |
| `extractCallInfo` | none | `@babel/types` |
| `isCallOrAwaitExpression` | `unwrapAwaitExpression` | `@babel/types` |

Verdict: Don's dependency list for Group 1 is **COMPLETE**. No hidden dependencies.

### Group 2: Mutation Detection

| Method | Internal Calls | External Dependencies |
|--------|---------------|----------------------|
| `detectArrayMutationInFunction` | none | `@babel/types`, `ArrayMutationInfo`, `ScopeTracker` |
| `detectIndexedArrayAssignment` | none | `@babel/types`, `ScopeTracker`, `VisitorCollections` |
| `detectObjectPropertyAssignment` | `extractMutationValue` | `@babel/types`, `ScopeTracker`, `PropertyAssignmentInfo`, `ObjectMutationInfo` |
| `extractMutationValue` | none | `@babel/types`, `ExpressionEvaluator` |
| `detectObjectAssignInFunction` | none | `@babel/types`, `ExpressionEvaluator`, `ObjectMutationInfo`, `ScopeTracker` |
| `detectVariableReassignment` | none | `@babel/types`, `ScopeTracker`, `VariableReassignmentInfo` |
| `collectUpdateExpression` | none | `@babel/types`, `ScopeTracker`, `UpdateExpressionInfo` |

Verdict: **COMPLETE** for internal deps. But see Issue #3 (PropertyAccessHandler as caller of `collectUpdateExpression`).

### Group 3: Variable Assignment Tracking

| Method | Internal Calls | External Dependencies |
|--------|---------------|----------------------|
| `trackVariableAssignment` | `extractObjectProperties`, `trackVariableAssignment` (recursive) | `@babel/types`, `ExpressionEvaluator`, `ObjectLiteralNode`, `ArrayLiteralNode`, `ExpressionNode`, `getLine`, `getColumn` |
| `extractObjectProperties` | `trackVariableAssignment`, `extractObjectProperties` (recursive) | `@babel/types`, `ObjectLiteralNode`, `ExpressionEvaluator` |
| `trackDestructuringAssignment` | `isCallOrAwaitExpression`, `unwrapAwaitExpression`, `extractCallInfo`, `ExpressionNode` | `@babel/types`, Group 1 functions |

Verdict: **COMPLETE** — mutual recursion is correctly identified. Don's proposal to co-locate them in one file is correct.

**Key addition:** `trackDestructuringAssignment` uses `ExpressionNode.generateId(...)` directly (not via JSASTAnalyzer). This is an external node factory, not a JSASTAnalyzer method, so it's already resolvable via import. Not a gap.

### Group 4: Declaration Handlers

| Method | Internal Calls | External Dependencies |
|--------|---------------|----------------------|
| `handleVariableDeclaration` | `extractVariableNamesFromPattern`, `trackVariableAssignment`, `trackDestructuringAssignment`, `classInstantiations.push` (direct mutation) | Group 1, Group 3, `computeSemanticId`, `ExpressionEvaluator` |
| `handleSwitchStatement` | `extractDiscriminantExpression`, `caseTerminates`, `extractCaseValue`, `computeSemanticId` | Group 1, `ScopeTracker`, `VisitorCollections` |
| `extractDiscriminantExpression` | `extractOperandName`, `memberExpressionToString` | Group 1, `@babel/types`, `ExpressionNode` |

Verdict: **COMPLETE** internally. Ordering dependency on Groups 1 and 3 is correctly stated.

### Group 5: Call Expression Handler

| Method | Internal Calls | External Dependencies |
|--------|---------------|----------------------|
| `handleCallExpression` | `detectArrayMutationInFunction`, `detectObjectAssignInFunction`, `extractMethodCallArguments`, `computeSemanticId` | Group 2, `@babel/types`, `ScopeTracker`, `ArgumentExtractor`, `ConstructorCallNode` |
| `extractMethodCallArguments` | none (self-contained) | `@babel/types`, `ExpressionEvaluator`, `ScopeTracker`, `CallArgumentInfo` |

Verdict: **COMPLETE** internally. Don's note about parameter reduction after Group 2 extraction is accurate.

### Group 6: Return/Catch/Trace Extractors

| Method | Internal Calls | External Dependencies |
|--------|---------------|----------------------|
| `extractReturnExpressionInfo` | none (pure AST transformation) | `@babel/types`, `ExpressionNode`, `ExpressionEvaluator`, `getLine`, `getColumn` |
| `collectCatchesFromInfo` | none (pure AST traversal) | `@babel/types`, `NodeFactory` or similar |
| `microTraceToErrorClass` | `funcPath.traverse` (internal Babel API, not a JSASTAnalyzer method) | `@babel/types`, `@babel/traverse` |
| `attachControlFlowMetadata` | none | `FunctionBodyContext` fields directly |

Verdict: **COMPLETE** internally. Note: `attachControlFlowMetadata` does NOT appear in the AnalyzerDelegate interface — it's a private method called directly from `analyzeFunctionBody` as `this.attachControlFlowMetadata(ctx)`. Don correctly keeps it as a potential stay-or-extract. It has no delegate exposure.

---

## 3. Circular Dependency Check

### Confirmed Circular: trackVariableAssignment ↔ extractObjectProperties

Proof by code:
- `trackVariableAssignment` line 657: `this.extractObjectProperties(...)`
- `extractObjectProperties` line 1156: `this.extractObjectProperties(...)` (self-recursive)
- But does `extractObjectProperties` call `trackVariableAssignment`?

Reading `extractObjectProperties` carefully (lines 1083–1224): it calls `this.extractObjectProperties(...)` recursively for nested ObjectExpressions, but does NOT call `trackVariableAssignment`. The mutual dependency is ONE-DIRECTIONAL: `trackVariableAssignment` → `extractObjectProperties` → `extractObjectProperties` (self).

**Correction to Don's plan:** Don says "trackVariableAssignment calls extractObjectProperties; extractObjectProperties calls trackVariableAssignment recursively for nested objects." The second half is INCORRECT. `extractObjectProperties` never calls `trackVariableAssignment`. It only calls itself recursively. This is a less severe circular dependency than stated — it's actually a one-way dependency with self-recursion.

**Impact on extraction:** Don's conclusion (extract together into one file) remains correct regardless. Both must be co-located because `trackVariableAssignment` imports `extractObjectProperties`. But the reasoning in the plan is factually wrong.

### Other potential circulars:

`trackDestructuringAssignment` → `isCallOrAwaitExpression` → `unwrapAwaitExpression`: this is a linear dependency chain, not circular.

`detectObjectPropertyAssignment` → `extractMutationValue`: one-way, not circular.

No other circular dependencies found among the methods being extracted.

---

## 4. Collection Mutation Safety

### allCollections aliasing in analyzeModule (lines 1872–1957 inline block)

Don identifies this risk (Phase 8, Medium Risk). Let me enumerate EVERY pattern that uses both the local variable and the `allCollections` reference:

**Line 1931–1936:** `allCollections.variableReassignments` — checked for existence, then cast to local array, then passed to `this.detectVariableReassignment`. This pattern initializes via `allCollections.X` (not the local variable).

**Line 1943:** `this.detectIndexedArrayAssignment(..., arrayMutations, ...)` — uses the local `arrayMutations` array (initialized at line 1736). This is SAFE — local variable and allCollections point to the same array instance (allCollections.arrayMutations = arrayMutations at line 1820-ish).

**Line 1946–1956:** `allCollections.propertyAssignments` — lazy-initialized via allCollections, not via a local variable. This is the aliasing risk Don mentions. If Rob extracts the inline block into a visitor class, the new visitor will need to receive `allCollections` (not just local `propertyAssignments`) because `propertyAssignments` is lazy-initialized.

**Verdict:** Don's aliasing concern is real, and the mitigation (extract functions receive typed collection arrays not the whole Collections object) is correct in principle. But the lazy-initialized collections (`propertyAssignments`, `variableReassignments`) require either (a) pre-initializing them before the inline blocks, or (b) passing `allCollections` to the new visitors. Rob must choose one approach and apply it consistently.

### Collection ref safety when passing to extracted functions

For methods receiving a typed array directly (e.g., `detectVariableReassignment(assignNode, module, variableReassignments, scopeTracker)`): the typed array IS the same object as `allCollections.variableReassignments` because of the aliasing established when `allCollections` is built. Pushes to the typed array are visible via `allCollections`. This is safe.

---

## 5. Delegate Interface Verification

Reading `AnalyzerDelegate.ts` (lines 36–207), I count the following exposed methods:

1. `handleVariableDeclaration` ✓ in delegate
2. `detectVariableReassignment` ✓ in delegate
3. `detectIndexedArrayAssignment` ✓ in delegate
4. `detectObjectPropertyAssignment` ✓ in delegate
5. `extractReturnExpressionInfo` ✓ in delegate
6. `microTraceToErrorClass` ✓ in delegate
7. `handleSwitchStatement` ✓ in delegate
8. `generateAnonymousName` ✓ in delegate
9. `generateSemanticId` ✓ in delegate
10. `analyzeFunctionBody` ✓ in delegate — Don correctly says this stays
11. `collectUpdateExpression` ✓ in delegate
12. `countLogicalOperators` ✓ in delegate
13. `handleCallExpression` ✓ in delegate
14. `collectCatchesFromInfo` ✓ in delegate
15. `memberExpressionToString` ✓ in delegate
16. `extractDiscriminantExpression` ✓ in delegate
17. `extractVariableNamesFromPattern` ✓ in delegate

**Don lists 16 delegate-exposed methods** in Phase 1. I count 17 in `AnalyzerDelegate.ts`. The discrepancy: `extractVariableNamesFromPattern` appears in the delegate (line 202–206) but Don's Phase 1 table says "No (delegates to util)." Don then correctly notes in Phase 7 that it should remain in the delegate. The table in Phase 1 is inconsistent with the actual interface.

**Verified: all delegate entries CAN switch to free function import given the extracted callers have access to required parameters** — all handlers receive `ctx` and `module` which contain everything needed.

---

## 6. Ordering Verification

Don's proposed step order:
```
1 (expression-helpers) → 2 (mutation-detection) → 3 (VariableAssignmentTracker) →
4+5 (switch/varDecl handlers) → 6 (return/catch/trace) →
8 (CallExpression handler) → 9 (inline traversals → visitors) → 10 (delegate cleanup)
```

**Step 6 dependency check:** Don says Group 6 depends on Group 1 only. Let me verify:
- `extractReturnExpressionInfo`: needs `getLine`, `getColumn`, `ExpressionEvaluator`, `ExpressionNode`. None of these are JSASTAnalyzer methods. Group 1 not actually needed. Can be extracted at ANY step.
- `collectCatchesFromInfo`: does a Babel `funcPath.traverse()` with inline handlers checking call sites. No JSASTAnalyzer methods called within.
- `microTraceToErrorClass`: calls `funcPath.traverse()` inline. No JSASTAnalyzer methods.
- `attachControlFlowMetadata`: accesses `FunctionBodyContext` fields directly. No JSASTAnalyzer methods.

**Correction:** Group 6 has NO dependency on Group 1 or any other group. Don's Step 6 can be executed at STEP 1 if desired. Not a blocking issue — Don's ordering is safe (a superset of the constraints) — but implementors should know they have flexibility here.

**Step 8 (CallExpression) dependency check:** Don says it depends on Groups 1 and 2. Verifying `handleCallExpression` body (lines 3404–3626): it calls `detectArrayMutationInFunction` and `detectObjectAssignInFunction` (Group 2 methods) as side effects via `this.`. Without Group 2 extraction, `handleCallExpression` cannot call them as free functions. **Ordering constraint is correct.**

**Step 9 (inline traversals) dependency check:** Don says these depend on Groups 1–8. Let me check each:

- 7a (AssignmentExpression traversal): calls `this.detectVariableReassignment`, `this.detectIndexedArrayAssignment`, `this.detectObjectPropertyAssignment` (Group 2) and `this.analyzeFunctionBody` (stays). Depends on Group 2. ✓
- 7b (UpdateExpression traversal): calls `this.collectUpdateExpression` (Group 2). Depends on Group 2. ✓
- 7c (Callback traversal): calls `this.generateAnonymousName`, `this.analyzeFunctionBody`, `computeSemanticId`. `generateAnonymousName` is Group ID-gen (stays). No cross-group deps. Can be extracted after Group 1 really.
- 7d (NewExpression traversal): calls `ArgumentExtractor.extract`, `ConstructorCallNode.generateId`, `ConstructorCallNode.isBuiltinConstructor`. None of these are JSASTAnalyzer methods. Can be extracted at ANY step.
- 7e (IfStatement traversal): calls `this.generateSemanticId`, `ConditionParser.parse`. Both are either staying or are Group ID-gen. No cross-group deps.

**Correction:** Don overstates the dependency of Group 7 steps on Groups 1–8. Steps 7c, 7d, 7e have no dependency on any extraction group (only on already-extracted items or items that stay). Step 7a and 7b depend on Group 2 only.

---

## 7. ASTWorker.ts Check

**ASTWorker.ts is a COMPLETELY SEPARATE implementation.** It does NOT call any method of JSASTAnalyzer. It implements its own `parseModule()` function with its own traversal logic.

**What ASTWorker.ts does:**
1. Imports/exports traversal — own implementation
2. Variable declarations — own implementation with `ExpressionEvaluator.extractLiteralValue`
3. Functions and classes — own implementation with `ClassNode.createWithContext`
4. Call expressions at module level — own implementation

**Impact of the JSASTAnalyzer extraction on ASTWorker.ts:** NONE. ASTWorker.ts does not import from JSASTAnalyzer and does not use any of the methods being extracted. The parallel path produces a structurally compatible `ASTCollections` but through entirely independent code.

**However, there is a pre-existing bug in ASTWorker.ts that is relevant:**

In ASTWorker.ts (lines 350–366), the `VariableDeclaration` handler contains:
```typescript
const shouldBeConstant = isConst && isLiteral;
const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';
```

This is the old (pre-REG-546 fix) logic that does NOT include `isLoopVariable` in `shouldBeConstant`. The fix in JSASTAnalyzer.ts (line 2433) is:
```typescript
const shouldBeConstant = isConst && (isLoopVariable || isLiteral);
```

ASTWorker.ts also does NOT handle `new X()` as VARIABLE (the REG-546 / REG-567 fix). The project memory notes this as "REG-567 filed for NewExpression CONSTANT/VARIABLE mismatch in parallel path." This is a known pre-existing gap, NOT introduced by this refactoring. Don correctly identifies this in the risk section. Rob must NOT fix this as part of REG-460 (out of scope), but Rob MUST verify that the extraction does not make the gap worse.

**Don's ASTWorker risk mitigation ("grep for method name in ASTWorker.ts") is sufficient and correct for this refactoring.** None of the extracted methods appear in ASTWorker.ts.

---

## 8. analyzeModule Inline Traversals: Detailed Analysis

Reading lines 1871–2216 of JSASTAnalyzer.ts:

### 7a: AssignmentExpression traversal (lines 1872–1958)

**What it does:** At module level (only if no `functionParent`), handles:
1. RHS is function/arrow → creates FUNCTION + SCOPE nodes, calls `this.analyzeFunctionBody`
2. LHS is Identifier → calls `this.detectVariableReassignment`
3. Any assignment → calls `this.detectIndexedArrayAssignment`
4. Any assignment → calls `this.detectObjectPropertyAssignment`

**Safety as visitor class:** YES, with caveats. The function detection logic (part 1) uses `scopeTracker.enterScope/exitScope` which must be carefully preserved in order. The `this.analyzeFunctionBody.bind(this)` call requires the analyzer to be passed to the new visitor.

**Ordering dependency:** Must run AFTER `traverse_variables` (VariableVisitor) because function assignments should not be double-processed as variables. The `getFunctionParent()` guard ensures this, but the traversal ordering through `analyzeModule` creates an implicit assumption that `VariableVisitor` has already processed `const/let/var` declarations before AssignmentExpression traversal processes `x = function() {}` patterns.

**Don correctly identifies this as lowest-risk.** However, part 1 (function creation + `analyzeFunctionBody`) is more complex than the mutation detection parts. Don suggests a `ModuleLevelAssignmentVisitor` — this is appropriate.

### 7b: UpdateExpression traversal (lines 1962–1973)

**What it does:** Skip if `functionParent`, then call `this.collectUpdateExpression`. 12 lines total.

**Safety as visitor class:** YES, trivially. Don correctly notes it may stay inline after Group 2 extraction.

### 7c: Callback traversal (lines 1995–2040)

**What it does:** `FunctionExpression` nodes that are direct arguments to `CallExpression` at module level. Creates FUNCTION + SCOPE, calls `this.analyzeFunctionBody`, calls `funcPath.skip()`.

**Critical ordering dependency:** This traversal MUST run AFTER `traverse_classes` because it registers anonymous functions that could be confused with class-level methods. Running it before `traverse_classes` would not cause correctness issues, but the semantic ID ordering would differ. Don does not mention this ordering dependency explicitly.

**Safety as visitor class:** YES, with `this.analyzeFunctionBody` and `this.generateAnonymousName` passed via delegate.

### 7d: NewExpression traversal (lines 2076–2163)

**What it does:** Module-level `new X()` constructor calls. Uses `processedConstructorCalls` set (line 2077) as a local deduplication guard. If this becomes a visitor, the set must be initialized in the constructor.

**Critical ordering dependency:** The `processedConstructorCalls` set must be initialized BEFORE the traverse, and it must survive for the entire traversal. If this becomes a `ModuleLevelNewExpressionVisitor`, the dedup set becomes an instance variable of that visitor. This is safe.

**Critical: Promise executor context registration (lines 2128–2158):** This block registers `promiseExecutorContexts` entries so that `CallExpressionHandler` (inside `analyzeFunctionBody`) can detect `resolve/reject` calls. The traversal order matters:

```
traverse_new (registers Promise executor contexts)
    ...later...
traverse_functions → analyzeFunctionBody → CallExpressionHandler reads promiseExecutorContexts
```

But wait — `traverse_new` runs AFTER `traverse_callbacks` (line 2043 vs 2076). And `traverse_callbacks` calls `this.analyzeFunctionBody`, which uses `CallExpressionHandler`, which reads `promiseExecutorContexts`. So at the time `traverse_callbacks` runs, the `promiseExecutorContexts` map is EMPTY — module-level Promise constructor calls haven't been processed yet.

**This is a pre-existing ordering bug in JSASTAnalyzer, NOT introduced by the refactoring.** For top-level callbacks passed to non-Promise constructors, there's no issue. For the specific case of `someFunc(new Promise((resolve) => { ... }))` — this is a NewExpression inside a CallExpression, which means the FunctionExpression callback is a child of the CallExpression arg, not of a top-level CallExpression. The `traverse_callbacks` guard (`funcPath.parent.type === 'CallExpression'`) would catch the outer callback, but the Promise context would not yet be registered. This is already broken. Rob should document this ordering issue but NOT fix it in REG-460 (out of scope).

### 7e: IfStatement traversal (lines 2167–2215)

**What it does:** Module-level if/else scopes. Calls `this.generateSemanticId`. Uses `ifScopeCounterRef` (local counter). Uses `code` string for condition extraction.

**Safety as visitor class:** YES, straightforward. The `code` string is available in `allCollections.code` (added at line 1848).

**Ordering dependency:** None critical. Can run at any point in the sequence.

---

## 9. Edge Cases by Construction

### Empty file

If the file has no content: `parse()` succeeds with empty AST. All visitors produce empty collections. All traversals visit 0 nodes. `graphBuilder.build()` is called with empty collections. This is already tested (implicitly) and will continue to work after extraction since the control flow is orchestration-level.

### File with ONLY module-level code (no functions)

VariableVisitor runs. FunctionVisitor produces nothing. `analyzeFunctionBody` is never called. The inline traversal blocks (assignments, updates) may still fire if there are module-level assignments. After extraction, the new visitor classes would handle these correctly — they already guard with `getFunctionParent()`.

### File with ONLY nested functions (deep nesting)

FunctionVisitor fires once for top-level function. `analyzeFunctionBody` is called. Inside that, `NestedFunctionHandler` fires for each nested function and recursively calls `analyzeFunctionBody`. This recursion goes through the same handler list. After extraction, `analyzeFunctionBody` still uses the same delegate pattern — `new NestedFunctionHandler(ctx, delegate)` — so deep nesting is safe.

### Parallel execution path (executeParallel)

`executeParallel` calls `pool.parseModules()` which dispatches to `ASTWorker.ts`. ASTWorker.ts is NOT affected by this refactoring (confirmed above). The parallel path does not exercise any of the methods being extracted. After extraction, `executeParallel` behavior is unchanged.

**However:** `executeParallel` never calls `this.analyzeModule`. It passes `result.collections` directly to `this.graphBuilder.build()`. The extracted methods live in `analyzeModule`'s traversal stack. The parallel path skips all of them. This means the snapshot tests (which run via the sequential path) will catch regressions from the extraction, but parallel-path regressions from pre-existing bugs (like REG-567) will not be caught by those tests. This is pre-existing, not introduced by REG-460.

---

## 10. Specific Issues Found

### Issue #1: LoopHandler as caller of `extractDiscriminantExpression` not documented

**Severity:** Medium. Rob is planning to remove `extractDiscriminantExpression` from the delegate after Group 4. But LoopHandler calls it at lines 162, 185, and 212.

**Required action:** After Group 4 extraction, `extractDiscriminantExpression` becomes a free function. LoopHandler must import it directly (via free function import). LoopHandler's delegate call (`analyzer.extractDiscriminantExpression(...)`) must be updated to a direct import call.

**If not fixed:** After delegate cleanup (Step 10), LoopHandler will reference a non-existent delegate method. TypeScript compiler will catch this, but it's a gap in Don's plan.

### Issue #2: LoopHandler as caller of `generateSemanticId` not documented

**Severity:** Medium. `generateSemanticId` is in the delegate. Don says it can be removed. LoopHandler calls it at line 267.

**Required action:** `generateSemanticId` must either:
(a) remain in the delegate until LoopHandler is updated, or
(b) be extracted as a free function and LoopHandler imports it directly.

Don's Phase 9 says `generateSemanticId` stays in JSASTAnalyzer (listed as "private"). If it stays, it stays in the delegate too. Don's Phase 7 says the delegate should retain only `analyzeFunctionBody` and possibly `extractVariableNamesFromPattern`. This contradicts with LoopHandler, BranchHandler, NestedFunctionHandler, and TryCatchHandler all needing `generateSemanticId` via the delegate.

**Conclusion:** `generateSemanticId` CANNOT be removed from the delegate as long as any handler calls it. The options are:
(a) Extract `generateSemanticId` to a free function (takes `scopeType` and `scopeTracker` — purely functional, no class state needed), update all callers to import it directly, then remove from delegate.
(b) Keep `generateSemanticId` in the delegate.

Don's plan implies (a) but does not state it explicitly as a required step.

### Issue #3: PropertyAccessHandler as caller of `collectUpdateExpression` not documented

**Severity:** Medium. Don's Group 2 says `collectUpdateExpression` has "no deps from JSASTAnalyzer." This is true for its implementation. But Don does not list PropertyAccessHandler as a caller — he only mentions the inline traversal block in `analyzeModule`.

**Verified in code:** `PropertyAccessHandler.ts:25` calls `analyzer.collectUpdateExpression(...)` via the delegate.

**Required action:** When `collectUpdateExpression` is extracted from Group 2 and the delegate entry removed (Step 10), PropertyAccessHandler must be updated to import and call the free function directly.

**If not fixed:** PropertyAccessHandler will reference a non-existent delegate method after Step 10. TypeScript compiler catches this, but it's a plan gap.

### Issue #4: ThrowHandler as caller of `microTraceToErrorClass` not documented

**Severity:** Low-Medium. Don's plan says `microTraceToErrorClass` can be removed from the delegate after Group 6 extraction. But `ThrowHandler.ts:78` also calls it.

**Required action:** After Group 6 extraction, ThrowHandler must be updated to call the extracted free function directly. Rob must not overlook ThrowHandler during delegate cleanup.

### Issue #5: TryCatchHandler calls `extractVariableNamesFromPattern` for catch params

**Severity:** Low. `TryCatchHandler.ts:241` calls `analyzer.extractVariableNamesFromPattern(catchNode.param)` to extract catch-clause parameter names.

Don notes that `extractVariableNamesFromPattern` should remain in the delegate (Phase 7). So this call site does NOT need to be changed. However, Don describes `extractVariableNamesFromPattern` as merely a utility delegate, which is accurate — it delegates to `extractNamesFromPattern`. The delegate entry can stay indefinitely since the underlying utility is already in `extractNamesFromPattern.ts`.

**No action required on this issue.** Documented for completeness.

### Issue #6: `extractObjectProperties` does NOT call `trackVariableAssignment` (plan error)

**Severity:** Low. Don states: "extractObjectProperties calls trackVariableAssignment recursively for nested objects." This is FACTUALLY INCORRECT. `extractObjectProperties` only calls itself recursively (for nested ObjectExpressions) — it does NOT call `trackVariableAssignment`.

The actual call chain is:
- `trackVariableAssignment` → `extractObjectProperties` (when init is ObjectExpression)
- `extractObjectProperties` → `extractObjectProperties` (for nested objects)

**Impact on extraction:** Don's conclusion (co-locate both in one file) is still correct because `trackVariableAssignment` imports `extractObjectProperties`. But the justification is wrong. This should be corrected in any handoff to Rob so he does not waste time looking for a circular call that doesn't exist.

### Issue #7: `analyzeModule` inline 7d block has ordering issue with `promiseExecutorContexts`

**Severity:** Low. Documented in Section 8 above. Pre-existing bug, not introduced by extraction. Rob should not fix it during REG-460.

---

## 11. AnalyzerDelegate Removal Schedule (Corrected)

Don's plan says to remove all extracted entries from the delegate incrementally. Here is the CORRECTED removal schedule accounting for Issues #1, #2, #3, #4:

| Delegate Method | Can Remove After Step | Callers to Update |
|---|---|---|
| `handleVariableDeclaration` | Step 5 (Group 4 extracted) | VariableHandler (import free fn) |
| `detectVariableReassignment` | Step 2 (Group 2 extracted) | VariableHandler (import free fn) |
| `detectIndexedArrayAssignment` | Step 2 | VariableHandler (import free fn) |
| `detectObjectPropertyAssignment` | Step 2 | VariableHandler (import free fn) |
| `collectUpdateExpression` | Step 2 | **PropertyAccessHandler** + inline block in analyzeModule |
| `extractReturnExpressionInfo` | Step 6 | ReturnYieldHandler, **NestedFunctionHandler** |
| `microTraceToErrorClass` | Step 6 | CallExpressionHandler, **ThrowHandler** |
| `handleSwitchStatement` | Step 4 | BranchHandler |
| `extractDiscriminantExpression` | Step 4 | BranchHandler, **LoopHandler** |
| `memberExpressionToString` | Step 1 | LoopHandler |
| `countLogicalOperators` | Step 1 | BranchHandler |
| `handleCallExpression` | Step 8 | CallExpressionHandler |
| `collectCatchesFromInfo` | Step 7 | analyzeFunctionBody (direct call, not via delegate) |
| `generateSemanticId` | CANNOT REMOVE without additional step | BranchHandler, NestedFunctionHandler, TryCatchHandler, LoopHandler — all must switch to free fn |
| `generateAnonymousName` | Stays in delegate | NestedFunctionHandler still calls it |
| `analyzeFunctionBody` | STAYS (recursive) | All NestedFunctionHandler-type handlers |
| `extractVariableNamesFromPattern` | STAYS | TryCatchHandler, ImportExportVisitor, VariableVisitor |

**Bold entries = callers Don did not mention.**

---

## 12. Snapshot Strategy Verification

Don's snapshot strategy is correct:
1. Run snapshots before starting (establish baseline) ✓
2. Run after each step ✓
3. Treat unexpected diffs as regression, rollback and fix ✓
4. Use `UPDATE_SNAPSHOTS=true` for intentional changes (only for pure refactors, no behavior change is expected) ✓

**Additional consideration:** Since this is a pure refactoring (no behavior change), `UPDATE_SNAPSHOTS=true` should NOT be needed. If snapshot diffs appear, they indicate a regression, not an intentional change. Don's step-by-step approach with snapshot verification between steps is the correct guard.

---

## Summary of Required Corrections to Don's Plan

| # | Issue | Required Fix Before Implementation |
|---|-------|-------------------------------------|
| 1 | LoopHandler calls `extractDiscriminantExpression` via delegate — not listed | Add LoopHandler to caller list for extractDiscriminantExpression; update it when delegate entry removed |
| 2 | LoopHandler calls `generateSemanticId` via delegate — `generateSemanticId` cannot be removed from delegate without converting it to a free function first | Either keep `generateSemanticId` in delegate, or add explicit step to extract it as free function and update all 4 handler files |
| 3 | PropertyAccessHandler calls `collectUpdateExpression` via delegate — not listed | Add PropertyAccessHandler to caller list; update when delegate entry removed |
| 4 | ThrowHandler calls `microTraceToErrorClass` via delegate — not listed | Add ThrowHandler to caller list; update when delegate entry removed |
| 6 | Don's claim that `extractObjectProperties` calls `trackVariableAssignment` is factually wrong | Correct the description; conclusion (co-locate) remains valid |

Issues #5 and #7 require no action.

---

## Final Verdict

**CONDITIONAL APPROVE.**

The plan's overall architecture is correct. The dependency graph is largely complete. The extraction order is valid (though more flexible than stated). The parallel path (ASTWorker.ts) is correctly identified as unaffected.

The five actionable issues (#1, #2, #3, #4, #6) are individually narrow but collectively important. Issues #1, #3, and #4 will produce TypeScript compilation errors during Step 10 (delegate cleanup) if Rob does not preemptively update the affected handlers. Issue #2 requires a decision: either keep `generateSemanticId` in the delegate permanently, or add an explicit extraction step. Issue #6 is a documentation error that must be corrected to avoid misleading Rob.

**Rob should proceed with the extraction in Don's order, with the following explicit additions:**
1. Before Step 10 delegate cleanup, grep for ALL callers of each delegate method being removed (not just the ones listed in the plan). The complete list is in Section 11 above.
2. For `generateSemanticId`: decide upfront whether to (a) convert to free function and remove from delegate, or (b) keep in delegate. Either is acceptable; the plan must state the chosen path.
3. For `collectUpdateExpression`: update PropertyAccessHandler when the delegate entry is removed.
4. For `extractDiscriminantExpression`: update LoopHandler when the delegate entry is removed.
5. For `microTraceToErrorClass`: update ThrowHandler when the delegate entry is removed.
