# Don Melton: T1.1 Segment Format Analysis

> Date: 2026-02-12
> Status: Initial analysis
> Reviewer: Don Melton (Tech Lead)

---

## Executive Summary

The T1.1 spec is solid and well-thought-out. It follows established patterns (Parquet/ORC footer-at-end, LSM bloom filters, columnar layout). I found **3 issues that need fixing** before implementation, **2 design decisions to verify**, and a clear build order. The biggest risk is the string table `get()` O(n) lookup, which the spec glosses over with "keep binary format compatible with v1."

---

## 1. Spec Completeness Analysis

### What's covered well
- Binary format layout with exact offsets and sizes
- Footer design following Parquet/ORC pattern (header at start, footer index at end)
- Bloom filter parameters (validated below)
- Zone map design for segment skipping
- Write sequence with seek-back for header update
- Error handling for corrupted files
- Performance targets

### Gaps found

**GAP-1: No `record_count` validation in footer.** The spec says to verify `record_count` matches column sizes, but column sizes are *derived* from `record_count` -- they're not independently stored. If `record_count` in the header is corrupted to a smaller value, the reader happily reads a truncated view with no error. **Fix:** Add `data_end_offset: u64` to footer index (the byte offset where column data ends). On open, verify: `header_size + computed_column_size == data_end_offset`.

**GAP-2: No total file checksum.** The spec explicitly says "NOT a full checksum (too expensive for mmap)." This is fine for v1 of v2, but we should at least store a checksum of the header+footer (the small, critical parts). A single XXH64 of the 32-byte header costs nothing. **Recommendation:** Add `header_checksum: u64` to footer index. Not blocking, but worth discussing.

**GAP-3: Missing `semantic_id` column in edge segments.** The v2 architecture doc (section 9.2) shows edges with `src` and `dst` as u128 only. The T1.1 spec matches. But the architecture doc (section 2.2) mentions edge segments storing `_owner: String` for enrichment edges. The T1.1 spec drops this entirely. **This is correct** -- `_owner` belongs in edge metadata, not as a column. But the spec should explicitly note this decision. Otherwise someone will ask "where did _owner go?"

**GAP-4: No guidance on segment size limits.** The architecture doc mentions "well-sized segments" of ~100-300 per project. But T1.1 has no mention of max record count per segment, max file size, or what happens when you try to write 10M records into a single segment. The `record_count: u64` field supports it, but `string_table` offsets are `u32` -- so the string table is limited to 4 GB. **Recommendation:** Document the implicit limits: max ~4B string offset range, recommended max 1M records per segment for practical bloom filter sizes.

**GAP-5: Padding bytes not zero-filled.** The spec says "padding to 16-byte boundary" between u32 columns and u128 columns, but doesn't specify what bytes go there. **Fix:** Specify `padding bytes MUST be 0x00`. This makes binary diffs cleaner and prevents information leakage from uninitialized memory.

### What's correctly omitted
- Compaction (Phase 2+)
- Tombstones (Phase 4)
- Inverted index (Level 1+ only)
- Global index
- Concurrent access

These all belong in later tasks. The spec correctly focuses on the single-segment atomic unit.

---

## 2. Implementation Order

### Dependency graph

```
types.rs (no deps)
    |
    v
string_table.rs (no deps, but types.rs defines what strings we store)
    |
    v
bloom.rs (no deps on other v2 modules)
    |
    v
zone_map.rs (no deps on other v2 modules)
    |
    v
writer.rs (depends on: types, string_table, bloom, zone_map)
    |
    v
segment.rs (depends on: types, string_table, bloom, zone_map)
    |
    v
mod.rs (re-exports everything)
```

### Recommended build order

| Step | File | LOC est. | Why this order |
|------|------|----------|----------------|
| 1 | `types.rs` | ~80 | Defines `NodeRecordV2`, `EdgeRecordV2`, `SegmentHeaderV2`, `SegmentMeta`. Everything depends on these. Pure data types, no logic. |
| 2 | `string_table.rs` | ~200 | Evolved from v1. Self-contained. Needs tests before anything uses it. |
| 3 | `bloom.rs` | ~200 | Self-contained. Needs property-based testing for FPR validation. |
| 4 | `zone_map.rs` | ~150 | Self-contained. Simplest of the footer components. |
| 5 | `writer.rs` | ~400 | Needs 1-4. This is where the real integration happens. |
| 6 | `segment.rs` | ~500 | Needs 1-4. Read path mirrors write path. |
| 7 | `mod.rs` | ~20 | Re-exports. Last. |

**Total: ~1550 LOC** (spec says ~1800, which leaves room for tests-in-file and doc comments).

### Why NOT interleave writer/segment?

You might think "write types.rs, then write writer.rs for nodes only, then segment.rs for nodes only, then add edges." DON'T. The reason: the binary format must be defined completely before either writer or reader. If you write the node writer first, you'll make format decisions that constrain the edge format. Build all the building blocks (steps 1-4), THEN build writer + reader against the complete format spec.

---

## 3. String Table: Reuse vs. Rewrite

### The problem

The spec says: "Keep binary format compatible with v1 for simplicity."

Let me be direct: **this is wrong.** Here's why:

The v1 `StringTable::get()` method (line 45-61 of `string_table.rs`) does a **linear scan** through the offsets array to find the next offset after the queried one:

```rust
pub fn get(&self, offset: u32) -> Option<&str> {
    let next_offset = self.offsets.iter()
        .find(|&&o| o > offset)  // <-- O(n) linear scan
        .copied()
        .unwrap_or(self.data.len() as u32);
    // ...
}
```

For the write path, this is fine -- the `intern()` method uses a HashMap for dedup and returns the offset directly. The `get()` is only called during reads.

But for v2 segments that may have thousands of unique strings, calling `get()` for every record during a full scan means O(n * m) where n = records and m = unique strings. For 100K records with 1000 unique strings, that's 100M iterations just to resolve string references.

### The fix

**Change the binary format.** Instead of storing just offsets into a blob, store (offset, length) pairs. This makes `get()` O(1):

```
Binary format v2:
  [string_count: u32]
  [total_data_len: u32]
  [entries: (offset: u32, length: u32) x string_count]   -- 8 bytes per string
  [data: u8 x total_data_len]                            -- concatenated strings
```

Lookup: `get(idx) -> &data[entries[idx].offset .. entries[idx].offset + entries[idx].length]`

This changes the string table API from offset-based to index-based:
- `intern(s) -> u32` returns an **index** (0, 1, 2, ...) not a byte offset
- `get(idx) -> &str` takes an index

The cost: 4 extra bytes per unique string (the length field). For 1000 strings, that's 4 KB. Negligible.

**IMPORTANT:** The column arrays in the segment would store string table **indices** (0, 1, 2, ...) not byte offsets. This is a cleaner abstraction and makes the string table format independent of its internal layout.

### Backward compatibility

There is NO backward compatibility concern. v2 segments have magic `SGV2`, v1 has `SGRF`. They're entirely separate formats. "Keep binary format compatible with v1" is a false constraint -- nothing reads v1 string tables from v2 segments.

### Recommendation

**Rewrite string_table.rs** with index-based API and O(1) lookup. Do NOT preserve v1 binary format. The spec should be updated before implementation.

---

## 4. Alignment Verification

### Node columns (spec's revised order)

```
Offset 32: [semantic_id offsets: u32 x N]     -- 4N bytes
            [node_type offsets: u32 x N]       -- 4N bytes
            [name offsets: u32 x N]            -- 4N bytes
            [file offsets: u32 x N]            -- 4N bytes
            [metadata offsets: u32 x N]        -- 4N bytes
            --- total u32 section: 20N bytes ---
            --- padding to 16-byte boundary ---
            [id column: u128 x N]              -- 16N bytes
            [content_hash column: u64 x N]     -- 8N bytes
```

**Verification:**
- After header (32 bytes), u32 section starts at offset 32. Fine (32 is 4-byte aligned).
- Total u32 section = 5 * 4 * N = 20N bytes.
- u128 column starts at offset 32 + 20N + padding.
- Need: `(32 + 20N + padding) % 16 == 0`.
- `32 % 16 == 0`, so we need `(20N + padding) % 16 == 0`.
- `20N % 16 == 4N % 16`.

| N mod 4 | 4N mod 16 | Padding needed |
|---------|-----------|----------------|
| 0 | 0 | 0 |
| 1 | 4 | 12 |
| 2 | 8 | 8 |
| 3 | 12 | 4 |

**The alignment scheme is correct.** Padding is at most 12 bytes. The `compute_padding` function in the spec handles this.

### Edge columns

```
[src column: u128 x N]           -- starts at offset 32, 16-byte aligned (32 % 16 == 0). OK.
[dst column: u128 x N]           -- starts at 32 + 16N. (32 + 16N) % 16 == 0. OK.
--- padding to 4-byte boundary if needed ---
[edge_type offsets: u32 x N]     -- starts at 32 + 32N + padding
[metadata offsets: u32 x N]
```

**Wait.** The edge format puts u128 first, then u32. But 32 + 32N is always 4-byte aligned (32N is divisible by 4). So the "padding to 4-byte boundary if needed" is **never needed**. The spec includes it defensively, which is fine -- the compute_padding function returns 0 in this case. But it should be documented that this padding is always 0 for edge segments.

### One concern: content_hash after u128

After the u128 column (16N bytes, starting at a 16-aligned offset), the u64 content_hash column starts at a 16-aligned offset. u64 requires 8-byte alignment. 16-byte aligned >= 8-byte aligned. **OK, no issue.**

---

## 5. Cargo.toml Changes

### New dependencies needed

```toml
[dev-dependencies]
proptest = "1.4"         # Property-based testing for roundtrips and bloom FPR

# Already present:
# criterion = "0.5"      # Benchmarks
# tempfile = "3.10"      # Temp dirs for segment tests
```

### Dependencies NOT needed

- **`xxhash-rust`**: The spec lists it as "optional, for content_hash verification." But content_hash is computed by the analyzer (TypeScript side), not by RFDB. RFDB just stores and retrieves it. There's nothing to verify on the Rust side. **Do NOT add this dependency.** If we later need xxhash for something else (e.g., header checksums), we can add it then. BLAKE3 is already in the project and works fine for internal hashing needs.

- **No new runtime dependencies.** `blake3` and `memmap2` are already present. The bloom filter and zone map are pure Rust with no external deps.

---

## 6. Bloom Filter Parameter Validation

### Research findings

The spec proposes: 10 bits/key, k=7, double-hashing from BLAKE3.

**10 bits/key with k=7:**
- Theoretical FPR = (1 - e^(-7/10))^7 ~ 0.82% ([Wikipedia: Bloom filter](https://en.wikipedia.org/wiki/Bloom_filter))
- Optimal k for 10 bits/key = 10 * ln(2) ~ 6.93, rounds to 7. **Correct.**
- The spec's target of "~1% FPR" is achieved. Actually slightly better (~0.82%).

**Double-hashing (Kirsch-Mitzenmacher):**
- [Kirsch & Mitzenmacher 2006](https://www.eecs.harvard.edu/~michaelm/postscripts/esa2006a.pdf) proved that `h_i(x) = h1(x) + i * h2(x) mod m` gives the same asymptotic FPR as k independent hash functions.
- [RocksDB Issue #4120](https://github.com/facebook/rocksdb/issues/4120) revealed a subtle flaw: when `h2(x) == 0`, all k probes hit the same position. RocksDB's fix: **enhanced double hashing** -- ensure `h2(x)` is odd (or nonzero and coprime with m).

**Using BLAKE3 for h1/h2:**
- BLAKE3 produces 256 bits (32 bytes). Taking first 8 bytes as h1 and next 8 bytes as h2 gives two 64-bit values.
- Since our bloom keys are u128 (already BLAKE3 hashes of semantic_ids), we're hashing a hash. This is fine -- BLAKE3(u128) produces well-distributed output.
- However, [research suggests](https://jszym.com/blog/short_input_hash/) BLAKE3 is slow for short inputs (16 bytes = u128). For bloom filter construction (thousands of inserts), this matters.

### Recommendation

**Use BLAKE3 for bloom hashing but apply the enhanced double-hashing fix:**

```rust
fn bloom_hashes(key: &[u8; 16], num_hashes: usize, num_bits: usize) -> Vec<usize> {
    let hash = blake3::hash(key);
    let bytes = hash.as_bytes();
    let h1 = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let h2 = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
    // Enhanced double hashing: ensure h2 is odd (always coprime with any m)
    let h2 = h2 | 1;
    (0..num_hashes)
        .map(|i| ((h1.wrapping_add((i as u64).wrapping_mul(h2))) % (num_bits as u64)) as usize)
        .collect()
}
```

The `h2 | 1` trick ensures h2 is always odd, which makes it coprime with num_bits (which is based on a power-of-2 word count, so the actual num_bits is even). This dodges the RocksDB pitfall entirely.

**Alternative considered:** Use the u128 key directly as h1||h2 (split the 16 bytes into two u64 values). This would skip the BLAKE3 call entirely and be faster. BUT: our u128 keys are already BLAKE3 outputs -- they have excellent distribution. So splitting the key itself IS the hash. **This is the better approach:**

```rust
fn bloom_hashes(key: u128, num_hashes: usize, num_bits: usize) -> impl Iterator<Item = usize> {
    let bytes = key.to_le_bytes();
    let h1 = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let h2 = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) | 1;
    (0..num_hashes)
        .map(move |i| ((h1.wrapping_add((i as u64).wrapping_mul(h2))) % (num_bits as u64)) as usize)
}
```

**No BLAKE3 call needed.** The u128 is already a BLAKE3 hash. Just split it. This is O(1) per key with no allocation. The spec should be updated to reflect this optimization.

---

## 7. Risk Areas

### RISK-1: mmap alignment on different platforms (MEDIUM)

The spec targets x86/ARM little-endian. On these platforms, unaligned reads of u128 work but may be slow. The v1 code already handles this (see `read_u128_at` in `segment.rs` which reads byte-by-byte). The v2 spec adds padding for alignment, which is good. But we MUST test on both x86 and ARM (Apple Silicon).

**Mitigation:** Property tests with `proptest` that verify roundtrips. CI on both architectures (already have Apple Silicon locally).

### RISK-2: Footer seek-back pattern (LOW)

The write path requires `Seek` to update the header's `footer_offset` after writing the footer. For buffered writers, this means flushing the buffer before seeking back. The v1 code already does this pattern successfully.

**Mitigation:** Existing pattern works. Just don't forget `writer.flush()` before seek.

### RISK-3: String table size limit (LOW, but document it)

With u32 offsets (or indices), the string table supports up to 4 billion entries. In practice, unique string count per segment will be in the hundreds or thousands. But the DATA size is also u32-bounded in v1 format. If we switch to the index-based format I propose (section 3), the `total_data_len` is u32, capping string data at 4 GB per segment. This is fine -- a single segment with 4 GB of string data would be pathological.

**Mitigation:** Add a `debug_assert!(self.data.len() < u32::MAX as usize)` in the string table.

### RISK-4: Empty segment edge cases (LOW)

0 records means: no columns written, bloom is empty, zone map is empty. The footer immediately follows the header. This creates a minimal valid segment (32 bytes header + footer). Need explicit tests.

**Mitigation:** Test #15 in the spec. Implement early.

### RISK-5: Large metadata blowing up segment size (MEDIUM)

The spec notes this but doesn't address it. A function with a 100KB JSDoc comment, repeated across a segment, will balloon segment size even with string table dedup (each unique metadata is stored once). But truly unique metadata (with line numbers, etc.) won't dedup at all.

**Mitigation:** This is an architectural question for later (compression, metadata externalization). For T1.1, just handle it gracefully -- no segment size limit, let the caller decide when to split.

### RISK-6: The `compute_padding` function needs to handle 0-record segments (LOW)

When N=0, the u32 section has 0 bytes. Offset after header = 32. Padding to 16 = 0. Then u128 column has 0 bytes. This works, but verify it doesn't cause division by zero or overflow in the padding calculation.

---

## 8. Testing Strategy

### Spec lists ~35 tests. Reordered by priority for TDD:

**Phase 1: Foundation (write these FIRST, before any implementation)**

| # | Test | Why first |
|---|------|-----------|
| 1 | `string_table_roundtrip` (new) | String table is used by everything. Must work before columns. |
| 2 | `string_table_dedup` (#5) | Core string table property. |
| 3 | `bloom_empty` (#8) | Simplest bloom test. Verifies construction. |
| 4 | `bloom_no_false_negatives` (#6) | Critical bloom property. |
| 5 | `bloom_roundtrip` (#10) | Bloom serialization. |
| 6 | `zone_map_roundtrip` (#14) | Zone map serialization. |
| 7 | `zone_map_exact_values` (#11) | Core zone map property. |

**Phase 2: Core roundtrips (after building blocks work)**

| # | Test | Why |
|---|------|-----|
| 8 | `empty_segment` (#15) | Edge case first. If this works, the format is correct for N=0. |
| 9 | `single_record_segment` (#16) | Minimal non-empty segment. |
| 10 | `write_read_roundtrip_nodes` (#1) | THE critical test. Write N random nodes, read them back, compare. |
| 11 | `write_read_roundtrip_edges` (#2) | Same for edges. |
| 12 | `semantic_id_u128_derivation` (#3) | Verify BLAKE3(semantic_id) == stored id. |
| 13 | `content_hash_roundtrip` (#4) | u64 survives roundtrip. |

**Phase 3: Alignment and binary stability**

| # | Test | Why |
|---|------|-----|
| 14 | `column_alignment` (#34) | Verify u128 at 16-byte boundary. |
| 15 | `various_record_counts` (#35) | N=0,1,2,3,7,8,15,16,100,1000. Catches alignment bugs. |
| 16 | `byte_exact_roundtrip` (#26) | Write-read-write produces same bytes. Binary stability. |

**Phase 4: Edge cases and robustness**

| # | Test | Why |
|---|------|-----|
| 17 | `empty_metadata` (#18) | metadata="" roundtrips correctly. |
| 18 | `unicode_strings` (#19) | Non-ASCII semantic_ids. |
| 19 | `very_long_semantic_id` (#20) | Stress string table. |
| 20 | `max_metadata_size` (#17) | 1MB metadata. |

**Phase 5: Corruption resilience**

| # | Test | Why |
|---|------|-----|
| 21 | `wrong_magic` (#22) | Clean error for non-v2 files. |
| 22 | `v1_magic` (#23) | Specific error for v1 files. |
| 23 | `truncated_file` (#21) | Partial writes. |
| 24 | `corrupted_footer_offset` (#24) | Footer points past EOF. |
| 25 | `zero_byte_file` (#25) | Empty file. |

**Phase 6: Bloom filter statistical validation**

| # | Test | Why |
|---|------|-----|
| 26 | `bloom_fpr_under_2_percent` (#7) | Statistical test. Run last because it's slow. |
| 27 | `bloom_single_item` (#9) | One item bloom filter. |
| 28 | `dst_bloom_no_false_negatives` (#31) | Edge dst bloom. |
| 29 | `dst_bloom_fpr` (#32) | Edge dst bloom FPR. |
| 30 | `dst_bloom_independent` (#33) | Src and dst blooms are independent. |

**Phase 7: Zone map extras**

| # | Test | Why |
|---|------|-----|
| 31 | `zone_map_empty_segment` (#12) | Empty segment zone map. |
| 32 | `zone_map_single_type` (#13) | Single type. |

**Phase 8: Benchmarks (LAST)**

| # | Test | Why |
|---|------|-----|
| 33 | `bench_write_throughput` (#27) | Performance validation. |
| 34 | `bench_read_sequential` (#28) | Read performance. |
| 35 | `bench_read_random` (#29) | Random access. |
| 36 | `bench_bloom_check` (#30) | Bloom latency. |

### Tests missing from the spec

- **`string_table_empty`** -- empty string table roundtrip
- **`string_table_empty_string`** -- intern("") works correctly (edge case: 0-length string)
- **`node_segment_get_individual_columns`** -- verify each `get_*` method independently
- **`edge_segment_maybe_contains_src_dst`** -- test both bloom filters on edge segment
- **`footer_index_at_eof`** -- verify footer index is exactly at EOF-28 (or whatever the final size is)

---

## 9. Decisions for User Review

### DECISION-1: String table format change
Proposed: rewrite string table with index-based O(1) lookup instead of v1's offset-based O(n) lookup. This breaks binary format compatibility with v1 (which doesn't matter since v2 is a new format). **Recommend: YES, rewrite.**

### DECISION-2: Bloom filter hashing optimization
Proposed: split the u128 key directly into h1/h2 instead of re-hashing through BLAKE3. Since our u128 keys are already BLAKE3 outputs, the distribution is excellent. Saves one BLAKE3 call per bloom insert/query. **Recommend: YES, use key-splitting.**

### DECISION-3: Enhanced double-hashing (h2 | 1)
Apply the RocksDB fix to ensure h2 is always odd, preventing degenerate probe patterns. **Recommend: YES, mandatory.**

### DECISION-4: Header checksum in footer
Add an XXH64 of the header to the footer index for corruption detection. Small cost, significant safety improvement. **Recommend: NICE-TO-HAVE, not blocking.**

### DECISION-5: `data_end_offset` in footer index
Add a field to validate that record_count matches actual column data size. **Recommend: YES, do it.**

---

## 10. Summary of Spec Changes Needed

Before implementation, the T1.1 spec should be updated:

1. **String table:** Change to index-based format with O(1) lookup (section 3 above)
2. **Bloom hashing:** Change from "BLAKE3 double-hashing" to "key-split double-hashing with enhanced h2" (section 6)
3. **Footer index:** Add `data_end_offset: u64` field (GAP-1)
4. **Padding:** Specify padding bytes must be 0x00 (GAP-5)
5. **Edge _owner:** Add note that `_owner` is stored in edge metadata, not as a column (GAP-3)
6. **Segment limits:** Document max string table data size (4 GB), recommended max records per segment (GAP-4)
7. **Edge padding:** Note that the u128-to-u32 padding in edge segments is always 0 bytes (section 4)

---

## Sources

- [Bloom filter - Wikipedia](https://en.wikipedia.org/wiki/Bloom_filter) -- FPR formula and optimal k calculation
- [Kirsch & Mitzenmacher 2006: Less Hashing, Same Performance](https://www.eecs.harvard.edu/~michaelm/postscripts/esa2006a.pdf) -- double-hashing proof
- [RocksDB Issue #4120: Flawed double hashing](https://github.com/facebook/rocksdb/issues/4120) -- enhanced double-hashing fix
- [Apache Parquet Format](https://github.com/apache/parquet-format) -- footer-at-end pattern
- [An Empirical Evaluation of Columnar Storage Formats](https://arxiv.org/pdf/2304.05028) -- Parquet/ORC comparison
- [BLAKE3 short input performance](https://jszym.com/blog/short_input_hash/) -- BLAKE3 slow on short inputs
- [xxhash-rust crate](https://github.com/DoumanAsh/xxhash-rust) -- evaluated and rejected for T1.1 scope
- [Bloom filter calculator](https://hur.st/bloomfilter/) -- parameter verification
- [Proptest crate documentation](https://docs.rs/proptest) -- property-based testing patterns
