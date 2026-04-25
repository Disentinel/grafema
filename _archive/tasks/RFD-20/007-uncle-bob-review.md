# Uncle Bob Review: RFD-20 Background Compaction

Reviewing files that will be modified during implementation at file-level (size, SRP) and method-level (complexity).

---

## File 1: `shard.rs`

**File size:** 1907 lines — **CRITICAL**
**SRP check:** Single concern (shard read/write operations), but file size is CRITICAL at 1907 lines.

**CRITICAL: File is 1907 lines — approaching 2000. This is 3.8x over the 500-line MUST-SPLIT threshold.**

### Issue

This file has grown to near 2000 lines. For context:
- 500 lines = MUST split
- 700 lines = CRITICAL
- 1907 lines = **WAY PAST CRITICAL**

The file includes:
- ~300 lines of tests (lines 877-1907)
- TombstoneSet struct + methods (~100 lines)
- FlushResult struct (~30 lines)
- Shard struct + constructors (~200 lines)
- Query methods (point lookup, attribute search, neighbor queries) (~300 lines)
- Flush implementation (~100 lines)
- Helper functions (~50 lines)

### What We'll Be Modifying

We will be adding L1 query paths to these methods:
- `find_nodes()` (lines 569-656, ~87 lines) — will add L1 node query logic
- `get_node()` (lines 500-530, ~30 lines) — will add L1 lookup
- `get_outgoing_edges()` (lines 664-723, ~59 lines) — will add L1 edge query
- `get_incoming_edges()` (lines 727-786, ~59 lines) — will add L1 edge query
- `flush_with_ids()` (lines 398-490, ~92 lines) — may need L1 segment handling

None of these methods are individually over 100 lines, but adding L1 logic will increase each by ~20-30 lines (additional segment iteration).

### Recommendation: SKIP Refactoring, CREATE TECH DEBT ISSUE

**Refactoring this file is too risky for PREPARE phase:**
- File is central to storage operations
- Splitting requires architectural decisions (where to draw boundaries?)
- High risk of breaking existing tests
- Would consume >50% of task time

**Instead:**
1. Proceed with implementation as planned (add L1 fields + query logic)
2. Create **tech debt issue** immediately:
   - Title: "Split shard.rs (1907 lines) into focused modules"
   - Suggested split:
     - `shard/core.rs` — Shard struct + constructors
     - `shard/query.rs` — find_nodes, get_node, neighbor queries
     - `shard/flush.rs` — flush_with_ids + helpers
     - `shard/tombstone.rs` — TombstoneSet
     - Keep tests in `shard/tests.rs`
   - Assign to v0.2 (blocking for Early Access quality)

**Risk:** LOW for this task (methods are well-structured, changes are localized)
**Estimated scope:** +100-150 lines total across all modified methods

---

## File 2: `manifest.rs`

**File size:** 2455 lines — **CRITICAL**
**SRP check:** Manifest operations + ManifestStore, but file size is CRITICAL.

**CRITICAL: File is 2455 lines — 4.9x over the 500-line threshold.**

### What We'll Be Modifying

We will be adding:
- `CompactionInfo` struct to `Manifest` (new field + struct definition, ~20 lines)
- L1 segment fields to `SegmentDescriptor` (2 new `Option<u64>` fields, ~10 lines)

### Method-Level

No methods will be directly modified — only struct definitions.

### Recommendation: SKIP Refactoring, CREATE TECH DEBT ISSUE

**Same reasoning as shard.rs:**
- File is 2455 lines (CRITICAL)
- Contains: type definitions, ManifestStore implementation, ManifestIndex, serialization helpers, tests (~800 lines)
- Splitting requires architectural clarity (ManifestStore should be separate module)
- Too risky for PREPARE phase

**Create tech debt issue:**
- Title: "Split manifest.rs (2455 lines) into focused modules"
- Suggested split:
  - `manifest/types.rs` — Manifest, SegmentDescriptor, ManifestStats, SnapshotInfo
  - `manifest/store.rs` — ManifestStore
  - `manifest/index.rs` — ManifestIndex
  - `manifest/io.rs` — atomic_write_json, fsync helpers
  - Keep tests in `manifest/tests.rs`
- Assign to v0.2

**Risk:** LOW (only adding fields, no logic changes)
**Estimated scope:** +30 lines total

---

## File 3: `multi_shard.rs`

**File size:** 2149 lines — **CRITICAL**
**SRP check:** Multi-shard operations, but file size is CRITICAL.

**CRITICAL: File is 2149 lines — 4.3x over the 500-line threshold.**

### What We'll Be Modifying

We will be adding:
- `compact()` method to `MultiShardStore` (~150-200 lines based on plan)

### Method-Level: New Method

The new `compact()` method will be complex (~150-200 lines):
- L0 segment selection (score calculation)
- L1 segment merging logic
- Manifest updates
- Two-pass compaction (nodes, then edges)

**Concern:** Adding a 150-200 line method to a 2149-line file makes the problem worse.

### Recommendation: REFACTOR OPPORTUNITY — Extract Compactor

**This is a GOOD opportunity for refactoring BEFORE implementation:**

**Plan:**
1. Create new module: `packages/rfdb-server/src/storage_v2/compaction.rs`
2. Define `Compactor` struct:
   ```rust
   pub struct Compactor<'a> {
       shards: &'a mut [Shard],
       manifest_store: &'a mut ManifestStore,
       db_path: &'a Path,
   }

   impl<'a> Compactor<'a> {
       pub fn compact_shard(&mut self, shard_id: u16) -> Result<()> { ... }
   }
   ```
3. Call it from `MultiShardStore::compact()` (which becomes a thin wrapper, ~20 lines)

**Benefits:**
- Keeps compaction logic isolated (single purpose module)
- `multi_shard.rs` stays focused on shard coordination
- Easier to test compaction independently
- Doesn't make the 2149-line problem worse

**Risk:** LOW
- Compaction is NEW code, no existing behavior to break
- Clear interface boundary (Compactor borrows mutable refs)
- Tests can target `Compactor` directly

**Estimated scope:**
- Create `compaction.rs`: ~250-300 lines (Compactor + helpers + tests)
- Update `multi_shard.rs`: +20 lines (thin compact() wrapper)
- Time cost: ~10-15% of task (worth it to avoid making file worse)

**Also create tech debt issue for splitting multi_shard.rs:**
- Title: "Split multi_shard.rs (2149 lines) into focused modules"
- Suggested split similar to shard.rs
- Assign to v0.2

---

## File 4: `types.rs`

**File size:** 584 lines — **OK**
**SRP check:** OK (type definitions + helpers)

### What We'll Be Modifying

Minor additions only (no structural changes).

### Recommendation: SKIP

File is under 600 lines, well-structured, no refactoring needed.

**Risk:** LOW
**Estimated scope:** +10-20 lines

---

## File 5: `engine_v2.rs`

**File size:** 1465 lines — **CRITICAL**
**SRP check:** Single concern (GraphStore trait adapter), but file size is CRITICAL.

**CRITICAL: File is 1465 lines — 2.9x over the 500-line threshold.**

### What We'll Be Modifying

We will be adding:
- `compact()` command handler in GraphEngineV2 (~10-15 lines, thin wrapper calling `MultiShardStore::compact()`)

### Method-Level

No existing methods will be modified. New method will be simple delegation.

### Recommendation: SKIP Refactoring, CREATE TECH DEBT ISSUE

**Same reasoning as other files:**
- File is 1465 lines (CRITICAL)
- Contains: type conversion helpers, GraphEngineV2 impl, GraphStore trait impl, tests (~400 lines)
- Splitting requires careful trait boundary design
- Too risky for PREPARE phase

**Create tech debt issue:**
- Title: "Split engine_v2.rs (1465 lines) into focused modules"
- Suggested split:
  - `engine_v2/core.rs` — GraphEngineV2 struct + constructors
  - `engine_v2/conversion.rs` — v1/v2 type conversion
  - `engine_v2/query.rs` — GraphStore query methods
  - `engine_v2/mutation.rs` — GraphStore mutation methods
  - Keep tests in `engine_v2/tests.rs`
- Assign to v0.2

**Risk:** LOW (only adding thin wrapper method)
**Estimated scope:** +15 lines

---

## Summary

### File-Level Assessment

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `shard.rs` | 1907 | **CRITICAL** | SKIP refactoring, CREATE tech debt issue |
| `manifest.rs` | 2455 | **CRITICAL** | SKIP refactoring, CREATE tech debt issue |
| `multi_shard.rs` | 2149 | **CRITICAL** | **REFACTOR: Extract Compactor to compaction.rs** + tech debt issue |
| `types.rs` | 584 | OK | No action needed |
| `engine_v2.rs` | 1465 | **CRITICAL** | SKIP refactoring, CREATE tech debt issue |

### Method-Level Assessment

All methods to be modified are under 100 lines individually. No method-level refactoring needed.

**Exception:** New `compact()` logic (~200 lines) should be extracted to dedicated `compaction.rs` module to avoid making `multi_shard.rs` worse.

### Overall Recommendation

**PROCEED with ONE targeted refactoring:**

1. **Extract Compactor** (BEFORE implementation):
   - Create `packages/rfdb-server/src/storage_v2/compaction.rs`
   - Move compaction logic there (new code, not touching existing)
   - `MultiShardStore::compact()` becomes thin wrapper
   - **Time cost:** ~10-15% of task
   - **Benefit:** Avoids making 2149-line file worse, better separation of concerns

2. **SKIP all other refactoring** (too risky for PREPARE phase)

3. **CREATE 4 tech debt issues** immediately after implementation:
   - Split `shard.rs` (1907 lines)
   - Split `manifest.rs` (2455 lines)
   - Split `multi_shard.rs` (2149 lines)
   - Split `engine_v2.rs` (1465 lines)
   - All assigned to **v0.2** (Early Access quality blocking)

### Risk Assessment

**Overall Risk:** MEDIUM

- **LOW** for struct field additions (shard.rs, manifest.rs, types.rs, engine_v2.rs)
- **MEDIUM** for query method modifications (shard.rs L1 logic) — clear structure, but adds complexity
- **LOW** for Compactor extraction (new code, clean boundary)

### Final Notes

**This codebase has a serious file size problem.** Four files are CRITICAL (>1400 lines), one approaching 2500 lines. This must be addressed in v0.2 for maintainability and Early Access quality.

For RFD-20, the ONE targeted refactoring (Compactor extraction) is justified because:
1. It prevents making the problem worse
2. It's new code with clear boundaries (low risk)
3. It improves testability and separation of concerns
4. Time cost is acceptable (~10-15% of task)

All other refactoring is deferred to tech debt issues.
