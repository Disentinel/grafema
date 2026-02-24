## Uncle Bob PREPARE Review: REG-460

**Reviewer:** Robert Martin (Uncle Bob)
**Date:** 2026-02-24
**Files to modify:** 13 (JSASTAnalyzer.ts + AnalyzerDelegate.ts + 9 handler files + 1 new directory = files affected, plus new files to create)

---

### File-level Review

#### JSASTAnalyzer.ts

**Location:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Size:** 4,739 lines — CRITICAL / MUST SPLIT

This file violates SRP in at least four distinct dimensions simultaneously:
1. Plugin orchestration (execute, executeParallel, shouldAnalyzeModule)
2. AST traversal coordination (analyzeModule — 654 lines of traversal wiring)
3. Expression analysis domain logic (trackVariableAssignment, extractDiscriminantExpression, extractReturnExpressionInfo)
4. Mutation detection domain logic (detectArrayMutationInFunction, detectObjectPropertyAssignment, collectUpdateExpression, etc.)

**Top 5 methods by size:**

1. `analyzeModule` — 654 lines (lines 1678–2331). God method. Contains collection initialization (~90 lines), 10+ visitor wiring calls, and 5 inline traversal blocks (~350 lines) that belong in visitor classes. This is the primary architectural problem.

2. `trackVariableAssignment` — 465 lines (lines 613–1077). Complex recursive descent over every expression type (AwaitExpression, TSAsExpression, ObjectExpression, ArrayExpression, Literal, Identifier, CallExpression, MemberExpression, NewExpression, BinaryExpression). Recursive call to `extractObjectProperties` for object literal init. Large but structurally sound — cohesive single responsibility. Ready to extract as a unit.

3. `trackDestructuringAssignment` — 357 lines (lines 1306–1662). Handles ObjectPattern and ArrayPattern destructuring recursively. Calls `isCallOrAwaitExpression`, `unwrapAwaitExpression`, `extractCallInfo`. No JSASTAnalyzer state dependency.

4. `handleCallExpression` — 223 lines (lines 3404–3626). 13 parameters. Dispatches on callee type (Identifier vs MemberExpression), builds CALL/METHOD_CALL nodes, detects array/object mutations as side effects. After Group 2 extraction, parameter count drops by 2–3. Currently coherent despite the length.

5. `extractReturnExpressionInfo` — 183 lines (lines 3057–3239). Pure AST transformation dispatching on expression type to build a `Partial<ReturnStatementInfo>`. No class state used. Zero dependency on other JSASTAnalyzer methods. Should have been a free function from the start.

**SRP violations:**
- The `Collections` interface (lines 143–230) at 87 lines with an `[key: string]: unknown` index signature lives in the same file as the plugin. It should be in `types.ts`.
- The `AnalysisManifest` and `AnalyzeContext` interfaces (lines 232–245) are plugin-private types embedded inside the implementation file.
- The 5 inline traversal blocks in `analyzeModule` (lines 1872–2216) each implement domain logic that belongs in dedicated visitor classes. They are structurally identical to existing visitor classes but were never extracted.
- `attachControlFlowMetadata` (lines 3328–3378) is a post-traversal analysis method that computes cyclomatic complexity. It belongs conceptually with the control flow visitors, not in the analyzer.

**Pre-existing issues (DO NOT FIX in REG-460):**
- Line 225: `sideEffects: unknown[]; // TODO: define SideEffectInfo` — forbidden TODO comment in production interface.
- Lines 638, 640, 1645: `(initExpression as any).expression` and `(initNode as any).expression` — `any` casts for TS AST node type narrowing. These are functional but hide the actual node types.
- The `Collections` interface has `[key: string]: unknown` index signature (line 229) which disables TypeScript structural checking on all collection accesses. This is the root cause of the aliasing risk Dijkstra identified and of the lazy-initialization `if (!ctx.collections.X)` patterns throughout VariableHandler and PropertyAccessHandler.
- The `isAnalysisResult` type guard (lines 24–30) exists because the WorkerPool result type is `unknown`. Pre-existing; not relevant to extraction.
- Line 914 in the function body: a comment in Russian (`// Если initNode — Promise...`). The codebase mixes English and Russian comments inconsistently.

---

#### AnalyzerDelegate.ts

**Location:** `packages/core/src/plugins/analysis/ast/handlers/AnalyzerDelegate.ts`
**Size:** 207 lines — CONCERN (but for the right reason)

The interface is well-structured: grouped by domain with clear section comments. The method signatures are correct and match the actual JSASTAnalyzer method signatures verified by Dijkstra.

The concern is not the current cleanliness — it is that the delegate is a temporary bridge that should be progressively dismantled. At 207 lines with 17 exposed methods, it is already substantial. After REG-460 completes, it should retain only 2–3 entries (`analyzeFunctionBody`, `extractVariableNamesFromPattern`, `generateAnonymousName`). If entries are not removed incrementally (one per extraction step), the interface will become misleading: it will expose methods that are also directly importable as free functions, creating two call paths for the same behavior.

**Specific concern:** `extractVariableNamesFromPattern` (lines 202–206) is listed in the delegate as a method that stays. But this method is already a thin wrapper around `extractNamesFromPattern` imported from `./ast/utils/extractNamesFromPattern.js`. After extraction, ALL callers should import from `extractNamesFromPattern.js` directly, and the delegate entry should be removed. Don's Phase 7 says it stays "indefinitely" — this is incorrect. The delegate entry adds indirection for no benefit once the callers are updated.

---

#### Target directories

- `ast/utils/` — EXISTS at `packages/core/src/plugins/analysis/ast/utils/`. Contains 6 files: `babelTraverse.ts`, `createParameterNodes.ts`, `extractNamesFromPattern.ts`, `getExpressionValue.ts`, `getMemberExpressionName.ts`, `location.ts`, `index.ts`. The new `expression-helpers.ts` file from Group 1 fits naturally here.

- `ast/extractors/` — DOES NOT EXIST. Must be created. This is the target for `VariableAssignmentTracker.ts`, `VariableDeclarationExtractor.ts`, `ReturnExpressionExtractor.ts`.

- `ast/mutation-detection/` — DOES NOT EXIST. Must be created. This is the target for the mutation detection group.

**Important conflict to resolve before creation:** `ast/visitors/MutationDetector.ts` (211 lines) already exists and handles array mutations and Object.assign detection for the MODULE-LEVEL traversal path (called from `CallExpressionVisitor`). The methods Don proposes for `ast/mutation-detection/` handle the FUNCTION-BODY path (called from `JSASTAnalyzer` directly, not via visitors). These are structurally similar but contextually different:

- `ast/visitors/MutationDetector.ts`: receives a full `VisitorCollections` object, initializes collections lazily, used by `CallExpressionVisitor`.
- `detectArrayMutationInFunction` (JSASTAnalyzer line 3993): receives a typed `ArrayMutationInfo[]` directly, no lazy initialization.

They are NOT the same logic. Do NOT merge them into the same file. The naming `mutation-detection/` directory alongside the existing `visitors/MutationDetector.ts` will cause confusion. Consider naming the directory `ast/function-body/` for the extracted function-body handlers, or add a clear README to `mutation-detection/` explaining the distinction.

---

#### Handler files

| File | Lines | Will Need Update? | Risk |
|------|-------|-------------------|------|
| `VariableHandler.ts` | 110 | YES — calls 4 delegate methods being extracted (handleVariableDeclaration, detectVariableReassignment, detectIndexedArrayAssignment, detectObjectPropertyAssignment) | LOW — will switch to direct imports |
| `BranchHandler.ts` | 411 | YES — calls countLogicalOperators (Group 1), extractDiscriminantExpression (Group 4), generateSemanticId (must stay or extract) | MEDIUM — 3 distinct delegate calls, 2 distinct code sites for countLogicalOperators |
| `LoopHandler.ts` | 307 | YES — calls memberExpressionToString (Group 1), extractDiscriminantExpression (Group 4 — 3 call sites), generateSemanticId (1 call site). Dijkstra flagged as undocumented in Don's plan. | MEDIUM — 5 total delegate calls, LoopHandler missed in Don's caller enumeration |
| `PropertyAccessHandler.ts` | 112 | YES — calls collectUpdateExpression (Group 2) via delegate. Dijkstra flagged as undocumented. | LOW — single call site, trivial update |
| `ThrowHandler.ts` | 101 | YES — calls microTraceToErrorClass (Group 6) via delegate. Dijkstra flagged as undocumented. | LOW — single call site |
| `CallExpressionHandler.ts` | 347 | YES — calls handleCallExpression (Group 5) and microTraceToErrorClass (Group 6) via delegate. The Promise rejection tracing logic (lines 76–343) is substantial and already duplicates pattern from handleCallExpression. | MEDIUM — post-extraction, CallExpressionHandler body will be larger than its delegate call justifies |
| `ReturnYieldHandler.ts` | 166 | YES — calls extractReturnExpressionInfo (Group 6) via delegate | LOW — 2 call sites, both straightforward |
| `NestedFunctionHandler.ts` | 201 | YES — calls generateAnonymousName, generateSemanticId (multiple times), extractReturnExpressionInfo, analyzeFunctionBody via delegate | MEDIUM — 4 distinct delegate methods, semanticId issue applies here too |
| `TryCatchHandler.ts` | 262 | YES — calls generateSemanticId (4 call sites), extractVariableNamesFromPattern (1 call site) via delegate | MEDIUM — generateSemanticId used most heavily here |

**The generateSemanticId problem is the highest-risk handler issue.** Dijkstra correctly identifies this as requiring an upfront decision. Currently `generateSemanticId` is called by:
- BranchHandler: lines 138, 172, 369 (3 call sites)
- NestedFunctionHandler: lines 43, 90, 150 (3 call sites)
- TryCatchHandler: lines 64, 106, 141 (3 call sites)
- LoopHandler: line 267 (1 call site)

That is 10 call sites across 4 handler files. The method body (lines 2337–2346) is 9 lines and has zero JSASTAnalyzer state dependency — it only uses `ScopeTracker`. It is a pure function disguised as a method. Rob must extract it as a free function in `ast/utils/` before delegate cleanup. This is not optional.

---

### Method-level Review (Top 5 methods to extract)

#### 1. `analyzeModule` (654 lines) — stays but must shrink

This method is NOT extracted as a unit. It is the orchestrator from which other methods are extracted. After all groups are done, it should be ~200 lines. However, the method has a structural problem that will impede extraction: the 5 inline traversal blocks (lines 1872–2216) share the `allCollections` reference, `scopeTracker`, and `code` local variables via closure. When converting these blocks to visitor classes, each new visitor must receive these as constructor arguments, just like the existing module-level visitors (`VariableVisitor`, `FunctionVisitor`, etc.) receive `module` and `collections`.

**Parameters:** None (private method) — takes `module`, `graph`, `projectPath`.
**Nesting depth:** 4–5 levels inside traversal callbacks.
**Recommendation:** DO NOT extract as a unit. Extract FROM it step by step per Don's plan.
**Key pre-extraction work:** Document the `allCollections` aliasing pattern (which local arrays are the same objects as `allCollections.*`) before touching any inline block. This must be a written comment or diagram, not just understood by the implementor.

#### 2. `trackVariableAssignment` (465 lines)

**Length:** 465 lines
**Parameters:** 13 (initNode, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef)
**Nesting depth:** 3 levels (switch-like if/else chain, each branch is flat)
**Recommendation:** EXTRACT AS-IS. The 13-parameter count is real but unavoidable given the collection-injection pattern. Do not try to bundle the parameters into a struct before extraction — that would be a STEP 2.5 change to a method that is already used at multiple call sites. Extract to `VariableAssignmentTracker.ts`, keeping the signature identical.

The recursive call on line 634 passes all 13 parameters through. This self-recursion is intentional (for `AwaitExpression` and TS type assertion unwrapping). After extraction, the recursion becomes a call to the free function by name.

**One genuine concern:** The `(initExpression as any).expression` cast at line 640. This is a pre-existing `any` cast for `TSAsExpression | TSSatisfiesExpression | TSNonNullExpression | TSTypeAssertion` nodes. The free function should carry this cast unchanged — do NOT fix it during extraction.

#### 3. `trackDestructuringAssignment` (357 lines)

**Length:** 357 lines
**Parameters:** 5 (pattern, initNode, variables, module, variableAssignments)
**Nesting depth:** 3–4 levels (nested pattern handling)
**Recommendation:** EXTRACT AS-IS. This is the cleanest of the large methods. Calls Group 1 helpers (`isCallOrAwaitExpression`, `unwrapAwaitExpression`, `extractCallInfo`) which will be available as free functions before this is extracted.

**Note on line 1645:** The `(initNode as any).expression` cast for `TSTypeAssertion` — same pattern as in `trackVariableAssignment`. Carry unchanged.

#### 4. `extractDiscriminantExpression` (140 lines)

**Length:** 140 lines
**Parameters:** 2 (discriminant, module)
**Nesting depth:** 3 levels (if/else on expression type)
**Recommendation:** EXTRACT AS-IS. Zero JSASTAnalyzer state. The return type is a large inline object literal (see AnalyzerDelegate.ts lines 183–200). Rob should extract the return type as a named interface `DiscriminantExpressionResult` in `ast/types.ts` before or during extraction.

**The undocumented callers problem:** LoopHandler calls this method at 3 distinct locations (lines 162, 185, 212). All 3 call the same free function after extraction. Rob must update LoopHandler in the same commit as BranchHandler when this delegate entry is removed — not as a separate follow-up.

#### 5. `handleCallExpression` (223 lines)

**Length:** 223 lines
**Parameters:** 13 (callNode, processedCallSites, processedMethodCalls, callSites, methodCalls, module, callSiteCounterRef, scopeTracker, parentScopeId, collections, isAwaited, isInsideTry, isInsideLoop)
**Nesting depth:** 4 levels (callee type checks, method call path)
**Recommendation:** SPLIT BEFORE EXTRACT. Don's recommendation (fold into `CallExpressionHandler.getHandlers()` directly) is correct in principle but the result will be a 580-line handler class (current 347 lines + 223 lines). That exceeds the handler size budget.

**Better approach:** Extract `extractMethodCallArguments` (91 lines) as a free function first. Then the body of `handleCallExpression` reduces to ~130 lines. At that point, fold the remaining logic into `CallExpressionHandler`. The handler class stays under 450 lines.

**Warning:** `CallExpressionHandler.ts` already has substantial Promise rejection tracing logic (lines 76–343) that structurally overlaps with what `handleCallExpression` does. After folding `handleCallExpression` in, `CallExpressionHandler` will contain near-duplicate paths for resolve/reject detection. This is a pre-existing architectural overlap (NOT introduced by this refactoring) — do not fix it in REG-460.

---

### Refactoring Recommendations

**REQUIRED before extraction begins:**

1. **Document allCollections aliasing.** Before touching `analyzeModule`, Rob must audit which local variables are the same object references as `allCollections.*` fields and add a comment block in `analyzeModule` documenting this. The lazy-init pattern (`if (!allCollections.propertyAssignments) { allCollections.propertyAssignments = []; }`) at multiple inline traversal sites means a new visitor class must use the same pattern OR all collections must be pre-initialized before the traversal. Choosing pre-initialization is cleaner and eliminates the aliasing concern entirely. This choice must be made before any traversal block is extracted.

2. **Extract `generateSemanticId` as a free function in Group 1.** This is a mandatory addition to Don's extraction order. The method has 9 lines, zero class state, and is called 10 times across 4 handler files. It must become `ast/utils/expression-helpers.ts` (or a new `ast/utils/scope-helpers.ts`) before Step 10 (delegate cleanup). Without this extraction, the delegate cleanup is blocked on all 4 handler files.

3. **Name the `DiscriminantExpressionResult` return type.** The return type of `extractDiscriminantExpression` is a 20-field inline object (AnalyzerDelegate.ts lines 183–200). This inline type is duplicated between the delegate interface and the method implementation. Before Group 4 extraction, add a named interface `DiscriminantExpressionResult` in `ast/types.ts` and use it in both the delegate and the free function signature. This is a prerequisite for the free function to have a clean signature.

4. **Update all 5 undocumented callers as part of their step.** The following callers are missing from Don's plan but MUST be updated when their delegate entry is removed (from Dijkstra's corrected schedule):
   - `LoopHandler`: update when `extractDiscriminantExpression` and `memberExpressionToString` entries removed (Step 4 / Step 1)
   - `PropertyAccessHandler`: update when `collectUpdateExpression` entry removed (Step 2)
   - `ThrowHandler`: update when `microTraceToErrorClass` entry removed (Step 6)
   - `NestedFunctionHandler`: update when `extractReturnExpressionInfo` entry removed (Step 6)
   - All 4 handlers (`BranchHandler`, `NestedFunctionHandler`, `TryCatchHandler`, `LoopHandler`): update when `generateSemanticId` becomes a free function

5. **Clarify the `ast/mutation-detection/` naming conflict before creating the directory.** The existing `ast/visitors/MutationDetector.ts` handles module-level mutation detection. The new directory will handle function-body mutation detection. These serve different traversal contexts. Either rename the directory (e.g., `ast/function-body-mutations/`) or add a `README.md` to the new directory clarifying the distinction. Failure to disambiguate will create maintenance confusion when the next developer needs to find mutation detection logic.

**SKIP (too risky or not worth it in REG-460):**

- Group 7e (`IfStatement` inline traversal to visitor): The `if-statement` module-level traversal (lines 2167–2215) is only 49 lines. Its removal from `analyzeModule` is less impactful than the other groups. Skip unless the time budget allows — the complexity of getting the `ifScopeCounterRef` scoping correct with a new visitor class is not worth ~49 lines saved.

- Merging `MutationDetector.ts` (visitors) with the new mutation-detection functions: These serve different traversal contexts. Do not merge.

- Fixing the `any` casts in `trackVariableAssignment` and `trackDestructuringAssignment`: Pre-existing, out of scope, carry unchanged.

- Fixing the `sideEffects: unknown[]` type in the `Collections` interface: Pre-existing, out of scope.

- Fixing the Promise executor context ordering bug (Dijkstra Issue #7): Pre-existing, out of scope.

- Extracting the `Collections` interface to `types.ts`: Pre-existing SRP violation, out of scope for this refactoring.

---

### Verification Checklist for Rob

Before starting ANY extraction step:
- [ ] Run `pnpm build && node --test test/unit/snapshots/GraphSnapshot.test.js` — must be 0 failures
- [ ] Note the baseline line count of JSASTAnalyzer.ts

After EACH extraction step:
- [ ] Run `pnpm build && node --test test/unit/snapshots/GraphSnapshot.test.js` — must be 0 failures (no UPDATE_SNAPSHOTS, this is a pure refactor)
- [ ] Verify the extracted method is removed from JSASTAnalyzer.ts (no dead code left behind)
- [ ] Verify the corresponding delegate entry is removed from AnalyzerDelegate.ts
- [ ] Verify ALL callers (not just those in Don's plan, but the full Dijkstra list) switch to the free function import
- [ ] grep for the method name in ASTWorker.ts — confirm no update needed there

After ALL extraction steps:
- [ ] Run `pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'` — 0 failures
- [ ] Verify JSASTAnalyzer.ts is under 1,100 lines
- [ ] Verify AnalyzerDelegate.ts retains only: `analyzeFunctionBody`, `generateAnonymousName`, `extractVariableNamesFromPattern` (and `generateSemanticId` only if it was NOT extracted as a free function)

---

### Risk Assessment

**Risk:** MEDIUM (was LOW before this review, elevated by the undocumented caller gaps and the generateSemanticId decision)

**Estimated scope:** 13+ files affected total:
- 1 file shrinking significantly (JSASTAnalyzer.ts: 4,739 → ~950 lines)
- 1 file shrinking significantly (AnalyzerDelegate.ts: 207 → ~50 lines)
- 9 handler files updated (all except FunctionBodyHandler)
- ~7 new files created (expression-helpers.ts, 3–4 mutation-detection files, VariableAssignmentTracker.ts, ReturnExpressionExtractor.ts, CatchesFromCollector.ts)
- 2 new directories created (ast/extractors/, ast/mutation-detection/)

The plan is structurally correct and the dependency graph is complete (with Dijkstra's corrections). The five undocumented callers are a real gap that will cause TypeScript compilation errors during delegate cleanup if not addressed. The `generateSemanticId` extraction decision must be made upfront — kicking it to "maybe later" means the delegate cleanup step cannot complete.

The overall refactoring is APPROVED to proceed. Don's plan with Dijkstra's corrections, plus the three additional requirements from this review (allCollections documentation, `generateSemanticId` extraction, `DiscriminantExpressionResult` named type), constitutes a complete preparation for safe extraction.
