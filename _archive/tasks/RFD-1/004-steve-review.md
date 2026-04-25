# Steve Jobs: T1.1 Segment Format — High-Level Review

> Date: 2026-02-12
> Status: Review
> Reviewer: Steve Jobs (High-level Review)
> Documents reviewed: 002-don-plan.md, 003-joel-tech-plan.md, T1.1-segment-format.md
> Existing code reviewed: storage/string_table.rs, storage/segment.rs

---

## APPROVE

With two conditions that must be addressed before implementation begins (see Conditions below).

---

## Review Criteria Assessment

### 1. Does this align with project vision?

**YES.** The v2 segment format is pure infrastructure — it's the storage substrate that everything else builds on. It doesn't directly serve "AI should query the graph, not read code," but it's a necessary foundation: bloom filters enable fast point lookups, zone maps enable segment skipping for type-based queries, columnar layout enables efficient scans. These are the primitives that will make the query layer fast enough for interactive AI agent use.

The key decisions are all vision-aligned:
- Separate node/edge segment types (not a single mixed format) — enables independent compaction, targeted queries
- Footer-at-end pattern (Parquet/ORC) — extensible without breaking format
- Bloom + zone map — targeted queries, not brute-force scans
- String table with dedup — efficient storage for the repetitive string-heavy data that code analysis produces

### 2. Did we cut corners?

**NO.** In fact, the analysis actively caught a corner that the original spec was about to cut:

- **String table O(n) lookup:** Don correctly identified the v1 `get()` method's linear scan through offsets (lines 49-51 of `string_table.rs` — I verified this). The original spec said "keep binary format compatible with v1 for simplicity." Don flagged this as a false constraint since v2 is a completely new format (`SGV2` vs `SGRF`). The proposed index-based format with O(1) lookup is the right call. Not fixing this would have been cutting a corner that compounds across every read operation.

- **Bloom filter hashing:** Don caught the RocksDB double-hashing pitfall (h2=0 degeneracy) and proposed the `h2 | 1` fix. He also caught the unnecessary BLAKE3 re-hashing — since u128 keys are already BLAKE3 outputs, splitting the key directly into h1/h2 is both faster and equally well-distributed. This is not a shortcut; it's a legitimate optimization grounded in the mathematical properties of the input data.

- **Footer index extensibility:** The `data_end_offset` addition (DECISION-5) is a genuine integrity check that catches corrupted `record_count` values. This is the kind of paranoid correctness that you want in a storage format you'll be stuck with.

### 3. Are there fundamental architectural gaps that make this feature useless?

**NO.** The segment format is a self-contained, well-bounded building block. It does one thing: serialize/deserialize columnar records with metadata for fast filtering. It explicitly defers compaction, tombstones, concurrent access, and global indexing to later phases — and it's right to do so.

I verified the format supports the later phases:
- **LSM-tree compaction (Phase 2+):** Segments are immutable and write-once. Compaction reads N segments, merges, writes new segment. Nothing in the v2 format prevents this. The sorted string table indices, deterministic zone map serialization (sorted keys/values), and self-describing footer all support merge operations.
- **Tombstones (Phase 4):** Tombstone segments are a separate segment type. The `segment_type: u8` field has values 0 (nodes) and 1 (edges), with 254 values reserved. Tombstone segments can use value 2 or higher.
- **Reverse edge lookup (N8 in expert concerns):** The dst bloom filter is included in the edge segment footer. This was promoted from "nice-to-have" to Phase 0 requirement because C4 blast radius depends on it. Don and Joel both handle this correctly — separate `dst_bloom_offset` in footer index, separate bloom construction during write.

### 4. Would shipping this embarrass us?

**NO.** This is a solid columnar format that follows proven patterns from Parquet, ORC, and RocksDB. The analysis shows genuine expertise — verifying alignment arithmetic, validating bloom filter FPR formulas against published research, catching the enhanced double-hashing issue from a real RocksDB bug. The test plan is comprehensive (35+ tests across 8 phases, property-based testing with proptest).

---

## Mandatory Complexity & Architecture Checklist

### 1. Complexity Check

- **Write path:** O(N + S) where N = records, S = unique strings. Single pass over records for interning + column extraction. Single pass for bloom construction. Linear writes for columns. This is optimal — you can't write N records in less than O(N).
- **Read path:** O(F) for open (F = footer size, typically < 10KB). O(1) for all point queries (`get_id`, `get_semantic_id`, `maybe_contains`, `contains_node_type`). O(N) for full scan. All correct.
- **No O(n) over ALL nodes/edges in the system.** This operates on individual segments. The "scan all segments" concern is a query-layer problem, not a segment-format problem. Zone maps and bloom filters exist precisely to minimize the number of segments touched.

**PASS.**

### 2. Plugin Architecture

- **Forward registration:** Zone maps and bloom filters are built during segment write (forward pass over records). The writer marks what's in the segment; the reader checks it. This is the correct pattern.
- **No backward scanning:** Readers never scan the segment to discover what's in it — they check the footer metadata first.

**PASS.**

### 3. Extensibility

- **Footer index pattern:** Adding new footer sections (e.g., inverted index, prefix-compressed string table, additional bloom filters) requires only adding new offset fields to the footer index. The footer index magic (`FTR2`) and fixed position (EOF - 44 bytes) make version detection trivial.
- **However** — see Condition 1 below regarding footer index versioning.

**CONDITIONAL PASS.**

### 4. No brute-force

- Bloom filter: O(1) membership check instead of scanning.
- Zone map: O(1) attribute check instead of scanning.
- String table: O(1) lookup by index instead of linear search.
- Column access: O(1) by computed offset instead of iterating records.

**PASS.**

---

## Specific Evaluations

### Is the string table rewrite the right call?

**Absolutely YES.** I verified the v1 code. The `get()` method at line 49 of `string_table.rs` does `self.offsets.iter().find(|&&o| o > offset)` — a linear scan through ALL offsets to find the next one after the queried offset, in order to compute the string length. This is O(m) per call where m = number of unique strings.

The v1 `load_from_mmap_slice` (line 148) actually builds the index correctly during load by iterating offsets sequentially, but the `get()` method ignores this structure and does a linear search anyway. This is a v1 bug that's been tolerable because v1 segments are small.

For v2 segments that may have 1M records with thousands of unique strings, and where every column access resolves through the string table, O(m) per `get()` is unacceptable. The index-based format (return position 0, 1, 2, ... instead of byte offset) with stored `(offset, length)` pairs makes `get()` O(1). The cost is 4 bytes per unique string (the length field). For 1000 strings, that's 4KB. For the correctness and performance guarantee, this is a no-brainer.

Don's observation that "v1 compatibility" is a false constraint is correct: v2 segments have magic `SGV2`, v1 has `SGRF`. Nothing reads v1 string tables from v2 segments.

### Is the bloom filter key-split optimization sound?

**YES**, with the enhanced double-hashing fix.

The reasoning chain:
1. u128 node IDs are BLAKE3 outputs (from `id_gen.rs`'s `string_id_to_u128()`).
2. BLAKE3 output has excellent distribution across all 128 bits.
3. Splitting 128 bits into two 64-bit halves (h1, h2) gives two values with the same distribution quality as computing two independent hash functions — proven by Kirsch-Mitzenmacher 2006.
4. The `h2 | 1` trick ensures h2 is always odd, preventing the degenerate case where h2=0 causes all k probes to land on the same position (RocksDB issue #4120).
5. This eliminates the BLAKE3 call entirely during bloom operations — no hashing needed, just arithmetic.

For 10 bits/key with k=7: theoretical FPR = (1 - e^(-7/10))^7 = ~0.82%. Under the 1% target. The 2% threshold in tests gives statistical headroom.

The one subtlety: edge segment bloom filters hash `src` and `dst` u128 values. These are also BLAKE3 outputs (from the same `string_id_to_u128()`), so the key-split approach applies equally to edge blooms.

**Sound.**

### Is the footer_index design extensible enough for future phases?

**MOSTLY YES, but see Condition 1.**

The current footer index is a fixed 44-byte structure at EOF:
- bloom_offset (8)
- dst_bloom_offset (8)
- zone_maps_offset (8)
- string_table_offset (8)
- data_end_offset (8)
- magic (4)

This works for T1.1. But when Phase 2+ adds new footer sections (inverted index, compression metadata, tombstone bitmap, secondary bloom filters), the footer index must grow. How?

Options:
1. **Add fields to footer index, increment magic.** FTR2 -> FTR3, size grows from 44 to 44+N. Reader checks magic to determine layout. Simple but rigid.
2. **Add a version/size field to footer index.** Reader reads version first, then knows how many bytes to read. More flexible.
3. **TLV (type-length-value) in footer.** Most flexible but over-engineered for this use case.

The current plan doesn't address this. **See Condition 1.**

### Are there any "MVP limitations" that defeat the purpose?

**NO.** Every deferral in the spec is legitimate:

- **No compaction:** Segments are L0 (write-once, file-scoped). Compaction is a separate concern that doesn't affect the segment format — compaction reads existing segments and writes new ones using the same format.
- **No tombstones:** Tombstones are a higher-level concept. The segment format stores records; the manifest tracks which segments are live.
- **No concurrent access:** Segments are immutable after write. Concurrent reads on mmap are safe. Concurrent writes don't happen (write-once semantics). This is a property, not a limitation.
- **No compression:** Adding compression later is an additive change — compressed columns with a compression flag in the header/footer. Doesn't require format changes to the uncompressed path.
- **No header checksum (DECISION-4 deferred):** Nice-to-have, not critical. Footer magic and data_end_offset provide basic integrity checking.

None of these omissions make the segment format work for <50% of real-world cases. The format handles all node and edge types, all string lengths, all record counts from 0 to millions. It's a complete storage unit.

### Will this format support LSM-tree compaction in future phases?

**YES.** Compaction requires:
1. Read N source segments sequentially — supported (column accessors, iter())
2. Merge records from multiple segments — application logic, not format concern
3. Write new compacted segment — supported (writer API)
4. Atomically swap manifest to point to new segment — manifest concern, not format
5. GC old segments — file deletion, not format concern

The format is a perfect building block for LSM. Segments are immutable, self-describing, and independently readable. This is exactly the Parquet/ORC model.

---

## Conditions for Approval

### Condition 1: Footer index must include a version or size field

The footer index is currently a fixed 44-byte structure with a magic number. When future phases add new footer sections, we need a way to extend it without breaking existing readers.

**Required change:** Add a `footer_index_version: u16` field (or repurpose 2 bytes from padding) to the footer index. Version 1 = current 44-byte layout. Future versions can add fields. Reader checks version and reads accordingly.

This costs 2 bytes. Without it, we'll need to change the magic number every time the footer grows, which is fragile and doesn't allow older readers to gracefully handle newer formats.

**Alternatively:** Add `footer_index_size: u16` so the reader knows exactly how many bytes to read from EOF. Even more robust — reader seeks to EOF minus `sizeof(magic) + sizeof(size)`, reads those 6 bytes, then seeks to `EOF - footer_index_size` and reads the full index.

Either approach is acceptable. The key invariant: a reader compiled against T1.1 must be able to open a segment written by a T1.5+ writer and either (a) read it correctly ignoring new fields, or (b) produce a clear "unsupported footer version" error. The current design does neither — it would read garbage if the footer index grew.

### Condition 2: Zone map serialization must cap value counts

The zone map stores all distinct values per field. For `node_type`, this is bounded (5-20 types). For `file`, in file-scoped shards, it's exactly 1 value.

But after compaction (Phase 4+), a segment could contain nodes from hundreds of files. If a compacted segment has 500 files, the zone map's `file` field stores 500 strings. This is still manageable.

The concern: `name` field. If someone adds `name` to the zone map in a future phase, and a compacted segment has 100K unique names — the zone map becomes 100K strings, defeating its purpose (it's supposed to be a cheap skip-list, not a full index).

**Required change:** Document (in code, not just spec) that zone maps are for **low-cardinality fields only**. Add a compile-time or runtime constant `MAX_ZONE_MAP_VALUES_PER_FIELD = 10_000`. If a field exceeds this during write, the zone map for that field is omitted (treated as "all values possible"). This prevents a future developer from naively adding a high-cardinality field and creating pathological zone maps.

This is a documentation + one `if` check. Not a format change.

---

## Minor Observations (not blocking)

1. **`vec![0u8; padding]` allocation on every write** (Joel's tech plan, line 754). For 0-12 bytes, this allocates a Vec on the heap. Use a stack buffer instead: `writer.write_all(&[0u8; 16][..padding])`. Trivial, but this is in the write hot path.

2. **The `from_bytes()` vs `from_mmap()` naming.** Joel's plan has both `from_mmap(mmap: Mmap)` and `open(path: &Path)`. The `from_bytes()` methods on bloom/zone_map/string_table take `&[u8]`. This is clean — `from_bytes` for sub-components, `from_mmap`/`open` for the segment itself. Just ensure the naming is consistent: either all sub-components use `from_bytes` or all use `from_slice`. Don't mix.

3. **Edge `metadata_offset` naming collision.** Both `NodeSegmentV2` and `EdgeSegmentV2` have a field called `metadata_offset`. In `NodeSegmentV2`, it's the offset to the metadata index column. In `EdgeSegmentV2`, same. But the field `metadata_offsets_offset` from v1 was renamed to just `metadata_offset` — make sure docs clarify this is the offset to the column of metadata indices (u32 array), not a single metadata offset.

4. **Empty bloom for 0 keys:** Joel specifies `num_bits = 64` (one word), all zeros, `maybe_contains()` always returns false. This is correct and avoids a division-by-zero in `probe_positions()` when `num_bits = 0`. But the `from_bytes()` deserialization checks `num_bits == 0` as an error. Verify that `new(0)` writes `num_bits = 64`, not `0`.

5. **The `debug_assert!(record.id == blake3_of(semantic_id))` in writer.** Good for catching bugs during development. But in release builds, this vanishes. If a caller passes a `NodeRecordV2` with mismatched `id` and `semantic_id`, the segment silently stores wrong data. Consider: should this be a hard error in release too? The cost is one BLAKE3 call per record during write — negligible compared to IO. Decision for the implementer, but flag it.

---

## Summary

Don's analysis is thorough, well-researched, and catches real issues (string table O(n), bloom hashing, footer validation). Joel's tech plan is detailed enough for direct implementation — API signatures, binary layouts, byte-level offset calculations, error catalogs, Big-O analysis. The build order is correct (types -> building blocks -> writer -> reader -> integration -> benchmarks).

The two conditions are:
1. Add footer index versioning (2 bytes, prevents format lock-in)
2. Cap zone map cardinality (one `if` check, prevents pathological behavior)

Both are small additions that protect the format's future. With these addressed, this is ready for implementation.

**APPROVE** pending conditions.
