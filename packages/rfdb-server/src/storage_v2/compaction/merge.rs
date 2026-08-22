//! Merge algorithms for LSM-style compaction.
//!
//! Merges multiple segments into a single sorted, deduplicated list,
//! filtering tombstoned records. Used by the compaction pipeline to
//! produce L1 segments from L0 flush segments.

use std::collections::hash_map::Entry;
use std::collections::HashMap;

use crate::error::Result;
use crate::storage_v2::compaction::tag_fold::fold_tags;
use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::shard::TombstoneSet;
use crate::storage_v2::types::{DerivedFields, EdgeRecordV2, NodeRecordV2};

/// Merge multiple node segments into a single sorted, deduplicated list.
///
/// Algorithm:
/// 1. Iterate segments from newest to oldest (caller provides order)
/// 2. Collect into HashMap by node_id (first insert wins = newest version)
/// 3. Filter tombstoned nodes
/// 4. Sort by node_id for deterministic output
///
/// Complexity: O(N log N) time, O(N) space where N = total records across all segments
pub fn merge_node_segments(
    segments: &[&NodeSegmentV2],
    tombstones: &TombstoneSet,
) -> Vec<NodeRecordV2> {
    let mut records: HashMap<u128, NodeRecordV2> = HashMap::new();

    // Insert from each segment -- first insert wins (HashMap::entry().or_insert)
    // Caller must provide segments in newest-first order
    for seg in segments {
        for record in seg.iter() {
            records.entry(record.id).or_insert(record);
        }
    }

    // Filter tombstones
    records.retain(|id, _| !tombstones.contains_node(*id));

    // Sort by node_id for deterministic, sorted output
    let mut sorted: Vec<NodeRecordV2> = records.into_values().collect();
    sorted.sort_by_key(|r| r.id);

    sorted
}

/// Merge multiple edge segments into a single sorted, deduplicated list.
///
/// Edge dedup key: (src, dst, edge_type) -- matching WriteBuffer behavior.
/// Newest version wins (first insert in newest-first segment order).
///
/// Complexity: O(M log M) time, O(M) space where M = total edges
pub fn merge_edge_segments(
    segments: &[&EdgeSegmentV2],
    tombstones: &TombstoneSet,
) -> Vec<EdgeRecordV2> {
    let mut records: HashMap<(u128, u128, String), EdgeRecordV2> = HashMap::new();

    // Insert from each segment -- first insert wins
    for seg in segments {
        for record in seg.iter() {
            let key = (record.src, record.dst, record.edge_type.clone());
            records.entry(key).or_insert(record);
        }
    }

    // Filter tombstones
    records.retain(|(src, dst, edge_type), _| !tombstones.contains_edge(*src, *dst, edge_type));

    // Sort by (src, dst, edge_type) for deterministic output
    let mut sorted: Vec<EdgeRecordV2> = records.into_values().collect();
    sorted.sort_by(|a, b| {
        a.src
            .cmp(&b.src)
            .then(a.dst.cmp(&b.dst))
            .then(a.edge_type.cmp(&b.edge_type))
    });

    sorted
}

// ── Derived (tagged) merge — compaction-⊕ rekeyed on aid (spec §3.2, P4) ──
//
// The base merges above dedup by first-insert-wins, which is correct ONLY for the
// idempotent BoolTag over the record model. When any input segment carries derived
// columns (provenance / semiring tag / tx), the coordinator routes here instead. In
// the FACT model two same-key records with different assertion identity are DIFFERENT
// ASSERTIONS (rofl-fact-model.md §3.2, normative: «ключ свёртки tag_fold — aid, то
// есть (fid, author, tick), а не fid»), so the fold key is:
//
//   * record from a v2 segment (no derived columns) → `Legacy(record_key)` — the
//     record model: newest-wins collapse, identical to the base merge under BOTH
//     merge routings (this is what keeps the projection's v2 winner-collapse
//     sha-invariant across compaction — ledger round-010-pre D8/D9);
//   * record from a v3 segment → `(record_key, assertion identity)` where the
//     assertion identity is `_source`/`_generation` from the metadata blob (the
//     §10.1 author/tick carriers, ledger D5) falling back to the ProvenanceV2
//     columns (`rule_ast_hash`, `generation`) for rule-written records.
//
// ⊕ (`fold_tags`) applies ONLY within one key — a true same-aid duplicate from a
// re-write of the same assertion. Across different aids records are BOTH kept: a
// CountTag fact asserted by two authors keeps two live assertions with separate
// weights (the §9.1/§10.5 C3 gate). Payload within one key takes newest-wins
// (first insert, segments are newest-first). Output goes through `add_derived`
// (v3), preserving the columns. Mismatched semiring_ids fold to E-FMT-002 (§9.3).

/// Assertion-identity component of the derived-merge fold key (§3.2: the fold key
/// is the aid, not the record key).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum AssertIdent {
    /// v2-segment record: the record model — newest-wins collapse per record key.
    Legacy,
    /// v3-segment record: one assertion = one (author-carrier, tick) identity.
    Assertion {
        /// `metadata["_source"]` (facts-written records; `None` for rule-written).
        source: Option<String>,
        /// `ProvenanceV2.rule_ast_hash` (rule identity for derive-written records).
        rule: u32,
        /// `metadata["_generation"]`, falling back to `ProvenanceV2.generation`.
        tick: u64,
    },
}

/// `_source` / `_generation` of a record metadata blob (the §10.1 carriers).
/// Local to the merge layer on purpose: storage must not depend on the facts
/// module (§8 rule 1) — the facts projection has its own identical reader.
fn meta_provenance(metadata: &str) -> (Option<String>, Option<u64>) {
    if metadata.is_empty() || !metadata.contains("_source") && !metadata.contains("_generation") {
        return (None, None);
    }
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(metadata)
    else {
        return (None, None);
    };
    let source = map
        .get("_source")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let generation = map.get("_generation").and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
    });
    (source, generation)
}

fn assert_ident(
    derived_segment: bool,
    metadata: &str,
    prov: &crate::storage_v2::types::ProvenanceV2,
) -> AssertIdent {
    if !derived_segment {
        return AssertIdent::Legacy;
    }
    let (source, generation) = meta_provenance(metadata);
    AssertIdent::Assertion {
        tick: generation.unwrap_or(prov.generation),
        rule: prov.rule_ast_hash,
        source,
    }
}

/// Tag-aware node merge: newest-wins payload WITHIN one assertion key, `⊕`-folded
/// tag within the key only (spec §3.2 — the fold key is the aid). Coexisting
/// assertions of one record key are ALL returned. Errors (E-FMT-00x) if a tag
/// fold is ill-typed (mixed/unknown/corrupt semiring) — never a silent mis-fold (I5).
pub fn merge_node_segments_derived(
    segments: &[&NodeSegmentV2],
    tombstones: &TombstoneSet,
) -> Result<Vec<(NodeRecordV2, DerivedFields)>> {
    let mut records: HashMap<(u128, AssertIdent), (NodeRecordV2, DerivedFields)> = HashMap::new();

    for seg in segments {
        let derived = seg.has_derived_columns();
        for i in seg.iter_indices() {
            let record = seg.get_record(i);
            let id = record.id;
            let fields = DerivedFields {
                provenance: seg.provenance(i),
                tag: seg.tag(i)?,
                tx_created: seg.tx_created(i),
                tx_invalidated: seg.tx_invalidated(i),
            };
            let ident = assert_ident(derived, &record.metadata, &fields.provenance);
            match records.entry((id, ident)) {
                Entry::Vacant(e) => {
                    e.insert((record, fields));
                }
                Entry::Occupied(mut e) => {
                    // Same assertion key re-written: keep the newer payload
                    // (already present = newest-first); ⊕-fold the tag.
                    let folded = fold_tags(&e.get().1.tag, &fields.tag)?;
                    e.get_mut().1.tag = folded;
                }
            }
        }
    }

    records.retain(|(id, _), _| !tombstones.contains_node(*id));
    let mut sorted: Vec<((u128, AssertIdent), (NodeRecordV2, DerivedFields))> =
        records.into_iter().collect();
    // Deterministic output: record key asc, then tick desc (newest assertion
    // first — the §2.3 storage-order winner stays deterministic), then identity.
    sorted.sort_by(|((ida, ka), _), ((idb, kb), _)| {
        ida.cmp(idb)
            .then_with(|| ident_sort_key(kb).cmp(&ident_sort_key(ka)))
    });
    Ok(sorted.into_iter().map(|(_, v)| v).collect())
}

/// Tag-aware edge merge: same §3.2 aid-keyed fold; edge record key is
/// `(src, dst, edge_type)`, matching [`merge_edge_segments`].
pub fn merge_edge_segments_derived(
    segments: &[&EdgeSegmentV2],
    tombstones: &TombstoneSet,
) -> Result<Vec<(EdgeRecordV2, DerivedFields)>> {
    type EdgeKey = (u128, u128, String);
    let mut records: HashMap<(EdgeKey, AssertIdent), (EdgeRecordV2, DerivedFields)> =
        HashMap::new();

    for seg in segments {
        let derived = seg.has_derived_columns();
        for i in seg.iter_indices() {
            let record = seg.get_record(i);
            let key = (record.src, record.dst, record.edge_type.clone());
            let fields = DerivedFields {
                provenance: seg.provenance(i),
                tag: seg.tag(i)?,
                tx_created: seg.tx_created(i),
                tx_invalidated: seg.tx_invalidated(i),
            };
            let ident = assert_ident(derived, &record.metadata, &fields.provenance);
            match records.entry((key, ident)) {
                Entry::Vacant(e) => {
                    e.insert((record, fields));
                }
                Entry::Occupied(mut e) => {
                    let folded = fold_tags(&e.get().1.tag, &fields.tag)?;
                    e.get_mut().1.tag = folded;
                }
            }
        }
    }

    records
        .retain(|((src, dst, edge_type), _), _| !tombstones.contains_edge(*src, *dst, edge_type));
    let mut sorted: Vec<((EdgeKey, AssertIdent), (EdgeRecordV2, DerivedFields))> =
        records.into_iter().collect();
    sorted.sort_by(|((ka, ia), _), ((kb, ib), _)| {
        ka.cmp(kb)
            .then_with(|| ident_sort_key(ib).cmp(&ident_sort_key(ia)))
    });
    Ok(sorted.into_iter().map(|(_, v)| v).collect())
}

/// Sort key of an assertion identity within one record key: tick-major so the
/// newest assertion's record lands first (compared DESC by the callers).
fn ident_sort_key(k: &AssertIdent) -> (u64, u32, Option<&String>, bool) {
    match k {
        AssertIdent::Legacy => (0, 0, None, false),
        AssertIdent::Assertion { source, rule, tick } => (*tick, *rule, source.as_ref(), true),
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::Arc;

    use super::*;
    use crate::derive::tag::CountTag;
    use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
    use crate::storage_v2::types::{
        EdgeRecordV2, NodeRecordV2, ProvenanceV2, TagV2, COUNTTAG_SEMIRING_ID, TX_OPEN,
    };
    use crate::storage_v2::writer::{EdgeSegmentWriter, NodeSegmentWriter};

    // ── Test Helpers ───────────────────────────────────────────────

    fn make_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id,
            node_type: node_type.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    fn make_edge(src_id: &str, dst_id: &str, edge_type: &str) -> EdgeRecordV2 {
        let src = u128::from_le_bytes(
            blake3::hash(src_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        let dst = u128::from_le_bytes(
            blake3::hash(dst_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        EdgeRecordV2 {
            src,
            dst,
            edge_type: edge_type.to_string(),
            metadata: String::new(),
        }
    }

    fn make_test_node_segment(records: Vec<NodeRecordV2>) -> NodeSegmentV2 {
        let mut writer = NodeSegmentWriter::new();
        for r in records {
            writer.add(r);
        }
        let mut buf = Cursor::new(Vec::new());
        writer.finish(&mut buf).unwrap();
        NodeSegmentV2::from_bytes(&buf.into_inner()).unwrap()
    }

    fn make_test_edge_segment(records: Vec<EdgeRecordV2>) -> EdgeSegmentV2 {
        let mut writer = EdgeSegmentWriter::new();
        for r in records {
            writer.add(r);
        }
        let mut buf = Cursor::new(Vec::new());
        writer.finish(&mut buf).unwrap();
        EdgeSegmentV2::from_bytes(&buf.into_inner()).unwrap()
    }

    // ── Node Merge Tests ──────────────────────────────────────────

    #[test]
    fn test_merge_empty_segments() {
        let tombstones = TombstoneSet::new();
        let result = merge_node_segments(&[], &tombstones);
        assert!(result.is_empty());
    }

    #[test]
    fn test_merge_single_segment() {
        let n1 = make_node("b_node", "FUNCTION", "b", "file.rs");
        let n2 = make_node("a_node", "CLASS", "a", "file.rs");
        let seg = make_test_node_segment(vec![n1.clone(), n2.clone()]);

        let tombstones = TombstoneSet::new();
        let result = merge_node_segments(&[&seg], &tombstones);

        assert_eq!(result.len(), 2);
        // Output must be sorted by node_id
        assert!(result[0].id < result[1].id);
        // Both records present
        let ids: Vec<u128> = result.iter().map(|r| r.id).collect();
        assert!(ids.contains(&n1.id));
        assert!(ids.contains(&n2.id));
    }

    #[test]
    fn test_merge_dedup_nodes() {
        // Older segment has node with node_type "FUNCTION"
        let old_node = make_node("shared_id", "FUNCTION", "old_name", "old.rs");
        let old_seg = make_test_node_segment(vec![old_node.clone()]);

        // Newer segment has same node with node_type "METHOD"
        let mut new_node = make_node("shared_id", "METHOD", "new_name", "new.rs");
        new_node.content_hash = 42;
        let new_seg = make_test_node_segment(vec![new_node.clone()]);

        let tombstones = TombstoneSet::new();
        // Newest first
        let result = merge_node_segments(&[&new_seg, &old_seg], &tombstones);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].node_type, "METHOD");
        assert_eq!(result[0].name, "new_name");
        assert_eq!(result[0].file, "new.rs");
        assert_eq!(result[0].content_hash, 42);
    }

    #[test]
    fn test_merge_tombstone_filtering() {
        let n1 = make_node("keep_me", "FUNCTION", "keep", "file.rs");
        let n2 = make_node("delete_me", "CLASS", "delete", "file.rs");
        let n3 = make_node("also_keep", "FUNCTION", "also", "file.rs");
        let seg = make_test_node_segment(vec![n1.clone(), n2.clone(), n3.clone()]);

        let mut tombstones = TombstoneSet::new();
        tombstones.add_nodes(vec![n2.id]);

        let result = merge_node_segments(&[&seg], &tombstones);

        assert_eq!(result.len(), 2);
        let ids: Vec<u128> = result.iter().map(|r| r.id).collect();
        assert!(ids.contains(&n1.id));
        assert!(ids.contains(&n3.id));
        assert!(!ids.contains(&n2.id));
    }

    #[test]
    fn test_merge_sorted_output() {
        let nodes: Vec<NodeRecordV2> = (0..10)
            .map(|i| make_node(&format!("node_{}", i), "FUNCTION", "fn", "file.rs"))
            .collect();
        let seg = make_test_node_segment(nodes);

        let tombstones = TombstoneSet::new();
        let result = merge_node_segments(&[&seg], &tombstones);

        assert_eq!(result.len(), 10);
        for i in 1..result.len() {
            assert!(
                result[i - 1].id < result[i].id,
                "output not sorted at index {}: {} >= {}",
                i,
                result[i - 1].id,
                result[i].id
            );
        }
    }

    // ── Edge Merge Tests ──────────────────────────────────────────

    #[test]
    fn test_merge_edge_dedup() {
        // Older segment: edge with empty metadata
        let old_edge = make_edge("src_a", "dst_b", "CALLS");
        let old_seg = make_test_edge_segment(vec![old_edge.clone()]);

        // Newer segment: same edge key with metadata
        let mut new_edge = make_edge("src_a", "dst_b", "CALLS");
        new_edge.metadata = r#"{"weight": 5}"#.to_string();
        let new_seg = make_test_edge_segment(vec![new_edge.clone()]);

        let tombstones = TombstoneSet::new();
        // Newest first
        let result = merge_edge_segments(&[&new_seg, &old_seg], &tombstones);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].metadata, r#"{"weight": 5}"#);
    }

    #[test]
    fn test_merge_edge_tombstones() {
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src2", "dst2", "IMPORTS_FROM");
        let seg = make_test_edge_segment(vec![e1.clone(), e2.clone()]);

        let mut tombstones = TombstoneSet::new();
        tombstones.add_edges(vec![(e1.src, e1.dst, Arc::from("CALLS"))]);

        let result = merge_edge_segments(&[&seg], &tombstones);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].edge_type, "IMPORTS_FROM");
    }

    // ── Derived (tagged) merge: compaction-⊕ ───────────────────────

    fn count_fields(n: i64, gen: u64) -> DerivedFields {
        DerivedFields {
            provenance: ProvenanceV2 { rule_ast_hash: 7, generation: gen },
            tag: TagV2 {
                semiring_id: COUNTTAG_SEMIRING_ID,
                bytes: CountTag(n).to_le_bytes(),
            },
            tx_created: gen,
            tx_invalidated: TX_OPEN,
        }
    }

    fn make_derived_node_segment(items: Vec<(NodeRecordV2, DerivedFields)>) -> NodeSegmentV2 {
        let mut w = NodeSegmentWriter::new();
        for (r, f) in items {
            w.add_derived(r, f);
        }
        let mut buf = Cursor::new(Vec::new());
        w.finish(&mut buf).unwrap();
        NodeSegmentV2::from_bytes(&buf.into_inner()).unwrap()
    }

    fn make_derived_edge_segment(items: Vec<(EdgeRecordV2, DerivedFields)>) -> EdgeSegmentV2 {
        let mut w = EdgeSegmentWriter::new();
        for (r, f) in items {
            w.add_derived(r, f);
        }
        let mut buf = Cursor::new(Vec::new());
        w.finish(&mut buf).unwrap();
        EdgeSegmentV2::from_bytes(&buf.into_inner()).unwrap()
    }

    /// The I10 evidence test with a NON-Bool fixture, REKEYED per §3.2 (ledger
    /// round-010-pre D9a): the same node id in two derived segments with
    /// DIFFERENT assertion identities (generations 1 and 2 = different ticks =
    /// different aids) is TWO assertions — compaction must keep BOTH records
    /// with their separate tags, never fold across aids. ⊕ still applies
    /// WITHIN one aid: a same-identity duplicate genuinely folds (checked in
    /// [`derived_merge_folds_within_one_aid`]).
    #[test]
    fn derived_merge_keeps_distinct_aids_not_folds() {
        let node = make_node("shared", "DERIVED", "n", "f.rs");
        let new_seg = make_derived_node_segment(vec![(node.clone(), count_fields(5, 2))]);
        let old_seg = make_derived_node_segment(vec![(node.clone(), count_fields(3, 1))]);

        let tomb = TombstoneSet::new();
        let merged = merge_node_segments_derived(&[&new_seg, &old_seg], &tomb).unwrap();

        assert_eq!(merged.len(), 2, "two aids → two surviving records");
        // Newest assertion first (tick-desc within one record key).
        assert_eq!(merged[0].0.id, node.id);
        assert_eq!(merged[1].0.id, node.id);
        assert_eq!(
            CountTag::from_le_bytes(&merged[0].1.tag.bytes),
            Some(CountTag(5)),
            "newest aid keeps ITS weight — no cross-aid fold"
        );
        assert_eq!(merged[0].1.provenance.generation, 2);
        assert_eq!(
            CountTag::from_le_bytes(&merged[1].1.tag.bytes),
            Some(CountTag(3)),
            "older aid keeps ITS weight"
        );
        assert_eq!(merged[1].1.provenance.generation, 1);
    }

    /// ⊕ WITHIN one aid: the same assertion identity re-written in two segments
    /// is a true duplicate — its tags fold (Count sums), one record survives.
    #[test]
    fn derived_merge_folds_within_one_aid() {
        let node = make_node("shared", "DERIVED", "n", "f.rs");
        let new_seg = make_derived_node_segment(vec![(node.clone(), count_fields(5, 2))]);
        let dup_seg = make_derived_node_segment(vec![(node.clone(), count_fields(3, 2))]);

        let merged =
            merge_node_segments_derived(&[&new_seg, &dup_seg], &TombstoneSet::new()).unwrap();
        assert_eq!(merged.len(), 1, "one aid → one record");
        assert_eq!(
            CountTag::from_le_bytes(&merged[0].1.tag.bytes),
            Some(CountTag(8)),
            "3 ⊕ 5 = 8 within the aid"
        );
    }

    /// The full compaction path round-trips: aid-keyed merge → `add_derived` →
    /// re-read keeps BOTH assertions' records and the v3 derived columns (the
    /// base path would have stripped them).
    #[test]
    fn derived_merge_round_trips_through_writer() {
        let node = make_node("shared", "DERIVED", "n", "f.rs");
        let a = make_derived_node_segment(vec![(node.clone(), count_fields(2, 1))]);
        let b = make_derived_node_segment(vec![(node.clone(), count_fields(6, 2))]);
        let merged = merge_node_segments_derived(&[&b, &a], &TombstoneSet::new()).unwrap();

        let out = make_derived_node_segment(merged);
        assert!(out.has_derived_columns(), "compacted derived segment stays v3");
        assert_eq!(out.record_count(), 2, "both aids survive the round-trip");
        let weights: Vec<i64> = (0..2)
            .map(|i| CountTag::from_le_bytes(&out.tag(i).unwrap().bytes).unwrap().0)
            .collect();
        assert_eq!(weights, vec![6, 2], "newest-first, separate weights");
    }

    /// Edge variant: same `(src,dst,type)` key, two assertion identities → both
    /// records survive with their own weights (metadata-borne `_source`
    /// identities — the facts write path).
    #[test]
    fn derived_edge_merge_keeps_distinct_authors() {
        let mut e1 = make_edge("s", "d", "DEPENDS_ON");
        e1.metadata = r#"{"_source":"alice","_generation":2}"#.to_string();
        let mut e2 = make_edge("s", "d", "DEPENDS_ON");
        e2.metadata = r#"{"_source":"bob","_generation":2}"#.to_string();
        let new_seg = make_derived_edge_segment(vec![(e1.clone(), count_fields(4, 2))]);
        let old_seg = make_derived_edge_segment(vec![(e2.clone(), count_fields(1, 2))]);
        let merged =
            merge_edge_segments_derived(&[&new_seg, &old_seg], &TombstoneSet::new()).unwrap();
        assert_eq!(merged.len(), 2, "two authors → two records");
        let mut weights: Vec<i64> = merged
            .iter()
            .map(|(_, f)| CountTag::from_le_bytes(&f.tag.bytes).unwrap().0)
            .collect();
        weights.sort_unstable();
        assert_eq!(weights, vec![1, 4], "separate weights, no cross-author fold");
    }

    /// v2-origin records inside a MIXED derived merge keep the record model:
    /// newest-wins collapse per record key (`Legacy` fold key), identical to
    /// the base merge — the projection's v2 winner-collapse stays sha-invariant
    /// across compaction (ledger round-010-pre D8/D9).
    #[test]
    fn derived_merge_collapses_v2_records_newest_wins() {
        // v2 (base-format) segments: same id, two versions.
        let old_node = make_node("shared_id", "FUNCTION", "old_name", "old.rs");
        let old_seg = make_test_node_segment(vec![old_node.clone()]);
        let mut new_node = make_node("shared_id", "METHOD", "new_name", "new.rs");
        new_node.content_hash = 42;
        let new_seg = make_test_node_segment(vec![new_node.clone()]);
        // A derived segment for an UNRELATED id routes the merge derived-wards.
        let other = make_node("other", "DERIVED", "o", "f.rs");
        let derived_seg = make_derived_node_segment(vec![(other.clone(), count_fields(1, 1))]);

        let merged = merge_node_segments_derived(
            &[&derived_seg, &new_seg, &old_seg],
            &TombstoneSet::new(),
        )
        .unwrap();
        assert_eq!(merged.len(), 2, "v2 duplicate collapsed + the derived record");
        let dup = merged.iter().find(|(r, _)| r.id == new_node.id).unwrap();
        assert_eq!(dup.0.node_type, "METHOD", "newest v2 version wins");
        assert_eq!(dup.0.content_hash, 42);
    }

    /// Folding two DIFFERENT-key derived facts never collides — distinct counts survive.
    #[test]
    fn derived_merge_distinct_keys_are_independent() {
        let n1 = make_node("a", "DERIVED", "a", "f.rs");
        let n2 = make_node("b", "DERIVED", "b", "f.rs");
        let seg = make_derived_node_segment(vec![
            (n1.clone(), count_fields(3, 1)),
            (n2.clone(), count_fields(9, 1)),
        ]);
        let merged = merge_node_segments_derived(&[&seg], &TombstoneSet::new()).unwrap();
        assert_eq!(merged.len(), 2);
        let by_id: std::collections::HashMap<u128, i64> = merged
            .iter()
            .map(|(r, f)| (r.id, CountTag::from_le_bytes(&f.tag.bytes).unwrap().0))
            .collect();
        assert_eq!(by_id[&n1.id], 3);
        assert_eq!(by_id[&n2.id], 9);
    }

    #[test]
    fn test_merge_edge_different_types_preserved() {
        // Same src/dst but different edge types -> both kept
        let e1 = make_edge("src_x", "dst_y", "CALLS");
        let e2 = make_edge("src_x", "dst_y", "IMPORTS_FROM");
        let seg = make_test_edge_segment(vec![e1.clone(), e2.clone()]);

        let tombstones = TombstoneSet::new();
        let result = merge_edge_segments(&[&seg], &tombstones);

        assert_eq!(result.len(), 2);
        let types: Vec<&str> = result.iter().map(|e| e.edge_type.as_str()).collect();
        assert!(types.contains(&"CALLS"));
        assert!(types.contains(&"IMPORTS_FROM"));
    }
}
