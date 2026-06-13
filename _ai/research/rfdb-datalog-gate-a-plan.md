# Gate A Plan — Datalog v2 Core (on real storage_v2)

**Status:** Gate A.0 complete → Gate A planning. Companion to `rfdb-datalog-engine-v2-spec.md` (§13 Gate A),
`rfdb-datalog-appendix-b-rule-migration.md` (51/51 rule-portable), `rfdb-datalog-storageview-contract.md`
(Architect resolutions). Design 2026-06-05.

## Resolved design premises (entering Gate A)

1. **Real storage, not a mockup.** StorageView is implemented over the real `storage_v2` version-pinned
   `ReadSnapshot` from day one. The in-memory impl exists ONLY as a unit/property-test fixture.
2. **Sorted runs are near-free.** L1 segments are already sorted by the existing blocking compaction merge
   (`merge.rs:41` nodes by id, `:71` edges by `(src,dst,edge_type)`; sole prod caller `compact_shard`
   `coordinator.rs:99`). L0 is unsorted (`write_buffer.rs:3`) but bounded by C3. A sorted run = k-way merge
   over `{sorted L1} + {L0 sorted in RAM at snapshot capture}`. No segment-format change required for Gate A.
3. **Graph-native predicates.** Base preds = views over node/edge CFs; transient derived preds live in RAM;
   `@materialize` preds project to edges/nodes; relational CF only lazily for arity ≥ 3. No predicate enumeration.
4. **Sits BESIDE the top-down engine.** Shared: types, parser, builtin bodies, GraphStore access, EvalLimits.
   Kill switch `RFDB_DATALOG_V2=off` (P3). One eval entry; explain = recording of it (I8).

## Module decomposition — `packages/rfdb-server/src/datalog2/`

Dependency order (lower builds first; each layer compiles + tests before the next fans out):

| # | Module | Contents | Depends on | Key invariants |
|---|---|---|---|---|
| 0 | `tag` | `Sealed`, `Tag`, `InvertibleTag`, `IdempotentTag` traits; `BoolTag` (Gate A only — Count/Conf/Product are Gate C) | — | I4 (recursion gated on `IdempotentTag`), I6 (sealed) |
| 1 | `value` | reuse v1 `Value`; `Fact = Box<[Value]>`, `Row`, `fact_id = u64 hash(pred_id, key)` | — | I1 (deterministic fact_id) |
| 2 | `storage_glue` (StorageView) | trait + real-LSM impl over `ReadSnapshot`; in-memory fixture impl | value, storage_v2 | I10 (access only via StorageView; module-private), §8.3 (no per-tuple point lookups in fixpoint) |
| 3 | `parser_ext` | extend v1 parser for Appendix-A annotations (`@tag`,`@materialize`,`@tag_from`,`@lattice`), `#requires`, `=>`, aggregates; Gate A needs at least `@materialize` + plain rules | v1 parser | I5 (every reject carries E-code) |
| 4 | `stratify` | predicate dep graph incl. storage-level @materialize map + negation edges; SCC condensation; `E-STRAT-001` on neg-in-cycle | parser_ext | I3 (strata), §4 stratification |
| 5 | `builtin` | `BuiltinDef` registry; port v1 eval bodies (node, edge, incoming, attr, neq, gt/lt, starts_with, …); modes + cost | storage_glue, value | I5 (unsupported mode → E-PLAN-001) |
| 6 | `plan` | literal reorder (bound-first feasibility, port v1), greedy cost from Stats, join-kind pick (hash on Δ / merge on Total via sorted runs), guards §3 | builtin, stratify | §3 guards (E-PLAN-003/004/005) |
| 7 | `exec` | semi-naive fixpoint: seed → Δ-loop, hash/merge joins, re-shuffle by fact_id, GROUP BY + ⊕ fold, tag_changed term.; EvalLimits per stratum; iteration cap 10k → E-EXEC-002 | plan, tag, storage_glue | I1 (worker-count invariance), I3 (⊆-growth), I4 (termination) |
| 8 | `events` | always-on `events.jsonl`; decisions + aggregate counters; versioned schema | exec, plan | I9 (log is source of truth) |
| 9 | (entry) `mod.rs` | single eval entry; router from `rfdb_server.rs` dispatch behind `RFDB_DATALOG_V2`; in-memory harness wiring | all | I8 (one eval entry), P3 (kill switch) |

**Out of Gate A (deferred):** Count/Conf/Product tags + annotations + why() (Gate C); EDB Differ (Gate C);
segment v2 / binding table / compaction-⊕ / @materialize write-back (Gate B); lattices (Gate C); sim() (Gate E).

## Locked StorageView trait (Gate A surface)

Backed by the real `ReadSnapshot`; in-memory fixture implements the same trait. Five methods (per contract),
the load-bearing one being the sorted-run iterator that the fixpoint merge-joins over:

```rust
pub(crate) trait StorageView {
    /// Version-pinned snapshot identity (already exists: MultiShardStore::snapshot → ReadSnapshot::capture).
    fn generation(&self) -> u64;

    /// Sorted run of a base relation in a given order — k-way merge over {sorted L1} + {L0 sorted at capture}.
    /// THE fixpoint access path (merge-join legs). Orders: Nodes by id; Edges by (src,type,dst) and (dst,type,src).
    fn sorted_run(&self, rel: Relation, order: SortOrder) -> Box<dyn Iterator<Item = Row> + '_>;

    /// Typed scan by node type (generator for `node(X, T)`); lazy iterator, not a materialized Vec.
    fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = NodeRow> + '_>;

    /// Edges by type, served as a sorted run on the requested order (forward for edge(), reverse for incoming()).
    fn scan_edges_by_type(&self, ty: &str, order: EdgeOrder) -> Box<dyn Iterator<Item = EdgeRow> + '_>;

    /// Bound-id point lookup — the ONLY permitted point lookup, for already-bound ids (attr/parent_function).
    /// FORBIDDEN inside the fixpoint hot path on unbound vars (§8.3).
    fn get_node(&self, id: u128) -> Option<NodeRow>;
}
```

Design rules locked now: **no point lookups except already-bound single ids**; everything else is a sorted-run /
typed scan; sharding hidden behind the iterators (per-shard merge internal).

## Gate A conformance manifest (outline)

Machine-checkable YAML (`bench/manifests/gate-a.yaml`), green = pass in CI:
- **Parser:** Appendix-A subset round-trips; every malformed input → a stable E-code (I5).
- **Stratifier:** storage-level @materialize deps included; neg-in-SCC → E-STRAT-001 (enumerated fixtures).
- **Executor (BoolTag):** semi-naive correctness on fixtures; **I1** K=1 vs K=N vs rule-order-permutation → byte-equal;
  **I3** ⊆-growth checker on; **I4** trybuild: CountTag-in-recursive-stratum fails to compile + iteration-cap fires.
- **StorageView:** point-lookup-in-fixpoint plan asserts E-PLAN (I10); real-LSM impl and in-memory fixture return
  identical results on the dogfood corpus (differential test); sorted_run verified monotone per order.
- **One engine (I8):** public-api snapshot pins a single eval entry; explain asserts the entry's execution counter.
- **Pilot:** the 51 guarantee rules (all rule-portable) evaluate on dogfood; result key-set ≡ the current top-down
  `check` output (the differential anchor — this is the Gate A acceptance signal that the engine is real).

## Next action

Implementation workflow over the module DAG: pipeline modules 0→9 (worktree isolation, parallel where deps allow),
each module → write + compile + its invariant checks → adversarial review against the conformance manifest row.
The 51-rule differential against the live top-down `check` is the Gate A exit gate.
