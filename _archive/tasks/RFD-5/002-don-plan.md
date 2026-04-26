# Don Melton — High-Level Plan for RFD-5: Manifest + Snapshot Chain

**Date:** 2026-02-13
**Task:** T2.1 Manifest + Snapshot Chain (~500 LOC, ~25 tests)
**Status:** Architectural review complete

---

## Prior Art Research Summary

I researched three production systems that solve similar problems:

### Apache Iceberg Table Format
- **Manifest chain pattern:** Sequential manifest list files point to manifest files containing data file metadata
- **Atomic commits:** Table metadata file swap provides serializable isolation
- **Snapshot isolation:** Readers use snapshot-at-open, unaffected by concurrent writes
- **Sequence numbers:** Every commit gets optimistic sequence number for version tracking

**Key insight:** Manifest metadata separate from data files enables query planning without opening segments.

**Sources:**
- [Apache Iceberg Spec](https://iceberg.apache.org/spec/)
- [Iceberg Metadata Explained](https://olake.io/blog/2025/10/03/iceberg-metadata/)
- [Understanding Manifest Lists](https://amdatalakehouse.substack.com/p/understanding-the-apache-iceberg)

### Delta Lake Transaction Log
- **Atomic commit protocol:** Optimistic concurrency control with cloud storage conditional PUT
- **Transaction log:** Sequential JSON files (000000.json, 000001.json, ...) for each commit
- **Two-phase write:** Writers optimistically write data files, then commit via log entry
- **Multi-part checkpoints:** For large tables, checkpoints split across Parquet files coordinated by JSON manifest

**Key insight:** Atomic rename at commit time provides ACID guarantees. Cloud storage PUT-if-absent prevents conflicts.

**Sources:**
- [Understanding Delta Lake Transaction Log](https://www.databricks.com/blog/2019/08/21/diving-into-delta-lake-unpacking-the-transaction-log.html)
- [Delta Lake ACID Transactions](https://delta-io.github.io/delta-rs/how-delta-lake-works/delta-lake-acid-transactions/)
- [Transaction Log Protocol](https://delta.io/blog/2023-07-07-delta-lake-transaction-log-protocol/)

### LSM-Tree Manifest Pattern
- **Manifest tracks snapshots:** Minimum/maximum snapshot visibility per SSTable
- **File snapshot-based MVCC:** Immutable files + snapshot versioning enables GC without fine-grained tracking
- **Two-phase GC:** Update manifest first, then delete old SSTables (prevents dangling refs on crash)
- **Compaction safety:** Old versions discarded only when no active transaction can see them

**Key insight:** Old SSTables deleted AFTER manifest update. If deleted first, crash leaves manifest pointing to missing files.

**Sources:**
- [TigerBeetle LSM Manifest](https://github.com/tigerbeetle/tigerbeetle/blob/main/src/lsm/manifest.zig)
- [LSM Tree Storage Engine Handbook](https://www.freecodecamp.org/news/build-an-lsm-tree-storage-engine-from-scratch-handbook/)

---

## Architecture Analysis

### What We're Building

**Core thesis:** Manifest = immutable snapshot descriptor. Chain of manifests = version history. Atomic pointer swap = commit.

This matches Delta Lake's transaction log pattern + LSM manifest safety. We're NOT building sharding/compaction yet (those are T2.2+), so keep it simple.

### Existing Code Review

**storage_v2 module is complete and excellent:**
- `types.rs` — clean separation: SegmentHeaderV2, FooterIndex, NodeRecordV2, EdgeRecordV2, **SegmentMeta**
- `segment.rs` — NodeSegmentV2/EdgeSegmentV2 readers with bloom filter, zone map, string table access
- `writer.rs` — NodeSegmentWriter/EdgeSegmentWriter produce SegmentMeta on finish()
- **Pattern:** Writers return SegmentMeta containing record_count, byte_size, segment_type, node_types, file_paths, edge_types

**SegmentMeta is exactly what we need for SegmentDescriptor.** We can convert it directly.

**GraphError enum supports:**
- `Io(std::io::Error)` — filesystem operations
- `Json(serde_json::Error)` — manifest serialization
- `InvalidFormat(String)` — corrupt manifests

No new error variants needed.

---

## File Organization

### New Module: `storage_v2/manifest.rs`

Single file for Phase 1. If it grows >800 LOC, split into:
- `storage_v2/manifest/types.rs` — data structures
- `storage_v2/manifest/store.rs` — ManifestStore operations
- `storage_v2/manifest/diff.rs` — diff computation

But start with single file — KISS.

### Storage Layout

```
<name>.rfdb/
├── current.json                    # Atomic pointer: {"version": 5}
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

**Naming:**
- Manifests: `manifests/{version:06}.json` (zero-padded 6 digits)
- Segments: `segments/seg_{id:06}_{type}.seg` where type = `nodes` | `edges`
- Extension: `.seg` (not `.bin`) to distinguish v2 segments from v1

**Directory creation:**
- `manifests/`, `segments/`, `gc/` created on first use (lazy init)
- Not created for ephemeral databases

---

## Data Structures

### Core Types

```rust
/// Manifest: immutable snapshot descriptor
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    /// Manifest version (sequential, monotonic)
    pub version: u64,

    /// Creation timestamp (Unix epoch seconds)
    pub created_at: u64,

    /// Active node segments
    pub node_segments: Vec<SegmentDescriptor>,

    /// Active edge segments
    pub edge_segments: Vec<SegmentDescriptor>,

    /// Optional tags (empty HashMap = no tags)
    pub tags: HashMap<String, String>,

    /// Pre-computed stats
    pub stats: ManifestStats,

    /// Previous manifest version (None for first manifest)
    pub parent_version: Option<u64>,
}

/// Segment descriptor (zone map summary + file info)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentDescriptor {
    /// Unique segment ID (globally monotonic)
    pub segment_id: u64,

    /// Relative path: "segments/seg_000001_nodes.seg"
    pub file_path: String,

    /// Record count
    pub record_count: u64,

    /// Byte size on disk
    pub byte_size: u64,

    /// Zone map: node types (empty for edge segments)
    pub node_types: HashSet<String>,

    /// Zone map: file paths (empty for edge segments)
    pub file_paths: HashSet<String>,

    /// Zone map: edge types (empty for node segments)
    pub edge_types: HashSet<String>,
}

/// Manifest stats (sum of segment stats)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestStats {
    pub total_nodes: u64,
    pub total_edges: u64,
    pub node_segment_count: u32,
    pub edge_segment_count: u32,
}

/// Atomic pointer to current manifest
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CurrentPointer {
    pub version: u64,
}

/// Snapshot info (for list operations)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub version: u64,
    pub created_at: u64,
    pub tags: HashMap<String, String>,
    pub stats: ManifestStats,
}

/// Diff between two snapshots
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDiff {
    pub from_version: u64,
    pub to_version: u64,
    pub added_node_segments: Vec<SegmentDescriptor>,
    pub removed_node_segments: Vec<SegmentDescriptor>,
    pub added_edge_segments: Vec<SegmentDescriptor>,
    pub removed_edge_segments: Vec<SegmentDescriptor>,
    pub stats_from: ManifestStats,
    pub stats_to: ManifestStats,
}
```

**Design decisions:**

1. **SegmentDescriptor vs SegmentMeta:** SegmentDescriptor is serializable + includes file_path. SegmentMeta (from writer.rs) is ephemeral. Conversion function:
   ```rust
   impl SegmentDescriptor {
       pub fn from_meta(segment_id: u64, file_path: String, meta: SegmentMeta) -> Self {
           Self {
               segment_id,
               file_path,
               record_count: meta.record_count,
               byte_size: meta.byte_size,
               node_types: meta.node_types,
               file_paths: meta.file_paths,
               edge_types: meta.edge_types,
           }
       }
   }
   ```

2. **Tags as HashMap:** Empty HashMap serializes as `{}` in JSON. Optional. Most manifests have no tags.

3. **parent_version:** Enables chain traversal without scanning directory. None for first manifest.

4. **Stats pre-computed:** Avoids iterating segments to get counts. Cheap to compute at manifest creation.

5. **PartialEq derives:** Needed for tests. Manifest equality = structural equality.

---

## Key APIs

### ManifestStore

Main interface. Manages manifest chain + current pointer.

```rust
pub struct ManifestStore {
    /// Database root path (None for ephemeral)
    db_path: Option<PathBuf>,

    /// Current manifest (cached)
    current: Manifest,

    /// Next segment ID to allocate (monotonic counter)
    next_segment_id: AtomicU64,
}

impl ManifestStore {
    /// Open existing database
    pub fn open(db_path: &Path) -> Result<Self>;

    /// Create new database (first manifest)
    pub fn create(db_path: &Path) -> Result<Self>;

    /// Create ephemeral store (in-memory, no disk writes)
    pub fn ephemeral() -> Self;

    /// Get current manifest
    pub fn current(&self) -> &Manifest;

    /// Create new manifest (not yet committed)
    pub fn create_manifest(
        &mut self,
        node_segments: Vec<SegmentDescriptor>,
        edge_segments: Vec<SegmentDescriptor>,
        tags: Option<HashMap<String, String>>,
    ) -> Result<Manifest>;

    /// Atomically commit manifest version (swap current pointer)
    pub fn commit(&mut self, version: u64) -> Result<()>;

    /// Load specific manifest version
    pub fn load_manifest(&self, version: u64) -> Result<Manifest>;

    /// Find snapshot by tag (walks chain backwards from current)
    pub fn find_snapshot(&self, tag_key: &str, tag_value: &str) -> Result<Option<u64>>;

    /// List all snapshots (optionally filtered by tag key)
    pub fn list_snapshots(&self, filter_tag: Option<&str>) -> Result<Vec<SnapshotInfo>>;

    /// Compute diff between two snapshots
    pub fn diff_snapshots(&self, from: u64, to: u64) -> Result<SnapshotDiff>;

    /// Tag existing snapshot (modifies manifest file)
    pub fn tag_snapshot(&self, version: u64, tags: HashMap<String, String>) -> Result<()>;

    /// GC: collect unreferenced segments → move to gc/
    pub fn gc_collect(&self, retention_versions: u64) -> Result<Vec<String>>;

    /// GC: delete files in gc/ directory
    pub fn gc_purge(&self) -> Result<usize>;

    /// Allocate next segment ID (thread-safe)
    pub fn next_segment_id(&self) -> u64;
}
```

**Thread safety:**
- `ManifestStore` is NOT `Send + Sync` by default (PathBuf, cached manifest)
- `next_segment_id` uses AtomicU64 for concurrent segment allocation
- For multi-threaded writes, caller must wrap in Arc<Mutex<ManifestStore>>
- Phase 1: single-threaded only (multi-threaded batch commits are T3.1)

### Atomic Write Helpers

```rust
/// Write JSON atomically via temp file + rename
fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> Result<()> {
    let temp_path = path.with_extension("tmp");
    let mut file = File::create(&temp_path)?;
    serde_json::to_writer_pretty(&file, data)?;
    file.sync_all()?;                       // fsync before rename
    std::fs::rename(&temp_path, path)?;     // atomic on POSIX
    Ok(())
}

/// Read JSON from file
fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = File::open(path)?;
    Ok(serde_json::from_reader(file)?)
}
```

**Why pretty print?** Manifests are debugging artifacts. Pretty JSON aids manual inspection. Cost: ~20% larger files, negligible for <5KB manifests.

---

## Interaction with Existing Segment Format

### Conversion: SegmentMeta → SegmentDescriptor

Writer produces SegmentMeta. Manifest needs SegmentDescriptor. Conversion:

```rust
// In writer.rs, after writer.finish():
let meta = writer.finish(&mut file)?;
let descriptor = SegmentDescriptor::from_meta(
    store.next_segment_id(),
    format!("segments/seg_{:06}_{}.seg", segment_id, "nodes"),
    meta,
);
```

**Pattern:**
1. Allocate segment ID from ManifestStore
2. Write segment to disk at allocated path
3. Convert SegmentMeta → SegmentDescriptor
4. Add descriptor to manifest

### Zone Map Summary in Manifest

SegmentMeta already contains:
- `node_types: HashSet<String>`
- `file_paths: HashSet<String>`
- `edge_types: HashSet<String>`

SegmentDescriptor stores these directly. Manifest-level query planning:

```rust
// "Does any segment contain FUNCTION nodes in src/main.rs?"
manifest.node_segments.iter().any(|seg| {
    seg.node_types.contains("FUNCTION") && seg.file_paths.contains("src/main.rs")
})
```

No need to open segments. This is Iceberg's pattern — metadata enables pruning.

---

## Critical Nuances

### 1. Crash Safety

**Atomic pointer guarantees:**
- Write new segments → write new manifest → **fsync manifest** → atomic rename current.json.tmp → current.json → **fsync directory**
- Before commit: old manifest active, new segments orphaned (GC cleans them)
- After commit: new manifest active, old segments unreferenced (GC moves to gc/)
- During commit: rename is atomic on POSIX (one syscall)

**Corner cases:**
- Crash after segment write, before manifest write → orphan segments → GC cleanup
- Crash after manifest write, before commit → manifest exists but unreferenced → overwritten on next commit (same version)
- Crash during rename → either old or new pointer, never partial (atomic)

**Directory fsync:** Required for durability on ext4/XFS. After rename, fsync parent directory to persist directory entry.

```rust
fn fsync_directory(path: &Path) -> Result<()> {
    let dir = File::open(path.parent().unwrap())?;
    dir.sync_all()?;
    Ok(())
}
```

### 2. Concurrent Readers During Commit

**mmap reference counting handles this:**
- Reader opens v1 manifest → opens segments → mmap segments
- Writer creates v2 segments → creates v2 manifest → commits (swaps current.json)
- New readers see v2
- Old reader still holds mmap of v1 segments → OS keeps file data alive
- When old reader closes, OS releases mmap → v1 segment files can be deleted

**No locking needed.** OS handles reference counting.

**GC implication:** Don't delete segment files immediately. Move to gc/ first, purge later (deferred until no mmaps).

### 3. Version Monotonicity

Versions MUST be strictly increasing. Gaps are OK (crash recovery skips failed version).

```rust
fn next_version(&self) -> u64 {
    self.current.version + 1
}
```

If manifest file exists for next_version (from previous failed write), **overwrite it** — it was never committed, so safe to reuse.

### 4. Ephemeral Databases

Ephemeral DBs (in-memory only) don't write manifests. ManifestStore for ephemeral:
- `db_path = None`
- `create_manifest()` and `commit()` are no-ops (only update `self.current`)
- No filesystem operations

Detect ephemeral via `db_path: Option<PathBuf>`.

### 5. Manifest File Size Growth

Typical manifest: 1-5 KB. 1000 manifests = ~5 MB. Acceptable.

For long-running DBs (100K+ manifests), old manifests can be purged alongside GC'd segments. Not in Phase 1.

### 6. GC Two-Phase Safety

**Phase 1: collect** — move unreferenced segments to gc/
**Phase 2: purge** — delete files from gc/

**Why two phases?** Safety. If collect logic is wrong (manifest parsing bug), files are in gc/, not deleted. Move them back, fix bug, retry.

**LSM insight:** Delete files AFTER manifest update, not before. Otherwise crash leaves dangling references.

### 7. Chain Traversal Performance

`find_snapshot()` walks parent chain: O(N) where N = manifests from current to target.

**Phase 1:** Naive linear scan. For 1000 manifests, worst case = 1000 disk reads (~100ms on SSD).

**Future optimization (not Phase 1):** Manifest cache. Or: `list_snapshots()` reads directory, avoids chain walk.

### 8. Tag Modification

Tags are mutable. `tag_snapshot()` rewrites manifest file with added tags.

**Safe because:**
- Manifest version unchanged (same filename)
- Manifest immutable EXCEPT tags
- Atomic write via temp file + rename

**Use case:** Post-hoc tagging. E.g., after analysis completes, tag snapshot with "analysis_run: complete".

### 9. Diff Correctness

Diff must be **exact:** segment in from but not in to = removed. Segment in to but not in from = added.

**Algorithm:** HashSet-based set difference. O(S) where S = total segments in both manifests.

```rust
let from_ids: HashSet<u64> = from.node_segments.iter().map(|s| s.segment_id).collect();
let to_ids: HashSet<u64> = to.node_segments.iter().map(|s| s.segment_id).collect();

let added: Vec<_> = to.node_segments.iter()
    .filter(|s| !from_ids.contains(&s.segment_id))
    .cloned().collect();
let removed: Vec<_> = from.node_segments.iter()
    .filter(|s| !to_ids.contains(&s.segment_id))
    .cloned().collect();
```

**Validation:** Test must verify `added ∪ removed ∪ unchanged = all segments`.

---

## What to SKIP (Deferred to Later Tasks)

These are mentioned in architecture docs but NOT part of T2.1:

1. **Sharding (T2.2):** Segments organized by directory shard. Phase 1 uses flat `segments/` directory.
2. **Compaction (T3.2):** Merge small segments into larger ones. Phase 1 segments never compacted.
3. **Inverted index (T4.x):** Manifest tracks global index version. Phase 1 has no index.
4. **Tombstones (T2.2):** Deleted records marked in separate .tombstones files. Phase 1 has no deletes.
5. **Compaction state (T3.2):** Manifest tracks compaction progress. Phase 1 field can be empty or omitted.
6. **Multi-part checkpoints:** For very large manifests. Phase 1 assumes manifests <10 KB.
7. **Manifest compression:** gzip manifests for long-term storage. Phase 1 uses plain JSON.

**Keep data structures extensible** so these features fit cleanly. But don't implement them.

---

## Test Strategy

### Test Categories

1. **Unit tests (manifest.rs):** Data structure serialization, conversion functions
2. **Integration tests (manifest_store_tests.rs):** End-to-end operations with temp directories
3. **Crash simulation tests:** Simulate crashes at each step of atomic write
4. **Concurrency tests:** Spawn threads, verify isolation
5. **GC safety tests:** Verify unreferenced detection logic

### Test Fixtures

```rust
fn make_test_descriptor(segment_id: u64, typ: &str, record_count: u64) -> SegmentDescriptor {
    SegmentDescriptor {
        segment_id,
        file_path: format!("segments/seg_{:06}_{}.seg", segment_id, typ),
        record_count,
        byte_size: record_count * 100, // fake size
        node_types: if typ == "nodes" { HashSet::from(["FUNCTION".into()]) } else { HashSet::new() },
        file_paths: if typ == "nodes" { HashSet::from(["src/main.rs".into()]) } else { HashSet::new() },
        edge_types: if typ == "edges" { HashSet::from(["CALLS".into()]) } else { HashSet::new() },
    }
}

fn make_test_manifest(version: u64, node_segs: Vec<SegmentDescriptor>, edge_segs: Vec<SegmentDescriptor>) -> Manifest {
    Manifest {
        version,
        created_at: 1234567890,
        node_segments: node_segs.clone(),
        edge_segments: edge_segs.clone(),
        tags: HashMap::new(),
        stats: ManifestStats {
            total_nodes: node_segs.iter().map(|s| s.record_count).sum(),
            total_edges: edge_segs.iter().map(|s| s.record_count).sum(),
            node_segment_count: node_segs.len() as u32,
            edge_segment_count: edge_segs.len() as u32,
        },
        parent_version: if version > 1 { Some(version - 1) } else { None },
    }
}
```

### Critical Tests (from validation requirements)

1. **Crash simulation:** Kill process mid-write → current.json valid
   - Use `std::fs::hard_link` to simulate partial writes
   - Verify old manifest still loadable

2. **Concurrent reads:** Spawn reader thread, writer swaps current → reader sees consistent snapshot
   - Reader: load manifest, sleep, verify segments still readable
   - Writer: commit new manifest during reader sleep
   - Assert: reader never sees torn reads

3. **GC safety:** Segments in gc/ not referenced by [current - retention, current]
   - Create v1-v10, GC with retention=3
   - Verify only segments from v1-v6 in gc/
   - Verify v7-v10 segments untouched

4. **Version monotonicity:** Create 100 manifests, verify versions = [1, 2, ..., 100]

5. **Diff correctness:** Create v1 with 3 segments, v2 with 5 segments (2 from v1, 3 new)
   - Verify diff: added=3, removed=1, unchanged=2

---

## Implementation Roadmap

### Phase 1: Data Structures (100 LOC, 5 tests)
- Define Manifest, SegmentDescriptor, ManifestStats, CurrentPointer structs
- Serde derives + PartialEq
- Conversion: SegmentMeta → SegmentDescriptor
- Tests: serialization roundtrip, stats computation

### Phase 2: Manifest I/O (100 LOC, 5 tests)
- atomic_write_json, read_json helpers
- Manifest file write/read
- Version formatting (6-digit zero-padded)
- Tests: write → read → identical, pretty JSON formatting

### Phase 3: ManifestStore Core (150 LOC, 8 tests)
- ManifestStore::open, create, ephemeral
- create_manifest, commit
- load_manifest
- Tests: create first manifest, sequential manifests, commit updates current, ephemeral no-ops

### Phase 4: Snapshot Operations (100 LOC, 5 tests)
- find_snapshot, list_snapshots, tag_snapshot
- Tests: find by tag, list all, list filtered, tag persists

### Phase 5: Diff (50 LOC, 4 tests)
- diff_snapshots implementation
- Tests: diff empty→populated, same version, add/remove/mixed

### Phase 6: GC (100 LOC, 3 tests)
- gc_collect, gc_purge
- collect_referenced_segments helper
- Tests: collects unreferenced, preserves referenced, purge deletes

**Total:** ~600 LOC, ~30 tests (slightly over estimate, but includes helpers + error handling).

---

## Dependencies

No new Cargo dependencies. Already have:
- `serde = { version = "1", features = ["derive"] }`
- `serde_json = "1"`
- `blake3` (for segment ID hashing if needed)

---

## Module Exports

Update `storage_v2/mod.rs`:

```rust
pub mod manifest;

pub use manifest::{
    Manifest, ManifestStore, SegmentDescriptor, ManifestStats,
    CurrentPointer, SnapshotInfo, SnapshotDiff,
};
```

---

## Open Questions for Joel

1. **Segment ID allocation:** Should segment IDs be derived (e.g., hash of content) or sequential counter? Sequential is simpler and matches Delta Lake pattern. Recommend sequential.

2. **Directory fsync:** Required for durability on Linux. Add `fsync_directory()` helper or skip for Phase 1? Recommend add — it's 3 lines.

3. **Ephemeral DB detection:** Should ManifestStore constructor take explicit `ephemeral: bool` flag, or detect via `db_path: Option<PathBuf>`? Recommend Option<PathBuf> (cleaner API).

4. **Manifest cache:** Should ManifestStore cache loaded manifests (HashMap<u64, Manifest>) or reload from disk each time? Phase 1 can skip cache (premature optimization), but add TODO comment for future.

5. **GC retention policy:** Should retention_versions be config parameter or hardcoded constant? Recommend parameter (more flexible for tests).

---

## Alignment with Vision

**"AI should query the graph, not read code."**

Manifest-level zone maps enable query planning without opening segments:
- "Find FUNCTION nodes in src/main.rs" → check manifest zone maps → open only relevant segments
- This is Grafema's core value: graph query optimization via metadata

Snapshot chain enables:
- Time-travel queries ("what did the graph look like at commit abc123?")
- Diff-based analysis ("what changed between analysis runs?")
- Rollback on failure ("bad analysis → revert to previous snapshot")

This task is foundational. Gets it right, enables batch commit (T3.1), which enables concurrent writes, which enables scaling.

**No shortcuts.** Atomic write protocol must be correct. GC safety must be airtight. Crash recovery must work.

---

## Recommendation

**Proceed with implementation.** Architecture is solid. Pattern matches production systems (Iceberg, Delta Lake, LSM trees). Scope is clear. Tests are well-defined.

**Key risks:**
1. Atomic write protocol on Windows (rename not atomic) → test on Windows, fallback to fs2 crate if needed
2. Directory fsync portability → wrap in conditional compilation (#[cfg(unix)])
3. mmap lifetime vs file deletion → ensure GC uses two-phase (collect → purge)

**Success criteria:**
- All 30 tests pass
- Crash simulation test kills process mid-write → DB still opens
- Concurrent read test never sees torn reads
- GC never deletes referenced segments

Joel: expand this into detailed implementation plan with step-by-step pseudocode.
