# Don Melton Plan: RFD-8 T3.1 Tombstones + Batch Commit

## 1. Current State Analysis

### What Exists (built in T2.1 / T2.2 / T2.3)

| Module | File | LOC | Role |
|--------|------|-----|------|
| `types.rs` | Segment types, header, footer, records | ~460 | `NodeRecordV2`, `EdgeRecordV2`, `SegmentMeta`, `SegmentType` (Nodes=0, Edges=1) |
| `writer.rs` | Segment writers | ~300 | `NodeSegmentWriter`, `EdgeSegmentWriter` |
| `segment.rs` | Immutable segment readers | ~480 | `NodeSegmentV2`, `EdgeSegmentV2`, bloom+zone map accessors |
| `bloom.rs` | Bloom filters | ~200 | `BloomFilter` with `maybe_contains(u128)` |
| `zone_map.rs` | Zone maps | ~150 | `ZoneMap` with `contains(field, value)` |
| `string_table.rs` | Per-segment string table | ~200 | `StringTableV2` |
| `write_buffer.rs` | In-memory memtable | ~170 | `WriteBuffer` with HashMap<u128, Node>, Vec<Edge>, edge dedup |
| `manifest.rs` | Manifest chain + snapshots | ~1150 | `ManifestStore`, `Manifest`, `SegmentDescriptor`, `SnapshotDiff` |
| `shard.rs` | Single-shard read/write | ~660 | `Shard` with point lookup, attribute search, neighbor queries |
| `shard_planner.rs` | Directory-based shard assignment | ~200 | `ShardPlanner` |
| `multi_shard.rs` | Multi-shard store | ~500 | `MultiShardStore` with routing, fan-out queries |

**Key architectural characteristics:**

1. **Append-only, no deletion.** Currently the system can only ADD nodes/edges. There is no way to remove or replace records. `WriteBuffer` does upsert for nodes (HashMap keyed by id), and dedup for edges (edge_keys HashSet), but this only works within a single write buffer lifetime. Once flushed to segments, records are immutable.

2. **No batch/transaction concept.** `MultiShardStore::add_nodes()` / `add_edges()` immediately mutate state. `flush_all()` commits everything to disk. There is no way to stage changes and commit/abort atomically.

3. **Segments are truly immutable.** Once written, a segment file is never modified. New data goes into new segments. The manifest tracks which segments constitute the current state via `SegmentDescriptor` lists.

4. **Manifest-based MVCC.** Each manifest version is a point-in-time view. `SnapshotDiff::compute()` already computes added/removed segments between two manifests. This is the foundation we build on.

5. **Edge segments have src bloom filter.** `EdgeSegmentV2` already has `maybe_contains_src(u128)`, which is exactly what we need for bloom-assisted edge tombstoning.

6. **Node records have `file` field and `content_hash`.** Both are first-class fields on `NodeRecordV2`, enabling file-based grouping and content-hash-based modified detection.

### What Needs to Be Added

1. **Tombstone mechanism** -- a way to mark node/edge IDs as deleted so queries skip them
2. **Query path changes** -- all read methods must check tombstones
3. **BatchState** -- per-connection staging area for nodes/edges/tombstones
4. **File grouping + edge ownership** -- when committing a batch of files, determine which nodes/edges to tombstone
5. **Enrichment file context** -- naming convention for enrichment data
6. **CommitDelta** -- structured diff returned after commit
7. **Backward-compatible auto-commit** -- single add_nodes/add_edges outside batch still works

## 2. Architecture Design

### 2.1 Tombstone Strategy: In-Memory HashSet (NOT tombstone segments)

**Decision: Tombstones are NOT separate segment files. They are an in-memory `HashSet<u128>` per Shard, persisted as a simple list in the manifest.**

**Rationale:**

The task description mentions "tombstone segments" but after analyzing the architecture, I believe this is the wrong approach for RFDB v2. Here's why:

1. **Delta Lake Deletion Vectors pattern.** Delta Lake 2.3+ uses "deletion vectors" -- lightweight bitmaps/lists stored alongside the manifest that mark deleted rows. This avoids creating entirely new segment files just for deletion markers. Our case is simpler: we only need to track deleted u128 IDs.

2. **Segment files are immutable, columnar, and optimized for reads.** Creating a new segment type (SegmentType::Tombstone = 2) would require: a new writer, a new reader, a new footer format, bloom filters for tombstones, etc. This is ~200+ LOC of infrastructure for what is essentially a `HashSet<u128>`.

3. **Tombstones are transient.** They exist only until compaction merges segments and physically removes tombstoned records. Storing them as immutable segments creates the same problem that Delta Lake deletion vectors were invented to solve -- rewriting entire segment files for small deletions.

4. **Our manifests already support metadata.** We can add a `tombstoned_node_ids: Vec<u128>` and `tombstoned_edge_keys: Vec<(u128, u128, String)>` to the manifest. On open, these are loaded into in-memory HashSets.

**Concrete approach:**

```rust
/// Tombstone state for a Shard.
/// Persisted in manifest, loaded into memory on open.
pub struct TombstoneSet {
    /// Deleted node IDs. Query path skips these.
    node_ids: HashSet<u128>,
    /// Deleted edge keys (src, dst, edge_type). Query path skips these.
    edge_keys: HashSet<(u128, u128, String)>,
}
```

**In the manifest**, two new fields on each `SegmentDescriptor` group (or at shard level):

```rust
// In Manifest (new fields)
pub tombstoned_node_ids: Vec<u128>,
pub tombstoned_edge_keys: Vec<(u128, u128, String)>,
```

Actually, after further reflection, tombstones should NOT be per-segment-descriptor. They are per-manifest (database-wide). A tombstoned node ID means "this node is deleted regardless of which segment it appears in."

**Alternative considered and rejected:** Per-segment deletion vectors (bit arrays). These are more efficient for very large segments where only a few rows are deleted, but they require knowing which segment contains which record. Our bloom-filter-based lookup doesn't give us segment-record mapping. The HashSet approach is simpler and works at any scale where tombstone count is << total record count.

**Scale analysis:** 10K tombstoned nodes = 10K * 16 bytes = 160KB. 100K tombstoned nodes = 1.6MB. These are well within manifest size limits. Compaction (future T4.x) will clear tombstones by physically rewriting segments.

### 2.2 Query Path Changes

Every read method in `Shard` must check tombstones:

**`get_node(id)`:**
```
if tombstones.contains_node(id) -> return None
```

**`node_exists(id)`:**
```
if tombstones.contains_node(id) -> return false
```

**`find_nodes(node_type, file)`:**
```
for each result: if tombstones.contains_node(id) -> skip
```

**`get_outgoing_edges(node_id, edge_types)`:**
```
for each result: if tombstones.contains_edge(src, dst, edge_type) -> skip
```

**`get_incoming_edges(node_id, edge_types)`:**
```
for each result: if tombstones.contains_edge(src, dst, edge_type) -> skip
```

The check is O(1) per record (HashSet lookup). This adds negligible overhead to query paths.

**Important:** `WriteBuffer` does NOT need tombstone checks. The write buffer only contains live data for the current batch. Tombstones apply to data in flushed segments.

### 2.3 BatchState Design

```rust
/// Per-connection batch state.
/// Lives in the connection/session layer, NOT in MultiShardStore/Shard.
///
/// Accumulates all mutations during a batch, then applies them
/// atomically on commit.
pub struct BatchState {
    /// Nodes to add/upsert, grouped by file path.
    nodes_by_file: HashMap<String, Vec<NodeRecordV2>>,

    /// Edges to add.
    edges: Vec<EdgeRecordV2>,

    /// Files being committed in this batch.
    /// Used to determine which OLD nodes/edges to tombstone.
    changed_files: HashSet<String>,

    /// Tags for the resulting manifest.
    tags: HashMap<String, String>,

    /// Whether this batch is active (between BeginBatch and Commit/Abort).
    active: bool,
}
```

**Key design decision: `BatchState` is NOT in `MultiShardStore`.**

The task description says "BatchState lives in ConnectionState, NOT in GraphEngineV2." This is correct because:

1. Multiple connections can have independent batches in progress
2. A batch is a client-side concept -- the storage engine only sees the final commit
3. Abort is trivial -- just drop the BatchState

**The `commit_batch()` method signature:**

```rust
impl MultiShardStore {
    pub fn commit_batch(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        manifest_store: &mut ManifestStore,
    ) -> Result<CommitDelta> {
        // 1. Compute tombstones for changed_files
        // 2. Apply tombstones
        // 3. Add new nodes/edges
        // 4. Flush all shards
        // 5. Commit manifest with tombstones
        // 6. Compute and return CommitDelta
    }
}
```

### 2.4 File Grouping Logic

When a batch commits with `changed_files = ["src/utils.js", "src/main.js"]`:

1. **Find old nodes for each changed file:**
   ```rust
   for file in changed_files {
       let old_nodes = store.find_nodes(None, Some(file));
       for node in old_nodes {
           tombstone_node_ids.insert(node.id);
       }
   }
   ```

2. **Find old edges owned by tombstoned nodes (bloom-assisted):**
   ```rust
   let tombstoned_ids: HashSet<u128> = tombstone_node_ids.clone();
   for shard in &shards {
       for edge_segment in &shard.edge_segments {
           // Bloom check: does this segment potentially contain edges
           // from any tombstoned node?
           let may_match = tombstoned_ids.iter()
               .any(|id| edge_segment.maybe_contains_src(*id));
           if !may_match { continue; }

           // Scan matching segment
           for i in 0..edge_segment.record_count() {
               let src = edge_segment.get_src(i);
               if tombstoned_ids.contains(&src) {
                   let dst = edge_segment.get_dst(i);
                   let edge_type = edge_segment.get_edge_type(i);
                   tombstone_edge_keys.insert((src, dst, edge_type.to_string()));
               }
           }
       }

       // Also check write buffer
       for edge in shard.write_buffer.iter_edges() {
           if tombstoned_ids.contains(&edge.src) {
               tombstone_edge_keys.insert((edge.src, edge.dst, edge.edge_type.clone()));
           }
       }
   }
   ```

**Complexity:** O(changed_files * nodes_per_file) for node tombstoning. O(edge_segments * bloom_check) for edge tombstoning with bloom pre-filtering. The bloom filter eliminates most segments from scanning.

**This requires adding a new method to `Shard`:**

```rust
/// Find edges with src in the given ID set.
/// Uses bloom filter on each edge segment for pre-filtering.
/// Returns (src, dst, edge_type) keys for tombstoning.
pub fn find_edge_keys_by_src_ids(
    &self,
    src_ids: &HashSet<u128>,
) -> Vec<(u128, u128, String)>
```

And a corresponding method on `MultiShardStore`:

```rust
pub fn find_edge_keys_by_src_ids(
    &self,
    src_ids: &HashSet<u128>,
) -> Vec<(u128, u128, String)>
```

### 2.5 Enrichment File Context

Enrichment data (edges created by enrichment passes like data flow analysis) needs a file context for tombstoning. The convention:

```
__enrichment__/{enricher_name}/{source_file_path}
```

Examples:
- `__enrichment__/data-flow/src/utils.js` -- data flow edges derived from `src/utils.js`
- `__enrichment__/import-resolver/src/main.js` -- import resolution edges from `src/main.js`

When `src/utils.js` is re-analyzed, the batch also includes `__enrichment__/data-flow/src/utils.js` in its `changed_files`. This causes the old enrichment edges to be tombstoned and replaced with fresh ones.

**Implementation:** This is primarily a convention enforced by the caller (the Grafema analysis pipeline), not by the storage engine. The storage engine treats these as regular file paths in the `file` field of `NodeRecordV2`. However, we should:

1. Document the convention in `types.rs`
2. Provide a helper function: `fn enrichment_file_context(enricher: &str, source_file: &str) -> String`

### 2.6 CommitDelta Design

```rust
/// Delta information returned by commit_batch().
/// Describes exactly what changed in this commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDelta {
    /// Files that were changed in this batch.
    pub changed_files: Vec<String>,

    /// Number of nodes added (new, not in previous snapshot).
    pub nodes_added: u64,

    /// Number of nodes removed (tombstoned from previous snapshot).
    pub nodes_removed: u64,

    /// Number of nodes modified (same semantic_id, different content_hash).
    pub nodes_modified: u64,

    /// IDs of removed nodes.
    pub removed_node_ids: Vec<u128>,

    /// Node types that were affected (from both added and removed nodes).
    pub changed_node_types: HashSet<String>,

    /// Edge types that were affected (from both added and tombstoned edges).
    pub changed_edge_types: HashSet<String>,

    /// Manifest version after this commit.
    pub manifest_version: u64,
}
```

**Modified detection (I4):**

A node is "modified" when both old and new versions exist with the same `semantic_id` (and thus same `id`) but different `content_hash`. During `commit_batch()`:

```rust
for new_node in &new_nodes {
    if let Some(old_node) = old_nodes_by_id.get(&new_node.id) {
        if old_node.content_hash != new_node.content_hash && new_node.content_hash != 0 {
            nodes_modified += 1;
        }
    }
}
```

Nodes with `content_hash == 0` are considered "not computed" and skip the modified check.

### 2.7 Manifest Changes

The `Manifest` struct needs two new fields:

```rust
pub struct Manifest {
    // ... existing fields ...

    /// Tombstoned node IDs (logically deleted).
    /// Query path skips records with these IDs.
    /// Cleared when compaction physically removes them from segments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tombstoned_node_ids: Vec<u128>,

    /// Tombstoned edge keys (src, dst, edge_type).
    /// Query path skips matching edges.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tombstoned_edge_keys: Vec<(u128, u128, String)>,
}
```

`Shard` gets a new `TombstoneSet` field, loaded from manifest on open.

### 2.8 Backward Compatibility (Auto-Commit)

When `add_nodes()` / `add_edges()` are called WITHOUT `begin_batch()`, they should still work as before (immediate mutation). Two approaches:

**Option A (preferred): Keep current API unchanged.** `MultiShardStore::add_nodes()` and `add_edges()` remain as-is. `commit_batch()` is a NEW method that handles batch semantics. The caller (connection handler) decides whether to use batch mode or direct mode.

**Option B: Implicit batch.** Every `add_nodes()` starts an implicit batch if none is active, auto-commits on next `flush_all()`. This is more complex and error-prone.

I recommend **Option A** because it preserves the existing API and makes batch vs. non-batch an explicit choice at the connection layer.

### 2.9 Atomic Manifest Swap

The commit protocol for a batch:

1. Compute tombstones (node IDs + edge keys) for changed files
2. Add new nodes to shards via `add_nodes()`
3. Add new edges to shards via `add_edges()`
4. Flush all shards (creates new segments on disk)
5. Build new manifest:
   - Start from current manifest's segments
   - Add new segment descriptors from flush
   - Set `tombstoned_node_ids` = current tombstones UNION new tombstones
   - Set `tombstoned_edge_keys` = current tombstones UNION new tombstones
6. Atomic manifest commit (write manifest file, update index, swap current pointer)
7. Update in-memory tombstone sets on all shards
8. Compute and return CommitDelta

**Atomicity guarantee:** If the process crashes before step 6 completes, the old manifest is still the current one. The new segment files exist on disk but are unreferenced (GC will clean them up). No data corruption.

## 3. Implementation Plan

### Phase 1: Tombstone Infrastructure (~150 LOC, ~8 tests)

**Files modified:** `manifest.rs`, `shard.rs`, `multi_shard.rs`
**New file:** None (TombstoneSet is a simple struct, can live in `shard.rs`)

1. Add `TombstoneSet` struct to `shard.rs`
2. Add `tombstoned_node_ids` and `tombstoned_edge_keys` fields to `Manifest`
3. Add `tombstones` field to `Shard`
4. Load tombstones from manifest on `Shard::open()` / `Shard::open_for_shard()`
5. Modify ALL query methods in `Shard` to check tombstones:
   - `get_node()`: check `tombstones.node_ids.contains(id)`
   - `node_exists()`: check `tombstones.node_ids.contains(id)`
   - `find_nodes()`: filter out tombstoned IDs
   - `get_outgoing_edges()`: filter out tombstoned edge keys
   - `get_incoming_edges()`: filter out tombstoned edge keys
6. Add `add_tombstoned_nodes()` and `add_tombstoned_edges()` to `Shard`
7. Modify `all_node_ids()` to exclude tombstoned IDs
8. Tests: tombstone blocks point lookup, tombstone blocks find_nodes, tombstone blocks edge queries, tombstone persists across open/close, tombstone with empty set is no-op, tombstoned node excluded from all_node_ids, tombstoned edges excluded from outgoing/incoming, multi-shard tombstone propagation

### Phase 2: Bloom-Assisted Edge Tombstoning (~80 LOC, ~5 tests)

**Files modified:** `shard.rs`, `multi_shard.rs`

1. Add `find_edge_keys_by_src_ids()` to `Shard`
   - For each edge segment: check src bloom for any of the IDs
   - If bloom says "maybe": scan the segment for matching src IDs
   - Also scan write buffer
2. Add `find_edge_keys_by_src_ids()` to `MultiShardStore` (fan-out to all shards)
3. Tests: bloom skips irrelevant segments, bloom-assisted finds correct edges, edge keys found across segments and buffer, empty input returns empty, large ID set performance acceptable

### Phase 3: BatchState + CommitBatch (~200 LOC, ~12 tests)

**Files modified:** `multi_shard.rs`
**New types in `types.rs`:** `CommitDelta`, `BatchCommitParams`

1. Define `CommitDelta` struct
2. Define helper: `enrichment_file_context(enricher, source_file) -> String`
3. Implement `commit_batch()` on `MultiShardStore`:
   a. Find old nodes for each changed file
   b. Compute old node IDs -> tombstone set
   c. Find old edge keys via bloom-assisted search -> tombstone set
   d. Add new nodes to shards
   e. Add new edges to shards
   f. Flush all shards
   g. Build manifest with tombstones
   h. Commit manifest atomically
   i. Update in-memory tombstones on all shards
   j. Compute CommitDelta (nodes added/removed/modified, changed types)
4. **Modified detection:** Compare old nodes (by id) with new nodes by content_hash
5. Tests:
   - Basic commit: add file, nodes visible
   - Re-commit same file: old nodes tombstoned, new nodes visible
   - Idempotency: re-analyze same content -> graph unchanged (delta shows 0 added/removed when content_hash matches)
   - Modify 1 function: only that function's node changes
   - Multi-file batch: all files committed atomically
   - Abort: BatchState dropped, no changes applied
   - Edge tombstoning: old edges for tombstoned nodes are removed
   - Cross-shard commit: nodes in different shards all updated
   - CommitDelta accuracy: changedFiles, counts, types all correct
   - changedEdgeTypes from both new AND tombstoned edges
   - Enrichment file context convention
   - Auto-commit without batch (existing add_nodes/add_edges still works)

### Phase 4: Manifest Integration + Persistence (~100 LOC, ~5 tests)

**Files modified:** `manifest.rs`, `multi_shard.rs`

1. Ensure tombstone data roundtrips through manifest serialization
2. Handle tombstone accumulation across multiple commits (union of all tombstones until compaction)
3. Update `ManifestStore::open()` to handle new manifest fields (backward-compatible with `#[serde(default)]`)
4. Update `SnapshotDiff` to include tombstone changes
5. Tests: manifest with tombstones serializes/deserializes, tombstones accumulate across commits, old manifests without tombstone fields load correctly, diff shows tombstone changes

### Phase 5: Validation + Integration (~70 LOC, ~5 tests)

1. **Idempotency test:** Analyze file twice with same content -> CommitDelta shows no changes
2. **Delta correctness:** Modify 1 function -> CommitDelta shows exactly 1 modified node
3. **Atomicity test:** Add 10 nodes in batch -> all appear or none appear
4. **Delta vs DiffSnapshots:** CommitDelta matches `ManifestStore::diff_snapshots(prev, current)` in all counts
5. **changedEdgeTypes completeness:** Edge types from tombstoned edges appear in changedEdgeTypes

## 4. Files Changed Summary

| File | Changes |
|------|---------|
| `storage_v2/types.rs` | Add `CommitDelta` struct, `enrichment_file_context()` helper |
| `storage_v2/manifest.rs` | Add tombstone fields to `Manifest`, update serialization |
| `storage_v2/shard.rs` | Add `TombstoneSet`, tombstone checks in all queries, `find_edge_keys_by_src_ids()` |
| `storage_v2/multi_shard.rs` | Add `commit_batch()`, `find_edge_keys_by_src_ids()` fan-out |
| `storage_v2/write_buffer.rs` | No changes (tombstones don't apply to write buffer) |
| `storage_v2/mod.rs` | Re-export new types |
| `storage_v2/segment.rs` | No changes (segments are immutable) |

**Estimated total: ~600 LOC, ~35 tests** (matches task estimate)

## 5. Risk Areas

### R1: Tombstone Set Size (LOW)
Tombstones accumulate until compaction. For a database with 1M nodes where 10% are re-analyzed per commit, each commit adds ~100K tombstone IDs. After 10 commits without compaction: ~1M tombstone IDs = 16MB in manifest JSON.

**Mitigation:** (a) The manifest uses `#[serde(default, skip_serializing_if = "Vec::is_empty")]` so empty tombstone sets add zero overhead. (b) Compaction (future T4.x) will clear tombstones. (c) If needed, we can switch to binary encoding for tombstone IDs in manifest.

### R2: Edge Tombstoning Correctness (MEDIUM)
Edge keys are `(src, dst, edge_type)`. If we only tombstone by src, we might miss edges where the dst node was also tombstoned but the src was not. However, edge tombstoning is triggered by src node tombstoning (edges owned by the source node's shard). Cross-shard edges where the dst is tombstoned but src is not -- these edges should remain (the edge itself is still valid from the src's perspective).

**Decision:** Edge tombstoning is src-based only. This matches the edge ownership model (edges are stored in the source node's shard).

### R3: Serde Backward Compatibility (LOW)
Adding new fields to `Manifest` with `#[serde(default)]` is backward-compatible. Old manifests without tombstone fields will deserialize with empty Vecs. Already proven pattern in existing codebase.

### R4: Content Hash Zero (LOW)
Nodes with `content_hash == 0` mean "not computed." If old node has hash=0 and new node also has hash=0, we cannot detect modification. This is explicitly called out in the task as "I4" and is acceptable for now.

### R5: Enrichment File Context Coordination (LOW)
The enrichment file context convention (`__enrichment__/{enricher}/{file}`) requires the Grafema analysis pipeline to use this convention. This is documentation + convention, not enforced by the storage engine. Risk is misconfigured pipelines not tombstoning enrichment data correctly.

## 6. Prior Art References

- [Delta Lake Deletion Vectors](https://delta.io/blog/2023-07-05-deletion-vectors/) -- Lightweight soft-delete markers stored alongside manifests, avoiding full segment rewrites. Directly inspired our HashSet-based tombstone approach.
- [SQLite Atomic Commit](https://sqlite.org/atomiccommit.html) -- Two-phase commit with journal-based rollback. Our manifest-swap approach is simpler (no WAL needed) because segments are immutable.
- [LSM-Tree Tombstone Design](https://www.freecodecamp.org/news/build-an-lsm-tree-storage-engine-from-scratch-handbook/) -- Standard tombstone-then-compact pattern. Our approach skips the "write tombstone markers to segments" step and goes directly to manifest-level tracking.
- [CockroachDB Parallel Commits](https://www.cockroachlabs.com/blog/parallel-commits/) -- Staging changes near original values, then switching atomically. Similar to our batch pattern where we stage nodes/edges, then commit manifest atomically.
- [Bloom Filter for Targeted Deletion](https://en.wikipedia.org/wiki/Bloom_filter) -- Using probabilistic data structures to avoid scanning irrelevant data. Our src bloom filter on edge segments directly enables O(edge_segments * bloom_check) complexity for edge tombstoning.

## 7. What This Does NOT Cover

- **Compaction** (T4.x): Physically removing tombstoned records from segments by rewriting them. Tombstones accumulate until compaction runs.
- **Wire protocol integration** (T4.1): BeginBatch/CommitBatch/AbortBatch wire protocol commands. This task builds the storage-layer API; the wire protocol wraps it.
- **Concurrent batches**: Multiple connections can have independent BatchStates, but `commit_batch()` on MultiShardStore takes `&mut self`, so commits are serialized. This is acceptable for single-writer architecture.
- **Partial batch commit**: If a batch includes 10 files and 5 succeed, we commit all or nothing. No partial commit support.
