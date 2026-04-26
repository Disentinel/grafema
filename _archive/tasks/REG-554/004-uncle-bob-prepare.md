# Uncle Bob PREPARE Review: REG-554

**Author:** Robert Martin (Uncle Bob)
**Date:** 2026-02-22
**Phase:** PREPARE (before implementation)

---

## Uncle Bob PREPARE Review: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**File size:** 4625 lines — CRITICAL

**Methods to modify:**
- `detectObjectPropertyAssignment` (lines 4184–4279) — 96 lines
- Module-level `AssignmentExpression` call site (line ~1942) — ~3 lines changed

**File-level:**
- At 4625 lines this file is well past the CRITICAL threshold. However, an active refactoring effort (REG-422) is already extracting handlers into dedicated files. Splitting this file further is out of scope for REG-554. Recorded as standing tech debt.
- The plan's changes are purely additive: one new parameter on the private method, one new `if` block at the end, and a 4-line initialization + updated call at the module-level site. No structural changes to the file.

**Method-level: `JSASTAnalyzer.ts::detectObjectPropertyAssignment`**
- **Recommendation:** SKIP
- Method is 96 lines, which is above the 50-line threshold but the logic is a single straight-line decision tree: type guard → extract object name → extract property name → extract value → push. There is no hidden state, no nested loops, no duplication.
- The change adds one optional parameter (`propertyAssignments?: PropertyAssignmentInfo[]`) and one trailing `if` block (~15 lines). The parameter is optional so both existing call sites that omit it continue to compile without change.
- Adding this parameter does bring the total parameter count to 5, which crosses the "consider Parameter Object" threshold. However, the method is `private`, the parameter is optional, and the call sites are co-located in the same file and in `VariableHandler.ts`. Introducing a parameter object for a 2-field change would be over-engineering. SKIP.
- Nesting depth does not increase: the new block is a top-level `if` at the end of the method, not nested inside the existing branches.

**Method-level: `JSASTAnalyzer.ts` module-level call site (~line 1942)**
- **Recommendation:** SKIP
- The site adds a lazy-initialization guard (`if (!allCollections.propertyAssignments)`) and passes the new collection as an argument. This is the same pattern used immediately above it for `objectMutations` (lines 1938–1942). Consistent with existing code style, no refactoring needed.

**Risk:** LOW
**Estimated scope:** ~20 lines modified/added (method signature + trailing if block + call site)

---

## Uncle Bob PREPARE Review: `packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts`

**File size:** 95 lines — OK

**Methods to modify:**
- `AssignmentExpression` handler body (lines 58–92) — ~35 lines

**File-level:**
- File is small and focused. Single responsibility: translate AST visitor events into analyzer delegate calls. No issues.

**Method-level: `VariableHandler.ts::AssignmentExpression` handler**
- **Recommendation:** SKIP
- The handler is 35 lines. It initializes collections, delegates to the analyzer, in a linear pattern matching the surrounding code.
- The change adds a lazy-init guard for `ctx.collections.propertyAssignments` (~3 lines) and passes it to the `detectObjectPropertyAssignment` call. This follows the verbatim pattern used for `arrayMutations` (lines 76–79) and `objectMutations` (lines 84–88) immediately above. Consistency is a virtue here; no refactoring needed.

**Risk:** LOW
**Estimated scope:** ~5 lines added

---

## Uncle Bob PREPARE Review: `packages/core/src/plugins/analysis/ast/handlers/AnalyzerDelegate.ts`

**File size:** 204 lines — OK

**Methods to modify:**
- `detectObjectPropertyAssignment` delegate signature (lines 74–79) — 6 lines

**File-level:**
- File is an interface-only file (pure contract). Well-structured, single responsibility: define the contract between extracted handlers and JSASTAnalyzer. No concerns.
- The existing `handleVariableDeclaration` method at lines 38–55 has 15 parameters. Adding one optional parameter to `detectObjectPropertyAssignment` (which already has 4) is not ideal in the abstract, but it matches the established pattern in this file and is the minimal correct change.

**Method-level: `AnalyzerDelegate.ts::detectObjectPropertyAssignment`**
- **Recommendation:** SKIP
- The change is purely mechanical: add `propertyAssignments?: PropertyAssignmentInfo[]` as the fifth parameter and import the new type. This is a delegate interface — it must mirror the concrete method signature in `JSASTAnalyzer`. No logic lives here.

**Risk:** LOW
**Estimated scope:** ~3 lines modified (signature + import)

---

## Uncle Bob PREPARE Review: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**File size:** 621 lines — MUST SPLIT (threshold: 500)

**Methods to modify:**
- `constructor` (lines 67–79) — 13 lines
- `build()` (lines 177–365) — 189 lines

**File-level:**
- At 621 lines this file exceeds the 500-line MUST SPLIT threshold. The file is already refactored into a delegation pattern (domain builders in `builders/`), and is primarily boilerplate for node buffering, builder orchestration, and post-flush async operations. Splitting it further would mean separating the `build()` dispatcher from the buffer utilities, which offers marginal readability benefit.
- Refactoring GraphBuilder further is out of scope for REG-554. Recorded as tech debt.
- The plan's change is 6 additive lines: 1 import, 1 field declaration, 1 constructor line, 1 `buffer()` call. This is the identical pattern used for every other domain builder already registered. No structural change.

**Method-level: `GraphBuilder.ts::build()`**
- **Recommendation:** SKIP
- `build()` is 189 lines — well above 50 lines. However, it is already a straight-line dispatcher: it buffers node categories in order, then calls each domain builder, then flushes. There is no decision logic hidden in it. Splitting it would create a meaningless intermediate extraction.
- The change adds one line: `this._propertyAssignmentBuilder.buffer(module, data);` after `this._mutationBuilder.buffer(module, data)`. This is the minimal, correct, obvious change.

**Method-level: `GraphBuilder.ts::constructor`**
- **Recommendation:** SKIP
- The constructor is 13 lines and instantiates builders. One new line is added. No issues.

**Risk:** LOW
**Estimated scope:** ~6 lines added (import + field + constructor + buffer call)

---

## Summary

| File | Lines | Status | Action | Risk |
|------|-------|--------|--------|------|
| `JSASTAnalyzer.ts` | 4625 | CRITICAL | SKIP (tech debt noted) | LOW |
| `VariableHandler.ts` | 95 | OK | SKIP | LOW |
| `AnalyzerDelegate.ts` | 204 | OK | SKIP | LOW |
| `GraphBuilder.ts` | 621 | MUST SPLIT | SKIP (tech debt noted) | LOW |

**Overall verdict: PROCEED.** No pre-implementation refactoring required. All changes are additive and follow existing patterns exactly. Two files are oversized but splitting them is out of scope and would carry more risk than the feature change itself.

**Tech debt to log after REG-554 merges:**
1. `JSASTAnalyzer.ts` (4625 lines) — systematic extraction of analysis methods into dedicated handlers (continuing REG-422 work).
2. `GraphBuilder.ts` (621 lines) — extract buffer-phase orchestration loop into a separate coordinator, leaving only the async post-flush operations in the main file.
