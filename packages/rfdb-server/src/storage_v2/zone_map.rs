//! Per-field distinct value tracking for segment skipping (v2).
//!
//! A `ZoneMap` records which distinct string values appear for each field
//! (e.g., `node_type`, `file`) within a segment. At query time the engine
//! checks the zone map first: if the queried value is not present for a
//! field, the entire segment can be skipped — no decompression needed.
//!
//! ## Binary format
//!
//! ```text
//! [field_count: u32 LE]                    // 4 bytes
//! For each field (sorted by name):
//!   [field_name_len: u16 LE]              // 2 bytes
//!   [field_name: utf8 bytes]              // variable
//!   [value_count: u32 LE]                 // 4 bytes
//!   For each value (sorted):
//!     [value_len: u16 LE]                 // 2 bytes
//!     [value: utf8 bytes]                 // variable
//! ```
//!
//! Fields and values are sorted lexicographically for deterministic,
//! byte-exact roundtrips.

use std::collections::{HashMap, HashSet};
use std::io::Write;

use crate::error::{GraphError, Result};
use crate::storage_v2::types::MAX_ZONE_MAP_VALUES_PER_FIELD;

/// Per-field distinct value set for segment skipping.
#[derive(Debug)]
pub struct ZoneMap {
    fields: HashMap<String, HashSet<String>>,
}

impl ZoneMap {
    /// Create an empty zone map.
    pub fn new() -> Self {
        Self {
            fields: HashMap::new(),
        }
    }

    /// Record that `value` appears for `field` in this segment.
    pub fn add(&mut self, field: &str, value: &str) {
        self.fields
            .entry(field.to_string())
            .or_default()
            .insert(value.to_string());
    }

    /// Check whether `value` was recorded for `field`.
    pub fn contains(&self, field: &str, value: &str) -> bool {
        self.fields
            .get(field)
            .map_or(false, |s| s.contains(value))
    }

    /// Get the full set of distinct values for a field, if tracked.
    pub fn get_values(&self, field: &str) -> Option<&HashSet<String>> {
        self.fields.get(field)
    }

    /// Number of tracked fields.
    pub fn field_count(&self) -> usize {
        self.fields.len()
    }

    /// Serialize to the binary format described in the module docs.
    ///
    /// Fields with more than [`MAX_ZONE_MAP_VALUES_PER_FIELD`] distinct
    /// values are skipped entirely (treated as "all values possible")
    /// because tracking them would bloat the zone map without meaningful
    /// pruning benefit.
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()> {
        // Collect fields sorted by name, skipping those over the cap.
        let mut sorted_fields: Vec<(&String, &HashSet<String>)> =
            self.fields.iter().collect();
        sorted_fields.sort_by_key(|(name, _)| name.as_str());

        // First pass: filter out oversized fields.
        let written_fields: Vec<(&String, &HashSet<String>)> = sorted_fields
            .into_iter()
            .filter(|(name, values)| {
                if values.len() > MAX_ZONE_MAP_VALUES_PER_FIELD {
                    tracing::warn!(
                        field = name.as_str(),
                        count = values.len(),
                        max = MAX_ZONE_MAP_VALUES_PER_FIELD,
                        "Zone map field exceeds cap, skipping (treated as all values possible)"
                    );
                    false
                } else {
                    true
                }
            })
            .collect();

        // field_count
        writer.write_all(&(written_fields.len() as u32).to_le_bytes())?;

        for (name, values) in &written_fields {
            let name_bytes = name.as_bytes();
            // field_name_len + field_name
            writer.write_all(&(name_bytes.len() as u16).to_le_bytes())?;
            writer.write_all(name_bytes)?;

            // Sort values for determinism.
            let mut sorted_values: Vec<&String> = values.iter().collect();
            sorted_values.sort();

            // value_count
            writer.write_all(&(sorted_values.len() as u32).to_le_bytes())?;

            for val in &sorted_values {
                let val_bytes = val.as_bytes();
                // value_len + value
                writer.write_all(&(val_bytes.len() as u16).to_le_bytes())?;
                writer.write_all(val_bytes)?;
            }
        }

        Ok(())
    }

    /// Deserialize from bytes produced by [`write_to`](Self::write_to).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 4 {
            return Err(GraphError::InvalidFormat(
                "Zone map too small".into(),
            ));
        }

        let mut pos = 0;

        let field_count =
            u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;

        let mut fields = HashMap::with_capacity(field_count);

        for _ in 0..field_count {
            // field_name_len
            if pos + 2 > bytes.len() {
                return Err(GraphError::InvalidFormat(
                    "Zone map field truncated".into(),
                ));
            }
            let name_len =
                u16::from_le_bytes(bytes[pos..pos + 2].try_into().unwrap()) as usize;
            pos += 2;

            // field_name
            if pos + name_len > bytes.len() {
                return Err(GraphError::InvalidFormat(
                    "Zone map field truncated".into(),
                ));
            }
            let name = std::str::from_utf8(&bytes[pos..pos + name_len])
                .map_err(|_| {
                    GraphError::InvalidFormat(
                        "Zone map contains invalid UTF-8".into(),
                    )
                })?
                .to_string();
            pos += name_len;

            // value_count
            if pos + 4 > bytes.len() {
                return Err(GraphError::InvalidFormat(
                    "Zone map field truncated".into(),
                ));
            }
            let value_count =
                u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
            pos += 4;

            let mut values = HashSet::with_capacity(value_count);

            for _ in 0..value_count {
                // value_len
                if pos + 2 > bytes.len() {
                    return Err(GraphError::InvalidFormat(
                        "Zone map value truncated".into(),
                    ));
                }
                let val_len =
                    u16::from_le_bytes(bytes[pos..pos + 2].try_into().unwrap())
                        as usize;
                pos += 2;

                // value
                if pos + val_len > bytes.len() {
                    return Err(GraphError::InvalidFormat(
                        "Zone map value truncated".into(),
                    ));
                }
                let val = std::str::from_utf8(&bytes[pos..pos + val_len])
                    .map_err(|_| {
                        GraphError::InvalidFormat(
                            "Zone map contains invalid UTF-8".into(),
                        )
                    })?
                    .to_string();
                pos += val_len;

                values.insert(val);
            }

            fields.insert(name, values);
        }

        Ok(Self { fields })
    }

    /// Compute the exact serialized byte count without writing.
    ///
    /// Matches the output of [`write_to`](Self::write_to): fields over
    /// the per-field cap are excluded.
    pub fn serialized_size(&self) -> usize {
        let mut size = 4; // field_count: u32

        for (name, values) in &self.fields {
            if values.len() > MAX_ZONE_MAP_VALUES_PER_FIELD {
                continue; // skipped during write_to
            }

            size += 2; // field_name_len: u16
            size += name.len(); // field_name bytes
            size += 4; // value_count: u32

            for val in values {
                size += 2; // value_len: u16
                size += val.len(); // value bytes
            }
        }

        size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zone_map_empty() {
        let zm = ZoneMap::new();
        assert_eq!(zm.field_count(), 0);
        assert!(!zm.contains("type", "FUNCTION"));
        assert!(zm.get_values("type").is_none());
    }

    #[test]
    fn test_zone_map_add_and_contains() {
        let mut zm = ZoneMap::new();
        zm.add("type", "FUNCTION");
        zm.add("type", "CLASS");

        assert!(zm.contains("type", "FUNCTION"));
        assert!(zm.contains("type", "CLASS"));
        assert!(!zm.contains("type", "METHOD"));
        assert!(!zm.contains("file", "anything"));
    }

    #[test]
    fn test_zone_map_multiple_fields() {
        let mut zm = ZoneMap::new();
        zm.add("type", "FUNCTION");
        zm.add("file", "src/main.rs");
        zm.add("file", "src/lib.rs");

        assert_eq!(zm.field_count(), 2);
        assert!(zm.contains("type", "FUNCTION"));
        assert!(zm.contains("file", "src/main.rs"));
        assert!(zm.contains("file", "src/lib.rs"));
        assert!(!zm.contains("type", "src/main.rs"));
    }

    #[test]
    fn test_zone_map_dedup() {
        let mut zm = ZoneMap::new();
        zm.add("type", "FUNCTION");
        zm.add("type", "FUNCTION");
        zm.add("type", "FUNCTION");

        let values = zm.get_values("type").unwrap();
        assert_eq!(values.len(), 1);
        assert!(values.contains("FUNCTION"));
    }

    #[test]
    fn test_zone_map_roundtrip() {
        let mut zm = ZoneMap::new();
        zm.add("type", "FUNCTION");
        zm.add("type", "CLASS");
        zm.add("file", "src/main.rs");
        zm.add("edge_type", "CALLS");
        zm.add("edge_type", "IMPORTS_FROM");

        let mut buf = Vec::new();
        zm.write_to(&mut buf).unwrap();

        let zm2 = ZoneMap::from_bytes(&buf).unwrap();
        assert_eq!(zm2.field_count(), 3);
        assert!(zm2.contains("type", "FUNCTION"));
        assert!(zm2.contains("type", "CLASS"));
        assert!(zm2.contains("file", "src/main.rs"));
        assert!(zm2.contains("edge_type", "CALLS"));
        assert!(zm2.contains("edge_type", "IMPORTS_FROM"));
        assert!(!zm2.contains("type", "METHOD"));
    }

    #[test]
    fn test_zone_map_exact_values() {
        let mut zm = ZoneMap::new();
        zm.add("type", "FUNCTION");
        zm.add("type", "CLASS");

        let values = zm.get_values("type").unwrap();
        assert_eq!(values.len(), 2);
        assert!(values.contains("FUNCTION"));
        assert!(values.contains("CLASS"));
    }

    #[test]
    fn test_zone_map_empty_segment() {
        // Empty zone map roundtrip.
        let zm = ZoneMap::new();
        let mut buf = Vec::new();
        zm.write_to(&mut buf).unwrap();

        assert_eq!(buf.len(), 4); // just field_count = 0
        assert_eq!(&buf, &[0, 0, 0, 0]);

        let zm2 = ZoneMap::from_bytes(&buf).unwrap();
        assert_eq!(zm2.field_count(), 0);
    }

    #[test]
    fn test_zone_map_single_type() {
        let mut zm = ZoneMap::new();
        zm.add("node_type", "FUNCTION");

        let mut buf = Vec::new();
        zm.write_to(&mut buf).unwrap();

        let zm2 = ZoneMap::from_bytes(&buf).unwrap();
        assert_eq!(zm2.field_count(), 1);
        assert!(zm2.contains("node_type", "FUNCTION"));
    }

    #[test]
    fn test_zone_map_serialized_size() {
        let mut zm = ZoneMap::new();
        zm.add("type", "FUNCTION");
        zm.add("type", "CLASS");
        zm.add("file", "src/main.rs");

        let expected_size = zm.serialized_size();

        let mut buf = Vec::new();
        zm.write_to(&mut buf).unwrap();

        assert_eq!(buf.len(), expected_size);
    }

    #[test]
    fn test_zone_map_from_bytes_too_small() {
        // Less than 4 bytes.
        let err = ZoneMap::from_bytes(&[0, 0]).unwrap_err();
        assert!(err.to_string().contains("Zone map too small"));

        // Empty slice.
        let err = ZoneMap::from_bytes(&[]).unwrap_err();
        assert!(err.to_string().contains("Zone map too small"));
    }

    #[test]
    fn test_zone_map_byte_exact() {
        // write -> from_bytes -> write -> same bytes
        let mut zm = ZoneMap::new();
        zm.add("type", "FUNCTION");
        zm.add("type", "CLASS");
        zm.add("type", "METHOD");
        zm.add("file", "src/main.rs");
        zm.add("file", "src/lib.rs");
        zm.add("edge_type", "CALLS");

        let mut buf1 = Vec::new();
        zm.write_to(&mut buf1).unwrap();

        let zm2 = ZoneMap::from_bytes(&buf1).unwrap();

        let mut buf2 = Vec::new();
        zm2.write_to(&mut buf2).unwrap();

        assert_eq!(buf1, buf2, "Zone map is not byte-exact after roundtrip");
    }

    #[test]
    fn test_zone_map_field_truncated() {
        // field_count = 1 but no field data follows.
        let buf = 1u32.to_le_bytes();
        let err = ZoneMap::from_bytes(&buf).unwrap_err();
        assert!(err.to_string().contains("Zone map field truncated"));
    }

    #[test]
    fn test_zone_map_value_truncated() {
        // Build valid field header, then truncate in the value section.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes()); // field_count = 1
        let name = b"type";
        buf.extend_from_slice(&(name.len() as u16).to_le_bytes());
        buf.extend_from_slice(name);
        buf.extend_from_slice(&1u32.to_le_bytes()); // value_count = 1
        buf.extend_from_slice(&(100u16).to_le_bytes()); // value_len = 100 (but no data)

        let err = ZoneMap::from_bytes(&buf).unwrap_err();
        assert!(err.to_string().contains("Zone map value truncated"));
    }

    #[test]
    fn test_zone_map_invalid_utf8() {
        // Build a zone map with invalid UTF-8 in a value.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes()); // field_count = 1
        let name = b"type";
        buf.extend_from_slice(&(name.len() as u16).to_le_bytes());
        buf.extend_from_slice(name);
        buf.extend_from_slice(&1u32.to_le_bytes()); // value_count = 1
        let bad_utf8: &[u8] = &[0xFF, 0xFE];
        buf.extend_from_slice(&(bad_utf8.len() as u16).to_le_bytes());
        buf.extend_from_slice(bad_utf8);

        let err = ZoneMap::from_bytes(&buf).unwrap_err();
        assert!(err.to_string().contains("invalid UTF-8"));
    }

    #[test]
    fn test_zone_map_field_name_overflow_skipped_in_write() {
        // Fields over MAX_ZONE_MAP_VALUES_PER_FIELD are skipped during write.
        let mut zm = ZoneMap::new();
        for i in 0..=MAX_ZONE_MAP_VALUES_PER_FIELD {
            zm.add("high_cardinality", &format!("val_{}", i));
        }
        zm.add("normal", "ok");

        // The in-memory map has 2 fields.
        assert_eq!(zm.field_count(), 2);

        let mut buf = Vec::new();
        zm.write_to(&mut buf).unwrap();

        // Only "normal" should survive serialization.
        let zm2 = ZoneMap::from_bytes(&buf).unwrap();
        assert_eq!(zm2.field_count(), 1);
        assert!(zm2.contains("normal", "ok"));
        assert!(!zm2.contains("high_cardinality", "val_0"));
    }

    #[test]
    fn test_zone_map_serialized_size_with_overflow() {
        let mut zm = ZoneMap::new();
        for i in 0..=MAX_ZONE_MAP_VALUES_PER_FIELD {
            zm.add("big", &format!("v{}", i));
        }
        zm.add("small", "x");

        let size = zm.serialized_size();
        let mut buf = Vec::new();
        zm.write_to(&mut buf).unwrap();
        assert_eq!(buf.len(), size);
    }
}
