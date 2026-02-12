# RFD-1: T1.1 Segment Format

## Request
Implement the v2 immutable columnar segment format for RFDB v2 - the foundational building block.

## Context
- Linear: RFD-1
- Branch: `rfd-1-t11-segment-format`
- Full spec: `/Users/vadimr/grafema/_tasks/rfdb-v2-roadmap/009-task-specs/T1.1-segment-format.md`
- Architecture: `/Users/vadimr/grafema-worker-1/_tasks/rfdb-v2-architecture-final.md`

## Scope (~1800 LOC, ~45 tests)
1. `NodeSegmentV2`: columnar layout (semantic_id, id/u128, type, name, file, content_hash/u64, metadata)
2. `EdgeSegmentV2`: columnar layout (src/u128, dst/u128, type, metadata)
3. Per-segment string table (embedded, not global)
4. Src bloom filter per segment (10 bits/key, 1% FPR, keyed on u128)
5. Dst bloom filter per edge segment (for C4 blast radius)
6. Zone maps per segment footer: set of distinct values per key field
7. Segment header (magic, version, counts, offsets) + footer (bloom, zone maps, string table)
8. `SegmentWriter::write()` + `SegmentReader::open()`

## Deliverables
New `src/storage_v2/` module with:
- `segment.rs` - NodeSegmentV2, EdgeSegmentV2 (read + types)
- `writer.rs` - SegmentWriter (write path)
- `bloom.rs` - BloomFilter (src + dst)
- `zone_map.rs` - ZoneMap (per-field distinct value sets)
- `string_table.rs` - StringTableV2
- `types.rs` - NodeRecordV2, EdgeRecordV2
- `mod.rs` - re-exports
