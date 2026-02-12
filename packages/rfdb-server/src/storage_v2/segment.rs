//! Segment readers for v2 format.
//!
//! Provides `NodeSegmentV2` and `EdgeSegmentV2` for reading immutable
//! columnar segments with memory-mapped or in-memory byte access.

use std::fs::File;
use std::path::Path;

use memmap2::Mmap;

use crate::error::{GraphError, Result};
use crate::storage_v2::bloom::BloomFilter;
use crate::storage_v2::string_table::StringTableV2;
use crate::storage_v2::types::*;
use crate::storage_v2::zone_map::ZoneMap;

// ── Helper Functions ───────────────────────────────────────────────

/// Read u32 from byte slice at offset (little-endian).
#[inline]
fn read_u32_at(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

/// Read u64 from byte slice at offset (little-endian).
#[inline]
fn read_u64_at(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Read u128 from byte slice at offset (little-endian).
#[inline]
fn read_u128_at(data: &[u8], offset: usize) -> u128 {
    u128::from_le_bytes(data[offset..offset + 16].try_into().unwrap())
}

// ── Node Column Offset Computation ────────────────────────────────

/// Compute byte offsets for node segment columns.
///
/// Returns: (semantic_id, node_type, name, file, metadata, ids, content_hash).
fn compute_node_column_offsets(
    record_count: usize,
) -> (usize, usize, usize, usize, usize, usize, usize) {
    let n = record_count;
    let semantic_id_offset = HEADER_SIZE; // 32
    let node_type_offset = semantic_id_offset + 4 * n; // 32 + 4N
    let name_offset = node_type_offset + 4 * n; // 32 + 8N
    let file_offset = name_offset + 4 * n; // 32 + 12N
    let metadata_offset = file_offset + 4 * n; // 32 + 16N
    let u32_end = metadata_offset + 4 * n; // 32 + 20N
    let padding = compute_padding(u32_end, 16);
    let ids_offset = u32_end + padding; // 16-byte aligned
    let content_hash_offset = ids_offset + 16 * n;
    (
        semantic_id_offset,
        node_type_offset,
        name_offset,
        file_offset,
        metadata_offset,
        ids_offset,
        content_hash_offset,
    )
}

// ── Edge Column Offset Computation ─────────────────────────────────

/// Compute byte offsets for edge segment columns.
///
/// Returns: (src, dst, edge_type, metadata).
fn compute_edge_column_offsets(record_count: usize) -> (usize, usize, usize, usize) {
    let n = record_count;
    let src_offset = HEADER_SIZE; // 32
    let dst_offset = src_offset + 16 * n; // 32 + 16N
    let edge_type_offset = dst_offset + 16 * n; // 32 + 32N (always 4-aligned)
    let metadata_offset = edge_type_offset + 4 * n; // 32 + 32N + 4N
    (src_offset, dst_offset, edge_type_offset, metadata_offset)
}

// ── NodeSegmentV2 ──────────────────────────────────────────────────

/// Immutable node segment reader (memory-mapped or from bytes).
#[derive(Debug)]
pub struct NodeSegmentV2 {
    data: Vec<u8>,
    header: SegmentHeaderV2,
    bloom: BloomFilter,
    zone_map: ZoneMap,
    string_table: StringTableV2,

    // Computed column offsets
    semantic_id_offset: usize,
    node_type_offset: usize,
    name_offset: usize,
    file_offset: usize,
    metadata_offset: usize,
    ids_offset: usize,
    content_hash_offset: usize,
}

impl NodeSegmentV2 {
    /// Open a node segment from a file path (memory-mapped).
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).map_err(GraphError::Io)?;
        let mmap = unsafe { Mmap::map(&file) }.map_err(GraphError::Io)?;
        Self::from_bytes(&mmap)
    }

    /// Open a node segment from a byte slice (for testing / embedding).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        // 1. Minimum size check
        if bytes.len() < HEADER_SIZE + FOOTER_INDEX_SIZE {
            return Err(GraphError::InvalidFormat(
                "File too small for v2 segment".into(),
            ));
        }

        // 2. Read and validate header
        let header = SegmentHeaderV2::from_bytes(&bytes[..HEADER_SIZE])?;
        if header.segment_type != SegmentType::Nodes {
            return Err(GraphError::InvalidFormat(
                "Expected node segment, got edge".into(),
            ));
        }

        // 3. Read footer index (last FOOTER_INDEX_SIZE bytes)
        let fi_start = bytes.len() - FOOTER_INDEX_SIZE;
        let footer_index = FooterIndex::from_bytes(&bytes[fi_start..])?;

        // 4. Validate footer_offset
        if header.footer_offset as usize >= bytes.len() {
            return Err(GraphError::InvalidFormat(
                "footer_offset points past end of file".into(),
            ));
        }

        // 5. Validate data_end_offset
        let n = header.record_count as usize;
        let (_, _, _, _, _, _, content_hash_offset) = compute_node_column_offsets(n);
        let expected_data_end = content_hash_offset + 8 * n;
        if footer_index.data_end_offset != expected_data_end as u64 {
            return Err(GraphError::InvalidFormat(
                "data_end_offset does not match column layout".into(),
            ));
        }

        // 6. Load footer components
        let bloom = BloomFilter::from_bytes(
            &bytes[footer_index.bloom_offset as usize..footer_index.zone_maps_offset as usize],
        )?;

        let zone_map = ZoneMap::from_bytes(
            &bytes
                [footer_index.zone_maps_offset as usize..footer_index.string_table_offset as usize],
        )?;

        let string_table = StringTableV2::from_bytes(
            &bytes[footer_index.string_table_offset as usize..header.footer_offset as usize],
        )?;

        // 7. Compute column offsets
        let (
            semantic_id_offset,
            node_type_offset,
            name_offset,
            file_offset,
            metadata_offset,
            ids_offset,
            content_hash_offset,
        ) = compute_node_column_offsets(n);

        Ok(Self {
            data: bytes.to_vec(),
            header,
            bloom,
            zone_map,
            string_table,
            semantic_id_offset,
            node_type_offset,
            name_offset,
            file_offset,
            metadata_offset,
            ids_offset,
            content_hash_offset,
        })
    }

    /// Number of records in the segment.
    pub fn record_count(&self) -> usize {
        self.header.record_count as usize
    }

    // ── Column Accessors (O(1)) ────────────────────────────────────

    /// Get node id (u128) at given index.
    pub fn get_id(&self, index: usize) -> u128 {
        debug_assert!(index < self.record_count(), "index out of bounds");
        let offset = self.ids_offset + index * 16;
        read_u128_at(&self.data, offset)
    }

    /// Get semantic_id string at given index.
    pub fn get_semantic_id(&self, index: usize) -> &str {
        debug_assert!(index < self.record_count(), "index out of bounds");
        self.read_string_at(self.semantic_id_offset, index)
    }

    /// Get node_type string at given index.
    pub fn get_node_type(&self, index: usize) -> &str {
        debug_assert!(index < self.record_count(), "index out of bounds");
        self.read_string_at(self.node_type_offset, index)
    }

    /// Get name string at given index.
    pub fn get_name(&self, index: usize) -> &str {
        debug_assert!(index < self.record_count(), "index out of bounds");
        self.read_string_at(self.name_offset, index)
    }

    /// Get file string at given index.
    pub fn get_file(&self, index: usize) -> &str {
        debug_assert!(index < self.record_count(), "index out of bounds");
        self.read_string_at(self.file_offset, index)
    }

    /// Get content_hash (u64) at given index.
    pub fn get_content_hash(&self, index: usize) -> u64 {
        debug_assert!(index < self.record_count(), "index out of bounds");
        let offset = self.content_hash_offset + index * 8;
        read_u64_at(&self.data, offset)
    }

    /// Get metadata string at given index.
    pub fn get_metadata(&self, index: usize) -> &str {
        debug_assert!(index < self.record_count(), "index out of bounds");
        self.read_string_at(self.metadata_offset, index)
    }

    /// Reconstruct a full record at given index (allocates strings).
    pub fn get_record(&self, index: usize) -> NodeRecordV2 {
        NodeRecordV2 {
            semantic_id: self.get_semantic_id(index).to_string(),
            id: self.get_id(index),
            node_type: self.get_node_type(index).to_string(),
            name: self.get_name(index).to_string(),
            file: self.get_file(index).to_string(),
            content_hash: self.get_content_hash(index),
            metadata: self.get_metadata(index).to_string(),
        }
    }

    // ── Bloom Filter ───────────────────────────────────────────────

    /// Check if the segment might contain a node with this id.
    ///
    /// Returns `false` → definitely not present.
    /// Returns `true`  → probably present (subject to false positive rate).
    pub fn maybe_contains(&self, id: u128) -> bool {
        self.bloom.maybe_contains(id)
    }

    // ── Zone Map ───────────────────────────────────────────────────

    /// Check if the segment contains a given node_type value.
    pub fn contains_node_type(&self, node_type: &str) -> bool {
        self.zone_map.contains("node_type", node_type)
    }

    /// Check if the segment contains a given file path.
    pub fn contains_file(&self, file: &str) -> bool {
        self.zone_map.contains("file", file)
    }

    // ── Iteration ──────────────────────────────────────────────────

    /// Iterate over record indices (0..record_count).
    pub fn iter_indices(&self) -> impl Iterator<Item = usize> {
        0..self.record_count()
    }

    /// Iterate over all records (reconstructs full NodeRecordV2 for each).
    pub fn iter(&self) -> impl Iterator<Item = NodeRecordV2> + '_ {
        (0..self.record_count()).map(move |i| self.get_record(i))
    }

    // ── Internal Helpers ───────────────────────────────────────────

    /// Read a string via string table index stored in a u32 column.
    fn read_string_at(&self, column_offset: usize, index: usize) -> &str {
        let byte_offset = column_offset + index * 4;
        let str_index = read_u32_at(&self.data, byte_offset);
        self.string_table
            .get(str_index)
            .expect("invalid string table index")
    }
}

// ── EdgeSegmentV2 ──────────────────────────────────────────────────

/// Immutable edge segment reader (memory-mapped or from bytes).
#[derive(Debug)]
pub struct EdgeSegmentV2 {
    data: Vec<u8>,
    header: SegmentHeaderV2,
    src_bloom: BloomFilter,
    dst_bloom: BloomFilter,
    zone_map: ZoneMap,
    string_table: StringTableV2,

    src_offset: usize,
    dst_offset: usize,
    edge_type_offset: usize,
    metadata_offset: usize,
}

impl EdgeSegmentV2 {
    /// Open an edge segment from a file path (memory-mapped).
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).map_err(GraphError::Io)?;
        let mmap = unsafe { Mmap::map(&file) }.map_err(GraphError::Io)?;
        Self::from_bytes(&mmap)
    }

    /// Open an edge segment from a byte slice (for testing / embedding).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        // 1. Minimum size check
        if bytes.len() < HEADER_SIZE + FOOTER_INDEX_SIZE {
            return Err(GraphError::InvalidFormat(
                "File too small for v2 segment".into(),
            ));
        }

        // 2. Read and validate header
        let header = SegmentHeaderV2::from_bytes(&bytes[..HEADER_SIZE])?;
        if header.segment_type != SegmentType::Edges {
            return Err(GraphError::InvalidFormat(
                "Expected edge segment, got node".into(),
            ));
        }

        // 3. Read footer index (last FOOTER_INDEX_SIZE bytes)
        let fi_start = bytes.len() - FOOTER_INDEX_SIZE;
        let footer_index = FooterIndex::from_bytes(&bytes[fi_start..])?;

        // 4. Validate footer_offset
        if header.footer_offset as usize >= bytes.len() {
            return Err(GraphError::InvalidFormat(
                "footer_offset points past end of file".into(),
            ));
        }

        // 5. Validate data_end_offset
        let n = header.record_count as usize;
        let (_, _, _, metadata_offset) = compute_edge_column_offsets(n);
        let expected_data_end = metadata_offset + 4 * n;
        if footer_index.data_end_offset != expected_data_end as u64 {
            return Err(GraphError::InvalidFormat(
                "data_end_offset does not match column layout".into(),
            ));
        }

        // 6. Load footer components (TWO bloom filters)
        let src_bloom = BloomFilter::from_bytes(
            &bytes[footer_index.bloom_offset as usize..footer_index.dst_bloom_offset as usize],
        )?;

        let dst_bloom = BloomFilter::from_bytes(
            &bytes[footer_index.dst_bloom_offset as usize..footer_index.zone_maps_offset as usize],
        )?;

        let zone_map = ZoneMap::from_bytes(
            &bytes
                [footer_index.zone_maps_offset as usize..footer_index.string_table_offset as usize],
        )?;

        let string_table = StringTableV2::from_bytes(
            &bytes[footer_index.string_table_offset as usize..header.footer_offset as usize],
        )?;

        // 7. Compute column offsets
        let (src_offset, dst_offset, edge_type_offset, metadata_offset) =
            compute_edge_column_offsets(n);

        Ok(Self {
            data: bytes.to_vec(),
            header,
            src_bloom,
            dst_bloom,
            zone_map,
            string_table,
            src_offset,
            dst_offset,
            edge_type_offset,
            metadata_offset,
        })
    }

    /// Number of records in the segment.
    pub fn record_count(&self) -> usize {
        self.header.record_count as usize
    }

    // ── Column Accessors (O(1)) ────────────────────────────────────

    /// Get source node id (u128) at given index.
    pub fn get_src(&self, index: usize) -> u128 {
        debug_assert!(index < self.record_count(), "index out of bounds");
        let offset = self.src_offset + index * 16;
        read_u128_at(&self.data, offset)
    }

    /// Get destination node id (u128) at given index.
    pub fn get_dst(&self, index: usize) -> u128 {
        debug_assert!(index < self.record_count(), "index out of bounds");
        let offset = self.dst_offset + index * 16;
        read_u128_at(&self.data, offset)
    }

    /// Get edge_type string at given index.
    pub fn get_edge_type(&self, index: usize) -> &str {
        debug_assert!(index < self.record_count(), "index out of bounds");
        self.read_string_at(self.edge_type_offset, index)
    }

    /// Get metadata string at given index.
    pub fn get_metadata(&self, index: usize) -> &str {
        debug_assert!(index < self.record_count(), "index out of bounds");
        self.read_string_at(self.metadata_offset, index)
    }

    /// Reconstruct a full record at given index (allocates strings).
    pub fn get_record(&self, index: usize) -> EdgeRecordV2 {
        EdgeRecordV2 {
            src: self.get_src(index),
            dst: self.get_dst(index),
            edge_type: self.get_edge_type(index).to_string(),
            metadata: self.get_metadata(index).to_string(),
        }
    }

    // ── Bloom Filters ──────────────────────────────────────────────

    /// Check if the segment might contain an edge with this source id.
    pub fn maybe_contains_src(&self, src: u128) -> bool {
        self.src_bloom.maybe_contains(src)
    }

    /// Check if the segment might contain an edge with this destination id.
    pub fn maybe_contains_dst(&self, dst: u128) -> bool {
        self.dst_bloom.maybe_contains(dst)
    }

    // ── Zone Map ───────────────────────────────────────────────────

    /// Check if the segment contains a given edge_type value.
    pub fn contains_edge_type(&self, edge_type: &str) -> bool {
        self.zone_map.contains("edge_type", edge_type)
    }

    // ── Iteration ──────────────────────────────────────────────────

    /// Iterate over record indices (0..record_count).
    pub fn iter_indices(&self) -> impl Iterator<Item = usize> {
        0..self.record_count()
    }

    /// Iterate over all records (reconstructs full EdgeRecordV2 for each).
    pub fn iter(&self) -> impl Iterator<Item = EdgeRecordV2> + '_ {
        (0..self.record_count()).map(move |i| self.get_record(i))
    }

    // ── Internal Helpers ───────────────────────────────────────────

    /// Read a string via string table index stored in a u32 column.
    fn read_string_at(&self, column_offset: usize, index: usize) -> &str {
        let byte_offset = column_offset + index * 4;
        let str_index = read_u32_at(&self.data, byte_offset);
        self.string_table
            .get(str_index)
            .expect("invalid string table index")
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::storage_v2::writer::{EdgeSegmentWriter, NodeSegmentWriter};

    // ── Test Helpers ───────────────────────────────────────────────

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

    fn make_edge(src_id: &str, dst_id: &str, edge_type: &str) -> EdgeRecordV2 {
        let src =
            u128::from_le_bytes(blake3::hash(src_id.as_bytes()).as_bytes()[0..16].try_into().unwrap());
        let dst =
            u128::from_le_bytes(blake3::hash(dst_id.as_bytes()).as_bytes()[0..16].try_into().unwrap());
        EdgeRecordV2 {
            src,
            dst,
            edge_type: edge_type.to_string(),
            metadata: String::new(),
        }
    }

    /// Write nodes to bytes using NodeSegmentWriter.
    fn write_node_segment(records: Vec<NodeRecordV2>) -> Vec<u8> {
        let mut writer = NodeSegmentWriter::new();
        for r in records {
            writer.add(r);
        }
        let mut buf = Cursor::new(Vec::new());
        writer.finish(&mut buf).unwrap();
        buf.into_inner()
    }

    /// Write edges to bytes using EdgeSegmentWriter.
    fn write_edge_segment(records: Vec<EdgeRecordV2>) -> Vec<u8> {
        let mut writer = EdgeSegmentWriter::new();
        for r in records {
            writer.add(r);
        }
        let mut buf = Cursor::new(Vec::new());
        writer.finish(&mut buf).unwrap();
        buf.into_inner()
    }

    // ── Phase 2: Core Roundtrips ───────────────────────────────────

    #[test]
    fn test_empty_node_segment() {
        let bytes = write_node_segment(vec![]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();
        assert_eq!(seg.record_count(), 0);

        // Random IDs should not be found in empty bloom.
        for i in 0..100u128 {
            assert!(!seg.maybe_contains(i));
        }
    }

    #[test]
    fn test_single_node_record() {
        let node = make_node("src/main.rs::main", "FUNCTION", "main", "src/main.rs");
        let bytes = write_node_segment(vec![node.clone()]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.record_count(), 1);
        assert_eq!(seg.get_id(0), node.id);
        assert_eq!(seg.get_semantic_id(0), "src/main.rs::main");
        assert_eq!(seg.get_node_type(0), "FUNCTION");
        assert_eq!(seg.get_name(0), "main");
        assert_eq!(seg.get_file(0), "src/main.rs");
        assert_eq!(seg.get_content_hash(0), 0);
        assert_eq!(seg.get_metadata(0), "");

        let record = seg.get_record(0);
        assert_eq!(record, node);
    }

    #[test]
    fn test_node_roundtrip_100() {
        let mut records = Vec::new();
        for i in 0..100 {
            let node = make_node(
                &format!("node_{}", i),
                if i % 2 == 0 { "FUNCTION" } else { "CLASS" },
                &format!("name_{}", i),
                &format!("file_{}.rs", i % 10),
            );
            records.push(node);
        }

        let bytes = write_node_segment(records.clone());
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.record_count(), 100);
        for (i, expected) in records.iter().enumerate() {
            let record = seg.get_record(i);
            assert_eq!(record, *expected, "mismatch at index {}", i);
        }
    }

    #[test]
    fn test_edge_roundtrip_100() {
        let mut records = Vec::new();
        for i in 0..100 {
            let edge = make_edge(
                &format!("src_{}", i),
                &format!("dst_{}", i),
                if i % 3 == 0 { "CALLS" } else { "IMPORTS_FROM" },
            );
            records.push(edge);
        }

        let bytes = write_edge_segment(records.clone());
        let seg = EdgeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.record_count(), 100);
        for (i, expected) in records.iter().enumerate() {
            let record = seg.get_record(i);
            assert_eq!(record, *expected, "mismatch at index {}", i);
        }
    }

    #[test]
    fn test_semantic_id_u128_derivation() {
        let semantic_id = "src/lib.rs::helper";
        let node = make_node(semantic_id, "FUNCTION", "helper", "src/lib.rs");

        let bytes = write_node_segment(vec![node.clone()]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        let stored_id = seg.get_id(0);
        let expected_id = u128::from_le_bytes(
            blake3::hash(semantic_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        assert_eq!(stored_id, expected_id);
        assert_eq!(stored_id, node.id);
    }

    #[test]
    fn test_content_hash_roundtrip() {
        let mut node = make_node("id", "FUNCTION", "name", "file.rs");
        node.content_hash = 0xdeadbeef_cafebabe;

        let bytes = write_node_segment(vec![node.clone()]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.get_content_hash(0), 0xdeadbeef_cafebabe);
        assert_eq!(seg.get_record(0).content_hash, node.content_hash);
    }

    #[test]
    fn test_empty_edge_segment() {
        let bytes = write_edge_segment(vec![]);
        let seg = EdgeSegmentV2::from_bytes(&bytes).unwrap();
        assert_eq!(seg.record_count(), 0);
    }

    #[test]
    fn test_single_edge_record() {
        let edge = make_edge("src/main.rs::main", "src/lib.rs::helper", "CALLS");
        let bytes = write_edge_segment(vec![edge.clone()]);
        let seg = EdgeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.record_count(), 1);
        assert_eq!(seg.get_src(0), edge.src);
        assert_eq!(seg.get_dst(0), edge.dst);
        assert_eq!(seg.get_edge_type(0), "CALLS");
        assert_eq!(seg.get_metadata(0), "");

        let record = seg.get_record(0);
        assert_eq!(record, edge);
    }

    // ── Phase 3: Alignment + Binary Stability ──────────────────────

    #[test]
    fn test_column_alignment() {
        for n in [0, 1, 2, 3, 7, 8, 15, 16, 100] {
            let mut records = Vec::new();
            for i in 0..n {
                records.push(make_node(&format!("id_{}", i), "TYPE", "name", "file.rs"));
            }

            let bytes = write_node_segment(records);
            let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

            // Verify ids_offset is 16-byte aligned
            assert_eq!(
                seg.ids_offset % 16,
                0,
                "ids_offset misaligned for N={} (offset={})",
                n,
                seg.ids_offset
            );
        }
    }

    #[test]
    fn test_various_record_counts() {
        for n in [0, 1, 2, 3, 7, 8, 15, 16, 100] {
            let mut records = Vec::new();
            for i in 0..n {
                records.push(make_node(&format!("id_{}", i), "TYPE", "name", "file.rs"));
            }

            let bytes = write_node_segment(records.clone());
            let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

            assert_eq!(seg.record_count(), n);
            for (i, expected) in records.iter().enumerate() {
                assert_eq!(seg.get_record(i), *expected);
            }
        }
    }

    #[test]
    fn test_byte_exact_roundtrip() {
        let mut records = Vec::new();
        for i in 0..50 {
            records.push(make_node(&format!("id_{}", i), "FUNCTION", "name", "file.rs"));
        }

        let bytes1 = write_node_segment(records.clone());
        let seg = NodeSegmentV2::from_bytes(&bytes1).unwrap();

        // Write again
        let mut writer = NodeSegmentWriter::new();
        for i in 0..seg.record_count() {
            writer.add(seg.get_record(i));
        }
        let mut buf = Cursor::new(Vec::new());
        writer.finish(&mut buf).unwrap();
        let bytes2 = buf.into_inner();

        assert_eq!(bytes1, bytes2, "Segment not byte-exact after roundtrip");
    }

    // ── Phase 4: Edge Cases ────────────────────────────────────────

    #[test]
    fn test_empty_metadata() {
        let node = make_node("id", "FUNCTION", "name", "file.rs");
        assert_eq!(node.metadata, "");

        let bytes = write_node_segment(vec![node.clone()]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.get_metadata(0), "");
        assert_eq!(seg.get_record(0).metadata, "");
    }

    #[test]
    fn test_unicode_strings() {
        let node = make_node(
            "путь/к/файлу::функция",
            "类型",
            "नाम",
            "ファイル.rs",
        );

        let bytes = write_node_segment(vec![node.clone()]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.get_semantic_id(0), "путь/к/файлу::функция");
        assert_eq!(seg.get_node_type(0), "类型");
        assert_eq!(seg.get_name(0), "नाम");
        assert_eq!(seg.get_file(0), "ファイル.rs");
    }

    #[test]
    fn test_very_long_semantic_id() {
        let long_id = "x".repeat(500);
        let node = make_node(&long_id, "FUNCTION", "name", "file.rs");

        let bytes = write_node_segment(vec![node.clone()]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.get_semantic_id(0), long_id);
    }

    #[test]
    fn test_max_metadata_size() {
        let mut node = make_node("id", "FUNCTION", "name", "file.rs");
        node.metadata = "m".repeat(1_000_000); // 1MB

        let bytes = write_node_segment(vec![node.clone()]);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert_eq!(seg.get_metadata(0).len(), 1_000_000);
        assert_eq!(seg.get_metadata(0), node.metadata);
    }

    // ── Phase 5: Corruption Resilience ─────────────────────────────

    #[test]
    fn test_wrong_magic() {
        let mut bytes = vec![0u8; HEADER_SIZE + FOOTER_INDEX_SIZE];
        bytes[0..4].copy_from_slice(b"XXXX");
        let err = NodeSegmentV2::from_bytes(&bytes).unwrap_err();
        assert!(err.to_string().contains("Not a v2 segment"));
    }

    #[test]
    fn test_v1_magic() {
        let mut bytes = vec![0u8; HEADER_SIZE + FOOTER_INDEX_SIZE];
        bytes[0..4].copy_from_slice(b"SGRF");
        let err = NodeSegmentV2::from_bytes(&bytes).unwrap_err();
        assert!(err.to_string().contains("v1 segment detected"));
    }

    #[test]
    fn test_truncated_file() {
        let node = make_node("id", "FUNCTION", "name", "file.rs");
        let bytes = write_node_segment(vec![node]);
        let truncated = &bytes[..bytes.len() / 2];
        let err = NodeSegmentV2::from_bytes(truncated).unwrap_err();
        let err_msg = err.to_string();
        // Truncated file can cause various errors: too small, footer index too small,
        // truncated bloom/zone map/string table, invalid format
        assert!(
            err_msg.contains("too small")
            || err_msg.contains("truncated")
            || err_msg.contains("Invalid"),
            "unexpected error: {}", err_msg
        );
    }

    #[test]
    fn test_corrupted_footer_offset() {
        let node = make_node("id", "FUNCTION", "name", "file.rs");
        let mut bytes = write_node_segment(vec![node]);

        // Corrupt footer_offset in header (byte 16)
        let bad_offset = (bytes.len() + 100) as u64;
        bytes[16..24].copy_from_slice(&bad_offset.to_le_bytes());

        let err = NodeSegmentV2::from_bytes(&bytes).unwrap_err();
        assert!(err.to_string().contains("footer_offset points past end"));
    }

    #[test]
    fn test_zero_byte_file() {
        let bytes = vec![];
        let err = NodeSegmentV2::from_bytes(&bytes).unwrap_err();
        assert!(err.to_string().contains("File too small"));
    }

    #[test]
    fn test_footer_index_at_eof() {
        // Valid segment should have footer index exactly at EOF - FOOTER_INDEX_SIZE
        let node = make_node("id", "FUNCTION", "name", "file.rs");
        let bytes = write_node_segment(vec![node]);

        let fi_start = bytes.len() - FOOTER_INDEX_SIZE;
        let footer = FooterIndex::from_bytes(&bytes[fi_start..]).unwrap();
        assert!(footer.bloom_offset > 0);
        assert!(footer.zone_maps_offset > 0);
        assert!(footer.string_table_offset > 0);
        assert!(footer.data_end_offset > 0);
    }

    // ── Phase 6: Bloom Through Segment ─────────────────────────────

    #[test]
    fn test_bloom_no_false_negatives_via_segment() {
        let mut records = Vec::new();
        for i in 0..200 {
            records.push(make_node(&format!("node_{}", i), "FUNCTION", "name", "file.rs"));
        }

        let bytes = write_node_segment(records.clone());
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        // All inserted IDs must be found
        for record in &records {
            assert!(
                seg.maybe_contains(record.id),
                "false negative for id {}",
                record.id
            );
        }
    }

    #[test]
    fn test_dst_bloom_no_false_negatives() {
        let mut records = Vec::new();
        for i in 0..200 {
            records.push(make_edge(&format!("src_{}", i), &format!("dst_{}", i), "CALLS"));
        }

        let bytes = write_edge_segment(records.clone());
        let seg = EdgeSegmentV2::from_bytes(&bytes).unwrap();

        // All destination IDs must be found
        for record in &records {
            assert!(
                seg.maybe_contains_dst(record.dst),
                "false negative for dst {}",
                record.dst
            );
        }
    }

    #[test]
    fn test_dst_bloom_independent() {
        let mut records = Vec::new();
        for i in 0..100 {
            records.push(make_edge(&format!("src_{}", i), &format!("dst_{}", i), "CALLS"));
        }

        let bytes = write_edge_segment(records.clone());
        let seg = EdgeSegmentV2::from_bytes(&bytes).unwrap();

        // Some dst IDs should NOT be found in src bloom (with high probability)
        let mut src_mismatch_count = 0;
        for record in &records {
            if !seg.maybe_contains_src(record.dst) {
                src_mismatch_count += 1;
            }
        }

        // Expect at least 50% of dst IDs not found in src bloom (independent sets)
        assert!(
            src_mismatch_count > 40,
            "dst bloom appears to overlap with src bloom (only {} mismatches)",
            src_mismatch_count
        );
    }

    // ── Phase 7: Zone Map Through Segment ──────────────────────────

    #[test]
    fn test_segment_contains_node_type() {
        let mut records = Vec::new();
        records.push(make_node("id1", "FUNCTION", "name", "file.rs"));
        records.push(make_node("id2", "CLASS", "name", "file.rs"));

        let bytes = write_node_segment(records);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert!(seg.contains_node_type("FUNCTION"));
        assert!(seg.contains_node_type("CLASS"));
        assert!(!seg.contains_node_type("METHOD"));
    }

    #[test]
    fn test_segment_contains_file() {
        let mut records = Vec::new();
        records.push(make_node("id1", "FUNCTION", "name", "src/main.rs"));
        records.push(make_node("id2", "FUNCTION", "name", "src/lib.rs"));

        let bytes = write_node_segment(records);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        assert!(seg.contains_file("src/main.rs"));
        assert!(seg.contains_file("src/lib.rs"));
        assert!(!seg.contains_file("src/other.rs"));
    }

    #[test]
    fn test_segment_contains_edge_type() {
        let mut records = Vec::new();
        records.push(make_edge("src1", "dst1", "CALLS"));
        records.push(make_edge("src2", "dst2", "IMPORTS_FROM"));

        let bytes = write_edge_segment(records);
        let seg = EdgeSegmentV2::from_bytes(&bytes).unwrap();

        assert!(seg.contains_edge_type("CALLS"));
        assert!(seg.contains_edge_type("IMPORTS_FROM"));
        assert!(!seg.contains_edge_type("EXTENDS"));
    }

    // ── Iterator Tests ─────────────────────────────────────────────

    #[test]
    fn test_iter_indices() {
        let mut records = Vec::new();
        for i in 0..50 {
            records.push(make_node(&format!("node_{}", i), "FUNCTION", "name", "file.rs"));
        }

        let bytes = write_node_segment(records);
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        let indices: Vec<usize> = seg.iter_indices().collect();
        assert_eq!(indices.len(), 50);
        assert_eq!(indices, (0..50).collect::<Vec<_>>());
    }

    #[test]
    fn test_iter_records() {
        let mut records = Vec::new();
        for i in 0..50 {
            records.push(make_node(&format!("node_{}", i), "FUNCTION", "name", "file.rs"));
        }

        let bytes = write_node_segment(records.clone());
        let seg = NodeSegmentV2::from_bytes(&bytes).unwrap();

        let iter_records: Vec<NodeRecordV2> = seg.iter().collect();
        assert_eq!(iter_records.len(), 50);
        assert_eq!(iter_records, records);
    }

    // ── File-Based Open (mmap) ─────────────────────────────────────

    #[test]
    fn test_open_from_file() {
        use tempfile::NamedTempFile;

        let node = make_node("id", "FUNCTION", "name", "file.rs");
        let bytes = write_node_segment(vec![node.clone()]);

        let mut temp = NamedTempFile::new().unwrap();
        use std::io::Write;
        temp.write_all(&bytes).unwrap();
        temp.flush().unwrap();

        let seg = NodeSegmentV2::open(temp.path()).unwrap();
        assert_eq!(seg.record_count(), 1);
        assert_eq!(seg.get_record(0), node);
    }
}
