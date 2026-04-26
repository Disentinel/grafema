# Don Melton: Analysis & Plan for REG-534

## Problem Statement

1414 VARIABLE/CONSTANT nodes have zero assignment edges (no ASSIGNED_FROM, DERIVES_FROM, or FLOWS_INTO). `trackVariableAssignment()` has 11 expression type branches and falls through silently when none match.

## Current State Analysis

### Two Separate Code Paths

There are **two completely separate** variable-tracking code paths:

1. **Module-level** (`VariableVisitor.ts` lines 200-483): Handles top-level `const/let/var` declarations. Has its own destructuring logic plus delegates to `trackVariableAssignment` for "normal" (non-destructuring) assignments.

2. **Function-level** (`JSASTAnalyzer.handleVariableDeclaration()` lines 2038-2205): Handles variables inside function bodies. Has its own destructuring via `trackDestructuringAssignment()`, delegates to `trackVariableAssignment` for simple assignments.

Both paths ultimately call `trackVariableAssignment()` for non-destructuring cases. The function-level path correctly detects destructuring patterns via `t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)` at line 2177 and routes them to `trackDestructuringAssignment()`.

### What `trackVariableAssignment()` Currently Handles (11 branches)

| # | Type | What it does |
|---|------|-------------|
| 0 | `AwaitExpression` | Unwraps and recurses into `.argument` |
| 0.5 | `ObjectExpression` | Creates OBJECT_LITERAL node + ASSIGNED_FROM edge |
| 1 | Literal (via `extractLiteralValue`) | Creates LITERAL node + ASSIGNED_FROM edge |
| 2 | `CallExpression` + `Identifier` callee | Creates CALL_SITE assignment |
| 3 | `CallExpression` + `MemberExpression` callee | Creates METHOD_CALL assignment |
| 4 | `Identifier` | Creates VARIABLE assignment |
| 5 | `NewExpression` | Creates CONSTRUCTOR_CALL assignment |
| 6 | `ArrowFunctionExpression` / `FunctionExpression` | Creates FUNCTION assignment |
| 7 | `MemberExpression` (without call) | Creates EXPRESSION node (MemberExpression) |
| 8 | `BinaryExpression` | Creates EXPRESSION node |
| 9 | `ConditionalExpression` | Creates EXPRESSION node + recurses |
| 10 | `LogicalExpression` | Creates EXPRESSION node + recurses |
| 11 | `TemplateLiteral` (with expressions) | Creates EXPRESSION node + recurses |

### What Falls Through Silently

The method simply returns `void` at the end without creating any edge for unhandled types. **No warning, no fallback, no logging.**

## Unhandled Expression Types

### High Impact (likely majority of 1414 missing edges)

| Type | Example | Estimated Impact | Approach |
|------|---------|-----------------|----------|
| **`ArrayExpression`** (non-all-literal) | `const arr = [a, b, fn()]` | **HIGH (200-400?)** | Create ARRAY_LITERAL node + ASSIGNED_FROM edge (mirrors ObjectExpression at branch 0.5). All-literal arrays already handled via `extractLiteralValue` returning an array. Only arrays with non-literal elements fall through. |
| **`UnaryExpression`** | `const neg = -x`, `const bool = !flag`, `const t = typeof x`, `const v = void 0` | **MEDIUM (100-200?)** | Create EXPRESSION node with operator + recurse into argument |
| **`AssignmentExpression`** | `const x = (a = b)` | **LOW-MEDIUM (50-100?)** | Create EXPRESSION node; right side is the effective value. Rare as variable init but valid JS. |
| **`SequenceExpression`** | `const x = (a, b, c)` | **LOW (10-30?)** | Last expression is the effective value. Track last element. |
| **`ThisExpression`** | `const self = this` | **LOW (20-50?)** | No meaningful source to link. Could create generic ASSIGNED_FROM with a synthetic "this" reference. |
| **`UpdateExpression`** | `const x = ++counter` | **LOW (5-20?)** | Modifies and returns. Track the argument identifier. |

### Medium Impact (TypeScript-specific)

| Type | Example | Estimated Impact | Approach |
|------|---------|-----------------|----------|
| **`TSAsExpression`** | `const x = value as Type` | **MEDIUM (50-200?)** | Unwrap: recurse into `.expression` (like AwaitExpression pattern) |
| **`TSSatisfiesExpression`** | `const x = value satisfies Type` | **LOW (10-50?)** | Unwrap: recurse into `.expression` |
| **`TSNonNullExpression`** | `const x = value!` | **LOW (10-30?)** | Unwrap: recurse into `.expression` |
| **`TSTypeAssertion`** | `const x = <Type>value` | **LOW (5-20?)** | Unwrap: recurse into `.expression` |

### Low Impact

| Type | Example | Estimated Impact | Approach |
|------|---------|-----------------|----------|
| **`TaggedTemplateExpression`** | ``const x = html`<div>` `` | **LOW (5-20?)** | This is effectively a function call. Track tag as CALL_SITE. |
| **`YieldExpression`** | `const x = yield value` | **VERY LOW (0-5?)** | Only valid inside generators. Already tracked separately via `yieldExpressions` collection, but init of a variable inside a generator function body: `const result = yield fetchData()`. Unwrap: recurse into `.argument`. |
| **`ClassExpression`** | `const MyClass = class { ... }` | **LOW (5-15?)** | Similar to FunctionExpression. Create CLASS assignment. |
| **`OptionalCallExpression`** | `const x = obj?.method()` | **LOW (5-15?)** | Treat like CallExpression. |
| **`OptionalMemberExpression`** | `const x = obj?.prop` | **LOW (5-15?)** | Treat like MemberExpression. |
| **`SpreadElement`** | Only valid in certain contexts | **ZERO** | Can't appear as VariableDeclarator init |
| **`ParenthesizedExpression`** | `const x = (expr)` | **NEAR ZERO** | Babel usually doesn't create these unless `createParenthesizedExpressions` is set. Unwrap if encountered. |
| **`DoExpression`** | Stage 1 proposal | **ZERO** | Not in standard JS |

### Silent Drops in VariableVisitor (Module-Level Destructuring)

There's a critical silent drop at **VariableVisitor.ts lines 459-460**:

```typescript
// Unsupported init type (MemberExpression without call, etc.)
// Skip silently
```

This drops module-level destructuring from anything other than `Identifier` or `CallExpression/AwaitExpression`. Examples that are silently dropped:

- `const { a } = obj.nested` (init is MemberExpression)
- `const { a } = new Something()` (init is NewExpression)
- `const { a } = arr[0]` (init is MemberExpression with computed)
- `const { a } = condition ? x : y` (init is ConditionalExpression)

**This is likely a significant contributor to the 1414 count**, especially for destructuring from member expressions which is extremely common in real codebases (e.g., `const { query } = req.params`).

## Root Cause Summary

There are **three** separate locations that silently drop assignments:

1. **`trackVariableAssignment()` lines 608-889**: No fallback after branch 11. Any expression type not in the 11 branches creates no edge.

2. **`VariableVisitor.getHandlers()` line 459**: Module-level destructuring with non-Identifier, non-Call init is silently skipped.

3. **`trackDestructuringAssignment()` lines 1118-1340**: Function-level destructuring only handles `Identifier` and `Call/Await` init sources (same limitation as VariableVisitor but in function scope).

## Proposed Approach

### Phase 1: Add Fallback to `trackVariableAssignment()` (Biggest Bang for Buck)

Add a catch-all at the end of the method that creates a generic assignment. This ensures every variable with an init expression gets SOME data flow edge.

**Strategy: Type-Aware Unwrapping + Fallback**

1. **Unwrap transparent wrappers** (before existing branches):
   - `TSAsExpression` -> recurse into `.expression`
   - `TSSatisfiesExpression` -> recurse into `.expression`
   - `TSNonNullExpression` -> recurse into `.expression`
   - `TSTypeAssertion` -> recurse into `.expression`
   - `ParenthesizedExpression` -> recurse into `.expression`

2. **Add missing expression handlers** (after existing branches):
   - `ArrayExpression` -> ARRAY_LITERAL node + ASSIGNED_FROM edge (mirrors ObjectExpression pattern)
   - `UnaryExpression` -> EXPRESSION node with operator, DERIVES_FROM argument if Identifier
   - `TaggedTemplateExpression` -> CALL_SITE for the tag function
   - `ClassExpression` -> CLASS assignment (like FunctionExpression)
   - `OptionalCallExpression` -> CALL_SITE/METHOD_CALL (like CallExpression)
   - `OptionalMemberExpression` -> EXPRESSION MemberExpression (like MemberExpression)
   - `AssignmentExpression` -> EXPRESSION node, track right side
   - `SequenceExpression` -> recurse into last expression
   - `YieldExpression` -> recurse into argument

3. **Catch-all fallback** (at the very end):
   - For any remaining unknown type: create generic ASSIGNED_FROM with a synthetic EXPRESSION node
   - Log a warning with the expression type for future coverage

### Phase 2: Fix Destructuring Silent Drops

Extend both `VariableVisitor` (module-level) and `trackDestructuringAssignment` (function-level) to handle additional init expression types for destructuring:

- `MemberExpression` init: `const { a } = obj.nested`
- `NewExpression` init: `const { a } = new Config()`
- `ConditionalExpression` init: `const { a } = cond ? x : y`
- TS wrappers: `const { a } = value as Type`

This is more complex because destructuring creates EXPRESSION nodes with property paths, and needs coordinate-based lookups for DERIVES_FROM edges.

### Phase 3: Verify & Measure

Run against a real codebase and measure the reduction from 1414.

## Risk Assessment

| Risk | Level | Mitigation |
|------|-------|-----------|
| Existing tests break | LOW | Changes are additive (new branches, fallback). No existing behavior modified. |
| Incorrect edge creation | LOW | Each new handler follows established patterns from existing branches. |
| Performance regression | NEGLIGIBLE | Adding more branches to a switch-like chain has ~zero perf impact. No new traversals. |
| ArrayExpression ordering with extractLiteralValue | LOW | `extractLiteralValue` is checked first (branch 1). Only arrays that fail literal extraction reach the new ArrayExpression branch. Same pattern as ObjectExpression (branch 0.5 is checked BEFORE literal). **Important: ArrayExpression handler must go BEFORE the literal check, same as ObjectExpression** to ensure arrays with non-literal elements get ARRAY_LITERAL nodes instead of trying (and failing) literal extraction. |
| Destructuring fix complexity (Phase 2) | MEDIUM | MemberExpression destructuring is common but needs careful coordinate-based edge creation. Can be deferred if Phase 1 provides sufficient reduction. |

## Estimated Impact

- **Phase 1 (fallback + new handlers)**: Should eliminate **800-1100** of the 1414 missing edges
- **Phase 2 (destructuring fixes)**: Should eliminate another **100-200**
- **Remaining ~100-200**: Variables declared without initializers (`let x;`), which correctly have no assignment edges

## Lens Recommendation

**Mini-MLA** (Don -> Rob -> Steve(auto) -> Vadim)

Rationale:
- Changes are well-scoped (single method + 2 small patches)
- All changes are additive (no architectural risk)
- Clear patterns to follow from existing branches
- No Uncle Bob step needed (the method is already well-structured with clear numbered branches)
- Kent tests: Yes, need tests for each new expression type handler

Modification: **Mini-MLA + Kent** (Don -> Kent -> Rob -> Steve(auto) -> Vadim)

Kent should write tests first for each unhandled expression type to confirm they currently produce no edges, then Rob implements the handlers.

## Key Files

- `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (main: `trackVariableAssignment` at line 608)
- `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts` (module-level: silent drop at line 459)
- `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts` (edge creation)
- `/Users/vadimr/grafema-worker-5/packages/core/src/plugins/analysis/ast/ExpressionEvaluator.ts` (literal extraction)
- `/Users/vadimr/grafema-worker-5/packages/core/src/core/nodes/ArrayLiteralNode.ts` (ArrayExpression pattern)
- `/Users/vadimr/grafema-worker-5/test/unit/DataFlowTracking.test.js` (existing test patterns)
