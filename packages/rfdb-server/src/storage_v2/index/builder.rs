//! Inverted index builder -- creates indexes during compaction.
//!
//! Two inverted indexes for nodes:
//! - **by_type**: node_type -> list of IndexEntry
//! - **by_file**: file -> list of IndexEntry
//!
//! Called after merge with the final sorted records and their positions.

use std::collections::HashMap;
use std::io::{Cursor, Write};

use crate::error::Result;
use crate::storage_v2::index::format::{
    IndexEntry, IndexFileHeader, LookupTableEntry, INDEX_MAGIC, INDEX_VERSION,
};
use crate::storage_v2::types::NodeRecordV2;

/// Built indexes ready to use in memory or write to disk.
pub struct BuiltIndexes {
    /// by_type index: maps node_type -> sorted IndexEntry list
    pub by_type: Vec<u8>,
    /// by_file index: maps file -> sorted IndexEntry list
    pub by_file: Vec<u8>,
}

/// Build inverted indexes from sorted, compacted node records.
///
/// Called after merge, with the final sorted records and their positions.
/// `shard_id` and `segment_id` identify where these records live.
///
/// Complexity: O(N) to group + O(K log K) to sort keys, where N = records, K = distinct keys.
pub fn build_inverted_indexes(
    records: &[NodeRecordV2],
    shard_id: u16,
    segment_id: u64,
) -> Result<BuiltIndexes> {
    let mut by_type: HashMap<String, Vec<IndexEntry>> = HashMap::new();
    let mut by_file: HashMap<String, Vec<IndexEntry>> = HashMap::new();

    for (offset, record) in records.iter().enumerate() {
        let entry = IndexEntry {
            node_id: record.id,
            segment_id,
            offset: offset as u32,
            shard: shard_id,
            _padding: 0,
        };
        by_type
            .entry(record.node_type.clone())
            .or_default()
            .push(entry);
        by_file
            .entry(record.file.clone())
            .or_default()
            .push(entry);
    }

    let by_type_bytes = serialize_index(&by_type)?;
    let by_file_bytes = serialize_index(&by_file)?;

    Ok(BuiltIndexes {
        by_type: by_type_bytes,
        by_file: by_file_bytes,
    })
}

/// Serialize an index map to binary format.
///
/// Format:
/// ```text
/// [IndexFileHeader: 32 bytes]
/// [string_table_len: u32 LE]
/// [StringTable: concatenated keys, sorted]
/// [LookupTable: LookupTableEntry x num_keys]
/// [Entries: IndexEntry x total_entries]
/// ```
fn serialize_index(index: &HashMap<String, Vec<IndexEntry>>) -> Result<Vec<u8>> {
    // Sort keys lexicographically for binary search
    let mut keys: Vec<&String> = index.keys().collect();
    keys.sort();

    let total_entries: usize = index.values().map(|v| v.len()).sum();

    let mut buf = Cursor::new(Vec::new());

    // Build string table (concatenated keys)
    let mut string_offsets: Vec<(u32, u16)> = Vec::new();
    let mut string_table = Vec::new();
    for key in &keys {
        let offset = string_table.len() as u32;
        let length = key.len() as u16;
        string_table.extend_from_slice(key.as_bytes());
        string_offsets.push((offset, length));
    }

    // Write header
    let header = IndexFileHeader {
        magic: INDEX_MAGIC,
        version: INDEX_VERSION,
        entry_count: total_entries as u64,
        lookup_count: keys.len() as u32,
        _reserved: [0u8; 12],
    };
    header.write_to(&mut buf)?;

    // Write string table length + data
    buf.write_all(&(string_table.len() as u32).to_le_bytes())?;
    buf.write_all(&string_table)?;

    // Build and write lookup table
    let mut entry_offset: u32 = 0;
    for (i, key) in keys.iter().enumerate() {
        let entries = &index[*key];
        let lookup = LookupTableEntry {
            key_offset: string_offsets[i].0,
            key_length: string_offsets[i].1,
            _padding: 0,
            entry_offset,
            entry_count: entries.len() as u32,
        };
        lookup.write_to(&mut buf)?;
        entry_offset += entries.len() as u32;
    }

    // Write all entries (grouped by key, in sort order)
    for key in &keys {
        let entries = &index[*key];
        IndexEntry::write_batch(entries, &mut buf)?;
    }

    Ok(buf.into_inner())
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::index::query::InvertedIndex;

    fn make_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id,
            node_type: node_type.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    #[test]
    fn test_build_inverted_indexes() {
        let records = vec![
            make_node("fn_a", "FUNCTION", "a", "src/lib.rs"),
            make_node("fn_b", "FUNCTION", "b", "src/lib.rs"),
            make_node("cls_c", "CLASS", "c", "src/main.rs"),
        ];

        let built = build_inverted_indexes(&records, 0, 1).unwrap();

        // Verify by_type index
        let by_type = InvertedIndex::from_bytes(&built.by_type).unwrap();
        assert_eq!(by_type.entry_count(), 3);

        let funcs = by_type.lookup("FUNCTION");
        assert_eq!(funcs.len(), 2);
        assert_eq!(funcs[0].node_id, records[0].id);
        assert_eq!(funcs[1].node_id, records[1].id);
        assert_eq!(funcs[0].shard, 0);
        assert_eq!(funcs[0].segment_id, 1);

        let classes = by_type.lookup("CLASS");
        assert_eq!(classes.len(), 1);
        assert_eq!(classes[0].node_id, records[2].id);

        // Verify by_file index
        let by_file = InvertedIndex::from_bytes(&built.by_file).unwrap();
        assert_eq!(by_file.entry_count(), 3);

        let lib_entries = by_file.lookup("src/lib.rs");
        assert_eq!(lib_entries.len(), 2);

        let main_entries = by_file.lookup("src/main.rs");
        assert_eq!(main_entries.len(), 1);
    }

    #[test]
    fn test_inverted_index_roundtrip() {
        let records = vec![
            make_node("fn_x", "FUNCTION", "x", "a.rs"),
            make_node("fn_y", "METHOD", "y", "b.rs"),
            make_node("fn_z", "FUNCTION", "z", "a.rs"),
        ];

        let built = build_inverted_indexes(&records, 2, 10).unwrap();

        // Deserialize and verify
        let idx = InvertedIndex::from_bytes(&built.by_type).unwrap();
        let keys = idx.keys();
        assert_eq!(keys, vec!["FUNCTION", "METHOD"]);

        let funcs = idx.lookup("FUNCTION");
        assert_eq!(funcs.len(), 2);
        assert_eq!(funcs[0].shard, 2);
        assert_eq!(funcs[0].segment_id, 10);
        assert_eq!(funcs[0].offset, 0); // first record
        assert_eq!(funcs[1].offset, 2); // third record

        let methods = idx.lookup("METHOD");
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].offset, 1); // second record
    }

    #[test]
    fn test_inverted_index_lookup_missing() {
        let records = vec![make_node("fn_a", "FUNCTION", "a", "a.rs")];

        let built = build_inverted_indexes(&records, 0, 1).unwrap();
        let idx = InvertedIndex::from_bytes(&built.by_type).unwrap();

        let missing = idx.lookup("NONEXISTENT");
        assert!(missing.is_empty());
    }

    #[test]
    fn test_build_empty_records() {
        let records: Vec<NodeRecordV2> = vec![];
        let built = build_inverted_indexes(&records, 0, 1).unwrap();

        let idx = InvertedIndex::from_bytes(&built.by_type).unwrap();
        assert_eq!(idx.entry_count(), 0);
        assert!(idx.keys().is_empty());
    }
}
