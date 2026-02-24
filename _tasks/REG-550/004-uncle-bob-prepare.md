## Uncle Bob PREPARE Review: packages/core/src/plugins/analysis/ast/types.ts

**File size:** 1292 lines — MUST SPLIT

**Methods to modify:** `ParameterInfo` interface (lines 48–64)

**File-level:**
- 1292 lines is well past the 500-line hard limit and approaching the 700-line critical threshold. This file aggregates every single AST node type definition for the entire analysis pipeline — 40+ interfaces in one file. It is doing more than one thing: it mixes input collection types (ParameterInfo, FunctionInfo), intermediate analysis types (ScopeInfo, BranchInfo), graph output types (GraphNode, GraphEdge), and data-flow types (ReturnStatementInfo, YieldExpressionInfo). These are distinct responsibilities.
- That said, this is pre-existing technical debt unrelated to REG-550. The change for this task is surgical: add one optional field `column?: number` to `ParameterInfo`. The interface itself is 17 lines and cohesive. The split is out of scope for this task.

**Method-level:** types.ts:ParameterInfo (lines 48–64)
- **Recommendation:** SKIP refactor — interface is 17 lines, single responsibility, flat structure.
- Add `column?: number` after `line: number` on line 54, consistent with every sibling interface that already carries this field (`FunctionInfo`, `VariableDeclarationInfo`, `PropertyAccessInfo`, etc.). Making it optional preserves backward compatibility.
- Risk of inconsistency: `FunctionInfo.column` is required (non-optional); `ParameterInfo.column` should be optional (`column?: number`) because AST location data may not always be present (e.g., synthetic parameters). Pattern matches `LoopInfo.column?: number` and `ClassDeclarationInfo.column?: number` — follow that precedent.

**Risk:** LOW
**Estimated scope:** 1 line added to interface

---

## Uncle Bob PREPARE Review: packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts

**File size:** 209 lines — OK

**Methods to modify:** `createParameterNodes` (lines 42–209, body is lines 50–208 = 158 lines)

**File-level:**
- Single responsibility: creates PARAMETER nodes from AST param patterns. Imports are minimal. No unrelated concerns. OK.

**Method-level:** createParameterNodes.ts:createParameterNodes (lines 42–209)
- The function is 158 lines, which exceeds the 50-line candidate threshold for splitting.
- **Recommendation:** SKIP refactor. The length is driven by 5 legitimate case branches (Identifier, AssignmentPattern+Identifier, AssignmentPattern+destructuring, RestElement, ObjectPattern/ArrayPattern). Each branch is a cohesive unit. Splitting into sub-functions (e.g., `createIdentifierParam`, `createRestParam`, `createDestructuredParams`) would be the right long-term move, but that is refactoring outside this task's scope.
- Nesting depth: The deepest nesting is `params.forEach → else if (AssignmentPattern) → if (left.type === ObjectPattern) → extractedParams.forEach` — that is 4 levels, which exceeds the 2-level guideline. However, the inner lambdas are not deeply nested control flow; they are iteration callbacks. Extracting the forEach bodies into named functions would reduce apparent nesting without altering logic.
- The 5 push sites that need `column` added are:
  1. Line 60–70: Identifier branch — `param.loc?.start.column`
  2. Lines 79–90: AssignmentPattern+Identifier branch — `assignmentParam.left.loc?.start.column`
  3. Lines 112–123: AssignmentPattern+destructuring branch — `paramInfo.loc.start.column`
  4. Lines 145–156: RestElement branch — `restParam.argument.loc?.start.column`
  5. Lines 178–188: ObjectPattern/ArrayPattern branch — `paramInfo.loc.start.column`
- All five follow the identical pattern: `?.start.column` with the `?` operator to handle absent loc. The `extractNamesFromPattern` utility already carries `loc: { start: { line, column } }` on its `ExtractedVariable` return type (confirmed in `types.ts` line 1243), so cases 3 and 5 can read `paramInfo.loc.start.column` without additional plumbing.
- No duplication concerns unique to this change. The repetition across 5 branches is structural, not accidental — each branch handles a distinct AST shape.

**Risk:** LOW
**Estimated scope:** 5 lines added (one `column` field per push site)

---

## Uncle Bob PREPARE Review: packages/core/src/core/ASTWorker.ts

**File size:** 567 lines — OK (under 700-line critical threshold; approaching 500-line soft limit)

**Methods to modify:**
- `ParameterNode` interface (lines 97–105, 8 lines)
- Parameter extraction block inside `FunctionDeclaration` visitor in `parseModule` (lines 409–421, ~12 lines)

**File-level:**
- 567 lines for a worker module that handles parsing, scope tracking, and collection of imports/exports/functions/variables/calls is borderline. The file is doing several things: protocol message handling, AST traversal, and collection assembly. This is pre-existing technical debt. No split required for this task.
- The `ParameterNode` interface (lines 97–105) is the worker's local mirror of the main `ParameterInfo` interface from `types.ts`. This divergence is deliberate (noted in memory: "Parallel path lags behind sequential path: ASTWorker.ts has its own copy of classification logic"). The task requires keeping this local interface in sync.

**Method-level:** ASTWorker.ts:ParameterNode interface (lines 97–105)
- **Recommendation:** SKIP refactor — 8-line interface, flat, single responsibility.
- Add `column?: number` after `line: number` on line 104. Make it optional to match the pattern being established in `ParameterInfo`.

**Method-level:** ASTWorker.ts:FunctionDeclaration visitor / parameter push (lines 409–421)
- **Recommendation:** SKIP refactor — 12-line block, nesting depth is 2 (forEach callback → if branch), acceptable.
- The parameter push currently does not read column from the AST node. Add `column: getColumn(param)` after `line: getLine(param)` on line 419. The `getColumn` utility is already imported (line 23) and used elsewhere in this file (lines 399, 444, 469). Using `getColumn` here is consistent.
- Note: `getColumn` on an `Identifier` param node will return `param.loc?.start.column ?? 0`. If `loc` is absent, it returns `0`. This is acceptable for the worker path where precision is secondary to completeness. The main path uses `param.loc?.start.column` directly (optional chaining, no fallback). The worker should match this by using `getColumn(param)` only if the utility handles absence gracefully — verify the implementation before finalizing.
- Methods are not extracted from class in this file. No class; pure functions and closures. No parameter count concerns (parseModule takes 4 params — exactly at the 3-param guideline limit, acceptable).

**Risk:** LOW
**Estimated scope:** 2 lines modified (1 in interface, 1 in push call)

---

## Summary

| File | Lines | Status | Change Size | Risk |
|------|-------|--------|-------------|------|
| `types.ts` | 1292 | MUST SPLIT (pre-existing) | +1 line | LOW |
| `createParameterNodes.ts` | 209 | OK | +5 lines | LOW |
| `ASTWorker.ts` | 567 | OK | +2 lines | LOW |

**Pre-task refactoring required:** None. The `types.ts` split is out of scope; the `createParameterNodes` function split is out of scope. Both are pre-existing technical debt that should be tracked but not addressed in REG-550.

**Implementation order:** `types.ts` first (interface definition), then `createParameterNodes.ts` (5 push sites), then `ASTWorker.ts` (local interface + push). Snapshots must be regenerated after all three changes.

**Watch for:** The `extractNamesFromPattern` return type (`ExtractedVariable`) already has `loc.start.column` available. No changes needed to that utility. The `getColumn` utility in `ASTWorker.ts` must be verified to handle absent loc without throwing.
