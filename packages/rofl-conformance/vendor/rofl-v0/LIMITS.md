# LIMITS — what ROFL v0 does not do

An honest list. Items marked (spec) are declared out of scope by START.md §8;
the rest are v0 implementation boundaries.

- **No `@async`** (spec). Parsed, rejected with "not in v0". There is no
  effects executor; "intention facts" are collected by the host at tick
  boundaries (see `examples/counter.rofl` and the `run` API's boundary hook).
- **No incremental maintenance** (spec). Any base-fact change (assert,
  retract, tick advance) discards the derived layer and re-runs the fixpoint
  from scratch. `excise` is likewise a clean re-evaluation on the subtracted
  EDB plus a diff — sound under multiple support by construction, and
  `incremental ≡ scratch` holds trivially because there is no incremental.
- **No multi-fact abduction** (spec). `whynot` is single-step: it names the
  failing premise instances per rule that could conclude the literal. It does
  not search for fact *sets* whose addition would make the literal derivable.
- **No occurs-check** (spec note). Unification is syntactic;
  `X = f(X)` builds a cyclic binding and canonicalizing such a term would not
  terminate. Don't do that; v0 does not detect it.
- **No persistence beyond store serialization.** `save`/`restore` round-trip
  the full store (facts, provenance, witnesses, tick log) through JSON;
  there is no storage engine, no WAL, no concurrency.
- **Stratum inference is data-driven and can be partial.** Strata come from
  boot.rofl's `stratum/2` facts. A negation rule whose head relation gets no
  stratum fact (its dependency cone contains only relations with neither
  facts nor `edb` marks) runs in a single final pass after all known strata,
  in canonical order. Programs whose correctness depends on negation ordering
  *within* that final pass are outside v0 guarantees. (Bootstrap `edb` marks
  for all reserved relations make this corner hard to reach — boot's and the
  appendix programs' rules all get proper strata.)
- **Without boot.rofl (or equivalent meta-rules) loaded, negation is
  unchecked**: no `stratum/2` facts means all negation rules run in the final
  pass, and no `unstratified/1` derivations means nothing gets rejected. The
  kernel deliberately contains no stratification checker of its own.
- **Demand (moded) evaluation limits.** Rules that are not range-restricted
  in written premise order are unfolded top-down at call sites; premise order
  matters (Prolog-style). Recursion depth through demand rules is capped at
  512 (counted against the budget as `hole`-style exhaustion). A negated
  premise over a demand-only relation is decided by attempting the unfolding
  under the current bindings; unbound arguments there mean the existential
  check ranges only over derivable instances reachable from those bindings.
  Querying a demand-only relation with all arguments unbound cannot
  enumerate (`? close(X, Y)` returns nothing rather than the infinite set).
- **Queries are god-view.** The REPL/API sees every perspective;
  `sees`/`imports` govern the `leak` audit, not query authorization.
- **Budgets count distinct firings + demand nodes**, not wall-clock or memory.
  Naive mode re-derivations are deduplicated by firing signature, so naive
  and seminaive agree on results; witness choice is canonical per engine mode.
- **Integer arithmetic only.** No floats, no bignums (safe-integer JS range);
  division/modulo by zero simply fails the builtin premise. Comparison
  builtins require ground integer operands.
- **Reflection facts live in `[main]`** and are timeless; rules do not carry
  per-perspective reflection. `in_perspective`/`asserted_by` metadata is
  emitted for user-asserted base facts only, and `asserted_by` only when the
  assert provides a `who`.
- **`@init` after tick 0 is inert** (diagnostic, no assertion). `@next` facts
  are not assertable directly; only rules stage into the next tick.
- **Frozen provenance is never garbage-collected.** Long multi-tick runs
  accumulate `derived_by` history (that is what makes the diverging-TM
  partial trace queryable); there is no compaction.
- **No aggregation, no optimization passes, no syntax sugar, no GPU anything**
  (spec §8). Resisted.
