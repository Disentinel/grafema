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

## R-1a. AMENDMENT to R-1 (2026-08-22 ~08:4x) — after empirical falsification of ground (b)

The R8 grounding probe falsified R-1's ground (b) BEFORE pre-registration (the escalation clause
worked as designed): **all 39 measured conflicts are tick ties** (both records carry
`_generation: 1`, 39/39, direct segment read of manifest 000171), so "max tick" never decides
them; the canon-order tie-break would pick EXTERNAL_FUNCTION 39/39 while storage physics picks
GLOBAL_DEFINITION 39/39 — a 39/39 behavior flip, not zero. No configuration-free logical order
reproduces segment-order physics on ties (segment order is physical, not a function of the
snapshot; mirroring it read-side would break §9.1 canonical sha).

**Amended order: max tick → author_priority table (optional; empty = skip) → author canon-order
→ min fid.** The table is seeded with exactly ONE pair:
`haskell-runtime-globals > haskell-local-refs`, living in `PredicateDecl.author_priority` —
the P1 normative field that until now was consumed by nothing.

Grounds: (a) SEMANTIC CORRECTNESS decides the tie, not name-length coincidence: the 39 are
prelude names (`notElem`, `take`, `last`, …) whose canonical home was established by the W23
haskell-globals migration (Q2 ruling: unify prelude with haskell-globals → HASKELL_GLOBAL /
GLOBAL_DEFINITION from `<runtime/haskell>`); EXTERNAL_FUNCTION from
`__grafema_virtual/haskell-local-refs` is the representation that migration retired. Flipping to
it would regress W23 intent. (b) Zero behavior flip vs today's storage winner is RESTORED
(GLOBAL_DEFINITION 39/39) — the differential re-pins winner==storage-winner. (c) R-1's rot
argument targeted a hand-maintained table over 47 authors incl. raw sha256s; a single
well-known-analyzer pair is not that case, and an EMPTY table degenerates to pure R-1, so the
configuration burden is one line with a written justification. (d) Freshness still dominates:
tick is checked FIRST — a newer analysis run beats any priority. (e) conflict/5 is still emitted
on EVERY multi-live resolution (superset emission stands), so nothing is hidden regardless of
who wins. Rejected alternatives: last-in-canon-order (data-tuned to these two name lengths,
fragile); storage-order parity (structurally impossible read-side); pure R-1 with acknowledged
39/39 flip (semantically regressive per (a)).

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

## R-8. Round-011 open-question acks (2026-08-22 ~11:20, delegation active)

OQ-1 ACK — conflict/5 Tick column = WINNER's tick (snapshot-derivable, deterministic).
OQ-2 ACK — Predicate column = canonical predicate NAME as Value::Str (§9.2 forbids interned ids
in canonical artifacts; doc's literal "PredicateId" yields to §9.2).
OQ-3 ACK — E-FUNC-002 = resolve_functional on a MultiValued predicate (C7 envelope).
OQ-4 ACK — conflict/5 durable materialization deferred to the P6 converter (C7 report counts
≥39 from the differential until then); read-side emission is the P5 semantics.
OQ-5 ACK — attr/3 Functional (file/name) deferred to P6 (compound (id,key) subject; the 39
measured conflicts are fully covered by node/type).
Also ratified: fa40b361 commit message stands without history rewrite (audited SHA ordering
outweighs message template); F1 process rule — ONE agent owns the timed perf window at a time.

## OQ-C3-1 (RESOLVED 2026-08-23 by ruling R-9 below — SWITCH TO THE NAME. Kept verbatim for the record)

**Question: should `canonical_state_sha` digest the author NAME instead of the interned author
RANK?**

What ships today (round-012, P6 stage 1): §9.1's `u32(author)` component is the author's position
in the store's own shortlex-sorted author table — exactly what round-012-pre D6 pre-registered and
what the implementation commit `b63a8049` pins. It is process-invariant (proven: three separate
runs, byte-identical stores) and it is what makes the converter's numeric-min F3 provably agree
with the base's shortlex-name-min F3.

Why the reviewer is right that this is a real question: the rank is **not injective over author
names across stores**. Two stores with different author sets that happen to sort to the same table
length produce the same u32 for different names, and the same author gets a different u32 the
moment the author set changes. §9.2 bans interned ids in canonical artifacts for the predicate and
perspective components; the author component is the one place that ban is not honoured. A stage-2
cross-backend C3 gate that compares `canonical_state_sha` between two backends whose author tables
were built independently would therefore compare ranks, not identities.

Cost of each answer:
- **Keep the rank** (status quo): zero work now; the digest stays a WITHIN-STORE identity, and any
  cross-store comparison must first prove the author tables are equal. That precondition must be
  written into the stage-2 C3 gate.
- **Switch to the NAME** (len-prefixed canon bytes, matching the predicate/perspective treatment):
  a one-line change in `canonical_state_sha`, but it INVALIDATES every recorded state sha
  (`6b83d6fc…` and the P2-P5 `ed520009…` lineage) and contradicts round-012-pre D6, which is
  pre-registered and immutable.

Recorded, not silently embedded: the non-injectivity is stated verbatim in the manifest itself
(`schemes.author_interning`, which cites this open question by name), in the doc comment on
`canonical_state_sha`, and it is pinned by the test
`canonical_state_sha_author_component_is_the_rank_not_the_name`
(packages/rfdb-server/src/facts/convert/reader.rs) so no future round can change it by accident.

## R-9. `canonical_state_sha` author component = the NAME, not the rank (resolves OQ-C3-1)

**Switch it.** §9.1's `u32(author)` becomes the author's canonical NAME as len-prefixed canon bytes,
exactly as §9.2 already requires for the predicate and perspective components. The change is
scoped to `canonical_state_sha` ONLY — the interned rank stays everywhere it is legitimately used
(in-memory interning, and the numeric-min F3 whose order-isomorphism to shortlex-name-min is a
property of the TABLE, not of the digest, and is therefore untouched).

Grounds:
(a) THE DIGEST IS AN EQUALITY ORACLE, AND THE STOP CONDITION IS A CROSS-STORE COMPARISON. P8's A4
    own-LSM ↔ RocksDB differential is the literal acceptance condition of this whole migration, and
    it compares two independently built stores. A component that is not injective over author names
    can report EQUAL for two states that differ in author identity. An audit environment whose
    canonical state digest admits that collision is unsound as an oracle, and «gate it instead» here
    means bolting an author-table-equality precondition onto every cross-store comparison forever.
(b) §9.2 IS NORMATIVE AND THIS IS ITS ONE VIOLATION. Two of the three interned components already
    ship as names. Leaving the third as a rank is an inconsistency reviewers will keep re-finding.
(c) THE COST IS STRICTLY MONOTONE IN TIME. It is one line today; every round from stage 2 onward
    records more state shas under the wrong recipe, and P8 would bake it into the acceptance gate.
(d) THE INVALIDATED SHAS ARE NOT LOST, THEY ARE RELABELLED. `6b83d6fc…` and the P2-P5 `ed520009…`
    lineage remain true statements about recipe v1 and stay in the ledger as such; the next round
    records the recipe change as a REPAIR with both values side by side.
(e) D6 IS NOT REWRITTEN. round-012-pre stays immutable and its claim stays honoured — the ships-today
    artifact WAS the rank. Superseding a pre-registered decision by a later pre-registration plus a
    recorded repair is exactly what the «Рабочий протокол» prescribes; silently editing D6 is what it
    forbids. The pinning test is renamed and inverted in the same commit, not deleted.

EXECUTION (binding on the next round that touches the converter): the switch, the repair record, the
re-pinned state sha, and the test inversion land TOGETHER in one round, BEFORE any stage-2 gate
consumes a state sha. Determinism (E7 two-process byte-identity) must be re-proven after the switch;
the output fact bytes must NOT move (the digest is self-description, not data) — if any `.seg` file
changes, that is a blocker, not a file to regenerate.

## R-10. `provenance.converter` git SHA — accept the digest pair, do NOT add build.rs (resolves OQ-C3-2)

**No build.rs.** Injecting git state into every build of the crate makes the binary non-reproducible
across dirty trees, which attacks A3 determinism at its root: the artifact's identity would move with
unrelated working-tree state. The store's identity is the ⟨input recursive sha256, output bytes⟩
pair — both already measured, both already in the report and the manifest.

`ROFL_CONVERT_GIT_SHA` stays an explicit opt-in env var, and `not-baked(...)` stays an honest value.
Binding process rule: any run whose output is CITED IN THE LEDGER must set it, and the ledger records
the resulting string. An unset value in a ledgered run is a defect of that round, not of the design.

## R-11. NM6 / divergence X1 (id↔sid subject skew of 32) — LOCALISE IT IN THE STAGE-2 PREMISE

Not deferrable past node_view, and not a reason to delay launching stage 2. The gap is BOUNDED and
well understood (503,372 id-metadata subjects vs 503,404 sid subjects; the delta is a set difference
over two enumerable sets), so per the completeness standard it gets CLOSED, not parked.

Binding: stage 2's premise phase produces the explicit list of the 32 subjects and a stated cause,
and node_view (S2-d) does not land until it exists. If the cause turns out to be a converter
lossiness class rather than a property of the base, that is a stage-1 defect and comes back as a
repair round — which is precisely why it must be answered BEFORE anything is built on sid.

## R-12. R-11 CLOSED — and its premise was WRONG. Recorded as a repair, not a rewrite.

R-11 asserted "503,372 id-metadata subjects vs 503,404 sid subjects; the delta is a set difference
over two enumerable sets". **That premise is false and I authored it.** Measured in R12: the
symmetric difference between the two subject sets is **0** — nothing is lost and nothing is
invented. The 32 is a *value-multiplicity* surplus on the id side: 503,404 distinct entity ids
collapse onto 503,372 distinct sid strings because **21 sid strings are each shared by 2–4
entities** (53 ids in total, Σ(|g|−1) = 32).

Cause, verified from code at HEAD (I re-read both sites myself, they are exactly as reported):
- `packages/rfdb-server/src/graph/engine_v2.rs:102-104` — when an incoming node carries no
  `semantic_id`, the engine mints the fallback `format!("{}:{}@{}", node_type, name, file)`.
- `plugins/type-inference.mjs:569-582` — mints `builtin::${className}::${methodName}` with
  `file: '<builtin>'` and `metadata.parentClass`, and sends **no `semanticId`**.
  Two builtin methods with the same method name under different parent classes therefore both
  fall back to `METHOD:<name>@<builtin>` and alias.

**Ruling: NOT a converter defect.** The skew is upstream, in the producer's id-minting path, and is
a pre-existing property of the source graph. Stage 1 is cleared; no repair round against the
converter. R-11's binding requirement (produce the 32 with a stated cause before anything is built
on sid) is **satisfied**.

**BINDING CONSEQUENCE, load-bearing for stage 2:** `node_view` keyed on entity id is safe and
lossless. The reverse direction MUST be typed `sid -> Set<Id>` behind a mechanical uniformity gate,
and MUST NEVER be typed `sid -> Id` / `Option<Id>` — that type silently drops 32 entities. This is a
type-level obligation, not a comment.

Carried-forward caveat (R12 §10 declared it honestly): the 53/21/Σ=32 enumeration was measured in
its premise phase and NOT re-run after compaction. The MECHANISM above is verified at HEAD; the
counts are not. Next round re-runs the group-by-sid enumeration and asserts Σ(|g|−1) == 32 with
every member `type=METHOD, file=<builtin>`.

## R-13. kernel-grep contract scope (answers R-req-1) — BAN THE VOCABULARY, NOT THE ENGLISH

The v0 contract (`scripts/kernel_grep.ts:52-57`) forbids appendix-program relation names from
appearing as code identifiers in kernel source. Ported literally to `packages/rfdb-server/src/`, the
eight names delta/reach/flow/step/move/dep/temp/close hit **828 times**. Those hits are ordinary
English used by a storage engine (`delta` manifests, `close()` handles, `temp` files) that predates
ROFL and means something unrelated.

**Ruling: the contract's PURPOSE is that the kernel must not special-case the appendix programs —
it must not know their vocabulary.** A literal identifier ban is a proxy that, at 828 hits, has
clearly stopped measuring that. Scope it to what the purpose actually requires:
1. The ban applies to **string literals and match arms that name an appendix RELATION as data** —
   i.e. the kernel must contain no `"reach"`, no `rel == "flow"`, no lookup table keyed by these.
2. It does NOT apply to Rust identifiers, field names, English prose in comments, or unrelated
   engine concepts.
3. Scope = the evaluator + storage kernel (`derive/`, `storage_v2/`, `graph/`), NOT test files,
   fixtures, `.dl` stdlib packs, or the conformance harness.

The gate must be MECHANICAL (a script with an exact count, checked in), and its first run records
the baseline. If the narrowed ban still returns non-zero, that is a real finding — report it, do not
re-narrow the rule to make it pass. Re-narrowing a failing gate to reach green is forbidden.

## R-14. Typed numerics on the wire (answers R-req-2) — FIX THE WIRE, IT IS A DEFECT

`bin/rfdb_server.rs:3205-3210` `wire_string_to_value` has exactly two arms: parses-as-u128 →
`Value::Id`, else `Value::Str`. The derive parser already produces typed literals
(`parser_ext.rs:1041-1054` yields `Term::Lit(Value::Int(0))` for a bare `0`).

**Ruling: this is a WIRE DEFECT, not a missing engine feature, and it gets fixed — it is not an
acceptable long-term asymmetry.** Grounds: (a) the engine side is already typed, so the wire is
losing information the engine has; (b) `Value::Term` renders at `:3212-3219` but has no parse arm,
so the round-trip is asymmetric in the same function — one fix, both bugs; (c) it is a prerequisite
for `has_premise(R,1)`, `V = 20`, and boot itself, so it blocks the widest lane; (d) an untyped wire
in front of a typed engine will silently corrupt A3 determinism comparisons later, when the same
logical value crosses as `Id` in one path and `Str` in another.

Binding: the fix carries an explicit round-trip property test over every `Value` variant
(Int/Id/Str/Term at minimum) asserting `parse(render(v)) == v`. A fix without that test does not
count as landed. Back-compat for existing untagged clients is the implementer's problem to solve
explicitly, not to skip.

## R-15. Where perspectives live (answers R-req-3) — A REAL EVALUATOR DIMENSION. Name-mangling REJECTED.

Perspectives sit behind 14 boot-loading tier-1 cases plus `p2-persp-isolation` — the single widest
blocker in the set.

**Ruling: perspective becomes a first-class dimension threaded through evaluation.** Encoding
`breach[audit]` into the relation name is explicitly REJECTED. Grounds: name-mangling makes the
perspective invisible to the evaluator, so per-perspective isolation, cross-perspective queries, and
`canonicalState()` would each have to re-parse the mangled name to recover a value the system
deliberately threw away; and the converted fact store **already carries a perspectives column**
(`/tmp/rofl-out-f1/rofl_manifest.json`), so mangling would put the wire and the store in permanent
disagreement — precisely the class of split that A4's cross-backend differential exists to catch.

This is the largest single item in the language lane and it is BOUNDED (a column threaded through
the evaluator, not a research problem), so per the completeness standard it is FINISHED, not parked.
It gets its own design round before any implementation.

## R-16. PROCESS: a failed agent must never reach a downstream prompt as `null`

R12 lost its second design lane: `design:native-rfdb` died on
`API Error: Claude's response exceeded the 32000 output token maximum`. Per `parallel()` semantics a
failed thunk resolves to `null`, and the script interpolated `JSON.stringify(designB, null, 1)`
straight into three downstream prompts. Critic B was therefore handed the literal text
`=== THE DESIGN YOU MUST TRY TO BREAK (premise: NATIVE RFDB) === null` and still returned a verdict
of **UNSOUND with 10 fatal flaws**. That verdict is an artifact and is hereby **struck from the
record** — `critique_verdicts.native_rfdb` in R12's result must not be cited by any later round.
(The other null-fed agent noticed and honestly reviewed the premise instead; the synthesizer also
caught it and set `grafted_from_loser: []` rather than inventing content. The round's own honesty is
what makes this recoverable.)

**Consequence: R12 was a two-design judge panel on paper and a one-design round in fact.** Its
committed design of record is a post-critique synthesis of design A only, which means **the design
of record itself has never been adversarially reviewed.** That review is the next round's first job.

Binding rules for every future round I author:
1. Every `parallel()` / `pipeline()` result is `.filter(Boolean)`-ed, or explicitly guarded, BEFORE
   interpolation into another prompt. Never `JSON.stringify(x)` a value that can be `null`.
2. If a fan-out lane dies, the round must either re-run it or **declare the degradation in its
   result** — a panel that silently loses a member must not report as a panel.
3. Structured-output schemas for long-form design agents get SPLIT (or their required-field count
   cut) so a single response cannot approach the 32k output ceiling. R12's `DESIGN_SCHEMA` had 11
   required fields, several being arrays of objects — that is what blew the limit.
