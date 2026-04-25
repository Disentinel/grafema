# Experiment: axios-4738 — Custom timeoutErrorMessage not used in http adapter

**Date:** 2026-02-11
**Task:** axios__axios-4738
**Bug:** `config.timeoutErrorMessage` is ignored in http adapter; always shows "timeout of Xms exceeded"

## Setup

- **Container Node version:** v20.19.1 (no side-install needed)
- **Grafema version:** 0.2.5-beta with REG-409 fix
- **Graph stats:** 3183 nodes, 4763 edges, 201 functions, 41 modules (1 service: axios)

### Infrastructure Notes

- Node 20 in container — grafema runs natively, no wrapper needed
- `path: "."` with `entrypoint: "index.js"` in grafema config (root index.js re-exports lib/axios)
- rfdb-server binary from preact-2927 image reused (`~/.local/bin/rfdb-server`)
- **Bug found:** grafema ignores custom entrypoint names — always falls back to `index.js`. Workaround: set `path: "."` so root `index.js` is used, which requires `./lib/axios`. Filed mentally, not blocking.

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | **PASS** | **PASS** |
| **Steps** | 34 | 35 (+3%) |
| **Cost** | $0.28 | $0.22 (-21%) |
| **Grafema cmds** | 0 | 4 |
| **cat commands** | 7 | 6 (-14%) |
| **grep commands** | 11 | 7 (-36%) |
| **Total file ops** | 18 | 13 (-28%) |
| **Patch file** | lib/adapters/http.js | lib/adapters/http.js |
| **Runtime** | ~5 min | ~6 min |

## Patches

Both target the same location in `httpAdapter()` — the `handleRequestTimeout` callback.

**Baseline:** Simple — uses `config.timeoutErrorMessage` with fallback to original message:
```js
var timeoutErrorMessage = config.timeoutErrorMessage || 'timeout of ' + timeout + 'ms exceeded';
```

**Grafema:** More elaborate — reconstructs timeout message + explicit override:
```js
var timeoutErrorMessage = config.timeout ? 'timeout of ' + config.timeout + 'ms exceeded' : 'timeout exceeded';
if (config.timeoutErrorMessage) {
  timeoutErrorMessage = config.timeoutErrorMessage;
}
```

Both produce correct behavior — eval PASS for both.

## Grafema Usage Pattern

1. `grafema overview` — project structure (41 modules, 201 functions)
2. `grafema query "timeoutErrorMessage"` — searched for bug keyword (may have found variable references)
3. `grafema query "timeout" | grep "http.js"` — narrowed to http adapter
4. `grafema context "http.js->exports->dispatchHttpRequest->if#11->FUNCTION->handleRequestTimeout"` — deep inspection of exact function

**Pattern observation:** Agent used the exact bug keyword (`timeoutErrorMessage`) as first grafema query — effective when the bug keyword IS a code entity. Then used semantic ID from query results for deep context.

## Analysis

### First PASS for both conditions
This is the first task where both baseline AND grafema produce passing patches. axios-4738 appears to be a straightforward bug: a config property exists but isn't used in one code path.

### Grafema saved cost (-21%)
$0.22 vs $0.28 — grafema condition was cheaper despite similar step count. Likely because grafema commands returned concise structured output vs verbose grep/cat results that inflate token counts.

### File ops reduction consistent (-28%)
13 vs 18 file operations — consistent with preact experiments (28-100% reduction). The 4 grafema commands replaced ~5 grep+cat operations.

### Both found the right function independently
Baseline used grep to find "timeoutErrorMessage" and "timeout" references, eventually landing on http.js handleRequestTimeout. Grafema got there through structured query → context path.

## Running Total

| Task | Baseline | Grafema | Notes |
|------|----------|---------|-------|
| preact-3345 | FAIL | FAIL | Grafema crashed (Node 18) |
| preact-4436 | FAIL | FAIL | File ops -100% |
| preact-2757 | FAIL | FAIL | File ops -48% |
| preact-2927 | FAIL | FAIL | File ops -39% |
| preact-3062 | FAIL | **HUNG** | 3x attempts, all hung |
| axios-4731 | PASS | — | Baseline only (no grafema) |
| **axios-4738** | **PASS** | **PASS** | **File ops -28%, cost -21%** |

**Baseline resolve rate:** 2/7
**Grafema resolve rate:** 1/6 (1 skipped, 1 hung)
**File ops saved (avg where grafema worked):** ~39% fewer cat/grep commands
**Cost saved (axios-4738):** 21%

## Key Insight: axios is a Better Testbed Than preact

- axios tasks are solvable by Sonnet (2/2 attempted = 2 PASS)
- Preact tasks are unsolvable by Sonnet (0/5 = 0 PASS)
- Grafema's value can only be measured on tasks where the model CAN solve the problem
- Continue with remaining 4 axios tasks to build statistical base

## Next Steps

- axios-5085 (next sequential)
- Reuse grafema config and rfdb-server binary for all axios tasks
- Consider: can we reuse the SAME grafema image for all axios tasks? (different commits may have different code)
