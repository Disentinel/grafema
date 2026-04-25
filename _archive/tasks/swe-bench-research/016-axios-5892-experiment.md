# Experiment: axios-5892 — Decompression handling issue

**Date:** 2026-02-11
**Task:** axios__axios-5892
**Bug:** HTTP response decompression handling issue in http adapter

## Setup

- **Container Node version:** v20.19.1
- **Grafema version:** 0.2.5-beta with REG-409 fix
- **Graph stats:** 4023 nodes, 5841 edges, 49 modules

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | **PASS** | **PASS** |
| **Steps** | 49 | 30 (-39%) |
| **Cost** | $0.47 | $0.22 (-53%) |
| **Grafema cmds** | 0 | 3 |
| **cat commands** | 14 | 9 (-36%) |
| **grep commands** | 6 | 4 (-33%) |
| **Total file ops** | 20 | 13 (-35%) |
| **Patch file** | lib/adapters/http.js | lib/adapters/http.js |
| **Runtime** | ~7.5 min | ~8 min |

## Patches

Both in `lib/adapters/http.js` — decompression handling in the http adapter.

## Grafema Usage Pattern

1. `grafema overview` — project structure
2. `grafema query "content-encoding"` — searched for bug keyword
3. `grafema query "decompress"` — found decompression handling

3 grafema commands — minimal but effective. Agent found the right area quickly.

## Analysis

### Both PASS — Grafema Significantly Cheaper

$0.22 vs $0.47 — grafema was **53% cheaper** while producing correct results.
30 steps vs 49 — **39% fewer steps**. This is the strongest efficiency gain so far.

### File Ops Reduction Consistent

13 vs 20 file ops — **35% reduction**. Grafema's structured navigation continues to reduce exploratory cat/grep commands.

### axios Tasks Where Both Succeed Show Consistent Grafema Advantage

| Task | Cost Savings | Step Savings | File Op Savings |
|------|-------------|-------------|-----------------|
| axios-4738 | -21% | +3% | -28% |
| axios-5892 | -53% | -39% | -35% |
| **Average** | **-37%** | **-18%** | **-32%** |

## Running Total

| Task | Baseline | Grafema | Notes |
|------|----------|---------|-------|
| preact-3345 | FAIL | FAIL | Grafema crashed (Node 18) |
| preact-4436 | FAIL | FAIL | File ops -100% |
| preact-2757 | FAIL | FAIL | File ops -48% |
| preact-2927 | FAIL | FAIL | File ops -39% |
| preact-3062 | FAIL | **HUNG** | 3x attempts |
| axios-4731 | PASS | — | Baseline only |
| axios-4738 | **PASS** | **PASS** | Cost -21% |
| axios-5085 | **PASS** | FAIL | Grafema missed 2/3 changes |
| axios-5316 | FAIL | FAIL | Baseline maxed steps |
| **axios-5892** | **PASS** | **PASS** | **Cost -53%, steps -39%** |

**Baseline resolve rate:** 4/10
**Grafema resolve rate:** 2/9

## Next Steps

- axios-6539 (last axios task)
