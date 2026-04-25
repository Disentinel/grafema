# REG-460: JSASTAnalyzer.ts Refactoring Plan

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-24
**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
**Current size:** 4,739 lines
**Target:** ~800 lines (orchestration only)

---

## Phase 0: Prior Art — What We Learned

### GraphBuilder (2,921 → 528 lines)
Pattern: Create a `BuilderContext` interface, pass it to all domain builders in their constructor. Each builder receives `bufferNode/bufferEdge` callbacks through context rather than the parent class. GraphBuilder becomes pure orchestrator: calls `builder.buffer(module, data)` per domain.

**Key insight:** Builders do not call back into the parent. They take context at construction time. No delegation interface needed.

### ReactAnalyzer (1,368 → 323 lines)
Pattern: Extract domain logic to free functions in `react-internal/` (browser-api.ts, hooks.ts, jsx.ts). ReactAnalyzer only does: parse → traverse → call free functions → write graph. No classes for extracted logic; pure functions suffice.

**Key insight:** Free functions work for pure transformations. No shared mutable state required.

### CallExpressionVisitor (1,363 → 496 lines)
Pattern: Extract `ArgumentExtractor`, `MutationDetector` as focused classes. Use a `HandlerState` struct passed in at visitor construction time. Visitor class only wires together handlers via `getHandlers()`.

**Key insight:** Complex multi-param methods become single-param methods when context is bundled into a typed struct.

### The AnalyzerDelegate Pattern (Currently in Use)
`AnalyzerDelegate.ts` already exposes all private methods of JSASTAnalyzer as a formal interface. Handlers call `this.analyzer.someMethod(...)` via the delegate. This was introduced in REG-422 to allow handler extraction without changing the methods' home — the methods still live in JSASTAnalyzer.

**Key insight:** The delegate is a _temporary_ bridge. The refactoring goal is to move the actual implementations OUT of JSASTAnalyzer so the delegate becomes unnecessary. Each extracted module should become self-contained.

---

## Phase 1: Full Method Inventory

All methods in JSASTAnalyzer.ts with line ranges (measured 2026-02-24):

| # | Method | Lines | Approx Size | Visibility | Exposed via Delegate |
|---|--------|-------|-------------|------------|---------------------|
| 1 | `calculateFileHash` | 298–305 | 8 | public | No |
| 2 | `shouldAnalyzeModule` | 310–344 | 35 | public | No |
| 3 | `execute` | 346–501 | 156 | public | No |
| 4 | `executeParallel` | 515–596 | 82 | private | No |
| 5 | `extractVariableNamesFromPattern` | 605–608 | 4 | public | No (delegates to util) |
| 6 | `trackVariableAssignment` | 613–1077 | 465 | public | No |
| 7 | `extractObjectProperties` | 1083–1224 | 142 | private | No |
| 8 | `unwrapAwaitExpression` | 1230–1235 | 6 | private | No |
| 9 | `extractCallInfo` | 1241–1280 | 40 | private | No |
| 10 | `isCallOrAwaitExpression` | 1285–1288 | 4 | private | No |
| 11 | `trackDestructuringAssignment` | 1306–1662 | 357 | private | No |
| 12 | `getModuleNodes` | 1667–1673 | 7 | private | No |
| 13 | `analyzeModule` | 1678–2331 | 654 | public | No |
| 14 | `generateSemanticId` | 2337–2346 | 10 | private | **Yes** |
| 15 | `generateAnonymousName` | 2352–2356 | 5 | private | **Yes** |
| 16 | `handleVariableDeclaration` | 2397–2571 | 175 | private | **Yes** |
| 17 | `handleSwitchStatement` | 2585–2738 | 154 | private | **Yes** |
| 18 | `extractDiscriminantExpression` | 2747–2886 | 140 | private | **Yes** |
| 19 | `extractOperandName` | 2892–2896 | 5 | private | No |
| 20 | `extractCaseValue` | 2901–2921 | 21 | private | No |
| 21 | `caseTerminates` | 2926–2958 | 33 | private | No |
| 22 | `blockTerminates` | 2963–2972 | 10 | private | No |
| 23 | `countLogicalOperators` | 2981–3013 | 33 | private | **Yes** |
| 24 | `memberExpressionToString` | 3018–3036 | 19 | private | **Yes** |
| 25 | `extractReturnExpressionInfo` | 3057–3239 | 183 | private | **Yes** |
| 26 | `analyzeFunctionBody` | 3250–3322 | 73 | public | **Yes** |
| 27 | `attachControlFlowMetadata` | 3328–3378 | 51 | private | No |
| 28 | `handleCallExpression` | 3404–3626 | 223 | private | **Yes** |
| 29 | `extractMethodCallArguments` | 3636–3726 | 91 | private | No |
| 30 | `microTraceToErrorClass` | 3739–3822 | 84 | private | **Yes** |
| 31 | `collectCatchesFromInfo` | 3841–3975 | 135 | private | **Yes** |
| 32 | `detectArrayMutationInFunction` | 3993–4070 | 78 | private | No |
| 33 | `detectIndexedArrayAssignment` | 4084–4201 | 118 | private | **Yes** |
| 34 | `detectObjectPropertyAssignment` | 4212–4366 | 155 | private | **Yes** |
| 35 | `collectUpdateExpression` | 4380–4484 | 105 | private | **Yes** |
| 36 | `detectVariableReassignment` | 4497–4611 | 115 | private | **Yes** |
| 37 | `extractMutationValue` | 4616–4659 | 44 | private | No |
| 38 | `detectObjectAssignInFunction` | 4665–4738 | 74 | private | No |

**Total delegate-exposed methods:** 16 (these are the natural extraction targets)

---

## Phase 2: Dependency Analysis

The critical insight is that `analyzeModule` is the god method (654 lines). It contains:
1. File read + parse (orchestration — stays)
2. Collection initialization (orchestration — stays, but can be extracted to `initCollections()`)
3. Series of `traverse(ast, visitor.getHandlers())` calls (orchestration — stays)
4. Inline traversal blocks (AssignmentExpression, UpdateExpression, callbacks, NewExpression, IfStatement) — these are the leakage. They should have been visitors.
5. Collision resolution post-pass (stays)
6. `graphBuilder.build()` call (stays)

The inline traversal blocks at lines 1872–2216 duplicate logic that belongs in visitors. They are the biggest single source of length in `analyzeModule`.

**Dependency graph for extraction:**

```
extractMutationValue (no deps)
extractOperandName (no deps)
extractCaseValue (no deps)
caseTerminates → blockTerminates (no other deps)
blockTerminates (no deps)
unwrapAwaitExpression (no deps)
extractCallInfo (no deps)
isCallOrAwaitExpression → unwrapAwaitExpression
countLogicalOperators (no deps)
memberExpressionToString (no deps)
generateSemanticId (no deps)
generateAnonymousName (no deps)
extractReturnExpressionInfo (no deps from JSASTAnalyzer, only types)
extractObjectProperties → trackVariableAssignment (circular-ish: trackVariableAssignment calls extractObjectProperties)
trackVariableAssignment → extractObjectProperties
trackDestructuringAssignment → isCallOrAwaitExpression, unwrapAwaitExpression, extractCallInfo
detectArrayMutationInFunction (no deps from JSASTAnalyzer)
detectObjectAssignInFunction (no deps from JSASTAnalyzer)
detectIndexedArrayAssignment (no deps from JSASTAnalyzer other than literals)
detectObjectPropertyAssignment → extractMutationValue
detectVariableReassignment (no deps from JSASTAnalyzer)
collectUpdateExpression (no deps from JSASTAnalyzer)
extractDiscriminantExpression → extractOperandName, memberExpressionToString
handleSwitchStatement → extractDiscriminantExpression, caseTerminates, extractCaseValue, computeSemanticId
extractMethodCallArguments (no deps from JSASTAnalyzer)
handleCallExpression → detectArrayMutationInFunction, detectObjectAssignInFunction, extractMethodCallArguments, computeSemanticId
handleVariableDeclaration → trackVariableAssignment, extractVariableNamesFromPattern, classInstantiations, computeSemanticId
collectCatchesFromInfo (no deps from JSASTAnalyzer, only collections)
microTraceToErrorClass (no deps from JSASTAnalyzer)
attachControlFlowMetadata (no deps from JSASTAnalyzer)
analyzeFunctionBody → createFunctionBodyContext, all handlers, collectCatchesFromInfo, attachControlFlowMetadata, extractReturnExpressionInfo
analyzeModule → all visitors, all inline traversal blocks, graphBuilder.build()
```

**Critical circular dependency:** `trackVariableAssignment` and `extractObjectProperties` call each other recursively for nested object literals. They must be extracted TOGETHER into the same module.

---

## Phase 3: Comparison vs Linear Issue Groups

The Linear issue (created when file was 4,042 lines) proposed 6 groups. Here is the reality check at 4,739 lines:

| Linear Group | What Was Proposed | Reality Check |
|---|---|---|
| `ast/extractors/` | handleCallExpression, extractReturnExpressionInfo, handleVariableDeclaration | Still accurate. handleCallExpression grew (221→223 lines), handleVariableDeclaration grew (175 lines). |
| `ast/mutation-detection/` | detectArrayMutation, detectObjectAssign, detectVariableReassignment, collectUpdateExpression | Still accurate. Also need: detectIndexedArrayAssignment, detectObjectPropertyAssignment, extractMutationValue, detectObjectAssignInFunction. |
| `ast/utils/` | SwitchStatementAnalyzer, CatchesFromCollector, expression-helpers | Still accurate. Also need: extractDiscriminantExpression, extractOperandName, caseTerminates, blockTerminates, memberExpressionToString, countLogicalOperators. |
| ID generation | migrate to IdGenerator | Still accurate but lower priority. Only ~60 lines of ID generation remain in JSASTAnalyzer. |
| Builder pattern | eliminate .push() boilerplate | Lower priority — GraphBuilder already handles the push side. The real push reduction comes from extractors taking collections directly. |
| Final polish | inline small methods, consolidate imports | Correct, but happens automatically as other groups are extracted. |

**New finding not in Linear issue:** The inline traversal blocks inside `analyzeModule` (lines 1871–2216: callbacks, assignments, updates, NewExpression, IfStatement) account for ~350 lines that could become visitor classes, following exactly the same pattern as FunctionVisitor, ClassVisitor, TypeScriptVisitor. These blocks exist because they were added incrementally and never extracted.

**Revised group count:** 7 groups (adding the inline-traversal-to-visitor conversion).

---

## Phase 4: Detailed Extraction Plan

### Group 1: Expression Helpers (No Dependencies — Extract First)
**Target:** `packages/core/src/plugins/analysis/ast/utils/expression-helpers.ts`

**Methods to extract:**
- `extractOperandName` (lines 2892–2896, 5 lines)
- `memberExpressionToString` (lines 3018–3036, 19 lines)
- `countLogicalOperators` (lines 2981–3013, 33 lines)
- `extractCaseValue` (lines 2901–2921, 21 lines)
- `caseTerminates` (lines 2926–2958, 33 lines)
- `blockTerminates` (lines 2963–2972, 10 lines)
- `unwrapAwaitExpression` (lines 1230–1235, 6 lines)
- `extractCallInfo` (lines 1241–1280, 40 lines)
- `isCallOrAwaitExpression` (lines 1285–1288, 4 lines)

**Total:** ~171 lines → exported as named functions.

**What it needs:** Only `@babel/types` (t). No JSASTAnalyzer state.

**What it returns:** Primitive values and typed objects (no collections mutations).

**AnalyzerDelegate impact:** `memberExpressionToString`, `countLogicalOperators`, `extractDiscriminantExpression` are in the delegate. After extraction, handlers call the free function directly — delegate entries for these can be removed.

**Dependencies:** None. Extract first with zero risk.

**File shape:**
```typescript
// packages/core/src/plugins/analysis/ast/utils/expression-helpers.ts
import * as t from '@babel/types';

export function extractOperandName(node: t.Expression | t.PrivateName): string | undefined { ... }
export function memberExpressionToString(expr: t.MemberExpression): string { ... }
export function countLogicalOperators(node: t.Expression): number { ... }
export function extractCaseValue(test: t.Expression | null): unknown { ... }
export function caseTerminates(caseNode: t.SwitchCase): boolean { ... }
export function blockTerminates(node: t.Statement): boolean { ... }
export function unwrapAwaitExpression(node: t.Expression): t.Expression { ... }
export function extractCallInfo(node: t.Expression): CallInfo | null { ... }
export function isCallOrAwaitExpression(node: t.Expression): boolean { ... }
```

---

### Group 2: Mutation Detection (No JSASTAnalyzer deps — Extract Second)
**Target:** `packages/core/src/plugins/analysis/ast/mutation-detection/`

**Files:**
- `MutationDetector.ts` — array/object mutations (already exists in visitors! verify it's distinct)
- `ArrayMutationDetector.ts` — detectArrayMutationInFunction, detectIndexedArrayAssignment
- `ObjectMutationDetector.ts` — detectObjectPropertyAssignment, detectObjectAssignInFunction, extractMutationValue
- `VariableReassignmentDetector.ts` — detectVariableReassignment
- `UpdateExpressionCollector.ts` — collectUpdateExpression

**Wait:** Check if `ast/visitors/MutationDetector.ts` already handles some of this. If so, consolidate instead of creating parallel structure.

**Methods to extract:**
- `detectArrayMutationInFunction` (lines 3993–4070, 78 lines)
- `detectIndexedArrayAssignment` (lines 4084–4201, 118 lines)
- `detectObjectPropertyAssignment` (lines 4212–4366, 155 lines) → depends on `extractMutationValue`
- `extractMutationValue` (lines 4616–4659, 44 lines)
- `detectObjectAssignInFunction` (lines 4665–4738, 74 lines)
- `detectVariableReassignment` (lines 4497–4611, 115 lines)
- `collectUpdateExpression` (lines 4380–4484, 105 lines)

**Total:** ~689 lines

**What they need:** `@babel/types`, `ScopeTracker`, `computeSemanticId`, `ExpressionEvaluator`, `ObjectLiteralNode`, `ArrayLiteralNode`, and collection types from `ast/types.ts`.

**What they return/push to:** Directly mutate passed-in collection arrays (`arrayMutations`, `objectMutations`, `variableReassignments`, `updateExpressions`, `propertyAssignments`).

**AnalyzerDelegate impact:** `detectIndexedArrayAssignment`, `detectObjectPropertyAssignment`, `collectUpdateExpression`, `detectVariableReassignment` will be removable from the delegate interface after extraction.

**Dependencies:** Group 1 (expression-helpers) for `extractMutationValue`.

**Blocker:** Must extract Group 1 first.

**File shape (example):**
```typescript
// packages/core/src/plugins/analysis/ast/mutation-detection/ArrayMutationDetector.ts
import * as t from '@babel/types';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { ArrayMutationInfo, ArrayMutationArgument, CounterRef } from '../types.js';
// ... imports

export function detectArrayMutationInFunction(
  callNode: t.CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: { file: string },
  arrayMutations: ArrayMutationInfo[],
  scopeTracker?: ScopeTracker,
  isNested?: boolean,
  baseObjectName?: string,
  propertyName?: string
): void { ... }

export function detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: { file: string },
  arrayMutations: ArrayMutationInfo[],
  scopeTracker?: ScopeTracker,
  collections?: CollectionsSubset
): void { ... }
```

---

### Group 3: Variable Assignment Tracking (Depends on Group 1 — Extract Third)
**Target:** `packages/core/src/plugins/analysis/ast/extractors/VariableAssignmentTracker.ts`

**Methods to extract:**
- `trackVariableAssignment` (lines 613–1077, 465 lines)
- `extractObjectProperties` (lines 1083–1224, 142 lines)
- `trackDestructuringAssignment` (lines 1306–1662, 357 lines)

**Total:** ~964 lines — this is the largest single group.

**Critical:** These three methods form a recursive triangle. `trackVariableAssignment` calls `extractObjectProperties`; `extractObjectProperties` calls `trackVariableAssignment` recursively for nested objects. They must be extracted TOGETHER into a single module or a set of mutually-importing modules.

**What they need:** `@babel/types`, `ExpressionEvaluator`, `ExpressionNode`, `ObjectLiteralNode`, `ArrayLiteralNode`, `getLine`, `getColumn`, `VisitorModule`, and collection types.

**What they return/push to:** Mutate passed-in `variableAssignments`, `literals`, `objectLiterals`, `objectProperties`, `arrayLiterals` collections.

**AnalyzerDelegate impact:** `handleVariableDeclaration` currently calls `trackVariableAssignment` on the delegate. After this extraction, VariableHandler can call the extracted free function directly.

**Dependencies:** Groups 1 and 2 (for some expression helpers, but primarily standalone).

**File shape:**
```typescript
// packages/core/src/plugins/analysis/ast/extractors/VariableAssignmentTracker.ts
import * as t from '@babel/types';
// ... all needed imports

export function trackVariableAssignment(
  initNode: t.Expression | null | undefined,
  variableId: string,
  variableName: string,
  module: VisitorModule,
  line: number,
  literals: LiteralInfo[],
  variableAssignments: VariableAssignmentInfo[],
  literalCounterRef: CounterRef,
  objectLiterals: ObjectLiteralInfo[],
  objectProperties: ObjectPropertyInfo[],
  objectLiteralCounterRef: CounterRef,
  arrayLiterals: ArrayLiteralInfo[],
  arrayLiteralCounterRef: CounterRef
): void { ... }

export function extractObjectProperties(
  objectExpr: t.ObjectExpression,
  objectId: string,
  module: VisitorModule,
  objectProperties: ObjectPropertyInfo[],
  objectLiterals: ObjectLiteralInfo[],
  objectLiteralCounterRef: CounterRef,
  literals: LiteralInfo[],
  literalCounterRef: CounterRef
): void { ... }

export function trackDestructuringAssignment(
  pattern: t.ObjectPattern | t.ArrayPattern,
  initNode: t.Expression | null | undefined,
  variables: Array<ExtractedVariable & { id: string }>,
  module: VisitorModule,
  variableAssignments: VariableAssignmentInfo[]
): void { ... }
```

---

### Group 4: Variable/Switch Declaration Handlers (Depends on Groups 1–3)
**Target:** `packages/core/src/plugins/analysis/ast/extractors/VariableDeclarationExtractor.ts` and `SwitchStatementAnalyzer.ts`

**Methods to extract:**
- `handleVariableDeclaration` (lines 2397–2571, 175 lines) → depends on `trackVariableAssignment`
- `handleSwitchStatement` (lines 2585–2738, 154 lines) → depends on `extractDiscriminantExpression`, `caseTerminates`, `extractCaseValue`
- `extractDiscriminantExpression` (lines 2747–2886, 140 lines) → depends on `extractOperandName`, `memberExpressionToString`

**Total:** ~469 lines

**Key note for `handleVariableDeclaration`:** After Groups 1–3 are extracted, this method's body will consist almost entirely of calls to `trackVariableAssignment`, `extractVariableNamesFromPattern`, and `computeSemanticId`. The method itself becomes ~50 lines of orchestration. It may not even need its own file — it could become part of VariableVisitor or VariableHandler directly.

**What they need:** Group 1 (expression-helpers), Group 3 (trackVariableAssignment), `computeSemanticId`, `ExpressionEvaluator`, `ExpressionNode`.

**AnalyzerDelegate impact:** `handleVariableDeclaration`, `handleSwitchStatement`, `extractDiscriminantExpression` are in the delegate. After this extraction, all three can be removed from AnalyzerDelegate.

---

### Group 5: Call Expression Handler (Depends on Groups 1–4)
**Target:** Move logic INTO or alongside existing `ast/handlers/CallExpressionHandler.ts`

**Methods to extract:**
- `handleCallExpression` (lines 3404–3626, 223 lines, 13 parameters)
- `extractMethodCallArguments` (lines 3636–3726, 91 lines)

**Total:** ~314 lines

**Key observation:** `handleCallExpression` in JSASTAnalyzer is the function-body version of the same logic in `CallExpressionVisitor` for module-level traversal. These two do essentially the same thing but from different contexts. The function-body version calls `detectArrayMutationInFunction` and `detectObjectAssignInFunction` as side effects. After Group 2 is extracted, these become free function calls.

**Recommended approach:** Don't create a new file. Instead, refactor `CallExpressionHandler.ts` to call the extracted mutation functions directly (similar to how VariableHandler calls `handleVariableDeclaration` on the delegate). The `handleCallExpression` logic gets folded into `CallExpressionHandler.getHandlers()` directly, eliminating the delegate call.

**AnalyzerDelegate impact:** `handleCallExpression` can be removed from AnalyzerDelegate after this.

**Parameters reduction:** With mutation detection extracted (Group 2), `handleCallExpression`'s 13 parameters reduce significantly — the `detectArray*` and `detectObject*` side-effect calls just become direct free function calls.

---

### Group 6: Return/Catch/Trace Extractors (Depends on Group 1)
**Target:** `packages/core/src/plugins/analysis/ast/extractors/ReturnExpressionExtractor.ts` and `packages/core/src/plugins/analysis/ast/utils/CatchesFromCollector.ts`

**Methods to extract:**
- `extractReturnExpressionInfo` (lines 3057–3239, 183 lines)
- `collectCatchesFromInfo` (lines 3841–3975, 135 lines)
- `microTraceToErrorClass` (lines 3739–3822, 84 lines)
- `attachControlFlowMetadata` (lines 3328–3378, 51 lines)

**Total:** ~453 lines

**Key note for `extractReturnExpressionInfo`:** This is currently called from within `analyzeFunctionBody` (for implicit arrow returns) and from `ReturnYieldHandler`. After extraction, both call sites use the free function. The delegate entry disappears.

**Key note for `collectCatchesFromInfo`:** This is called from `analyzeFunctionBody` as a second-pass post-traverse. After extraction, `analyzeFunctionBody` simply calls `collectCatchesFromInfo(ctx.functionPath, ...)`.

**What they need:** `@babel/types`, `getLine/getColumn`, `ExpressionEvaluator`, `NodeFactory`, `LiteralInfo`, `ReturnStatementInfo`, collection types.

**Dependencies:** Group 1 only (for some expression type checking). Mostly standalone.

---

### Group 7: Inline Traversal Blocks → Visitor Classes (New — Not in Linear Issue)
**Target:** Extract 5 inline traversal blocks from `analyzeModule` into proper visitor/handler classes.

These inline blocks in `analyzeModule` (lines 1871–2216) were added incrementally and never extracted:

**7a. AssignmentExpression traversal (lines 1872–1958, ~87 lines)**
Handles module-level function assignments + variable reassignments + array/object mutations.
Target: `ast/visitors/ModuleLevelAssignmentVisitor.ts` — mirrors the pattern of VariableVisitor but for module-level assignments.

**7b. UpdateExpression traversal (lines 1962–1973, ~12 lines)**
Tiny — calls `collectUpdateExpression` for module-level updates.
After Group 6 extraction, this becomes a 5-line lambda. Can stay inline.

**7c. Callback traversal (lines 1995–2040, ~46 lines)**
Handles FunctionExpression nodes that are arguments to CallExpression at module level.
Target: Fold into `FunctionVisitor` with a guard for `funcPath.parent.type === 'CallExpression'`.

**7d. NewExpression traversal (lines 2076–2163, ~88 lines)**
Handles module-level `new X()` calls.
Target: This already has a parallel in `NewExpressionHandler`. Consider a `ModuleLevelNewExpressionVisitor.ts` that wraps the same logic.

**7e. IfStatement traversal (lines 2167–2215, ~49 lines)**
Handles module-level if/else scope creation.
Target: Can be a `ModuleLevelIfStatementVisitor.ts`.

**Total reducible from analyzeModule:** ~282 lines

**Dependencies:** Groups 1–6 (because these blocks call the extracted free functions). Extract last.

---

## Phase 5: Extraction Order

```
Step 1: expression-helpers.ts          (Group 1) — zero deps
Step 2: mutation-detection/            (Group 2) — depends on Group 1
Step 3: VariableAssignmentTracker.ts   (Group 3) — depends on Groups 1-2
Step 4: SwitchStatementAnalyzer.ts     (Group 4, switch part) — depends on Groups 1,3
Step 5: VariableDeclarationExtractor   (Group 4, var decl part) — depends on Groups 1,3
Step 6: ReturnExpressionExtractor.ts   (Group 6) — depends on Group 1
Step 7: CatchesFromCollector.ts        (Group 6) — depends on Groups 1,3
Step 8: CallExpressionHandler refactor (Group 5) — depends on Groups 1,2
Step 9: Inline traversals → visitors   (Group 7) — depends on Groups 1-8
Step 10: AnalyzerDelegate cleanup      — remove all extracted entries
```

**Estimated line reductions per step:**

| Step | Lines Removed from JSASTAnalyzer | Cumulative Remaining |
|------|----------------------------------|----------------------|
| Start | — | 4,739 |
| 1 | ~171 | ~4,568 |
| 2 | ~689 | ~3,879 |
| 3 | ~964 | ~2,915 |
| 4+5 | ~469 | ~2,446 |
| 6+7 | ~453 | ~1,993 |
| 8 | ~314 | ~1,679 |
| 9 | ~282 | ~1,397 |
| 10 | ~100 (imports, delegate refs) | ~1,297 |

**Gap to target (~800 lines):** ~497 lines.

The remaining gap comes from:
- `analyzeModule` core (parse, collection init, visitor wiring) — ~350 lines. This is genuine orchestration. Can be reduced to ~200 if `initCollections()` is extracted.
- `execute` + `executeParallel` (~238 lines) — orchestration, stays.
- `analyzeFunctionBody` (~73 lines) — stays, it's the entry point.
- `shouldAnalyzeModule` + `calculateFileHash` (~43 lines) — stays.
- Imports (~60-80 lines) — will shrink as methods leave.
- Class declaration + constructor + metadata (~40 lines) — stays.

**Realistic final estimate: 900–1,100 lines** (vs 800 target in Linear). The target is achievable if `initCollections()` is extracted and `analyzeModule`'s inline traversals become visitors.

---

## Phase 6: Snapshot Strategy

### Existing Coverage
Six fixture snapshots already exist:
- `02-api-service.snapshot.json`
- `03-complex-async.snapshot.json`
- `04-control-flow.snapshot.json`
- `06-socketio.snapshot.json`
- `07-http-requests.snapshot.json`
- `nodejs-builtins.snapshot.json`

These cover: class hierarchies, async patterns, control flow branches, socket patterns, HTTP patterns, Node.js builtins.

### Before Starting Any Extraction Step
```bash
pnpm build
node --test test/unit/snapshots/GraphSnapshot.test.js
```
This must pass (0 failures) before any extraction begins. If it fails pre-refactoring, stop and fix first.

### After Each Extraction Step
```bash
pnpm build && node --test test/unit/snapshots/GraphSnapshot.test.js
```
Run this after EVERY step. A failure here means the extraction broke something — fix before proceeding.

### After All Steps Complete
```bash
pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'
```
Run full suite. Zero failures expected.

### If Snapshot Diffs Appear
- **Intentional change:** Run `UPDATE_SNAPSHOTS=true node --test test/unit/snapshots/GraphSnapshot.test.js` to regenerate.
- **Unintentional change:** The extraction changed behavior. Rollback the step, find the bug, fix, re-extract.

**WARNING from project memory:** Do NOT manually predict which snapshot nodes change. Always run `UPDATE_SNAPSHOTS=true` to regenerate. Previous experience (REG-546) showed that predicting which nodes would change led to wrong predictions about the count.

---

## Phase 7: Updating the AnalyzerDelegate

After each group is extracted, remove the corresponding entries from `AnalyzerDelegate.ts`. The interface should shrink in parallel with JSASTAnalyzer.

After all groups are extracted, the `AnalyzerDelegate` should retain only:
- `analyzeFunctionBody` (recursive — handlers call this for nested functions)
- Possibly `extractVariableNamesFromPattern` (already a utility delegate)

The `cast to AnalyzerDelegate` in `analyzeFunctionBody` (line 3285) will eventually become a trivial cast with almost nothing in the interface.

---

## Phase 8: Risk Assessment

### High Risk: trackVariableAssignment ↔ extractObjectProperties mutual recursion
**Risk:** Extracting them to separate files creates a circular import.
**Mitigation:** Extract them to the SAME file (`VariableAssignmentTracker.ts`). They share a single export module with no circular dependency.

### High Risk: ASTWorkerPool parallel path not updated
**From project memory:** ASTWorker.ts has its own copy of classification logic that may not get bug fixes. When extracting methods, Rob must verify whether ASTWorker.ts needs the same extraction applied or whether it calls JSASTAnalyzer methods at all.
**Mitigation:** After each extraction, grep for the method name in ASTWorker.ts to confirm it doesn't need parallel updates.

### Medium Risk: Collections `[key: string]: unknown` index signature
**Risk:** The `Collections` interface has `[key: string]: unknown`. Some methods access collections via string keys (e.g., `allCollections.propertyAssignments`). When methods are extracted and receive typed parameters instead of the full Collections object, these string-key accesses must be converted to typed parameters.
**Mitigation:** Make extracted functions receive typed collection arrays, not the whole Collections object.

### Medium Risk: `allCollections` ref vs local variable aliasing in analyzeModule
**Risk:** In `graphBuilder.build()` call (lines 2253–2319), some collections are passed as `allCollections.branches || branches` — indicating that analyzeFunctionBody populates via the allCollections reference while the local variable is sometimes stale. This aliasing must be understood before touching analyzeModule.
**Mitigation:** Rob must audit every `allCollections.X || X` pattern and understand which collections are populated via reference (through handlers) vs local declaration.

### Low Risk: Module-level traversal blocks re-ordered
**Risk:** The 5 inline traversal blocks in analyzeModule have an implicit ordering. They must run after specific visitors (e.g., CallExpressionVisitor must run before the NewExpression traversal to avoid double-processing).
**Mitigation:** Maintain exact ordering when converting to visitor classes.

### Low Risk: extractNamesFromPattern binding
**Risk:** `this.extractVariableNamesFromPattern.bind(this)` is passed to visitors. After extraction, the utility is a free function — `extractVariableNamesFromPattern` (no bind needed).
**Mitigation:** Update all call sites from the bound method to the direct import.

---

## Phase 9: What Remains in JSASTAnalyzer.ts After All Extractions

```typescript
class JSASTAnalyzer extends Plugin {
  // Fields: graphBuilder, analyzedModules, profiler

  get metadata(): PluginMetadata { ... }                    // ~35 lines
  calculateFileHash(...)                                    // ~8 lines
  shouldAnalyzeModule(...)                                  // ~35 lines
  execute(...)                                              // ~156 lines (orchestration)
  private executeParallel(...)                              // ~82 lines (orchestration)
  async analyzeModule(...)                                  // ~200 lines (after extractions)
  analyzeFunctionBody(...)                                  // ~73 lines (entry point)
  private attachControlFlowMetadata(...)                    // 51 lines OR extract
  private getModuleNodes(...)                               // 7 lines
  private generateSemanticId(...)                           // 10 lines (keep, used locally)
  private generateAnonymousName(...)                        // 5 lines (keep, used locally)
}
```

**Estimated final size: 850–950 lines** — slightly above the 800 target but within the <1,000 acceptance criterion.

---

## Implementation Notes for Rob

### Do NOT change public API
The following public methods must maintain their exact signatures:
- `execute(context)` — Plugin interface
- `analyzeModule(module, graph, projectPath)` — called by tests
- `analyzeFunctionBody(funcPath, parentScopeId, module, collections)` — called by visitors
- `trackVariableAssignment(...)` — called by VariableVisitor (bound callback)
- `extractVariableNamesFromPattern(...)` — called by ImportExportVisitor, VariableVisitor

After extraction, `trackVariableAssignment` and `extractVariableNamesFromPattern` should become thin wrappers that delegate to the extracted free functions. The public signature stays; the implementation delegates. This allows the existing `bind(this)` call sites to continue working.

### Extract as Free Functions, Not Classes
Following the ReactAnalyzer (react-internal/) pattern: use free functions, not classes, unless the extracted group has mutable state that must be encapsulated. None of the groups identified above have private mutable state — they all receive collections as parameters and push to them. Free functions are the right choice.

### AnalyzerDelegate Must Be Updated Incrementally
Each time a method is extracted and the delegate entry becomes dead code, remove it from `AnalyzerDelegate.ts` IMMEDIATELY in the same commit. Do not let the interface accumulate dead entries.

### Test After Every Step
The rule: `pnpm build && snapshot tests pass` before moving to the next step. No multi-step commits without passing tests between them.

---

## Sources Referenced

- [Visitor Pattern - refactoring.guru](https://refactoring.guru/design-patterns/visitor)
- [Extract Class refactoring - refactoring.guru](https://refactoring.guru/extract-class)
- [Refactoring at Scale - Stefan Haas](https://stefanhaas.dev/blog/refactoring-at-scale/)
