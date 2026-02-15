# RFD-20: Plan Revision — Addressing Auto-Review Blockers

**Date:** 2026-02-15
**Resolves:** 004-auto-review.md blockers

---

## Blocker 1: Edge Dedup Key — RESOLVED

**Finding:** `(src, dst, edge_type)` IS the correct dedup key.

**Evidence:** WriteBuffer stores `edge_keys: HashSet<(u128, u128, String)>` and performs upsert (replaces metadata) on duplicate keys. Test `test_edge_upsert_replaces_metadata` confirms this behavior.

**Action:** No change needed. Plan is correct.

---

## Blocker 2: IndexEntry Layout — FIXED

**Original:**
```rust
#[repr(C)]
pub struct IndexEntry {
    pub node_id: u128,    // 16 bytes
    pub shard: u16,       // 2 bytes  ← padding after this!
    pub segment_id: u64,  // 8 bytes
    pub offset: u32,      // 4 bytes
    pub _padding: u16,    // 2 bytes
} // Actually 44 bytes due to alignment padding
```

**Fixed (fields reordered by decreasing alignment):**
```rust
#[repr(C)]
pub struct IndexEntry {
    pub node_id: u128,      // offset 0,  16 bytes (align 16)
    pub segment_id: u64,    // offset 16, 8 bytes  (align 8)
    pub offset: u32,        // offset 24, 4 bytes  (align 4)
    pub shard: u16,         // offset 28, 2 bytes  (align 2)
    pub _padding: u16,      // offset 30, 2 bytes  (align to 32)
} // Exactly 32 bytes, no internal padding
```

**Validation:** Unit test will verify `std::mem::size_of::<IndexEntry>() == 32`.

---

## Blocker 3: Lookup Table Hash Collision — FIXED

**Problem:** Using only xxHash64 of attribute value risks (extremely unlikely but possible) hash collisions causing wrong query results.

**Fix:** Replace hash-only lookup with string table + offset approach:

```rust
// Index file layout (revised):
[IndexFileHeader]           // 32 bytes
[StringTable]               // variable — actual attribute strings
[LookupTable]               // variable — key_offset → entry_range
[IndexEntry; entry_count]   // 32 × entry_count bytes

// LookupTableEntry (revised):
struct LookupTableEntry {
    key_offset: u32,        // offset into StringTable
    key_length: u16,        // string length in bytes
    _padding: u16,          // alignment
    entry_offset: u32,      // byte offset into entries array
    entry_count: u32,       // number of entries for this key
} // 16 bytes

// StringTable: concatenated UTF-8 strings, no separators
// Lookup: binary search on LookupTable by comparing actual strings from StringTable
```

**Lookup algorithm:**
1. Binary search `LookupTable` by comparing `query_key` with `StringTable[entry.key_offset..+entry.key_length]`
2. On match: read `entry_count` IndexEntry values starting at `entry_offset`
3. No hash collisions possible — exact string matching

**Sorting:** LookupTable entries sorted by string value (lexicographic) for binary search.

---

## Blocker 4: Manifest Schema — REVISED

**Original:** `HashMap<u16, SegmentDescriptor>` for L1 segments.

**Problem:** Inconsistent with existing pattern (`Vec<SegmentDescriptor>`).

**Fix:** Use `Vec<SegmentDescriptor>` for L1 (consistent with L0 pattern). Each descriptor already has `shard_id: Option<u16>`, so shard routing works the same way.

```rust
pub struct Manifest {
    // ... existing fields ...

    /// L1 (compacted) node segments — at most one per shard
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub l1_node_segments: Vec<SegmentDescriptor>,

    /// L1 (compacted) edge segments — at most one per shard
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub l1_edge_segments: Vec<SegmentDescriptor>,

    /// Compaction metadata
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction: Option<CompactionInfo>,
}
```

**Loading:** At shard open, filter `l1_node_segments` by `shard_id` to find the L1 segment for this shard (at most one).

**Backwards compatibility:** `#[serde(default)]` — old manifests deserialize with empty Vecs.

---

## Blocker 5: Re-Compaction Logic — FIXED

**Problem:** Second compaction must include existing L1 as merge input, or data is lost.

**Fix:** Merge algorithm includes existing L1 segment as input:

```rust
fn collect_merge_inputs(shard: &Shard) -> (Vec<&NodeSegmentV2>, Vec<&EdgeSegmentV2>) {
    let mut node_inputs: Vec<&NodeSegmentV2> = Vec::new();
    let mut edge_inputs: Vec<&EdgeSegmentV2> = Vec::new();

    // Include existing L1 segment (oldest data, lowest priority)
    if let Some(l1) = &shard.l1_node_segment {
        node_inputs.push(l1);
    }
    if let Some(l1) = &shard.l1_edge_segment {
        edge_inputs.push(l1);
    }

    // Include L0 segments (newer data, higher priority — listed newest-first)
    for seg in shard.node_segments.iter().rev() {
        node_inputs.push(seg);
    }
    for seg in shard.edge_segments.iter().rev() {
        edge_inputs.push(seg);
    }

    (node_inputs, edge_inputs)
}
```

**Dedup priority:** Newer records (from L0) override older (from L1). HashMap insert order: L1 first, then L0 newest-first. HashMap::entry().or_insert() keeps the FIRST insert (newest wins because L0 is inserted after L1).

Wait — that's wrong. If L1 is inserted first and L0 second, `or_insert` keeps L1 (first inserted). We need L0 to win.

**Corrected:** Insert L0 (newest-first) FIRST, then L1:
```rust
// Insert L0 records first (newest wins via or_insert)
for seg in l0_segments_newest_first {
    for record in seg.iter() {
        records.entry(record.id).or_insert(record);
    }
}
// Then L1 — duplicates ignored (L0 already has newer version)
if let Some(l1) = l1_segment {
    for record in l1.iter() {
        records.entry(record.id).or_insert(record);
    }
}
```

This ensures newer L0 records override older L1 records.

---

## Concern 6: L0+L1 Query Dedup — DETAILED

**Query path after compaction (revised):**

```rust
fn find_nodes(&self, query: &AttrQuery) -> Vec<NodeRecordV2> {
    let mut seen: HashSet<u128> = HashSet::new();
    let mut results: Vec<NodeRecordV2> = Vec::new();

    // 1. Write buffer (most recent, always authoritative)
    for record in self.write_buffer.iter_nodes() {
        if matches_query(record, query) && !self.tombstones.is_node_tombstoned(record.id) {
            seen.insert(record.id);
            results.push(record.clone());
        }
    }

    // 2. L0 segments (post-compaction flushes, newest-first)
    for seg in self.node_segments.iter().rev() {
        // Zone map pruning
        if !zone_map_matches(seg, query) { continue; }

        for record in seg.iter() {
            if seen.contains(&record.id) { continue; }  // Already seen in newer data
            if self.tombstones.is_node_tombstoned(record.id) { continue; }
            if matches_query(record, query) {
                seen.insert(record.id);
                results.push(record);
            }
        }
    }

    // 3. L1 segment (compacted, oldest data)
    if let Some(l1) = &self.l1_node_segment {
        // TODO: Use inverted index if available (Phase 4)
        if !zone_map_matches(l1, query) { /* skip */ }
        else {
            for record in l1.iter() {
                if seen.contains(&record.id) { continue; }
                // No tombstone check needed — tombstones already applied during compaction
                if matches_query(record, query) {
                    seen.insert(record.id);
                    results.push(record);
                }
            }
        }
    }

    results
}
```

**Note on L1 tombstones:** L1 was built by filtering tombstones during compaction. However, NEW tombstones (added after compaction) must still be checked against L1 records. Fix:

```rust
// L1: check ONLY post-compaction tombstones
// Store compaction tombstone snapshot version in CompactionInfo
// Compare against current tombstones to find "new" tombstones
```

Actually, simpler: always check tombstones for L1 too. The overhead is O(1) per record (HashSet lookup). Tombstones that were already applied during compaction simply won't match any L1 record. No harm.

---

## Concern 7: GC Safety — RESOLVED

**Finding:** RFDB v2 uses `Arc<Mutex<DatabaseManager>>`. All client requests acquire the mutex. When compaction runs (synchronously, holding mutex), NO other threads are accessing segments.

**Flow:**
1. Client sends "compact" command
2. Handler acquires `Mutex<DatabaseManager>` lock
3. Compaction runs: merge → write → swap → delete old segments
4. Handler releases lock
5. Other clients (blocked on mutex) now access new segments

**Conclusion:** Immediate file deletion IS safe because the mutex provides mutual exclusion. No concurrent readers during swap.

**Caveat:** Server is unresponsive during compaction (all queries blocked). Acceptable for v0.2. Document as known limitation.

---

## Concern 8: Query Complexity with L0+L1 — ADDED

**Post-compaction query complexity:**

| Scenario | write_buffer | L0 segments | L1 | Total |
|----------|-------------|-------------|-----|-------|
| Just compacted (no new writes) | O(B) | 0 segments | O(N) scan or O(log K + R) indexed | O(B + N) or O(B + log K + R) |
| After some flushes (4 L0 segs) | O(B) | O(4 × N_L0) | O(N_L1) or O(log K + R) indexed | O(B + 4N_L0 + N_L1) or O(B + 4N_L0 + log K + R) |

**Key insight:** Inverted indexes help ONLY for L1. L0 still requires segment scan. Performance improvement depends on L1/L0 data ratio:
- Right after compaction: 100% in L1 → max speedup
- After many flushes: most data in L0 → minimal speedup from indexes
- Solution: re-compact when L0 grows large (compaction threshold)

**Performance model:**
- Speedup ≈ N_L1 / (N_L0 + N_L1) × index_factor
- index_factor ≈ 10-100× for attribute queries
- If L1 = 90% of data, L0 = 10% → effective speedup ≈ 9-90×

---

## Revised Implementation Order

No change to the 13-commit structure, but key corrections:
- **Commit 3:** Use revised index file format (string table + exact matching)
- **Commit 4:** Merge algorithm includes existing L1 as input
- **Commit 7:** Immediate file deletion after swap (safe per mutex analysis)
- **Commit 8:** Detailed L0+L1 query dedup (as described above)

**Total estimated LOC:** ~2,400 (unchanged)

---

**END OF REVISION**
