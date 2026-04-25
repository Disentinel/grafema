# REG-503: Batch 1 Reviews — Expose Explain Mode Through NAPI → Client → MCP → CLI

**Date:** 2026-02-18

---

## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** Excellent. The explain feature is a direct implementation of Grafema's thesis — it makes the graph queryable in a way that is superior to reading code. The primary use case is an AI agent that gets zero results from `query_graph` and cannot understand why. With `explain: true`, the agent sees exactly which predicate caused the funnel to drop to zero, without ever needing to look at source files. This closes a concrete product gap: previously, an AI agent had no recourse when a Datalog query returned nothing. Now it does.

The MCP integration (`query_graph` with `explain: true`) is the right first-class surface. The CLI `--explain` flag is the right second-class surface for human developers who build and debug queries. Both serve the AI-first tool mission.

**Architecture:** Clean. The feature piggybacks on the existing `EvaluatorExplain` Rust infrastructure — no new graph traversal, no new analysis engine. The `ExplainResult` wire variant is returned only on demand (`explain: true`), so the hot path (the vast majority of queries) has zero added cost. The TypeScript overload pattern means callers that don't use explain don't see any type change. This is minimal surface area for maximum diagnostic value.

No corners cut on the vision side. The output format is LLM-readable text (not JSON objects), which is the right choice for an AI-first tool. The step-by-step funnel format (`predicate → N results`) directly answers the question an agent would ask: "where did my query go wrong?"

One minor note: plan decision D6 says the CLI output should note "(not yet tracked)" next to `rule_eval_time` and `projection_time_us`, since those fields are always 0 from the Rust side. The implementation omits this annotation. This is a small UX gap — an agent seeing `Rule evaluations: 0` and `Total duration: 135 µs` could be confused about whether 0 is real or unimplemented. Not a rejection reason, but should be addressed in a follow-up.

---

## Вадим auto — Completeness Review

**Verdict:** REJECT

**Feature completeness:**

The core functionality is implemented and correct:

- Rust `EvaluatorExplain.eval_query()` — added and correct (`packages/rfdb-server/src/datalog/eval_explain.rs:186-265`)
- Socket protocol — `explain: bool` with `#[serde(default)]` added to `CheckGuarantee`, `DatalogQuery`, `ExecuteDatalog` (`packages/rfdb-server/src/bin/rfdb_server.rs:199-216`)
- `ExplainResult(WireExplainResult)` response variant — present, correct per-query structure (not per-row), matches Gap 3 fix from `005-plan-revision.md`
- TypeScript types `QueryStats`, `QueryProfile`, `ExplainStep`, `DatalogExplainResult` — all present in `packages/types/src/rfdb.ts:362-399`
- `IRFDBClient` interface overloads — present in `packages/types/src/rfdb.ts:538-546`
- JS client overloads on `datalogQuery`, `checkGuarantee`, `executeDatalog` — present and correct (`packages/rfdb/ts/client.ts:866-938`)
- `RFDBServerBackend` overloads — present and correctly forwarding (`packages/core/src/storage/backends/RFDBServerBackend.ts:673-741`)
- MCP `explain: boolean` in tool schema — present in `packages/mcp/src/definitions.ts:63-66`; `QueryGraphArgs.explain` in `packages/mcp/src/types.ts:48`
- CLI `--explain` flag, `renderExplainOutput`, `DatalogExplainResult` import — all present and correct (`packages/cli/src/commands/query.ts`)

The NAPI exclusion (D5) is correct and documented.

**Specific issues that cause REJECT:**

**Issue 1 — Missing guard: `--explain` without `--raw` silently does nothing.**

Plan Step 7f explicitly requires: "If `--raw` is absent, warn: `Note: --explain requires --raw. Ignoring --explain.`"

In `packages/cli/src/commands/query.ts:173-178`, when `options.raw` is falsy the code falls through to the non-raw query path, passing `options.explain` to `executeRawQuery` — but `executeRawQuery` is only called inside the `if (options.raw)` block. If the user runs `grafema query "some pattern" --explain` without `--raw`, the `--explain` flag is silently ignored with no feedback. An AI agent or developer will not know their `--explain` flag did nothing. The plan explicitly anticipated and required this guard.

**Issue 2 — Missing JS/TS integration and unit tests (plan specified 3 new test files, 0 delivered).**

The plan (`003-don-plan.md` Steps 4, 5, 6, 7; test strategy table) required:
- `test/scenarios/rfdb-client.test.js` — new cases for `checkGuarantee` with `explain=true`, `executeDatalog` with `explain=true`, and a non-explain regression test (Gap 4 fix in `005-plan-revision.md`)
- `test/unit/mcp/query-handlers-explain.test.js` — new file, mock db, assert explain path invokes `checkGuarantee(query, true)` and output contains "Step-by-step execution"
- `test/unit/commands/query-explain.test.js` — new file, `--explain` flag parsing, `renderExplainOutput` output capture, `--explain` without `--raw` warning

`git diff HEAD --name-only` shows only `packages/rfdb-server/src/datalog/tests.rs` as a test change. Zero new JS test files exist. The Rust tests in `tests.rs` are correct and thorough, but the JS layer is completely untested. Given that the JS client has a non-trivial response parsing path (`response as unknown as DatalogExplainResult & { requestId?: string }`) and the MCP handler has a double `(db as unknown as ...)` cast, these are exactly the paths most likely to fail silently.

**Issue 3 — MCP handler uses `checkGuarantee` for explain but should use `executeDatalog`.**

The MCP `handleQueryGraph` explain path (`packages/mcp/src/handlers/query-handlers.ts:42-46`) calls `checkGuarantee(query, true)`. The non-explain path also calls `checkGuarantee`. However, the CLI's `executeRawQuery` calls `backend.executeDatalog`. These are different wire requests — `CheckGuarantee` and `ExecuteDatalog` — which have different semantics: `CheckGuarantee` wraps the query in a `violation(X) :-` rule context, while `ExecuteDatalog` runs the query directly. For the MCP `query_graph` tool, where users write arbitrary Datalog like `node(X, "FUNCTION"), attr(X, "name", "main")`, using `checkGuarantee` is correct (it is what the non-explain path already does). This is not a bug in the explain path itself — the explain path correctly mirrors the non-explain path.

However, plan Risk R3 noted: "the explain changes must be applied to BOTH." The implementation does apply explain to all three request types in the Rust protocol. This is fine. No reject for this point — the MCP using `checkGuarantee` is intentional and consistent.

Withdrawing Issue 3 — this is not a defect.

**Test coverage:**

- Rust `EvaluatorExplain` tests: 5 tests added, good coverage. `test_explain_eval_query_produces_steps`, `test_explain_eval_query_no_explain_empty_steps`, `test_explain_query_produces_steps`, `test_explain_bindings_match_plain_evaluator`, `test_explain_stats_populated`. All targeted and correct.
- JS client: 0 tests. Explain path untested end-to-end.
- MCP handler: 0 tests. The `formatExplainOutput` function and the `checkGuarantee(query, true)` cast path are untested.
- CLI `renderExplainOutput`: 0 tests. The `--explain` without `--raw` guard (which is also missing from implementation) is untested.
- `RFDBServerBackend` explain forwarding: 0 tests.

**Commit quality:**

No commits yet (all changes are unstaged working tree modifications). Not a blocking concern at review time, but noting that when committed, these should be split into logical commits per the project's Small Commits policy: Rust protocol + tests, then TS types, then JS client, then Backend, then MCP, then CLI.

**Summary of required fixes before approval:**

1. Add `--explain` without `--raw` guard to `packages/cli/src/commands/query.ts` (plan Step 7f)
2. Add JS integration tests: `test/scenarios/rfdb-client.test.js` — at minimum the `checkGuarantee(source, true)` → `explainSteps` assertion and the non-explain regression test
3. Add MCP unit test: `test/unit/mcp/query-handlers-explain.test.js` — mock db, assert `checkGuarantee` called with `(query, true)` and output contains "Step-by-step execution"
4. Add CLI unit test: `test/unit/commands/query-explain.test.js` — `--explain` flag parsing and `renderExplainOutput` output verification
