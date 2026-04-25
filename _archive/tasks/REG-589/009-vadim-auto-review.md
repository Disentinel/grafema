# Вадим Auto Review — REG-589: ArgumentParameterLinker

**Reviewer:** Вадим auto (Completeness Reviewer)
**Date:** 2026-03-01
**Verdict: REJECT — 3 required fixes before merge**

---

## Completeness Against Original Requirements

| Requirement | Status | Notes |
|---|---|---|
| Positional argument-to-parameter linking, direct calls | PASS | Tiers 1, 7, 11 — all pass |
| Works for method calls where target is resolved | PASS (partial) | `this.method(arg)` works; `obj.method(arg)` (Identifier object) does NOT — documented gap |
| Rest params in scope | PASS | Tier 2 — correct |
| Spread args in scope | PASS | Tier 5 — correct |
| Destructured params in scope | PASS | Tier 6 — synthetic `{...}`/`[...]` node approach |
| Unresolved calls raise ISSUE nodes | PASS | Tier 8 — `issueKind: 'unresolved-call'` |
| Extra args raise ISSUE nodes | PASS | Tier 3 — `issueKind: 'extra-argument'` |
| `new Foo(arg)` constructor linking | PASS | Tier 10 — via CLASS → constructor chain |
| Arrow function support | PASS | Tier 11 |
| Cross-file support | PASS | Tier 9 — project-level resolution |
| Golden test coverage | PARTIAL — see Gap 1 |

---

## Test Execution

All 20 tests in `packages/core-v2/test/arg-binding.test.mjs` pass:

```
# tests 20
# suites 13
# pass 20
# fail 0
```

All 53 tests across the full core-v2 test suite pass. No regressions introduced.

---

## Gap 1 (REQUIRED): smoke.mjs not updated — golden test coverage incomplete

The plan (`002-don-plan.md`, Section "Test Strategy") explicitly states:

> "Update `smoke.mjs` to include `ARG_BINDING: 0` in `LANG_SPEC_EDGES` so it tracks coverage."

`ARG_BINDING` was not added to `LANG_SPEC_EDGES` in `packages/core-v2/test/smoke.mjs`.

Current smoke.mjs line 105:
```js
const { edges: stage3Edges, unresolved, stats } = resolveProject(fileResults, builtins);
```

`nodes` is not destructured from the result — so ISSUE nodes emitted by `linkArgumentsToParameters` are not counted in `totalNodes`. ARG_BINDING edges are not tracked in `LANG_SPEC_EDGES`. The Stage 3 stats (`argsLinked`, `issuesCreated`) are not printed.

Acceptance criterion says "Golden test coverage for the linking." The golden test (`verify-golden.mjs`) only verifies file-level walk output and does not run `resolveProject`. The smoke.mjs is the only pipeline-level coverage check. Not updating it means ARG_BINDING has zero golden coverage — a regression from the plan's explicit intent.

**Required:** Add `ARG_BINDING: 0` to `LANG_SPEC_EDGES`, destructure `nodes` from `resolveProject()`, count them in `totalNodes`, and print `stats.argsLinked` and `stats.issuesCreated` in the Stage 3 report.

---

## Gap 2 (REQUIRED — previously flagged by Steve and Uncle Bob, still open): Dead variable + O(N) scan

`packages/core-v2/src/resolve.ts`, lines 771–775:

```ts
const allNodeIds = new Set(allNodes.map(n => n.id));  // never used, dead code
for (const [callId] of callToArgs) {
  if (callsWithAnyEdge.has(callId)) continue;
  const callNode = allNodes.find(n => n.id === callId && n.type === 'CALL');  // O(N) scan
```

`allNodeIds` is built and never referenced. `allNodes.find` is O(N) over all nodes for each unresolved call. `index.getNode(callId)` is O(1) and available.

Both Steve's review (`008-steve-review.md`) and Uncle Bob's review (`010-uncle-bob-review.md`) flagged this as a required fix. It is still present in the code.

The ESLint pre-commit hook will reject the unused `allNodeIds` variable on commit. This is both a correctness/performance issue and a lint blocker.

**Required:** Remove `allNodeIds`, replace `allNodes.find` with `index.getNode(callId)`:

```ts
// Remove: const allNodeIds = new Set(allNodes.map(n => n.id));
const callNode = index.getNode(callId);
if (!callNode || callNode.type !== 'CALL') continue;
```

---

## Gap 3 (REQUIRED — Uncle Bob PREPARE BLOCKER, still open): `buildCalleeName` extraction

Uncle Bob's PREPARE review (`007-uncle-bob-prepare.md`) marked as a BLOCKER in capital letters:

> "Do NOT proceed to implement REG-589 changes in `visitCallExpression` without first extracting `buildCalleeName`. The function is too long to safely navigate without introducing errors."

`packages/core-v2/src/visitors/expressions.ts` was 1387 lines before. It is now 1412 lines. The callee-name derivation block (lines 51–102) is still inline in `visitCallExpression`, unchanged. The extraction was not done.

Uncle Bob's post-implementation review (`010-uncle-bob-review.md`) confirms: "PREPARE blocker was silently dropped."

**Required:** Extract lines 51–102 of `visitCallExpression` into:

```ts
function extractCalleeName(call: CallExpression): { name: string; isChained: boolean }
```

This is pure computation, no side effects on `ctx` or `result`. Zero behavioral risk. This must be done before merge.

---

## Observations (Not Blocking)

### `HAS_BODY` to PARAMETER — pre-existing bug propagated to 3 new locations

Pre-implementation: `declarations.ts:176` emitted `HAS_BODY` from function to parameter node (pre-existing bug).

Post-implementation, 3 more locations added in `expressions.ts`:
- Line 842: `visitArrowFunctionExpression`
- Line 898: `visitFunctionExpression`
- Line 1401: `visitObjectMethod`

Uncle Bob flagged this as a note, not a blocker. But the bug count grew from 1 to 4. A separate REG issue should be filed.

### `linkArgumentsToParameters` at 268 lines with depth-7 nesting

Uncle Bob's review flagged this. The function exceeds the 50-line threshold by 5x and reaches nesting depth 7. The `makeExtraArgIssue`/`makeUnresolvedCallIssue` helpers and `findCallableInTargets` extraction would reduce this, but are not blocking.

### No test for ClassMethod with default-param paramIndex

`Tier 7` tests `FunctionDeclaration` with default params. No corresponding tier for `ClassMethod` with defaults (e.g. `method(x, y = 5)` called with two args). The code path appears correct via the walk engine structural mechanism, but the invariant is unguarded. Uncle Bob flagged this as a recommended (not blocking) addition.

### `obj.method(arg)` gap — documented but not in tests

The Tier 4 test uses `this.method(arg)` which works. There is no test that demonstrates `obj.method(arg)` produces zero ARG_BINDING (which is correct behavior given the graph model). A negative test here would document the known limitation explicitly and prevent future confusion.

---

## What Was Delivered Correctly

The core feature is complete and correct:

- ARG_BINDING edge design (`PARAMETER → argument_node` with `{argIndex, callId}`) is sound
- `callId` in metadata correctly distinguishes multiple call sites for the same function
- Rest parameter matching is correct (args at index >= restParamIndex fold to rest param)
- Spread arg handling is correct (spread → rest param then stop; non-rest spread stops matching)
- Destructured param synthetic node approach correctly handles `{a, b}` and `[a, b]` patterns
- ISSUE node IDs are deterministic (`ISSUE#extra-argument:${callId}:${argIndex}`), making re-analysis idempotent
- Unresolved-call ISSUE filtering correctly uses `callsWithAnyEdge` (includes both CALLS and CALLS_ON) to avoid false positives for `obj.method(arg)` patterns
- `ClassPrivateMethod.params` correctly added to `edge-map.ts` (PREPARE gap fix applied)
- `metadata` field addition to `DeferredRef` is clean and non-breaking
- `resolveFileRefs` and walk.ts Stage 2 both forward `ref.metadata` to resolved edges (Dijkstra's critical finding 7.1 addressed)
- ISSUE node IDs use direct callId (not the collision-prone regex Dijkstra flagged in finding 5.2)
- `ResolveResult.nodes` extension is present and `CoreV2Analyzer` correctly calls `graph.addNodes(resolved.nodes)` — ISSUE nodes reach the graph store

---

## Required Actions Before Merge

1. **Add `ARG_BINDING: 0` to `LANG_SPEC_EDGES` in `smoke.mjs`**, destructure and count `nodes` from `resolveProject`, print `argsLinked`/`issuesCreated` stats. (Gap 1)

2. **Fix `allNodeIds` dead variable and `allNodes.find` O(N) scan** in `resolve.ts:771-775`. Replace with `index.getNode(callId)`. (Gap 2 — also blocked by ESLint)

3. **Extract `buildCalleeName` from `visitCallExpression`** in `expressions.ts:51-102`. This was a PREPARE BLOCKER that was silently dropped. (Gap 3)
