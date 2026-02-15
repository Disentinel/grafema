//! V2 columnar segment format for RFDB.
//!
//! Immutable, mmap-based segments with bloom filters, zone maps, and
//! per-segment string tables. Foundation for RFDB v2 LSM-tree storage.

pub mod types;
pub mod string_table;
pub mod bloom;
pub mod zone_map;
pub mod writer;
pub mod segment;
pub mod manifest;
pub mod write_buffer;
pub mod shard;
pub mod shard_planner;
pub mod multi_shard;
pub mod compaction;
pub mod index;
pub mod resource;

pub use types::*;
pub use string_table::StringTableV2;
pub use bloom::BloomFilter;
pub use zone_map::ZoneMap;
pub use writer::{NodeSegmentWriter, EdgeSegmentWriter};
pub use segment::{NodeSegmentV2, EdgeSegmentV2};

pub use manifest::{
    CurrentPointer, DurabilityMode, Manifest, ManifestIndex, ManifestStats, ManifestStore,
    SegmentDescriptor, SnapshotDiff, SnapshotInfo,
};
pub use write_buffer::WriteBuffer;
pub use shard::{Shard, FlushResult, TombstoneSet};
pub use shard_planner::ShardPlanner;
pub use multi_shard::{DatabaseConfig, MultiShardStore, ShardStats};
pub use compaction::{CompactionConfig, CompactionInfo, CompactionResult, merge_node_segments, merge_edge_segments};
pub use index::{IndexEntry, IndexFileHeader, LookupTableEntry};
pub use resource::{ResourceManager, SystemResources, TuningProfile};
