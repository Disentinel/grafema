## Task Metrics: REG-413

**Workflow:** v2.0
**Config:** Custom (Research — Don + 3 consultants + synthesis)
**Date:** 2026-02-15
**Wall clock:** ~45 minutes

### Subagents

| # | Agent | Model | Tokens | Tools | Duration | Est. Cost |
|---|-------|-------|--------|-------|----------|-----------|
| 1 | Don (explore + plan) | Sonnet | 84,052 | 30 | 253s | $0.55 |
| 2 | Tarjan (graph algorithms) | Sonnet | 49,270 | 13 | 212s | $0.33 |
| 3 | Cousot (formal analysis) | Sonnet | 57,023 | 13 | 265s | $0.38 |
| 4 | Альтшуллер (ТРИЗ) | Sonnet | 55,605 | 12 | 260s | $0.37 |

### Totals

| Metric | Value |
|--------|-------|
| Subagents total | 4 |
| By model | Haiku: 0, Sonnet: 4, Opus: 0 |
| Total tokens (subagents) | 245,950 |
| Est. subagent cost | $1.63 |
| Top-level overhead | ~20-30% (not tracked) |
| **Est. total cost** | **~$2.10** |
| Auto-review cycles | 0 (research task, no code review) |

### Grafema Dogfooding

| Metric | Value |
|--------|-------|
| Graph queries attempted | 0 |
| Graph queries successful | 0 |
| Fallbacks to file read | 0 |
| Product gaps found | 0 |

**Verdict:** Not applicable — pure research task, no codebase exploration needed.

### Notes

- All 4 subagents ran on Sonnet (cheapest model with reasoning for research)
- Agents 2-4 ran in parallel, saving ~8 minutes wall clock vs sequential
- Total output: 6 research documents + 1 synthesis + 9 Linear tickets
- Key insight: Альтшуллер's ТРИЗ analysis challenged the entire approach but user correctly identified it's based on limited evidence (N=11). Decision: test both hints and constraints.
- Research task format worked well: specialized consultants with different lenses produced complementary analysis
