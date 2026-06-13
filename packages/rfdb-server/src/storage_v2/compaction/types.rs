//! Types for LSM-style background compaction.
//!
//! Compaction merges multiple L0 (flush) segments into a single L1 (compacted)
//! segment per shard, removing tombstones and deduplicating records.

use serde::{Deserialize, Serialize};

use crate::storage_v2::resource::TuningProfile;

/// Configuration for compaction trigger policy.
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// Minimum L0 segment count per shard to trigger compaction (default: 4)
    pub segment_threshold: usize,

    /// Size-tiered fanout ratio: the L0→L1 full merge (which rewrites the entire
    /// L1 run, cost O(|L1|)) is performed only when the accumulated L0 record
    /// count has grown to at least `1/l1_fanout` of the L1 record count. While L0
    /// is smaller than that, compaction instead CONSOLIDATES the L0 runs among
    /// themselves into a single new L0 run (cost O(|L0|)), leaving the large L1
    /// untouched. This bounds the AMORTIZED rewrite work: each L1 byte is rewritten
    /// O(log_fanout(DB)) times over a full ingest instead of once per compaction
    /// round (the old O(DB)-per-round full rewrite — C3 gap 1). A value of 1.0
    /// degenerates to the legacy "always full-merge" policy.
    ///
    /// Default: 4.0 (fold L0 into L1 once L0 ≥ 25% of L1).
    pub l1_fanout: f64,
}

impl CompactionConfig {
    /// Create compaction config from an adaptive tuning profile.
    ///
    /// Uses `profile.segment_threshold` which ranges from 2 (low memory,
    /// compact early) to 8 (high memory, batch more before compacting).
    pub fn from_profile(profile: &TuningProfile) -> Self {
        Self {
            segment_threshold: profile.segment_threshold,
            l1_fanout: 4.0,
        }
    }
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            segment_threshold: 4,
            l1_fanout: 4.0,
        }
    }
}

/// Result of a compaction operation.
#[derive(Debug, Clone)]
pub struct CompactionResult {
    /// Shards that were compacted
    pub shards_compacted: Vec<u16>,
    /// Total node records in merged output
    pub nodes_merged: u64,
    /// Total edge records in merged output
    pub edges_merged: u64,
    /// Tombstones physically removed
    pub tombstones_removed: u64,
    /// Compaction duration in milliseconds
    pub duration_ms: u64,
}

/// Compaction metadata stored in manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompactionInfo {
    /// Manifest version when compaction was performed
    pub manifest_version: u64,
    /// Timestamp (unix epoch ms)
    pub timestamp_ms: u64,
    /// Number of L0 segments that were merged
    pub l0_segments_merged: u32,
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compaction_config_default_segment_threshold() {
        let config = CompactionConfig::default();
        assert_eq!(config.segment_threshold, 4);
    }

    #[test]
    fn test_compaction_config_custom_threshold() {
        let config = CompactionConfig {
            segment_threshold: 8,
            l1_fanout: 4.0,
        };
        assert_eq!(config.segment_threshold, 8);
        assert_eq!(config.l1_fanout, 4.0);
    }

    #[test]
    fn test_compaction_info_serde_roundtrip() {
        let info = CompactionInfo {
            manifest_version: 42,
            timestamp_ms: 1707826800000,
            l0_segments_merged: 5,
        };

        let json = serde_json::to_string(&info).unwrap();
        let deserialized: CompactionInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(info, deserialized);
    }

    #[test]
    fn test_compaction_info_json_format() {
        let info = CompactionInfo {
            manifest_version: 10,
            timestamp_ms: 1000,
            l0_segments_merged: 3,
        };

        let json = serde_json::to_string(&info).unwrap();
        // Verify field names match expected JSON keys
        assert!(json.contains("\"manifest_version\":10"));
        assert!(json.contains("\"timestamp_ms\":1000"));
        assert!(json.contains("\"l0_segments_merged\":3"));
    }

    #[test]
    fn test_compaction_result_construction() {
        let result = CompactionResult {
            shards_compacted: vec![0, 1, 2],
            nodes_merged: 1000,
            edges_merged: 500,
            tombstones_removed: 50,
            duration_ms: 250,
        };

        assert_eq!(result.shards_compacted, vec![0, 1, 2]);
        assert_eq!(result.nodes_merged, 1000);
        assert_eq!(result.edges_merged, 500);
        assert_eq!(result.tombstones_removed, 50);
        assert_eq!(result.duration_ms, 250);
    }

    #[test]
    fn test_compaction_config_from_profile_low_memory() {
        use crate::storage_v2::resource::{SystemResources, TuningProfile};

        // 1 GB RAM -> segment_threshold = 2
        let res = SystemResources {
            total_memory_bytes: 1024 * 1024 * 1024,
            available_memory_bytes: 512 * 1024 * 1024,
            cpu_count: 2,
        };
        let profile = TuningProfile::from_resources(&res);
        let config = CompactionConfig::from_profile(&profile);

        assert_eq!(config.segment_threshold, 2);
    }

    #[test]
    fn test_compaction_config_from_profile_high_memory() {
        use crate::storage_v2::resource::{SystemResources, TuningProfile};

        // 64 GB RAM -> segment_threshold = 8
        let res = SystemResources {
            total_memory_bytes: 64 * 1024 * 1024 * 1024,
            available_memory_bytes: 32 * 1024 * 1024 * 1024,
            cpu_count: 16,
        };
        let profile = TuningProfile::from_resources(&res);
        let config = CompactionConfig::from_profile(&profile);

        assert_eq!(config.segment_threshold, 8);
    }

    #[test]
    fn test_compaction_config_from_profile_range() {
        use crate::storage_v2::resource::{SystemResources, TuningProfile};

        // Test various memory sizes, threshold should always be in [2, 8]
        for &total_gb in &[0.5, 1.0, 4.0, 8.0, 16.0, 64.0, 256.0] {
            let res = SystemResources {
                total_memory_bytes: (total_gb * 1024.0 * 1024.0 * 1024.0) as u64,
                available_memory_bytes: (total_gb * 512.0 * 1024.0 * 1024.0) as u64,
                cpu_count: 4,
            };
            let profile = TuningProfile::from_resources(&res);
            let config = CompactionConfig::from_profile(&profile);

            assert!(
                config.segment_threshold >= 2 && config.segment_threshold <= 8,
                "threshold {} out of [2, 8] range for {total_gb} GB",
                config.segment_threshold
            );
        }
    }
}
