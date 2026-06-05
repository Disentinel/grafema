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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
pub(crate) trait StorageView {
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

    /// Bound-id point lookup — the ONLY permitted point lookup (§8.3), for an already-bound
    /// id (attr / parent_function). FORBIDDEN inside the fixpoint hot path on unbound vars.
    fn get_node(&self, id: u128) -> Option<NodeRow>;
}

// ── Real impl over a version-pinned ReadSnapshot ───────────────────

/// `StorageView` over the real `storage_v2` MVCC read path.
///
/// Holds an `Arc<MultiShardStore>` and a captured [`ReadSnapshot`] (which pins the
/// manifest version for the view's lifetime, MVCC B5). All reads go through the store's
/// public `*_at` snapshot methods, which apply the version's tombstones and L0-newest-wins
/// dedup. Storage stays module-private to `datalog2` (I10): this type is `pub(crate)` and
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

fn snapshot_get_node(store: &MultiShardStore, snapshot: &ReadSnapshot, id: u128) -> Option<NodeRow> {
    store.get_node_at(snapshot, id).map(|r| NodeRow {
        id: r.id,
        node_type: r.node_type,
        name: r.name,
        file: r.file,
    })
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

    fn get_node(&self, id: u128) -> Option<NodeRow> {
        snapshot_get_node(&self.store, &self.snapshot, id)
    }
}

// ── Borrowing impl over a version-pinned ReadSnapshot (router path) ─

/// `StorageView` over the real `storage_v2` MVCC read path that BORROWS the store
/// instead of holding an `Arc`.
///
/// The server-side dispatch (the `RFDB_DATALOG_V2` router) already holds a read lock on
/// the engine for the duration of one [`crate::datalog2::evaluate`] call, so it can lend
/// `&MultiShardStore` directly — no `Arc` clone is needed and the storage type stays
/// module-private to `datalog2` (I10). The captured [`ReadSnapshot`] pins the manifest
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

    fn get_node(&self, id: u128) -> Option<NodeRow> {
        snapshot_get_node(self.store, &self.snapshot, id)
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
}

impl FixtureStorageView {
    /// An empty fixture at `generation`.
    pub(crate) fn new(generation: u64) -> Self {
        Self {
            generation,
            nodes: BTreeMap::new(),
            edges_fwd: BTreeMap::new(),
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

    fn get_node(&self, id: u128) -> Option<NodeRow> {
        self.nodes.get(&id).cloned()
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
}
