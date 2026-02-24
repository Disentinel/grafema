## Uncle Bob — Code Quality Review

**Verdict:** REJECT

---

## File Sizes

**CRITICAL (> 500 lines — MUST SPLIT):**

| File | Lines |
|------|-------|
| `ast/extractors/VariableAssignmentTracker.ts` | **988** |
| `ast/mutation-detection/mutation-detection.ts` | **784** |

**FLAG (> 300 lines):**

| File | Lines |
|------|-------|
| `ast/extractors/CallExpressionExtractor.ts` | 336 |
| `ast/extractors/SwitchStatementAnalyzer.ts` | 314 |

The rest of the new files (createCollections, toASTCollections, expression-helpers, ModuleLevelExtractors, etc.) are within acceptable range.

**Pre-existing files that remain untouched and exceed 500 lines (not blocking this PR, but noted for backlog):**
- `ast/types.ts` — 1338 lines (type definition file, different category)
- `ast/visitors/ClassVisitor.ts` — 1057 lines

---

## Method Quality

**CRITICAL violations (> 50 lines = MUST SPLIT):**

### 1. `trackVariableAssignment` — 466 lines (VariableAssignmentTracker.ts:23–488)

This is the worst offender. A single function with 19 numbered branches (0 through 19), each handling a different AST expression type. It also recurses into itself across 9 call sites, each passing 13 arguments. This is not a function — it is a dispatch table masquerading as a function.

The refactoring moved these 466 lines out of JSASTAnalyzer into a new file, but did not reduce the function's complexity. A file that exists only to hold one 466-line function is not a refactoring — it is relocation.

Required fix: introduce an expression-type dispatch map or dedicated handler per expression type (`LiteralAssignmentHandler`, `CallAssignmentHandler`, `MemberExpressionAssignmentHandler`, etc.), reducing each case to a small, named, testable function.

### 2. `trackDestructuringAssignment` — 357 lines (VariableAssignmentTracker.ts:632–988)

Same pattern: a long if-else chain across 7 "phases" (also numbered 1–7), handling different init expression types for destructuring. Phases 3–5 duplicate the object/array index logic from Phases 1–2 with minor variations.

Required fix: same dispatch approach. The per-phase logic can each be a named function of 20–50 lines.

### 3. Recursive 13-argument call signature

`trackVariableAssignment` takes 13 parameters and calls itself recursively at 9 call sites. A function with 13 parameters has zero chance of being called correctly. The intended fix is a context object (`AssignmentTrackingContext`) carrying all the collection refs, which would reduce every recursive call to two arguments: `(expression, context)`.

### 4. `detectObjectPropertyAssignment` — 168 lines (mutation-detection.ts)

Exceeds the candidate-for-split threshold (> 50 lines). Not blocking on its own, but combined with the overall file size (784 lines), it should be split.

### 5. `collectUpdateExpression` — 117 lines (mutation-detection.ts)

Same threshold. The MEMBER_EXPRESSION branch (lines 504–577) duplicates the object-name and property-name extraction logic that already exists in `detectObjectPropertyAssignment`. This is duplication, not just size.

---

## Patterns and Naming

**Inconsistency in extractor file naming convention:**

The `ModuleLevel*` files follow a uniform factory function pattern (`createModuleLevelXxxVisitor`) and are clean and consistent. However, the main "extractor" files (`VariableAssignmentTracker.ts`, `CallExpressionExtractor.ts`) use free function exports with names like `trackVariableAssignment` and `handleCallExpression` — different verbs, different conventions. The `SwitchStatementAnalyzer.ts` uses `handleSwitchStatement` (verb: handle). The `VariableDeclarationExtractor.ts` uses `handleVariableDeclaration` (verb: handle). The `CallExpressionExtractor.ts` uses `handleCallExpression` (verb: handle). But `VariableAssignmentTracker.ts` uses `trackVariableAssignment` (verb: track). Minor, but worth aligning.

**`ARRAY_MUTATION_METHODS` constant defined twice in CallExpressionExtractor.ts (lines 133 and 171):**

```typescript
// Line 133
const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];

// Line 171 — identical
const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
```

This is a direct DRY violation. The constant should be module-level.

---

## Duplication

**Value type determination logic duplicated across three locations:**

The pattern of checking `ObjectExpression → OBJECT_LITERAL`, `ArrayExpression → ARRAY_LITERAL`, `Identifier → VARIABLE`, `CallExpression → CALL`, `extractLiteralValue → LITERAL` appears in:

1. `detectArrayMutationInFunction` (mutation-detection.ts lines 69–85)
2. `detectIndexedArrayAssignment` (mutation-detection.ts lines 169–231)
3. `detectObjectAssignInFunction` (mutation-detection.ts lines 750–763)
4. `extractMutationValue` (mutation-detection.ts lines 252–295)

The `extractMutationValue` function exists precisely to consolidate this pattern, but `detectArrayMutationInFunction` and `detectObjectAssignInFunction` do not use it — they inline the same logic. Three of the four sites should delegate to `extractMutationValue`. The function was extracted but not adopted.

**Object-name and property-name extraction logic duplicated between `detectObjectPropertyAssignment` and `collectUpdateExpression`:**

The code that extracts `objectName` from `Identifier|ThisExpression`, captures `enclosingClassName` via `scopeTracker.getEnclosingScope('CLASS')`, extracts `enclosingFunctionName` via `scopeTracker.getEnclosingScope('FUNCTION')`, and determines `propertyName`/`mutationType` from computed/non-computed member expressions appears verbatim (modulo variable names) in both functions. Lines 330–376 in `detectObjectPropertyAssignment` and lines 508–558 in `collectUpdateExpression` are structurally identical. A shared `extractMemberAssignmentTarget(memberExpr, scopeTracker)` helper should replace both.

---

## Import Hygiene

No circular imports detected. All imports resolve to peer modules or upward to `core/`. No unused imports found in the new files.

The `collections.scopeTracker as ScopeTracker | undefined` cast in `CallExpressionExtractor.ts` (line 321) is acceptable — it accesses a dynamically-attached field on `VisitorCollections`. Not ideal, but not a blocker.

---

## JSASTAnalyzer.ts (855 lines) — Orchestration Check

`analyzeModule` is now genuinely orchestration: it creates collections, runs traversals, and delegates all extraction. The method is ~240 lines which is on the high end but defensible given the number of traversal phases.

`analyzeFunctionBody` (~70 lines) is clean orchestration: creates context, creates handlers, merges visitors, single traversal, two post-traversal steps.

`attachControlFlowMetadata` is ~50 lines. It is at the boundary and could be moved into `FunctionBodyContext` or a dedicated `ControlFlowMetadataBuilder`, but it is not a blocker.

The ID collision resolution block in `analyzeModule` (lines 667–697) is ~30 lines of inline logic that could be a private method `resolveIdCollisions(pendingNodes, allCollections)`, but again not blocking.

Overall, JSASTAnalyzer.ts is genuinely orchestration-only now. The class no longer contains AST-processing logic. That goal was achieved.

---

## Summary of Required Fixes Before Approval

1. **Split `VariableAssignmentTracker.ts` (988 lines, 466-line and 357-line methods).**
   - Introduce `AssignmentTrackingContext` to eliminate the 13-argument recursive signature.
   - Extract per-expression-type handlers for `trackVariableAssignment`.
   - The file should not exceed 500 lines after splitting.

2. **Split `mutation-detection.ts` (784 lines).**
   - Minimum: separate `detectVariableReassignment` and `collectUpdateExpression` into their own file (they are conceptually distinct from the mutation detection functions).
   - Apply `extractMutationValue` inside `detectArrayMutationInFunction` and `detectObjectAssignInFunction` to eliminate the duplicated value-type dispatch.
   - Extract the shared member-expression-target logic into a helper.

3. **Remove duplicate `ARRAY_MUTATION_METHODS` constant in `CallExpressionExtractor.ts`.**
   - Promote to module-level constant.

4. **Remove `console.warn` from `VariableAssignmentTracker.ts:482`.**
   - Production analysis code must not write to stdout/stderr via console. Use the plugin logger pattern or emit an ISSUE node if an unhandled expression type is a product-relevant warning.
