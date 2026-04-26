# Experiment: preact-2757 — Progress element value=0 removes attribute

**Date:** 2026-02-11
**Task:** preactjs__preact-2757
**Bug:** Setting `value` of `<progress>` element to `0` removes the attribute instead of setting it

## Setup

- **Container Node version:** v16.20.2 (oldest so far)
- **Grafema compatibility:** Required Node 20 side-install (Node 16 can't run ESM modules)
- **Graph stats:** 2992 nodes, 8533 edges, 148 functions, 24 modules (3 services: core, hooks, compat)

### Infrastructure Notes

Node 16 in container broke grafema (`ERR_MODULE_NOT_FOUND: Cannot find package 'commander'`).
Fix: installed Node 20 binary alongside (`/opt/node-v20.11.1-linux-x64/`), created wrapper script
at `/usr/local/bin/grafema` that uses Node 20 specifically for grafema. System Node 16 stays untouched.

Docker commit captures: Node 20 binary, grafema wrapper, rfdb-server, pre-built graph.
Does NOT capture: node_modules (was :ro bind mount) — still needs volume mount.

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | FAIL | FAIL |
| **Steps** | 50 | 43 (-14%) |
| **Grafema cmds** | 0 | 4 |
| **cat commands** | 16 | 4 (-75%) |
| **grep commands** | 13 | 11 (-15%) |
| **Total file ops** | 29 | 15 (-48%) |
| **Patch file** | src/diff/props.js | src/diff/props.js |
| **Patch logic** | Identical | Identical |

## Patches (Both Identical Logic)

Both agents produced the same fix — adding a check for PROGRESS/METER elements:

```diff
+		!(name === 'value' && (dom.nodeName === 'PROGRESS' || dom.nodeName === 'METER')) &&
```

The only difference: baseline added it after `name in dom` (replacing the line), grafema added it
before `name in dom` (new line). Same semantics.

## Grafema Usage Pattern

Agent's first 4 commands were all grafema:
1. `grafema overview` — project structure
2. `grafema query "setAttribute"` — no results (grafema doesn't index DOM API names)
3. `grafema query "setProperty"` — found `props.js->global->FUNCTION->setProperty`
4. `grafema context "props.js->global->FUNCTION->setProperty"` — saw source code, edges, callers

After grafema pointed to the right function, agent switched to grep/cat for:
- Reading the full `props.js` file
- Searching `diff/index.js` for value handling
- Reading test files

## Analysis

### What Grafema Improved
- **48% fewer file operations** (15 vs 29)
- **14% fewer total steps** (43 vs 50)
- **Navigation was faster**: 4 grafema commands found `setProperty` directly;
  baseline needed multiple `ls`, `cat`, `grep` to locate the same function
- **No exploration waste**: Grafema agent didn't need `ls src/`, `ls src/diff/` etc.

### What Didn't Help
- **Same wrong fix**: Both agents produced identical patches that fail eval
- **The fix is plausible but incorrect** — likely the actual PR fix is different
  (perhaps using `setAttribute` directly, or handling the `value=0` case differently
  in `diffProps` rather than `setProperty`)
- **Reasoning gap confirmed**: Navigation is not the bottleneck for this task

### Why Both Fail
Both agents correctly identified:
1. The problem is in `setProperty` in `props.js`
2. For progress/meter elements, `dom.value = 0` sets the property but doesn't
   update the attribute (browser behavior)
3. The fix should force `setAttribute` for these elements

But the actual SWE-bench test might expect a different approach. Possible reasons:
- The gold fix might handle this in `diff/index.js` instead of `props.js`
- The gold fix might use a different pattern (not element type checking)
- The gold fix might handle more edge cases (not just PROGRESS/METER)

## Running Total (Preact Tasks)

| Task | Baseline | Grafema | Steps Saved | File Ops Saved |
|------|----------|---------|-------------|----------------|
| preact-3345 | FAIL | FAIL | ~same | N/A (grafema crashed on Node 18) |
| preact-4436 | FAIL | FAIL | +26% | -100% (0 cat/grep) |
| preact-2757 | FAIL | FAIL | -14% | -48% |

**Resolve rate:** 0/3 baseline, 0/3 grafema
**Navigation improvement:** Consistent across tasks where grafema works
**Reasoning improvement:** None observed

## Conclusions

1. **Grafema consistently reduces navigation overhead** — 14-100% fewer file operations
2. **Grafema does NOT improve fix correctness** — same wrong patches
3. **Node 16 compatibility solved** — side-install approach works, no test contamination
4. **The "navigation vs reasoning" boundary holds** for attribute handling tasks too
   (not just hooks, as seen in preact-3345/4436)

## Next Steps

- Continue with props.js tasks (2927, 3062, 3454, 4316) to build statistical base
- Consider: is 0/6 on preact a Sonnet limitation, or are preact tasks unusually hard?
- Compare with other repos (axios, docusaurus) where baseline already passes
