//! Segment writers for v2 format.
//!
//! Provides `NodeSegmentWriter` and `EdgeSegmentWriter` for creating immutable
//! columnar segments with bloom filters, zone maps, and string tables.

use std::collections::HashSet;
use std::io::{Write, Seek, SeekFrom};

use crate::error::Result;
use crate::storage_v2::bloom::BloomFilter;
use crate::storage_v2::string_table::StringTableV2;
use crate::storage_v2::types::*;
use crate::storage_v2::zone_map::ZoneMap;

// ── NodeSegmentWriter ──────────────────────────────────────────────

/// Writer for node segments (SegmentType::Nodes).
///
/// Accumulates node records in memory, then writes them in columnar format
/// with associated indexes (bloom filter, zone map, string table) on `finish()`.
pub struct NodeSegmentWriter {
    records: Vec<NodeRecordV2>,
}

impl NodeSegmentWriter {
    /// Create a new empty node segment writer.
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
        }
    }

    /// Add a node record to the segment.
    ///
    /// IMPORTANT: The caller must ensure `record.id` matches
    /// `blake3::hash(semantic_id)`. This is verified in debug builds.
    pub fn add(&mut self, record: NodeRecordV2) {
        #[cfg(debug_assertions)]
        {
            let hash = blake3::hash(record.semantic_id.as_bytes());
            let expected_id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
            debug_assert_eq!(
                record.id, expected_id,
                "NodeRecordV2.id must be blake3(semantic_id)"
            );
        }
        self.records.push(record);
    }

    /// Number of records in the segment.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Whether the segment contains no records.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Write the segment to the writer. Consumes self.
    ///
    /// Returns `SegmentMeta` with record count, byte size, and metadata
    /// extracted from the records (node_types, file_paths).
    ///
    /// ## Binary layout
    ///
    /// ```text
    /// [Header 32 bytes]
    /// [semantic_id indices: u32 × N]
    /// [node_type indices: u32 × N]
    /// [name indices: u32 × N]
    /// [file indices: u32 × N]
    /// [metadata indices: u32 × N]
    /// [padding to 16-byte boundary: 0x00 bytes]
    /// [id column: u128 × N]
    /// [content_hash column: u64 × N]
    /// [bloom filter]
    /// [zone map]
    /// [string table]
    /// [footer index 48 bytes]
    /// ```
    pub fn finish<W: Write + Seek>(self, writer: &mut W) -> Result<SegmentMeta> {
        let n = self.records.len();

        // Step 1: Build column arrays + intern strings.
        let mut string_table = StringTableV2::new();
        let mut semantic_id_indices: Vec<u32> = Vec::with_capacity(n);
        let mut node_type_indices: Vec<u32> = Vec::with_capacity(n);
        let mut name_indices: Vec<u32> = Vec::with_capacity(n);
        let mut file_indices: Vec<u32> = Vec::with_capacity(n);
        let mut metadata_indices: Vec<u32> = Vec::with_capacity(n);
        let mut ids: Vec<u128> = Vec::with_capacity(n);
        let mut content_hashes: Vec<u64> = Vec::with_capacity(n);

        let mut zone_map = ZoneMap::new();
        let mut node_types_set = HashSet::new();
        let mut file_paths_set = HashSet::new();

        for record in &self.records {
            semantic_id_indices.push(string_table.intern(&record.semantic_id));
            node_type_indices.push(string_table.intern(&record.node_type));
            name_indices.push(string_table.intern(&record.name));
            file_indices.push(string_table.intern(&record.file));
            metadata_indices.push(string_table.intern(&record.metadata));
            ids.push(record.id);
            content_hashes.push(record.content_hash);

            zone_map.add("node_type", &record.node_type);
            zone_map.add("file", &record.file);
            node_types_set.insert(record.node_type.clone());
            file_paths_set.insert(record.file.clone());
        }

        // Step 2: Build bloom filter.
        let mut bloom = BloomFilter::new(n);
        for &id in &ids {
            bloom.insert(id);
        }

        // Step 3: Write header with placeholder footer_offset=0.
        let header = SegmentHeaderV2::new(SegmentType::Nodes, n as u64, 0);
        header.write_to(writer)?;

        // Step 4: Write u32 columns (5 × N values).
        for &idx in &semantic_id_indices {
            writer.write_all(&idx.to_le_bytes())?;
        }
        for &idx in &node_type_indices {
            writer.write_all(&idx.to_le_bytes())?;
        }
        for &idx in &name_indices {
            writer.write_all(&idx.to_le_bytes())?;
        }
        for &idx in &file_indices {
            writer.write_all(&idx.to_le_bytes())?;
        }
        for &idx in &metadata_indices {
            writer.write_all(&idx.to_le_bytes())?;
        }

        // Step 5: Padding to 16-byte boundary (0x00 bytes).
        let current_offset = HEADER_SIZE + 20 * n;
        let padding = compute_padding(current_offset, 16);
        // Use stack buffer, not heap allocation.
        writer.write_all(&[0u8; 16][..padding])?;

        // Step 6: Write u128 column (ids).
        for &id in &ids {
            writer.write_all(&id.to_le_bytes())?;
        }

        // Step 7: Write u64 column (content_hash).
        for &hash in &content_hashes {
            writer.write_all(&hash.to_le_bytes())?;
        }

        // Record data_end_offset.
        let data_end_offset = writer.stream_position()?;

        // Step 8: Write footer sections.
        let bloom_offset = writer.stream_position()?;
        bloom.write_to(writer)?;

        let dst_bloom_offset = 0u64; // No dst bloom for nodes.

        let zone_maps_offset = writer.stream_position()?;
        zone_map.write_to(writer)?;

        let string_table_offset = writer.stream_position()?;
        string_table.write_to(writer)?;

        // Step 9: Write footer index.
        let footer_offset = writer.stream_position()?;
        let footer_index = FooterIndex {
            bloom_offset,
            dst_bloom_offset,
            zone_maps_offset,
            string_table_offset,
            data_end_offset,
            footer_index_size: FOOTER_INDEX_SIZE as u32,
            magic: FOOTER_INDEX_MAGIC,
        };
        footer_index.write_to(writer)?;

        let total_size = writer.stream_position()?;

        // Step 10: Seek back to header byte 16, update footer_offset.
        writer.seek(SeekFrom::Start(16))?;
        writer.write_all(&footer_offset.to_le_bytes())?;

        // Step 11: Flush.
        writer.flush()?;

        Ok(SegmentMeta {
            record_count: n as u64,
            byte_size: total_size,
            segment_type: SegmentType::Nodes,
            node_types: node_types_set,
            file_paths: file_paths_set,
            edge_types: HashSet::new(),
        })
    }
}

impl Default for NodeSegmentWriter {
    fn default() -> Self {
        Self::new()
    }
}

// ── EdgeSegmentWriter ──────────────────────────────────────────────

/// Writer for edge segments (SegmentType::Edges).
///
/// Accumulates edge records in memory, then writes them in columnar format
/// with associated indexes (src bloom, dst bloom, zone map, string table)
/// on `finish()`.
pub struct EdgeSegmentWriter {
    records: Vec<EdgeRecordV2>,
}

impl EdgeSegmentWriter {
    /// Create a new empty edge segment writer.
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
        }
    }

    /// Add an edge record to the segment.
    pub fn add(&mut self, record: EdgeRecordV2) {
        self.records.push(record);
    }

    /// Number of records in the segment.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Whether the segment contains no records.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Write the segment to the writer. Consumes self.
    ///
    /// Returns `SegmentMeta` with record count, byte size, and metadata
    /// extracted from the records (edge_types).
    ///
    /// ## Binary layout
    ///
    /// ```text
    /// [Header 32 bytes]
    /// [src column: u128 × N]
    /// [dst column: u128 × N]
    /// [edge_type indices: u32 × N]
    /// [metadata indices: u32 × N]
    /// [src bloom filter]
    /// [dst bloom filter]
    /// [zone map]
    /// [string table]
    /// [footer index 48 bytes]
    /// ```
    pub fn finish<W: Write + Seek>(self, writer: &mut W) -> Result<SegmentMeta> {
        let n = self.records.len();

        // Step 1: Build column arrays + intern strings.
        let mut string_table = StringTableV2::new();
        let mut srcs: Vec<u128> = Vec::with_capacity(n);
        let mut dsts: Vec<u128> = Vec::with_capacity(n);
        let mut edge_type_indices: Vec<u32> = Vec::with_capacity(n);
        let mut metadata_indices: Vec<u32> = Vec::with_capacity(n);

        let mut zone_map = ZoneMap::new();
        let mut edge_types_set = HashSet::new();

        for record in &self.records {
            srcs.push(record.src);
            dsts.push(record.dst);
            edge_type_indices.push(string_table.intern(&record.edge_type));
            metadata_indices.push(string_table.intern(&record.metadata));

            zone_map.add("edge_type", &record.edge_type);
            edge_types_set.insert(record.edge_type.clone());
        }

        // Step 2: Build bloom filters (src and dst).
        let mut bloom = BloomFilter::new(n);
        for &src in &srcs {
            bloom.insert(src);
        }

        let mut dst_bloom = BloomFilter::new(n);
        for &dst in &dsts {
            dst_bloom.insert(dst);
        }

        // Step 3: Write header with placeholder footer_offset=0.
        let header = SegmentHeaderV2::new(SegmentType::Edges, n as u64, 0);
        header.write_to(writer)?;

        // Step 4: Write u128 columns (src, dst).
        for &src in &srcs {
            writer.write_all(&src.to_le_bytes())?;
        }
        for &dst in &dsts {
            writer.write_all(&dst.to_le_bytes())?;
        }

        // Step 5: Write u32 columns (edge_type, metadata).
        // No padding needed: 32 + 32N is always 4-byte aligned.
        for &idx in &edge_type_indices {
            writer.write_all(&idx.to_le_bytes())?;
        }
        for &idx in &metadata_indices {
            writer.write_all(&idx.to_le_bytes())?;
        }

        // Record data_end_offset.
        let data_end_offset = writer.stream_position()?;

        // Step 6: Write footer sections.
        let bloom_offset = writer.stream_position()?;
        bloom.write_to(writer)?;

        let dst_bloom_offset = writer.stream_position()?;
        dst_bloom.write_to(writer)?;

        let zone_maps_offset = writer.stream_position()?;
        zone_map.write_to(writer)?;

        let string_table_offset = writer.stream_position()?;
        string_table.write_to(writer)?;

        // Step 7: Write footer index.
        let footer_offset = writer.stream_position()?;
        let footer_index = FooterIndex {
            bloom_offset,
            dst_bloom_offset,
            zone_maps_offset,
            string_table_offset,
            data_end_offset,
            footer_index_size: FOOTER_INDEX_SIZE as u32,
            magic: FOOTER_INDEX_MAGIC,
        };
        footer_index.write_to(writer)?;

        let total_size = writer.stream_position()?;

        // Step 8: Seek back to header byte 16, update footer_offset.
        writer.seek(SeekFrom::Start(16))?;
        writer.write_all(&footer_offset.to_le_bytes())?;

        // Step 9: Flush.
        writer.flush()?;

        Ok(SegmentMeta {
            record_count: n as u64,
            byte_size: total_size,
            segment_type: SegmentType::Edges,
            node_types: HashSet::new(),
            file_paths: HashSet::new(),
            edge_types: edge_types_set,
        })
    }
}

impl Default for EdgeSegmentWriter {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn make_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let bytes = hash.as_bytes();
        let id = u128::from_le_bytes(bytes[0..16].try_into().unwrap());
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

    fn make_edge(src_id: &str, dst_id: &str, edge_type: &str) -> EdgeRecordV2 {
        let src_hash = blake3::hash(src_id.as_bytes());
        let dst_hash = blake3::hash(dst_id.as_bytes());
        EdgeRecordV2 {
            src: u128::from_le_bytes(src_hash.as_bytes()[0..16].try_into().unwrap()),
            dst: u128::from_le_bytes(dst_hash.as_bytes()[0..16].try_into().unwrap()),
            edge_type: edge_type.to_string(),
            metadata: String::new(),
        }
    }

    #[test]
    fn test_write_empty_node_segment() {
        let writer = NodeSegmentWriter::new();
        assert_eq!(writer.len(), 0);
        assert!(writer.is_empty());

        let mut buf = Cursor::new(Vec::new());
        let meta = writer.finish(&mut buf).unwrap();

        assert_eq!(meta.record_count, 0);
        assert_eq!(meta.segment_type, SegmentType::Nodes);
        assert!(meta.node_types.is_empty());
        assert!(meta.file_paths.is_empty());

        // Verify header fields.
        let bytes = buf.into_inner();
        assert!(bytes.len() >= HEADER_SIZE);
        assert_eq!(&bytes[0..4], b"SGV2");
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), FORMAT_VERSION);
        assert_eq!(bytes[6], SegmentType::Nodes as u8);
        let record_count = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        assert_eq!(record_count, 0);
        let footer_offset = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        assert!(footer_offset > 0, "footer_offset must be updated");
    }

    #[test]
    fn test_write_single_node() {
        let mut writer = NodeSegmentWriter::new();
        let node = make_node("src/main.rs::main", "FUNCTION", "main", "src/main.rs");
        writer.add(node);

        let mut buf = Cursor::new(Vec::new());
        let meta = writer.finish(&mut buf).unwrap();

        assert_eq!(meta.record_count, 1);
        assert_eq!(meta.segment_type, SegmentType::Nodes);
        assert_eq!(meta.node_types.len(), 1);
        assert!(meta.node_types.contains("FUNCTION"));
        assert_eq!(meta.file_paths.len(), 1);
        assert!(meta.file_paths.contains("src/main.rs"));

        // Verify header.
        let bytes = buf.into_inner();
        assert_eq!(&bytes[0..4], b"SGV2");
        let record_count = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        assert_eq!(record_count, 1);
        let footer_offset = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        assert!(footer_offset > HEADER_SIZE as u64);

        // Verify footer index is present at the specified offset.
        let footer_start = footer_offset as usize;
        assert!(bytes.len() >= footer_start + FOOTER_INDEX_SIZE);
        let footer_bytes = &bytes[footer_start..footer_start + FOOTER_INDEX_SIZE];
        let footer = FooterIndex::from_bytes(footer_bytes).unwrap();
        assert_eq!(footer.magic, FOOTER_INDEX_MAGIC);
        assert_eq!(footer.dst_bloom_offset, 0); // nodes have no dst bloom
    }

    #[test]
    fn test_write_empty_edge_segment() {
        let writer = EdgeSegmentWriter::new();
        assert_eq!(writer.len(), 0);
        assert!(writer.is_empty());

        let mut buf = Cursor::new(Vec::new());
        let meta = writer.finish(&mut buf).unwrap();

        assert_eq!(meta.record_count, 0);
        assert_eq!(meta.segment_type, SegmentType::Edges);
        assert!(meta.edge_types.is_empty());

        // Verify header fields.
        let bytes = buf.into_inner();
        assert_eq!(&bytes[0..4], b"SGV2");
        assert_eq!(bytes[6], SegmentType::Edges as u8);
        let record_count = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        assert_eq!(record_count, 0);
        let footer_offset = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        assert!(footer_offset > 0);
    }

    #[test]
    fn test_write_single_edge() {
        let mut writer = EdgeSegmentWriter::new();
        let edge = make_edge("src/main.rs::main", "src/lib.rs::helper", "CALLS");
        writer.add(edge);

        let mut buf = Cursor::new(Vec::new());
        let meta = writer.finish(&mut buf).unwrap();

        assert_eq!(meta.record_count, 1);
        assert_eq!(meta.segment_type, SegmentType::Edges);
        assert_eq!(meta.edge_types.len(), 1);
        assert!(meta.edge_types.contains("CALLS"));

        // Verify header.
        let bytes = buf.into_inner();
        assert_eq!(&bytes[0..4], b"SGV2");
        let record_count = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        assert_eq!(record_count, 1);
        let footer_offset = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        assert!(footer_offset > HEADER_SIZE as u64);

        // Verify footer index.
        let footer_start = footer_offset as usize;
        assert!(bytes.len() >= footer_start + FOOTER_INDEX_SIZE);
        let footer_bytes = &bytes[footer_start..footer_start + FOOTER_INDEX_SIZE];
        let footer = FooterIndex::from_bytes(footer_bytes).unwrap();
        assert_eq!(footer.magic, FOOTER_INDEX_MAGIC);
        assert!(footer.dst_bloom_offset > 0); // edges have dst bloom
    }

    #[test]
    fn test_write_multiple_nodes() {
        let mut writer = NodeSegmentWriter::new();
        for i in 0..100 {
            let node = make_node(
                &format!("node_{}", i),
                if i % 2 == 0 { "FUNCTION" } else { "CLASS" },
                &format!("name_{}", i),
                &format!("file_{}.rs", i % 10),
            );
            writer.add(node);
        }

        let mut buf = Cursor::new(Vec::new());
        let meta = writer.finish(&mut buf).unwrap();

        assert_eq!(meta.record_count, 100);
        assert_eq!(meta.node_types.len(), 2);
        assert!(meta.node_types.contains("FUNCTION"));
        assert!(meta.node_types.contains("CLASS"));
        assert_eq!(meta.file_paths.len(), 10); // files 0..9
        assert!(meta.byte_size > 0);
    }

    #[test]
    fn test_write_multiple_edges() {
        let mut writer = EdgeSegmentWriter::new();
        for i in 0..100 {
            let edge = make_edge(
                &format!("src_{}", i),
                &format!("dst_{}", i),
                if i % 3 == 0 { "CALLS" } else { "IMPORTS_FROM" },
            );
            writer.add(edge);
        }

        let mut buf = Cursor::new(Vec::new());
        let meta = writer.finish(&mut buf).unwrap();

        assert_eq!(meta.record_count, 100);
        assert_eq!(meta.edge_types.len(), 2);
        assert!(meta.edge_types.contains("CALLS"));
        assert!(meta.edge_types.contains("IMPORTS_FROM"));
        assert!(meta.byte_size > 0);
    }

    #[test]
    fn test_write_node_column_alignment() {
        // Verify u128 column starts at 16-byte boundary for various N.
        for n in [0, 1, 2, 3, 4, 5] {
            let mut writer = NodeSegmentWriter::new();
            for i in 0..n {
                writer.add(make_node(&format!("id_{}", i), "TYPE", "name", "file.rs"));
            }

            let mut buf = Cursor::new(Vec::new());
            writer.finish(&mut buf).unwrap();

            let bytes = buf.into_inner();
            // u32 section: 20 * n bytes starting at offset 32.
            let u32_end = HEADER_SIZE + 20 * n;
            let padding = compute_padding(u32_end, 16);
            let ids_start = u32_end + padding;

            // Verify alignment.
            assert_eq!(
                ids_start % 16,
                0,
                "u128 column misaligned for N={} (offset={})",
                n,
                ids_start
            );

            // Verify padding bytes are 0x00.
            if padding > 0 {
                let padding_bytes = &bytes[u32_end..ids_start];
                assert!(
                    padding_bytes.iter().all(|&b| b == 0x00),
                    "padding contains non-zero bytes for N={}",
                    n
                );
            }
        }
    }

    #[test]
    fn test_write_padding_is_zeroes() {
        // N=1: u32_end=52, padding=12, ids_start=64.
        let mut writer = NodeSegmentWriter::new();
        writer.add(make_node("id_0", "TYPE", "name", "file.rs"));

        let mut buf = Cursor::new(Vec::new());
        writer.finish(&mut buf).unwrap();

        let bytes = buf.into_inner();
        let u32_end = HEADER_SIZE + 20 * 1; // 52
        let padding = compute_padding(u32_end, 16); // 12
        assert_eq!(padding, 12);

        let padding_bytes = &bytes[u32_end..u32_end + padding];
        assert_eq!(padding_bytes.len(), 12);
        assert!(
            padding_bytes.iter().all(|&b| b == 0x00),
            "padding not all zeroes: {:?}",
            padding_bytes
        );
    }

    #[test]
    fn test_write_footer_offset_updated() {
        let mut writer = NodeSegmentWriter::new();
        writer.add(make_node("id_0", "TYPE", "name", "file.rs"));

        let mut buf = Cursor::new(Vec::new());
        writer.finish(&mut buf).unwrap();

        let bytes = buf.into_inner();
        // Read footer_offset from header at byte 16.
        let footer_offset = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        assert!(footer_offset > 0, "footer_offset not updated in header");

        // Verify footer index is actually at that offset.
        let footer_start = footer_offset as usize;
        assert!(bytes.len() >= footer_start + FOOTER_INDEX_SIZE);
        let footer_bytes = &bytes[footer_start..footer_start + FOOTER_INDEX_SIZE];
        let footer = FooterIndex::from_bytes(footer_bytes).unwrap();
        assert_eq!(footer.magic, FOOTER_INDEX_MAGIC);
    }

    #[test]
    fn test_node_segment_default() {
        let writer = NodeSegmentWriter::default();
        assert_eq!(writer.len(), 0);
    }

    #[test]
    fn test_edge_segment_default() {
        let writer = EdgeSegmentWriter::default();
        assert_eq!(writer.len(), 0);
    }
}
