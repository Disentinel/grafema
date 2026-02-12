//! Index-based string table with O(1) lookup (v2).
//!
//! Stores deduplicated strings in a compact binary format. Each string gets
//! a 0-based index on intern. Lookup by index is O(1) via the entries array.
//!
//! Binary format:
//! ```text
//! [string_count: u32 LE]                                      // 4 bytes
//! [total_data_len: u32 LE]                                    // 4 bytes
//! [entries: (offset: u32 LE, length: u32 LE) x string_count]  // 8 bytes each
//! [data: u8 x total_data_len]                                 // concatenated UTF-8
//! ```
//!
//! Key differences from v1 StringTable:
//! - Returns 0-based index (not byte offset)
//! - Stores (offset, length) pairs for O(1) get without scanning
//! - `from_bytes` does NOT rebuild HashMap (read-only after load)

use std::collections::HashMap;
use std::io::Write;

use crate::error::{GraphError, Result};

/// String table with O(1) index-based lookup and write-time deduplication.
#[derive(Debug)]
pub struct StringTableV2 {
    /// Concatenated UTF-8 string bytes.
    data: Vec<u8>,
    /// (offset, length) pairs into `data`, one per interned string.
    entries: Vec<(u32, u32)>,
    /// Write-time deduplication index. Not populated on `from_bytes`.
    index: HashMap<String, u32>,
}

impl StringTableV2 {
    pub fn new() -> Self {
        Self {
            data: Vec::new(),
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }

    /// Intern a string, returning its 0-based index.
    ///
    /// If the string was previously interned, returns the existing index.
    /// Otherwise appends it to the data buffer and assigns a new index.
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&idx) = self.index.get(s) {
            return idx;
        }

        debug_assert!(
            self.data.len() + s.len() < u32::MAX as usize,
            "String table data exceeds u32 range"
        );

        let offset = self.data.len() as u32;
        let length = s.len() as u32;
        let idx = self.entries.len() as u32;

        self.data.extend_from_slice(s.as_bytes());
        self.entries.push((offset, length));
        self.index.insert(s.to_string(), idx);

        idx
    }

    /// Get a string by its 0-based index. O(1).
    pub fn get(&self, index: u32) -> Option<&str> {
        let (offset, length) = *self.entries.get(index as usize)?;
        let start = offset as usize;
        let end = start + length as usize;

        if end > self.data.len() {
            return None;
        }

        // Safety: data was either interned from valid &str or validated
        // as UTF-8 during from_bytes.
        std::str::from_utf8(&self.data[start..end]).ok()
    }

    /// Number of interned strings.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the string table contains no strings.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Write the string table in binary format.
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()> {
        // string_count
        writer.write_all(&(self.entries.len() as u32).to_le_bytes())?;

        // total_data_len
        writer.write_all(&(self.data.len() as u32).to_le_bytes())?;

        // entries
        for &(offset, length) in &self.entries {
            writer.write_all(&offset.to_le_bytes())?;
            writer.write_all(&length.to_le_bytes())?;
        }

        // data
        writer.write_all(&self.data)?;

        Ok(())
    }

    /// Parse a string table from bytes. Does NOT rebuild the HashMap index
    /// (the resulting table is read-only — `intern` will not deduplicate
    /// against existing strings).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        // Need at least string_count + total_data_len (8 bytes).
        if bytes.len() < 8 {
            return Err(GraphError::InvalidFormat(
                "String table too small".into(),
            ));
        }

        let string_count = u32::from_le_bytes(
            bytes[0..4].try_into().unwrap(),
        ) as usize;
        let total_data_len = u32::from_le_bytes(
            bytes[4..8].try_into().unwrap(),
        ) as usize;

        let entries_size = string_count * 8;
        if bytes.len() < 8 + entries_size {
            return Err(GraphError::InvalidFormat(
                "String table entries truncated".into(),
            ));
        }

        if bytes.len() < 8 + entries_size + total_data_len {
            return Err(GraphError::InvalidFormat(
                "String table data truncated".into(),
            ));
        }

        // Read entries.
        let mut entries = Vec::with_capacity(string_count);
        let mut pos = 8;
        for _ in 0..string_count {
            let offset = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
            let length = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap());
            entries.push((offset, length));
            pos += 8;
        }

        // Read data.
        let data = bytes[pos..pos + total_data_len].to_vec();

        // Validate each entry: bounds check + UTF-8.
        for &(offset, length) in &entries {
            let start = offset as usize;
            let end = start + length as usize;
            if end > data.len() {
                return Err(GraphError::InvalidFormat(
                    "String table entry out of bounds".into(),
                ));
            }
            std::str::from_utf8(&data[start..end]).map_err(|_| {
                GraphError::InvalidFormat("String table contains invalid UTF-8".into())
            })?;
        }

        Ok(Self {
            data,
            entries,
            index: HashMap::new(),
        })
    }

    /// Total byte size when serialized.
    pub fn serialized_size(&self) -> usize {
        // header (string_count + total_data_len) + entries + data
        4 + 4 + self.entries.len() * 8 + self.data.len()
    }
}

impl Default for StringTableV2 {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_string_table_empty() {
        let st = StringTableV2::new();
        assert_eq!(st.len(), 0);
        assert!(st.is_empty());
        assert_eq!(st.get(0), None);
    }

    #[test]
    fn test_string_table_intern_one() {
        let mut st = StringTableV2::new();
        let idx = st.intern("hello");
        assert_eq!(idx, 0);
        assert_eq!(st.len(), 1);
        assert!(!st.is_empty());
        assert_eq!(st.get(0), Some("hello"));
        assert_eq!(st.get(1), None);
    }

    #[test]
    fn test_string_table_intern_multiple() {
        let mut st = StringTableV2::new();
        let a = st.intern("alpha");
        let b = st.intern("beta");
        let c = st.intern("gamma");
        assert_eq!(a, 0);
        assert_eq!(b, 1);
        assert_eq!(c, 2);
        assert_eq!(st.len(), 3);
        assert_eq!(st.get(0), Some("alpha"));
        assert_eq!(st.get(1), Some("beta"));
        assert_eq!(st.get(2), Some("gamma"));
    }

    #[test]
    fn test_string_table_dedup() {
        let mut st = StringTableV2::new();
        let a = st.intern("dup");
        let b = st.intern("other");
        let c = st.intern("dup");
        assert_eq!(a, 0);
        assert_eq!(b, 1);
        assert_eq!(c, 0); // same as first
        assert_eq!(st.len(), 2);
    }

    #[test]
    fn test_string_table_roundtrip() {
        let mut st = StringTableV2::new();
        st.intern("foo");
        st.intern("bar");
        st.intern("baz");

        let mut buf = Vec::new();
        st.write_to(&mut buf).unwrap();

        let loaded = StringTableV2::from_bytes(&buf).unwrap();
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded.get(0), Some("foo"));
        assert_eq!(loaded.get(1), Some("bar"));
        assert_eq!(loaded.get(2), Some("baz"));
    }

    #[test]
    fn test_string_table_empty_string() {
        let mut st = StringTableV2::new();
        let idx = st.intern("");
        assert_eq!(idx, 0);
        assert_eq!(st.get(0), Some(""));
        assert_eq!(st.len(), 1);

        // Roundtrip.
        let mut buf = Vec::new();
        st.write_to(&mut buf).unwrap();
        let loaded = StringTableV2::from_bytes(&buf).unwrap();
        assert_eq!(loaded.get(0), Some(""));
    }

    #[test]
    fn test_string_table_unicode() {
        let mut st = StringTableV2::new();
        st.intern("hello");
        st.intern("\u{1F600}"); // emoji
        st.intern("\u{0410}\u{0411}\u{0412}"); // Cyrillic

        let mut buf = Vec::new();
        st.write_to(&mut buf).unwrap();

        let loaded = StringTableV2::from_bytes(&buf).unwrap();
        assert_eq!(loaded.get(0), Some("hello"));
        assert_eq!(loaded.get(1), Some("\u{1F600}"));
        assert_eq!(loaded.get(2), Some("\u{0410}\u{0411}\u{0412}"));
    }

    #[test]
    fn test_string_table_very_long() {
        let long = "x".repeat(100_000);
        let mut st = StringTableV2::new();
        let idx = st.intern(&long);
        assert_eq!(idx, 0);
        assert_eq!(st.get(0), Some(long.as_str()));

        let mut buf = Vec::new();
        st.write_to(&mut buf).unwrap();
        let loaded = StringTableV2::from_bytes(&buf).unwrap();
        assert_eq!(loaded.get(0), Some(long.as_str()));
    }

    #[test]
    fn test_string_table_serialized_size() {
        let mut st = StringTableV2::new();
        st.intern("abc"); // 3 bytes
        st.intern("de"); // 2 bytes

        // header: 8, entries: 2*8=16, data: 5
        assert_eq!(st.serialized_size(), 8 + 16 + 5);

        let mut buf = Vec::new();
        st.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), st.serialized_size());
    }

    #[test]
    fn test_string_table_from_bytes_too_small() {
        let buf = vec![0u8; 4]; // less than 8 bytes
        let err = StringTableV2::from_bytes(&buf).unwrap_err();
        assert!(
            err.to_string().contains("String table too small"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_string_table_from_bytes_truncated() {
        // Write a valid table, then truncate the entries section.
        let mut st = StringTableV2::new();
        st.intern("hello");

        let mut buf = Vec::new();
        st.write_to(&mut buf).unwrap();

        // Truncate: keep header (8) but cut into entries.
        let truncated = &buf[..10];
        let err = StringTableV2::from_bytes(truncated).unwrap_err();
        assert!(
            err.to_string().contains("String table entries truncated"),
            "unexpected error: {}",
            err
        );

        // Truncate: keep header + entries but cut into data.
        let truncated_data = &buf[..buf.len() - 2];
        let err = StringTableV2::from_bytes(truncated_data).unwrap_err();
        assert!(
            err.to_string().contains("String table data truncated"),
            "unexpected error: {}",
            err
        );
    }
}
