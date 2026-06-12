# Gate B residuals — implementation map (understand-workflow `wqr7w5ngj`, 2026-06-07)

Synthesis of 5 parallel reader agents over the remaining Gate B areas. Each claim below is
backed by `file:line` the agent actually read. Full agent transcripts: workflow run
`wf_05770c08-157`. Spec: `rfdb-datalog-engine-v2-spec.md`.

Two buckets: **(R) release-blocker** (must ship before any release) and **(S) §8 scaffolding**.

---

## (R) RELEASE-BLOCKER — wire v2 @materialize into prod + gate orchestrator (task #5)

Two pieces that MUST ship together (gate without wiring ⇒ prod loses DEPENDS_ON entirely).

### R1. Server-side @materialize command (prod-materialize-wiring)
- Engine entry exists & is correct: `eval_datalog_v2_materialize` (`engine_v2.rs:417-473`): pin
  snapshot → `evaluate_with_materialize` → `plan_writeback` → ONE `commit_batch_ext` (one manifest
  flip; abort-no-commit via `E-MAT-001/002/003`). Called **only from `#[test]`** (`:2958,:3004`).
- Read path is the pattern to mirror: `datalog_v2_enabled()` reads `RFDB_DATALOG_V2` per-request
  (`rfdb_server.rs:2634-2639`); `route_datalog_v2` (`:2671`) downcasts `as_any().downcast_ref::<GraphEngineV2>()`
  on a SHARED read lock and calls the read entry `eval_datalog_v2` (`:2689`).
- BUT materialize is `&mut self` (ends in `commit_batch_ext`) ⇒ must go through the EXCLUSIVE
  write lock `with_engine_write` (`:2577-2597`, enforces `session.can_write()`), using
  `as_any_mut().downcast_mut::<GraphEngineV2>()` (precedent: `Request::CommitBatch` at `:1801-1812`).
- **Steps:** add `Request::MaterializeDatalog { source }` (enum ~`:240-257`); add gated
  `dispatch_materialize_datalog(&mut dyn GraphStore, source)` (refuse with a coded error when
  `!datalog_v2_enabled()` — I5, never silent); wire the arm under `with_engine_write` returning
  `Response::Count { count }`. Effort **M**.

### R2. Gate orchestrator phase 9 (orchestrator-gating)
- Phase 9 (`grafema-orchestrator/src/main.rs:1733-1795`) runs unconditionally; lossy sid-parse at
  `:1746-1755`; commits DEPENDS_ON at `:1781`. The Haskell `MODULE#` drop bug = `_ai/gaps.md` 2026-06-07.
- Orchestrator reads NO env today; connects via `RfdbClient::connect` whose Hello handshake already
  returns `HelloResponse{protocol_version, server_version}` (`grafema-orchestrator/src/rfdb.rs:268-272`).
- **DECISION A (recommended): handshake capability, NOT a duplicated env read.** Add a bool
  capability (e.g. `datalog_v2_materialize`) to the Hello response, populated from the SERVER's
  `datalog_v2_enabled()`. Rationale: kill switch is authoritative on the server (it owns whether a
  `GraphEngineV2` backend even exists, `:2677-2683`); a second env read in the orchestrator process
  could disagree ⇒ double-write or zero-write. Handshake = single source of truth.
- **Steps:** (1) Hello capability bool both sides; (2) gate `if !caps.datalog_v2_materialize && !imports.is_empty()`
  at `main.rs:1736` (skip the whole legacy block when v2 active); (3) in the v2 branch, call the new
  R1 command so prod DEPENDS_ON becomes the correct file-attr derivation; (4) **P3**: keep the legacy
  block runnable + emit a legacy-path execution counter (spec P3 `:63` asserts execution, not equality)
  + add `legacy-retirement.lock` so CI fails if it's deleted before Gate E + one release. Effort **M**.

### R-prereqs / open correctness questions
- **Commit the uncommitted build-once+ordering fix FIRST** — both R agents flag the v2 materialize
  path is only viable with it (it's what made depends.dl finish). [needs user "commit"]
- **Re-analyze supersede (OPEN):** does the additive `commit_batch_ext` (empty `changed_files`,
  `engine_v2.rs:464`) correctly supersede a PRIOR generation's DEPENDS_ON on re-analyze, or accumulate
  stale pairs? Legacy path relies on phase-9.5 compaction dedup (`main.rs:1797-1814`). **Verify before
  shipping** — risk of stale + new edges coexisting.
- **Provenance mismatch:** legacy stamps `_source:"module-dependencies"`; v2 stamps `_source=rule_ast_hash`.
  Confirm GC/compaction keyed on `_source` tolerates both across the migration window.

---

## (S) §8 SCAFFOLDING (task #6) — degenerate for BoolTag, built for Gate C readiness

### S1. binding table (§9.3)
- Nothing exists today (grep clean). Per-record blocks DO exist: `TagV2{semiring_id:u16,bytes}` +
  `BOOLTAG_SEMIRING_ID=0`, `ProvenanceV2{rule_ast_hash:u32,generation:u64}`, `DerivedFields`
  (`storage_v2/types.rs:423-505`); reader raises E-FMT-001 on unknown semiring_id (`segment.rs:124`).
- Missing: the predicate→`(semiring_id,annotation_id,lattice_id,schema,defining_rule_hashes)` table; a
  persistence home (manifest carries ZERO datalog metadata, `manifest.rs:150-207`); stable predicate_id
  (`assign_pred_ids` is run-local name-ordered, `exec.rs:1282`); unified rule-hash width (**String blake3 in
  `materialize.rs:199` vs u32 in `types.rs:426`** — must reconcile, recommend u64).
- **Steps:** new `datalog2/binding.rs` types; build table during `evaluate_with_materialize` (`mod.rs:180`);
  persist as opaque blob in `Manifest`/`ManifestEdit` (keep storage_v2 from depending on datalog2 types — I10);
  read-back binding-change guard (changed semiring/schema ⇒ full rebuild + refuse to merge mixed segments).
  Gate B degenerate **S–M** (every field collapses to a constant); full §9.3 invalidation driver = **L**, depends on Gate C.

### S2. compaction-⊕
- `merge.rs:22-79` does first-insert-wins dedup keyed on id / `(src,dst,type)`; tombstone filter at
  `:37,:67`. Compaction feeds the writer via `.add()` ⇒ emits BASE v2 ⇒ **strips derived columns even if
  inputs had them** (`coordinator.rs:104-156`, `writer.rs:103-108`). Tags never folded.
- Spec §8.2 (`:221-224`): merge duplicate keys by ⊕ on tags; I10 (`:54`): "compaction output equals
  explicit fold on fixtures."
- **Steps:** tag-aware merge at the read boundary (`seg.tag(i)`/`provenance`/`tx`); branch base-vs-derived
  in coordinator on `has_derived_columns()` (`segment.rs:350`) keeping the base fast-path byte-identical;
  generalize dedup→⊕-fold in the derived path; semiring-dispatched `fold_tags(semiring_id,a,b)` (Gate B:
  BoolTag→`bool_one()`, else E-FMT-001). Effort **M**.
- **TRAP:** BoolTag is idempotent ⇒ a BoolTag-only test PASSES while the CountTag fold path is wrong.
  The I10 fixture test MUST use a non-Bool fixture semiring or assert fold-count, not presence.
- **Payload vs tag split:** payload = newest-wins (current), but tag must ⊕-fold across ALL versions —
  do NOT `or_insert` the whole `DerivedFields` (silently drops earlier weights).

### S3. `rfdb migrate-segments` (§8.6)
- Versions defined/enforced: `FORMAT_VERSION=2` base / `=3` derived, `MAX_READABLE_VERSION=3`,
  `MAGIC_V2=SGV2`/`MAGIC_V1=SGRF` (`types.rs:16-38`). v1 is currently **NON-readable** — `validate()`
  errors on SGRF pointing at a tool that doesn't exist (`types.rs:143-164`). No v1 reader anywhere.
- Atomic swap machinery exists (`ManifestStore` temp+fsync+rename, `manifest.rs:748`); compaction is the
  read-all→rewrite→swap analog (`coordinator.rs:75-156`). No CLI subcommand surface (daemon hand-parses
  `env::args()`, `bin/rfdb_server.rs:3548`). `SegmentDescriptor` has NO `format_version` ⇒ must open files to detect.
- **Steps:** new `storage_v2/segment_v1.rs` (SGRF reader — **layout must be recovered from git history**,
  the load-bearing missing piece); `storage_v2/migrate.rs` (per-shard read→rewrite→temp→rename, skip-if-already-target
  for idempotency, per-shard commit for resume); CLI branch at top of `main()` (`:3549`, offline, exclusive).
  Effort **L**, dominated by the v1 reader (**M** alone).
- **OPEN:** migration target v2-base vs v3-derived? (spec says "IDB writes v2-only" but Gate B added v3 —
  decide per-DB by whether Datalog v2 is enabled). Derived-column defaults (tag `one()`, deterministic
  `tx_created` — wrong `tx_created` breaks MVCC `as_of` visibility).

---

## Cross-cutting decisions to settle before/while coding

1. **Predicate→semiring granularity** (gates BOTH S1 & S2): per-record uniform-`semiring_id`-assert (Gate-B-only,
   keeps everything BoolTag, defer manifest table) vs introduce the §9.3 manifest binding table now.
   Both agents recommend the assert-uniformity minimum for Gate B; full table when datalog2 actually writes
   derived segments (Gate C). **Recommend: assert-uniformity now, table seam exposed for Gate C.**
2. **rule_ast_hash width** — reconcile String(blake3)/u32 → recommend u64.
3. **Migration target** v2-base vs v3 + v1 SGRF layout recovery.
4. **Re-analyze DEPENDS_ON supersede** (release-blocker correctness) — verify additive commit doesn't
   accumulate stale pairs.

## Recommended order (user chose strict-sequential)
1. **Commit the verified Gate B milestone** (build-once + ordering + diagnostic + docs) — clean checkpoint, R-prereq. [needs user "commit"]
2. **R1+R2 release-blocker** together (server command + handshake-gated orchestrator), incl. the re-analyze-supersede check + P3 counter/lock.
3. **S2 compaction-⊕** + **S1 binding-table** (assert-uniformity minimum) — coupled; the unmergeability guard must land before any non-Bool semiring (Gate C).
4. **S3 migrate-segments** — independent, L; can be scheduled when v1-store support is actually needed.
5. Then **Gate C**.
