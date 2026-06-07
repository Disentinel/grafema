//! Compaction-⊕: the per-key tag fold (spec §8.2).
//!
//! When compaction merges two records with the SAME fact key (node id /
//! `(src,dst,type)`), their provenance tags must be combined with the semiring `⊕`
//! (`plus`), NOT deduplicated — deduplication is only correct for the idempotent
//! `BoolTag` (set semantics). For `CountTag` two derivations of one fact must SUM;
//! for `ConfTag` the most-confident wins (`min`). This module is the single point
//! where the byte-level segment tag (`TagV2`) is bridged to the typed semiring
//! algebra in [`crate::datalog2::tag`], folded, and re-encoded.
//!
//! Invariants:
//! * **I10** (compaction output equals an explicit fold on fixtures): the fold here
//!   delegates to `Tag::plus`, the same operator the executor folds with, so a
//!   compacted segment carries exactly the weight a from-scratch evaluation would.
//! * **§9.3** (mixed `semiring_id` segments unmergeable by construction): folding two
//!   tags of one key that disagree on `semiring_id` is a binding change — a typed
//!   `E-FMT-002` error, never a silent cross-semiring fold.
//! * **I5 / I11**: an unknown id is `E-FMT-001`, a corrupt payload `E-FMT-003` — never
//!   a silent default.
//!
//! `BoolTag` folds to `bool_one()` (degenerate: idempotent dedup), so the base path is
//! unchanged; the Count/Conf arms are exercised by the unit tests below and become
//! load-bearing the moment a non-Bool semiring is materialized.

use crate::datalog2::tag::{ConfTag, CountTag, Tag};
use crate::error::{GraphError, Result};
use crate::storage_v2::types::{
    TagV2, BOOLTAG_SEMIRING_ID, CONFTAG_SEMIRING_ID, COUNTTAG_SEMIRING_ID,
};

/// Fold two per-record tags of the SAME fact key with the semiring `⊕` (`plus`).
///
/// Both tags must carry the same `semiring_id` (they are the same predicate by
/// construction); a mismatch is `E-FMT-002` (§9.3 unmergeable). The result is the
/// canonical re-encoding of `a ⊕ b` under that semiring.
pub fn fold_tags(a: &TagV2, b: &TagV2) -> Result<TagV2> {
    if a.semiring_id != b.semiring_id {
        return Err(GraphError::MixedSemiringId {
            a: a.semiring_id,
            b: b.semiring_id,
        });
    }
    match a.semiring_id {
        // BoolTag: ⊕ is the constant on () — set union / idempotent dedup.
        BOOLTAG_SEMIRING_ID => Ok(TagV2::bool_one()),
        COUNTTAG_SEMIRING_ID => {
            let x = decode_count(a)?;
            let y = decode_count(b)?;
            Ok(TagV2 {
                semiring_id: COUNTTAG_SEMIRING_ID,
                bytes: x.plus(&y).to_le_bytes(),
            })
        }
        CONFTAG_SEMIRING_ID => {
            let x = decode_conf(a)?;
            let y = decode_conf(b)?;
            Ok(TagV2 {
                semiring_id: CONFTAG_SEMIRING_ID,
                bytes: x.plus(&y).to_le_bytes(),
            })
        }
        other => Err(GraphError::UnknownSemiringId(other)),
    }
}

fn decode_count(t: &TagV2) -> Result<CountTag> {
    CountTag::from_le_bytes(&t.bytes).ok_or_else(|| GraphError::MalformedTag {
        semiring_id: t.semiring_id,
        detail: format!("expected 8 bytes for CountTag, got {}", t.bytes.len()),
    })
}

fn decode_conf(t: &TagV2) -> Result<ConfTag> {
    ConfTag::from_le_bytes(&t.bytes).ok_or_else(|| GraphError::MalformedTag {
        semiring_id: t.semiring_id,
        detail: format!("expected 4 bytes for ConfTag, got {}", t.bytes.len()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(n: i64) -> TagV2 {
        TagV2 {
            semiring_id: COUNTTAG_SEMIRING_ID,
            bytes: CountTag(n).to_le_bytes(),
        }
    }
    fn conf(n: u32) -> TagV2 {
        TagV2 {
            semiring_id: CONFTAG_SEMIRING_ID,
            bytes: ConfTag(n).to_le_bytes(),
        }
    }

    #[test]
    fn bool_fold_is_idempotent_dedup() {
        let r = fold_tags(&TagV2::bool_one(), &TagV2::bool_one()).unwrap();
        assert_eq!(r, TagV2::bool_one(), "BoolTag ⊕ is set union (dedup)");
    }

    /// The load-bearing test the spec warns about: a BoolTag-only check would pass even
    /// with a broken fold, so we assert CountTag genuinely SUMS (3 ⊕ 5 = 8 ≠ dedup-to-one).
    #[test]
    fn count_fold_sums_not_dedups() {
        let r = fold_tags(&count(3), &count(5)).unwrap();
        assert_eq!(CountTag::from_le_bytes(&r.bytes), Some(CountTag(8)));
        // A dedup (first-wins) would have produced 3 or 5, never 8.
        assert_ne!(CountTag::from_le_bytes(&r.bytes), Some(CountTag(3)));
        // Folding a fact with itself doubles its count — the non-idempotence that bans
        // CountTag from recursion (I4) and drives incremental maintenance.
        let twice = fold_tags(&count(4), &count(4)).unwrap();
        assert_eq!(CountTag::from_le_bytes(&twice.bytes), Some(CountTag(8)));
    }

    #[test]
    fn conf_fold_takes_min() {
        let r = fold_tags(&conf(5), &conf(8)).unwrap();
        assert_eq!(ConfTag::from_le_bytes(&r.bytes), Some(ConfTag(5)), "best (min neg-log) wins");
        // Idempotent: min(x,x) = x.
        let same = fold_tags(&conf(7), &conf(7)).unwrap();
        assert_eq!(ConfTag::from_le_bytes(&same.bytes), Some(ConfTag(7)));
    }

    #[test]
    fn mixed_semiring_is_e_fmt_002() {
        let err = fold_tags(&count(1), &conf(1)).unwrap_err();
        assert_eq!(err.code(), "E-FMT-002");
        assert!(matches!(err, GraphError::MixedSemiringId { .. }));
    }

    #[test]
    fn unknown_semiring_is_e_fmt_001() {
        let weird = TagV2 { semiring_id: 999, bytes: vec![] };
        let err = fold_tags(&weird, &weird).unwrap_err();
        assert_eq!(err.code(), "E-FMT-001");
    }

    #[test]
    fn malformed_payload_is_e_fmt_003() {
        let bad = TagV2 { semiring_id: COUNTTAG_SEMIRING_ID, bytes: vec![1, 2, 3] };
        let err = fold_tags(&bad, &count(1)).unwrap_err();
        assert_eq!(err.code(), "E-FMT-003");
    }
}
