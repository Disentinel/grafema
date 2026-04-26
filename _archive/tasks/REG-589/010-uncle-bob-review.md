# Uncle Bob Post-Implementation Review — REG-589: ArgumentParameterLinker

**Date:** 2026-03-01
**Verdict: REJECT — two required fixes, three notes**

---

## Summary Table

| Check | Result |
|-------|--------|
| File sizes (new code pushed over limit?) | WARN — resolve.ts +314 lines, now 1336 |
| `linkArgumentsToParameters` length (>50 lines?) | FAIL — 268 lines, must be split |
| Parameter count >3 | PASS — all public functions ≤ 3 params |
| Nesting depth >2 | FAIL — depth 7 in inner loop |
| Duplication (3+ times) | WARN — ISSUE construction duplicated, resolveCallableTarget inner loop duplicated |
| Naming clarity | PASS |
| PREPARE blockers honored | FAIL — buildCalleeName extraction was BLOCKER, not done |
| Steve's required fixes | FAIL — both required fixes unaddressed |
| Test quality | PASS with one gap |

---

## Required Fix 1: Dead variable + O(N) linear scan (Steve's Required Fix #1, still open)

Steve flagged this. It is still present.

`/Users/vadimr/grafema-worker-2/packages/core-v2/src/resolve.ts`, lines 771–775:

```ts
const allNodeIds = new Set(allNodes.map(n => n.id));  // never used
// ...
const callNode = allNodes.find(n => n.id === callId && n.type === 'CALL');
```

`allNodeIds` is constructed and immediately forgotten. `allNodes.find` does an O(N) linear scan over all nodes for every unresolved call. `index.getNode` is O(1) and the index is already available as the third parameter.

The fix is two lines:

```ts
// Remove allNodeIds entirely.
const callNode = index.getNode(callId);
if (!callNode || callNode.type !== 'CALL') continue;
```

This is a BLOCKER. The ESLint pre-commit hook will reject the `allNodeIds` unused variable on commit anyway. Do not ship with dead code at line 771.

---

## Required Fix 2: PREPARE blocker was silently dropped (buildCalleeName extraction)

PREPARE review (`007-uncle-bob-prepare.md`) marked this as a BLOCKER in capital letters:

> **Do NOT proceed to implement REG-589 changes in `visitCallExpression` without first extracting `buildCalleeName`.**

`/Users/vadimr/grafema-worker-2/packages/core-v2/src/visitors/expressions.ts` is now 1412 lines. It was 1387 before this PR. The callee-name derivation block (lines 51–102) is still inline in `visitCallExpression`, unchanged. The extraction was not done.

The implementation went ahead without the required refactor. This is a process failure, not just a style preference. The function has grown rather than shrunk.

**Required action:** Extract the callee-name derivation block into a standalone function before merge:

```ts
function extractCalleeName(call: CallExpression): { name: string; isChained: boolean }
```

The block at lines 51–102 is pure computation with no side effects on `ctx` or `result`. It takes a `CallExpression` and returns a name and a boolean. This extraction has zero behavioral risk.

---

## Note 1: `linkArgumentsToParameters` is 268 lines with depth-7 nesting

The function spans lines 528–795 of `resolve.ts`. That is 268 lines. The 50-line threshold for method length was exceeded by a factor of 5.

Within the function, the inner matching loop reaches nesting depth 7 (for loop → for loop → for loop → if spread → if restParam → object literal). This is the exact structure that PREPARE said to prevent:

> "No inlining of the ISSUE-node construction — extract makeUnresolvedCallIssue and makeExtraArgIssue as small helpers."

Neither helper was extracted. The ISSUE object construction is inline at lines 749–765 and 777–791. These are 16-line blocks duplicating the same `{id, type, name, file, line, column, metadata}` structure.

Additionally, the inner helper `resolveCallableTarget` (lines 624–671) has a duplicated loop body:

```ts
// VARIABLE/CONSTANT block (lines 640–651):
for (const dstId of assigned) {
  const dstNode = index.getNode(dstId);
  if (dstNode && CALLABLE_TYPES.has(dstNode.type)) return dstId;
  if (dstNode && dstNode.type === 'CLASS') {
    const constructorId = classToConstructor.get(dstId);
    if (constructorId) return constructorId;
  }
}

// IMPORT block (lines 658–665): identical body
for (const dstId of imports) {
  const dstNode = index.getNode(dstId);
  if (dstNode && CALLABLE_TYPES.has(dstNode.type)) return dstId;
  if (dstNode && dstNode.type === 'CLASS') {
    const constructorId = classToConstructor.get(dstId);
    if (constructorId) return constructorId;
  }
}
```

These two loops are identical. Extract:

```ts
function findCallableInTargets(
  dstIds: string[],
  classToConstructor: Map<string, string>,
  index: ProjectIndex,
): string | null {
  for (const dstId of dstIds) {
    const dstNode = index.getNode(dstId);
    if (dstNode && CALLABLE_TYPES.has(dstNode.type)) return dstId;
    if (dstNode?.type === 'CLASS') {
      const constructorId = classToConstructor.get(dstId);
      if (constructorId) return constructorId;
    }
  }
  return null;
}
```

This is a NOTE, not a BLOCKER, since the logic is correct. But the DRY violation is clear and the extraction is mechanical.

---

## Note 2: `HAS_BODY` edge emitted for PARAMETER nodes (pre-existing, now propagated further)

PREPARE identified this as a pre-existing bug (Issue 3, observation only). This PR propagated the same error to two new locations.

`/Users/vadimr/grafema-worker-2/packages/core-v2/src/visitors/expressions.ts`, lines 842 and 898:

```ts
result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' });  // ArrowFunctionExpression, line 842
result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' });  // FunctionExpression, line 898
result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' });  // ObjectMethod, line 1401
```

This is now in 4 places total (`declarations.ts:176` pre-existed; `expressions.ts:842`, `expressions.ts:898`, `expressions.ts:1401` are in this PR's scope). A PARAMETER node is not the body. The `RECEIVES_ARGUMENT` edge on the next line is the correct edge. The `HAS_BODY` emits a semantically wrong structural edge.

PREPARE said "document but do not fix." This PR instead added three more instances. A separate issue should be filed now. The bug count went from 1 to 4.

---

## Note 3: No test for ClassMethod with default-param impact on paramIndex

Steve's Required Fix #2 asked for either a fix to AssignmentPattern handling in class method visitors OR a failing test documenting the gap.

After tracing the actual execution path: the concern is partially addressed by the walk engine's EDGE_MAP mechanism. When `method(x, y = 5)` is parsed:
- `x` (Identifier): `classes.ts` visitor loop emits `RECEIVES_ARGUMENT{paramIndex:0}` directly.
- `y = 5` (AssignmentPattern): `classes.ts` visitor skips it; walk engine fires `RECEIVES_ARGUMENT{paramIndex:1}` via `visitAssignmentPattern` returning a PARAMETER node.

The paramIndex values are correct in this case. However, there is no test that covers `ClassMethod` with default parameters and verifies the resulting `ARG_BINDING` is correct. The test suite covers `FunctionDeclaration` with defaults (Tier 7) but not `ClassMethod`. This gap should be filled.

This is a NOTE, not a BLOCKER — the code path appears correct — but the test gap leaves the invariant unguarded.

---

## What Is Correct

The feature itself is architecturally sound and the core logic is right:

- `ARG_BINDING` edge design (`PARAMETER → argument_node` with `{argIndex, callId}` metadata) is the correct structure.
- `callId` in metadata is the right call — it distinguishes multiple call sites for the same function.
- Rest parameter matching (`args at index >= restParamIndex fold to rest param`) is correct.
- Spread arg handling (`→ rest param then stop`) is correct.
- ISSUE node IDs are deterministic (`ISSUE#extra-argument:${callId}:${argIndex}`), making re-analysis idempotent.
- `resolveCallableTarget` correctly follows `VARIABLE → ASSIGNED_FROM → FUNCTION` and `CLASS → constructor` chains.
- The test suite covers 11 tiers with 20 test cases, all with descriptive failure messages. That is good discipline.
- `ClassPrivateMethod.params` was correctly added to `edge-map.ts`. The PREPARE gap fix was applied.
- The `metadata` field addition to `DeferredRef` in `types.ts` is clean and non-breaking.

The pipeline placement is correct: `linkArgumentsToParameters` runs in Phase 3 after all call edges are resolved, which is the only valid position for it.

---

## Required Actions Before Merge

1. **Fix the `allNodeIds` dead variable and `allNodes.find` O(N) scan** (`resolve.ts:771–775`). Replace with `index.getNode(callId)`. Two lines.

2. **Extract `buildCalleeName` from `visitCallExpression`** (`expressions.ts:51–102`). This was a PREPARE BLOCKER that was dropped. It must be done before this PR merges.

---

## Actions Recommended (Not Blocking)

3. Extract `findCallableInTargets` to eliminate the duplicated loop in `resolveCallableTarget`.

4. Extract `makeExtraArgIssue` and `makeUnresolvedCallIssue` helpers to reduce nesting and ISSUE construction duplication.

5. Add a test: `ClassMethod` with a default-param calling convention (`method(x, y = 5)` called with two args) verifying both `ARG_BINDING` edges have correct `argIndex`.

6. File a separate issue for the `HAS_BODY → PARAMETER` semantic error in `visitArrowFunctionExpression`, `visitFunctionExpression`, and `visitObjectMethod`. It is now in 4 places.
