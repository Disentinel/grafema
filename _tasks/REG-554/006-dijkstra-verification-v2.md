# Dijkstra Verification v2: REG-554

**Verifier:** Edsger Dijkstra, Plan Verifier
**Date:** 2026-02-22
**Plan under review:** `005-don-plan-v2.md`
**Previous verdict:** REJECT (`004-dijkstra-verification.md`, 2 blockers + AC1 ambiguity)

---

## Verdict: APPROVE

Both blockers are fixed. The AC1 ambiguity is resolved with a concrete implementation choice (option 2: TSNonNullExpression unwrapping + MemberExpression handling + PROPERTY_ACCESS node lookup). No new blockers introduced by the revisions. One minor issue identified that does not block implementation.

---

## Blocker Status: Both Fixed

### BLOCKER 1 — `valueNodeId` removed. FIXED.

`PropertyAssignmentInfo` in v2 has no `valueNodeId` field. The comment in the interface explicitly documents why: "extractMutationValue() does NOT pre-resolve node IDs. There is no valueNodeId field." The `if (propAssign.valueNodeId)` branch is absent from `bufferPropertyAssignmentNodes()`. The dead-code path is gone.

Verification: The `PropertyAssignmentInfo` interface in Section 3 has no `valueNodeId` field. The `bufferPropertyAssignmentNodes()` implementation in Sub-step 7d uses only `if (propAssign.valueType === 'VARIABLE' ...)` and `else if (propAssign.valueType === 'MEMBER_EXPRESSION' ...)` with a documented comment for all other types producing no ASSIGNED_FROM edge.

**BLOCKER 1: CLOSED.**

### BLOCKER 2 — Import line explicitly stated. FIXED.

Sub-step 4a specifies the exact change at the exact line:

```typescript
// Line 55 in JSASTAnalyzer.ts — replace:
import { computeSemanticId } from '../../core/SemanticId.js';
// With:
import { computeSemanticId, computeSemanticIdV2 } from '../../core/SemanticId.js';
```

Cross-checked: `computeSemanticIdV2` is exported from `packages/core/src/core/SemanticId.ts` at line 253. The import path `'../../core/SemanticId.js'` already works (it is the path used for the existing `computeSemanticId` import on line 55). No path ambiguity.

**BLOCKER 2: CLOSED.**

---

## Specific Verification Points

### 1. TSNonNullExpression unwrapping

The plan correctly handles the single-level case (`options.graph!`):

```typescript
const effectiveValue: t.Expression =
  value.type === 'TSNonNullExpression' ? value.expression : value;
```

**Edge case not handled: double-bang `options.graph!!`**

For `options.graph!!`, `value` is `TSNonNullExpression` whose `.expression` is another `TSNonNullExpression`. The plan's single unwrap produces `effectiveValue.type === 'TSNonNullExpression'`, which does not match any if-branch — it falls through to the default `'EXPRESSION'` result. No ASSIGNED_FROM edge is created.

**Assessment: acceptable for V1, not a blocker.** Double-bang (`!!`) is an extremely rare and style-guide-prohibited TypeScript pattern. The fallback is safe (no crash, no missing node, just no ASSIGNED_FROM edge). However, the plan should document this known limitation somewhere — it is currently silent on it. The edge case table in Section 8 mentions `options.graph!` but not `options.graph!!`. Rob should add a code comment noting that only one level of TSNonNullExpression is unwrapped.

**Recommendation: add one-line note to Section 8 and a code comment. Does not block.**

### 2. MemberExpression matching in `bufferPropertyAssignmentNodes()`

The plan matches a PROPERTY_ACCESS node using:
```typescript
pa.objectName === memberObject &&
pa.propertyName === memberProperty &&
pa.file === propAssign.file &&
(memberLine === undefined || pa.line === memberLine) &&
(memberColumn === undefined || pa.column === memberColumn)
```

This logic is sound. `PropertyAccessVisitor` creates a `PropertyAccessInfo` entry for every MemberExpression read site, including RHS expressions. The `options.graph` on the RHS of `this.graph = options.graph` will produce a `PropertyAccessInfo` with `objectName='options'`, `propertyName='graph'`, and the line/column of the MemberExpression. The plan captures those coordinates via `valueInfo.memberLine` / `valueInfo.memberColumn` set during `extractMutationValue()`. The match is therefore precise enough to uniquely identify the node in all typical cases.

### 3. Fallback when no matching PROPERTY_ACCESS is found

Explicitly handled: if `propAccessNode` is `undefined`, no ASSIGNED_FROM edge is created and no exception is thrown. The comment states: "This can happen if the RHS member expression was not tracked by PropertyAccessVisitor (e.g., filtered out)." This is correct and safe.

### 4. Ordering: `bufferPropertyAccessNodes()` before `bufferPropertyAssignmentNodes()`

Confirmed by reading `CoreBuilder.buffer()` (lines 31–57 of `CoreBuilder.ts`):

```typescript
this.bufferPropertyAccessNodes(module, propertyAccesses, variableDeclarations, parameters, classDeclarations); // line 52
this.bufferCallbackEdges(methodCallbacks, functions);  // line 53
```

The plan inserts the new call "after line 52" (after `bufferPropertyAccessNodes`). Ordering is correct.

**Important nuance the plan correctly identifies:** The MEMBER_EXPRESSION lookup is performed against the in-memory `PropertyAccessInfo[]` array, not against graph nodes. The lookup only requires `PropertyAccessInfo.id` (to construct the ASSIGNED_FROM edge target), not a buffered graph node. The ordering guarantee is thus irrelevant for correctness — but keeping the new call after `bufferPropertyAccessNodes` is still good practice and the plan is right to note it.

### 5. `ObjectMutationValue` union extension — exhaustive switch risk

Adding `'MEMBER_EXPRESSION'` to the union.

All existing consumers of `ObjectMutationValue.valueType`:

- **`MutationBuilder.bufferObjectMutationEdges()`** (line 219): Uses `if (value.valueType === 'VARIABLE' ...)` — an if-chain, not a switch. Adding `'MEMBER_EXPRESSION'` causes it to silently fall through to the comment "For literals, object literals, etc. — we just track variable → object flows for now." This is correct behavior (MutationBuilder does not need to handle MEMBER_EXPRESSION; that is CoreBuilder's job).

- **`MutationDetector.ts`** (line 166) and **`JSASTAnalyzer.ts` second `extractMutationValue` block** (line 4598): These construct `ObjectMutationValue` objects — they are producers, not consumers of the discriminant. No switch on `valueType` here.

- **`CallFlowBuilder.bufferObjectPropertyEdges()`** (line 223): Uses `if (prop.valueType === 'VARIABLE' ...)` — an if-chain. Not an `ObjectMutationValue` consumer for this field pattern specifically.

- **`ReturnBuilder.ts`** and **`YieldBuilder.ts`**: Switch statements on `returnValueType` and `yieldValueType` respectively — these are completely different type discriminants (`ReturnStatementInfo.returnValueType`, `YieldExpressionInfo.yieldValueType`). Not `ObjectMutationValue.valueType`. No impact.

**Conclusion: No exhaustive switch break. Adding `'MEMBER_EXPRESSION'` to the union is safe.**

### 6. `propertyAccesses` availability in `CoreBuilder.buffer()`

`ASTCollections.propertyAccesses?: PropertyAccessInfo[]` exists at line 1208 of `types.ts`. The current `buffer()` method already destructures it at line 39:

```typescript
propertyAccesses = [],
```

The plan passes this existing `propertyAccesses` variable to `bufferPropertyAssignmentNodes()`. No new field needed — the data is already destructured. This is correct and requires no change to the destructure beyond the proposed `propertyAssignments = []` addition.

### 7. New edge cases introduced by the revision

The revision adds TSNonNullExpression unwrapping and MemberExpression handling to `extractMutationValue()`. New edge cases:

| New Case | Behavior | Assessment |
|----------|----------|------------|
| `options.graph!!` (double TSNonNullExpression) | Falls through to `'EXPRESSION'`; no ASSIGNED_FROM edge | Acceptable for V1; undocumented |
| `this.x = (options.graph as Graph)` (TSTypeAssertion) | Not a TSNonNullExpression; falls through to `'EXPRESSION'`; no ASSIGNED_FROM edge | Acceptable for V1 |
| `this.x = options` (Identifier after TSNonNullExpression: `options!`) | TSNonNullExpression unwraps to Identifier; `valueType: 'VARIABLE'`; ASSIGNED_FROM edge created | Correct, nice bonus |
| `this.x = options!.graph` (TSNonNullExpression on object before `.graph`) | The outer node is `MemberExpression`; no TSNonNull on the outer; `object` is `TSNonNullExpression` with `type !== 'Identifier'`; guard `effectiveValue.object.type === 'Identifier'` fails; falls through to `'EXPRESSION'` | Correct for V1 |

None of these constitute a blocker. The most notable gap (double-bang) is documented above as a minor issue.

---

## Confirmed Correct (Carries Over from v1 Verification)

All 10 points from `004-dijkstra-verification.md` remain confirmed. Additionally:

11. **`PropertyAssignmentInfo.valueType` cast** (`valueInfo.valueType as PropertyAssignmentInfo['valueType']`): The cast is necessary because `ObjectMutationValue.valueType` does not yet include `'MEMBER_EXPRESSION'` until the type is updated. The plan correctly specifies updating `ObjectMutationValue` in `types.ts` as part of the implementation order (Section 9, step 3). After that update, the cast will be redundant but harmless. Correct.

12. **Two-counter-ref initialization pattern**: The plan initializes `propertyAssignmentCounterRef` in both the module-level handler (Sub-step 5c) and `VariableHandler.ts` (STEP 6). The `if (!ctx.collections.propertyAssignmentCounterRef)` guard prevents double-initialization when both handlers fire for the same file. Correct.

13. **`propertyAssignmentCounterRef` is shared across both call sites** (JSASTAnalyzer module-level handler and VariableHandler). Since both write to `allCollections` / `ctx.collections` (the same `ASTCollections` object for a given file), the counter ref is correctly shared. IDs will not collide. Confirmed.

---

## Minor Issue (Does Not Block)

**[MINOR] Double-bang `options.graph!!` not documented.**

The plan handles one level of TSNonNullExpression unwrapping. Double-bang falls through silently to `'EXPRESSION'`. This is acceptable behavior but should be noted:
- Add `options.graph!!` row to the edge case table (Section 8).
- Add a one-line code comment in `extractMutationValue()` noting that only one TSNonNullExpression layer is unwrapped.

Rob may add this during implementation without a revised plan.

---

## Implementation Readiness

The plan is complete, internally consistent, and implementable without ambiguity. All acceptance criteria have concrete, verifiable implementation paths:

- **AC1** (`this.graph = options.graph!` → PROPERTY_ASSIGNMENT + ASSIGNED_FROM): TSNonNullExpression unwrap + MemberExpression case + PROPERTY_ACCESS lookup. Fully specified.
- **AC2** (`CONTAINS` edge from CLASS): Specified in `bufferPropertyAssignmentNodes()`. Fallback (skip edge) on missing class node is safe.
- **AC3** (multiple constructor assignments each produce a distinct node): Discriminator via `scopeTracker.getItemCounter()` + `computeSemanticIdV2`. Correct.

**APPROVE. Rob may proceed to implementation.**

---

## Summary

| Check | Result |
|-------|--------|
| BLOCKER 1 (`valueNodeId`) removed | FIXED |
| BLOCKER 2 (import line specified) | FIXED |
| TSNonNullExpression unwrapping (single level) | Correct |
| TSNonNullExpression double-bang edge case | Undocumented, not a blocker |
| MemberExpression matching logic | Sound |
| Fallback when PROPERTY_ACCESS not found | Specified (no crash, no edge) |
| Ordering of `bufferPropertyAccessNodes` before new method | Confirmed |
| `ObjectMutationValue` union extension — exhaustive switch risk | None found |
| `propertyAccesses` available in `buffer()` | Confirmed (already destructured) |
| New edge cases from revision | Acceptable for V1 |
| **Overall verdict** | **APPROVE** |
