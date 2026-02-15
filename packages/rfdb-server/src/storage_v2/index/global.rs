//! Global index -- sorted array of (node_id -> location) for binary search
//! point lookups.
//!
//! Enables O(log N) point lookup instead of O(S) shard fan-out, where
//! N = total nodes and S = shard count.

use std::io::Cursor;

use crate::error::Result;
use crate::storage_v2::index::format::{IndexEntry, IndexFileHeader, INDEX_MAGIC, INDEX_VERSION};

/// Global index: sorted array of IndexEntry by node_id.
///
/// Built from all shards' L1 entries after compaction.
/// Provides O(log N) point lookup for `get_node()`.
pub struct GlobalIndex {
    entries: Vec<IndexEntry>,
}

impl GlobalIndex {
    /// Build global index from entries collected across shards.
    ///
    /// Sorts entries by node_id for binary search.
    pub fn build(mut entries: Vec<IndexEntry>) -> Self {
        entries.sort_by_key(|e| e.node_id);
        Self { entries }
    }

    /// Serialize to bytes.
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let mut buf = Cursor::new(Vec::new());
        let header = IndexFileHeader {
            magic: INDEX_MAGIC,
            version: INDEX_VERSION,
            entry_count: self.entries.len() as u64,
            lookup_count: 0, // no lookup table for global index
            _reserved: [0u8; 12],
        };
        header.write_to(&mut buf)?;
        IndexEntry::write_batch(&self.entries, &mut buf)?;
        Ok(buf.into_inner())
    }

    /// Load from bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        let header = IndexFileHeader::read_from(&mut cursor)?;
        let entries = IndexEntry::read_batch(&mut cursor, header.entry_count as usize)?;
        Ok(Self { entries })
    }

    /// Point lookup: find the IndexEntry for a given node_id.
    ///
    /// O(log N) via binary search.
    pub fn lookup(&self, node_id: u128) -> Option<&IndexEntry> {
        self.entries
            .binary_search_by_key(&node_id, |e| e.node_id)
            .ok()
            .map(|idx| &self.entries[idx])
    }

    /// Total number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True if the index is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::index::format::IndexEntry;

    #[test]
    fn test_global_index_build_and_lookup() {
        let entries = vec![
            IndexEntry::new(300, 1, 0, 0),
            IndexEntry::new(100, 1, 1, 0),
            IndexEntry::new(200, 2, 0, 1),
        ];

        let idx = GlobalIndex::build(entries);
        assert_eq!(idx.len(), 3);

        // Lookup existing
        let found = idx.lookup(100).unwrap();
        assert_eq!(found.segment_id, 1);
        assert_eq!(found.offset, 1);
        assert_eq!(found.shard, 0);

        let found = idx.lookup(200).unwrap();
        assert_eq!(found.segment_id, 2);
        assert_eq!(found.offset, 0);
        assert_eq!(found.shard, 1);

        let found = idx.lookup(300).unwrap();
        assert_eq!(found.segment_id, 1);
        assert_eq!(found.offset, 0);

        // Lookup missing
        assert!(idx.lookup(999).is_none());
        assert!(idx.lookup(0).is_none());
    }

    #[test]
    fn test_global_index_roundtrip() {
        let entries = vec![
            IndexEntry::new(50, 1, 0, 0),
            IndexEntry::new(150, 2, 1, 1),
            IndexEntry::new(250, 3, 2, 0),
        ];

        let idx = GlobalIndex::build(entries);
        let bytes = idx.to_bytes().unwrap();

        let idx2 = GlobalIndex::from_bytes(&bytes).unwrap();
        assert_eq!(idx2.len(), 3);

        // Verify lookups still work after roundtrip
        assert_eq!(idx2.lookup(50).unwrap().segment_id, 1);
        assert_eq!(idx2.lookup(150).unwrap().segment_id, 2);
        assert_eq!(idx2.lookup(250).unwrap().segment_id, 3);
        assert!(idx2.lookup(999).is_none());
    }

    #[test]
    fn test_global_index_empty() {
        let idx = GlobalIndex::build(vec![]);
        assert!(idx.is_empty());
        assert_eq!(idx.len(), 0);
        assert!(idx.lookup(1).is_none());

        // Roundtrip empty
        let bytes = idx.to_bytes().unwrap();
        let idx2 = GlobalIndex::from_bytes(&bytes).unwrap();
        assert!(idx2.is_empty());
    }

    #[test]
    fn test_global_index_sorted_after_build() {
        // Build with unsorted input
        let entries = vec![
            IndexEntry::new(999, 1, 0, 0),
            IndexEntry::new(1, 1, 1, 0),
            IndexEntry::new(500, 1, 2, 0),
        ];

        let idx = GlobalIndex::build(entries);

        // Should find all by binary search (implies sorted)
        assert!(idx.lookup(1).is_some());
        assert!(idx.lookup(500).is_some());
        assert!(idx.lookup(999).is_some());
    }
}
