# RFD-11: Wire Protocol v3 Integration -- Joel Spolsky's Technical Specification

**Based on:** Don Melton's High-Level Plan (002-don-plan.md)

---

## Overview

This specification expands Don's 5-phase plan into concrete implementation steps with exact file paths, struct signatures, method-by-method mapping, complexity analysis, and test specifications.

**Scope:** ~1290 new LOC, ~350 modified LOC, ~35 new tests, 6-9 days.

---

## Phase 1: GraphStore Implementation for v2 (T4.1a)

### 1.1 Type Conversion Layer

**File:** `src/graph/engine_v2.rs` (new file, top section)

Create bidirectional conversion between v1 and v2 record types. These are `From` trait implementations.

#### NodeRecord <-> NodeRecordV2

```
Direction: NodeRecordV2 -> NodeRecord (for GraphStore return values)
Mapping:
  - id           -> id           (direct: u128)
  - node_type    -> node_type    (String -> Option<String>: Some(v2.node_type))
  - name         -> name         (String -> Option<String>: Some(v2.name))
  - file         -> file         (String -> Option<String>: Some(v2.file))
  - metadata     -> metadata     ("" -> None, non-empty -> Some(v2.metadata))
  - semantic_id  -> DROPPED      (v1 NodeRecord has no semantic_id field)
  - content_hash -> DROPPED      (v1 NodeRecord has no content_hash field)
  - (default)    -> file_id      (0 -- computed during flush, not needed in-flight)
  - (default)    -> name_offset  (0 -- computed during flush)
  - (default)    -> version      ("main".to_string())
  - (default)    -> exported     (false)
  - (default)    -> replaces     (None)
  - (default)    -> deleted      (false)

Direction: NodeRecord -> NodeRecordV2 (for GraphStore input from wire)
Mapping:
  - id           -> id           (direct: u128)
  - node_type    -> node_type    (Option<String> -> String: unwrap_or("UNKNOWN"))
  - name         -> name         (Option<String> -> String: unwrap_or(""))
  - file         -> file         (Option<String> -> String: unwrap_or(""))
  - metadata     -> metadata     (Option<String> -> String: unwrap_or(""))
  - (computed)   -> semantic_id  (format!("{}:{}@{}", node_type, name, file))
  - (default)    -> content_hash (0 -- not computed from v1 records)
```

**Complexity:** O(1) per record, O(n) for batch. No allocations beyond string cloning.

#### EdgeRecord <-> EdgeRecordV2

```
Direction: EdgeRecordV2 -> EdgeRecord
Mapping:
  - src       -> src        (direct: u128)
  - dst       -> dst        (direct: u128)
  - edge_type -> edge_type  (String -> Option<String>: Some(v2.edge_type))
  - metadata  -> metadata   ("" -> None, non-empty -> Some(v2.metadata))
  - (default) -> version    ("main".to_string())
  - (default) -> deleted    (false)

Direction: EdgeRecord -> EdgeRecordV2
Mapping:
  - src       -> src        (direct: u128)
  - dst       -> dst        (direct: u128)
  - edge_type -> edge_type  (Option<String> -> String: unwrap_or(""))
  - metadata  -> metadata   (Option<String> -> String: unwrap_or(""))
```

**Estimated LOC:** ~60

### 1.2 GraphEngineV2 Struct

**File:** `src/graph/engine_v2.rs`

```rust
pub struct GraphEngineV2 {
    store: MultiShardStore,
    manifest: ManifestStore,
    path: Option<PathBuf>,
    ephemeral: bool,

    // Pending tombstones for individual delete_node/delete_edge calls.
    // Applied during flush() or commit_batch().
    pending_tombstone_nodes: HashSet<u128>,
    pending_tombstone_edges: HashSet<(u128, u128, String)>,

    // Declared fields (for secondary indexing, same as v1)
    declared_fields: Vec<FieldDecl>,
}
```

#### Constructors

```
GraphEngineV2::create(path: &Path) -> Result<Self>
  1. fs::create_dir_all(path)
  2. ManifestStore::create(path)
  3. MultiShardStore::create(path, DEFAULT_SHARD_COUNT)  // DEFAULT_SHARD_COUNT = 4
  4. Return Self { store, manifest, path: Some(...), ephemeral: false, ... }

GraphEngineV2::create_ephemeral() -> Result<Self>
  1. ManifestStore::ephemeral()
  2. MultiShardStore::ephemeral(DEFAULT_SHARD_COUNT)
  3. Return Self { ..., ephemeral: true, ... }

GraphEngineV2::open(path: &Path) -> Result<Self>
  1. ManifestStore::open(path)
  2. MultiShardStore::open(path, &manifest)
  3. Return Self { store, manifest, path: Some(...), ephemeral: false, ... }
```

**Estimated LOC:** ~80

### 1.3 GraphStore Trait Implementation

**File:** `src/graph/engine_v2.rs` -- `impl GraphStore for GraphEngineV2`

Method-by-method specification:

#### Node Operations

**`add_nodes(&mut self, nodes: Vec<NodeRecord>)`**
```
1. Convert: nodes.into_iter().map(NodeRecord -> NodeRecordV2).collect()
2. self.store.add_nodes(converted)
```
Complexity: O(n) where n = nodes.len()

**`delete_node(&mut self, id: u128)`**
```
1. self.pending_tombstone_nodes.insert(id)
   // NOT immediately deleted -- buffered until flush/commit_batch
   // This is critical: v2 uses file-level tombstones in commit_batch,
   // but GraphStore needs per-node delete for backward compat.
2. Also tombstone outgoing edges from this node:
   for edge in self.store.get_outgoing_edges(id, None):
     self.pending_tombstone_edges.insert((edge.src, edge.dst, edge.edge_type))
3. Also tombstone incoming edges to this node:
   for edge in self.store.get_incoming_edges(id, None):
     self.pending_tombstone_edges.insert((edge.src, edge.dst, edge.edge_type))
```
Complexity: O(E_out + E_in) for edge discovery. This is necessary for correctness.

**DESIGN DECISION:** Individual deletes are buffered in `pending_tombstone_nodes`/`pending_tombstone_edges`. They take effect immediately for reads (get_node checks pending tombstones) but are persisted to manifest only on flush(). This matches v1's behavior where delete_node sets a `deleted` flag that's visible immediately.

**`get_node(&self, id: u128) -> Option<NodeRecord>`**
```
1. if self.pending_tombstone_nodes.contains(&id): return None
2. self.store.get_node(id).map(NodeRecordV2 -> NodeRecord)
```
Complexity: O(1) with node_to_shard lookup

**`node_exists(&self, id: u128) -> bool`**
```
1. if self.pending_tombstone_nodes.contains(&id): return false
2. self.store.node_exists(id)
```
Complexity: O(1)

**`get_node_identifier(&self, id: u128) -> Option<String>`**
```
1. self.get_node(id).map(|n| {
     let node_type = n.node_type.as_deref().unwrap_or("UNKNOWN");
     let name = n.name.as_deref().unwrap_or("?");
     let file = n.file.as_deref().unwrap_or("?");
     format!("{}:{}@{}", node_type, name, file)
   })
```
Complexity: O(1)

**`find_by_attr(&self, query: &AttrQuery) -> Vec<u128>`**
```
1. Start with store.find_nodes(query.node_type.as_deref(), query.file.as_deref())
2. Filter results by additional AttrQuery fields:
   - query.version: skip (v2 has no version field -- always matches)
   - query.exported: skip (v2 has no exported field -- always matches)
   - query.name: filter by node.name == query.name
   - query.file_id: skip (v2 uses file path, not file_id)
   - query.metadata_filters: for each (key, value) pair, parse node.metadata as JSON,
     check if json[key] == value. This is O(F * M) where F = filters, M = nodes.
3. Exclude pending tombstoned nodes
4. Return Vec<u128> of matching node IDs
```
Complexity: O(S * N_per_shard) for find_nodes fan-out + O(M * F) for metadata filtering where M = matched nodes, F = filter count.

**`find_by_type(&self, node_type: &str) -> Vec<u128>`**
```
1. Check for wildcard: if node_type contains '*':
   - Split on '*', match prefix (e.g., "http:*" matches "http:route", "http:endpoint")
   - For v2: use find_nodes(None, None) and filter by type prefix
   - OPTIMIZATION: v2 stores node_type in zone maps -- can be filtered at segment level
2. Else: self.store.find_nodes(Some(node_type), None)
3. Exclude pending tombstoned nodes
4. Return .iter().map(|n| n.id).collect()
```
Complexity: O(S * N_per_shard) fan-out. Wildcard is more expensive but zone maps help.

#### Edge Operations

**`add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool)`**
```
1. Convert: edges.into_iter().map(EdgeRecord -> EdgeRecordV2).collect()
2. self.store.add_edges(converted)
   // Note: add_edges returns Result -- if skip_validation is false and
   // a source node doesn't exist, v1 would have failed too.
   // If error and !skip_validation: log warning but don't crash
   // If error and skip_validation: silently skip missing sources
```
Complexity: O(n)

**`delete_edge(&mut self, src: u128, dst: u128, edge_type: &str)`**
```
1. self.pending_tombstone_edges.insert((src, dst, edge_type.to_string()))
```
Complexity: O(1)

**`neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128>`**
```
1. let et = if edge_types.is_empty() { None } else { Some(edge_types) };
2. self.store.get_outgoing_edges(id, et)
3. Filter out edges in pending_tombstone_edges
4. .map(|e| e.dst).collect()
```
Complexity: O(E_out)

**`get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord>`**
```
1. self.store.get_outgoing_edges(node_id, edge_types)
2. Filter out pending tombstoned edges
3. .map(EdgeRecordV2 -> EdgeRecord).collect()
```
Complexity: O(E_out)

**`get_incoming_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord>`**
```
1. self.store.get_incoming_edges(node_id, edge_types)
2. Filter out pending tombstoned edges
3. .map(EdgeRecordV2 -> EdgeRecord).collect()
```
Complexity: O(S * E_per_shard) -- must fan out to all shards

**`get_all_edges(&self) -> Vec<EdgeRecord>`**
```
EXPENSIVE -- must iterate all shards, all segments.
1. Collect all edges from all shards: for each shard, get all edges
   via find_nodes(None, None) -> get all node IDs -> get_outgoing_edges for each
2. Filter out pending tombstoned edges
3. Convert to EdgeRecord

ALTERNATIVE: MultiShardStore needs a new method get_all_edges() that iterates
all shards' write buffers and immutable segments.
Add MultiShardStore::get_all_edges() -> Vec<EdgeRecordV2> for this.
```
Complexity: O(total_edges). This is inherently expensive. Add a comment warning.

#### Stats

**`count_nodes_by_type(&self, types: Option<&[String]>) -> HashMap<String, usize>`**
```
1. MultiShardStore needs new method: count_nodes_by_type(types)
   Implementation: fan-out to all shards, each shard iterates write buffer
   + immutable segments, counting by type. Merge shard results.
2. If types filter contains wildcards (e.g., "http:*"), expand matching.
3. Subtract pending tombstoned nodes (by looking up their types).
```
Complexity: O(total_nodes) for full count, O(N_type) for specific types

**`count_edges_by_type(&self, edge_types: Option<&[String]>) -> HashMap<String, usize>`**
```
Same approach as count_nodes_by_type, applied to edges.
```
Complexity: O(total_edges) for full count

**`node_count(&self) -> usize`**
```
self.store.node_count() - self.pending_tombstone_nodes.len()
// Note: this can undercount if some tombstoned nodes were already gone.
// For exact count: self.store.node_count() - count_of_tombstoned_that_actually_exist
// For now, approximate is fine (matches v1 behavior where node_count includes deleted)
```
Complexity: O(S) -- sum across shards

**`edge_count(&self) -> usize`**
```
self.store.edge_count() - self.pending_tombstone_edges.len()
// Same approximation note as node_count
```
Complexity: O(S)

#### Traversal

**`bfs(&self, start: &[u128], max_depth: usize, edge_types: &[&str]) -> Vec<u128>`**
```
Reuse existing traversal::bfs() with a closure:
traversal::bfs(start, max_depth, |node_id| {
    self.neighbors(node_id, edge_types)
})
```
Complexity: O(V + E) within reachable subgraph

#### Maintenance

**`flush(&mut self) -> Result<()>`**
```
1. If pending tombstones exist:
   a. Apply pending_tombstone_nodes and pending_tombstone_edges to all shards
      via shard.set_tombstones() (union with existing)
   b. Clear pending sets
2. self.store.flush_all(&mut self.manifest)
3. If tombstones were applied, inject them into manifest (as commit_batch does)
```
Complexity: O(flush) + O(tombstones)

**`compact(&mut self) -> Result<()>`**
```
// No-op for v2 -- compaction is future work (T4.x)
Ok(())
```

### 1.4 Extra Methods (Not on GraphStore)

These methods are used by the wire protocol handler and must be available on GraphEngineV2.

**`clear(&mut self)`**
```
Replace store with fresh ephemeral or recreate from path.
Reset pending tombstones, declared_fields.
```

**`is_endpoint(&self, id: u128) -> bool`**
```
Same logic as v1 GraphEngine::is_endpoint():
1. get_node(id)
2. Check if node_type is in endpoint set: db:query, http:request, etc.
```

**`reachability(&self, start: &[u128], max_depth: usize, edge_types: &[&str], backward: bool) -> Vec<u128>`**
```
if backward:
    traversal::bfs(start, max_depth, |id| self.reverse_neighbors(id, edge_types))
else:
    self.bfs(start, max_depth, edge_types)

reverse_neighbors(id, edge_types):
    self.get_incoming_edges(id, Some(edge_types))
        .iter().map(|e| e.src).collect()
```

**`declare_fields(&mut self, fields: Vec<FieldDecl>)`**
```
self.declared_fields = fields;
// v2 note: FieldDecl metadata indexing is future work.
// For now, store them for API compat. Zone maps partially cover this.
```

**`commit_batch(nodes, edges, changed_files, tags) -> Result<CommitDelta>`**
```
Delegate directly to self.store.commit_batch(v2_nodes, v2_edges, changed_files, tags, &mut self.manifest)
Clear any pending tombstones for the changed files (they're now handled by commit_batch).
```

**`tag_snapshot(version, tags) -> Result<()>`**
```
self.manifest.tag_snapshot(version, tags)
```

**`find_snapshot(tag_key, tag_value) -> Option<u64>`**
```
self.manifest.find_snapshot(tag_key, tag_value)
```

**`list_snapshots(filter_tag) -> Vec<SnapshotInfo>`**
```
self.manifest.list_snapshots(filter_tag)
```

**`diff_snapshots(from_version, to_version) -> Result<SnapshotDiff>`**
```
self.manifest.diff_snapshots(from_version, to_version)
```

**Estimated LOC for 1.3 + 1.4:** ~450

### 1.5 New Methods on MultiShardStore

MultiShardStore needs these additions to support GraphStore:

**`get_all_edges(&self) -> Vec<EdgeRecordV2>`**
```
Fan-out: concatenate edges from all shards' write buffers + immutable segments.
Each Shard needs get_all_edges() added.
```

**`count_nodes_by_type(&self, types: Option<&[String]>) -> HashMap<String, usize>`**
```
Fan-out: each shard counts, merge by summing per type.
Each Shard needs count_nodes_by_type().
```

**`count_edges_by_type(&self, edge_types: Option<&[String]>) -> HashMap<String, usize>`**
```
Same pattern.
```

**Estimated LOC:** ~80 (across multi_shard.rs and shard.rs)

### 1.6 Module Registration

**File:** `src/graph/mod.rs` -- add module declaration:
```rust
pub mod engine_v2;
pub use engine_v2::GraphEngineV2;
```

**File:** `src/lib.rs` -- re-export:
```rust
pub use graph::GraphEngineV2;
```

**Estimated LOC:** ~5

### 1.7 Unit Tests for Phase 1

**File:** `src/graph/engine_v2.rs` -- `#[cfg(test)] mod tests`

| # | Test Name | What It Verifies |
|---|-----------|-----------------|
| 1 | `test_node_record_v2_to_v1_roundtrip` | NodeRecordV2 -> NodeRecord preserves id, type, name, file, metadata |
| 2 | `test_node_record_v1_to_v2_conversion` | NodeRecord -> NodeRecordV2 handles Optional fields correctly |
| 3 | `test_edge_record_v2_to_v1_roundtrip` | EdgeRecordV2 -> EdgeRecord preserves src, dst, type, metadata |
| 4 | `test_create_ephemeral` | create_ephemeral() produces working engine |
| 5 | `test_add_get_node` | add_nodes + get_node via GraphStore interface |
| 6 | `test_delete_node_buffered` | delete_node buffers tombstone, get_node returns None immediately |
| 7 | `test_find_by_type` | find_by_type returns correct IDs |
| 8 | `test_find_by_type_wildcard` | find_by_type("http:*") matches http:route, http:endpoint |
| 9 | `test_find_by_attr` | find_by_attr with file + node_type filter |
| 10 | `test_add_get_edges` | add_edges + get_outgoing_edges via GraphStore |
| 11 | `test_neighbors` | neighbors returns correct dst IDs |
| 12 | `test_bfs_traversal` | bfs reaches correct depth with edge type filter |
| 13 | `test_flush_persists_tombstones` | flush applies pending tombstones to manifest |
| 14 | `test_commit_batch_v2` | commit_batch produces correct CommitDelta |
| 15 | `test_v1_v2_equivalence` | Same operations on GraphEngine and GraphEngineV2 produce same results |

**Estimated LOC:** ~300

### Phase 1 Total: ~975 LOC (including tests)

---

## Phase 2: Protocol Handler Switchover (T4.1b)

### 2.1 Extend GraphStore for Object Safety + Downcasting

**File:** `src/graph/mod.rs`

The GraphStore trait is already object-safe (verified: all methods use `&self`/`&mut self`, no generics, no `Self` in return position except `Result<()>` which is fine).

Add `as_any()` for downcasting to engine-specific operations:

```rust
use std::any::Any;

pub trait GraphStore: Send + Sync {
    // ... existing 17 methods unchanged ...

    // Downcast support for engine-specific operations
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;
}
```

Both `GraphEngine` and `GraphEngineV2` implement these trivially:
```rust
fn as_any(&self) -> &dyn Any { self }
fn as_any_mut(&mut self) -> &mut dyn Any { self }
```

**Also need:** Add `Send + Sync` impl or derive for GraphEngineV2. Since MultiShardStore is `!Send + !Sync`, GraphEngineV2 will need to be wrapped. Two options:

**Option A (preferred):** Make MultiShardStore Send+Sync by adding appropriate bounds.
- WriteBuffer, Shard internals are all owned data (Vec, HashMap, HashSet)
- No Rc, no Cell -- should be Send+Sync already. Verify with compiler.

**Option B (fallback):** Use `unsafe impl Send for GraphEngineV2` + `unsafe impl Sync for GraphEngineV2` with documentation that all access is serialized by the RwLock in Database.

**Estimated LOC:** ~20

### 2.2 Modify Database Struct

**File:** `src/database_manager.rs`

Change from:
```rust
pub struct Database {
    pub name: String,
    pub engine: RwLock<GraphEngine>,
    pub ephemeral: bool,
    connection_count: AtomicUsize,
}
```

To:
```rust
pub struct Database {
    pub name: String,
    pub engine: RwLock<Box<dyn GraphStore>>,
    pub ephemeral: bool,
    connection_count: AtomicUsize,
}
```

Update `Database::new()`:
```rust
pub fn new(name: String, engine: Box<dyn GraphStore>, ephemeral: bool) -> Self { ... }
```

Update `node_count()` and `edge_count()` -- these already use `GraphStore` methods, so they work unchanged with `Box<dyn GraphStore>`.

**Estimated LOC:** ~15 (modifications to existing code)

### 2.3 Update DatabaseManager

**File:** `src/database_manager.rs`

**`create_database(&self, name: &str, ephemeral: bool) -> Result<()>`**

Currently creates `GraphEngine`. Change to create `GraphEngineV2`:
```rust
let engine: Box<dyn GraphStore> = if ephemeral {
    Box::new(GraphEngineV2::create_ephemeral()?)
} else {
    let db_path = self.base_path.join(format!("{}.rfdb", name));
    Box::new(GraphEngineV2::create(&db_path)?)
};
```

**`create_default_from_path(&self, db_path: &PathBuf) -> Result<()>`**

This is for backward compatibility with v1 databases. Keep v1 engine for existing databases:
```rust
let engine: Box<dyn GraphStore> = if db_path.join("nodes.bin").exists() {
    // v1 database detected -- open with v1 engine
    Box::new(GraphEngine::open(db_path)?)
} else if db_path.join("db_config.json").exists() {
    // v2 database detected -- open with v2 engine
    Box::new(GraphEngineV2::open(db_path)?)
} else {
    // New database -- create with v2 engine
    Box::new(GraphEngineV2::create(db_path)?)
};
```

**Estimated LOC:** ~30

### 2.4 Update with_engine_read / with_engine_write

**File:** `src/bin/rfdb_server.rs`

Change signatures from concrete `&GraphEngine` to `&dyn GraphStore`:

```rust
fn with_engine_read<F>(session: &ClientSession, f: F) -> Response
where
    F: FnOnce(&dyn GraphStore) -> Response,
{
    match &session.current_db {
        Some(db) => {
            let engine = db.engine.read().unwrap();
            f(&**engine)  // Deref Box<dyn GraphStore> to &dyn GraphStore
        }
        None => Response::ErrorWithCode { ... },
    }
}

fn with_engine_write<F>(session: &ClientSession, f: F) -> Response
where
    F: FnOnce(&mut dyn GraphStore) -> Response,
{
    match &session.current_db {
        Some(db) => {
            if !session.can_write() { return error; }
            let mut engine = db.engine.write().unwrap();
            f(&mut **engine)
        }
        None => Response::ErrorWithCode { ... },
    }
}
```

**Impact on existing handlers:** All handlers that use only `GraphStore` methods will compile unchanged. Only handlers using engine-specific methods need updating:

| Handler | Uses | Change Needed |
|---------|------|---------------|
| `CommitBatch` | `handle_commit_batch(engine)` | Downcast to v2 or keep v1 path |
| `Clear` | `engine.clear()` | Add `clear()` to GraphStore or downcast |
| `IsEndpoint` | `engine.is_endpoint(id)` | Add to GraphStore or downcast |
| `Reachability` | `engine.reachability(...)` | Add to GraphStore or downcast |
| `DeclareFields` | `engine.declare_fields(...)` | Add to GraphStore or downcast |
| `DatalogQuery` | `Evaluator::new(&engine)` | Change Evaluator to use `&dyn GraphStore` |

**Recommended approach:** Add these 5 methods to GraphStore trait rather than downcasting. This is cleaner:

```rust
pub trait GraphStore: Send + Sync {
    // ... existing methods ...

    // Additional methods (previously only on GraphEngine)
    fn clear(&mut self);
    fn is_endpoint(&self, id: u128) -> bool;
    fn reachability(&self, start: &[u128], max_depth: usize, edge_types: &[&str], backward: bool) -> Vec<u128>;
    fn declare_fields(&mut self, fields: Vec<FieldDecl>);
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;
}
```

This keeps downcasting only for v2-specific operations (commit_batch, snapshots).

**Estimated LOC:** ~40

### 2.5 Update handle_commit_batch

**File:** `src/bin/rfdb_server.rs`

The current `handle_commit_batch` takes `&mut GraphEngine` and does v1 delete-then-add. For v2, it should delegate to `GraphEngineV2::commit_batch()`.

```rust
fn handle_commit_batch(
    engine: &mut dyn GraphStore,
    changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
) -> Response {
    // Try v2 path first (downcast)
    if let Some(v2) = engine.as_any_mut().downcast_mut::<GraphEngineV2>() {
        // Convert wire types to v2 records
        let v2_nodes: Vec<NodeRecordV2> = nodes.into_iter()
            .map(wire_node_to_v2_record).collect();
        let v2_edges: Vec<EdgeRecordV2> = edges.into_iter()
            .map(wire_edge_to_v2_record).collect();

        match v2.commit_batch(v2_nodes, v2_edges, &changed_files, HashMap::new()) {
            Ok(delta) => Response::BatchCommitted {
                ok: true,
                delta: commit_delta_to_wire(delta),
            },
            Err(e) => Response::Error { error: e.to_string() },
        }
    } else {
        // v1 fallback -- existing delete-then-add logic
        handle_commit_batch_v1(engine, changed_files, nodes, edges)
    }
}
```

**New helper:** `wire_node_to_v2_record()`, `wire_edge_to_v2_record()`, `commit_delta_to_wire()`.

**WireCommitDelta difference:** v1's WireCommitDelta has `edges_added`/`edges_removed` fields that v2's CommitDelta doesn't. Add these with approximations or 0 values.

**Estimated LOC:** ~60

### 2.6 Adapt Datalog Evaluator

**File:** `src/datalog/eval.rs`

Change:
```rust
pub struct Evaluator<'a> {
    engine: &'a GraphEngine,   // BEFORE
    engine: &'a dyn GraphStore, // AFTER
    rules: HashMap<String, Vec<Rule>>,
}

impl<'a> Evaluator<'a> {
    pub fn new(engine: &'a dyn GraphStore) -> Self { ... } // BEFORE: &'a GraphEngine
}
```

**Audit of GraphStore methods used by Evaluator:**
(from grep results in eval.rs and eval_explain.rs)

| Method Call | GraphStore? | Notes |
|------------|------------|-------|
| `engine.find_by_type(node_type)` | YES | Direct trait method |
| `engine.get_node(id)` | YES | Direct trait method |
| `engine.count_nodes_by_type(None)` | YES | Direct trait method |
| `engine.get_outgoing_edges(id, types)` | YES | Direct trait method |
| `engine.get_all_edges()` | YES | Direct trait method |
| `engine.get_incoming_edges(id, types)` | YES | Direct trait method |
| `engine.bfs(start, depth, types)` | YES | Direct trait method |

**Result:** ALL methods used by the Evaluator are on GraphStore. The change is purely mechanical -- replace `&GraphEngine` with `&dyn GraphStore`.

**File:** `src/datalog/eval_explain.rs` -- Same change.

**Estimated LOC:** ~10 (pure signature changes)

### 2.7 JS Integration Tests

**Directory:** `test/unit/` (TypeScript/JavaScript tests)

These tests exercise the wire protocol via the TypeScript client. Since the wire protocol format is unchanged, most tests should pass automatically.

**Tests requiring adaptation:**

1. Tests calling `UpdateNodeVersion` -- v2 has no node versions. The handler should return `Ok` (no-op) for backward compat.
2. Tests calling `Compact` -- v2 compact is no-op. Handler returns `Ok`.
3. Tests that rely on v1-specific count behavior (e.g., `node_count` including deleted) -- v2 tombstones make deleted nodes invisible.

**Strategy:** Run full test suite, fix failures one by one. Expected: <5 test changes.

**Estimated LOC:** ~20 (test modifications)

### Phase 2 Total: ~195 LOC

---

## Phase 3: New Protocol Commands (T4.1c)

### 3.1 New Request/Response Variants

**File:** `src/bin/rfdb_server.rs`

Add to `Request` enum:

```rust
// Batch operations (enhanced)
BeginBatch,
AbortBatch,

// Snapshot operations (v2 only)
TagSnapshot {
    version: u64,
    tags: HashMap<String, String>,
},
FindSnapshot {
    #[serde(rename = "tagKey")]
    tag_key: String,
    #[serde(rename = "tagValue")]
    tag_value: String,
},
ListSnapshots {
    #[serde(rename = "filterTag")]
    filter_tag: Option<String>,
},
DiffSnapshots {
    #[serde(rename = "fromVersion")]
    from_version: u64,
    #[serde(rename = "toVersion")]
    to_version: u64,
},

// Query operations (v2 enhanced)
QueryEdges {
    #[serde(rename = "nodeId")]
    node_id: String,
    direction: String,  // "outgoing" | "incoming" | "both"
    #[serde(rename = "edgeTypes")]
    edge_types: Option<Vec<String>>,
    limit: Option<u32>,
},
FindDependentFiles {
    #[serde(rename = "nodeId")]
    node_id: Option<String>,
    file: Option<String>,
},
```

Add to `Response` enum:

```rust
BatchStarted {
    ok: bool,
    #[serde(rename = "batchId")]
    batch_id: String,
},

SnapshotTagged { ok: bool },

SnapshotFound {
    version: Option<u64>,
},

SnapshotList {
    snapshots: Vec<WireSnapshotInfo>,
},

SnapshotDiffResult {
    diff: WireSnapshotDiff,
},

DependentFiles {
    files: Vec<String>,
},
```

**Estimated LOC:** ~80

### 3.2 Wire Types for Snapshots

```rust
#[derive(Debug, Serialize)]
pub struct WireSnapshotInfo {
    pub version: u64,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    pub tags: HashMap<String, String>,
    #[serde(rename = "nodeCount")]
    pub node_count: u64,
    #[serde(rename = "edgeCount")]
    pub edge_count: u64,
}

#[derive(Debug, Serialize)]
pub struct WireSnapshotDiff {
    #[serde(rename = "fromVersion")]
    pub from_version: u64,
    #[serde(rename = "toVersion")]
    pub to_version: u64,
    #[serde(rename = "addedNodeTypes")]
    pub added_node_types: Vec<String>,
    #[serde(rename = "removedNodeTypes")]
    pub removed_node_types: Vec<String>,
    #[serde(rename = "addedEdgeTypes")]
    pub added_edge_types: Vec<String>,
    #[serde(rename = "removedEdgeTypes")]
    pub removed_edge_types: Vec<String>,
    #[serde(rename = "statsFrom")]
    pub stats_from: WireManifestStats,
    #[serde(rename = "statsTo")]
    pub stats_to: WireManifestStats,
}
```

**Estimated LOC:** ~50

### 3.3 Handler Implementations

**All new handlers follow the same pattern:** downcast engine to GraphEngineV2 via `as_any()`, call v2-specific method, return error if v1 engine.

**TagSnapshot handler:**
```rust
Request::TagSnapshot { version, tags } => {
    with_engine_write(session, |engine| {
        match engine.as_any_mut().downcast_mut::<GraphEngineV2>() {
            Some(v2) => match v2.tag_snapshot(version, tags) {
                Ok(()) => Response::SnapshotTagged { ok: true },
                Err(e) => Response::Error { error: e.to_string() },
            },
            None => Response::ErrorWithCode {
                error: "Snapshot operations require v2 engine".to_string(),
                code: "V2_REQUIRED".to_string(),
            },
        }
    })
}
```

**FindSnapshot, ListSnapshots, DiffSnapshots:** Same pattern with read access.

**BeginBatch / AbortBatch:**
```
BeginBatch:
  - Set session-level batch_state = Some(PendingBatch { id: uuid, nodes: vec![], edges: vec![] })
  - Return BatchStarted { ok: true, batch_id }

AbortBatch:
  - Clear session.batch_state
  - Return Ok { ok: true }
```

Note: This requires adding `batch_state: Option<PendingBatch>` to ClientSession.
However, this is optional -- the current CommitBatch is already an atomic single-call API.
If BeginBatch/AbortBatch are "nice to have" vs "must have", consider deferring.

**QueryEdges handler:**
```rust
Request::QueryEdges { node_id, direction, edge_types, limit } => {
    with_engine_read(session, |engine| {
        let id = string_to_id(&node_id);
        let types_refs: Option<Vec<&str>> = edge_types.as_ref()
            .map(|v| v.iter().map(|s| s.as_str()).collect());

        let edges = match direction.as_str() {
            "outgoing" => engine.get_outgoing_edges(id, types_refs.as_deref()),
            "incoming" => engine.get_incoming_edges(id, types_refs.as_deref()),
            "both" => {
                let mut out = engine.get_outgoing_edges(id, types_refs.as_deref());
                out.extend(engine.get_incoming_edges(id, types_refs.as_deref()));
                out
            }
            _ => return Response::Error { error: "Invalid direction".to_string() },
        };

        let limited = if let Some(lim) = limit {
            edges.into_iter().take(lim as usize).collect()
        } else {
            edges
        };

        Response::Edges { edges: limited.into_iter().map(record_to_wire_edge).collect() }
    })
}
```

**FindDependentFiles handler:**
```rust
// Find files that depend on a given node or file.
// Algorithm:
// 1. Find target node(s) -- either by nodeId or by file
// 2. Get all incoming edges to these nodes
// 3. For each source node of an incoming edge, get its file
// 4. Dedup file paths
// Uses GraphStore methods only -- works with both v1 and v2.
```

**Estimated LOC:** ~120

### 3.4 Unit Tests for Phase 3

| # | Test | What It Verifies |
|---|------|-----------------|
| 1 | `test_tag_snapshot_basic` | Tag a manifest version, find it back |
| 2 | `test_tag_snapshot_v1_error` | v1 engine returns error for snapshot ops |
| 3 | `test_find_snapshot` | Find snapshot by tag key/value |
| 4 | `test_list_snapshots` | List all snapshots with filter |
| 5 | `test_diff_snapshots` | Diff between two versions shows changes |
| 6 | `test_query_edges_outgoing` | QueryEdges with direction=outgoing |
| 7 | `test_query_edges_incoming` | QueryEdges with direction=incoming |
| 8 | `test_query_edges_both` | QueryEdges with direction=both |
| 9 | `test_query_edges_with_limit` | QueryEdges with limit parameter |
| 10 | `test_find_dependent_files` | FindDependentFiles returns correct files |
| 11 | `test_begin_abort_batch` | BeginBatch + AbortBatch lifecycle |
| 12 | `test_commit_batch_v2_wire` | Full CommitBatch through wire protocol with v2 engine |

**Estimated LOC:** ~200

### Phase 3 Total: ~450 LOC (including tests)

---

## Phase 4: Ephemeral Database Support for v2 (T4.1d)

### 4.1 Wire Through DatabaseManager

**File:** `src/database_manager.rs`

The `create_database()` change in Phase 2.3 already handles this:
- `ephemeral: true` -> `GraphEngineV2::create_ephemeral()`
- This creates `MultiShardStore::ephemeral(4)` + `ManifestStore::ephemeral()`
- Cleanup on disconnect already works via `cleanup_ephemeral_if_unused()`

**No additional code needed** -- this is covered by Phase 2.3.

### 4.2 Tests

| # | Test | What It Verifies |
|---|------|-----------------|
| 1 | `test_ephemeral_v2_create_via_manager` | create_database with ephemeral=true creates v2 engine |
| 2 | `test_ephemeral_v2_crud` | Add/get/delete nodes and edges in ephemeral v2 |
| 3 | `test_ephemeral_v2_cleanup` | Database removed after last connection closes |

**Estimated LOC:** ~60

### Phase 4 Total: ~60 LOC

---

## Phase 5: Test Adaptation for Removed/Changed Commands (T4.1e)

### 5.1 Backward-Compatible Stubs

**File:** `src/bin/rfdb_server.rs`

| Command | v2 Behavior | Response |
|---------|------------|----------|
| `UpdateNodeVersion` | No-op (v2 has no node versions) | `Response::Ok { ok: true }` |
| `Compact` | No-op (v2 compaction is future) | `Response::Ok { ok: true }` |
| `GetAllEdges` | Implemented via fan-out in Phase 1 | Works normally (expensive) |

**Estimated LOC:** ~15

### 5.2 Test Modifications

Identify tests that assert on v1-specific behavior:

1. Tests asserting `Compact` reduces data size -> change to assert `Ok` response
2. Tests asserting `UpdateNodeVersion` changes node -> change to assert `Ok` (no-op)
3. Tests asserting `node_count` includes deleted -> v2 tombstones hide deleted

**Estimated LOC:** ~30

### Phase 5 Total: ~45 LOC

---

## Implementation Order and Dependencies

```
Phase 1.1 (Type conversions)
    |
    v
Phase 1.2 (GraphEngineV2 struct)
    |
    v
Phase 1.3 (GraphStore impl) <-- requires 1.5 (new MultiShardStore methods)
    |
    v
Phase 1.4 (Extra methods)
    |
    v
Phase 1.7 (Unit tests) -- can be interleaved with 1.3/1.4
    |
    v
Phase 2.1 (GraphStore trait extension)
    |
    v
Phase 2.2 (Database struct change)
    |
    v
Phase 2.3 (DatabaseManager update)
    |
    v
Phase 2.4-2.5 (Server handler updates)
    |
    v
Phase 2.6 (Datalog evaluator)
    |
    +---------+---------+
    |         |         |
    v         v         v
Phase 3   Phase 4   Phase 5
(Commands) (Ephemeral) (Test adapt)
```

Phases 3, 4, 5 are independent and can be parallelized.

## Commit Plan

| Commit | Content | Tests Added |
|--------|---------|-------------|
| 1 | Type conversion layer (From impls) | 3 roundtrip tests |
| 2 | GraphEngineV2 struct + constructors | 1 test (create_ephemeral) |
| 3 | GraphStore impl (node operations) | 5 tests |
| 4 | GraphStore impl (edge + traversal + stats) | 4 tests |
| 5 | Extra methods + MultiShardStore additions | 2 tests |
| 6 | GraphStore trait extension (Send+Sync, as_any, extra methods) | 0 (compile check) |
| 7 | Database struct change + DatabaseManager | 0 (existing tests must pass) |
| 8 | with_engine_read/write + handler updates | 0 (existing tests must pass) |
| 9 | handle_commit_batch v2 path | 1 test |
| 10 | Datalog evaluator adaptation | 0 (existing datalog tests must pass) |
| 11 | New protocol commands (snapshot) | 5 tests |
| 12 | New protocol commands (query + batch) | 4 tests |
| 13 | Ephemeral v2 | 3 tests |
| 14 | Backward-compat stubs + test adaptation | 5 adapted tests |

**Total: 14 atomic commits, each with passing tests.**

## Risk Mitigation

### Risk 1: MultiShardStore Send+Sync

**Mitigation:** Before Phase 2, verify that `MultiShardStore` is `Send + Sync`:
```rust
fn assert_send<T: Send>() {}
fn assert_sync<T: Sync>() {}
assert_send::<MultiShardStore>();
assert_sync::<MultiShardStore>();
```
If it fails, identify the non-Send/Sync field and fix it (likely a missing bound on a contained type).

### Risk 2: Datalog Evaluator Uses Undocumented GraphEngine Methods

**Mitigation:** Done -- audit shows ALL methods used are on GraphStore trait. Safe to proceed.

### Risk 3: WireCommitDelta Format Mismatch

**Mitigation:** v2's `CommitDelta` doesn't have `edges_added`/`edges_removed`. Wire type `WireCommitDelta` needs updating:
- Option A: Add edge counts to v2's CommitDelta
- Option B: Map v2 delta to wire format with approximate/0 edge counts
- **Recommended:** Option A is cleaner, ~10 LOC in multi_shard.rs

### Risk 4: Performance Regression in find_by_attr

**Mitigation:** v2's find_by_attr uses find_nodes (segment-level zone map filtering) + in-memory metadata JSON parsing. This may be slower than v1's IndexSet for declared fields. Accept for now, optimize in future (field indexes on v2 segments).

## Open Questions Resolved

From Don's plan:

1. **Individual delete semantics:** RESOLVED -- Buffer in `pending_tombstone_nodes`/`pending_tombstone_edges`, apply on flush(). Reads check pending tombstones for immediate visibility.

2. **Datalog evaluator coupling:** RESOLVED -- Uses only GraphStore methods. Pure mechanical change.

3. **Engine selection strategy:** RESOLVED -- New databases use v2. Existing v1 databases detected by `nodes.bin` presence. `create_default_from_path()` auto-detects.

4. **GetAllEdges in v2:** RESOLVED -- Implement via fan-out across all shards. Add `MultiShardStore::get_all_edges()`. Mark as expensive in docs.

5. **Batch session state:** RESOLVED -- BeginBatch/AbortBatch are session-level state, optional nice-to-have. CommitBatch remains the primary API as a single atomic call.

---

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2026-02-14
**Status:** Ready for Steve Jobs review
