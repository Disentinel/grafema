//! L1 node index for O(1) node lookup after compaction.
//!
//! Provides:
//! - `format` -- binary format types (IndexEntry, IndexFileHeader, LookupTableEntry)
//! - `builder` -- inverted index construction during compaction
//! - `query` -- inverted index loading and O(log K) key lookup

pub mod builder;
pub mod format;
pub mod query;

pub use builder::{build_inverted_indexes, BuiltIndexes};
pub use format::{IndexEntry, IndexFileHeader, LookupTableEntry};
pub use query::InvertedIndex;
