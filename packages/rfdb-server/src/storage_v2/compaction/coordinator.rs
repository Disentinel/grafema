//! Compaction coordinator for LSM-style background compaction.
//!
//! Decides when a shard needs compaction and executes the merge:
//! 1. `should_compact()` — checks L0 segment count against threshold
//! 2. `compact_shard()` — merges L0 + existing L1 into new L1 segment
//!
//! The coordinator does NOT own Shard or ManifestStore. It receives
//! references to segment data, performs the merge, and returns the
//! merged records + metadata. The caller (MultiShardStore) handles
//! the manifest commit and shard state swap.

use std::io::Cursor;

use crate::error::Result;
use crate::storage_v2::compaction::merge::{merge_edge_segments, merge_node_segments};
use crate::storage_v2::compaction::types::CompactionConfig;
use crate::storage_v2::manifest::SegmentDescriptor;
use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::shard::Shard;
use crate::storage_v2::types::{SegmentMeta, SegmentType};
use crate::storage_v2::writer::{EdgeSegmentWriter, NodeSegmentWriter};

// ── Policy ──────────────────────────────────────────────────────────

/// Check if a shard should be compacted based on L0 segment count.
///
/// Returns true when the total L0 segments (nodes + edges) >= threshold.
/// Typical threshold: 4 (default in CompactionConfig).
///
/// Complexity: O(1)
pub fn should_compact(shard: &Shard, config: &CompactionConfig) -> bool {
    let total_l0 = shard.l0_node_segment_count() + shard.l0_edge_segment_count();
    total_l0 >= config.segment_threshold
}

// ── Compaction Result ───────────────────────────────────────────────

/// Result of compacting a single shard.
///
/// Contains the merged segment data (in-memory bytes) and metadata.
/// The caller writes these to disk and updates the manifest.
pub struct ShardCompactionResult {
    /// Merged node segment bytes (None if no nodes)
    pub node_segment_bytes: Option<Vec<u8>>,
    /// Merged node segment metadata (None if no nodes)
    pub node_meta: Option<SegmentMeta>,
    /// Merged edge segment bytes (None if no edges)
    pub edge_segment_bytes: Option<Vec<u8>>,
    /// Merged edge segment metadata (None if no edges)
    pub edge_meta: Option<SegmentMeta>,
    /// Number of L0 segments that were merged
    pub l0_segments_merged: u32,
    /// Number of tombstones that were physically removed
    pub tombstones_removed: u64,
}

// ── Compact Shard ───────────────────────────────────────────────────

/// Compact a single shard: merge L0 segments + existing L1 into new L1.
///
/// Algorithm:
/// 1. Collect all L0 node segments (newest first) + L1 node segment (oldest)
/// 2. Merge with tombstone filtering via `merge_node_segments()`
/// 3. Write merged records into a new in-memory segment
/// 4. Repeat for edges
/// 5. Return merged bytes + metadata
///
/// The caller (MultiShardStore) is responsible for:
/// - Allocating segment IDs
/// - Writing bytes to disk
/// - Updating the manifest
/// - Swapping shard state (set_l1_segments + clear_l0_after_compaction)
///
/// Complexity: O(N log N + M log M) where N = total nodes, M = total edges
pub fn compact_shard(shard: &Shard) -> Result<ShardCompactionResult> {
    let tombstones = shard.tombstones();

    // Count L0 segments being merged
    let l0_segments_merged =
        (shard.l0_node_segment_count() + shard.l0_edge_segment_count()) as u32;

    let tombstones_before =
        (tombstones.node_count() + tombstones.edge_count()) as u64;

    // ── Merge Nodes ─────────────────────────────────────────────────

    // Collect segment references: L0 newest-first, then L1 (oldest)
    let l0_node_segs: Vec<&NodeSegmentV2> = shard
        .l0_node_segments()
        .iter()
        .rev()
        .collect();

    let mut all_node_segs = l0_node_segs;
    if let Some(l1) = shard.l1_node_segment() {
        all_node_segs.push(l1);
    }

    let merged_nodes = merge_node_segments(&all_node_segs, tombstones);

    let (node_segment_bytes, node_meta) = if merged_nodes.is_empty() {
        (None, None)
    } else {
        let mut writer = NodeSegmentWriter::new();
        for record in merged_nodes {
            writer.add(record);
        }
        let mut cursor = Cursor::new(Vec::new());
        let meta = writer.finish(&mut cursor)?;
        (Some(cursor.into_inner()), Some(meta))
    };

    // ── Merge Edges ─────────────────────────────────────────────────

    let l0_edge_segs: Vec<&EdgeSegmentV2> = shard
        .l0_edge_segments()
        .iter()
        .rev()
        .collect();

    let mut all_edge_segs = l0_edge_segs;
    if let Some(l1) = shard.l1_edge_segment() {
        all_edge_segs.push(l1);
    }

    let merged_edges = merge_edge_segments(&all_edge_segs, tombstones);

    let (edge_segment_bytes, edge_meta) = if merged_edges.is_empty() {
        (None, None)
    } else {
        let mut writer = EdgeSegmentWriter::new();
        for record in merged_edges {
            writer.add(record);
        }
        let mut cursor = Cursor::new(Vec::new());
        let meta = writer.finish(&mut cursor)?;
        (Some(cursor.into_inner()), Some(meta))
    };

    Ok(ShardCompactionResult {
        node_segment_bytes,
        node_meta,
        edge_segment_bytes,
        edge_meta,
        l0_segments_merged,
        tombstones_removed: tombstones_before,
    })
}

/// Build a SegmentDescriptor from compaction metadata.
///
/// Used by the caller to construct descriptors for the manifest.
pub fn build_l1_descriptor(
    seg_id: u64,
    seg_type: SegmentType,
    shard_id: Option<u16>,
    meta: &SegmentMeta,
) -> SegmentDescriptor {
    SegmentDescriptor {
        segment_id: seg_id,
        segment_type: seg_type,
        shard_id,
        record_count: meta.record_count,
        byte_size: meta.byte_size,
        node_types: meta.node_types.clone(),
        file_paths: meta.file_paths.clone(),
        edge_types: meta.edge_types.clone(),
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::shard::Shard;
    use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};

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

    #[test]
    fn test_should_compact_below_threshold() {
        let shard = Shard::ephemeral();
        let config = CompactionConfig { segment_threshold: 4 };
        assert!(!should_compact(&shard, &config));
    }

    #[test]
    fn test_should_compact_at_threshold() {
        let mut shard = Shard::ephemeral();
        // Add nodes and flush 4 times to create 4 L0 segments
        for i in 0..4 {
            let node = make_node(&format!("node_{}", i), "FUNCTION", "fn", "file.rs");
            shard.add_nodes(vec![node]);
            shard.flush_with_ids(Some(i as u64 + 1), None).unwrap();
        }
        let config = CompactionConfig { segment_threshold: 4 };
        assert!(should_compact(&shard, &config));
    }

    #[test]
    fn test_compact_empty_shard() {
        let shard = Shard::ephemeral();
        let result = compact_shard(&shard).unwrap();
        assert!(result.node_segment_bytes.is_none());
        assert!(result.edge_segment_bytes.is_none());
        assert_eq!(result.l0_segments_merged, 0);
    }

    #[test]
    fn test_compact_shard_merges_nodes() {
        let mut shard = Shard::ephemeral();

        // Flush 1: two nodes
        let n1 = make_node("node_a", "FUNCTION", "a", "file.rs");
        let n2 = make_node("node_b", "CLASS", "b", "file.rs");
        shard.add_nodes(vec![n1.clone(), n2.clone()]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Flush 2: one new node + update of node_a
        let n3 = make_node("node_c", "METHOD", "c", "file.rs");
        let mut n1_updated = make_node("node_a", "FUNCTION", "a_updated", "new.rs");
        n1_updated.content_hash = 42;
        shard.add_nodes(vec![n3.clone(), n1_updated.clone()]);
        shard.flush_with_ids(Some(2), None).unwrap();

        let result = compact_shard(&shard).unwrap();

        assert!(result.node_segment_bytes.is_some());
        let meta = result.node_meta.unwrap();
        assert_eq!(meta.record_count, 3); // a (updated), b, c — deduped
        assert_eq!(result.l0_segments_merged, 2);
    }

    #[test]
    fn test_compact_shard_merges_edges() {
        let mut shard = Shard::ephemeral();

        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src2", "dst2", "IMPORTS_FROM");
        shard.upsert_edges(vec![e1.clone(), e2.clone()]);
        shard.flush_with_ids(None, Some(1)).unwrap();

        let e3 = make_edge("src3", "dst3", "CALLS");
        shard.upsert_edges(vec![e3.clone()]);
        shard.flush_with_ids(None, Some(2)).unwrap();

        let result = compact_shard(&shard).unwrap();

        assert!(result.edge_segment_bytes.is_some());
        let meta = result.edge_meta.unwrap();
        assert_eq!(meta.record_count, 3);
    }

    #[test]
    fn test_compact_shard_removes_tombstones() {
        let mut shard = Shard::ephemeral();

        let n1 = make_node("keep", "FUNCTION", "keep", "file.rs");
        let n2 = make_node("delete", "CLASS", "delete", "file.rs");
        shard.add_nodes(vec![n1.clone(), n2.clone()]);
        shard.flush_with_ids(Some(1), None).unwrap();

        // Add tombstone for n2
        shard.tombstones_mut().add_nodes(vec![n2.id]);

        let result = compact_shard(&shard).unwrap();

        let meta = result.node_meta.unwrap();
        assert_eq!(meta.record_count, 1); // Only "keep" survives
        assert_eq!(result.tombstones_removed, 1); // One tombstone was present
    }

    #[test]
    fn test_build_l1_descriptor() {
        let meta = SegmentMeta {
            record_count: 100,
            byte_size: 4096,
            segment_type: SegmentType::Nodes,
            node_types: ["FUNCTION".to_string()].into(),
            file_paths: ["file.rs".to_string()].into(),
            edge_types: Default::default(),
        };

        let desc = build_l1_descriptor(42, SegmentType::Nodes, Some(0), &meta);
        assert_eq!(desc.segment_id, 42);
        assert_eq!(desc.record_count, 100);
        assert_eq!(desc.byte_size, 4096);
        assert_eq!(desc.shard_id, Some(0));
        assert!(desc.node_types.contains("FUNCTION"));
    }
}
