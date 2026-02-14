//! V2 segment format types and constants.
//!
//! Defines the binary layout for immutable columnar segments — the atomic
//! building block of RFDB v2 storage.

use std::collections::HashSet;
use std::io::Write;

use serde::{Deserialize, Serialize};

use crate::error::{GraphError, Result};

// ── Constants ──────────────────────────────────────────────────────

/// Magic bytes for v2 segment files (distinct from v1 "SGRF")
pub const MAGIC_V2: [u8; 4] = *b"SGV2";

/// Magic bytes for v1 segments (used in error detection)
pub const MAGIC_V1: [u8; 4] = *b"SGRF";

/// Format version
pub const FORMAT_VERSION: u16 = 2;

/// Header size in bytes (fixed, power-of-2, cache-line friendly)
pub const HEADER_SIZE: usize = 32;

/// Footer index magic (ASCII "FTR2")
pub const FOOTER_INDEX_MAGIC: u32 = 0x4654_5232;

/// Footer index size in bytes: 5 * u64 + u32(size) + u32(magic) = 48 bytes
/// Self-describing: footer_index_size field allows future extension.
pub const FOOTER_INDEX_SIZE: usize = 48;

/// Bloom filter: bits per key (10 → ~0.82% FPR with k=7)
pub const BLOOM_BITS_PER_KEY: usize = 10;

/// Bloom filter: number of hash functions (optimal for 10 bits/key)
pub const BLOOM_NUM_HASHES: usize = 7;

/// Zone map: max distinct values per field before omitting
/// (Condition 2 from Steve Jobs review — prevents pathological zone maps)
pub const MAX_ZONE_MAP_VALUES_PER_FIELD: usize = 10_000;

// ── Segment Type ───────────────────────────────────────────────────

/// Type of segment (stored as u8 in header)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum SegmentType {
    Nodes = 0,
    Edges = 1,
}

impl SegmentType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Nodes),
            1 => Some(Self::Edges),
            _ => None,
        }
    }
}

// ── Header ─────────────────────────────────────────────────────────

/// V2 segment header — exactly 32 bytes on disk.
///
/// ```text
/// Offset  Size  Field
/// 0       4     magic: b"SGV2"
/// 4       2     version: u16 = 2
/// 6       1     segment_type: u8
/// 7       1     reserved: 0x00
/// 8       8     record_count: u64
/// 16      8     footer_offset: u64
/// 24      8     reserved: 0x00
/// ```
#[derive(Debug, Clone, Copy)]
pub struct SegmentHeaderV2 {
    pub magic: [u8; 4],
    pub version: u16,
    pub segment_type: SegmentType,
    pub record_count: u64,
    pub footer_offset: u64,
}

impl SegmentHeaderV2 {
    pub fn new(segment_type: SegmentType, record_count: u64, footer_offset: u64) -> Self {
        Self {
            magic: MAGIC_V2,
            version: FORMAT_VERSION,
            segment_type,
            record_count,
            footer_offset,
        }
    }

    /// Validate header fields. Returns specific errors for v1 segments.
    pub fn validate(&self) -> Result<()> {
        if self.magic == MAGIC_V1 {
            return Err(GraphError::InvalidFormat(
                "v1 segment detected (SGRF). Use migration tool.".into(),
            ));
        }
        if self.magic != MAGIC_V2 {
            return Err(GraphError::InvalidFormat(format!(
                "Not a v2 segment: expected SGV2, got {:?}",
                self.magic
            )));
        }
        if self.version != FORMAT_VERSION {
            return Err(GraphError::InvalidFormat(format!(
                "Unsupported segment version: {}",
                self.version
            )));
        }
        Ok(())
    }

    /// Parse header from byte slice (>= HEADER_SIZE bytes).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_SIZE {
            return Err(GraphError::InvalidFormat(
                "File too small for v2 segment".into(),
            ));
        }
        let mut magic = [0u8; 4];
        magic.copy_from_slice(&bytes[0..4]);
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        let segment_type_u8 = bytes[6];
        let segment_type = SegmentType::from_u8(segment_type_u8).ok_or_else(|| {
            GraphError::InvalidFormat(format!("Unknown segment type: {}", segment_type_u8))
        })?;
        let record_count = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let footer_offset = u64::from_le_bytes(bytes[16..24].try_into().unwrap());

        let header = Self {
            magic,
            version,
            segment_type,
            record_count,
            footer_offset,
        };
        header.validate()?;
        Ok(header)
    }

    /// Write header to writer (exactly HEADER_SIZE bytes).
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()> {
        writer.write_all(&self.magic)?;
        writer.write_all(&self.version.to_le_bytes())?;
        writer.write_all(&[self.segment_type as u8])?;
        writer.write_all(&[0u8])?; // reserved
        writer.write_all(&self.record_count.to_le_bytes())?;
        writer.write_all(&self.footer_offset.to_le_bytes())?;
        writer.write_all(&[0u8; 8])?; // reserved
        Ok(())
    }
}

// ── Footer Index ───────────────────────────────────────────────────

/// Footer index — last FOOTER_INDEX_SIZE bytes before EOF.
///
/// Self-describing via `footer_index_size` field (Condition 1 from Steve Jobs
/// review). Future versions add fields before `footer_index_size` and increase
/// the size value. Old readers can detect unknown sizes and error gracefully.
///
/// ```text
/// Offset  Size  Field
/// +0      8     bloom_offset: u64
/// +8      8     dst_bloom_offset: u64 (0 for node segments)
/// +16     8     zone_maps_offset: u64
/// +24     8     string_table_offset: u64
/// +32     8     data_end_offset: u64
/// +40     4     footer_index_size: u32 (= 48 for v1)
/// +44     4     magic: u32 = 0x46545232 ("FTR2")
/// ```
#[derive(Debug, Clone, Copy)]
pub struct FooterIndex {
    pub bloom_offset: u64,
    pub dst_bloom_offset: u64,
    pub zone_maps_offset: u64,
    pub string_table_offset: u64,
    pub data_end_offset: u64,
    pub footer_index_size: u32,
    pub magic: u32,
}

impl FooterIndex {
    /// Parse footer index from byte slice (>= FOOTER_INDEX_SIZE bytes).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < FOOTER_INDEX_SIZE {
            return Err(GraphError::InvalidFormat(
                "Footer index too small".into(),
            ));
        }
        let bloom_offset = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let dst_bloom_offset = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let zone_maps_offset = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let string_table_offset = u64::from_le_bytes(bytes[24..32].try_into().unwrap());
        let data_end_offset = u64::from_le_bytes(bytes[32..40].try_into().unwrap());
        let footer_index_size = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
        let magic = u32::from_le_bytes(bytes[44..48].try_into().unwrap());

        if magic != FOOTER_INDEX_MAGIC {
            return Err(GraphError::InvalidFormat(
                "Invalid footer index magic".into(),
            ));
        }
        if (footer_index_size as usize) < FOOTER_INDEX_SIZE {
            return Err(GraphError::InvalidFormat(format!(
                "Footer index size too small: {}",
                footer_index_size
            )));
        }
        // Future: if footer_index_size > FOOTER_INDEX_SIZE, we still read
        // the known fields and ignore extra bytes. Forward-compatible.

        Ok(Self {
            bloom_offset,
            dst_bloom_offset,
            zone_maps_offset,
            string_table_offset,
            data_end_offset,
            footer_index_size,
            magic,
        })
    }

    /// Write footer index to writer (exactly FOOTER_INDEX_SIZE bytes).
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()> {
        writer.write_all(&self.bloom_offset.to_le_bytes())?;
        writer.write_all(&self.dst_bloom_offset.to_le_bytes())?;
        writer.write_all(&self.zone_maps_offset.to_le_bytes())?;
        writer.write_all(&self.string_table_offset.to_le_bytes())?;
        writer.write_all(&self.data_end_offset.to_le_bytes())?;
        writer.write_all(&self.footer_index_size.to_le_bytes())?;
        writer.write_all(&self.magic.to_le_bytes())?;
        Ok(())
    }
}

// ── Record Types ───────────────────────────────────────────────────

/// Node record for v2 storage.
///
/// Key differences from v1:
/// - `semantic_id` is first-class (not hidden in metadata)
/// - `content_hash` is explicit (not missing)
/// - `node_type` is NOT optional
/// - No `version`, `exported`, `deleted` fields (moved to manifest/metadata/tombstones)
#[derive(Debug, Clone, PartialEq)]
pub struct NodeRecordV2 {
    /// Semantic ID string — THE identity.
    pub semantic_id: String,
    /// BLAKE3(semantic_id) → u128, derived index for fast lookup.
    pub id: u128,
    /// Node type: "FUNCTION", "CLASS", "http:route", etc.
    pub node_type: String,
    /// Entity name.
    pub name: String,
    /// Source file path (relative).
    pub file: String,
    /// Content hash: xxHash64 of source text span. 0 = not computed.
    pub content_hash: u64,
    /// JSON metadata string. "" = no metadata (NOT "{}").
    pub metadata: String,
}

/// Edge record for v2 storage.
///
/// Key differences from v1:
/// - No `version`, `deleted` fields
/// - `edge_type` is NOT optional
/// - `_owner` for enrichment edges goes in metadata, not as a column
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeRecordV2 {
    /// Source node u128 (BLAKE3 of semantic_id).
    pub src: u128,
    /// Destination node u128.
    pub dst: u128,
    /// Edge type: "CALLS", "CONTAINS", "IMPORTS_FROM", etc.
    pub edge_type: String,
    /// JSON metadata string. "" = no metadata.
    pub metadata: String,
}

// ── Segment Metadata ───────────────────────────────────────────────

/// Metadata about a written segment, returned by the writer for use
/// by manifest/catalog.
#[derive(Debug, Clone)]
pub struct SegmentMeta {
    pub record_count: u64,
    pub byte_size: u64,
    pub segment_type: SegmentType,
    pub node_types: HashSet<String>,
    pub file_paths: HashSet<String>,
    pub edge_types: HashSet<String>,
}

// ── Commit Delta ──────────────────────────────────────────────────

/// Structured diff returned by `MultiShardStore::commit_batch()`.
///
/// Describes what changed in this commit: files, node counts, edge types.
/// Used by the Grafema pipeline to determine which enrichment passes
/// need to re-run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommitDelta {
    /// Files that were committed in this batch.
    pub changed_files: Vec<String>,

    /// Number of nodes added (new, not in previous snapshot).
    pub nodes_added: u64,

    /// Number of nodes removed (tombstoned from previous snapshot).
    pub nodes_removed: u64,

    /// Number of nodes modified (same id, different content_hash).
    pub nodes_modified: u64,

    /// IDs of removed (tombstoned) nodes.
    pub removed_node_ids: Vec<u128>,

    /// Node types affected (from both added and removed nodes).
    pub changed_node_types: HashSet<String>,

    /// Edge types affected (from both added and tombstoned edges).
    pub changed_edge_types: HashSet<String>,

    /// Manifest version after this commit.
    pub manifest_version: u64,
}

// ── Enrichment File Context ───────────────────────────────────────

/// Construct the file context path for enrichment data.
///
/// Convention: `__enrichment__/{enricher}/{source_file}`
///
/// When `source_file` is re-analyzed, the caller includes the enrichment
/// file context in `changed_files` so old enrichment data is tombstoned.
///
/// # Examples
///
/// ```
/// use rfdb::storage_v2::enrichment_file_context;
/// assert_eq!(
///     enrichment_file_context("data-flow", "src/utils.js"),
///     "__enrichment__/data-flow/src/utils.js"
/// );
/// ```
pub fn enrichment_file_context(enricher: &str, source_file: &str) -> String {
    format!("__enrichment__/{}/{}", enricher, source_file)
}

// ── Helpers ────────────────────────────────────────────────────────

/// Compute padding bytes needed to align `offset` to `alignment`.
/// Padding bytes are always 0x00.
pub fn compute_padding(offset: usize, alignment: usize) -> usize {
    if alignment == 0 {
        return 0;
    }
    let rem = offset % alignment;
    if rem == 0 {
        0
    } else {
        alignment - rem
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_segment_type_from_u8() {
        assert_eq!(SegmentType::from_u8(0), Some(SegmentType::Nodes));
        assert_eq!(SegmentType::from_u8(1), Some(SegmentType::Edges));
        assert_eq!(SegmentType::from_u8(2), None);
        assert_eq!(SegmentType::from_u8(255), None);
    }

    #[test]
    fn test_header_write_read_roundtrip() {
        let header = SegmentHeaderV2::new(SegmentType::Nodes, 42, 1024);
        let mut buf = Vec::new();
        header.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), HEADER_SIZE);

        let parsed = SegmentHeaderV2::from_bytes(&buf).unwrap();
        assert_eq!(parsed.magic, MAGIC_V2);
        assert_eq!(parsed.version, FORMAT_VERSION);
        assert_eq!(parsed.segment_type, SegmentType::Nodes);
        assert_eq!(parsed.record_count, 42);
        assert_eq!(parsed.footer_offset, 1024);
    }

    #[test]
    fn test_header_validates_v1_magic() {
        let mut buf = vec![0u8; HEADER_SIZE];
        buf[0..4].copy_from_slice(b"SGRF");
        let err = SegmentHeaderV2::from_bytes(&buf).unwrap_err();
        assert!(err.to_string().contains("v1 segment detected"));
    }

    #[test]
    fn test_header_validates_wrong_magic() {
        let mut buf = vec![0u8; HEADER_SIZE];
        buf[0..4].copy_from_slice(b"XXXX");
        let err = SegmentHeaderV2::from_bytes(&buf).unwrap_err();
        assert!(err.to_string().contains("Not a v2 segment"));
    }

    #[test]
    fn test_header_too_small() {
        let buf = vec![0u8; 10];
        let err = SegmentHeaderV2::from_bytes(&buf).unwrap_err();
        assert!(err.to_string().contains("too small"));
    }

    #[test]
    fn test_footer_index_write_read_roundtrip() {
        let fi = FooterIndex {
            bloom_offset: 100,
            dst_bloom_offset: 200,
            zone_maps_offset: 300,
            string_table_offset: 400,
            data_end_offset: 500,
            footer_index_size: FOOTER_INDEX_SIZE as u32,
            magic: FOOTER_INDEX_MAGIC,
        };
        let mut buf = Vec::new();
        fi.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), FOOTER_INDEX_SIZE);

        let parsed = FooterIndex::from_bytes(&buf).unwrap();
        assert_eq!(parsed.bloom_offset, 100);
        assert_eq!(parsed.dst_bloom_offset, 200);
        assert_eq!(parsed.zone_maps_offset, 300);
        assert_eq!(parsed.string_table_offset, 400);
        assert_eq!(parsed.data_end_offset, 500);
        assert_eq!(parsed.footer_index_size, FOOTER_INDEX_SIZE as u32);
    }

    #[test]
    fn test_footer_index_bad_magic() {
        let buf = vec![0u8; FOOTER_INDEX_SIZE];
        // All fields zero, magic stays 0 → should fail
        let err = FooterIndex::from_bytes(&buf).unwrap_err();
        assert!(err.to_string().contains("Invalid footer index magic"));
    }

    #[test]
    fn test_compute_padding() {
        assert_eq!(compute_padding(32, 16), 0); // 32 % 16 == 0
        assert_eq!(compute_padding(33, 16), 15);
        assert_eq!(compute_padding(36, 16), 12);
        assert_eq!(compute_padding(40, 16), 8);
        assert_eq!(compute_padding(44, 16), 4);
        assert_eq!(compute_padding(48, 16), 0);
    }

    #[test]
    fn test_compute_padding_already_aligned() {
        assert_eq!(compute_padding(0, 16), 0);
        assert_eq!(compute_padding(16, 16), 0);
        assert_eq!(compute_padding(64, 16), 0);
    }

    #[test]
    fn test_compute_padding_zero_records_node_columns() {
        // N=0: u32 section = 0 bytes, starts at 32
        let u32_end = HEADER_SIZE + 20 * 0; // = 32
        let padding = compute_padding(u32_end, 16);
        assert_eq!(padding, 0); // 32 % 16 == 0
    }

    #[test]
    fn test_compute_padding_various_record_counts() {
        // Verify Don's table from the analysis
        for n in [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 100, 1000] {
            let u32_end = HEADER_SIZE + 20 * n;
            let padding = compute_padding(u32_end, 16);
            let ids_start = u32_end + padding;
            assert_eq!(ids_start % 16, 0, "u128 misaligned for N={}", n);
        }
    }

    #[test]
    fn test_footer_index_forward_compat() {
        // A future footer with larger size should still parse the known fields
        let fi = FooterIndex {
            bloom_offset: 100,
            dst_bloom_offset: 0,
            zone_maps_offset: 200,
            string_table_offset: 300,
            data_end_offset: 400,
            footer_index_size: 56, // future: 48 + 8 extra bytes
            magic: FOOTER_INDEX_MAGIC,
        };
        let mut buf = Vec::new();
        fi.write_to(&mut buf).unwrap();
        // Append 8 hypothetical extra bytes (simulating future version)
        buf.extend_from_slice(&[0u8; 8]);

        // Can still parse from the first 48 bytes
        let parsed = FooterIndex::from_bytes(&buf).unwrap();
        assert_eq!(parsed.bloom_offset, 100);
        assert_eq!(parsed.footer_index_size, 56);
    }

    // ── CommitDelta tests ─────────────────────────────────────────

    #[test]
    fn test_commit_delta_serde_roundtrip() {
        let delta = CommitDelta {
            changed_files: vec!["src/main.js".into(), "src/utils.js".into()],
            nodes_added: 10,
            nodes_removed: 3,
            nodes_modified: 2,
            removed_node_ids: vec![100, 200, 300],
            changed_node_types: HashSet::from(["FUNCTION".into(), "CLASS".into()]),
            changed_edge_types: HashSet::from(["CALLS".into()]),
            manifest_version: 5,
        };

        let json = serde_json::to_string(&delta).unwrap();
        let deserialized: CommitDelta = serde_json::from_str(&json).unwrap();
        assert_eq!(delta, deserialized);
    }

    #[test]
    fn test_commit_delta_default_values() {
        // Zero/empty CommitDelta is constructible and round-trips.
        let delta = CommitDelta {
            changed_files: vec![],
            nodes_added: 0,
            nodes_removed: 0,
            nodes_modified: 0,
            removed_node_ids: vec![],
            changed_node_types: HashSet::new(),
            changed_edge_types: HashSet::new(),
            manifest_version: 0,
        };

        let json = serde_json::to_string(&delta).unwrap();
        let deserialized: CommitDelta = serde_json::from_str(&json).unwrap();
        assert_eq!(delta, deserialized);
        assert!(delta.changed_files.is_empty());
        assert_eq!(delta.nodes_added, 0);
        assert_eq!(delta.manifest_version, 0);
    }

    // ── enrichment_file_context tests ─────────────────────────────

    #[test]
    fn test_enrichment_file_context_basic() {
        assert_eq!(
            enrichment_file_context("data-flow", "src/utils.js"),
            "__enrichment__/data-flow/src/utils.js"
        );
    }

    #[test]
    fn test_enrichment_file_context_nested_path() {
        assert_eq!(
            enrichment_file_context("call-graph", "src/deep/nested/module.ts"),
            "__enrichment__/call-graph/src/deep/nested/module.ts"
        );
    }

    #[test]
    fn test_enrichment_file_context_multiple_enrichers() {
        let a = enrichment_file_context("data-flow", "src/index.js");
        let b = enrichment_file_context("call-graph", "src/index.js");
        assert_ne!(a, b);
        assert_eq!(a, "__enrichment__/data-flow/src/index.js");
        assert_eq!(b, "__enrichment__/call-graph/src/index.js");
    }
}
