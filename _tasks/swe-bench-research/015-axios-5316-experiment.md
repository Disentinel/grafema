# Experiment: axios-5316 — FormData content type not set in http adapter

**Date:** 2026-02-11
**Task:** axios__axios-5316
**Bug:** FormData content-type header not being set correctly in Node.js http adapter when using native FormData (no getHeaders method).

## Setup

- **Container Node version:** v20.19.1
- **Grafema version:** 0.2.5-beta with REG-409 fix
- **Graph stats:** 3749 nodes, 5416 edges, 47 modules

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | FAIL | FAIL |
| **Steps** | 75 (maxed out!) | 45 |
| **Cost** | $0.77 | $0.41 (-47%) |
| **Grafema cmds** | 0 | 3 |
| **cat commands** | 21 | 18 (-14%) |
| **grep commands** | 8 | 6 (-25%) |
| **Total file ops** | 29 | 24 (-17%) |
| **Patch** | EMPTY (no submission) | lib/adapters/http.js |

## Patches

**Baseline:** No patch — agent ran out of steps (75 = step_limit). The agent spent all 75 steps exploring and attempting fixes but never submitted.

**Grafema:** Has a patch modifying http adapter's FormData handling, but it failed eval. The fix attempted to handle native FormData (no `getHeaders()`) by detecting and setting content-type manually, but the exact fix was incorrect.

## Grafema Usage Pattern

1. `grafema overview` — project structure
2. `grafema query "http.js"` — found the adapter
3. `grafema query "isFormData"` — searched for FormData handling

Only 3 grafema commands (fewer than usual). Agent switched to grep/cat quickly.

## Analysis

### Baseline Hit Step Limit

75 steps = the agent was stuck in exploration/retry loops. This task is genuinely harder than 4738 — it requires understanding the difference between browser FormData (native) and Node.js form-data package (has getHeaders), and correctly handling both.

### Grafema Was More Efficient But Still Wrong

45 steps vs 75 (40% fewer), $0.41 vs $0.77 (47% cheaper). Grafema agent at least submitted a patch, while baseline couldn't even reach submission. But the fix was incomplete/incorrect.

### Both Agents Struggle With Complex Bug Logic

This task requires:
1. Understanding that native FormData doesn't have `getHeaders()`
2. Detecting the FormData type and constructing multipart boundary manually
3. Setting the correct content-type with boundary

This is a reasoning challenge, not a navigation challenge. Neither grafema nor grep helps with understanding the fix logic.

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
| axios-5085 | **PASS** | FAIL | Grafema missed 2/3 changes |
| **axios-5316** | FAIL | FAIL | Baseline maxed steps, grafema -47% cost |

**Baseline resolve rate:** 3/9
**Grafema resolve rate:** 1/8

## Next Steps

- axios-5892, axios-6539 remaining
