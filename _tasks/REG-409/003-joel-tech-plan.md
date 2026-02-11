# Joel Spolsky Tech Plan: REG-409 Duplicate Edges in RFDB

## Summary

Fix duplicate edge storage in `GraphEngine` by adding an `edge_keys: HashSet<(u128, u128, String)>` field that enforces the uniqueness invariant: *at most one edge per (src, dst, edge_type) triple*. Changes are confined to a single file: `packages/rfdb-server/src/graph/engine.rs`.

## File Under Change

**`/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/graph/engine.rs`**

All line references are relative to the current state of this file.

---

## Change 1: Add `edge_keys` Field to `GraphEngine` Struct

**Location:** Lines 92-132 (struct definition)

Add a new field after `deleted_segment_ids` (line 124):

```rust
// line 124: deleted_segment_ids: HashSet<u128>,
// ADD after:

/// Tracks existing edge keys (src, dst, edge_type) for O(1) deduplication.
/// Maintained across all code paths: add, delete, flush, clear, open.
edge_keys: HashSet<(u128, u128, String)>,
```

The key type `(u128, u128, String)` matches the deduplication key used in `get_all_edges()` (line 1378) and `count_edges_by_type()` (line 1486). The `String` component is `edge_type.clone().unwrap_or_default()` -- empty string for edges with no type.

---

## Change 2: Initialize `edge_keys` in `create()`

**Location:** Lines 136-159 (`create()` method)

Add to the `Self { ... }` initializer block, after `deleted_segment_ids: HashSet::new(),` (line 155):

```rust
edge_keys: HashSet::new(),
```

---

## Change 3: Initialize `edge_keys` in `create_ephemeral()`

**Location:** Lines 175-202 (`create_ephemeral()` method)

Add to the `Self { ... }` initializer block, after `deleted_segment_ids: HashSet::new(),` (line 199):

```rust
edge_keys: HashSet::new(),
```

---

## Change 4: Populate `edge_keys` in `open()`

**Location:** Lines 210-293 (`open()` method)

The `open()` method loads segments and builds adjacency lists. It does NOT replay a delta log -- the `delta_log` starts empty (`DeltaLog::new()` at line 281). Therefore, `edge_keys` only needs to be populated from the edges segment.

**After** the adjacency list building loop (lines 246-258), add edge_keys population. The adjacency loop already iterates over all non-deleted segment edges, so we extend it:

Replace lines 246-258:

```rust
// Build adjacency, reverse_adjacency, and edge_keys from segments
let mut adjacency = HashMap::new();
let mut reverse_adjacency = HashMap::new();
let mut edge_keys = HashSet::new();
if let Some(ref edges_seg) = edges_segment {
    for idx in 0..edges_seg.edge_count() {
        if edges_seg.is_deleted(idx) {
            continue;
        }
        if let (Some(src), Some(dst)) = (edges_seg.get_src(idx), edges_seg.get_dst(idx)) {
            adjacency.entry(src).or_insert_with(Vec::new).push(idx);
            reverse_adjacency.entry(dst).or_insert_with(Vec::new).push(idx);

            let edge_type_key = edges_seg.get_edge_type(idx)
                .unwrap_or("")
                .to_string();
            edge_keys.insert((src, dst, edge_type_key));
        }
    }
}
```

Note: We must destructure differently because `get_src` and `get_dst` are checked together, and we need both to build the key. The original code checked `get_src` and `get_dst` independently -- we combine into a single `if let` matching both (already done in the original adjacency code for src/dst separately, but here we match both to get their values).

Then in the `Self { ... }` block at line 277, add:

```rust
edge_keys,
```

---

## Change 5: Deduplicate in `add_edges()`

**Location:** Lines 972-993 (`add_edges()` method)

Add an edge_keys check after node validation, before writing to delta_log:

```rust
fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool) {
    let mut added = 0;
    for edge in edges {
        // Validation: check both nodes exist (unless disabled)
        if !skip_validation {
            if !self.node_exists(edge.src) {
                tracing::warn!("Edge src node not found: {}", edge.src);
                continue;
            }
            if !self.node_exists(edge.dst) {
                tracing::warn!("Edge dst node not found: {}", edge.dst);
                continue;
            }
        }

        // Deduplication: skip if edge with same (src, dst, type) already exists
        let edge_key = (edge.src, edge.dst, edge.edge_type.clone().unwrap_or_default());
        if !self.edge_keys.insert(edge_key) {
            // insert() returns false if value was already present
            continue;
        }

        self.delta_log.push(Delta::AddEdge(edge.clone()));
        self.apply_delta(&Delta::AddEdge(edge));
        added += 1;
    }
    self.ops_since_flush += added;
    self.maybe_auto_flush();
}
```

**Key design decision:** The dedup check is in `add_edges()`, NOT in `apply_delta()`. Rationale:

- `apply_delta()` is a low-level method that mutates in-memory state. It is called from `add_edges()` for live operations.
- There is no delta log replay path in `open()` -- the `open()` method starts with an empty `delta_log` (line 281).
- If delta replay were ever added, `edge_keys` would be populated from the segment in `open()` BEFORE replay, so duplicates from the log would be caught naturally by the `edge_keys.insert()` check in `add_edges()`.
- Keeping `apply_delta()` unconditional avoids any risk of breaking replay semantics (the delta log is append-only; if it says AddEdge, the intent was to add).

**Metadata policy:** When a duplicate is detected, the **first** edge wins (the one already in the graph). This is correct because:
1. Segment edges (from previous flush) take priority over re-added delta edges
2. Within a single session, the first add wins
3. Enrichers that need to update metadata should use delete+add pattern

---

## Change 6: Update `delete_edge` to Remove from `edge_keys`

**Location:** Lines 995-999 (`delete_edge()` method)

Currently:
```rust
fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
    let delta = Delta::DeleteEdge { src, dst, edge_type: edge_type.to_string() };
    self.delta_log.push(delta.clone());
    self.apply_delta(&delta);
}
```

Add edge_keys removal:

```rust
fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
    let delta = Delta::DeleteEdge { src, dst, edge_type: edge_type.to_string() };
    self.delta_log.push(delta.clone());
    self.apply_delta(&delta);

    // Remove from edge_keys so the same edge can be re-added later
    self.edge_keys.remove(&(src, dst, edge_type.to_string()));
}
```

Without this, a deleted edge could never be re-added in the same session.

---

## Change 7: Deduplicate in `flush()`

**Location:** Lines 1122-1153 (edge collection in `flush()`)

Replace the naive `Vec` collection with `HashMap` dedup, matching the pattern from `get_all_edges()` (lines 1370-1415):

```rust
// Collect all edges with deduplication (same pattern as get_all_edges)
let mut edges_map: HashMap<(u128, u128, String), EdgeRecord> = HashMap::new();

// Delta edges first (more recent, take priority over segment)
for edge in &self.delta_edges {
    if !edge.deleted {
        let edge_type_key = edge.edge_type.clone().unwrap_or_default();
        let key = (edge.src, edge.dst, edge_type_key);
        edges_map.insert(key, edge.clone());
    }
}

// From segment (don't overwrite delta -- delta is more recent)
if let Some(ref segment) = self.edges_segment {
    for idx in 0..segment.edge_count() {
        if !segment.is_deleted(idx) {
            if let (Some(src), Some(dst)) = (
                segment.get_src(idx),
                segment.get_dst(idx),
            ) {
                let edge_type = segment.get_edge_type(idx);
                let edge_type_key = edge_type.unwrap_or("").to_string();
                let key = (src, dst, edge_type_key.clone());

                // Don't overwrite delta edges (they are more recent)
                if !edges_map.contains_key(&key) {
                    let metadata = segment.get_metadata(idx).map(|s| s.to_string());
                    edges_map.insert(key, EdgeRecord {
                        src,
                        dst,
                        edge_type: if edge_type_key.is_empty() { None } else { Some(edge_type_key) },
                        version: "main".to_string(),
                        metadata,
                        deleted: false,
                    });
                }
            }
        }
    }
}

let all_edges: Vec<EdgeRecord> = edges_map.into_values().collect();
```

**Delta-first ordering matters:** Delta edges are inserted first, segment edges only fill gaps. This matches `get_all_edges()` behavior and ensures that if metadata differs between segment and delta versions of the same edge, the delta (more recent) metadata wins.

---

## Change 8: Rebuild `edge_keys` After Flush

**Location:** Lines 1181-1212 (post-flush cleanup and rebuild section)

After `self.delta_edges.clear();` (line 1184), add `edge_keys` clearing. Then after the adjacency rebuild loop (lines 1198-1212), rebuild `edge_keys` from the freshly-written segment:

After line 1185 (`self.deleted_segment_ids.clear();`), add:

```rust
self.edge_keys.clear();
```

Then extend the adjacency rebuild loop (lines 1200-1212) to also populate `edge_keys`:

```rust
// Rebuild adjacency, reverse_adjacency, and edge_keys
self.adjacency.clear();
self.reverse_adjacency.clear();
// edge_keys already cleared above
if let Some(ref edges_seg) = self.edges_segment {
    for idx in 0..edges_seg.edge_count() {
        if edges_seg.is_deleted(idx) {
            continue;
        }
        if let (Some(src), Some(dst)) = (edges_seg.get_src(idx), edges_seg.get_dst(idx)) {
            self.adjacency.entry(src).or_insert_with(Vec::new).push(idx);
            self.reverse_adjacency.entry(dst).or_insert_with(Vec::new).push(idx);

            let edge_type_key = edges_seg.get_edge_type(idx)
                .unwrap_or("")
                .to_string();
            self.edge_keys.insert((src, dst, edge_type_key));
        }
    }
}
```

Note: the adjacency rebuild already iterates over all segment edges, so we piggyback `edge_keys` population onto the same loop. No extra iteration.

---

## Change 9: Clear `edge_keys` in `clear()`

**Location:** Lines 390-403 (`clear()` method)

Add `self.edge_keys.clear();` after `self.reverse_adjacency.clear();` (line 395):

```rust
pub fn clear(&mut self) {
    self.delta_log.clear();
    self.delta_nodes.clear();
    self.delta_edges.clear();
    self.adjacency.clear();
    self.reverse_adjacency.clear();
    self.edge_keys.clear();      // <-- ADD
    self.nodes_segment = None;
    self.edges_segment = None;
    self.metadata = GraphMetadata::default();
    self.ops_since_flush = 0;
    self.deleted_segment_ids.clear();
    self.index_set.clear();
    tracing::info!("Graph cleared");
}
```

---

## Change 10: Clear `edge_keys` in `delete_version()`

**Location:** Lines 442-453 (`delete_version()` method)

Currently, `delete_version()` marks all edges with a matching version as deleted. When edges are soft-deleted, they should be removed from `edge_keys` so they can be re-added later.

After the edge deletion loop (lines 449-453), add:

```rust
// Remove deleted edges from edge_keys
for edge in &self.delta_edges {
    if edge.deleted && edge.version == version {
        let key = (edge.src, edge.dst, edge.edge_type.clone().unwrap_or_default());
        self.edge_keys.remove(&key);
    }
}
```

---

## NOT Changed: `get_outgoing_edges()` and `get_incoming_edges()`

**Decision:** These methods do NOT need dedup changes.

Once `add_edges()` prevents duplicates in delta, and `flush()` deduplicates on disk, the read paths (`get_outgoing_edges` at lines 1238-1300, `get_incoming_edges` at lines 1305-1366) will naturally return unique edges because:

1. **Delta** contains no duplicates (guarded by `edge_keys` in `add_edges()`)
2. **Segment** contains no duplicates (deduped during `flush()`)
3. **Segment + delta overlap** is the only remaining risk, but:
   - After a `flush()`, delta is empty, so no overlap
   - Before a `flush()`, segment edges from the previous flush cannot be duplicated in delta because `edge_keys` covers both segment and delta

Therefore, the read paths are inherently dedup-safe once the write paths are fixed. No changes needed.

---

## NOT Changed: `get_all_edges()` and `count_edges_by_type()`

These methods already have correct deduplication (lines 1370-1415 and 1484-1550). No changes needed.

---

## NOT Changed: `apply_delta()`

**Decision:** `apply_delta()` (lines 296-346) remains unconditional.

The dedup check lives in `add_edges()` which is the only public entry point for adding edges. `apply_delta` is a private method called from `add_edges()` after the dedup check passes. Keeping `apply_delta` simple and unconditional avoids splitting the dedup logic across two methods.

---

## NOT Changed: `edge_count()`

**Current:** `edge_count()` (lines 1232-1234) returns `segment_count + delta_count`. This is a raw count of records, not unique edges.

After the fix, `delta_edges` will never contain duplicates of segment edges (blocked by `edge_keys`), so `edge_count()` will return the correct count without changes. However, note that `edge_count()` already has a known imprecision: it counts deleted edges. This is a pre-existing issue, not related to REG-409.

---

## NOT Changed: `neighbors()`

`neighbors()` (lines 1001-1035) iterates segment (via adjacency) and delta separately. Same argument as `get_outgoing_edges()` -- once write paths prevent duplicates, read paths are safe.

---

## No `clear_edges()` or `clear_edges_for_file()` Methods

Confirmed: No such methods exist in the codebase. The only edge removal operations are:
- `delete_edge()` (single edge by src/dst/type) -- updated in Change 6
- `delete_version()` (bulk soft-delete by version) -- updated in Change 10
- `clear()` (wipe everything) -- updated in Change 9

---

## Big-O Analysis

### Memory Cost of `edge_keys`

Each entry is `(u128, u128, String)`:
- Two `u128` values: 32 bytes
- One `String`: 24 bytes (pointer + len + capacity) + string data (avg ~15 chars for edge types like "PASSES_ARGUMENT")
- `HashSet` overhead: ~40-60 bytes per bucket (pointer, hash, tombstone flags)

**Per edge:** ~80-120 bytes overhead.

**For Grafema's scale:**
- ~12,000 edges (current Grafema codebase): ~1.4 MB
- ~100,000 edges (large project): ~12 MB
- ~1,000,000 edges (massive legacy codebase): ~120 MB

This is acceptable. The adjacency lists (`HashMap<u128, Vec<usize>>`) already consume similar memory per edge.

### Time Complexity

| Operation | Before | After | Delta |
|-----------|--------|-------|-------|
| `add_edges()` per edge | O(1) amortized | O(1) amortized (HashSet insert) | +O(1) |
| `flush()` edge collection | O(S + D) | O(S + D) with HashMap | Same big-O, constant factor ~2x for HashMap vs Vec |
| `open()` edge loading | O(S) | O(S) + HashSet inserts | +O(S) constant factor |
| `clear()` | O(1) | O(1) + HashSet clear | Negligible |
| `delete_edge()` | O(D) | O(D) + O(1) HashSet remove | +O(1) |
| `get_outgoing_edges()` | O(degree) | O(degree) unchanged | None |
| `get_incoming_edges()` | O(degree) | O(degree) unchanged | None |
| `get_all_edges()` | O(S + D) | O(S + D) unchanged | None |

Where S = segment edge count, D = delta edge count.

**Net impact:** Negligible. The HashSet operations are O(1) amortized. The `flush()` change replaces a Vec with a HashMap, which is slightly slower per insertion but was already O(S + D). The `open()` change piggybacks on an existing O(S) loop.

---

## Test Plan

All new tests go in the existing `#[cfg(test)] mod tests` block at line 1553 of `engine.rs`. Use the existing helpers: `make_test_node()` (line 1675) and `make_test_edge()` (line 1692).

### Test 1: `test_add_edges_dedup_same_session`

Add the same edge (src=1, dst=2, type="CALLS") twice in the same session. Assert `get_all_edges().len() == 1`. Verifies in-memory dedup via `edge_keys`.

```rust
#[test]
fn test_add_edges_dedup_same_session() {
    let mut engine = GraphEngine::create_ephemeral().unwrap();

    engine.add_nodes(vec![
        make_test_node(1, "A", "FUNCTION"),
        make_test_node(2, "B", "FUNCTION"),
    ]);

    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);

    assert_eq!(engine.get_all_edges().len(), 1);
    assert_eq!(engine.get_outgoing_edges(1, None).len(), 1);
}
```

### Test 2: `test_flush_dedup_segment_plus_delta`

Add edge, flush (goes to segment), add same edge again (goes to delta), flush again. Assert only 1 edge on disk. Verifies `flush()` dedup.

```rust
#[test]
fn test_flush_dedup_segment_plus_delta() {
    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test");

    let mut engine = GraphEngine::create(&db_path).unwrap();

    engine.add_nodes(vec![
        make_test_node(1, "A", "FUNCTION"),
        make_test_node(2, "B", "FUNCTION"),
    ]);

    // Add edge and flush to segment
    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    engine.flush().unwrap();
    assert_eq!(engine.get_all_edges().len(), 1);

    // Add same edge again -- should be blocked by edge_keys
    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    assert_eq!(engine.get_all_edges().len(), 1);

    // Flush again -- still 1 edge
    engine.flush().unwrap();
    assert_eq!(engine.get_all_edges().len(), 1);
}
```

### Test 3: `test_dedup_survives_reopen`

Create graph, add edges with duplicates, flush, close, reopen. Assert count is correct. Also add edges after reopen to verify `edge_keys` was populated from segment.

```rust
#[test]
fn test_dedup_survives_reopen() {
    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test");

    {
        let mut engine = GraphEngine::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_test_node(1, "A", "FUNCTION"),
            make_test_node(2, "B", "FUNCTION"),
        ]);
        engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
        engine.flush().unwrap();
    }

    {
        let mut engine = GraphEngine::open(&db_path).unwrap();
        assert_eq!(engine.get_all_edges().len(), 1);

        // Try adding the same edge -- should be blocked
        engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
        assert_eq!(engine.get_all_edges().len(), 1);
    }
}
```

### Test 4: `test_different_edge_types_not_deduped`

Add edges with same src/dst but different types. All should be kept.

```rust
#[test]
fn test_different_edge_types_not_deduped() {
    let mut engine = GraphEngine::create_ephemeral().unwrap();

    engine.add_nodes(vec![
        make_test_node(1, "A", "FUNCTION"),
        make_test_node(2, "B", "FUNCTION"),
    ]);

    engine.add_edges(vec![
        make_test_edge(1, 2, "CALLS"),
        make_test_edge(1, 2, "IMPORTS"),
        make_test_edge(1, 2, "CONTAINS"),
    ], false);

    assert_eq!(engine.get_all_edges().len(), 3);
}
```

### Test 5: `test_delete_then_readd_edge`

Add edge, delete it, add it again. Should succeed (edge_keys must be cleared on delete).

```rust
#[test]
fn test_delete_then_readd_edge() {
    let mut engine = GraphEngine::create_ephemeral().unwrap();

    engine.add_nodes(vec![
        make_test_node(1, "A", "FUNCTION"),
        make_test_node(2, "B", "FUNCTION"),
    ]);

    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    assert_eq!(engine.get_all_edges().len(), 1);

    engine.delete_edge(1, 2, "CALLS");
    assert_eq!(engine.get_all_edges().len(), 0);

    // Re-add should work
    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    assert_eq!(engine.get_all_edges().len(), 1);
}
```

### Test 6: `test_clear_resets_edge_keys`

Add edges, clear, add same edges. All should succeed.

```rust
#[test]
fn test_clear_resets_edge_keys() {
    let mut engine = GraphEngine::create_ephemeral().unwrap();

    engine.add_nodes(vec![
        make_test_node(1, "A", "FUNCTION"),
        make_test_node(2, "B", "FUNCTION"),
    ]);

    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    assert_eq!(engine.get_all_edges().len(), 1);

    engine.clear();

    // Re-add nodes and edges after clear
    engine.add_nodes(vec![
        make_test_node(1, "A", "FUNCTION"),
        make_test_node(2, "B", "FUNCTION"),
    ]);
    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    assert_eq!(engine.get_all_edges().len(), 1);
}
```

### Test 7: `test_get_outgoing_edges_no_duplicates_after_flush`

Add edge, flush, verify `get_outgoing_edges` returns exactly 1 edge. This is a regression test for the original bug where segment + delta would both return the same edge.

```rust
#[test]
fn test_get_outgoing_edges_no_duplicates_after_flush() {
    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test");

    let mut engine = GraphEngine::create(&db_path).unwrap();

    engine.add_nodes(vec![
        make_test_node(1, "A", "FUNCTION"),
        make_test_node(2, "B", "FUNCTION"),
    ]);

    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);
    engine.flush().unwrap();

    // After flush, edge is in segment. Adding same edge should be blocked.
    engine.add_edges(vec![make_test_edge(1, 2, "CALLS")], false);

    // Both should return exactly 1
    assert_eq!(engine.get_outgoing_edges(1, None).len(), 1);
    assert_eq!(engine.get_incoming_edges(2, None).len(), 1);
}
```

---

## Implementation Order

1. Add `edge_keys` field to struct (Change 1)
2. Initialize in `create()` and `create_ephemeral()` (Changes 2, 3)
3. Populate in `open()` (Change 4)
4. Dedup in `add_edges()` (Change 5)
5. Remove from `edge_keys` in `delete_edge()` (Change 6)
6. Dedup in `flush()` + rebuild `edge_keys` after flush (Changes 7, 8)
7. Clear in `clear()` and `delete_version()` (Changes 9, 10)
8. Write tests (7 tests)
9. Run `cargo test` to verify

**Estimated scope:** ~60-80 lines of production code changes, ~120 lines of tests. All in one file.

---

## Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| `edge_keys` out of sync with actual edges | LOW | Every write path (add, delete, flush-rebuild, clear, open-load) updates edge_keys. Tests cover all paths. |
| Metadata loss on dedup (first-write-wins) | LOW | Matches existing semantics. Enrichers that update metadata use delete+add pattern. |
| Memory overhead of HashSet | LOW | ~120 bytes/edge. At 1M edges = 120MB. Adjacency lists already use similar memory. |
| `flush()` HashMap vs Vec performance | NEGLIGIBLE | HashMap insertion is O(1) amortized. Flush is rare and already O(n). |
| Breaking existing tests | NONE | No existing behavior changes for non-duplicate inputs. Existing tests add unique edges. |
