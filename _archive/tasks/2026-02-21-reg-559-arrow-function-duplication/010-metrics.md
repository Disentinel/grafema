## Task Metrics: REG-559

**Workflow:** v2.2
**Config:** Mini-MLA
**Date:** 2026-02-22
**Wall clock:** ~90 minutes (planning + implementation + review)

### Subagents

| # | Agent | Model | Tokens | Tools | Duration | Est. Cost |
|---|-------|-------|--------|-------|----------|-----------|
| 1 | Don (explore+plan) | Sonnet | 147,470 | 61 | 414s | $0.97 |
| 2 | Dijkstra (verify v1) | Sonnet | 51,778 | 12 | 126s | $0.34 |
| 3 | Don (gap resolution) | Sonnet | 60,070 | 20 | 139s | $0.40 |
| 4 | Dijkstra (verify v2) | Sonnet | 43,595 | 10 | 112s | $0.29 |
| 5 | Uncle Bob (PREPARE) | Sonnet | 30,051 | 7 | 47s | $0.20 |
| 6 | Rob (impl) | Opus | 36,134 | 28 | 1465s | $1.19 |
| 7 | Kent (tests) | Opus | 97,050 | 33 | 327s | $3.20 |
| 8 | Steve (review) | Sonnet | 31,280 | 8 | 60s | $0.21 |
| 9 | Вадим auto (review) | Sonnet | 31,066 | 11 | 52s | $0.20 |
| 10 | Uncle Bob (review) | Sonnet | 32,561 | 4 | 36s | $0.21 |

### Totals

| Metric | Value |
|--------|-------|
| Subagents total | 10 |
| By model | Haiku: 0, Sonnet: 8, Opus: 2 |
| Total tokens (subagents) | 561,055 |
| Est. subagent cost | $7.21 |
| Top-level overhead | ~20-30% (not tracked) |
| **Est. total cost** | **~$9.00** |
| 3-Review cycles | 1 (all 3 approved first time) |
| Dijkstra cycles | 2 (rejected once, approved on re-verify) |

### Grafema Dogfooding

| Metric | Value |
|--------|-------|
| Graph queries attempted | 0 |
| Graph queries successful | 0 |
| Fallbacks to file read | 10+ |
| Product gaps found | 0 |

**Verdict:** not useful — bug was in indexing code, graph can't query its own construction defects

### Notes
- Dijkstra's first rejection caught a real gap (class field arrow duplication) — led to filing REG-562
- Rob spent most time (1465s) waiting for build/test cycles — Opus overkill for a 4-line change
- Rob updated snapshot correctly (counter shift from removing module-level duplicate arrow processing)
- Class field arrow duplication (REG-562) is a pre-existing separate bug, correctly scoped out
