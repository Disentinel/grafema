# Datalog v2 — RESUME HERE (post-compaction handoff)

**Branch:** `feat/datalog`. **As of:** 2026-06-06. Single source of "where we are / what's next".
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
