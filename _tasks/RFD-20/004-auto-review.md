# Auto-Review: RFD-20 Background Compaction

**Reviewer:** Combined Auto-Review (Sonnet)
**Date:** 2026-02-15
**Documents Reviewed:**
- `002-don-plan.md` (Don's design)
- `003-joel-tech-plan.md` (Joel's tech spec)

---

## Verdict: **REJECT**

This is a well-researched, thoughtfully designed plan with excellent prior art analysis. However, there are **critical architectural and implementation concerns** that must be addressed before proceeding.

---

## Part 1 — Vision & Architecture

### ✅ **GOOD: Alignment with Project Vision**

- Compaction is essential for RFDB v2 performance (5-10x query speedup target)
- LSM-style tiered+leveled hybrid is proven (RocksDB pattern)
- Inverted indexes enable attribute queries at scale
- Blue/green swap pattern fits single-threaded model

### ✅ **GOOD: Prior Art Research**

Don's research is excellent:
- RocksDB, LevelDB, ScyllaDB compaction strategies
- Cloudflare mmap-sync pattern for concurrent readers
- Cassandra tombstone filtering

### ⚠️ **CONCERN: Edge Record Dedup Key Assumption**

**Issue:** Joel assumes edge dedup key is `(src, dst, edge_type)` (line 19-21 of tech spec), but this needs verification against actual `EdgeRecordV2` structure.

**From `types.rs`:**
```rust
pub struct EdgeRecordV2 {
    pub src: u128,
    pub dst: u128,
    pub edge_type: String,
    pub metadata: String,
}
```

**Analysis:** EdgeRecordV2 has NO unique ID field. The composite key `(src, dst, edge_type)` is correct. However, this means:
- Multiple edges of the SAME type between the same nodes → only one survives compaction
- Is this the intended behavior? Grafema allows parallel edges?

**Action Required:** Verify with user that `(src, dst, edge_type)` is the correct dedup key. If parallel edges of the same type are needed (e.g., multiple CALLS with different metadata), the dedup logic is WRONG.

### 🔴 **CRITICAL: Segment Iterator API Missing**

**Issue:** Joel's merge algorithm (lines 160-188 of Don's plan) assumes:
```rust
for record in seg.iter() {
    // iterate all records
}
```

**From `segment.rs` (lines 282-284, 467-470):**
```rust
// NodeSegmentV2
pub fn iter(&self) -> impl Iterator<Item = NodeRecordV2> + '_ {
    (0..self.record_count()).map(move |i| self.get_record(i))
}

// EdgeSegmentV2
pub fn iter(&self) -> impl Iterator<Item = EdgeRecordV2> + '_ {
    (0..self.record_count()).map(move |i| self.get_record(i))
}
```

**Status:** ✅ Iterators EXIST. Algorithm is feasible.

---

## Part 2 — Practical Quality

### 🔴 **CRITICAL: IndexEntry Struct Layout Flaw**

**Issue:** Joel defines (tech spec lines 158-169):
```rust
#[repr(C)]
pub struct IndexEntry {
    pub node_id: u128,    // 16 bytes
    pub shard: u16,       // 2 bytes
    pub segment_id: u64,  // 8 bytes
    pub offset: u32,      // 4 bytes
    pub _padding: u16,    // 2 bytes — align to 32
}
```

**Problem:** On most platforms (x86-64, ARM64), `u128` requires 16-byte alignment. The compiler will insert **6 bytes of padding** after `shard: u16` to align `segment_id: u64` to 8 bytes, then more padding before `offset`.

**Correct layout with `#[repr(C)]`:**
```
node_id:    offset 0,  size 16, align 16
shard:      offset 16, size 2,  align 2
<padding 6 bytes>
segment_id: offset 24, size 8,  align 8
offset:     offset 32, size 4,  align 4
_padding:   offset 36, size 2,  align 2
<padding 6 bytes>
Total: 44 bytes (not 32)
```

**Fix:** Use `#[repr(C, packed)]` or reorder fields:
```rust
#[repr(C)]
pub struct IndexEntry {
    pub node_id: u128,      // 0-15
    pub segment_id: u64,    // 16-23
    pub offset: u32,        // 24-27
    pub shard: u16,         // 28-29
    pub _padding: u16,      // 30-31 (for future use)
} // exactly 32 bytes
```

**Impact:** Without fix, 1M entries = 44MB (not 32MB as claimed). Indexes 37% larger than planned.

### 🔴 **CRITICAL: Lookup Table Hash Collision Handling**

**Issue:** Joel's lookup table design (tech spec lines 186-192):
```rust
LookupTableEntry {
    key_hash: u64,          // xxHash of attribute value
    offset: u32,
    count: u32,
}
```

**Problem:** Uses **ONLY the hash** to identify attribute values. If two different `node_type` values hash to the same u64, the lookup table CANNOT distinguish them.

**Example Collision:**
- `node_type = "FUNCTION"` → xxHash = X
- `node_type = "METHOD"` → xxHash = X (collision)
- Lookup table has single entry for hash X
- Query for "FUNCTION" returns results for BOTH types

**Fix:** Lookup table must store the actual string value OR use exact string matching after hash lookup:
```rust
LookupTableEntry {
    key_value: String,  // NOT just hash
    offset: u32,
    count: u32,
}
```

**Impact:** Without fix, attribute queries can return WRONG results (false positives beyond bloom filter FPR).

### 🔴 **CRITICAL: Manifest Schema Evolution — Backwards Compatibility Issue**

**Issue:** Joel proposes (tech spec lines 119-138):
```rust
pub struct Manifest {
    // ... existing fields ...

    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub l1_node_segments: HashMap<u16, SegmentDescriptor>,

    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub l1_edge_segments: HashMap<u16, SegmentDescriptor>,
}
```

**Problem:** `HashMap<u16, SegmentDescriptor>` key is `shard_id`. Current manifest uses `Vec<SegmentDescriptor>` for L0 segments.

**Mismatch:**
- L0: `node_segments: Vec<SegmentDescriptor>` (all shards mixed)
- L1: `l1_node_segments: HashMap<u16, SegmentDescriptor>` (one entry per shard)

**Issue:** After compaction, a shard has:
- L0: multiple segments (in `node_segments` Vec)
- L1: one segment (in `l1_node_segments` HashMap)

**Query path:** Must scan BOTH `node_segments` (L0) AND `l1_node_segments` (L1). But how does Shard know which L0 segments belong to which shard?

**From shard.rs (lines 134-161):** Shard stores:
```rust
pub struct Shard {
    node_segments: Vec<NodeSegmentV2>,
    node_descriptors: Vec<SegmentDescriptor>,
    // ...
}
```

**Missing:** No `shard_id` field on Shard. No way to filter `node_segments` by shard.

**Root Cause:** Multi-shard compaction (per-shard L1) but Shard doesn't know its own ID in Phase 1 (single-shard). Adding compaction BEFORE multi-shard support = architectural mismatch.

**Fix Options:**
1. **Simple (for single-shard):** `l1_node_segment: Option<SegmentDescriptor>` (not HashMap). Add HashMap later in RFD-22 (multi-shard).
2. **Future-proof:** Add `shard_id` to Shard NOW, set to 0 for single-shard, prepare for multi-shard.

**Recommendation:** Option 1 (simple). Don't over-engineer for future tasks.

### ⚠️ **CONCERN: L1 Coexistence with L0 — Query Dedup Logic**

**Issue:** After compaction, new writes go to L0. Query path must dedup across:
- Write buffer
- L0 segments (post-compaction flushes)
- L1 segment (compacted)

**From shard.rs `find_nodes()` (lines 569-657):** Current dedup:
```rust
// Step 1: Scan write buffer (mark IDs as seen)
// Step 2: Scan L0 segments newest-to-oldest (skip seen IDs)
```

**Required Change (not in plan):**
```rust
// Step 1: Scan write buffer
// Step 2: Scan L0 segments newest-to-oldest (post-compaction)
// Step 3: Scan L1 segment (if exists, skip seen IDs)
```

**Missing from tech spec:** Updated query logic for L0+L1 dedup. Joel mentions it (tech spec lines 48-53) but doesn't show the actual code changes to `find_nodes()`, `get_node()`, etc.

**Action Required:** Commit 8 (Query path integration) must include detailed query logic for L0+L1 dedup.

### ⚠️ **CONCERN: Re-Compaction of Already-Compacted Shards**

**Issue:** What happens if you run `compact()` twice?

**Scenario:**
1. Compact shard (L0 → L1)
2. Flush new data (new L0 segments)
3. Trigger compaction again (L0 + L1 → new L1)

**Plan says (Don's plan lines 133-135):**
> L0 segments → L1 sorted segment (k-way merge with dedup and tombstone filtering).

**Issue:** Second compaction must merge:
- New L0 segments
- Old L1 segment

But the plan treats L1 as the **output**, not an **input**. If old L1 is not included in merge, second compaction LOSES old data.

**Fix Required:** Merge algorithm must check if L1 exists and include it as an input segment.

**Pseudocode:**
```rust
let mut input_segments = Vec::new();

// Add L0 segments
for seg in shard.node_segments {
    input_segments.push(seg);
}

// Add existing L1 segment (if exists)
if let Some(l1_seg) = shard.l1_node_segment {
    input_segments.push(l1_seg);
}

// Merge all inputs
let merged = merge_segments(input_segments, tombstones);
```

**Missing from plan:** Re-compaction logic not described. Critical gap.

### ⚠️ **CONCERN: GC Safety — Immediate Deletion in Single-Threaded Model**

**Issue:** Joel proposes (tech spec lines 54-66):
> Immediate deletion (no lsof, no gc/ directory). Drop old mmaps synchronously, delete files immediately.

**Rationale:** Single-threaded storage layer, no concurrent readers.

**Problem:** What about **query threads**? The plan mentions "concurrent queries" (Don's plan lines 596-617). If RFDB v2 has query threads, they hold mmap references.

**From storage_v2 architecture:** Is GraphEngineV2 single-threaded or does it spawn query threads?

**Risk:** If query threads exist, immediate deletion can cause:
- Segfault (reading from deleted mmap)
- EBUSY on delete (file still open)

**Clarification Needed:** Is RFDB v2 single-threaded INCLUDING queries? Or single-threaded write path + concurrent read threads?

**Recommendation:** Start with safe approach (gc/ directory + lsof check). Optimize to immediate deletion ONLY after confirming no concurrent readers.

---

## Part 3 — Code Quality

### ✅ **GOOD: Reuse of Existing Infrastructure**

- L1 uses same format as L0 (reuses readers/writers)
- Reuses bloom filters, zone maps, string tables
- No new segment format = 400-500 LOC saved

### ✅ **GOOD: Atomic Swap Mechanism**

- Write to `.tmp/`
- Atomic rename to final path
- Manifest commit is linearization point
- Crash recovery is sound

### ✅ **GOOD: Test Plan Coverage**

- Merge correctness (dedup, tombstones, sort)
- Index serialization roundtrip
- Query equivalence (before/after compaction)
- Concurrent safety (threads + compaction)

### ⚠️ **CONCERN: Commit Granularity — 13 Commits**

**Issue:** Joel proposes 13 atomic commits. Some commits depend on others:
- Commit 8 (Query path) depends on Commit 7 (Swap)
- Commit 11 (Index query) depends on Commit 10 (Index builder)

**Risk:** If Commit 8 fails review, Commits 1-7 are already merged but incomplete.

**Recommendation:** Group related commits:
- Phase 1: Infrastructure (Commits 1-3)
- Phase 2: Merge + Swap (Commits 4-7) — merge as ONE batch
- Phase 3: Query Integration (Commits 8-9) — merge as ONE batch
- Phase 4: Indexes (Commits 10-12) — merge as ONE batch
- Phase 5: Polish (Commit 13)

**Result:** 5 merge points instead of 13. Each merge point delivers a working feature.

### ⚠️ **CONCERN: Big-O Analysis Missing for Query Path**

**Issue:** Joel provides Big-O for compaction (merge, sort, index build) but NOT for query path after compaction.

**Example:** `find_nodes(node_type = "FUNCTION")` after compaction:
- **Before compaction:** O(S * N) where S = segments, N = records per segment
- **After compaction:** O(log K + R) where K = distinct node_types, R = result count

**Missing:** What's the actual query complexity with L0+L1 coexistence?

**Query path with L0+L1:**
1. Scan write buffer: O(B)
2. Scan L0 segments: O(S_L0 * N_L0)
3. Scan L1 via index: O(log K + R)

**Total:** O(B + S_L0 * N_L0 + log K + R)

**Issue:** If L0 has 10 segments after compaction, queries still scan L0. Only fully-compacted data (L1) benefits from indexes.

**Implication:** Performance improvement depends on:
- How often you compact (keep L0 small)
- Ratio of L1 to L0 data

**Missing from plan:** Performance model for L0+L1 coexistence.

---

## Specific Action Items

### **BLOCKER 1: Edge Dedup Key Verification**
**Owner:** User (Вадим)
**Action:** Confirm `(src, dst, edge_type)` is correct dedup key. If Grafema allows parallel edges of same type, edge merge algorithm is WRONG.

### **BLOCKER 2: Fix IndexEntry Layout**
**Owner:** Rob (Implementation)
**Action:** Reorder fields to ensure 32-byte size:
```rust
#[repr(C)]
pub struct IndexEntry {
    pub node_id: u128,      // 0-15
    pub segment_id: u64,    // 16-23
    pub offset: u32,        // 24-27
    pub shard: u16,         // 28-29
    pub _padding: u16,      // 30-31
}
```
Add unit test to verify `std::mem::size_of::<IndexEntry>() == 32`.

### **BLOCKER 3: Fix Lookup Table Hash Collision**
**Owner:** Rob (Implementation)
**Action:** Store actual string value in lookup table, not just hash:
```rust
LookupTableEntry {
    key_value: String,  // actual node_type/file value
    offset: u32,
    count: u32,
}
```
Or: keep hash but add exact string match after hash lookup.

### **BLOCKER 4: Simplify L1 Manifest Schema**
**Owner:** Joel (Tech Spec Revision)
**Action:** Change from `HashMap<u16, SegmentDescriptor>` to:
```rust
pub l1_node_segment: Option<SegmentDescriptor>,
pub l1_edge_segment: Option<SegmentDescriptor>,
```
Single-shard only. Defer HashMap to RFD-22 (multi-shard).

### **BLOCKER 5: Re-Compaction Logic**
**Owner:** Joel (Tech Spec Revision)
**Action:** Add pseudocode for re-compaction (L0 + old L1 → new L1). Ensure old L1 is included in merge inputs.

### **CRITICAL 6: L0+L1 Query Dedup Logic**
**Owner:** Rob (Implementation)
**Action:** Commit 8 must show detailed code changes to `find_nodes()`, `get_node()`, `get_outgoing_edges()` for L0+L1 dedup.

### **IMPORTANT 7: GC Safety Clarification**
**Owner:** User (Вадим)
**Action:** Confirm RFDB v2 threading model. Single-threaded queries? Or concurrent read threads? Determines GC strategy (immediate delete vs gc/ directory).

### **NICE-TO-HAVE 8: Query Complexity Analysis**
**Owner:** Joel (Tech Spec Revision)
**Action:** Add Big-O analysis for query path with L0+L1 coexistence. Model performance improvement vs L0 size.

---

## Summary

**Strengths:**
- Excellent research and design foundations
- Reuses existing infrastructure (writers, readers, manifest)
- Sound crash recovery and atomic swap
- Comprehensive test plan

**Critical Issues:**
1. IndexEntry struct layout = 44 bytes, not 32 (37% waste)
2. Lookup table hash collisions = WRONG query results
3. Manifest schema mismatch (HashMap for single-shard)
4. Re-compaction logic missing (data loss risk)
5. Edge dedup key needs user confirmation

**Recommendation:**
Fix blockers 2-5 in revised tech spec. Get blocker 1 confirmed by user. Then proceed to implementation.

**Estimated Fix Time:** 1-2 days (tech spec revision + user confirmation).

---

**Next Steps:**
1. User confirms edge dedup key (blocker 1)
2. Joel revises tech spec (blockers 2-5, actions 6-8)
3. Re-run auto-review on revised spec
4. If APPROVE → proceed to Uncle Bob (file-level review) → Kent & Rob (implementation)

