# STEP 2.5 — Uncle Bob Prepare Review

**Date:** 2026-02-22
**Task:** REG-562 — class field arrow function duplication
**Reviewer:** Robert Martin (Uncle Bob)
**Phase:** PREPARE — pre-implementation review

---

## Files Reviewed

1. `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` — 455 lines
2. `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` — 839 lines (context only)

---

## FunctionVisitor.ts — Primary Target

**File size:** 455 lines. Well under the 500-line hard limit. No split required.

**`ArrowFunctionExpression` handler:** lines 292–389, approximately **97 lines**.

This exceeds the 50-line "candidate for split" threshold. However, context matters. The method body is a single, linear sequence of operations with no branching other than the existing guard at line 295–296 and optional-collection checks. It is not doing multiple unrelated things — every line contributes to the same job: build and register one FUNCTION node for a top-level arrow function. The length is driven by data construction (collecting params, types, signature, scope, type parameters) not by complexity. There is no nesting beyond depth 2.

The method is not a refactoring candidate at this time. Splitting it would produce helpers that each do one tiny thing and share all the same local variables, which would require passing several arguments or closing over state — creating more coupling, not less.

**Parameter count:** `getHandlers()` itself takes zero parameters. The handler closures capture locals from the surrounding scope. This is the established pattern in this file and in `ClassVisitor.ts`. Acceptable.

**Nesting depth in `ArrowFunctionExpression`:** maximum depth 2 (the `for` loop inside the type-parameters `if`). No issue.

**The insertion point for the new guard** is the very top of the handler (lines 292–296). The existing guard is:

```typescript
ArrowFunctionExpression: (path: NodePath) => {
  // Skip arrow functions nested inside other functions — those are handled
  // by NestedFunctionHandler during analyzeFunctionBody traversal.
  const functionParent = path.getFunctionParent();
  if (functionParent) return;
  // ... rest of handler
```

This is a clean early-return pattern. Adding one more `if` guard immediately after (or modifying this one) is straightforward and safe. The guard site is already well-understood: it is the canonical "should we handle this node?" check, and the new condition (skip when inside a class body / class field context) belongs right alongside it.

**Verdict for FunctionVisitor.ts:** Ready to receive the change. No refactoring needed.

---

## ClassVisitor.ts — Context Only

**File size:** 839 lines. This is above the 700-line critical threshold.

However, this file is explicitly out of scope for REG-562. The task touches only `FunctionVisitor.ts`. Flagging the size here as an observation for the backlog — `ClassVisitor.ts` handles `ClassDeclaration`, `ClassExpression`, and all nested sub-handlers (`ClassMethod`, `ClassProperty`, `ClassPrivateProperty`, `ClassPrivateMethod`, `StaticBlock`). There is meaningful duplication between the `ClassDeclaration` and `ClassExpression` branches (the nested traversal blocks are near-identical). That is a separate concern and should not be addressed in this task.

**No action required in `ClassVisitor.ts` for REG-562.**

---

## Summary

| File | Lines | Status |
|------|-------|--------|
| `FunctionVisitor.ts` | 455 | Ready — no refactoring needed |
| `ClassVisitor.ts` | 839 | Out of scope — flag for future cleanup |

**Implementation can proceed.** The `ArrowFunctionExpression` handler is clean, the insertion point is obvious, and the change is a one-guard addition with no structural risk.

One note for the implementer: confirm whether the guard should use `path.getFunctionParent()` (already present) or a more specific check such as `path.parent.type === 'ClassProperty'`. The existing `getFunctionParent()` guard handles functions-inside-functions, but class field arrow functions sit inside a `ClassProperty`, not inside another function. `getFunctionParent()` will return `null` for a class field arrow because `ClassProperty` is not a function scope. The new guard must therefore be a separate, explicit class-context check — it cannot simply extend the existing one.
