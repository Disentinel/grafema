# Datalog v2 — RESUME HERE (post-compaction handoff)

**Branch:** `feat/datalog`. **As of:** 2026-06-07. Single source of "where we are / what's next".

## 2026-06-07 session — committed progress (newest first)

- `76659214` Gate C **binding table (§9.3)**: new `datalog2/binding.rs` — `BindingTable`
  pins one `(semiring_id, arity)` + defining rule-AST-hash set per predicate; the
  per-predicate dual of compaction-⊕'s per-record guard. Wired into
  `evaluate_with_materialize` as a post-parse / pre-fixpoint gate (`EvalError::Binding`,
  E-BIND-001 semiring / E-BIND-002 arity). Pure `diff()` seam (Added/Removed/Semiring/
  Arity/RulesChanged) for the increment machinery. Semiring arm unit-tested directly
  (BoolTag-uniform at this gate); arity arm reachable end-to-end. Manifest persistence
  DEFERRED to (A) — TagV2.semiring_id is self-describing, no prior-run reader exists yet.
  8 binding tests; datalog2 unit 133 passed; Gate A re-verified 50/50 (gate transparent).
- `b081fe6a` compaction-⊕ part 2: fold tags in merge + coordinator branch (base fast-path
  unchanged; derived inputs ⊕-fold via `fold_tags` and write v3 via `add_derived`). I10
  non-Bool fixture tests. 427 storage_v2 green.
- `68506f29` compaction-⊕ part 1: tag↔bytes codec (`CountTag/ConfTag::to/from_le_bytes`),
  segment reader accepts Count/Conf semiring_ids (E-FMT-001 only on truly unknown),
  `compaction/tag_fold.rs::fold_tags` (Bool→dedup, Count→sum, Conf→min; E-FMT-002 mixed,
  E-FMT-003 malformed). COUNTTAG_SEMIRING_ID=1, CONFTAG_SEMIRING_ID=2.
- `63a4538d` Gate C semiring tags: `CountTag`/`ConfTag`/`Product<A,B>` + full law gates in
  `datalog2/tag.rs` (I4 enforced by CountTag NOT impl IdempotentTag → compile-rejected in
  recursion; I15 conf≠probability). 13 tag tests.
- `fbddfdd7` **RELEASE-BLOCKER done**: server `MaterializeDatalog` command (write-lock, kill-
  switch-gated, empty source ⇒ bundled depends.dl) + Hello advertises `datalogV2Materialize`
  + orchestrator phase-9 gated on it (legacy = P3 fallback). All green.
- `e0fe6a25` **Gate B exit**: build-once hash-join + planner ordering ⇒ depends.dl 97s; v2 is
  the correct reference (orchestrator MODULE#-sid bug recorded in gaps.md).

**Gate C state:** (1) semiring tags ✓, (3-partial) compaction-⊕ ✓ (the §8 storage half, folded
in per user decision). REMAINING: binding-table (§9.3 assert-uniformity minimum); numeric
literals (⚠ NOT cheap — `crate::datalog::Value` is shared-with-v1 and deliberately unmodified,
only Id/Str today; bare numbers / `gt(A,0)` need a value-representation decision, not a lexer
one-liner); **increment machinery / EDB Differ / fact-level deltas = the Gate C EXIT** (single-
line edit ⇒ deltas ⇒ maintained ≡ scratch over 100 cycles); annotations + why(). Full plan +
the §8 maps: `_ai/research/rfdb-datalog-gateB-residual-map.md`.

**Standing (user, 2026-06-07):** commit freely on `feat/datalog` without asking; NEVER push
without explicit permission.

## ▶ NEXT after compaction — resume here

**(B) binding-table DONE** (`76659214`). **NEXT = (A) increment machinery / EDB Differ — the Gate
C EXIT.** Single-line source edit ⇒ fact-level deltas ⇒ incrementally-maintained relation ≡
from-scratch evaluation over 100 seeded cycles (spec §9.1/§9.2). The big, multi-commit, defining
piece. Design forks to settle with the user BEFORE coding (laid these out, awaiting confirmation):

1. **Delta representation.** A run's output as `(predicate, fact, weight_delta)` triples under the
   predicate's semiring (`+w` insert / `-w` retract; BoolTag = ±1, CountTag = ±n). The EDB Differ
   computes the *input* delta (which base facts changed between two pinned snapshots); semi-naive
   already propagates IDB deltas. Recommend: reuse the existing `Δ`-loop machinery; the new piece is
   the EDB diff + retraction (negative weight) handling, which needs InvertibleTag (BoolTag/CountTag
   are; ConfTag is NOT → ConfTag predicates fall back to recompute, gated by the binding table).
2. **EDB Differ location & naming.** `datalog2/differential.rs` is ALREADY TAKEN — it is the Gate A/B
   *test harness* (the v1≡v2 + orchestrator differentials), NOT the spec's EDB Differ. Do not conflate.
   New module e.g. `datalog2/increment.rs`. The Differ diffs two `StorageView`s (prev-gen snapshot vs
   current) → base-fact deltas; consumes `BindingTable::diff()` to decide recompute-vs-maintain per
   predicate.
3. **Prior-run state persistence (the piece deferred from B).** To diff against the last run the
   Differ needs (a) the prior snapshot/manifest version pin and (b) the prior `BindingTable`. Persist
   the binding table in the manifest NOW as a NEUTRAL blob (storage_v2 must not depend on datalog2
   types — I10), touching `storage_v2/manifest.rs:150/233` + commit path. Also reconcile `rule_ast_hash`
   width here: String blake3 (`materialize.rs:199`) vs the u32 `ProvenanceV2.rule_ast_hash`
   (`storage_v2/types.rs:434`, today only ever synthetic test values) → recommend storing the full
   hash (string/u64-trunc) in the blob; keep ProvenanceV2.rule_ast_hash as the per-record index.

**Verify before starting (cheap):** `cargo test --lib datalog2::binding` (8) + the commands below.

**numeric-literals caveat (when it comes up):** NOT a lexer one-liner. `crate::datalog::Value` is
shared with the v1 top-down engine and deliberately unmodified (`exec.rs cmp_value` handles only
Id/Str). Bare numbers / the dead `gt(A,0)` guarantee (`.grafema/guarantees.yaml:371`) need a
value-representation decision (extend shared Value — risk to v1 — vs a v2-local numeric value).
Settle that design before touching the parser.

**Verify-current (independent of any agent report — P1):**
```
cd packages/rfdb-server
cargo test --lib datalog2 -- --skip datalog2_differential_against_real_dataset --skip depends2_matches  # expect 133 passed
cargo test --lib storage_v2                                                                              # expect 427 passed
cargo test --bin rfdb-server -- materialize router hello                                                 # release-blocker wiring
cargo test --lib datalog2_differential_against_real_dataset -- --ignored --nocapture   # Gate A: TALLY match=50 mismatch=0 (~18-280s)
cargo test --release --lib depends2_matches_orchestrator_ground_truth -- --ignored --nocapture  # Gate B: v2=622 ⊋ oracle=495, only-oracle=0 (~97s, MISMATCH is EXPECTED — orchestrator bug)
```
Pre-existing/unrelated: 5 `cypher::tests` aggregate tests fail on clean HEAD (from the main merge).

**Tasks (TaskList):** #10 Gate C in_progress (this); #6 §8 scaffolding — compaction-⊕ DONE, only
migrate-segments remains (L, low urgency); #8 P3 compliance (counter test + legacy-retirement.lock);
#9 re-analyze DEPENDS_ON supersede (parity-with-legacy verify); #1 multiworker resolve reconcile;
#4 planner q-error (Gate D) + parallel re-shuffle + gate-a.yaml (Gate A residuals).

---
## (historical, superseded by the 2026-06-07 section above)
Spec: `rfdb-datalog-engine-v2-spec.md`. Plans: `rfdb-datalog-gate-a-plan.md`, `rfdb-datalog-gate-b-plan.md`.
Appendix B: `rfdb-datalog-appendix-b-rule-migration.md`. Contract: `rfdb-datalog-storageview-contract.md`. Gaps: `_ai/gaps.md`.

## Status

- **Gate A — DONE & verified.** Bottom-up semi-naive engine in `packages/rfdb-server/src/datalog2/` (~7.3k LOC,
  10 modules). Real-data differential on `.grafema/grafema.rfdb` (143k nodes/137k edges): **51/51 v2 ≡ v1 top-down**
  (50 identical violation sets + 1 mutual rejection of a malformed rule). 0 mismatch.
- **Gate B — EXIT PASSED (2026-06-07), scaffolding + prod wiring remain.**
  - ✅ step 1 segment format v2 (commit `0dc5cd06`): provenance/tag/tx per-record columns, FORMAT_VERSION_DERIVED=3,
    forward-compat footer, E-FMT-001 on unknown semiring_id, v1 read-only. 417 storage_v2 tests.
  - ✅ @materialize write-back + run isolation + depends.dl + planner ordering (commit `7a1142c0`):
    materialize.rs (rule_ast_hash, plan_writeback, E-MAT-001/002/003); engine_v2.rs `eval_datalog_v2_materialize`
    (one pinned snapshot → fixpoint → one commit_batch_ext → one atomic manifest flip; abort-no-commit verified);
    stdlib/depends.dl; plan.rs lexicographic ordering key + corrected base_estimate. 121 datalog2 tests.
  - ✅ **build-once hash-join + ordering fix (NOT yet committed)** — `depends.dl` eval went from never-finishing
    (>15min, killed) to **97.66s**. `exec.rs join_attr_generator_built_once` (build the `value→[id]` hash side ONCE
    via one `sorted_run(Nodes)`, probe O(1)/row; falls back per-row for non-surface keys) + `plan.rs
    ordering_estimate` (a leg binding NO new var = 0-cost filter/point-check leads; a var-introducing leg incl. attr
    GENERATOR mode is cardinality-ranked → interleaves generator→filter, kills the ~12M-row blowup). 122 datalog2
    tests (added `attr_value_generator_is_built_once_not_per_row`). **Gate A re-verified 50/51 — no regression**
    (ordering-only change, I1). Differential diagnostic added to `differential.rs` (sid-parse-drops vs file-attr-maps).

## Gate B exit — PASSED with a product finding (decided 2026-06-07)

Exit differential ran (`depends2_matches_orchestrator_ground_truth`, release, 97.66s): **v2=622 vs orchestrator=495,
only-v2=127, only-oracle=0**. NOT byte-≡ — but the divergence is an **orchestrator bug, not a v2 bug**:
- The orchestrator derives DEPENDS_ON by STRING-PARSING the endpoint semantic_id (`main.rs:1745-1758`: strip
  `grafema://{authority}/` else `split("->")`). A Haskell `IMPORTS_FROM` dst is a MODULE node with sid
  `MODULE#/abs/path.hs`, which matches NEITHER branch → file_to_module miss → **edge silently dropped** (805 of 1644).
- v2's `depends.dl` joins on the node's `file` **attr** (no sid-parse), so it maps them correctly → the 127 only-v2
  pairs are **real** module deps the orchestrator drops, on all 16 Haskell packages. `only-oracle=0` ⇒ v2 misses nothing.
- **Decision (user):** v2 is the correct reference → Gate B exit PASSED. Recorded the orchestrator bug in `_ai/gaps.md`
  (2026-06-07). The orchestrator's sid-parse derivation will be REPLACED by v2 `@materialize` (build-once removed the
  historic "v1 joins time out" reason that put it in the orchestrator), not patched.

## ⛔ RELEASE BLOCKER (user, 2026-06-07): production materialization not wired

`eval_datalog_v2_materialize` is called **only from tests** (`engine_v2.rs:2958,3004` inside `#[test]`). The
`RFDB_DATALOG_V2` router (`rfdb_server.rs:2624-2755`) routes only the READ/CheckGuarantee path; @materialize write-back
is NOT in the server dispatch, and the orchestrator (`main.rs:1734-1789`) is still the only thing materializing
DEPENDS_ON. **Until v2 @materialize is wired into prod dispatch AND the orchestrator derivation is gated behind the
kill switch (so prod DEPENDS_ON is the correct file-attr derivation), DO NOT release.** This is the top Gate-B-residual
priority.

## Remaining Gate B scaffolding (full §8)

Degenerate for BoolTag, build for Gate C readiness: **binding table** (§9.3 predicate→semiring_id/schema/hashes),
**compaction-⊕** generalization (`storage_v2/compaction/merge.rs:26-34/56-64` dedup → ⊕-fold), **migration tool**
`rfdb migrate-segments` (§8.6). Plus the release-blocker prod wiring above. **First action next session: an
understand-workflow mapped these 5 areas — see its output / the synthesized plan.** NOTE: today's build-once +
ordering + diagnostic changes are UNCOMMITTED (working tree) — commit when the user asks.

## Verify-current commands (independent of agent reports — P1)

```
cd packages/rfdb-server
cargo check
cargo test --lib datalog2 -- --skip datalog2_differential_against_real_dataset    # expect 121 passed
cargo test --lib storage_v2                                                        # expect 417 passed
cargo test --lib datalog2_differential_against_real_dataset -- --ignored --nocapture  # Gate A: TALLY match=50 mismatch=0 v2_err=0 both_err=1 (~90-280s)
```
Pre-existing/unrelated: 5 `cypher::tests` aggregate tests fail on clean HEAD (not datalog2 — likely from the main merge; candidate for a separate fix).

## Other open tasks (see TaskList + _ai/gaps.md)

- #1 Reconcile multiworker resolve with main's checkpoint/telemetry (from the main merge; orchestrator).
- #4 Roadmap residuals: numeric literals → Gate C (revives the 1 dead guarantee `gt(A,0)`); planner q-error → Gate D;
  parallel re-shuffle (I1 K=N) + `bench/manifests/gate-a.yaml` → Gate A residuals.
