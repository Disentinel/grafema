# Experiment: preact-2927 — contentEditable=undefined crashes

**Date:** 2026-02-11
**Task:** preactjs__preact-2927
**Bug:** Element with `contentEditable=undefined` crashes in Preact but not React

## Setup

- **Container Node version:** v16.20.2 (same as preact-2757)
- **Grafema version:** 0.2.5-beta **with REG-409 fix** (edge uniqueness)
- **Graph stats:** 3150 nodes, 7991 edges (vs 2757: 2992/8533 — fewer edges due to dedup)

## Results

| Metric | Baseline (Sonnet) | Grafema (Sonnet) |
|--------|-------------------|------------------|
| **Eval** | FAIL | FAIL |
| **Steps** | 41 | 45 (+10%) |
| **Grafema cmds** | 0 | 4 |
| **cat commands** | 13 | 5 (-62%) |
| **grep commands** | 15 | 12 (-20%) |
| **Total file ops** | 28 | 17 (-39%) |
| **Patch file** | src/diff/props.js | src/diff/props.js |
| **Runtime** | ~8 min | ~19 min |

## Patches (Same Location, Same Logic)

Both target the same line in `setProperty()` — replacing `dom[name] = value == null ? '' : value;`
with a null check that uses `removeAttribute` instead:

**Baseline:**
```js
if (value == null) {
    dom.removeAttribute(name);
} else {
    dom[name] = value;
}
```

**Grafema:** Identical logic, no comments.

## Grafema Usage Pattern (Consistent with preact-2757)

1. `grafema overview` — project structure
2. `grafema query "contentEditable"` — no results (DOM API, not in codebase)
3. `grafema query "setProperty"` — found the function
4. `grafema context "props.js->global->FUNCTION->setProperty"` — source + edges

Same 4-command pattern as preact-2757. Agent searches for the bug keyword first
(no results since it's a DOM concept), then searches for the handler function.

## Observations

### Grafema used more steps this time (45 vs 41)
- Baseline was more efficient at 41 steps — possibly because contentEditable is
  easier to grep for than progress element handling
- Grafema agent spent extra steps on grafema commands that returned no results
  (`contentEditable` is DOM API, not in Preact source)

### Both agents found the exact same fix
- Same function, same line, same logic
- The fix is plausible: when value is null/undefined, remove the attribute
  instead of setting it to empty string
- But eval says FAIL — the gold fix might be different

### REG-409 Impact
- Edge count decreased from 8533 (preact-2757) to 7991 (preact-2927 with REG-409)
- 542 fewer edges = ~6% were duplicates
- This is a real improvement in graph quality, though it didn't change the outcome here

## Running Total (Preact Tasks)

| Task | Baseline | Grafema | Steps (B/G) | File Ops (B/G) |
|------|----------|---------|-------------|----------------|
| preact-3345 | FAIL | FAIL | ~same | N/A (crashed) |
| preact-4436 | FAIL | FAIL | 50/37 | 53/0 (-100%) |
| preact-2757 | FAIL | FAIL | 50/43 | 29/15 (-48%) |
| preact-2927 | FAIL | FAIL | 41/45 | 28/17 (-39%) |

**Resolve rate:** 0/4 baseline, 0/4 grafema
**File ops saved (avg where grafema worked):** ~42% fewer cat/grep commands
**Step savings:** Mixed (sometimes fewer, sometimes more)

## Key Insight: Grafema Doesn't Help When Bug Keyword Is DOM-Specific

When the bug involves DOM concepts (contentEditable, progress element value),
`grafema query "<bug_keyword>"` returns nothing because these aren't in the source.
The agent must then search for the handler function name, which grep can also find quickly.

Grafema's advantage is strongest when:
- Bug keyword IS a function/variable in the codebase
- Understanding call chains matters for the fix
- Multiple files need to be explored

Grafema's advantage is weakest when:
- Bug is about DOM behavior, not code structure
- Fix is in a single well-known function
- The function name is easy to grep
