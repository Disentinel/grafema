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
use crate::storage_v2::compaction::merge::{
    merge_edge_segments, merge_edge_segments_derived, merge_node_segments,
    merge_node_segments_derived,
};
use crate::storage_v2::compaction::types::CompactionConfig;
use crate::storage_v2::manifest::SegmentDescriptor;
use crate::storage_v2::segment::{EdgeSegmentV2, NodeSegmentV2};
use crate::storage_v2::shard::{Shard, TombstoneSet};
use crate::storage_v2::types::{SegmentMeta, SegmentType};
use crate::storage_v2::writer::{EdgeSegmentWriter, NodeSegmentWriter};

// ── Auto-compaction suppression during derive/materialize ───────────
//
// A derive/materialize handler holds a `db.engine.read()` lock but internally commits derived
// edges across many rule packs; those commits would auto-trigger compaction. Compaction (rayon,
// memmap2) rewrites/unmaps segments while the SAME materialize's `par_join_rows` rayon tasks read
// them → use-after-unmap / heap corruption → SIGSEGV (confirmed by isolation test 2026-06-19).
// While a materialize is in progress we SUPPRESS auto-compaction; the deferred compaction runs at
// the natural barrier (end_bulk_load / explicit Compact) under the exclusive write lock.
static AUTO_COMPACTION_SUPPRESSED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Suppress (or re-enable) automatic compaction. Set while a derive/materialize is in progress.
pub fn set_auto_compaction_suppressed(suppressed: bool) {
    AUTO_COMPACTION_SUPPRESSED.store(suppressed, std::sync::atomic::Ordering::SeqCst);
}

/// RAII guard: suppresses auto-compaction for its lifetime, restoring on drop (even on panic).
pub struct AutoCompactionSuppressGuard;

impl AutoCompactionSuppressGuard {
    pub fn new() -> Self {
        set_auto_compaction_suppressed(true);
        AutoCompactionSuppressGuard
    }
}

impl Drop for AutoCompactionSuppressGuard {
    fn drop(&mut self) {
        set_auto_compaction_suppressed(false);
    }
}

// ── Policy ──────────────────────────────────────────────────────────

/// Check if a shard should be compacted based on L0 segment count.
///
/// Returns true when the total L0 segments (nodes + edges) >= threshold.
/// Typical threshold: 4 (default in CompactionConfig).
///
/// Complexity: O(1)
pub fn should_compact(shard: &Shard, config: &CompactionConfig) -> bool {
    // Suppressed while a derive/materialize is in progress (see AUTO_COMPACTION_SUPPRESSED) — the
    // confirmed fix for the parallel-derive SIGSEGV (compaction unmapping segments under parallel
    // reads). RFDB_DISABLE_COMPACTION=1 is a manual override for diagnostics.
    if AUTO_COMPACTION_SUPPRESSED.load(std::sync::atomic::Ordering::SeqCst)
        || std::env::var_os("RFDB_DISABLE_COMPACTION").is_some()
    {
        return false;
    }
    let total_l0 = shard.l0_node_segment_count() + shard.l0_edge_segment_count();
    total_l0 >= config.segment_threshold
}

// ── Compaction Tier ──────────────────────────────────────────────────

/// Which tier the compaction output lands in.
///
/// Size-tiered policy (C3 gap 1 fix): a shard whose existing L1 is large relative
/// to its accumulated L0 does NOT pay the O(|L1|) full rewrite every round. Instead
/// it consolidates its L0 runs among themselves into a single new L0 run, leaving
/// the L1 (and the cumulative tombstone set) untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionTier {
    /// Full merge: L0 + existing L1 → new L1. Tombstones are physically removed.
    /// The classic single-tier behavior; also the forced path when `l1_fanout = ∞`.
    FullMerge,
    /// L0-only consolidation: merge the L0 runs into ONE new L0 run, leaving L1
    /// in place. Tombstones are NOT physically removed (records they shadow may
    /// live in the untouched L1) — they stay in the cumulative manifest set and
    /// are still honored at read time, then physically purged at the next
    /// `FullMerge`. Cost is O(|L0|), independent of DB size.
    L0Consolidate,
}

/// Decide which tier a shard's compaction should target under the size-tiered
/// policy.
///
/// Rule: fold L0 into L1 (`FullMerge`) when the accumulated L0 record count has
/// grown to within a `l1_fanout` factor of the L1 record count —
/// `l0_records * l1_fanout >= l1_records`. Otherwise `L0Consolidate`.
///
/// `FullMerge` is always chosen when:
/// - the shard has no L1 yet (nothing to defer against), or
/// - `l1_fanout` is non-finite / `>= ∞` (explicit-compact barriers force the
///   complete fold — see `engine_v2::compact` / `end_bulk_load`), or
/// - `l1_fanout <= 1.0` and L0 already meets the legacy "any L0" trigger.
///
/// Records (not bytes) drive the ratio: counts are exact and cheap, and L1
/// rewrite cost scales with record count.
pub fn choose_tier(shard: &Shard, config: &CompactionConfig) -> CompactionTier {
    // No L1 ⇒ the "full merge" degenerates to merging L0 into a first L1; there is
    // no large run to protect, so always FullMerge (cost is O(|L0|) anyway).
    let l1_records: u64 = shard
        .l1_node_descriptor()
        .map(|d| d.record_count)
        .unwrap_or(0)
        + shard
            .l1_edge_descriptor()
            .map(|d| d.record_count)
            .unwrap_or(0);
    if l1_records == 0 {
        return CompactionTier::FullMerge;
    }
    // Barrier / legacy: ∞ (or any non-finite) forces the complete fold.
    if !config.l1_fanout.is_finite() {
        return CompactionTier::FullMerge;
    }

    let l0_records: u64 = shard
        .l0_node_descriptors()
        .iter()
        .map(|d| d.record_count)
        .sum::<u64>()
        + shard
            .l0_edge_descriptors()
            .iter()
            .map(|d| d.record_count)
            .sum::<u64>();

    // Fold once L0 has caught up to within `l1_fanout` of L1; otherwise defer the
    // big rewrite and consolidate L0 among itself. f64 mul is exact enough at these
    // magnitudes (record counts are well under 2^53).
    if (l0_records as f64) * config.l1_fanout >= (l1_records as f64) {
        CompactionTier::FullMerge
    } else {
        CompactionTier::L0Consolidate
    }
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
    /// Number of tombstones that were physically removed (0 for `L0Consolidate`,
    /// which defers tombstone purge to the next full merge)
    pub tombstones_removed: u64,
    /// Which tier the output lands in (drives the caller's shard/manifest surgery).
    pub tier: CompactionTier,
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
///
/// This is the unconditional full-merge entry (always `FullMerge`). For the
/// size-tiered policy use [`compact_shard_tiered`].
pub fn compact_shard(shard: &Shard) -> Result<ShardCompactionResult> {
    compact_shard_with_tier(shard, CompactionTier::FullMerge)
}

/// Compact a shard under the size-tiered policy: [`choose_tier`] decides whether
/// to fold L0 into L1 (`FullMerge`) or consolidate L0 among itself
/// (`L0Consolidate`), then performs that merge.
///
/// `L0Consolidate` leaves L1 + tombstones untouched and produces a single new L0
/// run, so the per-round cost is O(|L0|) instead of O(|L1|) (= O(DB)). Correctness
/// is preserved because the deferred tombstones stay in the cumulative manifest
/// set and are honored at read time (snapshot reads filter every L0/L1 hit through
/// `snap.tombstones`); they are physically purged at the next `FullMerge`.
pub fn compact_shard_tiered(
    shard: &Shard,
    config: &CompactionConfig,
) -> Result<ShardCompactionResult> {
    compact_shard_with_tier(shard, choose_tier(shard, config))
}

fn compact_shard_with_tier(shard: &Shard, tier: CompactionTier) -> Result<ShardCompactionResult> {
    let tombstones = shard.tombstones();

    let l0_segments_merged =
        (shard.l0_node_segment_count() + shard.l0_edge_segment_count()) as u32;

    // A full merge physically removes tombstones (the merge filters every record
    // through them, and the caller clears the cumulative set). An L0-only
    // consolidation defers that purge to the next full merge, so it removes 0.
    let tombstones_before = match tier {
        CompactionTier::FullMerge => (tombstones.node_count() + tombstones.edge_count()) as u64,
        CompactionTier::L0Consolidate => 0,
    };

    // Merge nodes and edges in parallel — they read different segment
    // types from the same shard and produce independent results.
    let (node_result, edge_result) = rayon::join(
        || merge_and_write_nodes(shard, tier),
        || merge_and_write_edges(shard, tier),
    );

    let (node_segment_bytes, node_meta) = node_result?;
    let (edge_segment_bytes, edge_meta) = edge_result?;

    Ok(ShardCompactionResult {
        node_segment_bytes,
        node_meta,
        edge_segment_bytes,
        edge_meta,
        l0_segments_merged,
        tombstones_removed: tombstones_before,
        tier,
    })
}

fn merge_and_write_nodes(
    shard: &Shard,
    tier: CompactionTier,
) -> Result<(Option<Vec<u8>>, Option<SegmentMeta>)> {
    let l0_node_segs: Vec<&NodeSegmentV2> = shard.l0_node_segments().iter().rev().collect();

    // FullMerge folds the existing L1 in (oldest, last) and applies tombstones.
    // L0Consolidate merges only the L0 runs and does NOT apply tombstones — the
    // shadowed records may live in the untouched L1, so the tombstone must survive
    // in the cumulative manifest set (still honored at read time) until a later
    // full merge physically purges it.
    let mut all_node_segs = l0_node_segs;
    let empty_tombstones;
    let tombstones = match tier {
        CompactionTier::FullMerge => {
            if let Some(l1) = shard.l1_node_segment() {
                all_node_segs.push(l1);
            }
            shard.tombstones()
        }
        CompactionTier::L0Consolidate => {
            empty_tombstones = TombstoneSet::new();
            &empty_tombstones
        }
    };

    // Base fast path (the dominant analyzer workload) stays byte-identical: first-insert-
    // wins dedup, no per-record tag decode. Only when an input carries derived columns do
    // we take the tag-aware ⊕-fold path, preserving provenance/tag/tx (the base path would
    // strip them) — spec §8.2.
    let any_derived = all_node_segs.iter().any(|s| s.has_derived_columns());

    let mut writer = NodeSegmentWriter::new();
    if any_derived {
        let merged = merge_node_segments_derived(&all_node_segs, tombstones)?;
        if merged.is_empty() {
            return Ok((None, None));
        }
        for (record, fields) in merged {
            writer.add_derived(record, fields);
        }
    } else {
        let merged = merge_node_segments(&all_node_segs, tombstones);
        if merged.is_empty() {
            return Ok((None, None));
        }
        for record in merged {
            writer.add(record);
        }
    }
    let mut cursor = Cursor::new(Vec::new());
    let meta = writer.finish(&mut cursor)?;
    Ok((Some(cursor.into_inner()), Some(meta)))
}

fn merge_and_write_edges(
    shard: &Shard,
    tier: CompactionTier,
) -> Result<(Option<Vec<u8>>, Option<SegmentMeta>)> {
    let l0_edge_segs: Vec<&EdgeSegmentV2> = shard.l0_edge_segments().iter().rev().collect();

    let mut all_edge_segs = l0_edge_segs;
    let empty_tombstones;
    let tombstones = match tier {
        CompactionTier::FullMerge => {
            if let Some(l1) = shard.l1_edge_segment() {
                all_edge_segs.push(l1);
            }
            shard.tombstones()
        }
        CompactionTier::L0Consolidate => {
            empty_tombstones = TombstoneSet::new();
            &empty_tombstones
        }
    };

    let any_derived = all_edge_segs.iter().any(|s| s.has_derived_columns());

    let mut writer = EdgeSegmentWriter::new();
    if any_derived {
        let merged = merge_edge_segments_derived(&all_edge_segs, tombstones)?;
        if merged.is_empty() {
            return Ok((None, None));
        }
        for (record, fields) in merged {
            writer.add_derived(record, fields);
        }
    } else {
        let merged = merge_edge_segments(&all_edge_segs, tombstones);
        if merged.is_empty() {
            return Ok((None, None));
        }
        for record in merged {
            writer.add(record);
        }
    }
    let mut cursor = Cursor::new(Vec::new());
    let meta = writer.finish(&mut cursor)?;
    Ok((Some(cursor.into_inner()), Some(meta)))
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
    use crate::storage_v2::shard::{Shard, TombstoneSet};
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
        let config = CompactionConfig { segment_threshold: 4, l1_fanout: f64::INFINITY };
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
        let config = CompactionConfig { segment_threshold: 4, l1_fanout: f64::INFINITY };
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
        let mut ts = TombstoneSet::new();
        ts.add_nodes(vec![n2.id]);
        shard.set_tombstones(ts);

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

    // ── W7: size-tiered policy ──────────────────────────────────────────────

    /// Build an L1 of `l1_count` distinct nodes on `shard` (full-merge bytes
    /// in-memory), then leave the shard with that L1 and an empty L0.
    fn install_l1(shard: &mut Shard, l1_count: usize) {
        for i in 0..l1_count {
            shard.add_nodes(vec![make_node(
                &format!("l1_{}", i),
                "FUNCTION",
                "f",
                "l1.rs",
            )]);
        }
        shard.flush_with_ids(Some(1000), None).unwrap();
        let result = compact_shard(shard).unwrap();
        let bytes = result.node_segment_bytes.unwrap();
        let meta = result.node_meta.unwrap();
        let seg = crate::storage_v2::segment::NodeSegmentV2::from_bytes(&bytes).unwrap();
        let desc = build_l1_descriptor(2000, SegmentType::Nodes, None, &meta);
        shard.set_l1_segments(Some(seg), Some(desc), None, None);
        shard.clear_l0_after_compaction();
        assert_eq!(
            shard.l1_node_descriptor().unwrap().record_count,
            l1_count as u64
        );
    }

    #[test]
    fn choose_tier_no_l1_is_full_merge() {
        let mut shard = Shard::ephemeral();
        shard.add_nodes(vec![make_node("a", "FUNCTION", "a", "f.rs")]);
        shard.flush_with_ids(Some(1), None).unwrap();
        let config = CompactionConfig {
            segment_threshold: 1,
            l1_fanout: 4.0,
        };
        // No L1 yet ⇒ always FullMerge.
        assert_eq!(choose_tier(&shard, &config), CompactionTier::FullMerge);
    }

    #[test]
    fn choose_tier_infinite_fanout_forces_full_merge() {
        let mut shard = Shard::ephemeral();
        install_l1(&mut shard, 1000);
        // Tiny L0 next to a big L1, but fanout=∞ forces the full merge (barrier).
        shard.add_nodes(vec![make_node("new", "FUNCTION", "n", "f.rs")]);
        shard.flush_with_ids(Some(3), None).unwrap();
        let config = CompactionConfig {
            segment_threshold: 1,
            l1_fanout: f64::INFINITY,
        };
        assert_eq!(choose_tier(&shard, &config), CompactionTier::FullMerge);
    }

    #[test]
    fn choose_tier_small_l0_big_l1_consolidates() {
        let mut shard = Shard::ephemeral();
        install_l1(&mut shard, 1000);
        // L0 = 10 records, L1 = 1000, fanout 4 ⇒ 10*4=40 < 1000 ⇒ L0Consolidate.
        for i in 0..10 {
            shard.add_nodes(vec![make_node(
                &format!("new_{}", i),
                "FUNCTION",
                "n",
                "f.rs",
            )]);
        }
        shard.flush_with_ids(Some(3), None).unwrap();
        let config = CompactionConfig {
            segment_threshold: 1,
            l1_fanout: 4.0,
        };
        assert_eq!(choose_tier(&shard, &config), CompactionTier::L0Consolidate);
    }

    #[test]
    fn choose_tier_l0_caught_up_full_merges() {
        let mut shard = Shard::ephemeral();
        install_l1(&mut shard, 100);
        // L0 = 30, L1 = 100, fanout 4 ⇒ 30*4=120 >= 100 ⇒ FullMerge.
        for i in 0..30 {
            shard.add_nodes(vec![make_node(
                &format!("new_{}", i),
                "FUNCTION",
                "n",
                "f.rs",
            )]);
        }
        shard.flush_with_ids(Some(3), None).unwrap();
        let config = CompactionConfig {
            segment_threshold: 1,
            l1_fanout: 4.0,
        };
        assert_eq!(choose_tier(&shard, &config), CompactionTier::FullMerge);
    }

    /// L0-only consolidation must NOT physically apply tombstones (they may shadow
    /// records in the untouched L1). It dedups L0 newest-wins, leaves the count of
    /// L0-only records intact, and reports tombstones_removed = 0.
    #[test]
    fn l0_consolidate_defers_tombstones() {
        let mut shard = Shard::ephemeral();
        install_l1(&mut shard, 200);
        // One of the L1-resident ids gets tombstoned.
        let l1_victim = make_node("l1_0", "FUNCTION", "f", "l1.rs");
        // New L0 records (small relative to L1) + a tombstone on an L1 id.
        for i in 0..5 {
            shard.add_nodes(vec![make_node(
                &format!("new_{}", i),
                "FUNCTION",
                "n",
                "f.rs",
            )]);
        }
        shard.flush_with_ids(Some(3), None).unwrap();
        let mut ts = TombstoneSet::new();
        ts.add_nodes(vec![l1_victim.id]);
        shard.set_tombstones(ts);

        let config = CompactionConfig {
            segment_threshold: 1,
            l1_fanout: 4.0,
        };
        assert_eq!(choose_tier(&shard, &config), CompactionTier::L0Consolidate);
        let result = compact_shard_tiered(&shard, &config).unwrap();
        assert_eq!(result.tier, CompactionTier::L0Consolidate);
        // The 5 new L0 records survive as one consolidated run; tombstone deferred.
        let meta = result.node_meta.unwrap();
        assert_eq!(meta.record_count, 5, "only the L0 records consolidate");
        assert_eq!(
            result.tombstones_removed, 0,
            "L0-only consolidation defers tombstone purge"
        );
    }
}
