# Auto-Review: RFD-29

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review (Sonnet)
**Task:** RFD-29 - Make v2 edge write-buffer upsert semantics explicit

## Verdict: **APPROVE**

## Review Summary

This is a clean, mechanical refactoring that makes the existing upsert semantics explicit in the API. The changes are well-scoped, properly tested, and improve code clarity without changing behavior.

## Vision & Architecture

**Status:** ✅ OK

- **Alignment with explicit semantics:** The core goal of RFD-29 is achieved. The previous API returned `bool` (inserted?) and `usize` (count added), which were ambiguous. The new API explicitly distinguishes `Inserted` vs `Updated` operations.
- **Idiomatic Rust:** The new types are standard Rust patterns:
  - `EdgeWriteOp` enum for single operation result
  - `UpsertStats` struct for batch operation stats
  - Both derive `Debug, Clone, Copy, PartialEq, Eq` appropriately
- **No over-engineering:** The types are simple and focused. No unnecessary complexity added.
- **Proper scoping:** The types are only `pub` within `storage_v2` module, not exported to external API. This is correct - the delegation layers (Shard, MultiShardStore) don't need to expose these implementation details.

## Practical Quality

**Status:** ✅ OK

### Completeness

All callsites in v2 code updated:
- ✅ `WriteBuffer::add_edge` → `upsert_edge` (signature changed to return `EdgeWriteOp`)
- ✅ `WriteBuffer::add_edges` → `upsert_edges` (signature changed to return `UpsertStats`)
- ✅ `Shard::add_edges` → `upsert_edges` (delegation layer)
- ✅ `MultiShardStore::add_edges` → `upsert_edges` (delegation layer)
- ✅ `GraphEngineV2::add_edges` internal call → `upsert_edges`
- ✅ All test function names updated to match

**No remaining references:** Verified via grep that no `add_edge(s)` calls remain in `storage_v2/` except for `TombstoneSet::add_edges`, which is a different type with different semantics (correct to keep separate).

### Edge Cases

- **Delete+re-add:** ✅ Still works correctly. Phase 5.5 in `commit_batch()` removes re-added IDs from tombstones. The upsert semantics don't affect this - a tombstoned edge that's re-added will be `Inserted` (tombstone cleared the old record).
- **Duplicate handling:** ✅ Tests verify both single-edge and batch upsert with duplicates:
  - `test_edge_dedup`: verifies `Inserted` then `Updated` for duplicate
  - `test_upsert_edges_batch_stats`: verifies batch stats with duplicates
- **Metadata replacement:** ✅ `test_edge_upsert_replaces_metadata` verifies that upsert updates metadata correctly

### Test Coverage

Excellent test coverage of new types:

| Test | What it verifies |
|------|------------------|
| `test_upsert_edges` | Basic insert returns `Inserted` |
| `test_edge_dedup` | Duplicate returns `Updated` |
| `test_edge_upsert_replaces_metadata` | Upsert actually replaces metadata |
| `test_upsert_edges_batch_stats` | Batch stats count inserts/updates correctly |
| `test_multiple_edge_types_same_endpoints` | Different edge_type = different key (both `Inserted`) |

All higher-level tests (shard, multi_shard, engine_v2) continue to pass with renamed methods.

### Regressions

**None detected.** The change is purely additive to the type system. Behavior is identical:
- Before: `add_edge()` returned `true` if inserted, `false` if updated
- After: `upsert_edge()` returns `Inserted` if inserted, `Updated` if updated

Same logic, more explicit types.

## Code Quality

**Status:** ✅ OK

### Naming

- ✅ `EdgeWriteOp` - clear, concise enum name
- ✅ `Inserted` / `Updated` - unambiguous variants
- ✅ `UpsertStats` - accurately describes aggregate stats
- ✅ `upsert_edge(s)` - method names now explicitly state upsert semantics

### Documentation

- ✅ Doc comments updated on all renamed methods
- ✅ New types have clear doc comments explaining semantics
- ✅ Comments in delegation layers updated (e.g., "Upsert edges into write buffer")
- ✅ Phase comments in `commit_batch()` updated to match new method names

### Structure

- ✅ New types defined at top of `write_buffer.rs` before `WriteBuffer` struct (logical placement)
- ✅ Method signatures clearly show the semantic change (`-> EdgeWriteOp`, `-> UpsertStats`)
- ✅ Delegation layers correctly ignore return value (acceptable since stats are for WriteBuffer-level observation)

### Commit Quality

**Atomic commits with clear messages:**

1. **Commit 1** (b90fa3f): Add new types, rename WriteBuffer methods
   - Focused: only changes `write_buffer.rs`
   - Message clearly explains what changed and why

2. **Commit 2** (5764f51): Update all callsites in delegation layers
   - Focused: updates `shard.rs`, `multi_shard.rs`, `engine_v2.rs`, all tests
   - Message clearly explains what changed and explicitly notes what's unchanged (TombstoneSet, GraphStore trait)

Both commits are working states (tests pass after each).

### No Loose Ends

- ✅ No TODOs, FIXMEs, or commented-out code
- ✅ No "will fix later" comments
- ✅ No scope creep - strictly mechanical refactoring as scoped

## Diff Stats

```
4 files changed
~124 insertions, ~92 deletions
```

**Breakdown:**
- New types: +20 lines (enum + struct + docs)
- Method renames: ~50 substitutions (`add_edge` → `upsert_edge`)
- Test updates: ~50 assertions updated to use new enum/struct
- Doc comment updates: ~4 locations

**No unexpected changes.** All changes directly serve the goal.

## Notes

This is an exemplary mechanical refactoring:
- Clear scope (make upsert semantics explicit)
- Complete execution (all callsites updated)
- Proper testing (new types tested, existing tests updated)
- Clean commits (atomic, working, clear messages)
- Zero behavioral change (only type system improvement)

The rename from `add_edge(s)` to `upsert_edge(s)` is particularly valuable - it eliminates confusion about whether the operation is "add or fail" vs "add or update". The new API makes it obvious: **upsert always succeeds, returning whether it inserted or updated.**

---

**Recommendation:** Ready for merge after user confirmation.
