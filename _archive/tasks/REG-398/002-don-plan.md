# Don Melton Plan: REG-398 Phase 1 -- ID Hash Index for RFDB

## 1. Codebase Analysis

### Current State

GraphEngine uses a **delta-log + mmap columnar segment** architecture. When a node is looked up by ID, the hot path is:

1. Check `delta_nodes: HashMap<u128, NodeRecord>` -- O(1)
2. Check `deleted_segment_ids: HashSet<u128>` -- O(1)
3. Call `segment.find_index(id)` -- **O(n) linear scan over all u128 IDs in the mmap segment**
4. Reconstruct `NodeRecord` from columnar data at the found index

`NodesSegment::find_index()` (segment.rs:249-256) is a brute-force linear scan:

```rust
pub fn find_index(&self, id: u128) -> Option<usize> {
    for idx in 0..self.node_count {
        if self.get_id(idx) == Some(id) {
            return Some(idx);
        }
    }
    None
}
```

This is called from **4 sites** in `engine.rs`:
- `get_node_internal()` (line 342) -- the primary get_node path
- `get_node_strings()` (line 505) -- file_path + name lookup
- `get_node_strings_with_metadata()` (line 531) -- file_path + name + metadata lookup
- `get_node_identifier()` (line 663) -- readable TYPE:name@file identifier

Each call is O(n) where n = total nodes in segment. For a 100K-node graph, that is 100K u128 comparisons per lookup. For 1M nodes, 1M comparisons. This is called thousands of times per session.

### Existing Pattern: Adjacency Lists

The codebase already has the exact pattern we need. `adjacency` and `reverse_adjacency` are `HashMap<u128, Vec<usize>>` built from mmap data on `open()` and `flush()`:

**open()** (engine.rs:231-246):
```rust
let mut adjacency = HashMap::new();
let mut reverse_adjacency = HashMap::new();
if let Some(ref edges_seg) = edges_segment {
    for idx in 0..edges_seg.edge_count() {
        if edges_seg.is_deleted(idx) { continue; }
        if let Some(src) = edges_seg.get_src(idx) {
            adjacency.entry(src).or_insert_with(Vec::new).push(idx);
        }
        // ... reverse_adjacency ...
    }
}
```

**flush()** (engine.rs:1035-1050): Identical rebuild after rewriting segments.

An ID index follows this exact same lifecycle: build in a single pass over segment IDs, use for O(1) lookups, rebuild when segment changes.

### Dead Code: sled FileIndex

`packages/rfdb-server/src/index/mod.rs` contains a `FileIndex` struct backed by sled. It is:
- Declared as a public module in `lib.rs`
- Listed as a dependency in `Cargo.toml`
- **Never imported or used anywhere in the actual query/write path**

This is dead code that adds a ~2MB dependency (sled) for nothing. Phase 2 will remove it, but Phase 1 should NOT touch it to keep scope tight.

### Thread Safety

GraphEngine is wrapped in `RwLock<GraphEngine>` inside `Database` (database_manager.rs:90):
```rust
pub engine: RwLock<GraphEngine>,
```

All mutation (`&mut self`) goes through write locks. All reads (`&self`) through read locks. The index will be a field on GraphEngine itself, so it inherits the same locking guarantees. No additional synchronization needed.

## 2. Approach Validation

The Linear issue proposes an `IndexSet` struct with `id_index: HashMap<u128, usize>`. After analyzing the code, I validate this approach with the following refinements:

### Where to put IndexSet

The issue suggests `storage/mod.rs`. I disagree. The index is a runtime concern of `GraphEngine`, not a storage/serialization concern. The index should live in the `graph` module, co-located with the engine that owns and rebuilds it.

**Recommendation:** New file `packages/rfdb-server/src/graph/index_set.rs` with the `IndexSet` struct. This mirrors how `traversal.rs` is already a separate file in `graph/`.

### Why NOT put all three indexes in Phase 1

The user asked whether to combine id_index, type_index, and file_index in one PR. The answer is **no**, for these reasons:

1. **id_index is mechanically different.** It maps u128 -> usize (1:1). Type and file indexes map String -> Vec<usize> (1:many). Different data structures, different rebuild logic, different query integration.

2. **id_index has a clean, testable impact.** Every `segment.find_index(id)` call becomes an index lookup. The change is purely internal -- no API changes, no new query patterns. Type/file indexes change how `find_by_attr()` works, which is a bigger behavioral change.

3. **Risk isolation.** If id_index has a bug (stale index after delete, off-by-one), it breaks node lookups. If type_index has a bug, it breaks queries. Different failure modes that should be tested independently.

4. **The IndexSet struct IS designed for extension.** Creating IndexSet with only `id_index` in Phase 1 and adding `type_index`/`file_index` in Phase 2 is trivially extensible -- just add fields and extend the `rebuild()` method.

## 3. Detailed Plan

### Step 1: Create IndexSet struct

New file: `packages/rfdb-server/src/graph/index_set.rs`

```rust
use std::collections::HashMap;

/// In-memory secondary indexes over segment data.
/// Rebuilt from scratch on open() and flush() -- not persisted to disk.
/// Analogous to adjacency/reverse_adjacency lists.
pub struct IndexSet {
    /// Node ID -> segment index. O(1) lookup replacing O(n) linear scan.
    id_index: HashMap<u128, usize>,
}

impl IndexSet {
    pub fn new() -> Self {
        Self { id_index: HashMap::new() }
    }

    /// Rebuild all indexes from segment data in a single pass.
    /// Called from GraphEngine::open() and GraphEngine::flush().
    pub fn rebuild_from_segment(&mut self, segment: &NodesSegment) {
        self.id_index.clear();
        self.id_index.reserve(segment.node_count());
        for idx in 0..segment.node_count() {
            if let Some(id) = segment.get_id(idx) {
                // Do NOT skip deleted nodes -- find_index doesn't skip them either.
                // The caller (get_node_internal) checks is_deleted() separately.
                self.id_index.insert(id, idx);
            }
        }
    }

    /// Clear all indexes (called on GraphEngine::clear())
    pub fn clear(&mut self) {
        self.id_index.clear();
    }

    /// Look up segment index for a node ID. O(1).
    pub fn find_node_index(&self, id: u128) -> Option<usize> {
        self.id_index.get(&id).copied()
    }
}
```

### Step 2: Integrate IndexSet into GraphEngine

Add `index_set: IndexSet` field to `GraphEngine` struct.

**Initialization points:**
- `create()` / `create_ephemeral()`: `index_set: IndexSet::new()` (empty, no segment)
- `open()`: After loading segments, call `index_set.rebuild_from_segment(&nodes_segment)` in the same block where adjacency lists are built
- `flush()`: After reopening segments (line 1032-1033), call `index_set.rebuild_from_segment(&nodes_segment)`
- `clear()`: Call `index_set.clear()`

### Step 3: Replace find_index calls

Replace all 4 call sites of `segment.find_index(id)` with `self.index_set.find_node_index(id)`:

1. **get_node_internal()** (line 342): `segment.find_index(id)` -> `self.index_set.find_node_index(id)`
2. **get_node_strings()** (line 505): Same replacement
3. **get_node_strings_with_metadata()** (line 531): Same replacement
4. **get_node_identifier()** (line 663): Same replacement

### Step 4: Deprecate segment.find_index()

After all call sites are migrated, mark `NodesSegment::find_index()` as `#[deprecated]` or remove it. Removing is preferred since it eliminates the temptation to use O(n) lookups.

### Step 5: Update mod.rs

Add `pub mod index_set;` to `packages/rfdb-server/src/graph/mod.rs`.

## 4. Edge Cases and Risks

### Deleted nodes in segment

`find_index()` does NOT check the deleted flag -- it returns the index for any node, deleted or not. The caller then checks `segment.is_deleted(idx)`. The id_index must follow the same contract: **index ALL nodes including deleted ones.** The caller decides whether to reject deleted nodes.

This is correct because:
- `get_node_internal()` checks `is_deleted()` after `find_index()` (line 343)
- `deleted_segment_ids` is checked BEFORE the segment lookup (line 336-338)
- Excluding deleted nodes from the index would mean `find_index` returning None for a deleted node, which could cause subtle bugs in code paths that need to know the node existed

### Delta vs segment interaction

Delta nodes (`delta_nodes: HashMap<u128, NodeRecord>`) are always checked FIRST, BEFORE segment lookup. This means:
- If a node is in delta, the index is never consulted -- correct
- If a node was deleted from delta, `deleted_segment_ids` catches it before index lookup -- correct
- After flush, all delta nodes merge into the new segment, and the index is rebuilt -- correct

The index ONLY covers the segment. Delta has its own HashMap. This is the same pattern as adjacency lists.

### Memory overhead

`HashMap<u128, usize>`:
- Per entry: 16 bytes (u128 key) + 8 bytes (usize value) + ~24 bytes HashMap overhead = ~48 bytes
- 100K nodes: ~4.8 MB
- 1M nodes: ~48 MB

This is comparable to existing adjacency lists. The Linear issue estimates ~2.4 MB for 100K nodes and ~24 MB for 1M nodes, which is the theoretical minimum. Real HashMap overhead is ~2x, so my estimate is more realistic. Still acceptable.

### Rebuild cost

Single pass over `node_count` u128 IDs via mmap. Each iteration: read 16 bytes from mmap + insert into HashMap. For 100K nodes, this is sub-millisecond. For 1M nodes, ~5-10ms. Negligible compared to flush (which rewrites all segment files).

### Ephemeral databases

Ephemeral databases never have segments (no nodes_segment), so the index stays empty. All lookups go through delta_nodes HashMap. No change in behavior.

### Duplicate IDs

If the segment contains duplicate IDs (which should not happen but could due to bugs), the HashMap would keep the last one written. The current `find_index()` returns the first one found. This is a theoretical concern -- if duplicates exist, both approaches are "wrong," but the HashMap approach is at least deterministic (last write wins). The flush() code already has duplicate detection logging (line 956).

## 5. Scope Boundaries

### IN Phase 1
- IndexSet struct with id_index
- Integration in open(), flush(), clear(), create(), create_ephemeral()
- Replace all 4 find_index() call sites
- Remove or deprecate find_index() from NodesSegment
- Unit tests for IndexSet (rebuild, lookup, clear, deleted nodes, empty segment)
- Integration tests (flush + reopen with index, ephemeral, delta priority)

### NOT in Phase 1
- type_index, file_index (Phase 2)
- Removing sled dependency / FileIndex dead code (Phase 2)
- Changes to find_by_attr() query path (Phase 2)
- Any schema changes (Phase 3+)
- Benchmarks (nice-to-have, not blocking -- the improvement is obvious from O(n)->O(1))

## 6. Testing Strategy

1. **Unit tests for IndexSet:**
   - `rebuild_from_segment` with non-empty segment builds correct mapping
   - `find_node_index` returns correct index for existing IDs
   - `find_node_index` returns None for non-existent IDs
   - `clear` empties the index
   - Deleted nodes in segment ARE indexed (caller decides)

2. **Integration tests (existing pattern -- use ephemeral or tempdir):**
   - Create graph, add nodes, flush, verify `get_node()` works via index
   - Create graph, add nodes, flush, reopen, verify `get_node()` works via index
   - Add nodes to delta + segment, verify delta takes priority
   - Delete a segment node, verify it returns None
   - Verify `get_node_strings()` and `get_node_identifier()` work after flush

3. **Existing tests must pass unchanged.** The change is an internal optimization with identical external behavior. All existing engine tests, reachability tests, find_by_attr tests, and ephemeral tests must pass without modification.

## 7. Implementation Estimate

- IndexSet struct + tests: ~1 hour
- GraphEngine integration (5 touch points): ~30 minutes
- Replace find_index calls (4 sites): ~15 minutes
- Run existing tests, fix any issues: ~15 minutes

**Total: ~2 hours.** This is a small, surgical change.

## 8. Prior Art

The approach of in-memory hash indexes rebuilt from mmap segments on open/flush is standard practice:
- **SQLite WAL mode**: Builds hash index over WAL frames for O(1) page lookup
- **RocksDB**: Maintains block cache indexes rebuilt from SSTable metadata
- **IndraDB** (Rust graph database): Uses sled internally but the principle of in-memory indexes over persisted data is the same
- **LMDB**: B-tree indexes are persisted, but our data volume makes in-memory rebuild cheap enough that persistence adds complexity without benefit (as the Linear issue correctly notes: ~50ms rebuild for 100K nodes)

The key insight from the Linear issue is correct: **rebuild is cheap, persistence is unnecessary complexity.**
