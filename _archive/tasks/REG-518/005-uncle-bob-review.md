# Uncle Bob Code Quality Review — REG-518

**Reviewer:** Robert Martin (Uncle Bob)
**Task:** REG-518 — `type()` predicate not implemented in Rust evaluator
**Verdict:** APPROVE with one minor observation

---

## File Size Check

| File | Lines | Status |
|------|-------|--------|
| `eval.rs` | 882 | Over the 500-line guideline — pre-existing, not introduced by this PR |
| `eval_explain.rs` | 858 | Over the 500-line guideline — pre-existing, not introduced by this PR |
| `utils.rs` | 406 | Within limit |
| `tests.rs` | 2570 | Over the 500-line guideline — pre-existing, not introduced by this PR |
| `query-handlers.ts` | 286 | Within limit |

All three over-limit files were pre-existing. This PR did not push any file over the threshold — it only added 25-30 lines to `tests.rs`. The technical debt in file sizes belongs to a separate cleanup task, not this PR.

---

## Single Responsibility

Each modified file has a clear, singular responsibility and the changes made respect those boundaries:

- `eval.rs` — dispatch and evaluation. The change stays in `eval_atom()` where it belongs.
- `eval_explain.rs` — explain-mode evaluation. The change is symmetric with `eval.rs`.
- `utils.rs` — query planning utilities. The change is in the planner's classification logic where it belongs.
- `query-handlers.ts` — MCP query handling. The regex extension stays in the "did you mean" hint path.

Single responsibility: maintained.

---

## Pattern Consistency

### `"node" | "type" =>` in Rust

This is idiomatic Rust. The `|` pattern in `match` arms for string aliases is the correct and standard approach. It avoids:
- A separate `eval_type()` function (duplication that would drift)
- A pre-processing normalization pass (indirection that obscures intent)
- Any runtime overhead (compiled to the same branch)

The pattern is used identically in all three Rust dispatch tables (`eval.rs:180`, `eval_explain.rs:265`, `utils.rs:166`). The consistency across the three tables is important: if any one diverged from the others, `type()` would silently fail in that specific mode. All three are aligned.

### Regex `(?:node|type)` in TypeScript

The non-capturing group `(?:...)` is the correct choice here — we are not capturing the predicate name, only the type argument. Using `(node|type)` would shift the capture group index for `typeMatch[1]` which would be a silent bug. The implementer used `(?:...)` correctly.

The regex is minimal and readable. No issues.

---

## Changes Minimal and Clean?

Each change is surgical:
- `eval.rs`: one `|` character and `"type"` added to an existing match arm
- `eval_explain.rs`: identical one-character change
- `utils.rs`: identical one-character change (the block following the match arm is unchanged)
- `query-handlers.ts`: `node` expanded to `(?:node|type)` in one regex

No new abstractions, no new state, no new code paths. The diff is as small as a correct fix for this problem can possibly be.

---

## Test Quality

Both new tests are placed in the correct section of `tests.rs` (alongside the existing `test_eval_node_by_type` and `test_eval_node_by_id` tests they pair with).

**`test_type_alias_returns_same_results_as_node`**

Tests the contract that matters: not merely "type() returns something" but "type() returns exactly what node() returns." The sort before comparison is correct — `eval_atom` does not guarantee ordering, so without sort this would be a flaky test. The hardcoded count assertion (`== 2`) documents the expected test graph state, which is useful. This test would catch any future regression where `type()` and `node()` diverge in output.

**`test_type_alias_by_id`**

Tests the reverse lookup direction `(Const, Var)`. This is the complementary case to `test_type_alias_returns_same_results_as_node` which tests the `(Var, Const)` direction. Together, the two tests cover the two primary usage patterns for the predicate.

Both tests follow the existing test pattern in the file: `setup_test_graph()` → `Evaluator::new()` → construct atom directly → `eval_atom()` → assert. No deviation from established conventions.

One minor observation: the comment in `test_type_alias_returns_same_results_as_node` at line 521 reads as a documentation comment rather than a `/ query` inline annotation as used in the nearby `test_eval_node_by_type` (line 506: `/ node(X, "queue:publish")`). The style is slightly inconsistent, but the meaning is clear and the test itself is correct. This is a cosmetic issue, not a defect.

---

## Unrelated `package.json` Change

`packages/mcp/package.json` adds a `./utils` export path. Steve's review already identified this. I confirm: it is not connected to REG-518 and violates the small-commits principle (one logical change per commit). However, it is not harmful — it exports a `./utils` entry that presumably exists or will exist in the package.

This should be reverted or moved to a separate commit. The concern is identical to Steve's and I will not repeat his analysis further.

---

## What Was Not Done (Correctly)

The implementer correctly left alone:
- `GuaranteeManager.extractRelevantTypes()` — the regex there only matches `node(`, not `type(`. This is a pre-existing gap that Vadim's review correctly flagged as out-of-scope. The acceptance criterion did not ask for it, and touching it here would be scope creep.
- The `attr_edge` asymmetry between `eval.rs` and `eval_explain.rs` — `eval.rs` has `"attr_edge"` in its dispatch table while `eval_explain.rs` does not. This is pre-existing. Not touching it is correct.

---

## Summary

The implementation is correct, minimal, and consistent. Tests are well-constructed and test the invariant that matters. All three Rust dispatch tables are aligned. The TypeScript regex is idiomatic.

Two items flagged by prior reviewers remain valid:
1. **`package.json` change** — must be reverted or separated (Steve, confirmed here)
2. **`GuaranteeManager.extractRelevantTypes()`** — must be tracked as a follow-up (Vadim, confirmed here)

Neither item is a defect in the core implementation.

**Verdict: APPROVE** — conditional on resolving the unrelated `package.json` change before merge.
