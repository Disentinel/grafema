//! Binary format types for the L1 node index.
//!
//! The index maps `node_id` (u128) to its location in an L1 segment
//! (segment_id + offset + shard). Designed for mmap-based O(1) lookup.
//!
//! # File Layout
//!
//! ```text
//! [IndexFileHeader]          32 bytes
//! [IndexEntry] * entry_count 32 bytes each
//! [LookupTableEntry] * N     16 bytes each
//! [key data]                 variable
//! ```

use std::io::{Read, Write};

use crate::error::{GraphError, Result};

// ── Index File Header ─────────────────────────────────────────────

/// Magic bytes for index files.
pub const INDEX_MAGIC: [u8; 4] = *b"RIDX";

/// Index file format version.
pub const INDEX_VERSION: u32 = 1;

/// Index file header -- exactly 32 bytes.
///
/// ```text
/// Offset  Size  Field
/// 0       4     magic: b"RIDX"
/// 4       4     version: u32 = 1
/// 8       8     entry_count: u64
/// 16      4     lookup_count: u32
/// 20      12    _reserved: [u8; 12]
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct IndexFileHeader {
    /// Magic bytes identifying this as an index file.
    pub magic: [u8; 4],
    /// Format version.
    pub version: u32,
    /// Number of IndexEntry records following the header.
    pub entry_count: u64,
    /// Number of LookupTableEntry records after the entries.
    pub lookup_count: u32,
    /// Reserved for future use.
    pub _reserved: [u8; 12],
}

impl IndexFileHeader {
    /// Create a new header with the given counts.
    pub fn new(entry_count: u64, lookup_count: u32) -> Self {
        Self {
            magic: INDEX_MAGIC,
            version: INDEX_VERSION,
            entry_count,
            lookup_count,
            _reserved: [0u8; 12],
        }
    }

    /// Write header to writer (32 bytes, little-endian).
    pub fn write_to<W: Write>(&self, w: &mut W) -> Result<()> {
        w.write_all(&self.magic)?;
        w.write_all(&self.version.to_le_bytes())?;
        w.write_all(&self.entry_count.to_le_bytes())?;
        w.write_all(&self.lookup_count.to_le_bytes())?;
        w.write_all(&self._reserved)?;
        Ok(())
    }

    /// Read header from reader (32 bytes, little-endian).
    pub fn read_from<R: Read>(r: &mut R) -> Result<Self> {
        let mut buf = [0u8; 32];
        r.read_exact(&mut buf).map_err(|e| {
            GraphError::InvalidFormat(format!("Failed to read index header: {}", e))
        })?;

        let mut magic = [0u8; 4];
        magic.copy_from_slice(&buf[0..4]);
        let version = u32::from_le_bytes(buf[4..8].try_into().unwrap());
        let entry_count = u64::from_le_bytes(buf[8..16].try_into().unwrap());
        let lookup_count = u32::from_le_bytes(buf[16..20].try_into().unwrap());
        let mut reserved = [0u8; 12];
        reserved.copy_from_slice(&buf[20..32]);

        let header = Self {
            magic,
            version,
            entry_count,
            lookup_count,
            _reserved: reserved,
        };

        if header.magic != INDEX_MAGIC {
            return Err(GraphError::InvalidFormat(format!(
                "Not an index file: expected RIDX, got {:?}",
                header.magic
            )));
        }
        if header.version != INDEX_VERSION {
            return Err(GraphError::InvalidFormat(format!(
                "Unsupported index version: {}",
                header.version
            )));
        }

        Ok(header)
    }
}

// ── Index Entry ───────────────────────────────────────────────────

/// Single index entry: maps a node_id to its segment location.
///
/// CRITICAL: This struct is `#[repr(C)]` and must be exactly 32 bytes
/// with no internal padding. The size assertion test enforces this.
///
/// ```text
/// Offset  Size  Field
/// 0       16    node_id: u128
/// 16      8     segment_id: u64
/// 24      4     offset: u32
/// 28      2     shard: u16
/// 30      2     _padding: u16
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct IndexEntry {
    /// Node ID (BLAKE3 hash of semantic_id).
    pub node_id: u128,
    /// Segment ID containing this node.
    pub segment_id: u64,
    /// Record offset within the segment.
    pub offset: u32,
    /// Shard ID.
    pub shard: u16,
    /// Explicit padding to reach 32 bytes.
    pub _padding: u16,
}

impl IndexEntry {
    /// Create a new index entry.
    pub fn new(node_id: u128, segment_id: u64, offset: u32, shard: u16) -> Self {
        Self {
            node_id,
            segment_id,
            offset,
            shard,
            _padding: 0,
        }
    }

    /// Write entry to writer (32 bytes, little-endian).
    pub fn write_to<W: Write>(&self, w: &mut W) -> Result<()> {
        w.write_all(&self.node_id.to_le_bytes())?;
        w.write_all(&self.segment_id.to_le_bytes())?;
        w.write_all(&self.offset.to_le_bytes())?;
        w.write_all(&self.shard.to_le_bytes())?;
        w.write_all(&self._padding.to_le_bytes())?;
        Ok(())
    }

    /// Read entry from reader (32 bytes, little-endian).
    pub fn read_from<R: Read>(r: &mut R) -> Result<Self> {
        let mut buf = [0u8; 32];
        r.read_exact(&mut buf).map_err(|e| {
            GraphError::InvalidFormat(format!("Failed to read index entry: {}", e))
        })?;

        Ok(Self {
            node_id: u128::from_le_bytes(buf[0..16].try_into().unwrap()),
            segment_id: u64::from_le_bytes(buf[16..24].try_into().unwrap()),
            offset: u32::from_le_bytes(buf[24..28].try_into().unwrap()),
            shard: u16::from_le_bytes(buf[28..30].try_into().unwrap()),
            _padding: u16::from_le_bytes(buf[30..32].try_into().unwrap()),
        })
    }

    /// Write a batch of entries to writer.
    pub fn write_batch<W: Write>(entries: &[IndexEntry], w: &mut W) -> Result<()> {
        for entry in entries {
            entry.write_to(w)?;
        }
        Ok(())
    }

    /// Read a batch of entries from reader.
    pub fn read_batch<R: Read>(r: &mut R, count: usize) -> Result<Vec<Self>> {
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            entries.push(Self::read_from(r)?);
        }
        Ok(entries)
    }
}

// ── Lookup Table Entry ────────────────────────────────────────────

/// Lookup table entry for key-based index access (e.g., by node_type).
///
/// ```text
/// Offset  Size  Field
/// 0       4     key_offset: u32
/// 4       2     key_length: u16
/// 6       2     _padding: u16
/// 8       4     entry_offset: u32
/// 12      4     entry_count: u32
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct LookupTableEntry {
    /// Byte offset of the key string in the key data section.
    pub key_offset: u32,
    /// Length of the key string in bytes.
    pub key_length: u16,
    /// Explicit padding.
    pub _padding: u16,
    /// Index of the first IndexEntry for this key.
    pub entry_offset: u32,
    /// Number of IndexEntry records for this key.
    pub entry_count: u32,
}

impl LookupTableEntry {
    /// Create a new lookup table entry.
    pub fn new(key_offset: u32, key_length: u16, entry_offset: u32, entry_count: u32) -> Self {
        Self {
            key_offset,
            key_length,
            _padding: 0,
            entry_offset,
            entry_count,
        }
    }

    /// Write entry to writer (16 bytes, little-endian).
    pub fn write_to<W: Write>(&self, w: &mut W) -> Result<()> {
        w.write_all(&self.key_offset.to_le_bytes())?;
        w.write_all(&self.key_length.to_le_bytes())?;
        w.write_all(&self._padding.to_le_bytes())?;
        w.write_all(&self.entry_offset.to_le_bytes())?;
        w.write_all(&self.entry_count.to_le_bytes())?;
        Ok(())
    }

    /// Read entry from reader (16 bytes, little-endian).
    pub fn read_from<R: Read>(r: &mut R) -> Result<Self> {
        let mut buf = [0u8; 16];
        r.read_exact(&mut buf).map_err(|e| {
            GraphError::InvalidFormat(format!("Failed to read lookup entry: {}", e))
        })?;

        Ok(Self {
            key_offset: u32::from_le_bytes(buf[0..4].try_into().unwrap()),
            key_length: u16::from_le_bytes(buf[4..6].try_into().unwrap()),
            _padding: u16::from_le_bytes(buf[6..8].try_into().unwrap()),
            entry_offset: u32::from_le_bytes(buf[8..12].try_into().unwrap()),
            entry_count: u32::from_le_bytes(buf[12..16].try_into().unwrap()),
        })
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::mem;

    // ── Size Assertions ───────────────────────────────────────────

    #[test]
    fn test_index_entry_size_is_32_bytes() {
        // CRITICAL: IndexEntry must be exactly 32 bytes with no internal
        // padding. This guarantees mmap-based array access works correctly.
        assert_eq!(mem::size_of::<IndexEntry>(), 32);
    }

    #[test]
    fn test_index_file_header_size_is_32_bytes() {
        assert_eq!(mem::size_of::<IndexFileHeader>(), 32);
    }

    #[test]
    fn test_lookup_table_entry_size_is_16_bytes() {
        assert_eq!(mem::size_of::<LookupTableEntry>(), 16);
    }

    // ── IndexFileHeader Serialization ─────────────────────────────

    #[test]
    fn test_index_file_header_roundtrip() {
        let header = IndexFileHeader::new(1000, 5);

        let mut buf = Vec::new();
        header.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), 32);

        let mut cursor = Cursor::new(&buf);
        let parsed = IndexFileHeader::read_from(&mut cursor).unwrap();

        assert_eq!(parsed.magic, INDEX_MAGIC);
        assert_eq!(parsed.version, INDEX_VERSION);
        assert_eq!(parsed.entry_count, 1000);
        assert_eq!(parsed.lookup_count, 5);
        assert_eq!(parsed._reserved, [0u8; 12]);
        assert_eq!(header, parsed);
    }

    #[test]
    fn test_index_file_header_bad_magic() {
        let mut buf = vec![0u8; 32];
        buf[0..4].copy_from_slice(b"XXXX");
        let mut cursor = Cursor::new(&buf);
        let err = IndexFileHeader::read_from(&mut cursor).unwrap_err();
        assert!(err.to_string().contains("Not an index file"));
    }

    #[test]
    fn test_index_file_header_truncated() {
        let buf = vec![0u8; 10]; // too short
        let mut cursor = Cursor::new(&buf);
        let err = IndexFileHeader::read_from(&mut cursor).unwrap_err();
        assert!(err.to_string().contains("Failed to read index header"));
    }

    // ── IndexEntry Serialization ──────────────────────────────────

    #[test]
    fn test_index_entry_single_roundtrip() {
        let entry = IndexEntry::new(
            0xdeadbeef_cafebabe_12345678_9abcdef0,
            42,
            100,
            3,
        );

        let mut buf = Vec::new();
        entry.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), 32);

        let mut cursor = Cursor::new(&buf);
        let parsed = IndexEntry::read_from(&mut cursor).unwrap();

        assert_eq!(parsed.node_id, 0xdeadbeef_cafebabe_12345678_9abcdef0);
        assert_eq!(parsed.segment_id, 42);
        assert_eq!(parsed.offset, 100);
        assert_eq!(parsed.shard, 3);
        assert_eq!(parsed._padding, 0);
        assert_eq!(entry, parsed);
    }

    #[test]
    fn test_index_entry_batch_100_roundtrip() {
        let entries: Vec<IndexEntry> = (0..100)
            .map(|i| {
                IndexEntry::new(
                    i as u128 * 1000 + 1,
                    i as u64 + 1,
                    (i * 50) as u32,
                    (i % 16) as u16,
                )
            })
            .collect();

        // Write all entries
        let mut buf = Vec::new();
        for entry in &entries {
            entry.write_to(&mut buf).unwrap();
        }
        assert_eq!(buf.len(), 100 * 32);

        // Read all entries back
        let mut cursor = Cursor::new(&buf);
        let mut parsed = Vec::new();
        for _ in 0..100 {
            parsed.push(IndexEntry::read_from(&mut cursor).unwrap());
        }

        assert_eq!(entries, parsed);
    }

    #[test]
    fn test_index_entry_empty_batch() {
        let entries: Vec<IndexEntry> = vec![];

        let mut buf = Vec::new();
        for entry in &entries {
            entry.write_to(&mut buf).unwrap();
        }
        assert_eq!(buf.len(), 0);

        // Reading from empty buffer should fail
        let mut cursor = Cursor::new(&buf);
        let result = IndexEntry::read_from(&mut cursor);
        assert!(result.is_err());
    }

    #[test]
    fn test_index_entry_max_values() {
        let entry = IndexEntry::new(u128::MAX, u64::MAX, u32::MAX, u16::MAX);

        let mut buf = Vec::new();
        entry.write_to(&mut buf).unwrap();

        let mut cursor = Cursor::new(&buf);
        let parsed = IndexEntry::read_from(&mut cursor).unwrap();

        assert_eq!(parsed.node_id, u128::MAX);
        assert_eq!(parsed.segment_id, u64::MAX);
        assert_eq!(parsed.offset, u32::MAX);
        assert_eq!(parsed.shard, u16::MAX);
    }

    #[test]
    fn test_index_entry_zero_values() {
        let entry = IndexEntry::new(0, 0, 0, 0);

        let mut buf = Vec::new();
        entry.write_to(&mut buf).unwrap();

        let mut cursor = Cursor::new(&buf);
        let parsed = IndexEntry::read_from(&mut cursor).unwrap();

        assert_eq!(parsed.node_id, 0);
        assert_eq!(parsed.segment_id, 0);
        assert_eq!(parsed.offset, 0);
        assert_eq!(parsed.shard, 0);
    }

    // ── LookupTableEntry Serialization ────────────────────────────

    #[test]
    fn test_lookup_table_entry_roundtrip() {
        let entry = LookupTableEntry::new(128, 8, 0, 50);

        let mut buf = Vec::new();
        entry.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), 16);

        let mut cursor = Cursor::new(&buf);
        let parsed = LookupTableEntry::read_from(&mut cursor).unwrap();

        assert_eq!(parsed.key_offset, 128);
        assert_eq!(parsed.key_length, 8);
        assert_eq!(parsed._padding, 0);
        assert_eq!(parsed.entry_offset, 0);
        assert_eq!(parsed.entry_count, 50);
        assert_eq!(entry, parsed);
    }

    #[test]
    fn test_lookup_table_entry_max_values() {
        let entry = LookupTableEntry::new(u32::MAX, u16::MAX, u32::MAX, u32::MAX);

        let mut buf = Vec::new();
        entry.write_to(&mut buf).unwrap();

        let mut cursor = Cursor::new(&buf);
        let parsed = LookupTableEntry::read_from(&mut cursor).unwrap();

        assert_eq!(parsed.key_offset, u32::MAX);
        assert_eq!(parsed.key_length, u16::MAX);
        assert_eq!(parsed.entry_offset, u32::MAX);
        assert_eq!(parsed.entry_count, u32::MAX);
    }

    #[test]
    fn test_lookup_table_entry_truncated() {
        let buf = vec![0u8; 8]; // too short (need 16)
        let mut cursor = Cursor::new(&buf);
        let err = LookupTableEntry::read_from(&mut cursor).unwrap_err();
        assert!(err.to_string().contains("Failed to read lookup entry"));
    }

    // ── Full File Roundtrip ───────────────────────────────────────

    #[test]
    fn test_full_index_file_roundtrip() {
        // Write a complete index file: header + entries + lookup table
        let entries = vec![
            IndexEntry::new(100, 1, 0, 0),
            IndexEntry::new(200, 1, 1, 0),
            IndexEntry::new(300, 2, 0, 1),
        ];
        let lookups = vec![
            LookupTableEntry::new(0, 8, 0, 2),  // "FUNCTION" -> entries 0..2
            LookupTableEntry::new(8, 5, 2, 1),   // "CLASS" -> entries 2..3
        ];

        let header = IndexFileHeader::new(entries.len() as u64, lookups.len() as u32);

        let mut buf = Vec::new();
        header.write_to(&mut buf).unwrap();
        for e in &entries {
            e.write_to(&mut buf).unwrap();
        }
        for l in &lookups {
            l.write_to(&mut buf).unwrap();
        }

        // Expected size: 32 (header) + 3*32 (entries) + 2*16 (lookups) = 160
        assert_eq!(buf.len(), 32 + 3 * 32 + 2 * 16);

        // Read back
        let mut cursor = Cursor::new(&buf);
        let parsed_header = IndexFileHeader::read_from(&mut cursor).unwrap();
        assert_eq!(parsed_header.entry_count, 3);
        assert_eq!(parsed_header.lookup_count, 2);

        let mut parsed_entries = Vec::new();
        for _ in 0..parsed_header.entry_count {
            parsed_entries.push(IndexEntry::read_from(&mut cursor).unwrap());
        }
        assert_eq!(parsed_entries, entries);

        let mut parsed_lookups = Vec::new();
        for _ in 0..parsed_header.lookup_count {
            parsed_lookups.push(LookupTableEntry::read_from(&mut cursor).unwrap());
        }
        assert_eq!(parsed_lookups, lookups);
    }
}
