# Datalog v2 — RESUME HERE (post-compaction handoff)

**Branch:** `feat/datalog`. **As of:** 2026-06-06. Single source of "where we are / what's next".
Spec: `rfdb-datalog-engine-v2-spec.md`. Plans: `rfdb-datalog-gate-a-plan.md`, `rfdb-datalog-gate-b-plan.md`.
Appendix B: `rfdb-datalog-appendix-b-rule-migration.md`. Contract: `rfdb-datalog-storageview-contract.md`. Gaps: `_ai/gaps.md`.

## Status

- **Gate A — DONE & verified.** Bottom-up semi-naive engine in `packages/rfdb-server/src/datalog2/` (~7.3k LOC,
  10 modules). Real-data differential on `.grafema/grafema.rfdb` (143k nodes/137k edges): **51/51 v2 ≡ v1 top-down**
  (50 identical violation sets + 1 mutual rejection of a malformed rule). 0 mismatch.
- **Gate B — in progress (full §8 chosen).**
  - ✅ step 1 segment format v2 (commit `0dc5cd06`): provenance/tag/tx per-record columns, FORMAT_VERSION_DERIVED=3,
    forward-compat footer, E-FMT-001 on unknown semiring_id, v1 read-only. 417 storage_v2 tests.
  - ✅ @materialize write-back + run isolation + depends.dl + planner ordering (commit `7a1142c0`):
    materialize.rs (rule_ast_hash, plan_writeback, E-MAT-001/002/003); engine_v2.rs `eval_datalog_v2_materialize`
    (one pinned snapshot → fixpoint → one commit_batch_ext → one atomic manifest flip; abort-no-commit verified);
    stdlib/depends.dl; plan.rs lexicographic ordering key + corrected base_estimate. 121 datalog2 tests.
  - ✅ **No Gate A regression** from the planner change — 51-rule differential re-verified at 50/51.

## THE blocker — resume here first

**Gate B exit (v2 `depends/2` ≡ orchestrator DEPENDS_ON) is UNVERIFIED — `depends.dl` does not finish evaluating
on the real graph, in debug OR release** (killed; >15 min release). Confirmed **algorithmic**, not a constant factor.

- Root cause: the executor evaluates a join leg **per-row**. For `depends`, the sub-pattern
  `node(M,"MODULE"), attr(M,"file",F)` does a `nodes_by_attr("file", F)` index probe **per IMPORTS_FROM row**
  (1644 rows × 2 endpoints). This is the **2nd instance** of the same limitation that caused the earlier
  anti-join `O(rows×M)` hang (fixed there by a one-time probe-set in `exec.rs`).
- **Fix (the next task):** make the executor **build the hash side ONCE** for a shared-variable generator leg
  (build-once hash-join), instead of re-evaluating the leg per row. This is the proper semi-naive design
  (spec §4: "Δ-side joins are hash-joins, build on Δ; Total/EDB legs merge-join over sort orders"). It benefits
  ALL multi-join rules, not just depends. Likely in `exec.rs` `join_extensional`/the leg-eval loop, mirroring the
  `build_anti_join_set` pattern already there.
- **Then** run the exit differential: `cargo test --release --lib depends2_matches_orchestrator_ground_truth -- --ignored --nocapture`
  (test at `src/datalog2/differential.rs:687`).
- **Correctness nuances to confirm in that differential** (may affect exact ≡):
  - Oracle finding: **805 of 1644 IMPORTS_FROM edges have an endpoint with no file→MODULE mapping** (dst is
    EXTERNAL_MODULE/FUNCTION/CONSTANT/…), so the orchestrator-equivalent emits module→module pairs only for the
    ~839 both-in-module edges. depends.dl correctly excludes non-module ends via `node(M,"MODULE")`.
  - If a single `file` maps to >1 MODULE node, depends.dl emits both pairs whereas the orchestrator's HashMap keeps
    one — verify whether this happens in the real graph.
  - `.grafema/grafema.rfdb` currently contains **0 DEPENDS_ON edges** in store, so the differential reproduces the
    orchestrator's module→module oracle in-test (it does).

## Remaining Gate B scaffolding (full §8, after the exit)

Degenerate for BoolTag, build for Gate C readiness: **binding table** (§9.3 predicate→semiring_id/schema/hashes),
**compaction-⊕** generalization (`storage_v2/compaction/merge.rs:26-34/56-64` dedup → ⊕-fold), **migration tool**
`rfdb migrate-segments` (§8.6). Then wire the `RFDB_DATALOG_V2` router so the server dispatch actually calls the v2
materialize path, and gate the orchestrator's DEPENDS_ON derivation behind it.

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
