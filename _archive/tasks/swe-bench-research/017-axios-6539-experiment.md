# Experiment: axios-6539 — URL handling bug

**Date:** 2026-02-11
**Task:** axios__axios-6539
**Bug:** URL building/path handling issue in axios adapters

## Setup

- **Container Node version:** v20.19.1
- **Grafema version:** 0.2.5-beta with REG-409 fix
- **Graph stats:** 4670 nodes, 6771 edges, 55 modules (largest axios version)

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | FAIL | FAIL |
| **Steps** | 64 | 29 (-55%) |
| **Cost** | $0.76 | $0.25 (-67%) |
| **Grafema cmds** | 0 | 2 |
| **cat commands** | 24 | 11 (-54%) |
| **grep commands** | 8 | 3 (-63%) |
| **Total file ops** | 32 | 14 (-56%) |
| **Patch file** | lib/adapters/fetch.js | lib/adapters/http.js |

## Patches

**Baseline:** Modified `lib/adapters/fetch.js` — added URL handling in fetch adapter
**Grafema:** Modified `lib/adapters/http.js` — added URL handling in http adapter

Different files = different approaches. Neither correct. The bug likely requires changes in a shared module (buildFullPath or similar), not in individual adapters.

## Grafema Usage Pattern

Only 2 commands:
1. `grafema overview`
2. `grafema query "buildFullPath"` — found the URL building function

Minimal grafema usage, but agent zeroed in quickly. 29 steps total — very efficient exploration, just wrong conclusion.

## Analysis

### Massive Efficiency Gain, Same Wrong Result

- **-67% cost** ($0.25 vs $0.76) — most extreme savings across all experiments
- **-55% steps** (29 vs 64)
- **-56% file ops** (14 vs 32)

But neither found the correct fix. This task is another reasoning challenge where efficient navigation doesn't compensate for incorrect fix logic.

### Agents Picked Different Adapters

Baseline modified the fetch adapter, grafema modified the http adapter. The bug is likely in shared code that both adapters use (buildFullPath, combineURLs, etc.), not in adapter-specific code.

## Running Total (Final for Axios)

| Task | Baseline | Grafema | Cost B/G | Steps B/G |
|------|----------|---------|----------|-----------|
| axios-4731 | PASS | — | — | — |
| axios-4738 | **PASS** | **PASS** | $0.28/$0.22 | 34/35 |
| axios-5085 | **PASS** | FAIL | $0.76/$0.43 | 54/50 |
| axios-5316 | FAIL | FAIL | $0.77/$0.41 | 75/45 |
| axios-5892 | **PASS** | **PASS** | $0.47/$0.22 | 49/30 |
| axios-6539 | FAIL | FAIL | $0.76/$0.25 | 64/29 |

**Axios resolve rate:** Baseline 4/6, Grafema 2/5
**Total cost:** Baseline $3.04, Grafema $1.53 (-50%)
**Average steps (where grafema ran):** Baseline 55.2, Grafema 37.8 (-31%)
