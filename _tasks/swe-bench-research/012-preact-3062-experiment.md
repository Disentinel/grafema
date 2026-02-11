# Experiment: preact-3062 — tabIndex attribute set to "0" instead of removed

**Date:** 2026-02-11
**Task:** preactjs__preact-3062
**Bug:** "tabIndex" attribute set to "0" instead of being removed when value is null/undefined

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | FAIL | HUNG (3x attempts) |
| **Steps** | ~30 | N/A |
| **Patch** | src/diff/props.js | N/A |

## Baseline Patch

Same pattern as preact-2757 and preact-2927 — replaces `dom[name] = value == null ? '' : value`
with `removeAttribute` when value is null:

```diff
-  dom[name] = value == null ? '' : value;
+  if (value == null) {
+    dom.removeAttribute(name);
+  } else {
+    dom[name] = value;
+  }
```

Baseline: FAIL (same fix as 2757/2927, all fail eval).

## Grafema Condition: Hung 3 Times

**Issue:** mini-SWE-agent process hangs indefinitely after container starts.
- Container starts normally, startup command works (verified separately)
- Process shows 0% CPU after ~10 minutes — waiting for something
- No trajectory saved, no new log lines after container start
- Reproduced consistently 3 times (killed at 35min, 15min, 10min)

**Possible causes:**
- API rate limiting (unlikely — baseline ran fine minutes earlier)
- A specific grafema command causing container timeout
- Agent enters a loop that triggers command timeout
- Docker exec timeout on a grafema command that takes too long

**Not investigated further** — would require adding debug logging to mini-swe-agent.

## Running Total

| Task | Baseline | Grafema | Notes |
|------|----------|---------|-------|
| preact-3345 | FAIL | FAIL | Grafema crashed (Node 18) |
| preact-4436 | FAIL | FAIL | File ops -100% |
| preact-2757 | FAIL | FAIL | File ops -48% |
| preact-2927 | FAIL | FAIL | File ops -39% |
| preact-3062 | FAIL | **HUNG** | 3x attempts, all hung |

**Baseline Preact resolve rate:** 0/5
**Grafema Preact resolve rate:** 0/4 (1 skipped)

## Observation: Sonnet Can't Solve Preact Props.js Tasks

All 3 props.js tasks (2757, 2927, 3062) produce the **exact same fix pattern**:
replace `dom[name] = value == null ? '' : value` with `removeAttribute(name)` for null.

All 3 fail eval. This suggests either:
1. The gold fix is fundamentally different (different approach entirely)
2. The fix is incomplete (needs additional changes in other locations)
3. The fix needs to handle the `setAttribute` path, not the property path

Sonnet appears to be stuck in a "removeAttribute for null" pattern regardless
of the specific bug description. This is a model reasoning limitation, not
a navigation problem.
