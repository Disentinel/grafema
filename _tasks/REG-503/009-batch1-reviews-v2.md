## Steve Jobs — Vision Review (v2)

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

This feature is exactly what "AI should query the graph, not read code" means in practice. When an AI agent writes a Datalog query and gets no results, today it has no recourse except to guess. With explain mode, the agent sees precisely where the funnel collapsed to zero — which predicate failed, how many candidates survived each step, and how long each step took. That is giving the AI better instrumentation of the graph engine, not giving it a reason to go back to reading files.

The MCP handler formats explain output as structured text explicitly designed for LLM consumption. The CLI renders it as a human-readable step-by-step trace. Both are appropriate for their audiences, and neither defers the value — this ships complete.

**Architecture check:**

The implementation follows the existing protocol extension pattern correctly. `serde(default)` on the `explain` field ensures full backward compatibility — old clients that don't send the field get the existing behavior without a code path change. The `ExplainResult` response variant is a separate, typed response rather than an overloaded field mutation on existing responses. That is the right call. The TypeScript overloads (`explain: true` literal, not `boolean`) are narrow enough to allow genuine return-type discrimination without runtime branching at the call site.

The `_parseExplainResponse` helper in `RFDBClient` is correctly isolated and the three Datalog methods (`datalogQuery`, `checkGuarantee`, `executeDatalog`) all use it consistently.

The Rust side delegates entirely to the existing `EvaluatorExplain` — no new evaluation logic, just routing. The `query_result_to_wire_explain` conversion is a pure mapping function with no iteration over the full graph.

**Complexity check:** No O(n) scans over all nodes or edges introduced. The explain data is a by-product of the query execution that was already happening, not an additional traversal.

One minor observation that does not block approval: `renderExplainOutput` in the CLI iterates `result.explainSteps` without a cap, while `formatExplainOutput` in the MCP handler caps at 50 steps. This is an inconsistency in defensive limits between the two surfaces, but it is not an architectural problem — for reasonable queries the step count will be small. Track it if step explosion from deeply recursive rules becomes a real complaint.

---

## Вадим auto — Completeness Review (v2)

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK
**Commit quality:** OK

---

### Feature completeness

All 6 layers from the task spec are implemented and connected end-to-end:

1. **Rust socket protocol** (`rfdb_server.rs`) — `explain` field accepted on `CheckGuarantee`, `DatalogQuery`, `ExecuteDatalog`. `ExplainResult(WireExplainResult)` variant in the `Response` enum. Wire structs (`WireExplainResult`, `WireQueryStats`, `WireQueryProfile`, `WireExplainStep`) all use `#[serde(rename_all = "camelCase")]`. The `query_result_to_wire_explain` helper correctly maps every field; no field is dropped or silently defaulted.

2. **TypeScript types** (`packages/types/src/rfdb.ts`) — `QueryStats`, `QueryProfile`, `ExplainStep`, `DatalogExplainResult` all defined. `DatalogBinding` is `{ [key: string]: string }`, matching the plain-object format the Rust side emits. `DatalogExplainResult.bindings: DatalogBinding[]` is consistent with the wire schema. Overload signatures on the `GraphBackend` interface are correct.

3. **JS Client** (`packages/rfdb/ts/client.ts`) — `_parseExplainResponse` private helper is extracted (the v1 issue is fixed). All three methods (`datalogQuery`, `checkGuarantee`, `executeDatalog`) use it. The overload pattern (`explain: true` literal) is correct and consistent with the types package.

4. **RFDBServerBackend** (`packages/core/src/storage/backends/RFDBServerBackend.ts`) — Thin delegation to client for all three methods; explain path returns `DatalogExplainResult` directly without wrapping.

5. **MCP handler** (`packages/mcp/src/handlers/query-handlers.ts`) — `explain` field destructured from args. `formatExplainOutput` renders steps (capped at 50), stats, and bindings (capped at 20). `explain` is registered in the tool schema (`definitions.ts`). The `--explain` code path uses `checkFn.call(db, query, true)` — the `.call` pattern is slightly unusual but functionally correct given the type-cast context.

6. **CLI** (`packages/cli/src/commands/query.ts`) — `--explain` flag registered with Commander. Warning emitted when `--explain` is used without `--raw` (previous v1 gap, now fixed). `renderExplainOutput` shows steps, stats, and paginated bindings. JSON fallback (`--json --explain`) also works.

No scope creep observed. The change is strictly limited to the explain mode feature.

### Test coverage

**Rust (5 tests, `tests.rs` lines 1898–1993):**
- `test_explain_eval_query_produces_steps` — verify non-empty steps with `explain=true`
- `test_explain_eval_query_no_explain_empty_steps` — verify empty steps with `explain=false` AND correct binding count
- `test_explain_query_produces_steps` — cover `query()` path (not just `eval_query()`)
- `test_explain_bindings_match_plain_evaluator` — regression: explain bindings equal plain-evaluator bindings
- `test_explain_stats_populated` — `nodes_visited > 0`, `find_by_type_calls > 0`, `total_results == 2`

All five tests are meaningful assertions, not smoke tests.

**JS (10 tests, `test/unit/ExplainMode.test.js`):**
- Tests 1–4: Shape assertions for all three entry points (checkGuarantee, datalogQuery, executeDatalog with rule, executeDatalog with direct query)
- Test 5: `nodesVisited > 0`
- Test 6: `explainSteps.length > 0`
- Test 7: Binding format — plain `{Variable: "id"}`, not `{name, value}` pairs
- Tests 8–10: Regression — non-explain calls still return array format via backend wrapper

The `assertExplainShape` helper checks all four top-level fields plus their sub-types (numeric stats, timing in profile, array types). Coverage is solid for happy path and regressions. The only things not tested at JS level are the MCP formatter (`formatExplainOutput`) and the CLI `renderExplainOutput`, but these are presentation-layer functions; their correctness is self-evident from inspection and the underlying data is tested.

### Commit quality

Code has no TODOs, no commented-out code, no `FIXME`/`HACK` markers. The `rule_eval_time_us: 0` and `projection_time_us: 0` values in `finalize_result` have an inline comment explaining they are not yet tracked — the previous TODO is gone, replaced by a factual comment. Acceptable.

One minor observation (not blocking): the `--explain` warning in the CLI (`console.error('Note: --explain requires --raw. Ignoring --explain.')`) does not exit — execution continues to the non-raw query path. The user gets the warning but the flag is silently dropped. This is a reasonable graceful-degradation choice; the comment is accurate.
