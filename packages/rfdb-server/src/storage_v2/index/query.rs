//! Index query -- load and search inverted indexes.
//!
//! `InvertedIndex` loads a serialized index (from `builder::serialize_index`)
//! into memory and provides O(log K) lookup by key via binary search on a
//! sorted lookup table.

use std::io::Read;

use crate::error::{GraphError, Result};
use crate::storage_v2::index::format::{IndexEntry, IndexFileHeader, LookupTableEntry};

/// Loaded inverted index for fast attribute lookups.
///
/// Structure:
/// - `string_table`: raw bytes of concatenated key strings
/// - `lookup_entries`: sorted by key for binary search
/// - `entries`: all IndexEntry records, grouped by key
///
/// Lookup is O(log K) where K = number of distinct keys.
pub struct InvertedIndex {
    /// String table (raw bytes of concatenated keys)
    string_table: Vec<u8>,
    /// Lookup table entries (sorted by key for binary search)
    lookup_entries: Vec<LookupTableEntry>,
    /// All index entries
    entries: Vec<IndexEntry>,
}

impl InvertedIndex {
    /// Load index from bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        let mut cursor = std::io::Cursor::new(data);

        // Read header
        let header = IndexFileHeader::read_from(&mut cursor)?;

        // Read string table
        let mut st_len_buf = [0u8; 4];
        cursor.read_exact(&mut st_len_buf).map_err(|e| {
            GraphError::InvalidFormat(format!("Failed to read string table length: {}", e))
        })?;
        let st_len = u32::from_le_bytes(st_len_buf) as usize;
        let mut string_table = vec![0u8; st_len];
        if st_len > 0 {
            cursor.read_exact(&mut string_table).map_err(|e| {
                GraphError::InvalidFormat(format!("Failed to read string table: {}", e))
            })?;
        }

        // Read lookup table
        let mut lookup_entries = Vec::with_capacity(header.lookup_count as usize);
        for _ in 0..header.lookup_count {
            lookup_entries.push(LookupTableEntry::read_from(&mut cursor)?);
        }

        // Read entries
        let entries = IndexEntry::read_batch(&mut cursor, header.entry_count as usize)?;

        Ok(Self {
            string_table,
            lookup_entries,
            entries,
        })
    }

    /// Lookup entries for a given attribute value.
    ///
    /// Returns slice of IndexEntry for the matching key, or empty if not found.
    /// O(log K) via binary search on lookup table.
    pub fn lookup(&self, key: &str) -> &[IndexEntry] {
        let result = self.lookup_entries.binary_search_by(|entry| {
            let start = entry.key_offset as usize;
            let end = start + entry.key_length as usize;
            let entry_key = std::str::from_utf8(&self.string_table[start..end]).unwrap_or("");
            entry_key.cmp(key)
        });

        match result {
            Ok(idx) => {
                let entry = &self.lookup_entries[idx];
                let start = entry.entry_offset as usize;
                let end = start + entry.entry_count as usize;
                &self.entries[start..end]
            }
            Err(_) => &[],
        }
    }

    /// List all distinct keys in this index.
    pub fn keys(&self) -> Vec<String> {
        self.lookup_entries
            .iter()
            .map(|entry| {
                let start = entry.key_offset as usize;
                let end = start + entry.key_length as usize;
                String::from_utf8_lossy(&self.string_table[start..end]).to_string()
            })
            .collect()
    }

    /// Total number of entries across all keys.
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::index::builder::build_inverted_indexes;
    use crate::storage_v2::types::NodeRecordV2;

    fn make_node(semantic_id: &str, node_type: &str, file: &str) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id,
            node_type: node_type.to_string(),
            name: semantic_id.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    #[test]
    fn test_inverted_index_roundtrip_query() {
        let records = vec![
            make_node("a", "FUNCTION", "src/a.rs"),
            make_node("b", "CLASS", "src/b.rs"),
            make_node("c", "FUNCTION", "src/a.rs"),
        ];

        let built = build_inverted_indexes(&records, 0, 1).unwrap();
        let idx = InvertedIndex::from_bytes(&built.by_type).unwrap();

        // Lookup existing key
        let funcs = idx.lookup("FUNCTION");
        assert_eq!(funcs.len(), 2);
        assert_eq!(funcs[0].node_id, records[0].id);
        assert_eq!(funcs[1].node_id, records[2].id);

        // Lookup another existing key
        let classes = idx.lookup("CLASS");
        assert_eq!(classes.len(), 1);

        // Lookup missing key
        assert!(idx.lookup("INTERFACE").is_empty());
    }

    #[test]
    fn test_inverted_index_keys_sorted() {
        let records = vec![
            make_node("z", "ZTYPE", "z.rs"),
            make_node("a", "ATYPE", "a.rs"),
            make_node("m", "MTYPE", "m.rs"),
        ];

        let built = build_inverted_indexes(&records, 0, 1).unwrap();
        let idx = InvertedIndex::from_bytes(&built.by_type).unwrap();

        let keys = idx.keys();
        assert_eq!(keys, vec!["ATYPE", "MTYPE", "ZTYPE"]);
    }

    #[test]
    fn test_inverted_index_entry_count() {
        let records = vec![
            make_node("a", "T", "f.rs"),
            make_node("b", "T", "f.rs"),
            make_node("c", "T", "f.rs"),
        ];

        let built = build_inverted_indexes(&records, 0, 1).unwrap();
        let idx = InvertedIndex::from_bytes(&built.by_type).unwrap();

        assert_eq!(idx.entry_count(), 3);
    }
}
