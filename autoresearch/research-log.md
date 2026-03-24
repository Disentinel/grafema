# Autoresearch Log

Research journal for Grafema evaluation experiments.

## 2026-03-24: First iteration — baseline vs grafema

### Setup
- 30 questions (Sillito taxonomy): 15 deterministic, 10 judge, 5 adversarial
- Model: Sonnet 4.6, temperature default
- Grafema mode: MCP tools available, no explicit "use graph first" instruction
- Runs: baseline-v1, grafema-v1

### Results (deterministic only, 15 questions)

| Metric | Baseline | Grafema | Delta |
|--------|----------|---------|-------|
| Accuracy | **93% (14/15)** | 87% (13/15) | -7% |
| Avg tokens | 3027 | 3279 | +8% |
| Avg latency | 52s | 62s | +19% |
| MCP adoption | 13% | **70%** | +425% |
| Est. cost | $7.03 | $7.57 | +8% |

### Key observations

1. **Baseline wins on accuracy.** Grafema lost Q06 (commitBatch callers) — find_calls returned incomplete results, agent supplemented with Grep but still missed one file. Q07 tied (both got 83%).

2. **MCP adoption is high (70%) without explicit instructions.** This disproves the SWE-bench pilot finding (1/10 tasks). Difference: SWE-bench tasks are "fix this bug" (action-oriented), autoresearch questions are "find/explain this" (comprehension-oriented). MCP tools are naturally more useful for comprehension.

3. **Only 3 distinct MCP tools used:** get_stats (19x), find_nodes (6x), find_calls (3x). Out of 30 available tools: trace_dataflow, describe, get_context, get_file_overview, query_graph — all unused. The tool surface area is too large.

4. **ToolSearch overhead:** 34 calls to load deferred tool schemas. Each costs tokens. This is infrastructure tax, not value.

5. **get_stats as ritual:** Called 19 times. MCP instructions say "START HERE: call get_stats". Agent follows literally, calling it before most questions. Pure overhead.

6. **Grep dominates tool usage:** 85 Grep calls in grafema mode (vs 0 MCP text search). Graph doesn't offer text search, so agent falls back to Grep for any "find this string" question. This is correct behavior — but means graph only adds value for structural/relational queries.

### Hypotheses generated

- **H001A**: Reduce tool count from 30 to 4-5 core tools → less overhead, better discoverability
- **H001B**: Single swiss-army tool → eliminate ToolSearch entirely
- **H001C**: Pre-load tools (non-deferred) → eliminate ToolSearch overhead
- **H002**: Agent prefers Grep over find_calls → **CONFIRMED** from Q06 session data
- **H003**: Graph advantage appears on cat 3 (tracing) not cat 1-2 → needs judge eval
- **H004**: find_calls returns incomplete results → specific bug to fix
- **H005**: get_stats called 19 times = overhead → remove or auto-include

### Next steps

1. Test H001A/B/C in separate worktree branches on remote server
2. Fix find_calls completeness (H004) — this is a product bug, not just a hypothesis
3. Add LLM judge for cat 3 questions to test H003
4. Each change → re-run benchmark → compare

### Evaluator fixes during this iteration

- Q01 changed from eval_type `set` to `superset` (multiple files produce the error)
- Added extension-aware fuzzy matching (`.ts`/`.js` in mid-string positions)
- Fixed evaluate.mjs to skip missing questions silently in partial runs
- Fixed validate.mjs glob handling (grep doesn't expand `**`, use `--include` instead)
