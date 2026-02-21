## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

The graph is the product. When an AI agent queries `type == 'CALL' AND isNew == true`, it finds nothing — and that is correct. When it queries `type == 'CONSTRUCTOR_CALL'`, it finds exactly what it should. Every `new X()` now maps to exactly one semantically accurate node. Queries are now unambiguous. That is the whole point.

Before this fix, a consumer of the graph had to choose: do I query CALL and filter by `isNew`, or query CONSTRUCTOR_CALL? Both produced the same expression. Neither was authoritative. That kind of ambiguity undermines every Datalog rule that touches constructor calls. The fix eliminates the choice by eliminating the wrong option.

### Architecture

The fix is pure deletion, which is the best kind of fix. No new abstractions, no new code paths, no filtering applied downstream to hide the symptom. The source of the duplicate was found and cut out.

The scope of the deletion was verified:

1. `NewExpressionHandler.ts` — creates only `CONSTRUCTOR_CALL`. The old `CALL(isNew)` block is gone. Confirmed.
2. `CallExpressionVisitor.ts` — the `handleNewExpression()` method that produced the duplicate CALL nodes has been removed. The remaining handlers (`handleDirectCall`, `handleMemberCall`) have no path to a NewExpression. Confirmed.
3. `call-expression-types.ts` (visitor-level types) — `isNew?: boolean` removed from `CallSiteInfo`. Confirmed.
4. `types.ts` (AST-level types) — `isNew?: boolean` removed from both `CallSiteInfo` and `MethodCallInfo`. Confirmed.

A third code path was investigated: `JSASTAnalyzer.ts` contains a module-level `NewExpression` traverse block (lines 1730-1790) and a function-body path via `NewExpressionHandler`. Both produce only `CONSTRUCTOR_CALL`. No residual `CALL(isNew)` logic exists anywhere in `packages/core/src/`.

A broad grep across the source confirms: no `isNew` property assignments remain in production code. Test files reference `isNew` only to assert its absence — which is the correct way to lock this behavior.

### Concerns

None. This is a clean fix to a real graph quality defect. Shipping this is the right call.
