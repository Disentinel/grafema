//! LSM-style background compaction for RFDB v2.
//!
//! Merges L0 (flush) segments into L1 (compacted) segments,
//! removing tombstones and deduplicating records.

pub mod merge;
pub mod types;

pub use merge::{merge_edge_segments, merge_node_segments};
pub use types::*;
