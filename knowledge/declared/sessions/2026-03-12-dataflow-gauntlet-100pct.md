---
id: kb:session:2026-03-12-dataflow-gauntlet-100pct
type: SESSION
projections:
  - epistemic
created: 2026-03-12
---

## Dataflow Gauntlet: 100% Backward Reachability

**Goal:** Achieve 100% backward reachability from SEED through all 119 `v_*` target variables in the dataflow gauntlet fixture.

**Starting point:** ~87% (104/119) from trace v6.

**Key outcomes:**
1. **Trace algorithm v7** (116/119): Added HAS_ELEMENT, HAS_PROPERTY, receiver mutation, FUNCTION RETURNS/YIELDS following
2. **Trace algorithm v8** (119/119): Added property write propagation via receiver chain matching
3. **Haskell analyzer fix**: `ruleForInOfStatement` now emits ITERATES_OVER from loop variable to iterable (+1 variable)
4. **Fixture fix**: `v_continue` was declared but never assigned SEED — added `v_continue = SEED;` in loop body (+1 variable)
5. **All 385 unit tests pass** — no regressions

**Progression:** 104/119 (87%) → 116/119 (97.5%) → 117/119 (98.3%) → 118/119 (99.2%) → 119/119 (100%)

**Files modified:**
- `packages/js-analyzer/src/Rules/Statements.hs` — for-of ITERATES_OVER edge emission
- `test/fixtures/dataflow-gauntlet/index.js` — v_continue fixture fix

**Trace scripts (not committed, in /tmp/):** trace_check_v7.mjs, trace_check_v8.mjs, and various diagnostic scripts
