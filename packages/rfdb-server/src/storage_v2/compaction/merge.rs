//! Merge algorithms for LSM-style compaction.
//!
//! Merges multiple segments into a single sorted, deduplicated list,
//! filtering tombstoned records. Used by the compaction pipeline to
//! produce L1 segments from L0 flush segments.

use std::collections::HashMap;

use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::shard::TombstoneSet;
use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};

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

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
    use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};
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
        tombstones.add_edges(vec![(e1.src, e1.dst, "CALLS".to_string())]);

        let result = merge_edge_segments(&[&seg], &tombstones);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].edge_type, "IMPORTS_FROM");
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
