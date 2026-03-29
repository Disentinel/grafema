//! L1 node index for O(1) node lookup after compaction.
//!
//! Provides:
//! - `format` -- binary format types (IndexEntry, IndexFileHeader, LookupTableEntry)
//! - `builder` -- inverted index construction during compaction
//! - `query` -- inverted index loading and O(log K) key lookup
//! - `global` -- global index for O(log N) point lookups across shards
//! - `token` -- token-based fuzzy name index for Jaccard similarity search

pub mod builder;
pub mod format;
pub mod global;
pub mod query;
pub mod token;

pub use builder::{build_inverted_indexes, BuiltIndexes};
pub use format::{IndexEntry, IndexFileHeader, LookupTableEntry};
pub use global::GlobalIndex;
pub use query::InvertedIndex;
pub use token::{build_token_index, tokenize_name, TokenIndex, TokenMatch};
