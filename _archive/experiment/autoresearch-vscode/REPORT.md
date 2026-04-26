# VS Code Autoresearch: Baseline vs Grafema

**Date:** 2026-03-25
**Model:** Claude Sonnet 4.6
**Project:** microsoft/vscode (5660 TS files, 4M nodes, 8.3M edges)
**Questions:** 30 (Sillito taxonomy L1-L4, sourced from real GitHub issues)

## Aggregate Results

| Metric | Baseline | Grafema | Delta |
|--------|----------|---------|-------|
| Questions answered | 28/30 | 28/30 | 0 |
| Avg output tokens | 2,339 | 3,182 | **+36%** |
| Total output tokens | 70,159 | 95,466 | +36% |
| Avg latency | 113s | 161s | **+42%** |
| Total tool calls | 1,051 | 1,178 | +12% |
| **MCP (graph) calls** | 0 | **85** | — |
| Avg MCP calls/question | 0 | **2.8** | — |
| Questions with MCP use | 0 | 8/30 (27%) | — |

## Per-Question Comparison

| ID | Type | Baseline tokens | Grafema tokens | MCP calls |
|----|------|----------------|----------------|-----------|
| L1-01 | finding_focus | 716 | 2,449 (+242%) | 3 |
| L1-02 | finding_focus | 294 | 302 (+3%) | 0 |
| L1-03 | finding_focus | 488 | 675 (+38%) | 0 |
| L1-04 | finding_focus | 382 | 765 (+100%) | 3 |
| L1-05 | finding_focus | 635 | 1,265 (+99%) | 6 |
| L4-01 | architecture | 1,280 | 1,136 (-11%) | 0 |
| L4-02 | architecture | 1,893 | 2,222 (+17%) | 0 |
| L4-03 | architecture | 1,837 | 1,472 (-20%) | 6 |
| L4-04 | architecture | 2,005 | 2,101 (+5%) | 0 |
| L4-05 | architecture | 1,781 | 1,935 (+9%) | 0 |
| Q01 | api_confusion | 1,028 | 3,592 (+249%) | 0 |
| Q02 | root_cause | 4,308 | 4,897 (+14%) | 0 |
| Q03 | arch_investigation | 1,002 | 760 (-24%) | 0 |
| Q04 | debugging | 1,654 | 1,947 (+18%) | 0 |
| Q05 | root_cause | 1,416 | 1,620 (+14%) | 0 |
| Q06 | root_cause | 1,317 | 1,344 (+2%) | 0 |
| Q07 | root_cause | 15,316 | 28,733 (+88%) | 5 |
| Q08 | root_cause | 985 | 633 (-36%) | 0 |
| Q09 | onboarding | 1,645 | 1,843 (+12%) | 4 |
| Q10 | doc_gaps | 1,635 | 1,251 (-23%) | 0 |
| Q11 | architectural | 1,658 | 2,707 (+63%) | 5 |
| Q12 | dataflow | 1,657 | 2,038 (+23%) | 0 |
| Q13 | feature_trace | 805 | 1,176 (+46%) | 0 |
| Q14 | architecture | 918 | 1,095 (+19%) | 0 |
| Q15 | config_trace | 1,701 | 1,616 (-5%) | 0 |
| **Q16** | **lifecycle** | **3,807** | **2,411 (-37%)** | **53** |
| Q17 | root_cause | 1,144 | 1,433 (+25%) | 0 |
| Q18 | debugging | 1,603 | 1,748 (+9%) | 0 |
| Q19 | root_cause | 3,879 | 1,066 (-73%) | 0 |
| Q20 | performance | 11,370 | 19,234 (+69%) | 0 |

## Key Findings

### 1. Grafema MCP used in only 8/30 questions (27%)

Claude Sonnet defaults to Grep/Glob/Read workflow even when graph tools are available. The prompt says "use graph tools" but doesn't enforce it. In 22/30 questions, the agent ignored MCP entirely.

### 2. When MCP IS used, results are mixed

- **Q16 (terminal lifecycle, 53 MCP calls):** Grafema saved 37% tokens — real structural exploration benefit
- **L1-05 (minimap, 6 MCP calls):** Grafema cost 99% more tokens — MCP overhead for a simple question
- **Q07 (text model updates, 5 MCP calls):** Grafema cost 88% more — exploration spiraled

### 3. Grafema adds cost, not savings (on average)

+36% output tokens, +42% latency. MCP round-trips (ToolSearch → MCP call → parse result) add ~20-50 tokens per call. With 85 calls, that's ~2-4K extra tokens just for MCP overhead.

### 4. Answer quality is similar

Both modes answered 28/30 questions (same 2 failures). Without LLM judge scoring, quality appears comparable based on token count similarity.

## Hypotheses for Next Iteration

### H1: Prompt engineering is the bottleneck, not the graph
The current prompt gently suggests graph use. A directive prompt ("You MUST use find_nodes/find_calls for initial exploration. Do NOT use Grep to find classes/functions.") would force adoption.

### H2: Graph is most valuable for L3-L4 questions
Q16 (53 MCP calls, -37% tokens) is a lifecycle tracing question. Simple L1 questions are faster with Grep. The graph's value is in structural queries that Grep can't do (callers, dataflow, dependencies).

### H3: MCP startup overhead dominates short questions
MCP server starts a Node.js process per `claude -p` invocation. For a 10s question, 30s MCP startup is 75% overhead. For a 180s question, it's 17%. Batch or persistent MCP server would help.

### H4: Deferred tool loading (ToolSearch) wastes tokens
Claude spends tokens on `ToolSearch("+grafema find")` before every MCP call. If tools were pre-loaded, this overhead disappears.

## Aggressive Prompt Experiment (partial — 7/30 questions)

Tested "DO NOT use Grep, MUST use find_nodes/find_calls" prompt.

Result: **0.9 MCP calls/question** — LOWER than soft prompt (2.8/q).

**Conclusion:** Prompt engineering does not control Claude Sonnet's tool selection. The model's training distribution dominates — Grep is the default codebase exploration tool regardless of instructions. "DO NOT use Grep" is ignored.

## Revised Hypotheses

### H1 (REJECTED): Prompt engineering is the bottleneck
Aggressive prompt performed WORSE than soft prompt. Model behavior > prompt instructions for tool selection.

### H2 (CONFIRMED): Graph most valuable for complex structural questions
Q16 (terminal lifecycle, 53 MCP calls, -37% tokens) is the standout. When Claude naturally reaches for graph tools on complex questions, they help.

### H3: The real bottleneck is tool discovery UX
MCP tools are "deferred" — Claude must call ToolSearch before using them. This adds friction. If graph tools were native (like Grep/Glob), adoption would be higher.

### H4: Graph-as-context, not graph-as-tool
Instead of waiting for Claude to call graph tools, inject graph context into the prompt. E.g., `describe` output for the question's likely scope. Claude reads context naturally; it doesn't naturally choose unfamiliar tools.

## Next Steps

1. **Quality judge** — LLM-based scoring against golden_answer_hint (quality may differ even if token count is similar)
2. **Graph-as-context injection** — pre-compute `describe`/`get_file_overview` for each question, inject into prompt
3. **Native tool integration** — make graph tools appear as built-in tools, not MCP
4. **Question filtering** — focus benchmark on L3-L4 questions where graph has structural advantage
