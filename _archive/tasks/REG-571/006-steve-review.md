## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Does this serve the vision?

The vision is "AI should query the graph, not read code." That means every fix should make the graph more complete and more correct as a source of truth — not just silence warnings.

This PR does exactly that. The 2931 warnings were not false alarms from an overly strict validator. They were symptoms of three real gaps in the graph:

1. `OBJECT_LITERAL` and `ARRAY_LITERAL` were not recognized as terminal data values. The graph had these nodes but the validator didn't know they are leaf types. That's a gap in graph semantics.

2. `EXPRESSION` nodes computed entirely from literals had no `DERIVES_FROM` edges because there was nothing to derive from — all operands were constants. An `EXPRESSION` with zero outgoing `DERIVES_FROM` edges is semantically terminal. The fix makes the validator understand that invariant correctly.

3. Ternary `BRANCH` nodes were generating `HAS_CONSEQUENT`/`HAS_ALTERNATE` edges pointing to node IDs that were never created — dangling edges. Dangling edges are broken graph state. A broken graph cannot be a source of truth.

Each fix either corrects the validator's understanding of existing graph semantics (RC1, RC2) or stops the graph from being constructed incorrectly in the first place (RC3). None of these are workarounds. They are the right fixes at the right layer.

---

### Did we cut corners?

RC1 deserves scrutiny. Treating `EXPRESSION` with zero `DERIVES_FROM` as terminal is an inference, not a structural guarantee. The question is: can this inference produce false negatives — cases where an `EXPRESSION` genuinely lacks `DERIVES_FROM` edges due to a bug in the enricher rather than all-literal operands?

Looking at RC1's implementation: it only fires when `DERIVES_FROM` count is zero. If the enricher failed to emit a `DERIVES_FROM` edge for a variable operand, RC1 would incorrectly silence a real gap. However:

- The condition is narrow and scoped only to `EXPRESSION` type nodes.
- The test coverage validates the invariant empirically: a `1 + 2` expression has zero `DERIVES_FROM` edges by design, and a `a + 2` expression has one. The model is consistent.
- RC1 does not fix the cause; it teaches the validator the correct semantic. That is appropriate.

The real question is whether the enricher is reliable enough that zero `DERIVES_FROM` on an `EXPRESSION` is always intentional. If there are enricher bugs that silently drop edges, RC1 would hide them. That is a risk worth noting — but it is not a reason to reject. It is a reason to ensure enricher tests are solid. The fix is sound given the current model.

RC3 is the cleanest fix. Stop generating an ID for a node that won't exist. The `producesExpressionNode()` helper is well-documented, keeps the logic in one place, and the content-based checks for `TaggedTemplateExpression` and `TemplateLiteral` match the actual conditions in `trackVariableAssignment`. The comment in the code explicitly flags the sync requirement — that is honest engineering.

---

### Complexity and Architecture Checklist

**O(n) scans:** RC1 adds one `getOutgoingEdges` call per `EXPRESSION` node encountered during path traversal. This is not a scan over all nodes — it is a targeted edge query on a node already in hand. No O(n) concern.

**Plugin architecture:** All changes stay within the existing plugin and handler abstractions. `DataFlowValidator` extends `Plugin`. `BranchHandler` extends `FunctionBodyHandler`. No new subsystems introduced.

**Extensibility:** Adding a new expression type that is always terminal would require adding it to `leafTypes`. Adding one that only conditionally produces an `EXPRESSION` node requires updating `EXPRESSION_PRODUCING_TYPES` or `producesExpressionNode()`. Both are single-place changes. The comment on `EXPRESSION_PRODUCING_TYPES` explicitly documents the sync requirement with `trackVariableAssignment` cases. That is the right pattern given the current architecture — the comment is the contract.

---

### Would shipping this embarrass us?

No. The fixes are targeted, the tests verify the actual graph structure (not just absence of errors), and the approach is honest about the semantics. The graph becomes a more reliable source of truth after this lands.
