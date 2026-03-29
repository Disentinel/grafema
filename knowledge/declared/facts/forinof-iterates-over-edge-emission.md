---
id: kb:fact:forinof-iterates-over-edge-emission
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - packages/js-analyzer/src/Rules/Statements.hs
created: 2026-03-12
---

## For-of/for-in ITERATES_OVER Edge Emission

The Haskell JS analyzer's `ruleForInOfStatement` in `Rules/Statements.hs` previously discarded the left-side walk result (`>> return ()`) for the loop variable declaration. This meant the loop variable (e.g., `const item` in `for (const item of arr)`) had no ITERATES_OVER edge connecting it to the iterable.

**Fix:** Capture `mLeftId` from `walkNode left` (which returns the CONSTANT/VARIABLE node ID from `ruleVariableDeclaration`), capture `mRightId` from `walkNode right`, and emit:
1. `ITERATES_OVER(loopId, rightId)` — the LOOP node iterates over the collection
2. `ITERATES_OVER(leftId, rightId)` — the loop variable iterates over the collection

Both edges are needed: the first connects the structural LOOP to its iterable, the second enables data flow tracing from the loop variable back to the collection.

**Evidence:** Without this fix, `v_loop_forof_results` in the dataflow gauntlet was unreachable from SEED (the trace couldn't flow from `arr` through the for-of into `item`).
