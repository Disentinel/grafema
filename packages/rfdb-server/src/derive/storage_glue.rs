//! Layer 2 — `StorageView` (the only access path to storage).
//!
//! Defines the locked `StorageView` trait (five methods: `generation`, `sorted_run`,
//! `scan_nodes_by_type`, `scan_edges_by_type`, `get_node`) and its two implementations:
//! the real LSM impl over a version-pinned `storage_v2::ReadSnapshot` and an in-memory
//! fixture impl used only by unit/property tests. Invariants: I10 (storage is reachable
//! ONLY through `StorageView`, which is module-private) and §8.3 (no per-tuple point
//! lookups inside the fixpoint hot path — the sole permitted point lookup is `get_node`
//! on an already-bound id).
//!
//! # The sorted-run access path
//!
//! The fixpoint joins legs by merge-join, which requires each base relation to be
//! readable as a *sorted run* in a chosen order (nodes by id, edges by `(src,type,dst)`
//! forward or `(dst,type,src)` reverse). Per the StorageView contract (Architect
//! resolution Q1), L1 segments are already sorted by the compaction merge and L0 is
//! bounded; the design is a k-way merge over `{sorted L1} + {L0 sorted at capture}`.
//!
//! The real impl ([`LsmStorageView`]) reads a *version-pinned* `ReadSnapshot` through
//! the public, tombstone-and-dedup-correct snapshot API of `MultiShardStore`
//! (`find_nodes_at`, `iter_all_edges_at`, `find_node_ids_by_type_at`,
//! `get_edges_by_type_at`, `get_node_at`). Those methods already resolve L0-newest-wins
//! dedup plus the version's tombstones; the view then orders the resolved live rows once
//! to expose a monotone sorted run. The k-way merge primitive itself ([`kmerge`]) is a
//! real, reusable iterator: the in-memory fixture feeds it the naturally-sorted legs of
//! its `BTreeMap` storage, exercising the honest merge directly. Both impls satisfy the
//! contract's monotonicity guarantee, verified by the differential and monotone tests.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap};
use std::sync::Arc;

use crate::datalog::Value;
use crate::storage_v2::manifest::ManifestStore;
use crate::storage_v2::multi_shard::MultiShardStore;
use crate::storage_v2::read_snapshot::ReadSnapshot;

// ── Row types ──────────────────────────────────────────────────────

/// A node row surfaced to the engine: identity plus the columns the planner needs to
/// bind base-predicate variables (`node(X, T)` binds id + type; attr/file are available
/// for ground filters). Strings are owned because the underlying segment bytes are not
/// borrowable past the closure that reads them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NodeRow {
    /// Node identity (`BLAKE3(semantic_id)` truncated to u128).
    pub id: u128,
    /// Node type, e.g. `"FUNCTION"`, `"http:route"`.
    pub node_type: String,
    /// Entity name.
    pub name: String,
    /// Source file path (relative).
    pub file: String,
}

/// An edge row surfaced to the engine: the triple `(src, edge_type, dst)` that the
/// `edge`/`incoming` base predicates bind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EdgeRow {
    /// Source node id.
    pub src: u128,
    /// Destination node id.
    pub dst: u128,
    /// Edge type, e.g. `"CALLS"`.
    pub edge_type: String,
}

/// A generic, ordered tuple yielded by [`StorageView::sorted_run`]. The first element of
/// the variants below is the sort key in the requested [`SortOrder`]; the executor reads
/// the columns positionally. Kept as a small enum (not `Box<[Value]>`) so the merge can
/// compare keys without re-parsing a value tuple on the hot path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Row {
    /// A node tuple, ordered by [`SortOrder::NodeById`].
    Node(NodeRow),
    /// An edge tuple, ordered by [`SortOrder::EdgeSrcTypeDst`] / [`SortOrder::EdgeDstTypeSrc`].
    Edge(EdgeRow),
}

impl Row {
    /// View this row's columns as datalog [`Value`]s in canonical column order
    /// (node: id, type, name, file; edge: src, type, dst). Used by the executor to bind
    /// literal variables without the storage layer knowing the binding schema.
    pub(crate) fn as_values(&self) -> Vec<Value> {
        match self {
            Row::Node(n) => vec![
                Value::Id(n.id),
                Value::Str(n.node_type.clone()),
                Value::Str(n.name.clone()),
                Value::Str(n.file.clone()),
            ],
            Row::Edge(e) => vec![
                Value::Id(e.src),
                Value::Str(e.edge_type.clone()),
                Value::Id(e.dst),
            ],
        }
    }
}

// ── Relation + order selectors ─────────────────────────────────────

/// A base relation backed by a storage column family.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Relation {
    /// The node column family.
    Nodes,
    /// The edge column family.
    Edges,
}

/// The order in which a [`StorageView::sorted_run`] yields rows. The merge-join picks the
/// order that lines its two legs up; nodes have a single key, edges have a forward and a
/// reverse key (the latter serves `incoming()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SortOrder {
    /// Nodes ascending by id. Only valid for [`Relation::Nodes`].
    NodeById,
    /// Edges ascending by `(src, edge_type, dst)`. Only valid for [`Relation::Edges`].
    EdgeSrcTypeDst,
    /// Edges ascending by `(dst, edge_type, src)` (reverse key for `incoming()`).
    EdgeDstTypeSrc,
}

/// Order for [`StorageView::scan_edges_by_type`]: forward serves `edge()`, reverse serves
/// `incoming()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum EdgeOrder {
    /// `(src, dst)` ascending — for `edge(src, Dst, T)`.
    Forward,
    /// `(dst, src)` ascending — for `incoming(dst, Src, T)`.
    Reverse,
}

// ── Sort-key helpers ───────────────────────────────────────────────

/// Comparison key for a [`Row`] under a given [`SortOrder`]. Returns a tuple-shaped key
/// via a closure-free match so `sort_by` / the heap compare without allocation beyond the
/// borrowed `&str`.
fn row_cmp(a: &Row, b: &Row, order: SortOrder) -> Ordering {
    match order {
        SortOrder::NodeById => match (a, b) {
            (Row::Node(x), Row::Node(y)) => x.id.cmp(&y.id),
            // Mixed-variant runs never occur (a run is single-relation); order Nodes
            // before Edges deterministically so the merge stays total.
            (Row::Node(_), Row::Edge(_)) => Ordering::Less,
            (Row::Edge(_), Row::Node(_)) => Ordering::Greater,
            (Row::Edge(_), Row::Edge(_)) => Ordering::Equal,
        },
        SortOrder::EdgeSrcTypeDst => match (a, b) {
            (Row::Edge(x), Row::Edge(y)) => x
                .src
                .cmp(&y.src)
                .then_with(|| x.edge_type.cmp(&y.edge_type))
                .then_with(|| x.dst.cmp(&y.dst)),
            (Row::Edge(_), Row::Node(_)) => Ordering::Less,
            (Row::Node(_), Row::Edge(_)) => Ordering::Greater,
            (Row::Node(_), Row::Node(_)) => Ordering::Equal,
        },
        SortOrder::EdgeDstTypeSrc => match (a, b) {
            (Row::Edge(x), Row::Edge(y)) => x
                .dst
                .cmp(&y.dst)
                .then_with(|| x.edge_type.cmp(&y.edge_type))
                .then_with(|| x.src.cmp(&y.src)),
            (Row::Edge(_), Row::Node(_)) => Ordering::Less,
            (Row::Node(_), Row::Edge(_)) => Ordering::Greater,
            (Row::Node(_), Row::Node(_)) => Ordering::Equal,
        },
    }
}

// ── k-way merge primitive ──────────────────────────────────────────

/// One leg of a k-way merge: a peekable cursor over an already-sorted row source.
struct MergeLeg {
    /// Buffered rows, ascending in the run order, consumed from the front.
    rows: std::vec::IntoIter<Row>,
    /// The next row not yet emitted (the cursor head), if any.
    head: Option<Row>,
}

impl MergeLeg {
    fn new(mut rows: std::vec::IntoIter<Row>) -> Self {
        let head = rows.next();
        Self { rows, head }
    }

    /// Take the current head and advance the cursor.
    fn pop(&mut self) -> Option<Row> {
        let out = self.head.take();
        self.head = self.rows.next();
        out
    }
}

/// Heap entry ordering the legs by their head row under `order`. `BinaryHeap` is a
/// max-heap, so the comparison is reversed to pop the *smallest* head first.
struct HeapItem {
    leg: usize,
    order: SortOrder,
    head: Row,
}

impl PartialEq for HeapItem {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for HeapItem {}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse so the min head sits at the top of the max-heap; break ties by leg
        // index for a deterministic, total order (invariant I1).
        row_cmp(&self.head, &other.head, self.order)
            .then_with(|| self.leg.cmp(&other.leg))
            .reverse()
    }
}

/// An honest k-way merge over already-sorted legs, yielding rows ascending in `order`.
///
/// Each leg must be sorted in `order`; the iterator pulls the global minimum head across
/// legs on every step (binary-heap selection, O(log k) per row). This is the merge the
/// fixpoint merge-join consumes; the fixture feeds it `BTreeMap`-ordered legs and the
/// real impl uses it after ordering its snapshot rows.
pub(crate) struct KMerge {
    legs: Vec<MergeLeg>,
    heap: BinaryHeap<HeapItem>,
    order: SortOrder,
    primed: bool,
}

impl KMerge {
    /// Build a merge over `legs`, each already sorted ascending in `order`.
    fn new(legs: Vec<Vec<Row>>, order: SortOrder) -> Self {
        let legs: Vec<MergeLeg> = legs
            .into_iter()
            .map(|v| MergeLeg::new(v.into_iter()))
            .collect();
        Self {
            legs,
            heap: BinaryHeap::new(),
            order,
            primed: false,
        }
    }

    /// Seed the heap with each leg's first head. Done lazily on the first `next`.
    fn prime(&mut self) {
        for (i, leg) in self.legs.iter().enumerate() {
            if let Some(head) = leg.head.clone() {
                self.heap.push(HeapItem {
                    leg: i,
                    order: self.order,
                    head,
                });
            }
        }
        self.primed = true;
    }
}

impl Iterator for KMerge {
    type Item = Row;

    fn next(&mut self) -> Option<Row> {
        if !self.primed {
            self.prime();
        }
        let top = self.heap.pop()?;
        let leg = top.leg;
        // Emit this leg's head, advance it, and re-insert its new head.
        let emitted = self.legs[leg].pop();
        if let Some(next_head) = self.legs[leg].head.clone() {
            self.heap.push(HeapItem {
                leg,
                order: self.order,
                head: next_head,
            });
        }
        emitted
    }
}

// ── StorageView trait ──────────────────────────────────────────────

/// The ONLY access path the engine has to storage (invariant I10). Implemented over the
/// real version-pinned snapshot ([`LsmStorageView`]) and an in-memory fixture
/// ([`FixtureStorageView`], tests only). Five methods (per the locked Gate A surface):
/// `generation`, `sorted_run`, `scan_nodes_by_type`, `scan_edges_by_type`, `get_node`.
///
/// §8.3: the only permitted point lookup is [`StorageView::get_node`] on an already-bound
/// id; the fixpoint hot path uses sorted runs and typed scans exclusively.
///
/// `Sync` is a supertrait: every view is an IMMUTABLE snapshot (generation-pinned), so
/// shared cross-thread reads are safe by construction, and the executor's row-parallel
/// join loops (rayon) require `&dyn StorageView: Send`. Test views that count accesses
/// must use atomics, not `Cell`.
pub(crate) trait StorageView: Sync {
    /// Version-pinned snapshot identity. Stable for the life of the view; two reads at the
    /// same generation observe the same committed data.
    fn generation(&self) -> u64;

    /// Sorted run of a base relation in `order` — the merge-join access path. Yields rows
    /// ascending in the requested order (nodes by id; edges by `(src,type,dst)` or
    /// `(dst,type,src)`). `order` must be valid for `rel` (node order for nodes, edge
    /// orders for edges); an invalid pairing yields an empty run.
    fn sorted_run(&self, rel: Relation, order: SortOrder) -> Box<dyn Iterator<Item = Row> + '_>;

    /// Typed scan by node type — the generator for `node(X, T)`. Lazy iterator over the
    /// live nodes of type `ty` at this generation.
    fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = NodeRow> + '_>;

    /// Edges of type `ty` served as a sorted run on `order` (forward for `edge()`, reverse
    /// for `incoming()`).
    fn scan_edges_by_type(&self, ty: &str, order: EdgeOrder)
        -> Box<dyn Iterator<Item = EdgeRow> + '_>;

    /// Keyed probe: outgoing edges of a *bound* source `src` with the given `edge_type`.
    ///
    /// Backed by storage's keyed source index (snapshot-pinned), NOT a full relation scan —
    /// the access cost is proportional to `src`'s fan-out, not to the edge total. This is the
    /// access path for `edge(boundSrc, Dst, "T")` and the per-row probe an anti-join issues on
    /// its negated leg (so the anti-join is O(rows × fanout), not O(rows × edges)). A `src`
    /// with no matching outgoing edges yields an empty vec.
    fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow>;

    /// Keyed probe: incoming edges into a *bound* destination `dst` with the given `edge_type`.
    ///
    /// Backed by storage's keyed destination index (snapshot-pinned), NOT a full relation scan;
    /// the access path for `incoming(boundDst, Src, "T")` / `edge(Src, boundDst, "T")`. A `dst`
    /// with no matching incoming edges yields an empty vec.
    fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow>;

    /// Bound-id point lookup — the ONLY permitted point lookup (§8.3), for an already-bound
    /// id (attr / parent_function). FORBIDDEN inside the fixpoint hot path on unbound vars.
    fn get_node(&self, id: u128) -> Option<NodeRow>;

    /// Attribute value-generator: all nodes whose attribute `key` equals `value`.
    ///
    /// The parity twin of the query engine's `find_by_attr` reverse lookup — it backs the `attr(FreeId,
    /// "key", "val")` generator mode. The key→filter mapping matches the query engine's `attr_to_query`
    /// exactly: `name`/`file`/`type` are first-class column filters, `exported` is the
    /// boolean export filter, and any other key is a metadata-key filter. The real impl
    /// drives this through storage_v2's snapshot-pinned attr index
    /// (`find_node_ids_by_attr_at`), so it is the same index path the query engine uses — not a full scan
    /// the engine post-filters. A key/value that matches no node yields an empty vec.
    fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<NodeRow>;

    /// Raw metadata JSON of the edge `src -[edge_type]-> dst`, for an already-bound edge
    /// triple (the `edge_attr` builtin's point probe — never inside a generator).
    ///
    /// Returns `Some(json)` when the edge exists and carries non-empty metadata; `None`
    /// when the edge is absent OR carries none (`""` is storage's "no metadata" marker).
    /// The string is the stored blob verbatim — parsing/validation is the caller's concern
    /// (a non-JSON blob is the caller's tuple non-match, never this layer's error). Served
    /// through the same snapshot-pinned keyed source index as [`StorageView::edges_from`].
    /// Note `OverlayStorageView`: hypothetical delta edges carry no metadata today, so a
    /// delta-only edge yields `None`.
    fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String>;

    /// Raw metadata JSON of the node `id`, for an already-bound id (the `node_attr`
    /// builtin's point probe — never inside a generator). The node twin of
    /// [`StorageView::edge_metadata`], with the same contract:
    ///
    /// Returns `Some(json)` when the node exists and carries non-empty metadata; `None`
    /// when the node is absent OR carries none (`""` is storage's "no metadata" marker).
    /// The string is the stored blob verbatim — parsing/validation is the caller's concern
    /// (a non-JSON blob is the caller's tuple non-match, never this layer's error). Served
    /// through the same snapshot point lookup as [`StorageView::get_node`] (§8.3-permitted:
    /// the id is bound). Note `OverlayStorageView`: hypothetical delta nodes carry no
    /// metadata today, so a delta-only node yields `None`.
    fn node_metadata(&self, id: u128) -> Option<String>;

    /// BULK metadata scan: every live edge of `edge_type` at this generation that carries
    /// non-empty metadata, as `(src, dst, blob)` — exactly the triples for which
    /// [`StorageView::edge_metadata`] would return `Some(blob)`, one entry per edge key.
    ///
    /// This is the build side of the executor's build-once `edge_attr` join index (W9
    /// fix #2): ONE typed scan replaces an O(rows) sequence of per-edge keyed point
    /// probes (each of which walks the source index AND parses the blob). The contract
    /// ties it to `edge_metadata` so the fast path and the per-row probe can never
    /// disagree: for every `(s, d, b)` yielded, `edge_metadata(s, d, edge_type) ==
    /// Some(b)`; edges absent here have `None` (no metadata) at this generation.
    fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)>;
}

// ── Real impl over a version-pinned ReadSnapshot ───────────────────

/// `StorageView` over the real `storage_v2` MVCC read path.
///
/// Holds an `Arc<MultiShardStore>` and a captured [`ReadSnapshot`] (which pins the
/// manifest version for the view's lifetime, MVCC B5). All reads go through the store's
/// public `*_at` snapshot methods, which apply the version's tombstones and L0-newest-wins
/// dedup. Storage stays module-private to `derive` (I10): this type is `pub(crate)` and
/// only the trait surface is consumed by higher layers.
pub(crate) struct LsmStorageView {
    store: Arc<MultiShardStore>,
    snapshot: ReadSnapshot,
}

impl LsmStorageView {
    /// Capture a version-pinned view from a store and its manifest. The snapshot pins the
    /// current published version until this view drops.
    pub(crate) fn capture(store: Arc<MultiShardStore>, manifest: &ManifestStore) -> Self {
        let snapshot = store.snapshot(manifest);
        Self { store, snapshot }
    }

    /// Build a view from an already-captured snapshot (e.g. a clone pinned elsewhere).
    pub(crate) fn from_snapshot(store: Arc<MultiShardStore>, snapshot: ReadSnapshot) -> Self {
        Self { store, snapshot }
    }

}

// ── Shared read helpers over (store, snapshot) ─────────────────────
//
// Both the owned [`LsmStorageView`] (Arc) and the borrowing
// [`BorrowedLsmStorageView`] (router path) read through the same `*_at` snapshot
// methods. The logic lives in these free helpers so the two views never drift in
// what they surface (one source of truth for the real read path).

/// Collect a snapshot's live node rows (deduped, tombstone-filtered by the public
/// snapshot path) sorted by id.
fn snapshot_node_rows_by_id(store: &MultiShardStore, snapshot: &ReadSnapshot) -> Vec<Row> {
    let mut rows: Vec<Row> = store
        .find_nodes_at(snapshot, None, None)
        .into_iter()
        .map(|r| {
            Row::Node(NodeRow {
                id: r.id,
                node_type: r.node_type,
                name: r.name,
                file: r.file,
            })
        })
        .collect();
    rows.sort_by(|a, b| row_cmp(a, b, SortOrder::NodeById));
    rows
}

/// Collect a snapshot's live edge rows sorted in `order`.
fn snapshot_edge_rows(store: &MultiShardStore, snapshot: &ReadSnapshot, order: SortOrder) -> Vec<Row> {
    let mut rows: Vec<Row> = store
        .iter_all_edges_at(snapshot)
        .into_iter()
        .map(|r| {
            Row::Edge(EdgeRow {
                src: r.src,
                dst: r.dst,
                edge_type: r.edge_type,
            })
        })
        .collect();
    rows.sort_by(|a, b| row_cmp(a, b, order));
    rows
}

fn snapshot_sorted_run(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    rel: Relation,
    order: SortOrder,
) -> Vec<Row> {
    match (rel, order) {
        (Relation::Nodes, SortOrder::NodeById) => snapshot_node_rows_by_id(store, snapshot),
        (Relation::Edges, SortOrder::EdgeSrcTypeDst)
        | (Relation::Edges, SortOrder::EdgeDstTypeSrc) => snapshot_edge_rows(store, snapshot, order),
        // Invalid (rel, order) pairing — empty run (the planner never issues these;
        // an empty run keeps the merge-join total without a panic).
        _ => Vec::new(),
    }
}

fn snapshot_scan_nodes_by_type(store: &MultiShardStore, snapshot: &ReadSnapshot, ty: &str) -> Vec<NodeRow> {
    store
        .find_nodes_at(snapshot, Some(ty), None)
        .into_iter()
        .map(|r| NodeRow {
            id: r.id,
            node_type: r.node_type,
            name: r.name,
            file: r.file,
        })
        .collect()
}

fn snapshot_scan_edges_by_type(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    ty: &str,
    order: EdgeOrder,
) -> Vec<EdgeRow> {
    let mut rows: Vec<EdgeRow> = store
        .get_edges_by_type_at(snapshot, ty)
        .into_iter()
        .map(|r| EdgeRow {
            src: r.src,
            dst: r.dst,
            edge_type: r.edge_type,
        })
        .collect();
    match order {
        EdgeOrder::Forward => rows.sort_by(|a, b| a.src.cmp(&b.src).then_with(|| a.dst.cmp(&b.dst))),
        EdgeOrder::Reverse => rows.sort_by(|a, b| a.dst.cmp(&b.dst).then_with(|| a.src.cmp(&b.src))),
    }
    rows
}

/// Keyed outgoing-edge probe for a bound source, via the snapshot-pinned source index
/// (`get_outgoing_edges_at`) — NOT a full scan. Passes the single `edge_type` through as a
/// one-element type filter so the bloom/zone-map short-circuits apply.
fn snapshot_edges_from(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    src: u128,
    edge_type: &str,
) -> Vec<EdgeRow> {
    store
        .get_outgoing_edges_at(snapshot, src, Some(&[edge_type]))
        .into_iter()
        .map(|r| EdgeRow {
            src: r.src,
            dst: r.dst,
            edge_type: r.edge_type,
        })
        .collect()
}

/// Keyed incoming-edge probe for a bound destination, via the snapshot-pinned destination
/// index (`get_incoming_edges_at`) — NOT a full scan.
fn snapshot_edges_to(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    dst: u128,
    edge_type: &str,
) -> Vec<EdgeRow> {
    store
        .get_incoming_edges_at(snapshot, dst, Some(&[edge_type]))
        .into_iter()
        .map(|r| EdgeRow {
            src: r.src,
            dst: r.dst,
            edge_type: r.edge_type,
        })
        .collect()
}

/// Metadata blob of one bound edge triple, via the snapshot-pinned source index (the same
/// keyed probe as [`snapshot_edges_from`], filtered to the bound `dst`). Empty stored
/// metadata (`""`, storage's "none" marker) normalizes to `None`.
fn snapshot_edge_metadata(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    src: u128,
    dst: u128,
    edge_type: &str,
) -> Option<String> {
    store
        .get_outgoing_edges_at(snapshot, src, Some(&[edge_type]))
        .into_iter()
        .find(|r| r.dst == dst)
        .map(|r| r.metadata)
        .filter(|m| !m.is_empty())
}

/// Metadata blob of one bound node id, via the same snapshot point lookup as
/// [`snapshot_get_node`]. Empty stored metadata (`""`, storage's "none" marker)
/// normalizes to `None` — the node twin of [`snapshot_edge_metadata`].
fn snapshot_node_metadata(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    id: u128,
) -> Option<String> {
    store
        .get_node_at(snapshot, id)
        .map(|r| r.metadata)
        .filter(|m| !m.is_empty())
}

/// Bulk `(src, dst, blob)` metadata triples of one edge type — the typed-scan twin of
/// [`snapshot_edge_metadata`]: both read the same snapshot-pinned edge records, so an
/// edge appears here with blob `b` iff the point probe yields `Some(b)` (empty stored
/// metadata, storage's "none" marker, is filtered the same way).
fn snapshot_scan_edge_metadata(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    edge_type: &str,
) -> Vec<(u128, u128, String)> {
    store
        .get_edges_by_type_at(snapshot, edge_type)
        .into_iter()
        .filter(|r| !r.metadata.is_empty())
        .map(|r| (r.src, r.dst, r.metadata))
        .collect()
}

fn snapshot_get_node(store: &MultiShardStore, snapshot: &ReadSnapshot, id: u128) -> Option<NodeRow> {
    store.get_node_at(snapshot, id).map(|r| NodeRow {
        id: r.id,
        node_type: r.node_type,
        name: r.name,
        file: r.file,
    })
}

/// Attribute value-generator over the snapshot-pinned attr index. The key→filter mapping is
/// identical to the query engine's `attr_to_query` (`name`/`file`/`type` → first-class column filters,
/// `exported` → boolean export filter, anything else → a metadata-key filter), so the derive
/// generator hits the same `find_node_ids_by_attr_at` index path the query engine uses. Rows are resolved
/// from the matched ids through the same snapshot point lookup (`get_node_at`) and ordered by
/// id for a deterministic run.
fn snapshot_nodes_by_attr(
    store: &MultiShardStore,
    snapshot: &ReadSnapshot,
    key: &str,
    value: &str,
) -> Vec<NodeRow> {
    // Map the attr key onto the storage filter slots exactly as the query engine's `attr_to_query` does.
    let mut node_type: Option<&str> = None;
    let mut file: Option<&str> = None;
    let mut name: Option<&str> = None;
    let mut exported: Option<bool> = None;
    let mut metadata_filters: Vec<(String, String)> = Vec::new();
    match key {
        "name" => name = Some(value),
        "file" => file = Some(value),
        "type" => node_type = Some(value),
        "exported" => exported = Some(value == "true"),
        _ => metadata_filters = vec![(key.to_string(), value.to_string())],
    }

    let ids = store.find_node_ids_by_attr_at(
        snapshot,
        node_type,
        None,
        file,
        name,
        exported,
        &metadata_filters,
        false,
    );

    let mut rows: Vec<NodeRow> = ids
        .into_iter()
        .filter_map(|id| snapshot_get_node(store, snapshot, id))
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

impl StorageView for LsmStorageView {
    fn generation(&self) -> u64 {
        self.snapshot.version
    }

    fn sorted_run(&self, rel: Relation, order: SortOrder) -> Box<dyn Iterator<Item = Row> + '_> {
        let rows = snapshot_sorted_run(&self.store, &self.snapshot, rel, order);
        // Wrap the already-sorted single source in the same k-way merge primitive so the
        // real and fixture impls share one ordered-iteration mechanism.
        Box::new(KMerge::new(vec![rows], order))
    }

    fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = NodeRow> + '_> {
        Box::new(snapshot_scan_nodes_by_type(&self.store, &self.snapshot, ty).into_iter())
    }

    fn scan_edges_by_type(
        &self,
        ty: &str,
        order: EdgeOrder,
    ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
        Box::new(snapshot_scan_edges_by_type(&self.store, &self.snapshot, ty, order).into_iter())
    }

    fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
        snapshot_edges_from(&self.store, &self.snapshot, src, edge_type)
    }

    fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
        snapshot_edges_to(&self.store, &self.snapshot, dst, edge_type)
    }

    fn get_node(&self, id: u128) -> Option<NodeRow> {
        snapshot_get_node(&self.store, &self.snapshot, id)
    }

    fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<NodeRow> {
        snapshot_nodes_by_attr(&self.store, &self.snapshot, key, value)
    }

    fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
        snapshot_edge_metadata(&self.store, &self.snapshot, src, dst, edge_type)
    }

    fn node_metadata(&self, id: u128) -> Option<String> {
        snapshot_node_metadata(&self.store, &self.snapshot, id)
    }

    fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)> {
        snapshot_scan_edge_metadata(&self.store, &self.snapshot, edge_type)
    }
}

// ── Borrowing impl over a version-pinned ReadSnapshot (router path) ─

/// `StorageView` over the real `storage_v2` MVCC read path that BORROWS the store
/// instead of holding an `Arc`.
///
/// The server-side dispatch (the `RFDB_DERIVE_ENGINE` router) already holds a read lock on
/// the engine for the duration of one [`crate::derive::evaluate`] call, so it can lend
/// `&MultiShardStore` directly — no `Arc` clone is needed and the storage type stays
/// module-private to `derive` (I10). The captured [`ReadSnapshot`] pins the manifest
/// version for the view's lifetime exactly like [`LsmStorageView`]; both delegate to the
/// same `snapshot_*` helpers so they can never disagree on what the snapshot surfaces.
pub(crate) struct BorrowedLsmStorageView<'a> {
    store: &'a MultiShardStore,
    snapshot: ReadSnapshot,
}

impl<'a> BorrowedLsmStorageView<'a> {
    /// Build a borrowing view from a borrowed store and an already-captured snapshot. The
    /// snapshot pins the published version for the view's lifetime; the caller must keep
    /// the snapshot consistent with the manifest it was captured from.
    pub(crate) fn new(store: &'a MultiShardStore, snapshot: ReadSnapshot) -> Self {
        Self { store, snapshot }
    }
}

impl<'a> StorageView for BorrowedLsmStorageView<'a> {
    fn generation(&self) -> u64 {
        self.snapshot.version
    }

    fn sorted_run(&self, rel: Relation, order: SortOrder) -> Box<dyn Iterator<Item = Row> + '_> {
        let rows = snapshot_sorted_run(self.store, &self.snapshot, rel, order);
        Box::new(KMerge::new(vec![rows], order))
    }

    fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = NodeRow> + '_> {
        Box::new(snapshot_scan_nodes_by_type(self.store, &self.snapshot, ty).into_iter())
    }

    fn scan_edges_by_type(
        &self,
        ty: &str,
        order: EdgeOrder,
    ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
        Box::new(snapshot_scan_edges_by_type(self.store, &self.snapshot, ty, order).into_iter())
    }

    fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
        snapshot_edges_from(self.store, &self.snapshot, src, edge_type)
    }

    fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
        snapshot_edges_to(self.store, &self.snapshot, dst, edge_type)
    }

    fn get_node(&self, id: u128) -> Option<NodeRow> {
        snapshot_get_node(self.store, &self.snapshot, id)
    }

    fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<NodeRow> {
        snapshot_nodes_by_attr(self.store, &self.snapshot, key, value)
    }

    fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
        snapshot_edge_metadata(self.store, &self.snapshot, src, dst, edge_type)
    }

    fn node_metadata(&self, id: u128) -> Option<String> {
        snapshot_node_metadata(self.store, &self.snapshot, id)
    }

    fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)> {
        snapshot_scan_edge_metadata(self.store, &self.snapshot, edge_type)
    }
}

// ── In-memory fixture impl (tests only) ────────────────────────────

/// BTreeMap-backed `StorageView` for unit and property tests ONLY.
///
/// Mirrors the real impl's semantics on a tiny dataset so tests can assert
/// fixpoint/negation/aggregation behavior in RAM and check real-vs-fixture parity. Its
/// storage is naturally sorted (`BTreeMap`), so [`StorageView::sorted_run`] feeds the
/// [`KMerge`] genuinely-sorted legs — exercising the merge primitive directly rather than
/// a sort-then-merge. NOT a production substrate: the engine is validated on
/// [`LsmStorageView`].
#[derive(Default)]
pub(crate) struct FixtureStorageView {
    generation: u64,
    /// Nodes keyed by id (BTreeMap → ascending-by-id iteration is free).
    nodes: BTreeMap<u128, NodeRow>,
    /// Edges keyed by `(src, type, dst)` for the forward order.
    edges_fwd: BTreeMap<(u128, String, u128), EdgeRow>,
    /// Metadata blobs by edge key — a SIDE map (an [`EdgeRow`] carries no metadata column;
    /// the engine's join surface stays the bare triple). Only edges explicitly given
    /// metadata via [`FixtureStorageView::put_edge_metadata`] appear here, mirroring the
    /// real impl's "empty blob ⇒ `None`" normalization.
    edge_meta: BTreeMap<(u128, String, u128), String>,
    /// Metadata blobs by node id — the node-axis twin of `edge_meta` (a [`NodeRow`] carries
    /// no metadata column; the engine's join surface stays id/type/name/file). Only nodes
    /// explicitly given metadata via [`FixtureStorageView::put_node_metadata`] appear here.
    node_meta: BTreeMap<u128, String>,
}

impl FixtureStorageView {
    /// An empty fixture at `generation`.
    pub(crate) fn new(generation: u64) -> Self {
        Self {
            generation,
            nodes: BTreeMap::new(),
            edges_fwd: BTreeMap::new(),
            edge_meta: BTreeMap::new(),
            node_meta: BTreeMap::new(),
        }
    }

    /// Insert (or replace) a node.
    pub(crate) fn put_node(&mut self, row: NodeRow) {
        self.nodes.insert(row.id, row);
    }

    /// Insert (or replace) an edge.
    pub(crate) fn put_edge(&mut self, row: EdgeRow) {
        self.edges_fwd
            .insert((row.src, row.edge_type.clone(), row.dst), row);
    }

    /// Attach a metadata JSON blob to an (already-inserted or later-inserted) edge triple.
    /// A non-empty blob makes [`StorageView::edge_metadata`] return `Some(blob)` for the
    /// triple; an empty blob mirrors storage's "no metadata" marker (`None`).
    #[cfg(test)]
    pub(crate) fn put_edge_metadata(&mut self, src: u128, dst: u128, edge_type: &str, meta: &str) {
        if meta.is_empty() {
            self.edge_meta.remove(&(src, edge_type.to_string(), dst));
        } else {
            self.edge_meta
                .insert((src, edge_type.to_string(), dst), meta.to_string());
        }
    }

    /// Attach a metadata JSON blob to an (already-inserted or later-inserted) node id —
    /// the node-axis twin of [`FixtureStorageView::put_edge_metadata`]. A non-empty blob
    /// makes [`StorageView::node_metadata`] return `Some(blob)` for the id; an empty blob
    /// mirrors storage's "no metadata" marker (`None`).
    #[cfg(test)]
    pub(crate) fn put_node_metadata(&mut self, id: u128, meta: &str) {
        if meta.is_empty() {
            self.node_meta.remove(&id);
        } else {
            self.node_meta.insert(id, meta.to_string());
        }
    }
}

impl StorageView for FixtureStorageView {
    fn generation(&self) -> u64 {
        self.generation
    }

    fn sorted_run(&self, rel: Relation, order: SortOrder) -> Box<dyn Iterator<Item = Row> + '_> {
        let rows: Vec<Row> = match (rel, order) {
            (Relation::Nodes, SortOrder::NodeById) => {
                // BTreeMap by id → already in NodeById order.
                self.nodes.values().cloned().map(Row::Node).collect()
            }
            (Relation::Edges, SortOrder::EdgeSrcTypeDst) => {
                // Keyed by (src, type, dst) → already in EdgeSrcTypeDst order.
                self.edges_fwd.values().cloned().map(Row::Edge).collect()
            }
            (Relation::Edges, SortOrder::EdgeDstTypeSrc) => {
                let mut v: Vec<Row> =
                    self.edges_fwd.values().cloned().map(Row::Edge).collect();
                v.sort_by(|a, b| row_cmp(a, b, order));
                v
            }
            _ => Vec::new(),
        };
        Box::new(KMerge::new(vec![rows], order))
    }

    fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = NodeRow> + '_> {
        let rows: Vec<NodeRow> = self
            .nodes
            .values()
            .filter(|n| n.node_type == ty)
            .cloned()
            .collect();
        Box::new(rows.into_iter())
    }

    fn scan_edges_by_type(
        &self,
        ty: &str,
        order: EdgeOrder,
    ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
        let mut rows: Vec<EdgeRow> = self
            .edges_fwd
            .values()
            .filter(|e| e.edge_type == ty)
            .cloned()
            .collect();
        match order {
            EdgeOrder::Forward => rows.sort_by(|a, b| a.src.cmp(&b.src).then_with(|| a.dst.cmp(&b.dst))),
            EdgeOrder::Reverse => rows.sort_by(|a, b| a.dst.cmp(&b.dst).then_with(|| a.src.cmp(&b.src))),
        }
        Box::new(rows.into_iter())
    }

    fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
        self.edges_fwd
            .values()
            .filter(|e| e.src == src && e.edge_type == edge_type)
            .cloned()
            .collect()
    }

    fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
        self.edges_fwd
            .values()
            .filter(|e| e.dst == dst && e.edge_type == edge_type)
            .cloned()
            .collect()
    }

    fn get_node(&self, id: u128) -> Option<NodeRow> {
        self.nodes.get(&id).cloned()
    }

    fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<NodeRow> {
        // The fixture's `NodeRow` surface carries only the first-class columns
        // (id/type/name/file); it mirrors the real index for those keys and yields nothing
        // for keys outside that surface (e.g. metadata keys), consistent with the Gate A row
        // surface. Rows come back ascending by id (BTreeMap iteration order).
        self.nodes
            .values()
            .filter(|n| match key {
                "name" => n.name == value,
                "file" => n.file == value,
                "type" => n.node_type == value,
                _ => false,
            })
            .cloned()
            .collect()
    }

    fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
        // Only blobs explicitly attached via `put_edge_metadata` exist; an edge without one
        // (including every plain `put_edge`) is `None` — the real impl's "" normalization.
        self.edge_meta
            .get(&(src, edge_type.to_string(), dst))
            .cloned()
    }

    fn node_metadata(&self, id: u128) -> Option<String> {
        // Only blobs explicitly attached via `put_node_metadata` exist; a node without one
        // (including every plain `put_node`) is `None` — the real impl's "" normalization.
        self.node_meta.get(&id).cloned()
    }

    fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)> {
        // The side map only holds non-empty blobs (put_edge_metadata removes on ""), so
        // every entry of the requested type satisfies the `edge_metadata == Some(blob)`
        // contract directly.
        self.edge_meta
            .iter()
            .filter(|((_, ty, _), _)| ty == edge_type)
            .map(|((src, _, dst), blob)| (*src, *dst, blob.clone()))
            .collect()
    }
}

// ── Read-only hypothetical overlay (sim / what-if) ─────────────────

/// A read-only OVERLAY of a hypothetical in-memory delta on top of a base [`StorageView`] —
/// the substrate for `sim()` (what-if queries) over the REAL store WITHOUT committing.
///
/// Every read returns `base ∪ delta`. It is the missing piece that lets the incremental
/// maintenance engine run a hypothetical edit against a live `LsmStorageView`: pass the
/// overlay as the `cur_view` to `maintain_incremental` with the same delta as the
/// `BaseDelta`, and the engine computes the derived facts of the hypothetical world while
/// the committed store is never touched.
///
/// Intended for ADDITIVE hypotheticals (new nodes/edges). The delta SHOULD be disjoint from
/// the base (the caller is asking "what if I ADD this fact", and asserts it is genuinely
/// absent), so the union needs no cross-source dedup — a duplicated row would merely be
/// yielded twice, which set-semantics fact identity collapses, but the disjoint contract
/// keeps the sorted-run merge honest.
pub(crate) struct OverlayStorageView<'a> {
    base: &'a dyn StorageView,
    delta: FixtureStorageView,
}

impl<'a> OverlayStorageView<'a> {
    /// Overlay `delta` (an in-memory fixture holding only the hypothetical nodes/edges) on
    /// top of `base`. The overlay borrows `base`; `delta` is owned.
    pub(crate) fn new(base: &'a dyn StorageView, delta: FixtureStorageView) -> Self {
        Self { base, delta }
    }
}

impl<'a> StorageView for OverlayStorageView<'a> {
    fn generation(&self) -> u64 {
        // The overlay observes the same committed snapshot as `base`, plus an uncommitted
        // hypothetical; it shares the base's version identity.
        self.base.generation()
    }

    fn sorted_run(&self, rel: Relation, order: SortOrder) -> Box<dyn Iterator<Item = Row> + '_> {
        // Both legs are individually sorted in `order` (base by storage, delta by the
        // fixture's BTreeMap/sort), so a k-way merge of the two preserves the run contract.
        let base_rows: Vec<Row> = self.base.sorted_run(rel, order).collect();
        let delta_rows: Vec<Row> = self.delta.sorted_run(rel, order).collect();
        Box::new(KMerge::new(vec![base_rows, delta_rows], order))
    }

    fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = NodeRow> + '_> {
        // `scan_nodes_by_type` carries no order contract (unlike sorted_run), so a plain
        // concatenation of the two generators is sufficient.
        let mut rows: Vec<NodeRow> = self.base.scan_nodes_by_type(ty).collect();
        rows.extend(self.delta.scan_nodes_by_type(ty));
        Box::new(rows.into_iter())
    }

    fn scan_edges_by_type(
        &self,
        ty: &str,
        order: EdgeOrder,
    ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
        // This path IS a sorted run (forward/reverse), so re-sort the union to keep the
        // contract — base and delta are each sorted, the few delta rows merge cheaply.
        let mut rows: Vec<EdgeRow> = self.base.scan_edges_by_type(ty, order).collect();
        rows.extend(self.delta.scan_edges_by_type(ty, order));
        match order {
            EdgeOrder::Forward => {
                rows.sort_by(|a, b| a.src.cmp(&b.src).then_with(|| a.dst.cmp(&b.dst)))
            }
            EdgeOrder::Reverse => {
                rows.sort_by(|a, b| a.dst.cmp(&b.dst).then_with(|| a.src.cmp(&b.src)))
            }
        }
        Box::new(rows.into_iter())
    }

    fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
        let mut v = self.base.edges_from(src, edge_type);
        v.extend(self.delta.edges_from(src, edge_type));
        v
    }

    fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
        let mut v = self.base.edges_to(dst, edge_type);
        v.extend(self.delta.edges_to(dst, edge_type));
        v
    }

    fn get_node(&self, id: u128) -> Option<NodeRow> {
        // A hypothetical node shadows the base (additive sim never re-keys an existing id,
        // but prefer the delta to honour an explicit override if one is supplied).
        self.delta.get_node(id).or_else(|| self.base.get_node(id))
    }

    fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<NodeRow> {
        let mut v = self.base.nodes_by_attr(key, value);
        v.extend(self.delta.nodes_by_attr(key, value));
        v
    }

    fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
        // A committed edge's blob comes from the base; hypothetical delta edges carry no
        // metadata today (the fixture delta only gets one if a test attaches it), so a
        // delta-only edge correctly yields `None`.
        self.base
            .edge_metadata(src, dst, edge_type)
            .or_else(|| self.delta.edge_metadata(src, dst, edge_type))
    }

    fn node_metadata(&self, id: u128) -> Option<String> {
        // A committed node's blob comes from the base; hypothetical delta nodes carry no
        // metadata today (the fixture delta only gets one if a test attaches it), so a
        // delta-only node correctly yields `None`.
        self.base
            .node_metadata(id)
            .or_else(|| self.delta.node_metadata(id))
    }

    fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)> {
        // Mirror `edge_metadata`'s precedence (base first, delta only for keys the base
        // lacks) so the bulk contract stays exactly the point probe's union view.
        let mut out = self.base.scan_edge_metadata_by_type(edge_type);
        let base_keys: std::collections::HashSet<(u128, u128)> =
            out.iter().map(|(s, d, _)| (*s, *d)).collect();
        for (s, d, b) in self.delta.scan_edge_metadata_by_type(edge_type) {
            if !base_keys.contains(&(s, d)) {
                out.push((s, d, b));
            }
        }
        out
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::manifest::ManifestStore;
    use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};
    use std::collections::HashMap;

    /// Derive the canonical u128 id from a semantic id the same way the writer does.
    fn id_of(semantic_id: &str) -> u128 {
        u128::from_le_bytes(
            blake3::hash(semantic_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        )
    }

    fn node_rec(semantic_id: &str, ty: &str, name: &str, file: &str) -> NodeRecordV2 {
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id: id_of(semantic_id),
            node_type: ty.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    fn edge_rec(src: &str, dst: &str, ty: &str) -> EdgeRecordV2 {
        EdgeRecordV2 {
            src: id_of(src),
            dst: id_of(dst),
            edge_type: ty.to_string(),
            metadata: String::new(),
        }
    }

    /// A tiny dataset shared by the real-vs-fixture parity tests.
    fn tiny_nodes() -> Vec<NodeRecordV2> {
        vec![
            node_rec("a/fn1", "FUNCTION", "fn1", "a/file.js"),
            node_rec("a/fn2", "FUNCTION", "fn2", "a/file.js"),
            node_rec("b/cls1", "CLASS", "cls1", "b/file.js"),
        ]
    }

    fn tiny_edges() -> Vec<EdgeRecordV2> {
        vec![
            edge_rec("a/fn1", "a/fn2", "CALLS"),
            edge_rec("a/fn1", "b/cls1", "CONTAINS"),
            edge_rec("a/fn2", "b/cls1", "CALLS"),
        ]
    }

    /// Build a real LSM view over an ephemeral committed store holding the tiny dataset.
    fn build_real_view() -> LsmStorageView {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();
        let nodes = tiny_nodes();
        let edges = tiny_edges();
        store
            .commit_batch(
                nodes,
                edges,
                &["a/file.js".to_string(), "b/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();
        LsmStorageView::capture(Arc::new(store), &manifest)
    }

    /// Build a fixture view holding the same tiny dataset.
    fn build_fixture_view() -> FixtureStorageView {
        let mut v = FixtureStorageView::new(1);
        for n in tiny_nodes() {
            v.put_node(NodeRow {
                id: n.id,
                node_type: n.node_type,
                name: n.name,
                file: n.file,
            });
        }
        for e in tiny_edges() {
            v.put_edge(EdgeRow {
                src: e.src,
                dst: e.dst,
                edge_type: e.edge_type,
            });
        }
        v
    }

    /// Assert a row iterator is non-decreasing in `order`.
    fn assert_monotone(mut rows: impl Iterator<Item = Row>, order: SortOrder) {
        let mut prev: Option<Row> = None;
        let mut count = 0usize;
        while let Some(cur) = rows.next() {
            if let Some(p) = &prev {
                assert_ne!(
                    row_cmp(p, &cur, order),
                    Ordering::Greater,
                    "sorted_run not monotone: {:?} > {:?}",
                    p,
                    cur
                );
            }
            prev = Some(cur);
            count += 1;
        }
        assert!(count > 0, "expected a non-empty run");
    }

    #[test]
    fn kmerge_merges_sorted_legs() {
        // Two already-sorted node legs (by id) → merged run is globally sorted.
        let mk = |id: u128| {
            Row::Node(NodeRow {
                id,
                node_type: "T".into(),
                name: "n".into(),
                file: "f".into(),
            })
        };
        let leg_a = vec![mk(1), mk(4), mk(7)];
        let leg_b = vec![mk(2), mk(3), mk(8)];
        let merged: Vec<u128> = KMerge::new(vec![leg_a, leg_b], SortOrder::NodeById)
            .map(|r| match r {
                Row::Node(n) => n.id,
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(merged, vec![1, 2, 3, 4, 7, 8]);
    }

    #[test]
    fn sorted_run_nodes_is_monotone_real_and_fixture() {
        let real = build_real_view();
        assert_monotone(
            real.sorted_run(Relation::Nodes, SortOrder::NodeById),
            SortOrder::NodeById,
        );
        let fixture = build_fixture_view();
        assert_monotone(
            fixture.sorted_run(Relation::Nodes, SortOrder::NodeById),
            SortOrder::NodeById,
        );
    }

    #[test]
    fn sorted_run_edges_is_monotone_both_orders() {
        for order in [SortOrder::EdgeSrcTypeDst, SortOrder::EdgeDstTypeSrc] {
            let real = build_real_view();
            assert_monotone(real.sorted_run(Relation::Edges, order), order);
            let fixture = build_fixture_view();
            assert_monotone(fixture.sorted_run(Relation::Edges, order), order);
        }
    }

    #[test]
    fn real_and_fixture_sorted_runs_are_identical() {
        let real = build_real_view();
        let fixture = build_fixture_view();

        // Nodes by id.
        let real_nodes: Vec<Row> = real.sorted_run(Relation::Nodes, SortOrder::NodeById).collect();
        let fix_nodes: Vec<Row> = fixture
            .sorted_run(Relation::Nodes, SortOrder::NodeById)
            .collect();
        assert_eq!(real_nodes, fix_nodes, "node sorted_run parity");

        // Edges, both orders.
        for order in [SortOrder::EdgeSrcTypeDst, SortOrder::EdgeDstTypeSrc] {
            let real_edges: Vec<Row> = real.sorted_run(Relation::Edges, order).collect();
            let fix_edges: Vec<Row> = fixture.sorted_run(Relation::Edges, order).collect();
            assert_eq!(real_edges, fix_edges, "edge sorted_run parity for {:?}", order);
        }
    }

    #[test]
    fn real_and_fixture_scan_by_type_parity() {
        let real = build_real_view();
        let fixture = build_fixture_view();

        let mut real_fns: Vec<u128> = real.scan_nodes_by_type("FUNCTION").map(|n| n.id).collect();
        let mut fix_fns: Vec<u128> = fixture
            .scan_nodes_by_type("FUNCTION")
            .map(|n| n.id)
            .collect();
        real_fns.sort_unstable();
        fix_fns.sort_unstable();
        assert_eq!(real_fns, fix_fns, "scan_nodes_by_type parity");

        let real_calls: Vec<Row> = real
            .scan_edges_by_type("CALLS", EdgeOrder::Forward)
            .map(Row::Edge)
            .collect();
        let fix_calls: Vec<Row> = fixture
            .scan_edges_by_type("CALLS", EdgeOrder::Forward)
            .map(Row::Edge)
            .collect();
        assert_eq!(real_calls, fix_calls, "scan_edges_by_type parity");
        assert_eq!(real_calls.len(), 2, "two CALLS edges in the fixture");
    }

    #[test]
    fn edges_from_and_to_keyed_probe_on_fixture() {
        let fixture = build_fixture_view();
        let fn1 = id_of("a/fn1");
        let fn2 = id_of("a/fn2");
        let cls1 = id_of("b/cls1");

        // Outgoing CALLS of fn1 — exactly one (a/fn1 -CALLS-> a/fn2).
        let out_calls = fixture.edges_from(fn1, "CALLS");
        assert_eq!(out_calls.len(), 1);
        assert_eq!(out_calls[0].src, fn1);
        assert_eq!(out_calls[0].dst, fn2);
        assert_eq!(out_calls[0].edge_type, "CALLS");

        // Outgoing CONTAINS of fn1 — exactly one (a/fn1 -CONTAINS-> b/cls1); type-filtered.
        let out_contains = fixture.edges_from(fn1, "CONTAINS");
        assert_eq!(out_contains.len(), 1);
        assert_eq!(out_contains[0].dst, cls1);

        // Incoming CALLS into cls1 — exactly one (a/fn2 -CALLS-> b/cls1).
        let in_calls = fixture.edges_to(cls1, "CALLS");
        assert_eq!(in_calls.len(), 1);
        assert_eq!(in_calls[0].src, fn2);
        assert_eq!(in_calls[0].dst, cls1);

        // Non-existent endpoint → empty (a keyed miss, never a full scan).
        assert!(fixture.edges_from(0xdead_beef, "CALLS").is_empty());
        assert!(fixture.edges_to(0xdead_beef, "CALLS").is_empty());
        // Bound endpoint, wrong type → empty.
        assert!(fixture.edges_from(fn1, "NOPE").is_empty());
        // Source with no outgoing edges of that type → empty (cls1 is a sink).
        assert!(fixture.edges_from(cls1, "CALLS").is_empty());
    }

    #[test]
    fn edges_from_and_to_real_fixture_parity() {
        let real = build_real_view();
        let fixture = build_fixture_view();
        let fn1 = id_of("a/fn1");
        let cls1 = id_of("b/cls1");

        let mut real_out: Vec<(u128, u128)> =
            real.edges_from(fn1, "CALLS").into_iter().map(|e| (e.src, e.dst)).collect();
        let mut fix_out: Vec<(u128, u128)> =
            fixture.edges_from(fn1, "CALLS").into_iter().map(|e| (e.src, e.dst)).collect();
        real_out.sort_unstable();
        fix_out.sort_unstable();
        assert_eq!(real_out, fix_out, "edges_from parity");

        let mut real_in: Vec<(u128, u128)> =
            real.edges_to(cls1, "CALLS").into_iter().map(|e| (e.src, e.dst)).collect();
        let mut fix_in: Vec<(u128, u128)> =
            fixture.edges_to(cls1, "CALLS").into_iter().map(|e| (e.src, e.dst)).collect();
        real_in.sort_unstable();
        fix_in.sort_unstable();
        assert_eq!(real_in, fix_in, "edges_to parity");
    }

    #[test]
    fn get_node_bound_id_parity_and_miss() {
        let real = build_real_view();
        let fixture = build_fixture_view();
        let fn1 = id_of("a/fn1");
        assert_eq!(real.get_node(fn1), fixture.get_node(fn1));
        assert!(real.get_node(fn1).is_some());
        // Unknown bound id → None on both.
        assert!(real.get_node(0xdead_beef).is_none());
        assert!(fixture.get_node(0xdead_beef).is_none());
    }

    #[test]
    fn generation_is_stable_and_nonzero_for_committed_store() {
        let real = build_real_view();
        let g1 = real.generation();
        let g2 = real.generation();
        assert_eq!(g1, g2, "generation must be stable for the view's life");
        assert!(g1 >= 1, "a committed store publishes version >= 1");
    }

    /// `OverlayStorageView` returns `base ∪ delta` for ALL eight `StorageView` methods —
    /// including the keyed probes (`edges_from`/`edges_to`) and the `sorted_run` merge that the
    /// `depends.dl` integration path does not exercise. Base = the tiny fixture; delta = one new
    /// FUNCTION in c/file.js + one new CALLS edge `a/fn1 → c/fn3`.
    #[test]
    fn overlay_view_returns_base_union_delta_for_every_method() {
        let base = build_fixture_view();
        let mut delta = FixtureStorageView::new(1);
        delta.put_node(NodeRow {
            id: id_of("c/fn3"),
            node_type: "FUNCTION".to_string(),
            name: "fn3".to_string(),
            file: "c/file.js".to_string(),
        });
        delta.put_edge(EdgeRow {
            src: id_of("a/fn1"),
            dst: id_of("c/fn3"),
            edge_type: "CALLS".to_string(),
        });
        let overlay = OverlayStorageView::new(&base, delta);

        // generation: shares the base's version identity.
        assert_eq!(overlay.generation(), base.generation());

        // scan_nodes_by_type: base 2 FUNCTIONs + delta 1.
        let funcs: Vec<u128> = overlay.scan_nodes_by_type("FUNCTION").map(|n| n.id).collect();
        assert_eq!(funcs.len(), 3, "two base + one delta FUNCTION");
        assert!(funcs.contains(&id_of("c/fn3")) && funcs.contains(&id_of("a/fn1")));

        // scan_edges_by_type: base 2 CALLS + delta 1, and the run stays sorted (forward key).
        let calls: Vec<EdgeRow> = overlay.scan_edges_by_type("CALLS", EdgeOrder::Forward).collect();
        assert_eq!(calls.len(), 3, "two base + one delta CALLS edge");
        for w in calls.windows(2) {
            assert!((w[0].src, w[0].dst) <= (w[1].src, w[1].dst), "forward run stays sorted");
        }

        // edges_from (keyed): a/fn1 has one base CALLS + the delta CALLS.
        let from_fn1: Vec<u128> = overlay.edges_from(id_of("a/fn1"), "CALLS").iter().map(|e| e.dst).collect();
        assert_eq!(from_fn1.len(), 2, "fn1→fn2 (base) + fn1→fn3 (delta)");
        assert!(from_fn1.contains(&id_of("c/fn3")));

        // edges_to (keyed): only the delta edge points into c/fn3.
        let into_fn3 = overlay.edges_to(id_of("c/fn3"), "CALLS");
        assert_eq!(into_fn3.len(), 1);
        assert_eq!(into_fn3[0].src, id_of("a/fn1"));

        // get_node: delta shadows/extends base; a miss is None.
        assert!(overlay.get_node(id_of("c/fn3")).is_some(), "delta node visible");
        assert!(overlay.get_node(id_of("a/fn1")).is_some(), "base node visible");
        assert!(overlay.get_node(id_of("nope/x")).is_none(), "neither base nor delta");

        // nodes_by_attr: file index over base ∪ delta.
        let by_c: Vec<u128> = overlay.nodes_by_attr("file", "c/file.js").iter().map(|n| n.id).collect();
        assert_eq!(by_c, vec![id_of("c/fn3")], "the delta node by its file");
        assert_eq!(overlay.nodes_by_attr("file", "a/file.js").len(), 2, "two base nodes by file");

        // sorted_run: base 3 + delta 1 nodes, merged and monotone by id.
        let nodes: Vec<Row> = overlay.sorted_run(Relation::Nodes, SortOrder::NodeById).collect();
        assert_eq!(nodes.len(), 4, "three base + one delta node");
        assert_monotone(nodes.into_iter(), SortOrder::NodeById);
    }

    /// `edge_metadata` parity: the real LSM view surfaces a committed edge's metadata blob
    /// verbatim; the fixture mirrors it via `put_edge_metadata`; an absent edge OR an edge
    /// whose stored blob is empty (`""` = storage's "none") yields `None` on both.
    #[test]
    fn edge_metadata_real_and_fixture_parity() {
        // Real store: one edge WITH metadata, one with the empty marker.
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();
        let mut with_meta = edge_rec("a/fn1", "a/fn2", "CALLS");
        with_meta.metadata = r#"{"via":"instance_of"}"#.to_string();
        let without_meta = edge_rec("a/fn1", "b/cls1", "CONTAINS");
        store
            .commit_batch(
                tiny_nodes(),
                vec![with_meta, without_meta],
                &["a/file.js".to_string(), "b/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();
        let real = LsmStorageView::capture(Arc::new(store), &manifest);

        // Fixture twin.
        let mut fixture = build_fixture_view();
        fixture.put_edge_metadata(
            id_of("a/fn1"),
            id_of("a/fn2"),
            "CALLS",
            r#"{"via":"instance_of"}"#,
        );

        for view in [&real as &dyn StorageView, &fixture as &dyn StorageView] {
            assert_eq!(
                view.edge_metadata(id_of("a/fn1"), id_of("a/fn2"), "CALLS").as_deref(),
                Some(r#"{"via":"instance_of"}"#),
                "blob surfaced verbatim"
            );
            assert_eq!(
                view.edge_metadata(id_of("a/fn1"), id_of("b/cls1"), "CONTAINS"),
                None,
                "empty stored blob normalizes to None"
            );
            assert_eq!(
                view.edge_metadata(id_of("a/fn1"), id_of("a/fn2"), "NOPE"),
                None,
                "wrong type → no edge → None"
            );
            assert_eq!(
                view.edge_metadata(0xdead_beef, id_of("a/fn2"), "CALLS"),
                None,
                "absent edge → None"
            );
        }
    }

    /// `node_metadata` parity: the real LSM view surfaces a committed node's metadata blob
    /// verbatim; the fixture mirrors it via `put_node_metadata`; an absent node OR a node
    /// whose stored blob is empty (`""` = storage's "none") yields `None` on both.
    #[test]
    fn node_metadata_real_and_fixture_parity() {
        // Real store: one node WITH metadata, the rest with the empty marker.
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();
        let mut nodes = tiny_nodes();
        nodes[0].metadata = r#"{"line":42,"exported":true}"#.to_string();
        store
            .commit_batch(
                nodes,
                tiny_edges(),
                &["a/file.js".to_string(), "b/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();
        let real = LsmStorageView::capture(Arc::new(store), &manifest);

        // Fixture twin.
        let mut fixture = build_fixture_view();
        fixture.put_node_metadata(id_of("a/fn1"), r#"{"line":42,"exported":true}"#);

        for view in [&real as &dyn StorageView, &fixture as &dyn StorageView] {
            assert_eq!(
                view.node_metadata(id_of("a/fn1")).as_deref(),
                Some(r#"{"line":42,"exported":true}"#),
                "blob surfaced verbatim"
            );
            assert_eq!(
                view.node_metadata(id_of("a/fn2")),
                None,
                "empty stored blob normalizes to None"
            );
            assert_eq!(view.node_metadata(0xdead_beef), None, "absent node → None");
        }
    }

    /// Overlay: a base node's metadata is visible through the overlay; a delta-only
    /// (hypothetical) node carries no metadata today → `None`.
    #[test]
    fn overlay_node_metadata_base_visible_delta_none() {
        let mut base = build_fixture_view();
        base.put_node_metadata(id_of("a/fn1"), r#"{"k":"v"}"#);
        let mut delta = FixtureStorageView::new(1);
        delta.put_node(NodeRow {
            id: id_of("c/fn3"),
            node_type: "FUNCTION".to_string(),
            name: "fn3".to_string(),
            file: "c/file.js".to_string(),
        });
        let overlay = OverlayStorageView::new(&base, delta);

        assert_eq!(
            overlay.node_metadata(id_of("a/fn1")).as_deref(),
            Some(r#"{"k":"v"}"#),
            "base node's blob visible through the overlay"
        );
        assert_eq!(
            overlay.node_metadata(id_of("c/fn3")),
            None,
            "hypothetical delta node carries no metadata"
        );
    }

    /// Overlay: a base edge's metadata is visible through the overlay; a delta-only
    /// (hypothetical) edge carries no metadata today → `None`.
    #[test]
    fn overlay_edge_metadata_base_visible_delta_none() {
        let mut base = build_fixture_view();
        base.put_edge_metadata(id_of("a/fn1"), id_of("a/fn2"), "CALLS", r#"{"k":"v"}"#);
        let mut delta = FixtureStorageView::new(1);
        delta.put_edge(EdgeRow {
            src: id_of("a/fn1"),
            dst: id_of("c/fn3"),
            edge_type: "CALLS".to_string(),
        });
        let overlay = OverlayStorageView::new(&base, delta);

        assert_eq!(
            overlay.edge_metadata(id_of("a/fn1"), id_of("a/fn2"), "CALLS").as_deref(),
            Some(r#"{"k":"v"}"#),
            "base edge's blob visible through the overlay"
        );
        assert_eq!(
            overlay.edge_metadata(id_of("a/fn1"), id_of("c/fn3"), "CALLS"),
            None,
            "hypothetical delta edge carries no metadata"
        );
    }
}
