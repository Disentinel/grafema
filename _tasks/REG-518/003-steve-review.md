# Steve Jobs Vision Review — REG-518

**Reviewer:** Steve Jobs (Vision Reviewer)
**Task:** REG-518 — `type()` predicate not implemented in Rust evaluator
**Verdict:** APPROVE with one note

---

## The One-Sentence Summary

This is a bug fix, not a feature — something we documented as working simply wasn't, and this makes it work. That's it. Ship it.

---

## Vision Alignment

The vision is "AI should query the graph, not read code." Every predicate that fails silently is a hole in that vision. When an AI agent writes `type(X, "http:request")` — which is the *documented primary form* — and gets zero results with no error, it doesn't go back and read the docs. It reads the code instead. That is exactly what we're trying to prevent.

This fix directly serves the vision. A broken `type()` predicate is not a minor inconvenience — it's a fundamental breach of trust with every agent using the tool.

---

## Architecture: Is Making `type()` an Alias the Right Approach?

Yes. The alias approach is correct for this codebase at this stage, for three reasons:

**1. The CLI documentation already defines the relationship.** The task description states that `type()` is the primary predicate and `node()` is the alias. However, looking at `definitions.ts`, the MCP tool documentation only mentions `node(Id, Type)` — not `type()`. That's an inconsistency worth noting, but it doesn't invalidate the fix.

**2. The implementation is symmetric and complete.** The change touches all three required dispatch points consistently: `eval.rs`, `eval_explain.rs`, and `utils.rs` (reorder classification). All three use the same `"node" | "type"` pattern. If any one of the three had been missed, `type()` would fail in a specific mode (explain mode, or reordering). All three are covered. That's disciplined work.

**3. No semantic duplication.** The alias is pure dispatch — `type()` resolves to `eval_node()` immediately. There is no separate `eval_type()` implementation that could drift from `eval_node()` over time. The single function is the ground truth for both predicates. This is the right pattern.

---

## Did We Cut Corners?

No. The actual change is minimal and surgically precise:

- `eval.rs` line 180: `"node" => ...` becomes `"node" | "type" => ...` (1 character change in logic)
- `eval_explain.rs` line 265: same 1-character change
- `utils.rs` line 166: same 1-character change in the reorder classifier
- `query-handlers.ts` line 56: regex extended from `node\(` to `(?:node|type)\(` — the "did you mean" hint now fires for `type()` queries too

Four single-line changes. No abstraction introduced, no new code paths, no new state. It's the simplest correct fix.

---

## Tests

Two tests were added:

**`test_type_alias_returns_same_results_as_node`** — Runs the same logical query with both predicates and asserts identical result sets (sorted by ID). This is the right test. It locks the alias contract: not just "type() returns something" but "type() returns exactly what node() returns."

**`test_type_alias_by_id`** — Tests the reverse direction: `type(id, Var)`. Both modes of `eval_node()` are covered (by-type scan and by-id lookup).

The test quality is good. They are specific, they test the invariant that matters (equality, not just non-emptiness), and they don't duplicate existing infrastructure.

---

## One Out-of-Scope Change

`packages/mcp/package.json` adds a `./utils` export to the package manifest. This is not connected to REG-518 in any way. Looking at the change — it adds a package export path for `./utils` — this appears to be leftover from another task or exploratory work. It is not harmful, but it should not be in this commit.

**Action required before merging:** Revert the `package.json` change or move it to a separate commit with its own justification. The commit must be atomic.

---

## Would Shipping This Embarrass Us?

The fix itself — no. Four one-line changes to make a documented predicate actually work, with two clean tests. This is exactly what a professional team ships.

The `package.json` noise in the diff — slightly. Keep commits clean.

---

## Final Verdict

**APPROVE** — conditional on reverting or separating the unrelated `package.json` change.

The core implementation is correct, complete, minimal, and properly tested. The architecture decision (alias via dispatch) is the right one. This fixes a real silent failure that directly undermines our value proposition.
