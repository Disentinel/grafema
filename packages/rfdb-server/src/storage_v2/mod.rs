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

pub use types::*;
pub use string_table::StringTableV2;
pub use bloom::BloomFilter;
pub use zone_map::ZoneMap;
pub use writer::{NodeSegmentWriter, EdgeSegmentWriter};
pub use segment::{NodeSegmentV2, EdgeSegmentV2};
