# 009 — preact-4436 Experiment Report (ref cleanup functions)

**Date:** 2026-02-11
**Task:** preactjs__preact-4436 (Support cleanup functions for refs — React 19 feature)
**Model:** Sonnet 4.5
**Grafema version:** 0.2.5-beta (REG-400 + REG-406)

## Task Description

Implement React 19 feature: callback refs can return cleanup functions.
```jsx
<input ref={(ref) => {
  // ref created
  return () => { /* ref cleanup */ };
}} />
```

## Gold Patch Summary

Two files modified:
1. **`src/diff/index.js`** (`applyRef`): Store cleanup on `ref._unmount` (function object).
   When cleanup exists and value==null (unmount), skip calling ref(null).
2. **`src/internal.d.ts`**: Update RefCallback type to return `void | (() => void)`

Key design decision: cleanup stored on **function object** (`ref._unmount`), not on VNode.

## Run Results

| Metric | Baseline | Grafema Context |
|--------|----------|-----------------|
| Steps | 50 | 63 |
| Cost | ~$0.51 | ~$0.64 |
| Grafema cmds | 0 | 7 (1 overview, 3 query, 3 context) |
| cat/head/tail | 34 | ~0 |
| grep/find | 19 | ~0 |
| sed edits | 0 (python) | 5+ |
| Files modified | 2 | 3 |
| Step to find applyRef | Step 6 | Step 3 |
| Eval | **FAIL** | **FAIL** |

## Comparison Analysis

### What Grafema Context Changed

**1. Exploration strategy completely different:**
- Baseline: 34 cat + 19 grep = 53 file-reading steps (exploration)
- Grafema: 7 grafema commands replaced ALL file exploration
- Agent never used cat or grep — `grafema context` was sufficient

**2. Faster architectural understanding:**
- Baseline found applyRef at step 6 via `grep -r "applyRef"`
- Grafema found applyRef at step 3 via `grafema context` showing full source + callers

**3. Found additional bug in children.js (step 36):**

Grafema context showed both call sites of applyRef:
```
commitRoot (line 321): applyRef(refQueue[i], refQueue[++i], refQueue[++i]);
unmount (line 583): applyRef(r, null, parentVNode);
```

This led agent to examine `children.js:102` where it discovered:
```javascript
// WRONG — cleanup stored on oldVNode, but called with childVNode
applyRef(oldVNode.ref, null, childVNode)
// Should be:
applyRef(oldVNode.ref, null, oldVNode)
```

**Baseline did NOT find this bug.** The children.js fix was a direct result of
`grafema context` showing the call sites with code context.

### What Both Got Wrong

Both agents stored cleanup on `vnode._refCleanup` instead of `ref._unmount`:

| Aspect | Gold Patch | Both Agents |
|--------|-----------|-------------|
| Cleanup storage | `ref._unmount` (function object) | `vnode._refCleanup` (VNode) |
| Call ref(null) on unmount | NO (skip when cleanup exists) | YES (always) |
| Handles shared refs | Yes (cleanup follows function) | No (cleanup on wrong vnode) |

**Why the vnode approach fails:**
- Test expects `ref` called ONCE (with element), NOT called with `null`
- Agent's code calls `ref(null)` on unmount → test fails
- Gold patch: if cleanup exists, SKIP ref(null) → test passes

### Root Cause of Wrong Approach

The agent sees applyRef receives `(ref, value, vnode)` and knows it needs to store
cleanup. Natural instinct: store on `vnode` (the available context object).

The gold patch's insight is non-obvious: store on `ref` itself (the function object),
which means you can also use `ref._unmount` existence to decide whether to call
`ref(null)` at all.

**Grafema gap:** The graph shows structural relationships (who calls whom) but doesn't
show semantic intent ("when value is null, this means unmount"). Understanding that
`applyRef(ref, null, vnode)` is an unmount pattern requires reading the surrounding
code/comments, which both agents did but neither drew the right conclusion.

## Boundary Clarification: Structure vs Design Reasoning

Initially classified as "argument value semantics gap" — **retracted after review.**

`grafema context` DID show the literal `null` in the call site code:
`applyRef(r, null, parentVNode)`. The information was there. The agent could have
reasoned: "null = unmount, so skip ref(null) when cleanup exists."

**This is NOT a Grafema gap.** It's a model reasoning boundary:
- Grafema domain: structural understanding (who calls what, with what code)
- Model domain: design reasoning (which pattern to use, where to store state)

The boundary is between "what exists in code" and "how to correctly change it."

## Graph Stats

| Metric | Value |
|--------|-------|
| Nodes | 4560 |
| Edges | 13547 |
| applyRef callers (unique) | 2 (commitRoot, unmount) |
| applyRef callers (graph) | 8 (4x duplicates, REG-409) |

## Grafema Usage Detail

| Step | Command | Purpose | Value Added |
|------|---------|---------|-------------|
| 1 | `grafema overview` | Project structure | Modules/files/functions counts |
| 2 | `grafema query "ref"` | Find ref entities | Found applyRef, forwardRef, useRef, createRef |
| 3 | `grafema context "applyRef"` | Deep dive | Source code + 2 callers with code |
| 4 | `grafema query "commitRoot"` | Explore caller | Found in diff/index.js |
| 5 | `grafema context "commitRoot"` | Caller source | Full commitRoot source + edges |
| 6 | `grafema query "unmount"` | Explore caller | Found unmount function |
| 7 | `grafema context "unmount"` | Caller source | Unmount source + how it calls applyRef |

**Total: 7 grafema commands (11% of 63 steps), replaced ALL file-reading exploration.**

## Conclusions

### Grafema Context Value on This Task

**Positive:**
1. Completely replaced cat/grep exploration (53 commands → 0)
2. Found children.js bug that baseline missed
3. Faster to find target function (step 3 vs step 6)

**Neutral:**
4. Didn't change the core fix strategy (both chose vnode storage)
5. More total steps (63 vs 50) — but different kind of steps (verification vs exploration)

**Negative:**
6. Both still FAIL — understanding structure ≠ understanding design intent

### Pattern Emerging Across Experiments

| Task | Context helps understand? | Context helps fix? |
|------|--------------------------|-------------------|
| preact-3345 | Yes (3x faster) | No (same wrong fix) |
| preact-4436 | Yes (found extra bug) | No (same wrong approach) |

**Consistent finding:** Grafema context helps UNDERSTANDING (navigation, call sites,
code reading) but doesn't help DESIGN DECISIONS (where to store data, which pattern
to use). Design decisions require reasoning about semantics that graphs don't capture.

## Product Issues

- **REG-409 confirmed** — 8 CALLS edges for 2 unique callers (4x duplicates)
- **New insight:** Argument value patterns could be a future feature
  - When function called with literal null/undefined, annotate in context
  - Helps agents understand call semantics, not just call structure

## Next Steps

1. Try a simpler task (props.js fixes — maybe structure understanding IS enough)
2. Consider prompt hint: "if storing data for cleanup, consider the function object"
3. Track the pattern: does Grafema help more on navigation-bound vs reasoning-bound tasks?
