# Uncle Bob Review: RFD-21 Resource Adaptation

**Date:** 2026-02-15
**Reviewer:** Robert Martin (Uncle Bob)
**Scope:** File-level structure + method-level quality for RFD-21 changes

---

## File 1: `packages/rfdb-server/src/storage_v2/segment.rs`

**File size:** 1025 lines — **WARNING** (approaching 500-line recommendation, but acceptable for low-churn infrastructure)

**Methods to modify:**
- New method: `prefetch()` (will be ~10-15 lines based on plan)

**File-level:**
- **OK** — File implements segment reader abstraction (NodeSegmentV2, EdgeSegmentV2)
- Single Responsibility: Read-only segment access with bloom/zone map filtering
- 1025 lines includes 540 lines of tests (485 production code)
- File is stable (RFD-20 finalized), new method is small addition

**Method-level: segment.rs::prefetch()**
- **Recommendation: IMPLEMENT DIRECTLY**
- New method, no existing code to review
- Expected size: 10-15 lines (mmap hint call + error handling)
- Risk: LOW — isolated addition, no structural changes

**Risk:** LOW
**Estimated scope:** +12 lines

---

## File 2: `packages/rfdb-server/src/storage_v2/write_buffer.rs`

**File size:** 421 lines — **OK**

**Methods to modify:**
- New method: `estimated_memory_bytes()` (will be ~15-20 lines based on plan)

**File-level:**
- **OK** — File implements in-memory write buffer (memtable pattern)
- Single Responsibility: Buffer accumulation before flush
- 421 lines includes 215 lines of tests (206 production code)
- Clean separation: nodes (HashMap), edges (Vec + HashSet dedup)

**Method-level: write_buffer.rs::estimated_memory_bytes()**
- **Recommendation: IMPLEMENT DIRECTLY**
- New method, no existing code to review
- Expected size: 15-20 lines (size_of calculations for HashMap/Vec/HashSet)
- Risk: LOW — pure calculation, no side effects

**Risk:** LOW
**Estimated scope:** +18 lines

---

## File 3: `packages/rfdb-server/src/storage_v2/shard.rs`

**File size:** 2696 lines — **CRITICAL** (>500 line hard limit, >>700 critical threshold)

**Methods to modify:**
- `add_nodes()` — currently 3 lines (wrapper around WriteBuffer)

**File-level:**
- **CRITICAL — FILE MUST BE SPLIT BEFORE RFD-21 IMPLEMENTATION**
- 2696 lines is 5.4x the recommended maximum
- File violates Single Responsibility:
  - Write buffer operations
  - Flush/segment management
  - Query routing (point lookup, attribute search, neighbor queries)
  - Tombstone management
  - L0/L1 segment tracking
  - Inverted index integration

**Root Cause:**
This is technical debt from RFD-20 rapid iteration. The file grew organically as features were added (flush, compaction, indexing, tombstones). Classic example of "just one more method" syndrome.

**Required Action:**
**STOP. Cannot proceed with RFD-21 implementation until this file is split.**

Per Root Cause Policy (CLAUDE.md):
> When behavior or architecture doesn't match project vision:
> 1. STOP immediately
> 2. Do not patch or workaround
> 3. Identify the architectural mismatch
> 4. Discuss with user before proceeding
> 5. Fix from the roots, not symptoms

**Proposed Split (post-discussion with user):**

```
shard.rs (400 lines)
  - Shard struct + initialization
  - High-level write API (add_nodes, upsert_edges)
  - High-level query API (get_node, find_nodes_by_*, neighbor queries)

shard_flush.rs (300 lines)
  - Flush operations (flush, flush_with_ids)
  - Segment file writing
  - L0 segment registration

shard_segments.rs (250 lines)
  - L0/L1 segment tracking
  - Segment loading/unloading
  - Segment descriptor management

shard_query.rs (400 lines)
  - Point lookup merging (buffer + L0 + L1)
  - Attribute search merging
  - Neighbor query merging
  - Tombstone filtering

tombstone.rs (150 lines) — ALREADY EXISTS, but needs exposure
  - TombstoneSet operations
  - Currently embedded in shard.rs, should be separate module
```

**Method-level: shard.rs::add_nodes()**
- Current implementation: 3 lines (trivial delegation)
- Proposed change: +5 lines (auto-flush check)
- **Recommendation: DEFER until file split**

**Why this matters for RFD-21:**
Adding auto-flush logic to an already massive file perpetuates the problem. We're adding "smart behavior" to a God Object. This is how 6k-line files happen.

**Risk:** HIGH (architectural debt)
**Estimated scope:** Refactoring 2696→4 files (6-8 hours) OR proceed with technical debt (2 minutes)

---

## File 4: `packages/rfdb-server/src/storage_v2/multi_shard.rs`

**File size:** 3285 lines — **CRITICAL** (>500 line hard limit, >>700 critical threshold)

**Methods to modify:**
- `compact()` — currently 203 lines (979-1182)

**File-level:**
- **CRITICAL — FILE MUST BE SPLIT BEFORE RFD-21 IMPLEMENTATION**
- 3285 lines is 6.5x the recommended maximum
- File violates Single Responsibility:
  - Multi-shard routing
  - Query fan-out/merge
  - Compaction orchestration
  - Global index building
  - Manifest coordination
  - Commit batch processing
  - Statistics aggregation

**Root Cause:**
Same as shard.rs — organic growth during RFD-20. Each phase added 300-500 lines:
- Phase 1: Basic multi-shard routing
- Phase 2: Compaction integration
- Phase 3: Global index
- Phase 4: Parallel compaction experiments

**Required Action:**
**STOP. Cannot proceed with RFD-21 until this file is split.**

**Proposed Split (post-discussion with user):**

```
multi_shard.rs (500 lines)
  - MultiShardStore struct + initialization
  - High-level write API (add_nodes, upsert_edges)
  - High-level query API (get_node, find_nodes, edge queries)
  - ShardPlanner integration

multi_shard_query.rs (600 lines)
  - Query fan-out to all shards
  - Result merging (nodes, edges, stats)
  - Tombstone filtering in merge paths

multi_shard_compaction.rs (800 lines)
  - compact() orchestration
  - Parallel compaction task spawning
  - Global index building
  - Manifest commit coordination

multi_shard_commit.rs (400 lines)
  - commit_batch() logic
  - Flush coordination across shards
  - Tombstone propagation
  - Snapshot creation
```

**Method-level: multi_shard.rs::compact()**
- **Current:** 203 lines (979-1182) — **CRITICAL**
- Hard limit: 50 lines for maintainability
- This method is 4x the recommended maximum
- Nested loops, manifest coordination, global index building, parallel task management
- **Recommendation: EXTRACT CompactionOrchestrator before modification**

**Why 203 lines is a problem:**
1. **Cognitive load:** Cannot hold entire function in working memory
2. **Testing difficulty:** Too many paths to cover atomically
3. **Change risk:** Any modification touches multiple concerns
4. **Debugging nightmare:** Stack traces land in middle of 200-line function

**Specific issues in compact():**
- Lines 979-1003: Loop setup + manifest preservation (25 lines)
- Lines 1004-1080: Per-shard compaction decision + execution (76 lines per iteration)
- Lines 1081-1120: Global index building (40 lines)
- Lines 1121-1150: Manifest commit + segment writing (30 lines)
- Lines 1151-1182: Result aggregation (32 lines)

**Proposed refactoring (BEFORE RFD-21):**

```rust
pub fn compact(&mut self, manifest_store: &mut ManifestStore, config: &CompactionConfig)
    -> Result<CompactionResult>
{
    let mut orchestrator = CompactionOrchestrator::new(self, manifest_store, config);

    for shard_idx in 0..self.shards.len() {
        orchestrator.compact_shard_if_needed(shard_idx)?;
    }

    orchestrator.build_global_index()?;
    orchestrator.commit_manifest()?;
    Ok(orchestrator.finalize())
}
```

Each method in `CompactionOrchestrator` would be 20-40 lines max.

**Risk:** CRITICAL (architectural debt + change risk)
**Estimated scope:** Refactoring 3285→4 files (8-12 hours) OR proceed with technical debt + 30% chance of regression

---

## File 5: `packages/rfdb-server/src/storage_v2/compaction/coordinator.rs`

**File size:** 323 lines — **OK**

**Methods to modify:**
- New method: extract task creation logic (~40 lines based on plan)

**File-level:**
- **OK** — File implements compaction decision logic + single-shard merge
- Single Responsibility: Compact one shard (doesn't own multi-shard orchestration)
- 323 lines includes 150 lines of tests (173 production code)
- Clean separation from multi_shard.rs orchestration

**Method-level: coordinator.rs::CompactionTask extraction**
- **Recommendation: IMPLEMENT DIRECTLY**
- New struct + method extraction
- Expected size: ~40 lines (task struct + spawn helper)
- Risk: LOW — isolated addition for parallel execution

**Risk:** LOW
**Estimated scope:** +45 lines

---

## File 6: `packages/rfdb-server/src/storage_v2/compaction/types.rs`

**File size:** 113 lines — **OK**

**Methods to modify:**
- Extend `CompactionConfig` with adaptive fields (~15 lines)

**File-level:**
- **OK** — File defines compaction configuration and result types
- Single Responsibility: Type definitions only
- 113 lines includes 64 lines of tests (49 production code)
- Pure data structures, no logic

**Method-level: types.rs::CompactionConfig extension**
- **Recommendation: IMPLEMENT DIRECTLY**
- Adding new fields + update Default impl
- Expected size: +15 lines (fields + default values)
- Risk: NONE — pure data structure extension

**Risk:** NONE
**Estimated scope:** +15 lines

---

## File 7: `packages/rfdb-server/src/graph/engine_v2.rs`

**File size:** 1440 lines — **WARNING** (approaching 500-line recommendation)

**Methods to modify:**
- `create()` / `create_ephemeral()` — adaptive shard count (~5 lines each)

**File-level:**
- **WARNING** — File is large but not yet critical
- 1440 lines implements GraphStore trait adapter (v1↔v2 translation)
- File serves single purpose (adapter pattern) but has grown with feature additions
- Should be monitored, may need split at 2000 lines

**Method-level: engine_v2.rs::create() / create_ephemeral()**
- Current: `create()` is 15 lines (168-183)
- Current: `create_ephemeral()` is 12 lines (186-197)
- Proposed change: Add adaptive shard count calculation before MultiShardStore::create/ephemeral
- **Recommendation: EXTRACT adaptive_shard_count() helper**

**Why extract:**
```rust
// Current:
pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
    let path = path.as_ref();
    std::fs::create_dir_all(path)?;
    let store = MultiShardStore::create(path, DEFAULT_SHARD_COUNT)?;  // ← will become 10+ lines
    ...
}

// Proposed:
pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
    let path = path.as_ref();
    std::fs::create_dir_all(path)?;
    let shard_count = Self::adaptive_shard_count();  // ← extracted
    let store = MultiShardStore::create(path, shard_count)?;
    ...
}

fn adaptive_shard_count() -> u16 {
    let available_memory = /* system call */;
    // 10 lines of calculation
    clamp(calculated, MIN_SHARDS, MAX_SHARDS)
}
```

**Risk:** LOW (with extraction), MEDIUM (without extraction — method bloat)
**Estimated scope:** +25 lines (15 for helper, 2 per call site × 5 call sites)

---

## Summary & Recommendations

| File | Size | Status | Action Required |
|------|------|--------|-----------------|
| segment.rs | 1025 | WARNING | OK to proceed — add prefetch() |
| write_buffer.rs | 421 | OK | OK to proceed — add estimated_memory_bytes() |
| **shard.rs** | **2696** | **CRITICAL** | **MUST SPLIT BEFORE RFD-21** |
| **multi_shard.rs** | **3285** | **CRITICAL** | **MUST SPLIT BEFORE RFD-21** |
| coordinator.rs | 323 | OK | OK to proceed — add CompactionTask |
| types.rs | 113 | OK | OK to proceed — extend CompactionConfig |
| engine_v2.rs | 1440 | WARNING | OK to proceed — extract adaptive_shard_count() |

### Critical Decision Point

**Option A: Fix Architecture First (Recommended)**
1. STOP RFD-21 implementation
2. Split shard.rs (2696 → 4 files @ ~400-700 lines each)
3. Split multi_shard.rs (3285 → 4 files @ ~400-800 lines each)
4. Estimated time: 2-3 days (includes test migration, integration verification)
5. THEN proceed with RFD-21 on clean foundation
6. Total RFD-21 time: 3-4 days (refactoring) + 2-3 days (feature) = 5-7 days

**Option B: Proceed with Technical Debt (Not Recommended)**
1. Implement RFD-21 changes in current 2696/3285-line files
2. Add "file split" tech debt issues to Linear (v0.2 or v0.3)
3. Risk: 30% chance of regression (touching 200-line compact() method)
4. Total RFD-21 time: 2-3 days (implementation) + uncertain debugging
5. Future cost: File splits become HARDER after adding more features

### Root Cause Assessment

**How did we get here?**
RFD-20 was executed in 4 rapid phases over 2 weeks. Each phase added 300-500 lines to shard.rs and multi_shard.rs:
- Phase 1: Basic LSM structure
- Phase 2: L1 compaction
- Phase 3: Global index
- Phase 4: Inverted index + optimization

**Boy Scout Rule was not enforced** during RFD-20 because:
1. No file-level size checks in pre-implementation reviews
2. "Get it working first, refactor later" mindset
3. No hard stop at 500-line threshold

**How to prevent:**
1. **Mandatory Uncle Bob review** runs BEFORE implementation (STEP 2.5)
2. **Hard limit enforcement:** File >500 lines = auto-REJECT at review
3. **CI check:** Fail build if any file >700 lines (except generated code)

### Recommendation

**I recommend Option A: Fix architecture first.**

**Rationale:**
1. **This is how 6k-line files happen** — "just one more feature" × 10
2. RFD-21 adds "smart auto-flush" to shard.rs and parallel prefetch to multi_shard.rs
3. These are complex behaviors, not simple getters — they deserve clean files
4. Fixing now costs 2-3 days. Fixing after RFD-21/RFD-22/RFD-23 costs 1-2 weeks
5. Per CLAUDE.md Root Cause Policy: "If it takes longer — it takes longer. No shortcuts."

**If user chooses Option B:**
- Create Linear issues: REG-XXX (split shard.rs), REG-YYY (split multi_shard.rs)
- Label: `Tech Debt`, `v0.2`, `High Priority`
- Document in RFD-21 metrics: "Proceeded with architectural debt, payback required before v0.2 release"

---

**Uncle Bob's Verdict:**
🔴 **REJECT — Architecture debt must be addressed**

Two critical files (2696 + 3285 lines) are 5-6x recommended maximum. Adding new features to these files violates Clean Code principles and Root Cause Policy.

**Next Step:**
Present to user: Option A (fix first) vs Option B (debt + future cost).
