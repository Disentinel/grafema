//! L1 node index for O(1) node lookup after compaction.
//!
//! Maps node_id (u128) to segment location (segment_id + offset + shard).

pub mod format;

pub use format::{IndexEntry, IndexFileHeader, LookupTableEntry};
