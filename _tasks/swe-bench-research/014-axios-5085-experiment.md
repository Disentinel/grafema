# Experiment: axios-5085 — Set-Cookie header array values lost on normalize/toJSON

**Date:** 2026-02-11
**Task:** axios__axios-5085
**Bug:** AxiosHeaders `normalize()` and `toJSON()` destroy array values (e.g., Set-Cookie with multiple values), collapsing them into a single string.

## Setup

- **Container Node version:** v20.19.1
- **Grafema version:** 0.2.5-beta with REG-409 fix
- **Graph stats:** 4000 nodes, 6104 edges, ~45 modules (slightly different axios version from 4738)

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | **PASS** | **FAIL** |
| **Steps** | 54 | 50 (-7%) |
| **Cost** | $0.76 | $0.43 (-43%) |
| **Grafema cmds** | 0 | 4 |
| **cat commands** | 22 | 11 (-50%) |
| **grep commands** | 6 | 9 (+50%) |
| **Total file ops** | 28 | 20 (-29%) |
| **Patch file** | lib/core/AxiosHeaders.js | lib/core/AxiosHeaders.js |
| **Runtime** | ~9 min | ~9 min |

## Patches

**Baseline (PASS):** 3 changes in AxiosHeaders.js:
1. `normalize()` — preserves array values during normalization (2 locations)
2. `toJSON()` — keeps Set-Cookie as array instead of joining with `, `

**Grafema (FAIL):** 1 change in AxiosHeaders.js:
1. `toJSON()` only — keeps Set-Cookie as array (same as baseline #3)

The grafema agent found only the toJSON part of the fix but missed the normalize method changes. The baseline agent found all 3 required changes.

## Grafema Usage Pattern

1. `grafema overview` — project structure
2. `grafema query "AxiosHeaders"` — found the class
3. `grafema context "AxiosHeaders.js->global->FUNCTION->AxiosHeaders"` — constructor context
4. `grafema query "get" | grep "AxiosHeaders"` — tried to find getter methods

## Analysis

### Why Grafema FAIL When Baseline PASS

This is the first case where grafema performed **worse** than baseline. The root cause:

1. **Grafema provided focused but incomplete context.** The `context` command showed the AxiosHeaders constructor and its immediate edges, but the agent didn't drill into the `normalize` method deeply enough.

2. **Baseline's exhaustive file reading found all change points.** With 22 cat commands (vs grafema's 11), baseline read more of AxiosHeaders.js repeatedly, discovering all 3 locations needing changes.

3. **Grafema's efficiency was a liability here.** By reading less code, the grafema agent missed the normalize method's role in destroying array values. The bug required understanding that BOTH normalize AND toJSON flatten arrays.

### Cost Savings Significant But Misleading

$0.43 vs $0.76 — grafema was 43% cheaper. But this "savings" came from reading less code, which directly caused the incomplete fix. In this case, **reading more code was the correct strategy**.

### Grafema Limitation: Multi-Location Bugs

When a bug requires changes in multiple methods within the same file, grafema's "navigate precisely, read less" approach can miss change points. The `context` command shows one function at a time, not the full class with all methods.

**Potential improvement:** A `grafema context` for a CLASS should show all methods, not just the constructor. This would help agents see all relevant code in one query.

## Running Total

| Task | Baseline | Grafema | Notes |
|------|----------|---------|-------|
| preact-3345 | FAIL | FAIL | Grafema crashed (Node 18) |
| preact-4436 | FAIL | FAIL | File ops -100% |
| preact-2757 | FAIL | FAIL | File ops -48% |
| preact-2927 | FAIL | FAIL | File ops -39% |
| preact-3062 | FAIL | **HUNG** | 3x attempts |
| axios-4731 | PASS | — | Baseline only |
| axios-4738 | **PASS** | **PASS** | File ops -28%, cost -21% |
| **axios-5085** | **PASS** | **FAIL** | **Grafema missed normalize changes** |

**Baseline resolve rate:** 3/8
**Grafema resolve rate:** 1/7 (1 skipped, 1 hung)

## Key Insight: Grafema's Precision Can Hurt

Grafema reduces noise but can also reduce signal. For bugs that span multiple methods in one file, reading the entire file (cat) provides better coverage than querying individual functions.

**Actionable:** Consider enhancing `grafema context` for classes to show all methods, or add a `grafema file <path>` command that shows all entities in a file with their relationships.

## Next Steps

- Continue with axios-5316, 5892, 6539
- Track whether this is an anomaly or a pattern (precision vs coverage tradeoff)
