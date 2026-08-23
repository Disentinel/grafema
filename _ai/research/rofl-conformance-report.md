# ROFL v0 ↔ RFDB conformance report (P0 harness)

- run: `rofl-conformance-1787525131406` (identity in `conformance-run-meta.json`; the machine report `conformance-report.json` is byte-reproducible and carries no run identity)
- oracle: ROFL v0 vendored at `052a4c5` (main); subject: rfdb-server 0.4.1 (protocol v3, derive engine, repo `a3c6e7656ff6`)
- a RED verdict is a SUCCESS of the harness: it is a machine-readable migration-roadmap entry, not a failure. Harness failures are crashes, fake greens, silent skips — gated by the oracle self-check (30/30 must pass on vendored v0) and the scenario-count check.

## Tier-0 — 120-seed TS↔RFDB differential (common subset)

- seeds run: **120** (75% positive, 25% stratified negation with boot preloaded on the v0 side)
- fact-set divergences: **0**
- why (positive) witness spot-checks: **325 passed / 0 failed** (existence + body ⊆ v0 fact set; deliberately NOT tree identity — v0 stores only the first witness per fact, store.ts:127, and witness choice is mode-dependent, LIMITS.md:48; tree-shape parity remains RED missing:whynot-shape)
- whynot (negative) gap spot-checks: **554 passed / 0 failed** (≤5 absent ground tuples per seed over rule-bearing rels: v0 whynot must NOT hold, RFDB explainDatalogGap witness must EXIST, satisfied premises ⊆ v0 fact set, failing predicate must be a program predicate; demo-tree parity stays RED missing:whynot-shape)

## Tier-0 rules-from-store — the same seeds answered with the rules read out of the database

- seeds run: **120**; carried whole by Projection T: **120**; refused on the merits (not reflectable, NOT a divergence): **0** — the refusal path is live, a deliberately unreflectable control program came back `E-REFLECT-003`
- **same answer with rules from the store as with rules from the text: 120 / 120**
- same answer as the ROFL v0 oracle: **120 / 120**
- rule-facts written by reflection: **5168**
- why witness spot-checks: **325 passed / 0 failed**; whynot gap spot-checks: **554 passed / 0 failed** — the same checks the text pass runs, so the explain surface is measured out of the store too
- anti-silence controls passed: **120 / 120** seeds answered ZERO rows to the same selectors before anything was reflected, and **120 / 120** had the server read the rule source back as `store` before being asked
- anti-silence: each seed gets a FRESH database, and before anything is reflected the very selectors used to ask the questions are run against it in store mode and must return zero rows. A seed whose reflection wrote no facts, whose mode did not read back `store`, or whose answer after reflection is empty, stops the run as a harness gap instead of counting as agreement — two silences are not a match.

## Tier-1 — the 29 v0 tests + boot.rofl

- GREEN 5 / RED 25 / DIVERGENCE 0 / HARNESS_GAP 0 (of 30)
- RED by reason code: `dialect:untranslatable`×2, `missing:compound-terms`×1, `missing:whynot-shape`×1, `missing:perspectives`×1, `missing:rules-as-data`×18, `missing:excise`×1, `missing:holes`×1

| scenario | source | verdict | reason code | evidence |
|---|---|---|---|---|
| p1-tc-seminaive | test/phase1.test.ts:12 | GREEN | — | all ported assertions passed against the RfdbRofl adapter (answers delegated to rfdb-server over the wire; 1 wire round-trips) |
| p1-tc-naive | test/phase1.test.ts:22 | RED | dialect:untranslatable | naive evaluation mode is a v0 engine-internal toggle; RFDB has a single evaluation mode (v0 modes agree on fact sets, LIMITS.md:48) |
| p1-functor-append | test/phase1.test.ts:30 | RED | missing:compound-terms | functor term 'cons(…)' in clause 2: the derive program parser has no functor form — parse_term accepts wildcard, quoted const, variable, bare const and number, nothing else (datalog/parser.rs:146-173). Live-probed R15/P2 |
| p1-async-reject | test/phase1.test.ts:45 | GREEN | — | all ported assertions passed via the SHARED vendored v0 parser front-end (rejection at load(); no engine delegation involved — zero wire round-trips) |
| p1-next-body-reject | test/phase1.test.ts:52 | GREEN | — | all ported assertions passed via the SHARED vendored v0 parser front-end (rejection at load(); no engine delegation involved — zero wire round-trips) |
| p1-arith | test/phase1.test.ts:58 | RED | dialect:untranslatable | builtin 'is' in clause 3: the v0 arithmetic/comparison semantics (unify.ts:96-113, JS trunc) → RFDB builtin mapping is unverified in P0 (first P1 flip candidate) |
| p2-diff-positive | test/phase2.test.ts:63 | GREEN | — | all ported assertions passed against the RfdbRofl adapter (answers delegated to rfdb-server over the wire; 962 wire round-trips) |
| p2-diff-negation | test/phase2.test.ts:74 | GREEN | — | all ported assertions passed against the RfdbRofl adapter (answers delegated to rfdb-server over the wire; 487 wire round-trips) |
| p2-why-tree | test/phase2.test.ts:102 | RED | missing:whynot-shape | v0 why() is a recursive tree '<key> <= r<fnv1a> @tick N' (api.ts:250-277); RFDB witness for path(a,c) is flat {ruleAstHash, body[]} (derive/exec.rs:298-306) — witness EXISTS but the tree shape is unrepresentable. Live-pr |
| p2-persp-isolation | test/phase2.test.ts:118 | RED | missing:perspectives | perspective [vault] in clause 1: RFDB has no perspective dimension |
| p2-stratum-order | test/phase2.test.ts:129 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p2-noboot-null-plan | test/phase2.test.ts:150 | RED | missing:rules-as-data | v0 strata come from boot-derived stratum/2 + unstratified/1 FACTS (engine.ts:2-4, boot.rofl:17-21); RFDB stratification is internal, not queryable |
| p2-unstrat-reject | test/phase2.test.ts:161 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p2-derived-by | test/phase2.test.ts:176 | RED | missing:rules-as-data | reflection-vocabulary relation 'derived_by' in query 'derived_by(F, R, T)': RFDB has no rules-as-data / provenance relations |
| p3-kernel-grep | test/phase3.test.ts:14 | RED | missing:rules-as-data | the kernel-grep vocabulary contract is about the v0 reflection vocabulary as the kernel API; RFDB has no reflection vocabulary to check |
| p3-runtime-rule | test/phase3.test.ts:19 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p3-write-protected | test/phase3.test.ts:38 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p3-breach | test/phase3.test.ts:46 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p3-malformed-sibling | test/phase3.test.ts:55 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p3-snapshot-roundtrip | test/phase3.test.ts:75 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-counter | test/phase4.test.ts:19 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-replay | test/phase4.test.ts:34 | RED | missing:rules-as-data | reflection-vocabulary relation 'uses_builtin' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-tm | test/phase4.test.ts:83 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-tm-diverge | test/phase4.test.ts:104 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-boot-audits | test/phase4.test.ts:119 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-sensors | test/phase4.test.ts:133 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-excise-multi | test/phase4.test.ts:169 | RED | missing:excise | v0 excise = clean re-evaluation on EDB minus one fact (api.ts:348); RFDB sim_derive is overlay-ADD, there is no minus-one-fact counterpart |
| p4-forged | test/phase4.test.ts:185 | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| p4-budget-hole | test/phase4.test.ts:199 | RED | missing:holes | load with an evaluation budget: v0 commits partial results + hole/2 facts on exhaustion (engine.ts:188-198); RFDB aborts without committing (E-codes, engine_v2.rs:749-750) — the known policy contradiction, ТЗ P1 mandates |
| boot-load | boot.rofl | RED | missing:rules-as-data | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |

## Expected vs found (join against ledger round-001 pre-registrations)

| claim | expected | found | match | note |
|---|---|---|---|---|
| exp_phase1_tc_parse_green | green | green | ✓ | p1-tc-seminaive=GREEN, p1-async-reject=GREEN, p1-next-body-reject=GREEN |
| exp_phase1_functor_red | red:missing:compound-terms | red:missing:compound-terms | ✓ | functor term 'cons(…)' in clause 2: the derive program parser has no functor form — parse_term accepts wildcard, quoted const, variable, bare const and number,  |
| exp_phase1_arith_red | red:dialect:untranslatable | red:dialect:untranslatable | ✓ | builtin 'is' in clause 3: the v0 arithmetic/comparison semantics (unify.ts:96-113, JS trunc) → RFDB builtin mapping is unverified in P0 (first P1 flip candidate |
| exp_phase2_differentials_green | green | green | ✓ | p2-diff-positive=GREEN, p2-diff-negation=GREEN |
| exp_phase2_whytree_persp_strata_red | red | red | ✓ | p2-why-tree=RED(missing:whynot-shape), p2-persp-isolation=RED(missing:perspectives), p2-stratum-order=RED(missing:rules-as-data), p2-noboot-null-plan=RED(missing:rules-as-data), p2-unstrat-reject=RED( |
| exp_phase3_reflection_snapshot_red | red | red | ✓ | p3-kernel-grep=RED(missing:rules-as-data), p3-runtime-rule=RED(missing:rules-as-data), p3-write-protected=RED(missing:rules-as-data), p3-breach=RED(missing:rules-as-data), p3-malformed-sibling=RED(mis |
| exp_phase4_time_budget_boot_red | red | red | ✓ | p4-counter=RED(missing:rules-as-data), p4-replay=RED(missing:rules-as-data), p4-tm=RED(missing:rules-as-data), p4-tm-diverge=RED(missing:rules-as-data), p4-boot-audits=RED(missing:rules-as-data), p4-s |
| exp_boot_load_red | red:missing:rules-as-data | red:missing:rules-as-data | ✓ | reflection-vocabulary relation 'has_conclusion' in clause 1: RFDB has no rules-as-data / provenance relations |
| exp_tier0_differential_green | green | green | ✓ | 120 seeds run |
| exp_tier0_witness_green | green | green | ✓ | 325 why witnesses (existence + body ⊆ v0 facts) + 554 whynot gap witnesses (existence + satisfied ⊆ v0 facts) checked; NOT tree identity — v0 keeps first witness only, store.ts:127 |
| exp_deworkaround_tier0_green | green | green | ✓ | 120 seeds with no translator normalization for F1/F2/F3 (translate.ts workarounds removed; engine fixes regression-pinned in exec.rs/plan.rs/stratify.rs) |
| exp_rules_from_store_agrees | green | green | ✓ | 120 of 120 seeds carried whole by Projection T (0 refused on the merits, refusal control E-REFLECT-003); 5168 rule-facts written; each seed's answer taken from a fresh database whose SAME selectors re |

## Engine findings discovered by the harness (probe evidence)

- F1 FIXED (was: RFDB `\+ p(X, _)` — wildcard inside a NEGATED literal — silently returned wrong answers; probe q0(X) :- p0(X), \+ p2(X, _) with p0(c0). p0(c1). p2(c1,c9). returned {c0, c1}, correct {c0}). Engine fix: the negated branch of join_derived in exec.rs now anti-joins existentially over the non-wildcard columns (regression test negated_derived_leg_with_wildcard_is_existential in exec.rs). The translator's aux-predicate projection workaround is REMOVED — negated wildcards go to the wire as-is.
- F2 FIXED (was: a body literal over a predicate with NO facts and NO rules gave no response past the 30s EvalLimits deadline — a debug_assert in the stratifier panicked and killed the DEBUG-build connection thread; that assert no longer exists, so there is nothing left to cite). Engine fix: the debug_assert removed, unknown predicate = legal empty relation; deadline abort pinned by the regression test unknown_predicate_leg_expired_deadline_aborts_with_e_exec_001 in exec.rs. The translator's empty-predicate elimination workaround is REMOVED — unknown predicates go to the wire as-is.
- F3 FIXED (was: a fully-ground body literal in a multi-literal rule tripped E-PLAN-003 after planner reordering; q0(X) :- p0(X), p1("c1","c2"). rejected). Engine fix: shares_no_binding in plan.rs treats an empty bound set as "preceding legs were filters", so a ground probe is safe in any position (regression test ground_probe_leg_is_safe_in_any_position in plan.rs). The translator's ground-body-literal rejection is REMOVED; the structural cross-join guard for genuinely disconnected generators remains.
- executeDatalog "first rule head" includes ground FACTS (a fact is a bodyless rule): the target predicate's first RULE must be hoisted above all facts or the response is the first fact's relation with empty bindings. (Wire-protocol dialect rule, NOT a bug — the translator keeps the hoist.)

## Comparison-mode statement

Tier-0 compares canonicalized USER-visible fact sets: perspective-stripped `rel(args)` lines, sorted; the v0 side is masked by the phase2.test.ts:56-61 domainFacts port (RESERVED + stratum + unstratified excluded) intersected with the generated program's relations (boot is preloaded on the v0 side of negation seeds and derives its own vocabulary the RFDB side can never contain). Witness comparison covers BOTH directions: positive (why — witness existence + body ⊆ v0 facts) and negative (whynot — gap-witness existence for absent tuples + satisfied premises ⊆ v0 facts + failing-predicate sanity), NOT tree identity. why/whynot TREE parity is out of tier-0 scope by design (missing:whynot-shape).
