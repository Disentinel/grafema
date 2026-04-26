# Don Melton — Plan Revision for RFD-5 (Steve Jobs Review)

**Date:** 2026-02-13
**Task:** T2.1 Manifest + Snapshot Chain
**Status:** Revised after Steve Jobs architectural review

---

## Steve's Verdict: REJECT

Steve identified 5 fundamental O(N) performance issues and extensibility gaps that violate Grafema's "don't brute-force" principle. All objections are valid and must be fixed before implementation.

---

## Summary of Steve's Objections

### 1. O(N) list_snapshots — scans all manifests
**Problem:** Current design: `list_snapshots()` reads manifests/ directory, loads every manifest file, extracts metadata. For 10K manifests = 10K disk reads.

**Fix:** Add `ManifestIndex` — single file tracking all snapshot metadata + tag index. Updated atomically during commit. `list_snapshots()` reads ONE file.

### 2. O(N) find_snapshot — chain traversal
**Problem:** Current design: walk parent chain backwards, load each manifest, check tags. Worst case = load all manifests from current to v1.

**Fix:** Tag index inside ManifestIndex: `tag_key -> tag_value -> version`. O(1) lookup via HashMap.

### 3. Sharding extensibility — file_path as string
**Problem:** `file_path: String` embeds directory structure in manifest. When we add sharding (T2.2), must rewrite all manifests or parse strings.

**Fix:** Store `segment_id + shard_id (Option)` separately. Derive paths on read. Sharding becomes config change, not data migration.

### 4. GC O(R×S + F) — loads all manifests in retention window
**Problem:** `gc_collect()` loads every manifest in [current - retention, current], extracts segments, builds referenced set. For 100 manifests × 100 segments = 10K disk reads + set ops.

**Fix:** Maintain `referenced_segments: HashSet<u64>` in ManifestIndex. Updated during commit. GC becomes O(F) — just scan segments/ dir and check set membership. No manifest loading.

### 5. Fsync not configurable
**Problem:** Fsync adds 5-10ms latency. Hardcoded = no escape hatch for throughput-over-durability scenarios.

**Fix:** Add `DurabilityMode { Strict, Relaxed }` to ManifestStore config. Strict = fsync everything. Relaxed = skip fsync (best-effort durability).

---

## Revised Architecture: ManifestIndex

### Core Idea

**ManifestIndex is the key addition.** It's a single index file (`manifest_index.json`) that caches:
1. All snapshot metadata (version, created_at, tags, stats)
2. Tag index for O(1) tag lookups
3. Referenced segments across ALL manifests (for O(F) GC)
4. Latest version pointer (redundant with current.json, but convenient)

**Updated atomically alongside current.json during commit.** Same atomic write protocol: temp file + fsync + rename.

### ManifestIndex Structure

```rust
/// ManifestIndex: cached metadata for all snapshots + tag index + GC reference tracking.
///
/// Single-file index that eliminates O(N) operations:
/// - list_snapshots() → O(1) (read index)
/// - find_snapshot() → O(1) (tag index lookup)
/// - gc_collect() → O(F) (scan segments/ dir, check referenced set)
///
/// Updated atomically during commit (written to manifest_index.json.tmp, then renamed).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestIndex {
    /// Latest manifest version (redundant with current.json, but convenient)
    pub latest_version: u64,

    /// All snapshot metadata (sorted by version ascending)
    /// Contains version, created_at, tags, stats for every manifest ever created.
    pub snapshots: Vec<SnapshotInfo>,

    /// Tag index: tag_key -> tag_value -> version
    /// Enables O(1) find_snapshot() lookup.
    /// Example: {"commit_sha": {"abc123": 5, "def456": 7}}
    #[serde(default)]
    pub tag_index: HashMap<String, HashMap<String, u64>>,

    /// All segment IDs referenced by ANY active manifest (union across all versions).
    /// Used by GC: segments NOT in this set are unreferenced → safe to collect.
    /// Updated during commit: add new segments, remove segments from GC'd manifests.
    pub referenced_segments: HashSet<u64>,
}

impl ManifestIndex {
    /// Create empty index (for new database)
    pub fn new() -> Self {
        Self {
            latest_version: 0,
            snapshots: Vec::new(),
            tag_index: HashMap::new(),
            referenced_segments: HashSet::new(),
        }
    }

    /// Add snapshot to index (called during commit)
    pub fn add_snapshot(&mut self, manifest: &Manifest) {
        // Add to snapshots list
        self.snapshots.push(SnapshotInfo::from_manifest(manifest));

        // Update tag index
        for (key, value) in &manifest.tags {
            self.tag_index
                .entry(key.clone())
                .or_insert_with(HashMap::new)
                .insert(value.clone(), manifest.version);
        }

        // Add segments to referenced set
        for seg in manifest.node_segments.iter().chain(manifest.edge_segments.iter()) {
            self.referenced_segments.insert(seg.segment_id);
        }

        // Update latest version
        self.latest_version = manifest.version;
    }

    /// Remove old snapshot from index (called during GC)
    pub fn remove_snapshot(&mut self, version: u64) {
        // Remove from snapshots list
        self.snapshots.retain(|info| info.version != version);

        // Remove from tag index
        for tag_values in self.tag_index.values_mut() {
            tag_values.retain(|_, v| *v != version);
        }
        // Clean up empty tag keys
        self.tag_index.retain(|_, values| !values.is_empty());

        // Note: referenced_segments NOT updated here (conservative GC keeps all)
    }

    /// Find snapshot by tag (O(1) lookup)
    pub fn find_by_tag(&self, tag_key: &str, tag_value: &str) -> Option<u64> {
        self.tag_index
            .get(tag_key)
            .and_then(|values| values.get(tag_value))
            .copied()
    }

    /// List snapshots (O(1) — already in memory)
    pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Vec<SnapshotInfo> {
        if let Some(tag_key) = filter_tag {
            self.snapshots.iter()
                .filter(|info| info.tags.contains_key(tag_key))
                .cloned()
                .collect()
        } else {
            self.snapshots.clone()
        }
    }
}
```

### SegmentDescriptor with Sharding Support

**Current (wrong):**
```rust
pub struct SegmentDescriptor {
    pub segment_id: u64,
    pub file_path: String,  // ❌ Embeds directory structure
    // ...
}
```

**Revised (correct):**
```rust
pub struct SegmentDescriptor {
    /// Unique segment ID (globally monotonic)
    pub segment_id: u64,

    /// Optional shard ID (None = flat segments/ directory, Some(n) = segments/0n/ directory)
    /// Phase 1: always None. T2.2 adds sharding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shard_id: Option<u16>,

    /// Segment type (nodes or edges)
    pub segment_type: SegmentType,

    /// Record count, byte size, zone maps (unchanged)
    pub record_count: u64,
    pub byte_size: u64,
    pub node_types: HashSet<String>,
    pub file_paths: HashSet<String>,
    pub edge_types: HashSet<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum SegmentType {
    Nodes,
    Edges,
}

impl SegmentDescriptor {
    /// Derive file path from segment_id, shard_id, segment_type.
    /// Path generation logic centralized here (easy to change in T2.2).
    pub fn file_path(&self, db_path: &Path) -> PathBuf {
        let type_suffix = match self.segment_type {
            SegmentType::Nodes => "nodes",
            SegmentType::Edges => "edges",
        };

        let filename = format!("seg_{:06}_{}.seg", self.segment_id, type_suffix);

        if let Some(shard_id) = self.shard_id {
            // Sharded: segments/{shard_id:02}/seg_{id}_{type}.seg
            db_path.join("segments").join(format!("{:02}", shard_id)).join(filename)
        } else {
            // Flat: segments/seg_{id}_{type}.seg
            db_path.join("segments").join(filename)
        }
    }

    /// Derive relative path string for logging/debugging
    pub fn relative_path(&self) -> String {
        let type_suffix = match self.segment_type {
            SegmentType::Nodes => "nodes",
            SegmentType::Edges => "edges",
        };
        let filename = format!("seg_{:06}_{}.seg", self.segment_id, type_suffix);

        if let Some(shard_id) = self.shard_id {
            format!("segments/{:02}/{}", shard_id, filename)
        } else {
            format!("segments/{}", filename)
        }
    }
}
```

**Migration path:**
- Phase 1: `shard_id = None` always (flat directory)
- T2.2: Add sharding config → new segments get `shard_id = Some(hash(segment_id) % num_shards)`
- Old segments with `shard_id = None` still work (derive path correctly)
- No manifest rewrite needed

### DurabilityMode Config

```rust
/// Durability mode for manifest writes.
///
/// Strict: Full fsync protocol (manifest + current pointer + directory).
///         Ensures crash safety at cost of ~5-10ms commit latency.
///
/// Relaxed: Skip fsync (OS buffers writes). Best-effort durability.
///          Faster commits (~1ms), but crash may lose recent commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityMode {
    Strict,   // fsync everything
    Relaxed,  // skip fsync (OS handles flush)
}

impl Default for DurabilityMode {
    fn default() -> Self {
        DurabilityMode::Strict  // Safe default
    }
}

pub struct ManifestStore {
    db_path: Option<PathBuf>,
    current: Manifest,
    next_segment_id: AtomicU64,
    index: ManifestIndex,           // NEW: cached index
    durability: DurabilityMode,      // NEW: fsync config
}

impl ManifestStore {
    /// Open existing database with custom durability mode.
    pub fn open_with_config(db_path: &Path, durability: DurabilityMode) -> Result<Self> {
        // Load current.json → get version
        let current_pointer = CurrentPointer::read_from(db_path)?;
        let current = load_manifest(db_path, current_pointer.version)?;

        // Load manifest_index.json
        let index_path = db_path.join("manifest_index.json");
        let index: ManifestIndex = read_json(&index_path)?;

        // Compute next_segment_id from index.referenced_segments
        let max_segment_id = index.referenced_segments.iter().max().copied().unwrap_or(0);
        let next_segment_id = AtomicU64::new(max_segment_id + 1);

        Ok(Self {
            db_path: Some(db_path.to_path_buf()),
            current,
            next_segment_id,
            index,
            durability,
        })
    }

    /// Open with default durability (Strict)
    pub fn open(db_path: &Path) -> Result<Self> {
        Self::open_with_config(db_path, DurabilityMode::Strict)
    }
}
```

### Updated Commit Protocol with Index

**Old (no index):**
```
1. Write manifests/{version}.json
2. Fsync manifest
3. Write current.json.tmp
4. Fsync current.json.tmp
5. Rename current.json.tmp → current.json
6. Fsync directory
```

**New (with index):**
```
1. Write manifests/{version}.json
2. Fsync manifest (if Strict mode)
3. Update ManifestIndex in memory
4. Write manifest_index.json.tmp
5. Fsync manifest_index.json.tmp (if Strict mode)
6. Rename manifest_index.json.tmp → manifest_index.json
7. Write current.json.tmp
8. Fsync current.json.tmp (if Strict mode)
9. Rename current.json.tmp → current.json
10. Fsync directory (if Strict mode + Linux)
```

**Ordering rationale:**
- Manifest written first (immutable data)
- Index written second (metadata update)
- Current pointer written last (atomic commit marker)
- Crash before step 9 → old version active, new manifest + index are orphaned (harmless)
- Crash after step 9 → new version active, index + manifest consistent

### Updated GC with Index

**Old (O(R×S + F)):**
```rust
pub fn gc_collect(&self, retention_versions: u64) -> Result<Vec<String>> {
    let min_version = self.current.version.saturating_sub(retention_versions);
    let mut referenced_ids = HashSet::new();

    // Load every manifest in [min_version, current]
    for version in min_version..=self.current.version {
        let manifest = self.load_manifest(version)?;  // ❌ O(R) disk reads
        for seg in manifest.node_segments.iter().chain(manifest.edge_segments.iter()) {
            referenced_ids.insert(seg.segment_id);
        }
    }

    // Scan segments/ directory
    for entry in std::fs::read_dir(segments_dir)? {
        let segment_id = parse_segment_id(entry)?;
        if !referenced_ids.contains(&segment_id) {
            // Move to gc/
        }
    }
}
```

**New (O(F)):**
```rust
pub fn gc_collect(&self) -> Result<Vec<String>> {
    // Referenced segments already tracked in index (updated during commit)
    let referenced_ids = &self.index.referenced_segments;  // ✅ O(1) access

    // Scan segments/ directory
    let segments_dir = self.db_path.as_ref().unwrap().join("segments");
    let mut moved = Vec::new();

    for entry in std::fs::read_dir(&segments_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("seg") {
            continue;
        }

        if let Some(segment_id) = parse_segment_id_from_filename(path.file_name().unwrap().to_str().unwrap()) {
            if !referenced_ids.contains(&segment_id) {  // ✅ O(1) lookup
                let gc_path = self.db_path.as_ref().unwrap().join("gc").join(path.file_name().unwrap());
                std::fs::rename(&path, &gc_path)?;
                moved.push(gc_path.to_string_lossy().to_string());
            }
        }
    }

    Ok(moved)
}
```

**Note:** Retention policy now handled differently:
- Phase 1: GC has NO retention parameter (collects ALL unreferenced segments immediately)
- T2.2: Add time-based retention (keep segments for N days even if unreferenced)
- T2.2: Index tracks `last_referenced_at` timestamp per segment

### Updated list_snapshots

**Old (O(M×S)):**
```rust
pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Result<Vec<SnapshotInfo>> {
    let manifests_dir = self.db_path.as_ref().unwrap().join("manifests");
    let mut infos = Vec::new();

    for entry in std::fs::read_dir(&manifests_dir)? {  // ❌ O(M) disk reads
        let manifest: Manifest = read_json(&entry.path())?;
        if let Some(tag_key) = filter_tag {
            if !manifest.tags.contains_key(tag_key) {
                continue;
            }
        }
        infos.push(SnapshotInfo::from_manifest(&manifest));
    }

    infos.sort_by_key(|info| info.version);
    Ok(infos)
}
```

**New (O(1)):**
```rust
pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Result<Vec<SnapshotInfo>> {
    // Index already has all snapshots (loaded at open time)
    Ok(self.index.list_snapshots(filter_tag))  // ✅ O(1) — in-memory filter
}
```

### Updated find_snapshot

**Old (O(N×S) chain traversal):**
```rust
pub fn find_snapshot(&self, tag_key: &str, tag_value: &str) -> Result<Option<u64>> {
    let mut current = self.current.clone();
    loop {
        if let Some(value) = current.tags.get(tag_key) {
            if value == tag_value {
                return Ok(Some(current.version));
            }
        }
        match current.parent_version {
            Some(parent_ver) => {
                current = self.load_manifest(parent_ver)?;  // ❌ O(N) disk reads
            }
            None => return Ok(None),
        }
    }
}
```

**New (O(1) index lookup):**
```rust
pub fn find_snapshot(&self, tag_key: &str, tag_value: &str) -> Result<Option<u64>> {
    Ok(self.index.find_by_tag(tag_key, tag_value))  // ✅ O(1) HashMap lookup
}
```

---

## Revised LOC Estimate

**Original estimate:** ~500 LOC

**Added complexity:**
1. ManifestIndex struct + impl: +80 LOC
2. Index update in commit(): +20 LOC
3. Index persistence (atomic write): +15 LOC
4. SegmentDescriptor.file_path() derivation: +20 LOC
5. DurabilityMode enum + conditional fsync: +15 LOC

**New estimate:** ~650 LOC

**Still reasonable for Phase 1.** ManifestIndex is NOT premature optimization — it's a correctness fix. Without it, we have O(N) operations that break at scale.

---

## Revised Storage Layout

```
<name>.rfdb/
├── current.json                    # Atomic pointer: {"version": 5}
├── manifest_index.json             # ✅ NEW: Index with all snapshot metadata + tag index + referenced segments
├── manifests/
│   ├── 000001.json                 # Manifest v1 (immutable after commit)
│   ├── 000002.json
│   ├── 000003.json
│   └── 000005.json                 # Current (gaps OK after crash recovery)
├── segments/
│   ├── seg_000001_nodes.seg        # Immutable v2 segment
│   ├── seg_000001_edges.seg
│   ├── seg_000002_nodes.seg
│   └── ...
└── gc/                             # Segments pending deletion
    └── seg_000001_nodes.seg
```

**File sizes:**
- `current.json`: 20 bytes
- `manifest_index.json`: ~10KB for 1000 snapshots (acceptable, scales linearly)
- `manifests/000001.json`: 1-5 KB per manifest (unchanged)

**Index size growth:**
- 1K snapshots × 10 bytes/snapshot = 10 KB
- 10K snapshots = 100 KB
- 100K snapshots = 1 MB (still fast to load/parse on SSD)

For databases with >100K snapshots, can add periodic index compaction (remove snapshots older than retention window). Not needed for Phase 1.

---

## Updated Implementation Roadmap

### Phase 1: Data Structures (120 LOC, 7 tests)
- Define all structs (Manifest, SegmentDescriptor, ManifestStats, CurrentPointer, **ManifestIndex**)
- Add `SegmentType` enum
- Add `DurabilityMode` enum
- Implement `SegmentDescriptor::file_path()` derivation
- Implement `ManifestIndex` helper methods

**Tests:**
- test_manifest_serde_roundtrip
- test_segment_descriptor_from_meta
- test_segment_descriptor_file_path_flat (shard_id = None)
- test_segment_descriptor_file_path_sharded (shard_id = Some)
- test_manifest_index_add_snapshot
- test_manifest_index_find_by_tag
- test_manifest_index_list_snapshots

### Phase 2: File I/O Helpers (100 LOC, 6 tests)
- atomic_write_json with conditional fsync (DurabilityMode)
- read_json
- fsync_directory (conditional compilation)
- manifest_file_path, parse_segment_id_from_filename, current_timestamp

**Tests:**
- test_atomic_write_json_strict_mode (with fsync)
- test_atomic_write_json_relaxed_mode (no fsync)
- test_read_json_missing_file
- test_fsync_directory_no_error
- test_parse_segment_id_from_filename
- test_durability_mode_default

### Phase 3: ManifestStore Core (180 LOC, 10 tests)
- ManifestStore::open_with_config (load index)
- ManifestStore::open (default durability)
- ManifestStore::create (write first manifest + empty index)
- ManifestStore::ephemeral
- create_manifest, commit (with index update), load_manifest, next_segment_id

**Tests:**
- test_manifest_store_ephemeral
- test_manifest_store_create_new_database
- test_manifest_store_create_writes_index
- test_manifest_store_open_existing
- test_manifest_store_open_loads_index
- test_manifest_store_commit_updates_index
- test_manifest_store_commit_sequential
- test_manifest_store_commit_monotonicity_check
- test_manifest_store_load_manifest
- test_manifest_store_next_segment_id_increments

### Phase 4: Snapshot Operations (100 LOC, 6 tests)
- find_snapshot (via index)
- list_snapshots (via index)
- tag_snapshot (update manifest + index)

**Tests:**
- test_find_snapshot_by_tag_via_index
- test_find_snapshot_not_found
- test_list_snapshots_all_via_index
- test_list_snapshots_filtered_by_tag
- test_tag_snapshot_updates_index
- test_tag_snapshot_persists_after_reopen

### Phase 5: Diff Computation (50 LOC, 4 tests)
- (Unchanged from original plan)

### Phase 6: Garbage Collection (100 LOC, 5 tests)
- gc_collect (O(F) via index.referenced_segments)
- gc_purge

**Tests:**
- test_gc_collect_uses_index (verify no manifest loading)
- test_gc_collect_unreferenced
- test_gc_collect_preserves_referenced
- test_gc_purge_deletes_files
- test_gc_ephemeral_no_op

### Phase 7: Integration Tests (100 LOC, 7 tests)
- (Original 6 tests + 1 new)
- **NEW:** test_index_consistency_after_crash

**Total:** ~750 LOC, ~45 tests (vs original 600 LOC, 30 tests)

---

## Complexity Analysis After Revision

### Fixed Operations

| Operation | Old | New | Notes |
|-----------|-----|-----|-------|
| `list_snapshots()` | O(M×S) | **O(1)** | Read index (in memory) |
| `find_snapshot(tag)` | O(N×S) | **O(1)** | HashMap lookup in tag_index |
| `gc_collect()` | O(R×S + F) | **O(F)** | No manifest loading, just scan segments/ |

### Unchanged Operations

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `open()` | O(S) | Load current manifest + index (single file each) |
| `commit(manifest)` | O(S) | Write manifest + update index + write index |
| `load_manifest(v)` | O(S) | JSON deserialization (unchanged) |
| `diff_snapshots(from, to)` | O(S) | HashSet-based set difference (unchanged) |

### Space Complexity

| Data Structure | Size | Notes |
|---------------|------|-------|
| `ManifestIndex` in memory | O(M + T + R) | M = snapshots, T = tag entries, R = referenced segments |
| `ManifestIndex` on disk | ~10 KB per 1000 snapshots | JSON, compresses well |

For typical database (1K manifests, 1K segments): Index = ~10 KB in memory, <5 KB on disk (gzipped).

---

## Migration from Original Plan

**No migration needed.** Original plan was not implemented yet.

If we had shipped original plan, migration would be:
1. Generate ManifestIndex by scanning manifests/ directory (one-time cost)
2. Add `shard_id: None` to all existing SegmentDescriptor entries (backwards compatible)
3. Add `durability: DurabilityMode::Strict` to config (safe default)

But since we're revising BEFORE implementation, no migration cost.

---

## What NOT to Do (Updated)

### Still Deferred to Later Tasks

1. **Sharding implementation (T2.2):** Add sharding config, generate `shard_id` for new segments. Phase 1: `shard_id = None` always.
2. **Compaction (T3.2):** Merge segments. Phase 1: no compaction.
3. **Tombstones (T2.2):** Delete records. Phase 1: no deletes.
4. **Inverted Index (T4.x):** Global index files. Phase 1: no index.
5. **Manifest compression (future):** gzip manifests. Phase 1: plain JSON.
6. **Multi-part index (future):** Split index for >100K snapshots. Phase 1: single file.

### New: What the Index Does NOT Do

1. **No time-based GC retention:** Phase 1 GC collects ALL unreferenced segments immediately. Time-based retention (keep for N days) deferred to T2.2.
2. **No per-segment metadata:** Index tracks segment IDs, not per-segment metadata (that's in manifest). Keeps index small.
3. **No query planning:** Index is for manifest operations, not graph queries. Query planning uses manifest zone maps (unchanged).

---

## Success Criteria (Updated)

### Functional Requirements (All Original + New Index Tests)

- [ ] Can create database with first manifest + empty index
- [ ] Index correctly updated during commit
- [ ] Index persists across reopen
- [ ] find_snapshot() uses index (O(1) lookup)
- [ ] list_snapshots() uses index (O(1) scan)
- [ ] gc_collect() uses index.referenced_segments (O(F), no manifest loading)
- [ ] SegmentDescriptor.file_path() works with shard_id = None
- [ ] SegmentDescriptor.file_path() works with shard_id = Some (future-proofing test)
- [ ] DurabilityMode::Strict performs fsync
- [ ] DurabilityMode::Relaxed skips fsync
- [ ] All original tests still pass

### Performance Targets (Phase 1)

- [ ] Commit latency <10ms (Strict mode, SSD)
- [ ] Commit latency <1ms (Relaxed mode, SSD)
- [ ] GC collect <100ms for 10K segments (no manifest loading)
- [ ] list_snapshots <5ms for 1000 snapshots (in-memory filter)
- [ ] find_snapshot <1ms (HashMap lookup)

---

## Alignment with Vision (Unchanged)

**"AI should query the graph, not read code."**

This revision IMPROVES alignment:
- Faster manifest operations = faster graph analysis startup
- O(1) tag lookups = better time-travel queries
- O(F) GC = scales to massive codebases

**No shortcuts.** Steve was right to reject. ManifestIndex is the RIGHT solution, not a hack.

---

## Risk Assessment After Revision

### New Risks Introduced

1. **Index corruption:** Index gets out of sync with manifests.
   - **Mitigation:** Atomic write (index committed before current pointer). If crash mid-commit, old index + old manifests = consistent.
   - **Recovery:** Can rebuild index by scanning manifests/ (one-time repair operation).

2. **Index size growth:** For databases with >100K snapshots, index becomes >1 MB.
   - **Mitigation:** Phase 1 assumes <10K snapshots (typical). T3.x can add index compaction (remove old snapshots outside retention window).

3. **Index loading latency:** Open database loads index (10-100 KB file).
   - **Mitigation:** Index is small (<100 KB for typical DB). SSD read = <1ms. Acceptable.

### Risks Eliminated

1. **O(N) list_snapshots** — FIXED via index
2. **O(N) find_snapshot** — FIXED via tag_index
3. **O(R×S) GC** — FIXED via referenced_segments
4. **Sharding migration pain** — FIXED via segment_id + shard_id split
5. **Hardcoded fsync** — FIXED via DurabilityMode

---

## Summary for Joel

**Revised scope:**
- Add ManifestIndex (80 LOC + tests)
- Change SegmentDescriptor.file_path to derive from segment_id + shard_id (20 LOC)
- Add DurabilityMode config (15 LOC)
- Update commit protocol to persist index (20 LOC)
- Update GC to use index.referenced_segments (simplifies logic, -30 LOC)
- Update find_snapshot / list_snapshots to use index (simplifies logic, -20 LOC)

**Net change:** +85 LOC (650 total vs 565 original).

**All 5 of Steve's objections addressed.**

Joel: expand this into detailed implementation plan with updated pseudocode for commit protocol, GC algorithm, and index operations.

---

**Recommendation: PROCEED with revised architecture.**

Steve's objections were valid. This revision fixes all 5 issues without adding unreasonable complexity. The ManifestIndex is a natural fit for the manifest chain pattern (Delta Lake has similar index files).

No shortcuts. Do it right.
