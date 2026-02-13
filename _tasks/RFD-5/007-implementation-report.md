# RFD-5 Implementation Report

## File Created
`packages/rfdb-server/src/storage_v2/manifest.rs` — ~1300 LOC (implementation + 58 tests)

## File Modified
- `packages/rfdb-server/src/storage_v2/types.rs` — Added `Hash, Serialize, Deserialize` to `SegmentType`
- `packages/rfdb-server/src/storage_v2/mod.rs` — Added `pub mod manifest` + re-exports

## Data Structures
- `DurabilityMode` — Strict (fsync) / Relaxed (no fsync)
- `Manifest` — Immutable snapshot descriptor
- `SegmentDescriptor` — Segment identity with derived file paths (segment_id + shard_id)
- `ManifestStats` — Pre-computed aggregate statistics
- `SnapshotInfo` — Lightweight snapshot metadata for list operations
- `ManifestIndex` — O(1) tag lookup + O(N) list + O(F) GC via referenced_segments
- `CurrentPointer` — Atomic pointer to current manifest version
- `SnapshotDiff` — HashSet-based set difference between manifests

## ManifestStore API
- **Constructors:** `create()`, `open()`, `ephemeral()` (with `_with_config` variants)
- **Core:** `current()`, `create_manifest()`, `commit()`, `load_manifest()`, `next_segment_id()`
- **Snapshots:** `find_snapshot()` O(1), `list_snapshots()` O(N), `tag_snapshot()`, `diff_snapshots()`
- **GC:** `gc_collect()` O(F), `gc_purge()`

## Key Features
1. **ManifestIndex** — Eliminates O(N) scans for list/find/GC
2. **Derived paths** — `segment_id + shard_id` → file path computed at runtime (future-proof for T2.2)
3. **Atomic commit** — manifest → index → current pointer (crash-safe)
4. **Index consistency check** — `rebuild_index()` on mismatch during `open()`
5. **Two-phase GC** — collect (move to gc/) → purge (delete from gc/)

## Tests: 58 total
- Phase 1: Data structures + serde (13 tests)
- Phase 2: File I/O helpers (3 tests)
- Phase 3: ManifestStore core (12 tests)
- Phase 4: Snapshot operations (6 tests)
- Phase 5: Diff computation (7 tests)
- Phase 6: GC (6 tests)
- Phase 7: Integration — crash simulation (3 tests) + concurrent reads (2 tests)
- Index consistency rebuild (1 test)
- Ephemeral edge cases (5 tests)

## Build Status
- `cargo build` — clean (no new warnings)
- `cargo test --lib storage_v2::manifest` — 58/58 pass
- `cargo clippy` — no warnings from manifest.rs (pre-existing warnings in other files)
