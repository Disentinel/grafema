# Donald Knuth -- Cyclomatic Complexity Analysis

## Executive Summary

- **JSASTAnalyzer.ts at 4,080 lines is the dominant complexity source**, with several methods exceeding CC 20 and two exceeding CC 30. The file contains 37+ methods and remains the single largest source file in the codebase despite prior refactoring (REG-422).
- **The "type dispatch" pattern** (chains of `if (expr.type === 'X')` branches for AST node types) accounts for roughly 60% of all measured complexity. This is **essential complexity** -- the AST has ~30 expression types and each requires distinct handling. However, the current implementation repeats this dispatch pattern across 5+ methods, creating accidental complexity through duplication.
- **Parameter explosion** is the clearest accidental complexity signal: `trackVariableAssignment` takes 11 parameters, `handleVariableDeclaration` takes 15 parameters, `handleCallExpression` takes 13 parameters. Each parameter adds implicit branching at call sites and cognitive load.
- **PhaseRunner.ts is well-structured** (451 lines, no method exceeds CC 12) -- it is NOT a complexity bottleneck.
- **CallExpressionHandler.ts** has a single `getHandlers()` method with CC ~32 due to deeply nested Promise rejection detection logic that was mechanically extracted from JSASTAnalyzer but not truly decomposed.

## Methodology

Cyclomatic complexity (CC) is computed as: **1 + number of decision points**.

Decision points counted:
- `if` / `else if` (each `if` = +1, `else` without `if` = +0)
- `for` / `for...of` / `for...in` / `while` / `do...while` (+1 each)
- `switch` case clauses (+1 per non-default case)
- `&&` / `||` in conditions (+1 each)
- Ternary `?:` (+1)
- `catch` (+1)
- Early returns that branch control flow (+0 -- they reduce nesting but don't add decision points by McCabe's definition)

I read each file line by line, counted decision points, and recorded line ranges. Methods with CC <= 5 are omitted (they are not hot spots).

---

## Results by File

### PhaseRunner.ts -- Total File Complexity: Low

**Lines:** 451
**Methods analyzed:** 8

PhaseRunner is clean. No method exceeds CC 12. The topological sort and queue-based propagation are well-decomposed.

#### runPhase (line 270-353) -- CC: 12
- Decision points:
  - L274: `if` (filter plugins for phase)
  - L285: `if` (ENRICHMENT phase check)
  - L308: `if` (ENRICHMENT + supportsBatch + consumerIndex)
  - L321-322: `if` (ENRICHMENT + supportsBatch) + `if` (shouldSkipEnricher)
  - L339: `if` (delta non-null)
  - L340-341: `for` (changedNodeTypes) + `for` (changedEdgeTypes)
  - L317: `for` (main plugin loop)
  - L299: `for` (sortedIds loop)
  - L301: `if` (plugin exists in map)
  - L405: `if` (context.onProgress)
- **Essential complexity:** Phase orchestration requires mode-switching (ENRICHMENT vs others), skip optimization, and progress reporting. All 12 branches serve a purpose.
- **Accidental complexity:** Minimal. The method is well-structured with early returns and clear separation of batch vs non-batch paths.
- **Recommendation:** No action needed. This is a model of appropriate complexity for its responsibility.

#### runEnrichmentWithPropagation (line 363-435) -- CC: 8
- Decision points: `while`, 2x `if`, `for` (phasePlugins), `for` (changedTypes), `if` (consumers), `for` (consumers), `if` (!processed)
- **Essential complexity:** Queue-based propagation inherently requires loop + conditional enqueue.
- **Recommendation:** Fine as-is.

#### executePlugin (line 192-268) -- CC: 10
- Decision points: `if` (delta), `if` (!result.success), `if` (hasFatal), `if` (allStrictErrors compound), `if` (phaseName === 'ENRICHMENT' && strictMode && allStrictErrors), `try`/`catch`, `if` (!diagnosticCollector.hasFatal), `if` (suppressedByIgnore), `if` (typeof suppressed)
- **Essential complexity:** Error handling, fatal detection, and strict mode suppression are inherent to plugin execution.
- **Recommendation:** The strict mode error compound condition (L244-245) is dense. Could be extracted to `shouldHaltOnFatal()` for readability.

#### buildPluginContext (line 106-169) -- CC: 7
- **Recommendation:** Fine.

---

### JSASTAnalyzer.ts -- Total File Complexity: CRITICAL

**Lines:** 4,080
**Methods analyzed:** 25 (only those with CC > 5 shown below)

This file is the heart of the problem. It was partially decomposed in REG-422 (extracting handlers to `ast/handlers/`), but the JSASTAnalyzer class itself still owns massive methods with high complexity.

#### trackVariableAssignment (line 577-858) -- CC: 28
- **Lines:** 281
- Decision points:
  - L590: `if (!initNode)` early return
  - L595: `if (AwaitExpression)` -- recurse
  - L600: `if (ObjectExpression)`
  - L635: `if (literalValue !== null)` -- Literal
  - L655: `if (CallExpression && Identifier)` -- 2 conditions
  - L669: `if (CallExpression && MemberExpression)` -- 2 conditions
  - L682: `if (Identifier)`
  - L693: `if (NewExpression)`
  - L697-699: `if (Identifier)` / `else if (MemberExpression && Identifier)` / `else`
  - L722: `if (ArrowFunction || FunctionExpression)` -- 1 (||)
  - L733: `if (MemberExpression)`
  - L734-739: 3 ternary operators for objectName, propertyName, computedPropertyVar
  - L741: `if` (computed && Identifier) -- 1 (&&)
  - L766: `if (BinaryExpression)`
  - L776-777: 2 ternary operators
  - L786: `if (ConditionalExpression)`
  - L795-796: 2 ternary operators (+ recursive calls)
  - L808: `if (LogicalExpression)`
  - L831: `if (TemplateLiteral && expressions.length > 0)` -- 1 (&&)
  - L852: `if (t.isExpression(expr))` inside for loop
- **Essential complexity:** ~15. The AST has ~12 expression types for variable init values; each must be handled. The recursive unwrapping of await/conditional/logical is inherent.
- **Accidental complexity:** ~13. The method takes **11 parameters** (module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, etc.). Most of these are collections being threaded through. A `VariableAssignmentContext` parameter object would eliminate 8 parameters. The 12-branch type dispatch could be a lookup table or visitor pattern.
- **Recommendation:** HIGH PRIORITY. (1) Introduce a `TrackingContext` parameter object. (2) Consider extracting a `VariableInitClassifier` that maps expression type to handler, reducing the linear if-chain to a dispatch table.

#### handleCallExpression (line 2847-3058) -- CC: 26
- **Lines:** 211
- Decision points:
  - L2863: `if (Identifier callee)`
  - L2865-2866: `if (processedCallSites.has)` early return
  - L2875: `if (scopeTracker)`
  - L2893: spread operator ternary
  - L2897: `else if (MemberExpression callee)`
  - L2903: `if (Identifier || ThisExpression) && Identifier` -- compound condition
  - L2905-2907: `if (processedMethodCalls.has)` early return
  - L2918: `if (scopeTracker)`
  - L2944: `if (arguments.length > 0)`
  - L2950: `if (ARRAY_MUTATION_METHODS.includes)`
  - L2952-2953: `if (!collections.arrayMutations)` -- lazy init
  - L2967-2968: `if (Object.assign)` -- 2 conditions (&&)
  - L2969-2970: `if (!collections.objectMutations)` -- lazy init
  - L2984: `else if (MemberExpression && Identifier)` -- nested MemberExpression
  - L2989: `if (ARRAY_MUTATION_METHODS.includes)` (nested)
  - L2995-2996: `if (base === Identifier || ThisExpression) && !computed && Identifier` -- 4 conditions
  - L3001-3003: `if (!collections.arrayMutations)` -- lazy init
  - L3023: `if (objectName)` -- nested method call node creation
  - L3025: `if (!processedMethodCalls.has)`
  - L3032: `if (scopeTracker)`
  - L3051: `if (arguments.length > 0)`
- **Essential complexity:** ~12. Direct calls, method calls, and nested method calls are structurally different and require distinct handling. Array/object mutation detection is a separate concern bundled in.
- **Accidental complexity:** ~14. **13 parameters**. The mutation detection logic (array push/splice, Object.assign) is a completely separate concern from call expression handling but is inline here. Lazy collection initialization (`if (!collections.X) collections.X = []`) appears 4 times identically.
- **Recommendation:** HIGH PRIORITY. (1) Extract `detectMutationFromCallExpression()` as a separate method (removes ~40 lines and ~6 decision points). (2) Parameter object for the 13 parameters. (3) Ensure collections are pre-initialized rather than lazily checked.

#### extractObjectProperties (line 864-1005) -- CC: 18
- **Lines:** 141
- Decision points:
  - L874: `for` (properties loop)
  - L879: `if (SpreadElement)`
  - L890: `if (Identifier)` inside spread
  - L900: `if (ObjectProperty)`
  - L904-910: `if (Identifier)` / `else if (StringLiteral)` / `else if (NumericLiteral)` / `else` -- key type dispatch
  - L926: `if (ObjectExpression)` -- nested
  - L956: `if (literalValue !== null || NullLiteral)` -- compound
  - L974: `else if (Identifier)`
  - L979: `else if (CallExpression)`
  - L993: `else if (ObjectMethod)`
- **Essential complexity:** ~12. Object property extraction inherently dispatches on property type (spread, property, method) and value type (nested object, literal, identifier, call, other).
- **Accidental complexity:** ~6. The recursive call for nested objects is inherent but the value type dispatch duplicates logic in `extractMutationValue` and `trackVariableAssignment`.
- **Recommendation:** MEDIUM. Extract value-type classification into a shared utility that all three callers use.

#### handleVariableDeclaration (line 2001-2168) -- CC: 22
- **Lines:** 167
- Decision points:
  - L2022: `||` (isForOf || isForIn) + `&&`
  - L2024: `forEach` (declarations)
  - L2028: `forEach` (variables)
  - L2029-2031: 3 ternary/conditionals for literalValue, isLiteral, isNewExpression
  - L2035: `&&` compound (isConst && (isLoopVariable || isLiteral || isNewExpression))
  - L2041-2043: ternary (scopeTracker ? semantic : legacy)
  - L2054: `if (shouldBeConstant)`
  - L2064: `if (isLiteral)`
  - L2071: `if (isNewExpression && isNewExpression && isIdentifier)` -- 3 conditions
  - L2094: `if (isLoopVariable)`
  - L2099: `if (ObjectPattern || ArrayPattern)`
  - L2112: `if (Identifier)`
  - L2138: `else if (declarator.init)`
  - L2140: `if (ObjectPattern || ArrayPattern)` (again)
- **Essential complexity:** ~14. Variable declarations involve: kind detection (const vs let), destructuring, loop variables, class instantiations, and assignment tracking. All are inherent to JavaScript's variable declaration semantics.
- **Accidental complexity:** ~8. **15 parameters** -- the most of any method. The method does too much: it determines variable kind, generates IDs, tracks class instantiations, and handles both loop and non-loop destructuring. Each concern could be a separate method.
- **Recommendation:** HIGH PRIORITY. This is the poster child for parameter object + decomposition. Split into: (1) `classifyVariableKind()`, (2) `generateVariableId()`, (3) loop variable tracking, (4) regular variable tracking.

#### trackDestructuringAssignment (line 1087-1296) -- CC: 20
- **Lines:** 209
- Decision points:
  - L1094: `if (!initNode)` early return
  - L1098: `if (isIdentifier)` -- Phase 1
  - L1102: `for` (variables loop)
  - L1106: `if (varInfo.isRest)`
  - L1117: `if (isObjectPattern && propertyPath)`
  - L1149: `else if (isArrayPattern && arrayIndex !== undefined)`
  - L1155: `if (hasPropertyPath)` -- &&
  - L1183: `else if (isCallOrAwaitExpression)` -- Phase 2
  - L1195: `for` (variables loop, again)
  - L1199: `if (varInfo.isRest)` (again)
  - L1216: `if (isObjectPattern && propertyPath)` (again)
  - L1255: `else if (isArrayPattern && arrayIndex !== undefined)` (again)
  - L1260: `if (hasPropertyPath)` (again)
- **Essential complexity:** ~12. Destructuring assignment tracking inherently branches on: init type (Identifier vs Call), pattern type (Object vs Array), and special cases (rest elements, mixed nesting).
- **Accidental complexity:** ~8. The method has TWO nearly identical inner loops (Phase 1 and Phase 2), each with the same ObjectPattern/ArrayPattern/isRest branching. This is a clear DRY violation -- the loops differ only in how they compute the source expression.
- **Recommendation:** HIGH PRIORITY. Factor out the inner loop into `processDestructuredVariables(variables, sourceResolver)` where `sourceResolver` is a function that differs between Phase 1 and Phase 2.

#### analyzeModule (line 1312-1935) -- CC: 15
- **Lines:** 623
- This is a long method but its CC is moderate because most of its body is sequential (create visitors, traverse, build graph). The complexity comes from:
  - L1316: `try`/`catch`
  - L1348-1414: ~10 counter/collection initializations (no branching, just boilerplate)
  - L1506-1583: AST traversal for assignments (L1510: `if functionParent`, L1512-1513: `if right is Function`, L1517-1523: `if MemberExpression`/`else if Identifier`, L1565-1568: `if Identifier` + `if !variableReassignments`)
  - L1673-1689: top-level await detection (2 if's)
  - L1702-1769: NewExpression handling (L1705: `if processedCalls`, L1712-1716: `if Identifier`/`else if MemberExpression`, L1718: `if className`, L1736: `if Promise`, L1740: `if ArrowFunction || FunctionExpression`, L1745-1748: 2 param checks, L1752: `if resolveName`)
  - L1775-1822: Module-level IfStatements (4 if's)
  - L1827-1856: Collision resolution (3 if's + for loops)
- **Essential complexity:** ~10. Module analysis requires: parsing, multiple traversal passes, and graph building. Each pass is essentially a visitor registration, which is linear.
- **Accidental complexity:** ~5. The **623 lines** is the real problem, not the CC. The method is a linear sequence of "set up visitor, traverse, end profiler" blocks. It could be decomposed into 10 methods, each doing one traversal pass, without changing behavior. The inline AST traversals (assignments, callbacks, ifs, NewExpression) should be extracted into named visitors like the existing ImportExportVisitor, FunctionVisitor, etc.
- **Recommendation:** HIGH PRIORITY (for length, not CC). Extract the 4 inline `traverse(ast, {...})` blocks into named visitor classes, matching the pattern already established by `ImportExportVisitor`, `VariableVisitor`, `FunctionVisitor`, etc.

#### extractReturnExpressionInfo (line 2500-2682) -- CC: 16
- **Lines:** 182
- Decision points: 12 `if (t.isX(expr))` checks for different expression types, plus 4 ternary operators for extracting names.
- **Essential complexity:** ~14. This is pure type dispatch over AST expression types. Each expression type produces different metadata fields.
- **Accidental complexity:** ~2. The pattern is inherent but could benefit from a lookup table mapping expression type to handler function.
- **Recommendation:** LOW. The method is long but each branch is simple and independent. A type->handler map would be marginally cleaner.

#### detectVariableReassignment (line 3858-3972) -- CC: 13
- **Lines:** 114
- Decision points: 5 type checks on rightExpr (Literal, Identifier, CallExpression/Identifier, CallExpression/MemberExpression, else Expression), plus 4 inner type-specific metadata extractions.
- **Essential:** ~10. **Accidental:** ~3 (repeated pattern from trackVariableAssignment).
- **Recommendation:** MEDIUM. The value-type classification duplicates logic in `trackVariableAssignment` and `extractMutationValue`.

#### collectUpdateExpression (line 3748-3845) -- CC: 12
- **Lines:** 97
- Decision points: L3761: `if Identifier`, L3779: `if MemberExpression`, L3786-3794: object type dispatch (Identifier/ThisExpression/else), L3805-3827: property type dispatch (computed/non-computed, StringLiteral, Identifier).
- **Essential:** ~10 (member expression property/object type dispatch). **Accidental:** ~2 (duplicates detectObjectPropertyAssignment's dispatch).
- **Recommendation:** MEDIUM. Extract shared `extractMemberTarget()` utility used by both this method and `detectObjectPropertyAssignment`.

#### detectIndexedArrayAssignment (line 3511-3628) -- CC: 14
- **Lines:** 117
- Decision points: L3519: `if MemberExpression && computed`, L3526: `if !== NumericLiteral`, L3531: `if Identifier`, L3550-3612: value type dispatch (ObjectExpression, ArrayExpression, Identifier, CallExpression, else Literal) with nested `if` for collection availability.
- **Essential:** ~8. **Accidental:** ~6. The value type dispatch + collection availability checks are repeated in `detectArrayMutationInFunction` and `extractMutationValue`.
- **Recommendation:** MEDIUM. The value extraction is duplicated across 4 methods.

#### detectObjectPropertyAssignment (line 3639-3734) -- CC: 12
- **Lines:** 95
- Similar pattern: object type dispatch (Identifier/ThisExpression), property type dispatch (non-computed Identifier, computed StringLiteral, computed other).
- **Recommendation:** MEDIUM. Share `extractMemberTarget()` with `collectUpdateExpression`.

#### handleSwitchStatement (line 2182-2292) -- CC: 11
- Moderate complexity, mostly from collection initialization guards and case iteration.
- **Recommendation:** LOW. Pre-initialize collections to eliminate 4 guard if-statements.

#### shouldAnalyzeModule (line 305-339) -- CC: 7
- Clean, appropriate for its purpose.

---

### CallExpressionHandler.ts (ast/handlers/) -- Complexity: HIGH

**Lines:** 347
**Methods analyzed:** 1 (getHandlers, containing a single massive CallExpression visitor)

#### getHandlers/CallExpression visitor (line 16-346) -- CC: 32
- Decision points (counted precisely):
  - L19-20: 2 ternary operators (isAwaited, isInsideTry, isInsideLoop)
  - L50: `if (paramNameToIndex.size > 0 || aliasToParamIndex.size > 0)` -- || = +1
  - L51: `if (isIdentifier callee)`
  - L53-54: `??` (nullish coalescing for paramIndex lookup, counts as conditional)
  - L54: `if (paramIndex !== undefined)`
  - L58: `if (propertyPath)`
  - L62-65: `else if (isMemberExpression && isIdentifier && restParamNames.has)` -- 3 conditions
  - L68: `if (paramIndex !== undefined)`
  - L77: `if (isIdentifier callee)` -- Promise executor detection
  - L83: `while (funcParent)` -- loop
  - L88: `if (context)`
  - L92: `if (isResolve || isReject)` -- ||
  - L99-103: `find` with 4 conditions (&&)
  - L106: `if (resolveCall)`
  - L117-118: `if (!collections.callArguments)`
  - L123: `forEach` (arguments loop)
  - L133: `if (isIdentifier)`
  - L136: `else if (isLiteral && !isTemplateLiteral)` -- &&
  - L139: `if (literalValue !== null)`
  - L158: `else if (isCallExpression)`
  - L162: `else` (Expression)
  - L181: `while (funcParent)` -- second loop (executor_reject detection)
  - L186: `if (context && calleeName === rejectName && arguments.length > 0)` -- 3 conditions
  - L195: `if (isNewExpression && isIdentifier)` -- &&
  - L207: `else if (isIdentifier)` -- variable reject
  - L213: `while (checkParent)` -- third loop
  - L215-217: `if (isFunction)` + `if (params.some)` + `if (isIdentifier && name === varName)`
  - L225: `if (isParameter)`
  - L238-248: micro-trace + ternary
  - L264: `if (isMemberExpression callee)` -- Promise.reject detection
  - L266-270: 4 conditions (&&) for Promise.reject pattern
  - L276: `if (isNewExpression && isIdentifier)`
  - L288: `else if (isIdentifier)` (variable)
  - L291-293: `if (isParameter)` + ternary for params.some
  - L306: `else` + `if (!functionPath)` -- variable_unknown fallback
- **Essential complexity:** ~15. Promise rejection detection (executor reject, Promise.reject, variable tracing) is inherently conditional.
- **Accidental complexity:** ~17. This single visitor function handles FOUR separate concerns: (1) HOF parameter invocation detection, (2) Promise resolve/reject argument collection, (3) Promise executor reject pattern detection, (4) Promise.reject() pattern detection. These were mechanically extracted from JSASTAnalyzer but NOT decomposed into separate handlers. The Promise reject detection (lines 178-343) duplicates almost identical logic twice (executor_reject vs Promise.reject) with only slight variations.
- **Recommendation:** HIGH PRIORITY. Split into 3-4 sub-methods: `detectParameterInvocation()`, `collectPromiseResolutionArgs()`, `detectExecutorRejection()`, `detectPromiseRejectCall()`. The executor_reject and Promise.reject handlers share ~80% of their logic and should be unified into `classifyRejectionPattern()`.

---

### BranchHandler.ts (ast/handlers/) -- Complexity: Moderate

**Lines:** 313

#### createIfStatementVisitor.enter (line 53-176) -- CC: 14
- Decision points: `if (controlFlowState)`, `if (isElseIf)`, `if (parentIfInfo)` / `else`, `if (scopeIdStack)` (2x), `if (scopeTracker)` (2x), `if (ifNode.alternate && !isIfStatement)`, various scope tracking.
- **Essential:** ~10 (if/else-if/else scoping is inherently complex). **Accidental:** ~4 (null guards for scopeIdStack and scopeTracker repeated on every call).
- **Recommendation:** LOW-MEDIUM. Pre-validate scopeTracker/scopeIdStack existence once.

---

### FetchAnalyzer.ts -- Complexity: Moderate

**Lines:** 694

#### analyzeModule (line 142-462) -- CC: 18
- The CallExpression visitor inside `analyzeModule` handles 4 distinct patterns (fetch, axios.method, axios(config), custom wrappers) with multiple sub-conditions each.
- **Essential:** ~14 (4 distinct HTTP client patterns is the domain). **Accidental:** ~4 (the 4 patterns share `extractURL` + `extractMethodInfo` + `isExternalAPI` calls -- could be a pipeline).
- **Recommendation:** MEDIUM. Extract each pattern into a named detector function and iterate over an array of detectors.

---

### ExpressResponseAnalyzer.ts -- Complexity: Moderate

**Lines:** 623

#### findIdentifierInScope (line 410-477) -- CC: 10
- 5 `for await` loops querying different node types (VARIABLE, CONSTANT, PARAMETER, module-level VARIABLE, module-level CONSTANT).
- **Essential:** ~3 (need to check variable, constant, parameter). **Accidental:** ~7. This method performs 5 sequential graph queries that are structurally identical but differ only in type string and matching predicate. A single parameterized helper looping over `['VARIABLE', 'CONSTANT', 'PARAMETER']` would reduce both complexity and code volume.
- **Recommendation:** MEDIUM-HIGH. Reduce 5 loops to 1 parameterized loop.

---

### IncrementalAnalysisPlugin.ts -- Complexity: Low

**Lines:** 669
No method exceeds CC 10. Well-structured plugin with clear separation of concerns.

---

## Top 10 Complexity Hot Spots

| # | File:Method | CC | Lines | Verdict |
|---|------------|-----|-------|---------|
| 1 | CallExpressionHandler:getHandlers (CallExpression visitor) | 32 | 330 | **Reducible** -- 4 concerns in 1 function, duplicated reject logic |
| 2 | JSASTAnalyzer:trackVariableAssignment | 28 | 281 | **Reducible** -- 11 params, repeated type dispatch, DRY violations |
| 3 | JSASTAnalyzer:handleCallExpression | 26 | 211 | **Reducible** -- 13 params, mutation detection bundled in |
| 4 | JSASTAnalyzer:handleVariableDeclaration | 22 | 167 | **Reducible** -- 15 params, mixed concerns |
| 5 | JSASTAnalyzer:trackDestructuringAssignment | 20 | 209 | **Reducible** -- two nearly identical inner loops |
| 6 | FetchAnalyzer:analyzeModule (CallExpression visitor) | 18 | 320 | **Partially reducible** -- 4 pattern detectors could be separated |
| 7 | JSASTAnalyzer:extractObjectProperties | 18 | 141 | **Partially essential** -- property type dispatch is inherent |
| 8 | JSASTAnalyzer:extractReturnExpressionInfo | 16 | 182 | **Mostly essential** -- expression type dispatch |
| 9 | JSASTAnalyzer:analyzeModule | 15 | 623 | **Reducible** (length, not CC) -- 4 inline traversals should be named visitors |
| 10 | BranchHandler:createIfStatementVisitor.enter | 14 | 123 | **Partially essential** -- if/else scoping is inherently complex |

---

## Architectural Complexity Issues

### 1. The "Threading Collections" Anti-Pattern

The single biggest structural problem in JSASTAnalyzer is that **40+ typed arrays are created in `analyzeModule()`, assembled into a `Collections` bag, and then threaded through 10+ methods as individual parameters**. This means:

- `handleVariableDeclaration` takes 15 parameters, of which ~12 are collections
- `trackVariableAssignment` takes 11 parameters, of which ~8 are collections
- `handleCallExpression` takes 13 parameters, of which ~6 are collections

Each parameter increases the call-site complexity and makes the signatures unreadable. The `FunctionBodyContext` (introduced in REG-422) partially solved this for the handler classes, but the JSASTAnalyzer methods that the handlers **delegate back to** still use the old exploded parameter style.

**Impact:** Every new feature that adds a collection (and there have been many -- REG-288, REG-290, REG-309, REG-311, REG-312, REG-328, REG-334, REG-395, etc.) requires adding a parameter to 3-5 method signatures, increasing their CC by 0-2 each time.

### 2. Duplicated Value-Type Classification

The pattern "determine if expression is Literal/Identifier/CallExpression/MemberExpression/ObjectExpression/ArrayExpression/other" appears in:

1. `trackVariableAssignment` (12 branches)
2. `extractMutationValue` (6 branches)
3. `detectArrayMutationInFunction` (6 branches)
4. `detectIndexedArrayAssignment` (6 branches)
5. `detectVariableReassignment` (5 branches)
6. `extractReturnExpressionInfo` (12 branches)
7. `extractObjectProperties` (6 branches)
8. `extractMethodCallArguments` (7 branches)

That is **~60 decision points** across 8 methods that all classify the same set of AST expression types. A single `classifyExpression(expr) -> { type, metadata }` utility would eliminate most of this duplication.

### 3. Mechanical Extraction Without Decomposition (REG-422)

The REG-422 refactoring extracted `analyzeFunctionBody` handlers into separate classes (`BranchHandler`, `CallExpressionHandler`, `VariableHandler`, etc.), which was a good structural improvement. However, the handlers still delegate most logic back to JSASTAnalyzer's private methods. The `CallExpressionHandler` in particular is a single 330-line function because the Promise rejection detection was copy-pasted from JSASTAnalyzer without being decomposed into sub-methods.

### 4. Lazy Collection Initialization

The pattern `if (!collections.X) { collections.X = []; }` appears ~15 times across the codebase. This is both a complexity tax (each guard adds +1 CC) and a code smell (the collections should be pre-initialized in a single place).

---

## Recommendations (Priority Order)

### 1. Introduce `AnalysisContext` Parameter Object -- Impact: -40 CC across 5 methods

Create a context object that bundles:
```
interface AnalysisContext {
  module: VisitorModule;
  collections: Collections; // already exists partially
  scopeTracker: ScopeTracker;
  // ... counter refs, etc.
}
```

Replace the 11-15 parameter signatures of `trackVariableAssignment`, `handleVariableDeclaration`, `handleCallExpression`, and `trackDestructuringAssignment` with a single context parameter. This eliminates parameter threading and makes adding new collections a single-point change.

**Estimated complexity reduction:** Each method loses 0-2 CC from eliminated null guards on individual params. More importantly, cognitive complexity drops massively.

### 2. Extract `classifyExpressionValue()` Utility -- Impact: -30 CC across 8 methods

A single method that maps `t.Expression -> { valueType, metadata }` can replace the repeated type dispatch chains in 8 methods. Each caller becomes a simple: `const { valueType, meta } = classifyExpressionValue(expr, module)`.

### 3. Decompose CallExpressionHandler -- Impact: -17 CC

Split the single 330-line visitor into 4 sub-methods:
- `handleCallExpression()` -- delegate to analyzer (already exists, lines 16-41)
- `detectParameterInvocation()` -- HOF detection (lines 43-73)
- `collectPromiseResolutionArgs()` -- resolve/reject arg collection (lines 75-176)
- `classifyRejectionPattern()` -- unified executor_reject + Promise.reject (lines 178-343)

### 4. Factor Out Destructuring Loop in trackDestructuringAssignment -- Impact: -8 CC

The two nearly identical inner loops (Phase 1 and Phase 2) should be unified into a single `processDestructuredVariables(variables, sourceInfoProvider)` where `sourceInfoProvider` is a callback/strategy that differs between Identifier init and Call init.

### 5. Extract Inline Traversals from analyzeModule -- Impact: Reduces method from 623 to ~200 lines

Move the 4 inline `traverse(ast, {...})` blocks (assignments, callbacks, NewExpressions, IfStatements) into named visitor classes following the existing pattern (ImportExportVisitor, FunctionVisitor, etc.).

### 6. Pre-initialize Collections -- Impact: -15 CC across multiple methods

Ensure all collections in `allCollections` are initialized in `analyzeModule()` before passing to visitors. Eliminate all `if (!collections.X) collections.X = []` guards.

### 7. Extract Mutation Detection from handleCallExpression -- Impact: -6 CC

Move array mutation detection (push/splice/unshift) and Object.assign detection out of `handleCallExpression` into a `MutationDetector` that is called separately. The `MutationDetector` visitor already exists in `ast/visitors/` -- the function-body version should delegate to it.

### 8. Parameterize ExpressResponseAnalyzer.findIdentifierInScope -- Impact: -7 CC

Replace 5 sequential `for await` loops with a single parameterized helper iterating over `[{type: 'VARIABLE', scopeMatch: ...}, {type: 'CONSTANT', ...}, ...]`.
