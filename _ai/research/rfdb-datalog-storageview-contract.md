# StorageView Contract (Datalog v2) — Draft

**Status:** Gate A.0 output.
**Companion to:** `rfdb-datalog-engine-v2-spec.md` §7 (planner / access paths) and §8.3 (point-lookup ban on the fixpoint hot path).

## Summary

StorageView for Datalog v2 is grounded in the **actual MVCC read path**: `multi_shard.rs` `*_at` methods over a version-pinned `ReadSnapshot`. `storage_v2` consists of **TWO column families** (nodes + edges), stored as **COLUMNAR segments in INSERTION order, unsorted**.

**3 of 5 spec primitives EXIST** in some form; the **2 MISSING** primitives are the load-bearing ones for the spec's §7/§8.3 access-path model:
- **sorted-run-per-(predicate, order)** — does not exist; segments are unsorted, lookups are positional/linear.
- **predicate-as-column-family** — does not exist; only 2 `SegmentType` variants (Nodes/Edges), other predicates are first-class fields, metadata JSON, or edge-type filters.

See **Gaps** and **Open questions** below.

## Proposed trait methods

| Name | Signature | Purpose | Backed by (file:line) | Status |
|---|---|---|---|---|
| `snapshot` | `fn snapshot(self) -> ReadSnapshot` | version-pinned view the fixpoint reads against | `MultiShardStore::snapshot` multi_shard.rs:794 → `ReadSnapshot::capture` read_snapshot.rs:193 | **exists** |
| `get_node` | `fn get_node(snap, id) -> Option<NodeRecordV2>` | point lookup eval.rs:1203; §8.3 wants this off the hot path, bound-id only | `get_node_at` multi_shard.rs:852 (bloom + LINEAR 865–869) | **exists** |
| `scan_nodes_by_type` | `fn scan_nodes_by_type(snap, t) -> Iterator<u128>` | generator `node(X, TYPE)`, want lazy iter eval.rs:405 | `find_node_ids_by_type_at` :1409 → chunked :1460, materializes `Vec` | **partial** |
| `get_outgoing_edges` | `fn get_outgoing_edges(snap, src, types) -> Vec<EdgeRecordV2>` | `edge(src, Dst, T)` eval.rs:875 | `get_outgoing_edges_at` :1107 (`maybe_contains_src` :1120; no src-sorted run) | **exists** |
| `sorted_run` | `fn sorted_run(snap, pred, order) -> Iterator<Tuple>` | core spec §7: sorted run per (predicate, order), no point lookups | **NONE**; positional `get_id` segment.rs:259/303, no sort/merge/binary-search; **WRITE-PATH change** | **new** |

## Gaps

1. **NO sorted-run-per-(predicate, order):** unsorted segments, positional `get_id` segment.rs:259/303; `get_node_at` is a linear scan after the bloom filter multi_shard.rs:865–869. Needs write-time sorting.
2. **NO predicate-as-column-family** (`open_column_family` would be NEW): `SegmentType` is a 2-variant enum Nodes/Edges manifest.rs:48; other predicates are either first-class fields eval.rs:1216–1222, metadata JSON eval.rs:1225–1234 / segment.rs:297, or an edge_type filter (`eval_edge` :875/915).
3. **NO per-edge-type sorted run:** `scan_edges_by_type` is PARTIAL — `get_edges_by_type_at` multi_shard.rs:1321 linear-scans every edge segment; hash-join eval.rs:527/603 builds a `HashMap` src→dsts per call.
4. **Fixpoint = per-tuple POINT LOOKUPS that §8.3 bans:** `process_literals` eval.rs:304–325 → `get_node` multi_shard.rs:852 is O(segments); avoided only when the hash-join path fires (`should_hash_join` eval.rs:489).
5. **Snapshot reads BYPASS live indexes by design** multi_shard.rs:983–984; `find_similar_names_at` :1578 is the only index-using `*_at` method (L1 token index).
6. **NO snapshot-pinned BFS** (`bfs` would be NEW): `GraphStore::bfs` mod.rs:97 / `reachability` mod.rs:198 run on the **live** engine; `path()` eval.rs:1394 is not version-pinned.
7. **NO snapshot cardinality beyond totals** (`count_nodes_by_type` PARTIAL): `ManifestStats` carries only `total_nodes`/`total_edges` manifest.rs:527; `count_by_type_at` :1068 is a full O(records) scan.
8. **Other backed methods (no new gap):** `scan_nodes_by_attr` PARTIAL :1460 (`matches_attr_filters` :1493 parses metadata JSON segment.rs:297); `get_incoming_edges` EXISTS :1192 (`maybe_contains_dst` :1203); `node_exists` EXISTS :900; live counts EXIST :1031/:1400; `bloom_probe` PARTIAL segment.rs:321/512/517 (not surfaced at snapshot level). Metadata is an **opaque JSON STRING** segment.rs:297, zone-mapped only on `node_type`/`file` :328/333.

## Open questions (need architect decision)

1. **Sorted runs:** sort segments by `node_id` / `(src, edge_type, dst)` **AT WRITE TIME** (writers + segment.rs binary search + L0/L1 merge), or maintain **separate sorted index files** per (predicate, order)? Former changes the segment binary format; latter adds GC/manifest surface.
2. **Predicate-CF scope:** FIXED set (node, edge, attr-by-key) or OPEN (one CF per derived predicate)? Only 2 `SegmentType` variants exist today.
3. **Granularity:** keep whole-relation `Vec` methods (`get_edges_by_type`, `get_outgoing_edges`) or go iterator-only? `get_node` point lookup is still needed for bound-id attr/parent_function — is the rule "no point lookups except already-bound single ids"?
4. **Index visibility:** must indexes be persisted per-version (segments) and pinned by `VersionPins`, coupling index build into `commit_batch` :2097 and the C3 segment-bounding work?
5. **Per-snapshot cardinality oracle:** extend `ManifestStats` with per-type / per-edge-type counts at commit so the planner can order literals without an O(records) `count_by_type_at` scan?
6. **Write buffer:** all `*_at` methods exclude it read_snapshot.rs:7–15 — does v2 ALWAYS read a committed snapshot (uncommitted in-session writes invisible)? Acceptable for the resolve-phase evaluator?
7. **Shard structure:** expose `shard_node_descriptors` / `shard_ids` read_snapshot.rs:217/245 for per-shard parallel scans, or hide sharding from the StorageView?

## Architect resolutions (post-A.0 review, 2026-06-05)

Two of the open questions are resolved by review; the A.0 agent's gap analysis examined only the **read path** and missed the write/compaction path. Corrections (audit trail preserved — the gaps above are what the agent found, this section is what review concluded):

**Q1 (sorted runs) — RESOLVED, near-ZERO write-path change.** The compaction merge **already sorts its output**: `merge_node_segments` sorts by `node_id` (merge.rs:41), `merge_edge_segments` by `(src, dst, edge_type)` (merge.rs:71-76); module doc says "single **sorted**, deduplicated list". Its only production caller is `compact_shard` (coordinator.rs:99 — confirmed by graph: find_calls=6, 5 are tests). So **L1 segments are already sorted runs** → `seg.iter()` yields in order, no segment-format change. L0 is explicitly unsorted (write_buffer.rs:3) but **bounded** by C3 (~90-110 node-segs / ~320 edge-segs per shard, from get_stats shard diagnostics). A sorted run per predicate = **k-way merge over {sorted L1} + {L0}**, with L0 sorted in RAM at `ReadSnapshot` capture (once per run, bounded). This is **read/eval-side**; the only optional write-path tweak is sorting `drain_nodes()`/`drain_edges()` before L0 flush (one `.sort_by_key`). Gap 1 and the `sorted_run` "new" status above are therefore overstated — they reflect the read API not exploiting an order that already exists on disk. **Decision: build StorageView on the REAL storage_v2, not an in-memory BTree.**

**Q2 (predicate-CF) — RESOLVED graph-native, no unbounded enumeration.** The DB stays a graph. (a) Base predicates (`node`, `edge`, `attr`, `incoming`) are **views** over the existing node/edge CFs — no new storage. (b) Most derived predicates are **transient** (live in RAM Total/Δ for the run, never stored). (c) `@materialize` predicates land **back in the graph**: binary → edges (spec §3 "writes real edges stamped _source/_generation"; DEPENDS_ON already works this way today), unary → nodes/attrs. (d) A genuine relational column family is needed **only lazily, only for arity ≥ 3** typed-tuple predicates. The stored-predicate set is therefore NOT arbitrary/unbounded — it equals the set of declared `@materialize` predicates, **known at rule-load** (binding table §9.3), allocated lazily, GC'd when a rule is removed. Resolves the spec's internal §3-vs-§8.2 tension toward graph-native. (Common-sense catch by user; verified on real code.)

**In-memory impl status:** demoted to a **unit/property-test fixture** (fixpoint, negation, aggregation in RAM), NOT the substrate the engine is validated on. The engine reads a real version-pinned snapshot from day one.
