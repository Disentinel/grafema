# REG-503: Expose Explain mode through NAPI → Client → MCP → CLI

## Source
Linear issue REG-503, subtask of REG-502 (Datalog Polish).

## Request
Expose the existing Rust `EvaluatorExplain` through the full stack: NAPI bindings → JS Client → MCP tool → CLI flag.

## Acceptance Criteria
1. NAPI: `checkGuarantee(source, explain?)` and `datalogQuery(query, explain?)` return stats/profile/steps when explain=true
2. JS Client: `datalogQuery(query, { explain: true })` and `checkGuarantee(rule, { explain: true })` pipe the flag
3. MCP: `query_graph` tool accepts `explain: boolean` parameter, returns explain steps in response
4. CLI: `grafema query --explain` outputs step-by-step trace

## Implementation Notes (from issue)
- NAPI bindings: replace `Evaluator` with `EvaluatorExplain` (explain=false by default, zero overhead)
- Or add separate `datalogQueryExplain` method
- Return type: extend JsDatalogResult or create separate JsQueryResult
- Fix `rule_eval_time_us: 0` TODO in eval_explain.rs
