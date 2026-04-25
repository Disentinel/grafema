# Joel Spolsky: T1.1 Segment Format — Detailed Technical Plan

> Date: 2026-02-12
> Status: Implementation plan
> Based on: Don Melton's analysis (002-don-plan.md)
> Spec: T1.1-segment-format.md

---

## Table of Contents

1. [Module Structure](#1-module-structure)
2. [Phase 1: types.rs + mod.rs skeleton](#2-phase-1-typesrs--modrs-skeleton)
3. [Phase 2: string_table.rs](#3-phase-2-string_tablers)
4. [Phase 3: bloom.rs](#4-phase-3-bloomrs)
5. [Phase 4: zone_map.rs](#5-phase-4-zone_maprs)
6. [Phase 5: writer.rs](#6-phase-5-writerrs)
7. [Phase 6: segment.rs](#7-phase-6-segmentrs)
8. [Phase 7: Integration tests](#8-phase-7-integration-tests)
9. [Phase 8: Benchmarks](#9-phase-8-benchmarks)
10. [Cargo.toml changes](#10-cargotoml-changes)
11. [Binary format reference](#11-binary-format-reference)
12. [Big-O complexity summary](#12-big-o-complexity-summary)
13. [Error catalog](#13-error-catalog)

---

## 1. Module Structure

```
src/storage_v2/
  mod.rs            ← re-exports, SegmentType enum
  types.rs          ← NodeRecordV2, EdgeRecordV2, SegmentHeaderV2, SegmentMeta, constants
  string_table.rs   ← StringTableV2 (index-based, O(1) lookup)
  bloom.rs          ← BloomFilter (key-split double-hashing)
  zone_map.rs       ← ZoneMap (per-field distinct value sets)
  writer.rs         ← NodeSegmentWriter, EdgeSegmentWriter
  segment.rs        ← NodeSegmentV2, EdgeSegmentV2 (read path)
```

All v2 types live under `storage_v2`. No modifications to existing `storage/` module — v1 and v2 coexist.

---

## 2. Phase 1: types.rs + mod.rs skeleton

**Goal:** Define all data structures and constants. Zero logic, pure types.

### File: `types.rs`

```rust
// === Constants ===

/// Magic bytes for v2 segment files
pub const MAGIC_V2: [u8; 4] = *b"SGV2";

/// Magic bytes for v1 segments (used in error detection)
pub const MAGIC_V1: [u8; 4] = *b"SGRF";

/// Format version
pub const FORMAT_VERSION: u16 = 2;

/// Header size in bytes (fixed, power-of-2, cache-line friendly)
pub const HEADER_SIZE: usize = 32;

/// Footer index magic (ASCII "FTR2")
pub const FOOTER_INDEX_MAGIC: u32 = 0x46545232;

/// Footer index size in bytes: 5 * u64 + u32 = 44 bytes
pub const FOOTER_INDEX_SIZE: usize = 44;

/// Bloom filter: bits per key
pub const BLOOM_BITS_PER_KEY: usize = 10;

/// Bloom filter: number of hash functions (optimal for 10 bits/key)
pub const BLOOM_NUM_HASHES: usize = 7;

/// Recommended max records per segment
pub const RECOMMENDED_MAX_RECORDS: u64 = 1_000_000;

/// Max string table data size (u32 offset range)
pub const MAX_STRING_TABLE_DATA_BYTES: usize = u32::MAX as usize;
```

```rust
// === Segment Type ===

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SegmentType {
    Nodes = 0,
    Edges = 1,
}

impl SegmentType {
    pub fn from_u8(v: u8) -> Option<Self> { ... }
}
```

```rust
// === Header ===

/// V2 segment header — exactly 32 bytes on disk
#[derive(Debug, Clone, Copy)]
pub struct SegmentHeaderV2 {
    pub magic: [u8; 4],           // offset 0,  4 bytes
    pub version: u16,             // offset 4,  2 bytes
    pub segment_type: SegmentType,// offset 6,  1 byte
    pub reserved_1: u8,           // offset 7,  1 byte  (0x00)
    pub record_count: u64,        // offset 8,  8 bytes
    pub footer_offset: u64,       // offset 16, 8 bytes
    pub reserved_2: u64,          // offset 24, 8 bytes (0x00)
}

impl SegmentHeaderV2 {
    pub fn new(segment_type: SegmentType, record_count: u64, footer_offset: u64) -> Self;
    pub fn validate(&self) -> Result<()>;

    /// Read header from byte slice (>= 32 bytes)
    pub fn from_bytes(bytes: &[u8]) -> Result<Self>;

    /// Write header to byte slice or writer
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()>;
}
```

```rust
// === Footer Index ===

/// Footer index — last 44 bytes before EOF
/// Layout: bloom_offset(8) + dst_bloom_offset(8) + zone_maps_offset(8)
///       + string_table_offset(8) + data_end_offset(8) + magic(4)
#[derive(Debug, Clone, Copy)]
pub struct FooterIndex {
    pub bloom_offset: u64,
    pub dst_bloom_offset: u64,      // 0 for node segments
    pub zone_maps_offset: u64,
    pub string_table_offset: u64,
    pub data_end_offset: u64,       // DECISION-5: byte offset where column data ends
    pub magic: u32,                 // FOOTER_INDEX_MAGIC
}

impl FooterIndex {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self>;
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()>;
}
```

```rust
// === Record Types ===

/// Node record for v2 storage
#[derive(Debug, Clone, PartialEq)]
pub struct NodeRecordV2 {
    pub semantic_id: String,
    pub id: u128,              // BLAKE3(semantic_id), always derived
    pub node_type: String,     // NOT optional in v2
    pub name: String,
    pub file: String,
    pub content_hash: u64,     // 0 = not computed
    pub metadata: String,      // "" = no metadata (NOT "{}")
}

/// Edge record for v2 storage
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeRecordV2 {
    pub src: u128,
    pub dst: u128,
    pub edge_type: String,     // NOT optional in v2
    pub metadata: String,      // "" = no metadata
    // NOTE: _owner is stored inside metadata JSON, not as a column (GAP-3)
}
```

```rust
// === Segment Metadata (returned by writer) ===

/// Metadata about a written segment, for use by manifest/catalog
#[derive(Debug, Clone)]
pub struct SegmentMeta {
    pub record_count: u64,
    pub byte_size: u64,
    pub segment_type: SegmentType,
    pub node_types: HashSet<String>,
    pub file_paths: HashSet<String>,
    pub edge_types: HashSet<String>,
}
```

```rust
// === Helper ===

/// Compute padding bytes needed to align `offset` to `alignment`
/// Padding bytes are always 0x00 (GAP-5)
pub fn compute_padding(offset: usize, alignment: usize) -> usize {
    let rem = offset % alignment;
    if rem == 0 { 0 } else { alignment - rem }
}
```

### File: `mod.rs` (skeleton)

```rust
pub mod types;
pub mod string_table;
pub mod bloom;
pub mod zone_map;
pub mod writer;
pub mod segment;

pub use types::*;
pub use string_table::StringTableV2;
pub use bloom::BloomFilter;
pub use zone_map::ZoneMap;
pub use writer::{NodeSegmentWriter, EdgeSegmentWriter};
pub use segment::{NodeSegmentV2, EdgeSegmentV2};
```

### Tests for Phase 1

```
test_segment_type_from_u8()          — roundtrip SegmentType <-> u8
test_header_size()                   — assert size_of header fields == HEADER_SIZE
test_footer_index_size()             — assert size_of footer index fields == FOOTER_INDEX_SIZE
test_compute_padding()               — verify padding for various offsets and alignments
test_compute_padding_already_aligned()— padding(16, 16) == 0
test_compute_padding_zero_records()  — padding for N=0 scenario
```

### Dependencies

None. Pure data types.

### Estimated LOC: ~120 (types.rs) + ~20 (mod.rs) = ~140

---

## 3. Phase 2: string_table.rs

**Goal:** Index-based string table with O(1) lookup. Complete rewrite from v1. (DECISION-1: YES)

### Binary format (NEW, not v1-compatible)

```
[string_count: u32]                                    // 4 bytes
[total_data_len: u32]                                  // 4 bytes
[entries: (offset: u32, length: u32) × string_count]   // 8 bytes per string
[data: u8 × total_data_len]                            // concatenated UTF-8 strings
```

Total overhead: 8 + 8 * string_count bytes. For 1000 strings: 8,008 bytes.

### Struct and API

```rust
/// Index-based string table with O(1) lookup
///
/// Write path: intern() returns a u32 index (0, 1, 2, ...).
/// Column arrays store these indices, NOT byte offsets.
/// Read path: get(index) returns &str in O(1).
pub struct StringTableV2 {
    /// Concatenated string data (UTF-8 bytes)
    data: Vec<u8>,
    /// (offset, length) pairs, one per unique string
    entries: Vec<(u32, u32)>,
    /// Dedup index: string -> index (only populated during write)
    index: HashMap<String, u32>,
}

impl StringTableV2 {
    /// Create empty string table for writing
    pub fn new() -> Self;

    /// Intern a string, returning its index (0-based).
    /// If already interned, returns existing index. O(1) amortized.
    ///
    /// Panics (debug_assert) if total data exceeds MAX_STRING_TABLE_DATA_BYTES.
    pub fn intern(&mut self, s: &str) -> u32;

    /// Get string by index. O(1).
    /// Returns None if index >= string_count.
    pub fn get(&self, index: u32) -> Option<&str>;

    /// Number of unique strings
    pub fn len(&self) -> usize;

    /// Whether the table is empty
    pub fn is_empty(&self) -> bool;

    /// Serialize to writer
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()>;

    /// Deserialize from byte slice (for mmap)
    /// Rebuilds entries but NOT the dedup index (read-only after load)
    pub fn from_bytes(bytes: &[u8]) -> Result<Self>;

    /// Total serialized size in bytes
    pub fn serialized_size(&self) -> usize;
}
```

### Key implementation details

1. `intern()`: Check `self.index` HashMap first (O(1) amortized). If miss: append to `self.data`, push `(offset, len)` to `self.entries`, insert into `self.index`. Return index = `self.entries.len() - 1`.

2. `get()`: Bounds-check index, read `self.entries[index]`, slice `self.data[offset..offset+length]`, `from_utf8_unchecked` (safe because we only store valid UTF-8 from `intern()`).

3. `from_bytes()`: Read string_count, total_data_len, entries array, data blob. Do NOT rebuild `self.index` HashMap — loaded string tables are read-only.

4. `write_to()`: Write string_count (u32 LE), total_data_len (u32 LE), entries (pairs of u32 LE), data blob.

### Error cases

| Condition | Error |
|-----------|-------|
| `from_bytes()` with < 8 bytes | `GraphError::InvalidFormat("String table too small")` |
| `from_bytes()` with truncated entries | `GraphError::InvalidFormat("String table entries truncated")` |
| `from_bytes()` with truncated data | `GraphError::InvalidFormat("String table data truncated")` |
| `from_bytes()` with offset+length overflowing data | `GraphError::InvalidFormat("String table entry out of bounds")` |
| `from_bytes()` with invalid UTF-8 in data | `GraphError::InvalidFormat("String table contains invalid UTF-8")` |
| `intern()` causing data > 4GB | `debug_assert!` panic (never happens with recommended segment sizes) |

### Tests (TDD — write first)

```
test_string_table_empty()             — new table: len()==0, get(0)==None
test_string_table_intern_one()        — intern("hello") returns 0, get(0)=="hello"
test_string_table_intern_multiple()   — intern 3 strings, get each by index
test_string_table_dedup()             — intern("a"), intern("a") returns same index
test_string_table_roundtrip()         — intern N strings, write, from_bytes, get all back
test_string_table_empty_string()      — intern("") returns valid index, get() returns ""
test_string_table_unicode()           — intern("функция"), roundtrip OK
test_string_table_very_long()         — intern 10KB string, roundtrip OK
test_string_table_serialized_size()   — verify serialized_size() matches actual write
test_string_table_from_bytes_too_small() — < 8 bytes → error
test_string_table_from_bytes_truncated() — partial data → error
```

**Property-based test (proptest):**
```
proptest_string_table_roundtrip()     — random Vec<String>, intern all, write, from_bytes,
                                        verify get(i) == original[i] for all unique strings
```

### Dependencies

- `std::collections::HashMap`
- `crate::error::{GraphError, Result}`

### Estimated LOC: ~200 (including tests)

---

## 4. Phase 3: bloom.rs

**Goal:** Bloom filter with key-split double-hashing. No external hash dependency — u128 keys ARE the hash. (DECISION-2: YES, DECISION-3: YES)

### Binary format

```
[num_bits: u64]           // 8 bytes
[num_hashes: u32]         // 4 bytes
[padding: u32]            // 4 bytes (0x00)
[bits: u64 × word_count]  // word_count = ceil(num_bits / 64), 8 bytes each
```

Total: 16 + 8 * ceil(num_bits / 64) bytes.

For 1000 keys at 10 bits/key: 16 + 8 * ceil(10000/64) = 16 + 8 * 157 = 1,272 bytes.

### Struct and API

```rust
/// Bloom filter with key-split enhanced double-hashing
///
/// Keys are u128 values (already BLAKE3 hashes). The key is split:
///   h1 = lower 64 bits
///   h2 = upper 64 bits | 1  (ensure odd, DECISION-3)
///   probe_i = (h1 + i * h2) % num_bits
///
/// Parameters: 10 bits/key, k=7 → ~0.82% FPR (under 1% target)
pub struct BloomFilter {
    bits: Vec<u64>,
    num_bits: usize,
    num_hashes: usize,
}

impl BloomFilter {
    /// Create empty bloom filter sized for `num_keys` items
    /// Uses BLOOM_BITS_PER_KEY and BLOOM_NUM_HASHES constants.
    /// If num_keys == 0, creates a minimal filter that always returns false.
    pub fn new(num_keys: usize) -> Self;

    /// Insert a u128 key into the filter. O(k) = O(7) = O(1).
    pub fn insert(&mut self, key: u128);

    /// Check if key might be in the filter. O(k) = O(1).
    /// Returns false → definitely not present.
    /// Returns true → possibly present (FPR ~0.82%).
    pub fn maybe_contains(&self, key: u128) -> bool;

    /// Number of bits in the filter
    pub fn num_bits(&self) -> usize;

    /// Number of hash functions
    pub fn num_hashes(&self) -> usize;

    /// Serialize to writer
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()>;

    /// Deserialize from byte slice
    pub fn from_bytes(bytes: &[u8]) -> Result<Self>;

    /// Total serialized size in bytes
    pub fn serialized_size(&self) -> usize;
}
```

### Internal helper (not pub)

```rust
/// Compute k probe positions for a u128 key using key-split double-hashing.
/// h1 = key as two u64s: lower 64 bits
/// h2 = upper 64 bits | 1 (always odd → coprime with any even num_bits)
fn probe_positions(key: u128, num_hashes: usize, num_bits: usize) -> impl Iterator<Item = usize>;
```

### Key implementation details

1. **`new(num_keys)`**: `num_bits = max(64, num_keys * BLOOM_BITS_PER_KEY)`. Round up to next multiple of 64. `word_count = num_bits / 64`. Allocate `vec![0u64; word_count]`.

2. **`insert(key)`**: For each probe position, set `bits[pos / 64] |= 1 << (pos % 64)`.

3. **`maybe_contains(key)`**: For each probe position, check `bits[pos / 64] & (1 << (pos % 64)) != 0`. Short-circuit on first miss.

4. **Key-split**: `let bytes = key.to_le_bytes(); h1 = u64::from_le_bytes(bytes[0..8]); h2 = u64::from_le_bytes(bytes[8..16]) | 1;`

5. **Empty filter (0 keys)**: `num_bits = 64` (one word), all zeros, `maybe_contains()` always returns false.

### Error cases

| Condition | Error |
|-----------|-------|
| `from_bytes()` with < 16 bytes | `GraphError::InvalidFormat("Bloom filter too small")` |
| `from_bytes()` with truncated bit array | `GraphError::InvalidFormat("Bloom filter data truncated")` |
| `from_bytes()` with num_bits == 0 | `GraphError::InvalidFormat("Bloom filter has zero bits")` |

### Tests (TDD)

```
test_bloom_empty()                    — empty bloom, maybe_contains() always false
test_bloom_single_item()              — insert 1 key, found=true, random others likely false
test_bloom_no_false_negatives()       — insert 1000 keys, all found
test_bloom_roundtrip()                — insert keys, write, from_bytes, verify all still found
test_bloom_serialized_size()          — verify serialized_size() matches actual write
test_bloom_from_bytes_too_small()     — < 16 bytes → error
test_bloom_from_bytes_truncated()     — partial data → error
```

**Property-based tests (proptest):**
```
proptest_bloom_no_false_negatives()   — random Vec<u128>, insert all, verify all found
```

**Statistical test (slow, Phase 6 in test plan):**
```
test_bloom_fpr_under_2_percent()      — insert 10000 keys, test 100000 random keys,
                                        measure FPR, assert < 2%
```

### Dependencies

- `crate::error::{GraphError, Result}`

No external hash crate needed — keys are already hashes.

### Estimated LOC: ~200 (including tests)

---

## 5. Phase 4: zone_map.rs

**Goal:** Per-field distinct value tracking for segment skipping. Tiny data structure.

### Binary format

```
[field_count: u32]                    // 4 bytes
For each field:
  [field_name_len: u16]              // 2 bytes
  [field_name: utf8 bytes]           // variable
  [value_count: u32]                 // 4 bytes
  For each value:
    [value_len: u16]                 // 2 bytes
    [value: utf8 bytes]              // variable
```

### Struct and API

```rust
/// Per-field distinct value tracking for segment skipping.
///
/// Tracks which distinct values appear in a segment for indexed fields.
/// Typically: node_type, file, edge_type.
///
/// Zone map query: "does this segment contain nodeType=FUNCTION?"
/// If not in zone map → skip entire segment. O(1) lookup.
pub struct ZoneMap {
    fields: HashMap<String, HashSet<String>>,
}

impl ZoneMap {
    /// Create empty zone map
    pub fn new() -> Self;

    /// Add a value for a field. O(1) amortized.
    pub fn add(&mut self, field: &str, value: &str);

    /// Check if field contains a specific value. O(1).
    pub fn contains(&self, field: &str, value: &str) -> bool;

    /// Get all distinct values for a field. O(1).
    pub fn get_values(&self, field: &str) -> Option<&HashSet<String>>;

    /// Number of tracked fields
    pub fn field_count(&self) -> usize;

    /// Serialize to writer
    pub fn write_to<W: Write>(&self, writer: &mut W) -> Result<()>;

    /// Deserialize from byte slice
    pub fn from_bytes(bytes: &[u8]) -> Result<Self>;

    /// Total serialized size in bytes
    pub fn serialized_size(&self) -> usize;
}
```

### Key implementation details

1. **`add()`**: `self.fields.entry(field.to_string()).or_default().insert(value.to_string())`.

2. **`contains()`**: `self.fields.get(field).map_or(false, |s| s.contains(value))`.

3. **`write_to()`**: Iterate fields in sorted order (for deterministic output / byte-exact roundtrip). For each field: write name length (u16 LE), name bytes, value count (u32 LE), then for each value (also sorted): write value length (u16 LE), value bytes.

4. **`from_bytes()`**: Inverse of write_to. Read field_count, then loop.

5. **Sorting for determinism**: Both fields and values within each field must be sorted lexicographically to ensure `write → read → write` produces identical bytes.

### Error cases

| Condition | Error |
|-----------|-------|
| `from_bytes()` with < 4 bytes | `GraphError::InvalidFormat("Zone map too small")` |
| `from_bytes()` with truncated field | `GraphError::InvalidFormat("Zone map field truncated")` |
| `from_bytes()` with truncated value | `GraphError::InvalidFormat("Zone map value truncated")` |
| `from_bytes()` with invalid UTF-8 | `GraphError::InvalidFormat("Zone map contains invalid UTF-8")` |
| field_name_len > remaining bytes | `GraphError::InvalidFormat("Zone map field name overflow")` |

### Tests (TDD)

```
test_zone_map_empty()                 — new: field_count()==0, contains("x","y")==false
test_zone_map_add_and_contains()      — add values, verify contains
test_zone_map_multiple_fields()       — node_type + file, verify independently
test_zone_map_dedup()                 — add("file","a.js") twice, get_values has 1 entry
test_zone_map_roundtrip()             — add values, write, from_bytes, verify all
test_zone_map_exact_values()          — verify get_values returns exactly the added set
test_zone_map_empty_segment()         — empty zone map roundtrip
test_zone_map_single_type()           — one field, one value
test_zone_map_serialized_size()       — verify serialized_size() matches actual write
test_zone_map_from_bytes_too_small()  — < 4 bytes → error
test_zone_map_byte_exact()            — write → from_bytes → write produces same bytes
```

### Dependencies

- `std::collections::{HashMap, HashSet}`
- `crate::error::{GraphError, Result}`

### Estimated LOC: ~150

---

## 6. Phase 5: writer.rs

**Goal:** Write node and edge segments to files. Depends on types, string_table, bloom, zone_map.

### Struct and API

```rust
/// Writer for node segments
pub struct NodeSegmentWriter {
    records: Vec<NodeRecordV2>,
    string_table: StringTableV2,
}

impl NodeSegmentWriter {
    pub fn new() -> Self;

    /// Add a node record. O(1) amortized.
    /// Validates: id == BLAKE3(semantic_id) in debug mode.
    pub fn add(&mut self, record: NodeRecordV2);

    /// Number of records added
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;

    /// Write the segment to a writer. Consumes self.
    /// Returns SegmentMeta describing what was written.
    ///
    /// Write sequence:
    /// 1. Intern all strings into string table
    /// 2. Build bloom filter from ids
    /// 3. Build zone maps from distinct values
    /// 4. Write header (with placeholder footer_offset=0)
    /// 5. Write column data (u32 columns → padding → u128 column → u64 column)
    /// 6. Write footer (bloom, zone maps, string table)
    /// 7. Write footer index
    /// 8. Seek back to header byte 16, update footer_offset
    /// 9. Flush
    pub fn finish<W: Write + Seek>(self, writer: &mut W) -> Result<SegmentMeta>;
}
```

```rust
/// Writer for edge segments
pub struct EdgeSegmentWriter {
    records: Vec<EdgeRecordV2>,
    string_table: StringTableV2,
}

impl EdgeSegmentWriter {
    pub fn new() -> Self;

    pub fn add(&mut self, record: EdgeRecordV2);

    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;

    /// Write the edge segment. Consumes self.
    ///
    /// Write sequence:
    /// 1. Intern all strings
    /// 2. Build src bloom filter from src ids
    /// 3. Build dst bloom filter from dst ids
    /// 4. Build zone maps (edge_type)
    /// 5. Write header
    /// 6. Write column data (u128 src → u128 dst → u32 edge_type → u32 metadata)
    /// 7. Write footer (src bloom, dst bloom, zone maps, string table)
    /// 8. Write footer index
    /// 9. Seek back to update footer_offset
    /// 10. Flush
    pub fn finish<W: Write + Seek>(self, writer: &mut W) -> Result<SegmentMeta>;
}
```

### Node column write order (detailed byte layout)

```
Offset 0:   Header (32 bytes)
Offset 32:  semantic_id indices [u32 × N]     — 4N bytes
            node_type indices   [u32 × N]     — 4N bytes
            name indices        [u32 × N]     — 4N bytes
            file indices        [u32 × N]     — 4N bytes
            metadata indices    [u32 × N]     — 4N bytes
            ---- end of u32 section: 20N bytes ----
            padding to 16-byte boundary       — 0..12 bytes (0x00)
            id column           [u128 × N]    — 16N bytes
            content_hash column [u64 × N]     — 8N bytes
            ---- end of column data ----
```

**Padding calculation for node columns:**

```
u32_section_end = HEADER_SIZE + 20 * N   // = 32 + 20N
padding = compute_padding(u32_section_end, 16)
// Per Don's verification:
// N % 4 == 0 → 0 bytes padding
// N % 4 == 1 → 12 bytes padding
// N % 4 == 2 → 8 bytes padding
// N % 4 == 3 → 4 bytes padding
```

### Edge column write order

```
Offset 0:   Header (32 bytes)
Offset 32:  src column  [u128 × N]   — 16N bytes (16-byte aligned: 32 % 16 == 0)
            dst column  [u128 × N]   — 16N bytes
            ---- no padding needed (32 + 32N is always 4-byte aligned) ----
            edge_type indices [u32 × N] — 4N bytes
            metadata indices  [u32 × N] — 4N bytes
            ---- end of column data ----
```

### Write path: `finish()` step-by-step for NodeSegmentWriter

```rust
fn finish<W: Write + Seek>(self, writer: &mut W) -> Result<SegmentMeta> {
    let n = self.records.len();

    // Step 1: Intern all strings, build column arrays
    // (string_table already populated during add(), OR do it here in batch)
    let mut string_table = self.string_table;  // already has strings from add()
    let mut semantic_id_indices: Vec<u32> = Vec::with_capacity(n);
    let mut node_type_indices: Vec<u32> = Vec::with_capacity(n);
    let mut name_indices: Vec<u32> = Vec::with_capacity(n);
    let mut file_indices: Vec<u32> = Vec::with_capacity(n);
    let mut metadata_indices: Vec<u32> = Vec::with_capacity(n);
    let mut ids: Vec<u128> = Vec::with_capacity(n);
    let mut content_hashes: Vec<u64> = Vec::with_capacity(n);

    // Also build zone map and bloom inputs
    let mut zone_map = ZoneMap::new();
    let mut bloom_keys: Vec<u128> = Vec::with_capacity(n);

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
        bloom_keys.push(record.id);
    }

    // Step 2: Build bloom filter
    let mut bloom = BloomFilter::new(n);
    for &key in &bloom_keys {
        bloom.insert(key);
    }

    // Step 3: Write header with placeholder footer_offset=0
    let header = SegmentHeaderV2::new(SegmentType::Nodes, n as u64, 0);
    header.write_to(writer)?;

    // Step 4: Write u32 columns
    for &idx in &semantic_id_indices { writer.write_all(&idx.to_le_bytes())?; }
    for &idx in &node_type_indices   { writer.write_all(&idx.to_le_bytes())?; }
    for &idx in &name_indices        { writer.write_all(&idx.to_le_bytes())?; }
    for &idx in &file_indices        { writer.write_all(&idx.to_le_bytes())?; }
    for &idx in &metadata_indices    { writer.write_all(&idx.to_le_bytes())?; }

    // Step 5: Padding to 16-byte boundary (0x00 bytes, GAP-5)
    let current_offset = HEADER_SIZE + 20 * n;
    let padding = compute_padding(current_offset, 16);
    writer.write_all(&vec![0u8; padding])?;

    // Step 6: Write u128 column (ids)
    for &id in &ids { writer.write_all(&id.to_le_bytes())?; }

    // Step 7: Write u64 column (content_hash)
    for &hash in &content_hashes { writer.write_all(&hash.to_le_bytes())?; }

    // Record data_end_offset (DECISION-5)
    let data_end_offset = writer.stream_position()?;

    // Step 8: Write footer sections
    let bloom_offset = writer.stream_position()?;
    bloom.write_to(writer)?;

    let dst_bloom_offset = 0u64;  // No dst bloom for nodes

    let zone_maps_offset = writer.stream_position()?;
    zone_map.write_to(writer)?;

    let string_table_offset = writer.stream_position()?;
    string_table.write_to(writer)?;

    // Step 9: Write footer index
    let footer_offset = writer.stream_position()?;
    let footer_index = FooterIndex {
        bloom_offset,
        dst_bloom_offset,
        zone_maps_offset,
        string_table_offset,
        data_end_offset,
        magic: FOOTER_INDEX_MAGIC,
    };
    footer_index.write_to(writer)?;

    let total_size = writer.stream_position()?;

    // Step 10: Seek back to header and update footer_offset
    writer.seek(SeekFrom::Start(16))?;  // footer_offset is at byte 16
    writer.write_all(&footer_offset.to_le_bytes())?;

    // Step 11: Flush
    writer.flush()?;

    Ok(SegmentMeta { ... })
}
```

### Write path: `finish()` differences for EdgeSegmentWriter

- Column order: u128 src, u128 dst, u32 edge_type, u32 metadata (no padding between u128 and u32 — 32 + 32N is always 4-byte aligned)
- Two bloom filters: src bloom (from all src values), dst bloom (from all dst values)
- Zone map: tracks `edge_type` only (no `file` for edges)
- Footer: bloom, dst_bloom, zone_maps, string_table (dst_bloom_offset is nonzero)

### Interning strategy decision

Strings are interned during `finish()`, not during `add()`. Reason: `add()` takes ownership of `NodeRecordV2` which already owns the strings. No point interning eagerly since we need the records in memory anyway for column extraction.

Exception: if we discover memory is a concern (large segments), we could intern during `add()` and store indices instead of strings. But for recommended max 1M records, keeping records in memory is fine.

### Error cases

| Condition | Error |
|-----------|-------|
| IO error during write | propagated `GraphError::Io(...)` |
| Seek failure | propagated `GraphError::Io(...)` |
| `debug_assert!(record.id == blake3_of(semantic_id))` | panic in debug builds only |

### Tests

```
test_write_empty_node_segment()       — 0 records, valid file, can open
test_write_single_node()              — 1 record, roundtrip
test_write_empty_edge_segment()       — 0 records
test_write_single_edge()              — 1 record
test_write_multiple_nodes()           — 100 random nodes, verify file size
test_write_multiple_edges()           — 100 random edges
test_write_node_column_alignment()    — verify u128 at 16-byte boundary for N=1,2,3,4,5
test_write_padding_is_zeroes()        — read raw bytes, verify padding = 0x00
test_write_footer_offset_updated()    — read raw bytes, verify header.footer_offset != 0
```

### Dependencies

- `types.rs` (constants, record types, header, footer index)
- `string_table.rs` (StringTableV2)
- `bloom.rs` (BloomFilter)
- `zone_map.rs` (ZoneMap)
- `blake3` (for debug_assert id verification)
- `std::io::{Write, Seek, BufWriter}`
- `crate::error::{GraphError, Result}`

### Estimated LOC: ~450

---

## 7. Phase 6: segment.rs

**Goal:** Read path — open segments via mmap, provide column access and bloom/zone map queries.

### Struct and API: NodeSegmentV2

```rust
/// Immutable node segment reader (memory-mapped)
///
/// Open sequence:
/// 1. mmap the file
/// 2. Read header (first 32 bytes), validate magic
/// 3. Read footer index (last FOOTER_INDEX_SIZE bytes)
/// 4. Validate: footer_index.magic == FOOTER_INDEX_MAGIC
/// 5. Validate: data_end_offset == computed column data size
/// 6. Load bloom filter from footer
/// 7. Load zone map from footer
/// 8. Load string table from footer
/// 9. Compute column offsets arithmetically
pub struct NodeSegmentV2 {
    mmap: Mmap,
    header: SegmentHeaderV2,
    footer_index: FooterIndex,
    bloom: BloomFilter,
    zone_map: ZoneMap,
    string_table: StringTableV2,

    // Computed column offsets
    semantic_id_offset: usize,    // = HEADER_SIZE
    node_type_offset: usize,      // = HEADER_SIZE + 4*N
    name_offset: usize,           // = HEADER_SIZE + 8*N
    file_offset: usize,           // = HEADER_SIZE + 12*N
    metadata_offset: usize,       // = HEADER_SIZE + 16*N
    ids_offset: usize,            // = HEADER_SIZE + 20*N + padding
    content_hash_offset: usize,   // = ids_offset + 16*N
}

impl NodeSegmentV2 {
    /// Open a node segment from file path.
    /// Validates magic, version, segment type, footer index, data_end_offset.
    pub fn open(path: &Path) -> Result<Self>;

    /// Open from existing Mmap (for testing / embedding)
    pub fn from_mmap(mmap: Mmap) -> Result<Self>;

    // --- Column accessors (all O(1)) ---

    /// Number of records in the segment
    pub fn record_count(&self) -> usize;

    /// Get node id (u128) at index. Panics if out of bounds.
    pub fn get_id(&self, index: usize) -> u128;

    /// Get semantic_id string at index. O(1) via string table.
    pub fn get_semantic_id(&self, index: usize) -> &str;

    /// Get node_type string at index. O(1).
    pub fn get_node_type(&self, index: usize) -> &str;

    /// Get name string at index. O(1).
    pub fn get_name(&self, index: usize) -> &str;

    /// Get file path string at index. O(1).
    pub fn get_file(&self, index: usize) -> &str;

    /// Get content_hash (u64) at index. O(1).
    pub fn get_content_hash(&self, index: usize) -> u64;

    /// Get metadata string at index. O(1).
    pub fn get_metadata(&self, index: usize) -> &str;

    /// Reconstruct full record at index. O(1), but allocates strings.
    pub fn get_record(&self, index: usize) -> NodeRecordV2;

    // --- Bloom filter ---

    /// Check if an id might exist in this segment.
    /// false → definitely not here. true → maybe here.
    pub fn maybe_contains(&self, id: u128) -> bool;

    // --- Zone map ---

    /// Check if this segment contains records with given node_type. O(1).
    pub fn contains_node_type(&self, node_type: &str) -> bool;

    /// Check if this segment contains records with given file path. O(1).
    pub fn contains_file(&self, file: &str) -> bool;

    // --- Iteration ---

    /// Iterator over all record indices
    pub fn iter_indices(&self) -> impl Iterator<Item = usize>;

    /// Iterator that reconstructs full records
    pub fn iter(&self) -> impl Iterator<Item = NodeRecordV2> + '_;
}
```

### Struct and API: EdgeSegmentV2

```rust
/// Immutable edge segment reader (memory-mapped)
pub struct EdgeSegmentV2 {
    mmap: Mmap,
    header: SegmentHeaderV2,
    footer_index: FooterIndex,
    src_bloom: BloomFilter,
    dst_bloom: BloomFilter,
    zone_map: ZoneMap,
    string_table: StringTableV2,

    // Computed column offsets
    src_offset: usize,           // = HEADER_SIZE
    dst_offset: usize,           // = HEADER_SIZE + 16*N
    edge_type_offset: usize,     // = HEADER_SIZE + 32*N (no padding needed)
    metadata_offset: usize,      // = HEADER_SIZE + 32*N + 4*N
}

impl EdgeSegmentV2 {
    pub fn open(path: &Path) -> Result<Self>;
    pub fn from_mmap(mmap: Mmap) -> Result<Self>;

    pub fn record_count(&self) -> usize;

    pub fn get_src(&self, index: usize) -> u128;
    pub fn get_dst(&self, index: usize) -> u128;
    pub fn get_edge_type(&self, index: usize) -> &str;
    pub fn get_metadata(&self, index: usize) -> &str;
    pub fn get_record(&self, index: usize) -> EdgeRecordV2;

    /// Bloom check on src field
    pub fn maybe_contains_src(&self, src: u128) -> bool;

    /// Bloom check on dst field (N8)
    pub fn maybe_contains_dst(&self, dst: u128) -> bool;

    /// Zone map check on edge_type
    pub fn contains_edge_type(&self, edge_type: &str) -> bool;

    pub fn iter_indices(&self) -> impl Iterator<Item = usize>;
    pub fn iter(&self) -> impl Iterator<Item = EdgeRecordV2> + '_;
}
```

### Column offset computation (NodeSegmentV2)

```rust
fn compute_node_column_offsets(record_count: usize) -> NodeColumnOffsets {
    let n = record_count;
    let semantic_id_offset = HEADER_SIZE;                     // 32
    let node_type_offset   = semantic_id_offset + 4 * n;     // 32 + 4N
    let name_offset        = node_type_offset + 4 * n;       // 32 + 8N
    let file_offset        = name_offset + 4 * n;            // 32 + 12N
    let metadata_offset    = file_offset + 4 * n;            // 32 + 16N
    let u32_end            = metadata_offset + 4 * n;        // 32 + 20N
    let padding            = compute_padding(u32_end, 16);
    let ids_offset         = u32_end + padding;              // 16-byte aligned
    let content_hash_offset = ids_offset + 16 * n;
    // ...
}
```

### Column offset computation (EdgeSegmentV2)

```rust
fn compute_edge_column_offsets(record_count: usize) -> EdgeColumnOffsets {
    let n = record_count;
    let src_offset       = HEADER_SIZE;                     // 32
    let dst_offset       = src_offset + 16 * n;            // 32 + 16N
    let edge_type_offset = dst_offset + 16 * n;            // 32 + 32N (always 4-aligned)
    let metadata_offset  = edge_type_offset + 4 * n;       // 32 + 32N + 4N
    // ...
}
```

### Reading a u32 string table index and resolving

```rust
fn read_string_at(&self, column_offset: usize, index: usize) -> &str {
    let byte_offset = column_offset + index * 4;
    let bytes: [u8; 4] = self.mmap[byte_offset..byte_offset + 4].try_into().unwrap();
    let str_index = u32::from_le_bytes(bytes);
    self.string_table.get(str_index).expect("invalid string table index")
}
```

### `open()` validation sequence

```rust
pub fn open(path: &Path) -> Result<Self> {
    let file = File::open(path)?;
    let mmap = unsafe { Mmap::map(&file)? };

    // 1. Minimum size check
    if mmap.len() < HEADER_SIZE + FOOTER_INDEX_SIZE {
        return Err(GraphError::InvalidFormat("File too small for v2 segment"));
    }

    // 2. Read and validate header
    let header = SegmentHeaderV2::from_bytes(&mmap[..HEADER_SIZE])?;
    // header.validate() checks:
    //   - magic == MAGIC_V2 (if MAGIC_V1 → "v1 segment, use migration tool")
    //   - version == FORMAT_VERSION
    //   - segment_type == Nodes

    // 3. Read footer index (last FOOTER_INDEX_SIZE bytes)
    let fi_start = mmap.len() - FOOTER_INDEX_SIZE;
    let footer_index = FooterIndex::from_bytes(&mmap[fi_start..])?;
    // Validate footer_index.magic == FOOTER_INDEX_MAGIC

    // 4. Validate footer_offset
    if header.footer_offset as usize >= mmap.len() {
        return Err(GraphError::InvalidFormat("footer_offset past EOF"));
    }

    // 5. Validate data_end_offset (DECISION-5)
    let expected_data_end = compute_node_data_end(header.record_count as usize);
    if footer_index.data_end_offset != expected_data_end as u64 {
        return Err(GraphError::InvalidFormat("data_end_offset mismatch"));
    }

    // 6. Load footer components using offsets from footer_index
    let bloom = BloomFilter::from_bytes(
        &mmap[footer_index.bloom_offset as usize..footer_index.zone_maps_offset as usize]
    )?;

    let zone_map = ZoneMap::from_bytes(
        &mmap[footer_index.zone_maps_offset as usize..footer_index.string_table_offset as usize]
    )?;

    let string_table = StringTableV2::from_bytes(
        &mmap[footer_index.string_table_offset as usize..header.footer_offset as usize]
    )?;

    // 7. Compute column offsets
    // ...

    Ok(Self { ... })
}
```

### Error cases

| Condition | Error |
|-----------|-------|
| File too small (< 76 bytes) | `InvalidFormat("File too small for v2 segment")` |
| Wrong magic (not SGV2) | `InvalidFormat("Not a v2 segment: expected SGV2, got XXXX")` |
| V1 magic (SGRF) | `InvalidFormat("v1 segment detected (SGRF). Use migration tool.")` |
| Wrong version (!= 2) | `InvalidFormat("Unsupported segment version: X")` |
| Wrong segment_type | `InvalidFormat("Expected node segment, got edge")` |
| footer_offset >= file_size | `InvalidFormat("footer_offset points past end of file")` |
| footer index magic mismatch | `InvalidFormat("Invalid footer index magic")` |
| data_end_offset mismatch | `InvalidFormat("data_end_offset does not match column layout")` |
| Zero-byte file | `InvalidFormat("File too small for v2 segment")` |
| Truncated footer components | propagated from bloom/zonemap/string_table `from_bytes()` |
| String index out of bounds | panic (should never happen if segment is valid) |

### Tests

**Phase 2 (core roundtrips) — depends on writer.rs being ready:**
```
test_empty_node_segment()             — 0 records: valid, readable, bloom=false
test_single_node_record()             — 1 record: all columns accessible
test_node_roundtrip_100()             — write 100 random nodes, read all back, compare
test_edge_roundtrip_100()             — same for edges
test_semantic_id_u128_derivation()    — for all nodes: BLAKE3(semantic_id) == stored id
test_content_hash_roundtrip()         — u64 survives roundtrip exactly
test_empty_edge_segment()             — 0 edges
test_single_edge_record()             — 1 edge
```

**Phase 3 (alignment and binary stability):**
```
test_column_alignment()               — verify u128 offset % 16 == 0
test_various_record_counts()          — N=0,1,2,3,7,8,15,16,100,1000
test_byte_exact_roundtrip()           — write → read → write → same bytes
```

**Phase 4 (edge cases):**
```
test_empty_metadata()                 — metadata="" roundtrips as ""
test_unicode_strings()                — unicode in all string columns
test_very_long_semantic_id()          — 500+ char semantic_id
test_max_metadata_size()              — 1MB metadata
```

**Phase 5 (corruption resilience):**
```
test_wrong_magic()                    — random 4 bytes → "Not a v2 segment"
test_v1_magic()                       — b"SGRF" → "v1 segment detected"
test_truncated_file()                 — cut file at various offsets → clean error
test_corrupted_footer_offset()        — footer_offset = file_size + 100 → error
test_zero_byte_file()                 — empty file → error
test_footer_index_at_eof()            — verify footer index is at exactly EOF - 44
```

**Phase 6 (bloom statistical + edge bloom):**
```
test_bloom_no_false_negatives_via_segment()  — write+open, maybe_contains all inserted ids
test_bloom_fpr_via_segment()                 — FPR < 2% on segment
test_dst_bloom_no_false_negatives()          — edge dst bloom works
test_dst_bloom_fpr()                         — edge dst bloom FPR < 2%
test_dst_bloom_independent()                 — src bloom != dst bloom
```

**Phase 7 (zone map via segment):**
```
test_segment_contains_node_type()     — zone map check through segment API
test_segment_contains_file()          — zone map file check
test_segment_contains_edge_type()     — edge segment zone map
```

### Dependencies

- `types.rs`
- `string_table.rs`
- `bloom.rs`
- `zone_map.rs`
- `memmap2::Mmap`
- `crate::error::{GraphError, Result}`

### Estimated LOC: ~500

---

## 8. Phase 7: Integration Tests

Place in a separate test file: `tests/storage_v2_integration.rs` (or in-module `#[cfg(test)]` blocks).

### Roundtrip tests (proptest)

```rust
proptest! {
    #[test]
    fn proptest_node_roundtrip(nodes in vec(arb_node_record_v2(), 0..500)) {
        // write to tempfile → open → verify all records match
    }

    #[test]
    fn proptest_edge_roundtrip(edges in vec(arb_edge_record_v2(), 0..500)) {
        // write to tempfile → open → verify all records match
    }
}
```

### Cross-component tests

```
test_bloom_zone_map_consistency()     — bloom says "maybe", zone map confirms type exists
test_string_table_shared_across_columns() — same string in semantic_id and name → same index
test_large_segment_1000_records()     — write 1000 nodes, verify all
test_segment_file_extension()         — verify file can be opened by path
```

### Missing tests from spec (Don's additions)

```
test_string_table_empty_table()       — empty string table roundtrip
test_node_get_individual_columns()    — verify each get_* method independently
test_edge_maybe_contains_src_dst()    — test both bloom filters on edge segment
test_footer_index_position()          — footer index is exactly at EOF - 44
```

---

## 9. Phase 8: Benchmarks

Place in `benches/segment_v2.rs`.

```rust
use criterion::{criterion_group, criterion_main, Criterion, BenchmarkId};

fn bench_write_throughput(c: &mut Criterion) {
    // Pre-generate 10K, 100K nodes
    // Measure: writer.add() + writer.finish()
    // Target: >500K nodes/sec
}

fn bench_read_sequential(c: &mut Criterion) {
    // Write segment, then: open + iter over all records
    // Target: >1M records/sec
}

fn bench_read_random(c: &mut Criterion) {
    // Write segment, then: random get_record(i)
    // Target: <10us per query
}

fn bench_bloom_check(c: &mut Criterion) {
    // Open segment, then: maybe_contains(random_id)
    // Target: <100ns
}

fn bench_zone_map_check(c: &mut Criterion) {
    // Open segment, then: contains_node_type("FUNCTION")
    // Target: <50ns
}

fn bench_segment_open(c: &mut Criterion) {
    // Measure: NodeSegmentV2::open(path)
    // Target: <1ms
}
```

Add to Cargo.toml:
```toml
[[bench]]
name = "segment_v2"
harness = false
```

---

## 10. Cargo.toml Changes

### Add to `[dev-dependencies]`

```toml
proptest = "1.4"    # Property-based testing for roundtrips and bloom FPR
```

### Do NOT add

- `xxhash-rust` — content_hash is computed by TypeScript analyzer, not RFDB. No verification needed on Rust side. (Don's analysis, section 5)
- No new runtime dependencies. `blake3` and `memmap2` are already present.

### Add bench target

```toml
[[bench]]
name = "segment_v2"
harness = false
```

---

## 11. Binary Format Reference

### Complete byte layout: Node segment

```
╔══════════════════════════════════════════════════════════════╗
║ HEADER (32 bytes)                                           ║
╠═══════╦═══════╦═══════════════════════════════════════════════╣
║ 0-3   ║ 4B    ║ magic: b"SGV2"                              ║
║ 4-5   ║ 2B    ║ version: u16 LE = 2                         ║
║ 6     ║ 1B    ║ segment_type: u8 = 0 (nodes)                ║
║ 7     ║ 1B    ║ reserved: 0x00                               ║
║ 8-15  ║ 8B    ║ record_count: u64 LE                         ║
║ 16-23 ║ 8B    ║ footer_offset: u64 LE                        ║
║ 24-31 ║ 8B    ║ reserved: 0x0000000000000000                 ║
╠═══════╩═══════╩═══════════════════════════════════════════════╣
║ COLUMN DATA                                                  ║
╠══════════════════════════════════════════════════════════════╣
║ [semantic_id indices: u32 LE × N]       4N bytes             ║
║ [node_type indices:   u32 LE × N]       4N bytes             ║
║ [name indices:        u32 LE × N]       4N bytes             ║
║ [file indices:        u32 LE × N]       4N bytes             ║
║ [metadata indices:    u32 LE × N]       4N bytes             ║
║ [padding: 0x00 × P]                    0-12 bytes            ║
║ [id column:           u128 LE × N]     16N bytes             ║
║ [content_hash column: u64 LE × N]       8N bytes             ║
╠══════════════════════════════════════════════════════════════╣
║ data_end_offset points here ↑                                ║
╠══════════════════════════════════════════════════════════════╣
║ FOOTER                                                       ║
╠══════════════════════════════════════════════════════════════╣
║ [bloom filter]         variable (see bloom format)           ║
║ [zone maps]            variable (see zone map format)        ║
║ [string table]         variable (see string table format)    ║
╠══════════════════════════════════════════════════════════════╣
║ FOOTER INDEX (44 bytes)                                      ║
╠═══════╦═══════╦═══════════════════════════════════════════════╣
║  +0   ║ 8B    ║ bloom_offset: u64 LE                         ║
║  +8   ║ 8B    ║ dst_bloom_offset: u64 LE = 0 (nodes)        ║
║ +16   ║ 8B    ║ zone_maps_offset: u64 LE                     ║
║ +24   ║ 8B    ║ string_table_offset: u64 LE                  ║
║ +32   ║ 8B    ║ data_end_offset: u64 LE                      ║
║ +40   ║ 4B    ║ magic: u32 LE = 0x46545232 ("FTR2")         ║
╚═══════╩═══════╩═══════════════════════════════════════════════╝
```

**Footer index size: 5 × 8 + 4 = 44 bytes** (updated from spec's 28 due to DECISION-5 adding `data_end_offset`)

### Complete byte layout: Edge segment

```
╔══════════════════════════════════════════════════════════════╗
║ HEADER (32 bytes)  — same as node, segment_type = 1         ║
╠══════════════════════════════════════════════════════════════╣
║ COLUMN DATA                                                  ║
╠══════════════════════════════════════════════════════════════╣
║ [src column:         u128 LE × N]      16N bytes             ║
║ [dst column:         u128 LE × N]      16N bytes             ║
║ [edge_type indices:  u32 LE × N]        4N bytes             ║
║ [metadata indices:   u32 LE × N]        4N bytes             ║
╠══════════════════════════════════════════════════════════════╣
║ data_end_offset points here ↑                                ║
╠══════════════════════════════════════════════════════════════╣
║ FOOTER                                                       ║
╠══════════════════════════════════════════════════════════════╣
║ [src bloom filter]     variable                              ║
║ [dst bloom filter]     variable                              ║
║ [zone maps]            variable                              ║
║ [string table]         variable                              ║
╠══════════════════════════════════════════════════════════════╣
║ FOOTER INDEX (44 bytes)                                      ║
║   bloom_offset → points to src bloom                         ║
║   dst_bloom_offset → points to dst bloom (nonzero for edges) ║
║   zone_maps_offset → points to zone maps                     ║
║   string_table_offset → points to string table               ║
║   data_end_offset → end of column data                       ║
║   magic: 0x46545232                                          ║
╚══════════════════════════════════════════════════════════════╝
```

**Edge note:** No padding between u128 and u32 sections. 32 + 32N is always divisible by 4. Padding would always be 0 bytes. (Don's verification, section 4)

### String table binary format (v2, NEW)

```
[string_count: u32 LE]                                // 4 bytes
[total_data_len: u32 LE]                              // 4 bytes
[(offset: u32 LE, length: u32 LE) × string_count]    // 8 bytes per string
[data: u8 × total_data_len]                           // concatenated UTF-8
```

### Bloom filter binary format

```
[num_bits: u64 LE]                    // 8 bytes
[num_hashes: u32 LE]                  // 4 bytes
[padding: u32 LE = 0]                 // 4 bytes
[bits: u64 LE × ceil(num_bits/64)]    // 8 bytes per word
```

### Zone map binary format

```
[field_count: u32 LE]                 // 4 bytes
For each field (sorted by name):
  [field_name_len: u16 LE]           // 2 bytes
  [field_name: UTF-8]                // variable
  [value_count: u32 LE]             // 4 bytes
  For each value (sorted):
    [value_len: u16 LE]             // 2 bytes
    [value: UTF-8]                  // variable
```

---

## 12. Big-O Complexity Summary

### Write path

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `writer.add(record)` | O(1) amortized | Vec push |
| `writer.finish()` total | O(N) | N = record count |
| String interning (per record) | O(1) amortized | HashMap lookup/insert |
| Bloom insert (per record) | O(k) = O(7) = O(1) | k=7 hash probes |
| Zone map add (per record) | O(1) amortized | HashSet insert |
| Column write (total) | O(N) | Sequential write of all columns |
| Footer write | O(S + B) | S = string table size, B = bloom size |
| Header seek-back | O(1) | Single seek + 8-byte write |
| **Total finish()** | **O(N + S)** | N = records, S = unique strings |

### Read path

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `segment::open()` | O(F) | F = footer size (bloom + zone map + string table) |
| — mmap | O(1) | OS maps file, no data read |
| — header read | O(1) | 32 bytes |
| — footer index read | O(1) | 44 bytes |
| — bloom load | O(B/64) | B = num_bits, read bit array |
| — zone map load | O(Z) | Z = total zone map bytes |
| — string table load | O(S) | S = string table bytes |
| `get_id(i)` | O(1) | Direct mmap offset read, 16 bytes |
| `get_semantic_id(i)` | O(1) | Read u32 index + string table lookup |
| `get_node_type(i)` | O(1) | Same pattern |
| `get_name(i)` | O(1) | Same pattern |
| `get_file(i)` | O(1) | Same pattern |
| `get_content_hash(i)` | O(1) | Direct mmap offset read, 8 bytes |
| `get_metadata(i)` | O(1) | Read u32 index + string table lookup |
| `get_record(i)` | O(1) | Combines all get_* + String allocation |
| `maybe_contains(id)` | O(k) = O(1) | k=7 probe positions, bit check |
| `contains_node_type(t)` | O(1) | HashSet lookup |
| `contains_file(f)` | O(1) | HashSet lookup |
| Full scan `iter()` | O(N) | N = record count |
| `maybe_contains_src(id)` | O(1) | Edge src bloom |
| `maybe_contains_dst(id)` | O(1) | Edge dst bloom |

### Bloom filter

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `new(num_keys)` | O(B/64) | B = num_keys * 10, allocate zeroed vec |
| `insert(key)` | O(k) = O(7) | 7 bit-set operations |
| `maybe_contains(key)` | O(k) = O(7) | 7 bit-check operations, short-circuit on miss |
| `write_to()` | O(B/64) | Write bit array |
| `from_bytes()` | O(B/64) | Read bit array |

### String table

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `intern(s)` | O(1) amortized | HashMap lookup + Vec push |
| `get(index)` | **O(1)** | Array index + slice (was O(n) in v1!) |
| `write_to()` | O(S + E) | S = data bytes, E = entries count |
| `from_bytes()` | O(S + E) | Same |

### Zone map

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `add(field, value)` | O(1) amortized | HashMap + HashSet |
| `contains(field, value)` | O(1) | HashMap get + HashSet contains |
| `write_to()` | O(F * V * log V) | F=fields, V=values (sorting for determinism) |
| `from_bytes()` | O(F * V) | Linear read |

---

## 13. Error Catalog

All errors use `GraphError::InvalidFormat(String)` from `crate::error`. No new error variants needed — `InvalidFormat` is the right semantic for format-level issues.

### Summary of all error strings

| Component | Error message | When |
|-----------|--------------|------|
| Header | "File too small for v2 segment" | mmap.len() < 76 (32 + 44) |
| Header | "Not a v2 segment: expected SGV2, got XXXX" | wrong magic |
| Header | "v1 segment detected (SGRF). Use migration tool." | v1 magic |
| Header | "Unsupported segment version: X" | version != 2 |
| Header | "Expected node segment, got edge" (or vice versa) | wrong segment_type |
| Footer | "footer_offset points past end of file" | footer_offset >= file_size |
| Footer | "Invalid footer index magic" | footer magic != FTR2 |
| Footer | "data_end_offset does not match column layout" | validation failure |
| String table | "String table too small" | < 8 bytes |
| String table | "String table entries truncated" | not enough bytes for entries |
| String table | "String table data truncated" | not enough bytes for data |
| String table | "String table entry out of bounds" | offset+length > data_len |
| String table | "String table contains invalid UTF-8" | invalid UTF-8 in data |
| Bloom | "Bloom filter too small" | < 16 bytes |
| Bloom | "Bloom filter data truncated" | not enough bytes for bits |
| Bloom | "Bloom filter has zero bits" | num_bits == 0 |
| Zone map | "Zone map too small" | < 4 bytes |
| Zone map | "Zone map field truncated" | partial field read |
| Zone map | "Zone map value truncated" | partial value read |
| Zone map | "Zone map contains invalid UTF-8" | invalid UTF-8 |
| Zone map | "Zone map field name overflow" | name_len > remaining |

---

## Segment Size Limits (GAP-4 documentation)

| Limit | Value | Reason |
|-------|-------|--------|
| Max string_count | 4,294,967,295 (u32) | u32 index |
| Max string table data | ~4 GB (u32 offset) | u32 offset in entries |
| Max record_count | 2^64 - 1 (u64) | header field size |
| Recommended max records | 1,000,000 | Practical bloom filter size, memory during write |
| Bloom size at 1M records | ~1.22 MB | 10 bits/key × 1M keys |

**For recommended 1M records:**
- Node segment column data: 20N + padding + 16N + 8N = ~44 MB
- Edge segment column data: 16N + 16N + 4N + 4N = ~40 MB
- Bloom filter: ~1.22 MB
- String table: depends on unique strings (typically < 1 MB)
- Total: ~45-50 MB per segment (comfortable for mmap)

---

## Implementation Notes

### Things NOT to do

1. **Do NOT modify `storage/` module.** v1 and v2 coexist. Migration happens later.
2. **Do NOT add `xxhash-rust` dependency.** Content hash verification is not RFDB's job.
3. **Do NOT add header checksum** (DECISION-4: deferred). Can be added in a future iteration.
4. **Do NOT add compression.** Future work. Current format is uncompressed.
5. **Do NOT add concurrent write support.** Segments are write-once, immutable after creation.

### Things to remember

1. **All integers are little-endian.** Use `to_le_bytes()` / `from_le_bytes()` everywhere.
2. **All padding bytes are 0x00.** (GAP-5)
3. **Empty metadata is `""`, not `"{}"`.**
4. **`_owner` for enrichment edges goes in metadata JSON, not as a column.** (GAP-3)
5. **Edge segments have no padding between u128 and u32 sections** — but the compute_padding call is still there, it just returns 0.
6. **String table indices are 0-based** — column arrays store indices (0, 1, 2, ...), not byte offsets.
7. **`id` must equal `BLAKE3(semantic_id)`** — `debug_assert!` in writer.
8. **Zone map fields and values sorted lexicographically** for byte-exact roundtrips.

---

## Summary

| Phase | File | Est. LOC | Dependencies |
|-------|------|----------|-------------|
| 1 | types.rs + mod.rs | ~140 | none |
| 2 | string_table.rs | ~200 | types.rs |
| 3 | bloom.rs | ~200 | types.rs |
| 4 | zone_map.rs | ~150 | types.rs |
| 5 | writer.rs | ~450 | all above |
| 6 | segment.rs | ~500 | all above + memmap2 |
| 7 | Integration tests | ~200 | all above + proptest + tempfile |
| 8 | Benchmarks | ~150 | all above + criterion |
| **Total** | | **~1990** | |

Cargo.toml changes:
- Add `proptest = "1.4"` to `[dev-dependencies]`
- Add `[[bench]] name = "segment_v2"` target
- No new runtime dependencies
