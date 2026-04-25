# Steve Jobs Vision Review — REG-571 v2

**Date:** 2026-02-23
**Reviewer:** Steve Jobs (Vision Reviewer)
**Version:** v2 — reimplemented after RC1 rejection

---

## Verdict: APPROVE

---

## The Core Question

The original rejection was right. v1 made the validator tolerant of missing edges — that is the opposite of what Grafema stands for. The validator exists to tell us when the graph is incomplete. Making it quieter is the wrong direction entirely.

v2 does the right thing: the graph now contains real DERIVES_FROM edges from EXPRESSION nodes to inline LITERAL nodes. When `1 + 2` appears in code, the graph now encodes that — two LITERAL nodes exist, two DERIVES_FROM edges exist. The information is in the graph. That is exactly where it belongs.

---

## Vision Alignment

**Vision: "AI should query the graph, not read code."**

Before this change, `const x = 1 + 2` produced an EXPRESSION node in the graph but provided no answer to "where does x come from?" The validator correctly reported ERR_NO_LEAF_NODE. The v1 fix silenced the validator. The v2 fix answers the question properly.

Now an agent querying the graph can ask: "What literal values flow into this expression?" and get a real answer. That is the product improving in the right direction.

The DataFlowValidator additions (OBJECT_LITERAL, ARRAY_LITERAL as leaf types) are also correct. Object and array literals are ground-truth values. They terminate data flow chains. Recognizing them as leaves is accurate — not tolerant.

**This change makes the graph a more complete source of truth. It is aligned with the vision.**

---

## Architecture

### What was built

1. **JSASTAnalyzer** detects when an expression operand is not an Identifier but is a literal value. It stores the literal value, line, and column in `VariableAssignmentInfo`.

2. **AssignmentBuilder** reads that metadata and, during the buffering phase, creates an inline LITERAL node via `NodeFactory.createLiteral()` and buffers a DERIVES_FROM edge from the EXPRESSION to that LITERAL.

3. **DataFlowValidator** adds OBJECT_LITERAL and ARRAY_LITERAL to its leaf type set.

4. **BranchHandler** gates `consequentExpressionId` and `alternateExpressionId` generation on whether the AST node actually produces an EXPRESSION node — fixing dangling HAS_CONSEQUENT / HAS_ALTERNATE edges.

### Is the architecture sound?

Yes. The pattern is already established: EXPRESSION nodes derived from identifiers already had DERIVES_FROM edges to variable nodes. This change extends the same pattern to literal operands. There is no new abstraction, no new subsystem. The same pipe, carrying more water.

The `producesExpressionNode()` helper in BranchHandler is a clean content-based check. It is placed at the correct level — BranchHandler is the place that decides whether to emit consequent/alternate expression IDs.

### O(n) concerns

Each `VariableAssignmentInfo` with literal operands generates at most two extra nodes (LITERAL) and at most two extra edges (DERIVES_FROM). The work is bounded per assignment, not per file or per graph. O(n) with a small constant. No concern.

### One gap I see

The detection in JSASTAnalyzer uses `ExpressionEvaluator.extractLiteralValue()`. I do not see handling for nested expressions like `1 + 2 + 3` — the left operand of the outer `BinaryExpression` would be another `BinaryExpression`, not a literal. `extractLiteralValue` would return null for it. The inner EXPRESSION would itself lack DERIVES_FROM edges to its literal operands.

This is not a regression — it was broken before. It is a known gap in scope. The fix is correct for the cases it handles. Nested compound literals are a follow-on task, not a blocker.

---

## Test Quality

The tests are specific and structural. They do not test "no error occurred." They test the actual graph: DERIVES_FROM exists, it points to a LITERAL node, the LITERAL node exists. That is the right way to test a graph tool.

The RC3 ternary tests check for dangling edges — again, structural graph integrity, not just behavioral outcomes. These tests will catch future regressions if someone changes BranchHandler.

Eight tests covering the four expression types plus the ternary edge case is adequate coverage for the scope of this change.

---

## Would Shipping This Embarrass Us?

No. The graph is more truthful after this change than before it. A user or agent querying `const x = obj.timeout || 10` now sees the literal `10` in the graph as a reachable node. Before this change, the data flow chain was a dead end. Dead ends embarrass us. This fixes dead ends.

The one thing that would embarrass us is if the gap for nested expressions (`1 + (2 + 3)`) surfaced as a validator error on real code. That risk exists today and was not introduced by this change. It should be tracked.

---

## Summary

| Concern | Assessment |
|---|---|
| Vision alignment | Correct — graph gains real data, not tolerance |
| Architecture pattern | Extends existing pattern, no new abstraction |
| O(n) performance | Bounded per assignment, no concern |
| Test quality | Structural graph assertions, correct |
| Known gap | Nested compound literals not detected (pre-existing, not introduced here) |
| Ship it? | Yes |
