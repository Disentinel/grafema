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

use super::tag::{InvertibleTag, Tag};

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

#[cfg(test)]
mod tests {
    use super::*;
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
