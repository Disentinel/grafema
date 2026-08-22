# Owner rulings — ROFL migration

Authority: Vadim, 2026-08-22 (~06:40 UTC): «Ты можешь сам выбрать решение, мне главное чтобы
рофл заработал» — decision authority delegated to the orchestrating session; optimization
criterion = shortest sound path to a working ROFL environment on RFDB. Rulings below are made
under that delegation and recorded here so subsequent phases consume them instead of re-asking.
Each is reversible by Vadim; none is silently embedded.

## R-1. Functional-conflict resolution order (unblocks P5) — K-1/O-3

No hand-maintained author-priority table. The measured author domain (47 distinct `_source`
values incl. raw sha256 strings) makes a curated list rot-prone, and no one will maintain it.

**Resolution order: max `tick` wins (newest analysis run) → author canon-order (deterministic
tie-break) → min `fid`.** `$legacy` (tick 0) loses to any real tick by construction.

Grounds: (a) it is total and deterministic with zero configuration; (b) it coincides with
today's storage physics (newest-wins), which the P2 equivalence differential proved
winner-coherent on the real base — so P5 introduces no behavior flip on the 39 measured
conflicts; (c) `conflict/5` still records every disagreement as a queryable fact, so a future
author-priority table can be layered on WITHOUT data loss — the conflicts are all still there.
The doc's §2.3 proposal (author-priority first) is downgraded to an optional future refinement.

## R-2. Budget exhaustion semantics — O-4

Per ТЗ P1 (explicit): **holes win**. Budget exhaustion produces committed partial results +
`hole/2` certificates (partial ⊑ total); abort-no-commit (E-EXEC-002/003 today) is replaced on
the ROFL path when ТЗ-P1 lands. The W8 lesson (cancel-as-convergence, 1726 lost edges) applies:
the holes implementation MUST make "partial" mechanically distinguishable from "converged" —
a hole fact is exactly that distinguisher, and its absence must be provable (final re-check
before commit).

## R-3. `meta` in derived-edge identity + @materialize_node ownership — K-2/O-10

**Keep meta OUT of derived identity** (today's collapse semantics stand): two derived facts
differing only in a meta column remain ONE edge. Grounds: bundled rule-pack authors were told
to rely on the collapse (materialize.rs:53-58); flipping it multiplies edge counts corpus-wide
(the exact fan-out failure class from the Haskell v1/v2 rounds). The storage-order-nondeterminism
of WHICH meta wins is resolved by R-1's order once assertions exist (P4+): winner = max tick.
@materialize provenance-scoped exclusivity remains the ownership mechanism; author-scoped
supersession (§4.2) operates at assertion level underneath it, not instead of it.

## R-4. A12 oracle — O-16

**Accept A12 without a cross-implementation differential.** abduce/dry_excise are unimplemented
in TS v0 (LIMITS.md:14-17), so a v0 oracle would first have to be built in a codebase whose
roadmap we do not own — not the shortest path. A12's acceptance criteria are self-verifying
properties (ТЗ: «abduce returns minimal Δ-sets verified by APPLYING them»; «dry_excise blast
radius ≡ actual excise diff») — property-verified acceptance, honestly labeled as such in the
ledger (differential-verified for A1-A11, property-verified for A12).

## R-5. 24h-run corpus source — O-16(a)

**Pin by SHA, no merge:** corpus = `Disentinel/rofl` branch `claude/collatz-24h-run@6dfa003`
(fetched locally in /home/dev/rofl). Dual citation base ⟨M⟩/⟨R⟩ per the design doc appendix
stands. If the branch ever vanishes upstream, the local clone is the archive.

## R-6. Accumulated ratifications from P1/P2/P3 — RATIFIED AS IMPLEMENTED

All judgment calls recorded in ledger rounds 005-009 are ratified without modification:
C3 (declare_default get-or-declare; strict head validation scoped per round-009-pre H3),
C4 (dual orders: canon-Ord vs exec cmp_value, unification deferred), C6 (arity-0 Term = bare
functor on text surfaces), C7 (typed FactStoreError envelope over §7.2 payload shapes),
E-MAT-014 (Term-in-scalar-meta code), F3-broadened E-CAT-001 (all-field conflict identity),
C19 (E-STORE-001 for propagated store failures), C21 (write-side attr Str-only),
C22+R1 (winner-coherent fact relation; §2.3 conflicts = explained-exception accounting),
R2 (COLUMN_META_KEYS precedence), R4 (canonical_state_sha contractual panic on foreign
snapshot), D1 (open-space seeded at estimate 0 — monotone), Q1-Q11 of round-007-pre.
Each was argued with evidence and survived adversarial review; overturning any would cost a
re-verification round with no path-to-working-ROFL payoff.

## R-7. What stays OUTSIDE this delegation

git push / PR / merge to main / release remain Vadim-explicit-only. The two main cherry-picks
(gc_manifests data-loss; \+ p(X,_) soundness + F2/F3) stay READY in the morning queue
(RESUME-LOOP.md) awaiting his push word. The flaky
test_commit_batch_performance_scaling robustness task stays recorded (_ai/gaps.md), off the
critical path.
