//! Incremental maintenance — Layer 9, the Gate C EXIT (spec §9.1/§9.2).
//!
//! NOT to be confused with [`super::differential`], which is the Gate A/B *test harness*
//! (the v1≡v2 and v2≡orchestrator differentials). This module is the spec's **EDB Differ +
//! increment machinery**: given two version-pinned snapshots of the base relations, compute
//! the fact-level delta and maintain each derived relation so that the maintained result is
//! byte-identical to a from-scratch evaluation of the new snapshot.
//!
//! # The delta algebra (this commit)
//!
//! A [`WeightedRelation`] is a derived relation as the executor holds its committed half:
//! `fact_id → (head tuple, provenance weight)`. A [`RelationDelta`] is the change between two
//! of them — facts whose weight is *asserted* (added with `⊕`) and facts whose weight is
//! *retracted* (removed with `⊖`). [`diff`] computes the delta turning a `prev` relation into
//! a `cur` one; the two `apply_*` functions replay a delta onto a relation.
//!
//! ## Two replays, one per maintenance algorithm — and why
//!
//! A derived fact can have *many* derivations. Retracting one input does not always remove
//! the fact, and the two semirings answer "is it still there?" differently:
//!
//! * **Counting** ([`apply_counted`], `CountTag`) — the weight *is* the derivation count, so
//!   `⊖` decrements and the fact is gone exactly when its count hits `zero()`. Sound for
//!   non-recursive views with no re-derivation pass. Requires `zero() ≠ one()`, which is why
//!   it is **not** used for `BoolTag` (whose unit carrier has `zero() == one()` — a count it
//!   cannot represent).
//! * **Set / DRed** ([`apply_set`], `BoolTag`) — membership is key-presence, retraction
//!   removes the key. For a *recursive* view this is only the over-deletion half of
//!   Delete-and-Rederive; the re-derivation pass that restores still-supported facts lands in
//!   a later commit. For the EDB-delta and non-recursive cases it is exact on its own.
//!
//! Both replays satisfy `apply(prev, diff(prev, cur)) == cur` on their tag (proven below).
//! `ConfTag` is **not** [`InvertibleTag`] (tropical `min` has no inverse), so it cannot form a
//! delta at all — `diff`/`apply_counted` do not type-check for it; such predicates fall back
//! to a from-scratch recompute, a decision the binding-table diff drives (see
//! [`super::binding`]).

use std::collections::BTreeMap;

use crate::datalog::Value;

use super::storage_glue::{Relation, SortOrder, StorageView};
use super::tag::{BoolTag, InvertibleTag, Tag};
use super::value::{fact_id, PredicateId};

/// A derived relation's committed half: `fact_id → (head tuple, provenance weight)`.
///
/// Ordered by `fact_id` so a delta and a replay are deterministic (I1) and two relations
/// compare independent of insertion order. The `fact_id` is the caller's stable identity
/// (`super::value::fact_id(pred_id, key)`); this module treats it opaquely.
pub type WeightedRelation<T> = BTreeMap<u64, (Box<[Value]>, T)>;

/// The change between two [`WeightedRelation`]s: per-fact weights asserted (`⊕` in) and
/// retracted (`⊖` out). A fact whose weight merely *changed* appears in BOTH maps (retract
/// the old weight, assert the new) — the commutative group makes `base ⊕ new ⊖ old == new`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationDelta<T> {
    /// Facts (and weights) to fold in with `⊕`.
    pub asserted: BTreeMap<u64, (Box<[Value]>, T)>,
    /// Facts (and weights) to fold out with `⊖`.
    pub retracted: BTreeMap<u64, (Box<[Value]>, T)>,
}

impl<T> Default for RelationDelta<T> {
    fn default() -> Self {
        Self {
            asserted: BTreeMap::new(),
            retracted: BTreeMap::new(),
        }
    }
}

impl<T: Clone> RelationDelta<T> {
    /// An empty delta (no change).
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the delta changes nothing.
    pub fn is_empty(&self) -> bool {
        self.asserted.is_empty() && self.retracted.is_empty()
    }

    /// Number of asserted plus retracted facts (the delta's size — the work an incremental
    /// replay does, vs. the full relation a from-scratch pass would).
    pub fn len(&self) -> usize {
        self.asserted.len() + self.retracted.len()
    }
}

/// Compute the delta that turns `prev` into `cur`: assert every fact whose weight differs
/// (its new weight) and retract it (its old weight), so a replay reconstructs `cur` exactly.
///
/// Facts identical in both are skipped (minimal delta). Requires [`InvertibleTag`] — a
/// delta is meaningless for a tag with no `⊖` (e.g. `ConfTag`), and the bound makes that a
/// compile error rather than a silent wrong answer.
pub fn diff<T: InvertibleTag + PartialEq>(
    prev: &WeightedRelation<T>,
    cur: &WeightedRelation<T>,
) -> RelationDelta<T> {
    let mut delta = RelationDelta::new();
    // Every fact in `cur`: new or weight-changed → assert the new weight (and retract the
    // old, if it existed at a different weight).
    for (&fid, (key, cw)) in cur {
        match prev.get(&fid) {
            Some((_, pw)) if pw == cw => {} // unchanged — not in the delta
            Some((_, pw)) => {
                delta.asserted.insert(fid, (key.clone(), cw.clone()));
                delta.retracted.insert(fid, (key.clone(), pw.clone()));
            }
            None => {
                delta.asserted.insert(fid, (key.clone(), cw.clone()));
            }
        }
    }
    // Facts only in `prev` → retract their whole weight.
    for (&fid, (key, pw)) in prev {
        if !cur.contains_key(&fid) {
            delta.retracted.insert(fid, (key.clone(), pw.clone()));
        }
    }
    delta
}

/// Replay a delta with **set** semantics (membership = key presence): asserted facts are
/// inserted, retracted facts are removed. The replay for `BoolTag` (and the over-deletion
/// half of DRed for recursive views). Ignores weights — for a unit carrier they are
/// degenerate.
pub fn apply_set<T: Tag>(rel: &mut WeightedRelation<T>, delta: &RelationDelta<T>) {
    for (&fid, (key, w)) in &delta.asserted {
        rel.insert(fid, (key.clone(), w.clone()));
    }
    for fid in delta.retracted.keys() {
        // A fact both asserted and retracted (a weight change) stays — the assert above wins.
        if !delta.asserted.contains_key(fid) {
            rel.remove(fid);
        }
    }
}

/// Replay a delta with **counting** semantics: `⊕` each asserted weight, `⊖` each retracted
/// weight, and drop a fact exactly when its weight reaches [`Tag::zero`]. The replay for
/// `CountTag` (the counting algorithm for non-recursive incremental maintenance).
///
/// Precondition: the tag's `zero() != one()` (a genuine count). `BoolTag` violates this (use
/// [`apply_set`] for it). Requires [`InvertibleTag`] for `⊖`.
pub fn apply_counted<T: InvertibleTag + PartialEq>(
    rel: &mut WeightedRelation<T>,
    delta: &RelationDelta<T>,
) {
    for (&fid, (key, w)) in &delta.asserted {
        let next = match rel.get(&fid) {
            Some((_, cur)) => cur.plus(w),
            None => T::zero().plus(w),
        };
        rel.insert(fid, (key.clone(), next));
    }
    for (&fid, (_, w)) in &delta.retracted {
        if let Some((key, cur)) = rel.get(&fid) {
            let next = cur.minus(w);
            if next == T::zero() {
                rel.remove(&fid);
            } else {
                let key = key.clone();
                rel.insert(fid, (key, next));
            }
        }
    }
}

// ── The EDB Differ (spec §9.2) ──────────────────────────────────────

/// Reserved predicate ids for keying BASE-relation facts in a [`BaseDelta`]. A namespace
/// distinct from the small, dense ids `assign_pred_ids` (exec.rs) hands the *derived*
/// predicates, so a base fact's `fact_id` never collides with a derived one.
pub const NODE_PRED_ID: PredicateId = u64::MAX;
/// Reserved predicate id for base edge facts (see [`NODE_PRED_ID`]).
pub const EDGE_PRED_ID: PredicateId = u64::MAX - 1;

/// The fact-level change in the BASE relations between two version-pinned snapshots: the
/// nodes and edges added/removed. Base facts are presence-only (`BoolTag`), so this is a
/// pair of set deltas — the seed the incremental fixpoint propagates to derived predicates.
///
/// A node whose *attributes* changed (same id, different name/file) is one full tuple
/// retracted and a new one asserted — exactly what a rule joining on `node.name` must see.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BaseDelta {
    /// Node tuples added (`asserted`) / removed (`retracted`).
    pub nodes: RelationDelta<BoolTag>,
    /// Edge tuples added / removed.
    pub edges: RelationDelta<BoolTag>,
}

impl BaseDelta {
    /// Whether nothing in the base relations changed between the two snapshots.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.edges.is_empty()
    }

    /// Total changed base facts (nodes + edges, asserted + retracted) — the size of the
    /// seed the incremental loop starts from, vs. the full base a recompute would re-scan.
    pub fn len(&self) -> usize {
        self.nodes.len() + self.edges.len()
    }
}

/// Diff the BASE relations of two version-pinned views: scan each view's full node and edge
/// run, build a presence-weighted relation, and set-diff them via [`diff`]. Pure over the
/// two views — the only access is the locked [`StorageView`] scan surface (I10), no write.
///
/// `prev` is the previously-materialized generation, `cur` the new one; the returned
/// [`BaseDelta`] asserts facts new in `cur` and retracts facts gone from `prev`.
// Consumed by the engine_v2 incremental `@materialize` path (Gate C EXIT, next commit) and
// fully exercised by the tests now; allow the gap only in a non-test build until then.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn diff_base(prev: &dyn StorageView, cur: &dyn StorageView) -> BaseDelta {
    BaseDelta {
        nodes: diff(
            &scan_weighted(prev, Relation::Nodes, SortOrder::NodeById),
            &scan_weighted(cur, Relation::Nodes, SortOrder::NodeById),
        ),
        edges: diff(
            &scan_weighted(prev, Relation::Edges, SortOrder::EdgeSrcTypeDst),
            &scan_weighted(cur, Relation::Edges, SortOrder::EdgeSrcTypeDst),
        ),
    }
}

/// Build a [`StorageView`] exposing ONLY the asserted base delta `ΔB` — the view the
/// incremental executor installs via `with_delta_view`, so a base leg flagged as the
/// semi-naive delta leg reads only the new base facts. Reconstructs `NodeRow`/`EdgeRow`
/// from the canonical-order value tuples (`Row::as_values`: node `[id, type, name, file]`,
/// edge `[src, type, dst]`).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn delta_view(base: &BaseDelta) -> crate::datalog2::storage_glue::FixtureStorageView {
    use crate::datalog2::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
    let mut v = FixtureStorageView::new(0);
    for (_, (vals, _)) in &base.nodes.asserted {
        if let [Value::Id(id), Value::Str(ty), Value::Str(name), Value::Str(file)] = &vals[..] {
            v.put_node(NodeRow {
                id: *id,
                node_type: ty.clone(),
                name: name.clone(),
                file: file.clone(),
            });
        }
    }
    for (_, (vals, _)) in &base.edges.asserted {
        if let [Value::Id(src), Value::Str(ty), Value::Id(dst)] = &vals[..] {
            v.put_edge(EdgeRow {
                src: *src,
                dst: *dst,
                edge_type: ty.clone(),
            });
        }
    }
    v
}

/// Materialize one base relation of a view as a presence-weighted relation keyed by the
/// canonical `fact_id` over the full tuple (so an attribute change is a distinct fact).
#[cfg_attr(not(test), allow(dead_code))]
fn scan_weighted(
    view: &dyn StorageView,
    rel: Relation,
    order: SortOrder,
) -> WeightedRelation<BoolTag> {
    let pid = match rel {
        Relation::Nodes => NODE_PRED_ID,
        Relation::Edges => EDGE_PRED_ID,
    };
    view.sorted_run(rel, order)
        .map(|row| {
            let key: Box<[Value]> = row.as_values().into_boxed_slice();
            let fid = fact_id(pid, &key);
            (fid, (key, BoolTag::present()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datalog2::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
    use crate::datalog2::tag::{BoolTag, CountTag};

    fn key(n: i64) -> Box<[Value]> {
        vec![Value::Id(n as u128)].into_boxed_slice()
    }

    // ── BoolTag (set / DRed replay) ──────────────────────────────────

    fn bool_rel(fids: &[u64]) -> WeightedRelation<BoolTag> {
        fids.iter()
            .map(|&f| (f, (key(f as i64), BoolTag::present())))
            .collect()
    }

    #[test]
    fn bool_diff_is_set_difference() {
        let prev = bool_rel(&[1, 2, 3]);
        let cur = bool_rel(&[2, 3, 4]); // -1, +4
        let d = diff(&prev, &cur);
        assert_eq!(d.asserted.keys().copied().collect::<Vec<_>>(), vec![4]);
        assert_eq!(d.retracted.keys().copied().collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn bool_apply_set_round_trips_diff() {
        let prev = bool_rel(&[1, 2, 3]);
        let cur = bool_rel(&[2, 3, 4, 5]);
        let d = diff(&prev, &cur);
        let mut maintained = prev.clone();
        apply_set(&mut maintained, &d);
        assert_eq!(maintained, cur, "apply_set(prev, diff(prev,cur)) == cur");
    }

    #[test]
    fn bool_empty_diff_when_equal() {
        let a = bool_rel(&[1, 2, 3]);
        assert!(diff(&a, &a).is_empty());
    }

    // ── CountTag (counting replay) ───────────────────────────────────

    fn count_rel(facts: &[(u64, i64)]) -> WeightedRelation<CountTag> {
        facts
            .iter()
            .map(|&(f, n)| (f, (key(f as i64), CountTag(n))))
            .collect()
    }

    #[test]
    fn count_diff_records_weight_change_as_assert_and_retract() {
        let prev = count_rel(&[(1, 3), (2, 5)]);
        let cur = count_rel(&[(1, 4), (2, 5)]); // fact 1: 3 → 4
        let d = diff(&prev, &cur);
        assert_eq!(d.asserted.get(&1).unwrap().1, CountTag(4));
        assert_eq!(d.retracted.get(&1).unwrap().1, CountTag(3));
        assert!(!d.asserted.contains_key(&2), "unchanged fact absent from delta");
    }

    #[test]
    fn count_apply_round_trips_diff() {
        let prev = count_rel(&[(1, 3), (2, 5), (3, 1)]);
        let cur = count_rel(&[(1, 4), (3, 1), (4, 9)]); // 1: 3→4, 2 removed, 4 added
        let d = diff(&prev, &cur);
        let mut maintained = prev.clone();
        apply_counted(&mut maintained, &d);
        assert_eq!(maintained, cur, "apply_counted(prev, diff(prev,cur)) == cur");
    }

    #[test]
    fn count_retract_to_zero_drops_fact() {
        // One derivation of fact 1 retracted while another remains: count 2 → 1, survives.
        let mut rel = count_rel(&[(1, 2)]);
        let mut d = RelationDelta::new();
        d.retracted.insert(1, (key(1), CountTag(1)));
        apply_counted(&mut rel, &d);
        assert_eq!(rel.get(&1).unwrap().1, CountTag(1), "still supported");
        // Retract the last derivation: count 1 → 0, fact gone (not a 0-weight ghost).
        apply_counted(&mut rel, &d);
        assert!(!rel.contains_key(&1), "count reached zero → fact dropped");
    }

    // ── EDB Differ (diff_base over two snapshots) ────────────────────

    fn node(id: u128, ty: &str, name: &str, file: &str) -> NodeRow {
        NodeRow {
            id,
            node_type: ty.into(),
            name: name.into(),
            file: file.into(),
        }
    }
    fn edge(src: u128, dst: u128, ty: &str) -> EdgeRow {
        EdgeRow {
            src,
            dst,
            edge_type: ty.into(),
        }
    }

    #[test]
    fn diff_base_detects_added_and_removed_nodes_and_edges() {
        let mut prev = FixtureStorageView::new(1);
        prev.put_node(node(1, "FUNCTION", "a", "a.rs"));
        prev.put_node(node(2, "FUNCTION", "b", "b.rs"));
        prev.put_edge(edge(1, 2, "CALLS"));

        let mut cur = FixtureStorageView::new(2);
        cur.put_node(node(1, "FUNCTION", "a", "a.rs")); // unchanged
        cur.put_node(node(3, "FUNCTION", "c", "c.rs")); // added (2 removed)
        cur.put_edge(edge(1, 3, "CALLS")); // added (1→2 removed)

        let d = diff_base(&prev, &cur);
        assert_eq!(d.nodes.asserted.len(), 1, "node 3 added");
        assert_eq!(d.nodes.retracted.len(), 1, "node 2 removed");
        assert_eq!(d.edges.asserted.len(), 1, "edge 1→3 added");
        assert_eq!(d.edges.retracted.len(), 1, "edge 1→2 removed");
        assert_eq!(d.len(), 4);
    }

    #[test]
    fn diff_base_treats_attribute_change_as_retract_plus_assert() {
        // Same node id, renamed: the full tuple changed → old retracted, new asserted, so a
        // rule joining on node.name re-derives correctly.
        let mut prev = FixtureStorageView::new(1);
        prev.put_node(node(1, "FUNCTION", "old", "a.rs"));
        let mut cur = FixtureStorageView::new(2);
        cur.put_node(node(1, "FUNCTION", "new", "a.rs"));

        let d = diff_base(&prev, &cur);
        assert_eq!(d.nodes.asserted.len(), 1, "renamed node asserted");
        assert_eq!(d.nodes.retracted.len(), 1, "old name retracted");
        assert!(d.edges.is_empty());
    }

    #[test]
    fn diff_base_empty_when_snapshots_equal() {
        let mut prev = FixtureStorageView::new(1);
        prev.put_node(node(1, "FUNCTION", "a", "a.rs"));
        prev.put_edge(edge(1, 1, "RECURSES"));
        let mut cur = FixtureStorageView::new(9); // generation differs, content identical
        cur.put_node(node(1, "FUNCTION", "a", "a.rs"));
        cur.put_edge(edge(1, 1, "RECURSES"));

        assert!(diff_base(&prev, &cur).is_empty(), "identical content → empty base delta");
    }

    #[test]
    fn count_insert_then_retract_is_identity() {
        // The group law a.plus(b).minus(b) == a, lifted to a relation.
        let base = count_rel(&[(1, 7)]);
        let mut rel = base.clone();
        let mut ins = RelationDelta::new();
        ins.asserted.insert(2, (key(2), CountTag(4)));
        apply_counted(&mut rel, &ins);
        let mut ret = RelationDelta::new();
        ret.retracted.insert(2, (key(2), CountTag(4)));
        apply_counted(&mut rel, &ret);
        assert_eq!(rel, base, "assert then retract the same weight is identity");
    }
}
