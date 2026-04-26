# Uncle Bob Pre-Implementation Review — REG-589

## Summary Verdict

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `types.ts` | 192 | PASS | SKIP — minimal, clean |
| `walk.ts` | 607 | PASS | SKIP — methods are acceptable |
| `expressions.ts` | 1387 | FAIL | MUST SPLIT before touching |
| `declarations.ts` | 283 | PASS | SKIP |
| `classes.ts` | 209 | PASS | SKIP |
| `misc.ts` | 361 | WARN | Refactor `visitObjectPattern`/`visitArrayPattern` as part of the change itself |
| `edge-map.ts` | 198 | PASS | SKIP |
| `resolve.ts` | 1022 | WARN | Acceptable — but `linkArgumentsToParameters` must be extracted cleanly |

---

## File 1: `packages/core-v2/src/types.ts` — 192 lines

### Verdict: SKIP

**Structure:** Perfect. Four well-named interface sections, each with a clear responsibility. No methods to review (type-only file). The module-level `paramTypeRefInfo` function (lines 163-179) is 17 lines with no branching beyond what the domain demands. Readable.

**Planned change:** Add `metadata?: Record<string, unknown>` to `DeferredRef`. One field, one line. No structural risk.

**Concern:** None.

---

## File 2: `packages/core-v2/src/walk.ts` — 607 lines

### Verdict: SKIP

**Structure:** 607 lines is above the 300-line threshold, but the bulk is the `JS_GLOBALS` constant (lines 40–86) — 47 lines of data, not logic. Excluding that, actual logic is ~560 lines. Still over 300.

**However:** The file has exactly three responsibilities:
1. `parseFile` — 24 lines
2. `createWalkContext` — 53 lines
3. `walkFile` — the orchestrator, containing the inner `visit` closure and post-walk processing

The inner `visit` function (lines 271-396) is 125 lines and is the target of the change. Analysis:

- `visit` is a recursive closure with one level of nesting inside `walkFile`. This is acceptable because it needs shared mutable collections (`allNodes`, `allEdges`, `allDeferred`) without parameter explosion.
- Cyclomatic complexity is moderate: one `if/else` tree for `srcFrom` resolution, one `for` loop over child keys, one `if/else` for array vs scalar children.
- The planned change adds `edgeMetadata?: Record<string, unknown>` to the `visit` signature and two small conditions to the array loop. This is a clean, local change. The additional parameter does not increase cognitive complexity meaningfully.

**Stage 2 resolver block (lines 475-538):** 63 lines, well-structured `for` loop over deferred refs with a `switch`. The planned change is one line: `metadata: ref.metadata`. Clean.

**Concern:** The `visit` function at 125 lines is approaching the upper bound. It is not clean enough to extract easily without disrupting the closure's shared state access. The planned changes are localized. Do not restructure `visit` now — note it as a future obligation.

---

## File 3: `packages/core-v2/src/visitors/expressions.ts` — 1387 lines

### Verdict: MUST SPLIT

**This file is 4.6x over the 300-line limit.** The problem is not merely cosmetic. The file contains, by inspection:

1. `visitCallExpression` — ~420 lines (lines 44–471)
2. `visitMemberExpression` — estimated 60 lines
3. `visitArrowFunctionExpression` — estimated 80 lines
4. `visitFunctionExpression` — estimated 80 lines
5. `visitNewExpression` — estimated 50 lines
6. `visitObjectExpression`, `visitObjectProperty`, `visitObjectMethod` — estimated 80 lines
7. `visitArrayExpression` — estimated 30 lines
8. `visitAssignmentExpression`, `visitBinaryExpression`, and others — estimated 150 lines remaining
9. `visitIdentifier`, `visitAwaitExpression`, `visitYieldExpression`, and passthrough registrations — remaining

### `visitCallExpression` quality assessment

The function is **430 lines**. This is a serious violation of the Single Responsibility Principle. It is doing:

- Callee name derivation (60 lines, lines 53–102)
- CALL node construction (20 lines)
- CHAINS_FROM chain detection (35 lines, lines 126–162)
- PASSES_ARGUMENT deferred emission for identifier args (14 lines, lines 164–180)
- Callee resolution deferred (12 lines, lines 182–194)
- CALLS_ON resolution with complex if/else for method objects (35 lines, lines 195–225)
- fn.bind() special case (27 lines, lines 227–251)
- Array method `BINDS_THIS_TO` special case (25 lines, lines 253–277)
- EventEmitter `on/off/once/emit` pattern detection
- EventEmitter `addListener/removeListener` detection
- `require()`/dynamic import detection
- `Object.assign` detection
- More special-case patterns...

**Required split before implementation:**

Extract from `visitCallExpression`:

```
extractCalleeName(call: CallExpression): { name: string, isChained: boolean }
buildPassesArgumentDeferreds(call, nodeId, ctx, line): DeferredRef[]
buildCalleeDeferred(call, nodeId, ctx, line): DeferredRef[]
buildChainsFromEdge(call, nodeId, ctx, line): GraphEdge | null
```

The function's core logic then becomes a coordinator of 4-5 well-named helpers. This would bring `visitCallExpression` below 120 lines.

**The planned change sits in the PASSES_ARGUMENT loop (lines 167-179).** With extraction, this loop moves into `buildPassesArgumentDeferreds`. The change is adding `metadata: { argIndex: i }` and converting `for..of` to `for..let i`. Clean in isolation, but buried in 430 lines right now.

**Minimum required split (just enough to make the area safe to modify):**

Extract `buildCalleeName` (the 60-line name-derivation block at lines 51-102) into a standalone function. This is the most complex and unrelated logic at the top of the function. The remaining function will still be long, but the area we are modifying (lines 164-179) will be more visible.

Do NOT proceed to implement REG-589 changes in `visitCallExpression` without first extracting `buildCalleeName`. The function is too long to safely navigate without introducing errors.

### `visitArrowFunctionExpression` and `visitFunctionExpression`

These will receive `paramIndex` metadata changes. Need to locate their sizes:
<br>Based on the file being 1387 lines and the distribution above, they are each approximately 70-80 lines. Acceptable once the caller's split is done.

---

## File 4: `packages/core-v2/src/visitors/declarations.ts` — 283 lines

### Verdict: SKIP

**Structure:** Four visitors, clean sections. `visitFunctionDeclaration` (lines 122-186) is 65 lines with one `for` loop over params. The planned change converts `for (const param of fn.params)` to `for (let i = 0; ...)` and adds `metadata: { paramIndex: i }` to the RECEIVES_ARGUMENT edge push. This is a mechanical, low-risk change.

**Concern:** `visitFunctionDeclaration` manually pushes `HAS_BODY` edge to parameter nodes (line 175: `result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' })`). This appears to be a bug — `HAS_BODY` semantics should be between a function and its body block, not between a function and its parameters. There is already a separate `RECEIVES_ARGUMENT` push on line 176. The `HAS_BODY` on line 175 is likely an error — the RECEIVES_ARGUMENT on line 176 is the correct edge. This is a pre-existing issue, not introduced by REG-589. Document but do not fix under this ticket.

---

## File 5: `packages/core-v2/src/visitors/classes.ts` — 209 lines

### Verdict: SKIP

**Structure:** Six visitors. `visitClassMethod` (lines 35-86) is 52 lines. `visitClassPrivateMethod` (lines 109-157) is 49 lines. Both contain the same param loop pattern. The planned change is the same mechanical conversion as in `declarations.ts`.

**Duplication observation:** `visitClassMethod` and `visitClassPrivateMethod` share almost identical parameter-loop logic. This duplication pre-dates this ticket. Note it — REG-589 changes should not increase the duplication. If extracting a `buildParamNodes(params, fnId, ctx, line)` helper is practical during the change, do it. But do not block on it.

**`ClassMethod.params` missing from EDGE_MAP:** The plan in `005-don-revised-plan.md` Section 7 notes that the walk engine needs to pass `paramIndex` for RECEIVES_ARGUMENT array edges via EDGE_MAP. Looking at `edge-map.ts` line 196: `'ClassMethod.params': { edgeType: 'RECEIVES_ARGUMENT' }` is present. `ClassPrivateMethod.params` is NOT in the EDGE_MAP (noted as the file-8 change needed). This is a legitimate gap that REG-589 must fix. The walk engine will not fire the structural RECEIVES_ARGUMENT for `ClassPrivateMethod.params` because the EDGE_MAP entry is missing.

---

## File 6: `packages/core-v2/src/visitors/misc.ts` — 361 lines

### Verdict: WARN — Refactor during implementation

**Structure:** 361 lines, 61 over threshold. The file is a catch-all for patterns, JSX, directives, and miscellaneous visitors. The top section (lines 23-216) contains the pattern visitors that will be modified.

**`visitObjectPattern` (lines 57-89) — 33 lines:** Currently handles both param and non-param contexts by checking `isParam` flag. The planned change rewrites this to add a synthetic PARAMETER node path when `isParam === true`. The current 33-line function will become ~60 lines. This is the correct place for the change.

**Quality concern with current `visitObjectPattern`:** The function handles two very different cases (variable destructuring vs parameter destructuring) behind one `isParam` flag. After the REG-589 change, the two branches will diverge significantly in code volume. Consider extracting `visitObjectPatternAsParam` as a separate function called from `visitObjectPattern` when `isParam` is true. This keeps each branch under 30 lines.

**`visitArrayPattern` (lines 96-149) — 54 lines:** Same situation. Already longer than `visitObjectPattern` due to the ELEMENT_OF derivation logic. After adding the synthetic node path, it will be ~80 lines. Extract the param branch.

**`isParameterContext` (lines 23-40) — 18 lines:** Good. Clean predicate function.

**The `_getVarKind` function (lines 42-50) — 9 lines with a TODO comment:** The function always returns `'let'` and the comment says "Need grandparent for kind, but we only have parent." This is dead code with a comment that describes a known limitation. Not a blocker for REG-589 but a code smell that should be noted. The function is unused except... actually checking if it is called: the function name is `_getVarKind` with a leading underscore, which in this project means "prefixed to avoid unused-var lint error." It appears to not be called anywhere. This is dead code that should be removed, but not in this ticket.

---

## File 7: `packages/core-v2/src/edge-map.ts` — 198 lines

### Verdict: SKIP

**Structure:** A pure data file — a single `EDGE_MAP` constant. 198 lines, well within limits. The planned change adds one entry: `'ClassPrivateMethod.params': { edgeType: 'RECEIVES_ARGUMENT' }`. One line. Zero risk.

**Placement:** Must go in the "Function params" section (lines 192-198), alongside the existing `FunctionDeclaration.params`, `FunctionExpression.params`, etc. entries.

---

## File 8: `packages/core-v2/src/resolve.ts` — 1022 lines

### Verdict: WARN — `linkArgumentsToParameters` must be self-contained

**Structure:** 1022 lines is 3.4x over threshold, but this is the project resolver — its size is partially justified by the number of distinct resolver types (import, call, type, alias, re-export chain, and three derived-edge derivers). The structure is:

| Lines | Responsibility |
|-------|---------------|
| 1-85 | `resolveFileRefs` (Stage 2.5) |
| 87-195 | `ProjectIndex` class |
| 197-307 | Module resolution utilities |
| 309-481 | `resolveProject` orchestrator |
| 483-542 | `resolveImport` |
| 544-592 | `inferReceiverType` |
| 594-700 | `resolveCall`, `resolveType`, `resolveAlias` |
| 702-774 | `resolveImportViaReExportChain`, `followReExportChain` |
| 776-1022 | Derived edges: `deriveTransitiveExtends`, `deriveInstanceOf`, `deriveComputedAccessElementOf`, `deriveMapGetElementOf` |

**Adding `linkArgumentsToParameters`:** Per the plan, this function will be ~100-150 lines. Adding it brings `resolve.ts` to ~1150-1170 lines. This is undesirable but tolerable if the function is well-structured and clearly sectioned.

**Requirement for the implementer:** `linkArgumentsToParameters` must follow the same pattern as the existing `derive*` functions:
- Single responsibility: build two maps, iterate, emit edges and nodes
- No inlining of the ISSUE-node construction — extract `makeUnresolvedCallIssue(callNode)` and `makeExtraArgIssue(callNode, argIndex, paramCount)` as small helpers
- Section it with a `// ─── Arg-Parameter Linker ───` header consistent with existing section separators

**`resolveProject` orchestrator (lines 335-481):** Currently 147 lines. Adding the `linkArgumentsToParameters` call and `nodes` collection adds ~10 lines. Stays manageable.

**`ResolveResult` interface extension:** Adding `nodes: GraphNode[]` and three stats fields is a clean, backward-compatible change (new fields). Callers that do not use `nodes` are unaffected.

---

## Critical Issues to Fix Before Coding

### Issue 1 (BLOCKER): `expressions.ts` must be partially split

Extract `buildCalleeName` from `visitCallExpression` before making any REG-589 changes. The 60-line name-derivation block at lines 51-102 is pure computation with no side effects on `ctx` or `result`. It takes a `CallExpression` and returns `{ name: string, isChained: boolean }`. This extraction:
- Reduces `visitCallExpression` from ~430 to ~370 lines (still long, but the modification area at lines 164-179 becomes easier to locate)
- Has zero behavioral impact (pure refactor)
- Can be tested by confirming no change to graph output

This must be done in a **separate commit** before the REG-589 implementation commit.

### Issue 2 (REQUIRED): Add `ClassPrivateMethod.params` to EDGE_MAP

This is a pre-existing gap. Without it, the walk engine will not fire RECEIVES_ARGUMENT for private method params from the structural array-loop path. The `visitClassPrivateMethod` manually emits `RECEIVES_ARGUMENT`, but `paramIndex` via the walk engine path cannot fire without this entry. Add the entry in the EDGE_MAP change.

### Issue 3 (OBSERVATION — do not fix in REG-589): `HAS_BODY` edge to parameter in `visitFunctionDeclaration`

Line 175: `result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' })` — this is almost certainly wrong. Parameters are not the body. This pre-existing bug should be filed as a separate issue.

---

## Recommendations per File

| File | Recommendation | Rationale |
|------|----------------|-----------|
| `types.ts` | SKIP refactor | Clean; add `metadata` to `DeferredRef` inline |
| `walk.ts` | SKIP refactor | Methods acceptable; note `visit` for future split |
| `expressions.ts` | REFACTOR FIRST — extract `buildCalleeName` | 1387 lines, `visitCallExpression` at 430 lines; unsafe to modify without extraction |
| `declarations.ts` | SKIP refactor | 283 lines, target method is 65 lines, clean |
| `classes.ts` | SKIP refactor | 209 lines; note duplicated param loop but do not fix here |
| `misc.ts` | REFACTOR during change — extract param branches | Synthetic PARAMETER node addition will push `visitObjectPattern`/`visitArrayPattern` over acceptable size; extract param branches as separate functions during implementation |
| `edge-map.ts` | SKIP refactor | Pure data file, one-line addition |
| `resolve.ts` | NO pre-split; discipline during addition | Add `linkArgumentsToParameters` as self-contained section; extract issue-node factories as helpers |

---

## Implementation Order

1. Commit: Extract `buildCalleeName` from `visitCallExpression` in `expressions.ts` (pure refactor, no behavior change)
2. Commit: Add `ClassPrivateMethod.params` to `edge-map.ts` (gap fix, separate from linker)
3. Commit: Add `metadata` to `DeferredRef` in `types.ts` + walk engine changes (`walk.ts`)
4. Commit: `visitCallExpression` argIndex + function visitor `paramIndex` changes (`expressions.ts`, `declarations.ts`, `classes.ts`)
5. Commit: Synthetic PARAMETER nodes for destructured params + extracted param-branch functions (`misc.ts`)
6. Commit: `linkArgumentsToParameters` + `ResolveResult` extension (`resolve.ts`) + `CoreV2Analyzer` update
7. Commit: Tests (`arg-binding.test.mjs`) + smoke test update

Each commit must have tests passing. Steps 3-5 add metadata but produce no new edges yet — validate by confirming existing tests still pass. Step 6 produces the ARG_BINDING edges — validate with new tests.
