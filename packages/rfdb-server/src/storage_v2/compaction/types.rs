//! Types for LSM-style background compaction.
//!
//! Compaction merges multiple L0 (flush) segments into a single L1 (compacted)
//! segment per shard, removing tombstones and deduplicating records.

use serde::{Deserialize, Serialize};

/// Configuration for compaction trigger policy.
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// Minimum L0 segment count per shard to trigger compaction (default: 4)
    pub segment_threshold: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            segment_threshold: 4,
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
        };
        assert_eq!(config.segment_threshold, 8);
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
}
