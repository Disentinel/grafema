# Uncle Bob PREPARE: REG-554

## File Sizes

| File | Lines | Verdict |
|------|-------|---------|
| `packages/types/src/nodes.ts` | 408 | Over 300 — but we only ADD lines (enum entry, interface, union member). No existing method to split. Accept. |
| `packages/core/src/plugins/analysis/ast/types.ts` | 1293 | Large, but we only ADD an interface and two fields. Not touching existing methods. Accept. |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | 4639 | Large file. Two methods we touch: `detectObjectPropertyAssignment` and `extractMutationValue`. Reviewed below. |
| `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` | 363 | Slightly over 300. We add ~100 lines via `bufferPropertyAssignmentNodes()`. Post-task file will be ~460 lines. Acceptable — the file is a single-purpose builder and new method is cohesive with existing ones. |

---

## Methods Under Review

### `detectObjectPropertyAssignment()` — 103 lines (4184–4286) — SKIP

The method is 103 lines, which exceeds 50. However, the plan adds roughly 40 more lines (new signature params + the `propertyAssignments.push(...)` block), taking it to ~143 lines.

That said — refactoring it is out of scope for two reasons:

1. The method body is not complex: it is one linear decision tree (early returns for non-matching AST node shapes), then a push to `objectMutations`. There are no nested loops, no branching that branches inside branches. It reads sequentially.
2. The existing push block (`objectMutations.push(...)`) is the template for the new push block we are adding. Splitting the method now would require passing new parameters into extracted sub-methods, adding coupling complexity for zero readability gain.

The new `propertyAssignments.push(...)` block (plan STEP 5b) slots naturally after the existing push — same level, same pattern, independent guard. The method stays linear.

**Decision: SKIP.** Do not refactor `detectObjectPropertyAssignment()` before or during this task.

---

### `extractMutationValue()` — 24 lines (4536–4559) — SKIP

Currently 24 lines. The plan replaces it with a ~33-line version (adding TSNonNullExpression unwrapping and the MemberExpression branch). Final size: ~33 lines. Well within limit. Structure is a flat if/else-if chain — correct pattern for this kind of type dispatch.

**Decision: SKIP.**

---

### `buffer()` in `CoreBuilder.ts` — 27 lines (31–57) — SKIP

The plan adds one destructure entry and one method call. Final size: ~29 lines. No issue.

**Decision: SKIP.**

---

### `bufferPropertyAccessNodes()` — 78 lines (222–299) — our template — NOTE

This is the template for `bufferPropertyAssignmentNodes()`. It runs 78 lines — above 50 but below 100, and structured as one loop with three logically distinct phases (buffer node, buffer CONTAINS edge, buffer READS_FROM/ASSIGNED_FROM edge). It is readable as-is.

We are NOT modifying this method. We are modeling our new method after it.

**Decision: SKIP (not modified).**

---

### `bufferPropertyAssignmentNodes()` — new method, ~95 lines from plan — REVIEW

The plan's method body (STEP 7d) runs approximately 95 lines including the JSDoc comment block (~30 lines of doc + ~65 lines of code). The code-only body is ~65 lines — above 50.

However, splitting it would produce exactly two natural sub-methods:
- `bufferPropertyAssignmentNode()` — buffer the node + CONTAINS edge
- `resolveAssignedFromEdge()` — resolve and buffer the ASSIGNED_FROM edge

These would each be ~25–30 lines. The split is clean. But is it necessary?

Examining the plan's code: the ASSIGNED_FROM resolution block (the `if (propAssign.valueType === 'VARIABLE' ...)` through `else if (propAssign.valueType === 'MEMBER_EXPRESSION' ...)` section) is ~35 lines of dense lookup logic with two distinct paths. It is the only part that risks becoming hard to follow at a glance.

**Decision: ONE targeted extract — `bufferAssignedFromEdge()`.** Extract the ASSIGNED_FROM resolution block into a private helper. This keeps `bufferPropertyAssignmentNodes()` under 50 lines (the loop body becomes ~30 lines) and isolates the two-path lookup logic in its own named method (~35 lines). This is "one level better", not "perfect."

Rob: implement `bufferPropertyAssignmentNodes()` with the ASSIGNED_FROM resolution extracted to a private `bufferAssignedFromEdge(propAssign: PropertyAssignmentInfo, propertyAccesses: PropertyAccessInfo[], variableDeclarations: VariableDeclarationInfo[], parameters: ParameterInfo[]): void` method. Everything else from the plan is unchanged.

---

## Refactoring Plan

**One extraction only:**

Extract from `bufferPropertyAssignmentNodes()`:

```typescript
private bufferAssignedFromEdge(
  propAssign: PropertyAssignmentInfo,
  propertyAccesses: PropertyAccessInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[]
): void {
  // The VARIABLE and MEMBER_EXPRESSION resolution blocks from the plan.
  // LITERAL/CALL/EXPRESSION: no-op (falls through, no edge).
}
```

`bufferPropertyAssignmentNodes()` calls `this.bufferAssignedFromEdge(propAssign, propertyAccesses, variableDeclarations, parameters)` instead of inlining the resolution. Resulting sizes:
- `bufferPropertyAssignmentNodes()`: ~45 lines (under 50)
- `bufferAssignedFromEdge()`: ~35 lines (under 50)

No other refactoring. No renaming of public API. No changes to other methods.

---

## Verdict: REFACTOR FIRST

Minor — extract `bufferAssignedFromEdge()` while implementing `bufferPropertyAssignmentNodes()`. Do it inline during implementation (STEP 7d), not as a separate commit. The rest of the plan proceeds as written.
