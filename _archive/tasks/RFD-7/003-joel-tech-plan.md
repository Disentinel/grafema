# RFD-7: T2.3 Multi-Shard -- Joel's Tech Spec

> Date: 2026-02-13
> Author: Joel Spolsky (Implementation Planner)
> Based on: Don's Plan (002-don-plan.md)
> Status: Ready for Steve Jobs review

---

## 0. Scope

Build the multi-shard layer for RFDB v2 storage. Directory-based partitioning where files in the same directory go to the same shard. New `ShardPlanner` computes shard assignments deterministically. New `MultiShardStore` wraps N independent `Shard` instances and fans out queries.

**Total budget:** ~840 LOC across 4 phases, ~20 tests.

**What this spec DOES cover:**
- `shard_planner.rs`: File→shard_id mapping via directory hash
- `multi_shard.rs`: MultiShardStore with N shards + fan-out queries
- `multi_shard.rs`: DatabaseConfig struct for shard_count persistence
- Integration with ManifestStore (shard_id already supported)

**What this spec does NOT cover:**
- No query optimization (shard-aware routing, parallel fan-out)
- No resharding (shard_count is immutable)
- No per-shard WAL (ManifestStore handles crash recovery)
- No cross-shard transactions (append-only, single manifest commit is atomic)

**CRITICAL CORRECTIONS to Don's plan:**
1. **NO seahash** — not in Cargo.toml. Use `blake3` (already available, deterministic).
2. **NO separate config.rs file** — overkill for L0. Simple `DatabaseConfig` struct in `multi_shard.rs`.
3. **NO `shards/` directories** — not needed for L0. `Shard::create()` already creates its directory.
4. **Edge routing needs node→shard mapping** — `EdgeRecordV2` only has `src: u128`, not file path. We need `HashMap<u128, u16>` to route edges to correct shard.

---

## 1. Exact Data Structures

### 1.1. ShardPlanner (`shard_planner.rs`)

```rust
use std::path::Path;
use std::collections::HashMap;

/// Computes deterministic shard assignments for file paths.
///
/// Uses directory-based partitioning: files in the same directory go to
/// the same shard. Hash function is blake3 (deterministic, already a
/// dependency, ~3GB/s throughput).
pub struct ShardPlanner {
    shard_count: u16,
}
```

**Design rationale:**
- `shard_count: u16` — Max 65535 shards (reasonable for any database).
- No cached state — ShardPlanner is stateless, just computation.
- Blake3 hashing — Already in Cargo.toml, deterministic across platforms/versions.

### 1.2. DatabaseConfig (`multi_shard.rs`)

```rust
use serde::{Deserialize, Serialize};

/// Database-level configuration stored at `<db_path>/db_config.json`.
///
/// Written at database creation time. Immutable (resharding = future T4.x).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    /// Format version (currently 2)
    pub version: u16,

    /// Number of shards (fixed at creation time)
    pub shard_count: u16,

    /// Creation timestamp (Unix epoch seconds)
    pub created_at: u64,
}
```

**Design rationale:**
- Simple 3-field struct, ~30 LOC including read/write.
- Lives in `multi_shard.rs` (not separate file — too small to justify).
- JSON format for human readability.

### 1.3. MultiShardStore (`multi_shard.rs`)

```rust
use std::path::{Path, PathBuf};
use std::collections::{HashMap, HashSet};
use crate::storage_v2::shard::Shard;
use crate::storage_v2::shard_planner::ShardPlanner;
use crate::storage_v2::types::{NodeRecordV2, EdgeRecordV2};
use crate::storage_v2::manifest::ManifestStore;

/// Multi-shard store: N shards + fan-out queries.
///
/// Owns N `Shard` instances. All queries fan out to all shards and merge
/// results with deduplication. Flush coordinates across shards and commits
/// a single manifest.
pub struct MultiShardStore {
    /// Path to database root
    db_path: PathBuf,

    /// Shard instances (indexed by shard_id)
    shards: Vec<Shard>,

    /// Shard planner for computing file→shard_id
    planner: ShardPlanner,

    /// Number of shards (immutable)
    shard_count: u16,

    /// Node ID → shard_id mapping for edge routing.
    /// Updated as nodes are added. Used by add_edges to route edges to
    /// the shard containing the source node.
    node_to_shard: HashMap<u128, u16>,
}
```

**Design rationale:**

- `shards: Vec<Shard>` — Indexed by shard_id (0..N). Vec is the natural container.
- `node_to_shard: HashMap<u128, u16>` — **CRITICAL** for edge routing. `EdgeRecordV2` only has `src: u128`, not file path. When `add_edges` is called, we look up `edge.src` in this map to find the shard. **Updated in `add_nodes`** as nodes are added.
- `planner: ShardPlanner` — Stateless helper for file→shard_id computation.
- `db_path: PathBuf` — Needed for segment file paths and config writes.

---

## 2. Complete API Signatures

### 2.1. ShardPlanner API

```rust
impl ShardPlanner {
    /// Create planner for N shards.
    ///
    /// Complexity: O(1)
    pub fn new(shard_count: u16) -> Self;

    /// Compute shard_id for a file path.
    ///
    /// Algorithm:
    /// 1. Extract directory from file path (parent)
    /// 2. blake3::hash(directory_bytes)
    /// 3. Take first 8 bytes as u64
    /// 4. Modulo shard_count → shard_id
    ///
    /// Complexity: O(len(dir_path)) for hash computation
    pub fn compute_shard_id(&self, file_path: &str) -> u16;

    /// Plan shard assignments for a batch of files.
    ///
    /// Returns HashMap<shard_id, Vec<file_path>>.
    ///
    /// Complexity: O(F) where F = number of files
    pub fn plan(&self, files: &[&str]) -> HashMap<u16, Vec<String>>;
}
```

### 2.2. DatabaseConfig API

```rust
impl DatabaseConfig {
    /// Create new config with current timestamp.
    ///
    /// Complexity: O(1)
    pub fn new(shard_count: u16) -> Self;

    /// Read config from `<db_path>/db_config.json`.
    ///
    /// Returns error if file doesn't exist or JSON parse fails.
    ///
    /// Complexity: O(1) (file read + JSON parse)
    pub fn read_from(db_path: &Path) -> Result<Self>;

    /// Write config to `<db_path>/db_config.json`.
    ///
    /// Uses atomic write (temp file + rename).
    ///
    /// Complexity: O(1) (file write)
    pub fn write_to(&self, db_path: &Path) -> Result<()>;
}
```

### 2.3. MultiShardStore API

```rust
impl MultiShardStore {
    // -- Constructors --

    /// Create new multi-shard database with N shards.
    ///
    /// Creates:
    /// - db_path/db_config.json (shard_count)
    /// - db_path/shards/00/ ... db_path/shards/0N/ (shard directories)
    /// - Empty ManifestStore
    ///
    /// Complexity: O(N) where N = shard_count (create N directories)
    pub fn create(db_path: &Path, shard_count: u16) -> Result<Self>;

    /// Create ephemeral multi-shard database (in-memory only).
    ///
    /// For testing. No disk I/O. Flush writes to in-memory segments.
    ///
    /// Complexity: O(N) where N = shard_count (create N ephemeral shards)
    pub fn ephemeral(shard_count: u16) -> Self;

    /// Open existing multi-shard database.
    ///
    /// Reads:
    /// - db_path/db_config.json → shard_count
    /// - ManifestStore::current_manifest() → segment descriptors
    /// - Group descriptors by shard_id
    /// - Open N shards with their descriptors
    ///
    /// Complexity: O(N + S) where N = shard_count, S = total segments
    pub fn open(db_path: &Path, manifest_store: &ManifestStore) -> Result<Self>;

    // -- Write Operations --

    /// Add nodes to write buffers.
    ///
    /// Algorithm:
    /// 1. For each node, compute shard_id = planner.compute_shard_id(node.file)
    /// 2. Group nodes by shard_id
    /// 3. Call shards[shard_id].add_nodes(nodes)
    /// 4. Update node_to_shard mapping: node_to_shard[node.id] = shard_id
    ///
    /// Complexity: O(N + N*H) where N = nodes, H = hash cost (~500ns)
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>) -> Result<()>;

    /// Add edges to write buffers.
    ///
    /// Algorithm:
    /// 1. For each edge, lookup shard_id = node_to_shard[edge.src]
    /// 2. If src not in node_to_shard, return error (node must exist)
    /// 3. Group edges by shard_id
    /// 4. Call shards[shard_id].add_edges(edges)
    ///
    /// Complexity: O(E) where E = edges
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>) -> Result<()>;

    /// Flush all shards to disk and commit manifest.
    ///
    /// Algorithm:
    /// 1. Allocate segment IDs from ManifestStore for each shard
    /// 2. Flush each shard sequentially: shard.flush_with_ids(node_id, edge_id)
    /// 3. Collect all SegmentDescriptors (with shard_id set)
    /// 4. Commit single manifest with all segments
    ///
    /// Complexity: O(N * flush_cost) where N = shard_count
    pub fn flush_all(&mut self, manifest_store: &mut ManifestStore) -> Result<()>;

    // -- Point Lookup --

    /// Get node by id.
    ///
    /// Algorithm:
    /// 1. Fan-out to all shards with early exit
    /// 2. For each shard: if shard.get_node(id) returns Some, return it
    /// 3. Bloom filters prune most shards instantly
    ///
    /// Complexity: O(N) where N = shard_count (sequential scan with bloom prune)
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2>;

    /// Check if node exists.
    ///
    /// Same algorithm as get_node but avoids record reconstruction.
    ///
    /// Complexity: O(N) where N = shard_count
    pub fn node_exists(&self, id: u128) -> bool;

    // -- Attribute Search --

    /// Find nodes matching optional filters (node_type, file).
    ///
    /// Algorithm:
    /// 1. Fan-out to all shards: results = shards[i].find_nodes(type, file)
    /// 2. Merge with deduplication by node id (HashSet)
    ///
    /// Complexity: O(N * S) where N = shard_count, S = segment scan cost per shard
    pub fn find_nodes(
        &self,
        node_type: Option<&str>,
        file: Option<&str>,
    ) -> Vec<NodeRecordV2>;

    // -- Neighbor Queries --

    /// Get outgoing edges from a node.
    ///
    /// Algorithm:
    /// 1. Fan-out to all shards with bloom filter prune
    /// 2. Merge results (no dedup needed, edges are unique)
    ///
    /// Complexity: O(N) where N = shard_count (bloom filters prune most)
    pub fn get_outgoing_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2>;

    /// Get incoming edges to a node.
    ///
    /// Algorithm:
    /// 1. Fan-out to all shards (no bloom filter on dst for L0)
    /// 2. Merge results
    ///
    /// Complexity: O(N * E) where N = shard_count, E = edges per shard
    pub fn get_incoming_edges(
        &self,
        node_id: u128,
        edge_types: Option<&[&str]>,
    ) -> Vec<EdgeRecordV2>;

    // -- Stats --

    /// Total node count (sum across all shards).
    ///
    /// Complexity: O(N) where N = shard_count
    pub fn node_count(&self) -> usize;

    /// Total edge count (sum across all shards).
    ///
    /// Complexity: O(N) where N = shard_count
    pub fn edge_count(&self) -> usize;

    /// Per-shard stats: Vec<(node_count, edge_count)>.
    ///
    /// For debugging/monitoring shard balance.
    ///
    /// Complexity: O(N) where N = shard_count
    pub fn shard_stats(&self) -> Vec<(usize, usize)>;
}
```

---

## 3. Algorithms (Pseudocode)

### 3.1. Shard Routing

```rust
// ShardPlanner::compute_shard_id
fn compute_shard_id(file_path: &str, shard_count: u16) -> u16 {
    // Extract directory path
    let dir = Path::new(file_path)
        .parent()
        .unwrap_or(Path::new(""))
        .as_os_str()
        .as_bytes();

    // Hash with blake3
    let hash_bytes = blake3::hash(dir).as_bytes();

    // Take first 8 bytes as u64
    let hash_u64 = u64::from_le_bytes(hash_bytes[0..8].try_into().unwrap());

    // Modulo shard_count
    (hash_u64 % shard_count as u64) as u16
}
```

**Complexity:** O(len(dir)) for blake3 hash (~3GB/s = ~500ns for typical 100-byte path).

**Determinism:** blake3 is cryptographically deterministic. Same input bytes → same output hash across all platforms, all Rust versions.

### 3.2. Node Distribution

```rust
// MultiShardStore::add_nodes
fn add_nodes(&mut self, records: Vec<NodeRecordV2>) -> Result<()> {
    // Step 1: Group nodes by shard_id
    let mut nodes_by_shard: HashMap<u16, Vec<NodeRecordV2>> = HashMap::new();

    for node in records {
        let shard_id = self.planner.compute_shard_id(&node.file);
        nodes_by_shard.entry(shard_id).or_default().push(node.clone());

        // Update node→shard mapping for edge routing
        self.node_to_shard.insert(node.id, shard_id);
    }

    // Step 2: Batch-add to each shard
    for (shard_id, nodes) in nodes_by_shard {
        self.shards[shard_id as usize].add_nodes(nodes);
    }

    Ok(())
}
```

**Complexity:** O(N + N*H) where N = nodes, H = hash cost (~500ns).

**Invariant:** After `add_nodes`, every node ID in `node_to_shard` maps to the correct shard.

### 3.3. Edge Distribution

```rust
// MultiShardStore::add_edges
fn add_edges(&mut self, records: Vec<EdgeRecordV2>) -> Result<()> {
    // Step 1: Group edges by source shard_id
    let mut edges_by_shard: HashMap<u16, Vec<EdgeRecordV2>> = HashMap::new();

    for edge in records {
        // Lookup source node's shard
        let shard_id = self.node_to_shard.get(&edge.src)
            .ok_or_else(|| GraphError::InvalidOperation(
                format!("Edge src node {} not found", edge.src)
            ))?;

        edges_by_shard.entry(*shard_id).or_default().push(edge);
    }

    // Step 2: Batch-add to each shard
    for (shard_id, edges) in edges_by_shard {
        self.shards[shard_id as usize].add_edges(edges);
    }

    Ok(())
}
```

**Complexity:** O(E) where E = edges (HashMap lookup is O(1)).

**Error handling:** If edge.src is not in `node_to_shard`, return error. Caller must add nodes before edges.

### 3.4. Flush Coordination

```rust
// MultiShardStore::flush_all
fn flush_all(&mut self, manifest_store: &mut ManifestStore) -> Result<()> {
    let mut all_node_descriptors = Vec::new();
    let mut all_edge_descriptors = Vec::new();

    // Step 1: Flush each shard sequentially
    for (shard_idx, shard) in self.shards.iter_mut().enumerate() {
        let shard_id = shard_idx as u16;

        // Allocate segment IDs from manifest store
        let node_seg_id = if shard.write_buffer_size().0 > 0 {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };
        let edge_seg_id = if shard.write_buffer_size().1 > 0 {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };

        // Flush shard
        if let Some(result) = shard.flush_with_ids(node_seg_id, edge_seg_id)? {
            // Build descriptors with shard_id
            if let Some(meta) = result.node_meta {
                let desc = SegmentDescriptor::from_meta(
                    node_seg_id.unwrap(),
                    SegmentType::Nodes,
                    Some(shard_id),
                    meta,
                );
                all_node_descriptors.push(desc);
            }
            if let Some(meta) = result.edge_meta {
                let desc = SegmentDescriptor::from_meta(
                    edge_seg_id.unwrap(),
                    SegmentType::Edges,
                    Some(shard_id),
                    meta,
                );
                all_edge_descriptors.push(desc);
            }
        }
    }

    // Step 2: Commit single manifest with all segments
    manifest_store.commit(all_node_descriptors, all_edge_descriptors)?;

    Ok(())
}
```

**Complexity:** O(N * flush_cost) where N = shard_count.

**Atomicity:** ManifestStore::commit is atomic. Crash before commit → old manifest still valid. Crash after commit → new manifest includes all shards' segments.

**Sequential flush:** Not parallel for L0. Parallelism in T4.x after we add atomic segment ID counter.

### 3.5. Query Fan-Out

```rust
// MultiShardStore::get_node
fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
    // Early exit: as soon as one shard returns the node
    for shard in &self.shards {
        if let Some(node) = shard.get_node(id) {
            return Some(node);
        }
        // Bloom filter in shard.get_node() prunes most shards
    }
    None
}

// MultiShardStore::find_nodes
fn find_nodes(
    &self,
    node_type: Option<&str>,
    file: Option<&str>,
) -> Vec<NodeRecordV2> {
    let mut seen_ids: HashSet<u128> = HashSet::new();
    let mut results: Vec<NodeRecordV2> = Vec::new();

    // Fan-out to all shards
    for shard in &self.shards {
        let shard_results = shard.find_nodes(node_type, file);
        for node in shard_results {
            if seen_ids.insert(node.id) {
                results.push(node);
            }
        }
    }

    results
}
```

**Complexity:**
- `get_node`: O(N) where N = shard_count. Bloom filters prune most shards (k=7 hash checks, ~100ns).
- `find_nodes`: O(N * S) where N = shard_count, S = segment scan per shard.

**Deduplication:** `find_nodes` uses HashSet on node.id. If multiple shards return same node (shouldn't happen, but defensive), first wins.

---

## 4. Big-O Complexity Analysis

### Write Path

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `add_nodes(N nodes)` | O(N + N*H) | H = blake3 hash (~500ns), group by shard |
| `add_edges(E edges)` | O(E) | HashMap lookup per edge |
| `flush_all()` | O(N * F) | N = shard_count, F = flush cost per shard |

### Read Path

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `get_node(id)` | O(N) | N = shard_count, bloom filters prune most |
| `node_exists(id)` | O(N) | Same as get_node |
| `find_nodes(type, file)` | O(N * S) | N = shard_count, S = segment scan per shard |
| `get_outgoing_edges(id)` | O(N) | Bloom filters on src prune most shards |
| `get_incoming_edges(id)` | O(N * E) | No bloom filter on dst, scan all shards |

### Stats

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `node_count()` | O(N) | Sum over N shards |
| `edge_count()` | O(N) | Sum over N shards |
| `shard_stats()` | O(N) | Per-shard stats |

**Key insight:** All query operations scale linearly with shard_count (O(N)). For L0 with N=8, this is 8x overhead. Acceptable for correctness-first implementation. Optimization in T4.x.

---

## 5. Step-by-Step Implementation Phases

### Phase 1: ShardPlanner (150 LOC, 5 tests)

**File:** `packages/rfdb-server/src/storage_v2/shard_planner.rs`

**Functions:**
1. `ShardPlanner::new(shard_count)` — 5 LOC
2. `ShardPlanner::compute_shard_id(file_path)` — 15 LOC
3. `ShardPlanner::plan(files)` — 20 LOC
4. Tests — 110 LOC

**Tests:**
1. `test_compute_shard_id_deterministic` — Same file path → same shard_id across calls
2. `test_compute_shard_id_same_directory` — Files in same dir → same shard
3. `test_compute_shard_id_different_directories` — Files in different dirs → likely different shards
4. `test_plan_groups_by_shard` — `plan()` returns HashMap grouped by shard_id
5. `test_plan_every_file_assigned` — Every file in input appears exactly once in output

**Estimated time:** 1-2 hours

### Phase 2: DatabaseConfig (80 LOC, 3 tests)

**File:** `packages/rfdb-server/src/storage_v2/multi_shard.rs` (top of file)

**Functions:**
1. `DatabaseConfig::new(shard_count)` — 10 LOC
2. `DatabaseConfig::read_from(db_path)` — 10 LOC
3. `DatabaseConfig::write_to(db_path)` — 15 LOC (atomic write pattern)
4. Tests — 45 LOC

**Tests:**
1. `test_config_roundtrip` — Write → read → verify same data
2. `test_config_read_nonexistent` — Error on missing file
3. `test_config_atomic_write` — Verify temp file + rename pattern

**Estimated time:** 1 hour

### Phase 3: MultiShardStore Core (400 LOC, 8 tests)

**File:** `packages/rfdb-server/src/storage_v2/multi_shard.rs`

**Functions:**
1. `MultiShardStore::create(db_path, shard_count)` — 40 LOC
2. `MultiShardStore::ephemeral(shard_count)` — 20 LOC
3. `MultiShardStore::open(db_path, manifest_store)` — 60 LOC
4. `MultiShardStore::add_nodes(records)` — 30 LOC
5. `MultiShardStore::add_edges(records)` — 30 LOC
6. `MultiShardStore::flush_all(manifest_store)` — 60 LOC
7. Tests — 160 LOC

**Tests:**
1. `test_create_multi_shard_db` — Create with N=8, verify directories + config
2. `test_ephemeral_multi_shard` — Ephemeral with N=4, add/query data
3. `test_add_nodes_distributes_by_directory` — Nodes in same dir → same shard
4. `test_add_edges_routes_to_source_shard` — Edge A→B stored in shard containing A
5. `test_add_edges_src_not_found_error` — Error if edge.src node doesn't exist
6. `test_flush_all_commits_manifest` — Flush → manifest contains all shards' segments
7. `test_flush_empty_shards_skipped` — Shards with no data don't create segments
8. `test_open_existing_db` — Create → flush → close → open → verify data

**Estimated time:** 3-4 hours

### Phase 4: Query Fan-Out (160 LOC, 4 tests)

**File:** `packages/rfdb-server/src/storage_v2/multi_shard.rs`

**Functions:**
1. `MultiShardStore::get_node(id)` — 15 LOC
2. `MultiShardStore::node_exists(id)` — 10 LOC
3. `MultiShardStore::find_nodes(type, file)` — 30 LOC
4. `MultiShardStore::get_outgoing_edges(id, types)` — 20 LOC
5. `MultiShardStore::get_incoming_edges(id, types)` — 20 LOC
6. `MultiShardStore::{node_count, edge_count, shard_stats}()` — 15 LOC
7. Tests — 50 LOC

**Tests:**
1. `test_get_node_finds_across_shards` — Add nodes to different shards, get_node finds them
2. `test_find_nodes_deduplicates` — No duplicate node IDs in results
3. `test_cross_shard_edges_queryable` — Edge A→B where A in shard0, B in shard7
4. `test_incoming_edges_fans_out` — Incoming edges query hits all shards

**Estimated time:** 2-3 hours

### Phase 5: Integration Tests (150 LOC, 5 tests)

**File:** `packages/rfdb-server/src/storage_v2/multi_shard.rs` (test module)

**Tests:**
1. `test_equivalence_single_vs_multi_shard` — Same data in single-shard vs 8-shard → identical query results
2. `test_full_lifecycle` — Create → add → flush → close → open → query
3. `test_uneven_distribution` — 100 files, 80 in `src/` → verify no crash
4. `test_empty_shards_ok` — N=8, only 3 files → 5 empty shards don't break queries
5. `test_node_to_shard_mapping_persistent` — Add nodes → flush → open → node_to_shard still valid

**Estimated time:** 2 hours

### Phase 6: Export + Documentation (50 LOC)

**File:** `packages/rfdb-server/src/storage_v2/mod.rs`

**Changes:**
```rust
pub mod shard_planner;
pub mod multi_shard;

pub use shard_planner::ShardPlanner;
pub use multi_shard::{MultiShardStore, DatabaseConfig};
```

**Documentation:** Update module-level doc comments.

**Estimated time:** 30 minutes

---

## 6. Design Decisions

### 6.1. Why blake3 instead of seahash?

**Don's plan suggested seahash, but it's not in Cargo.toml.**

Options:
1. Add seahash as dependency (~50 LOC, ~2.5GB/s)
2. Use `std::hash::DefaultHasher` (SipHash, non-deterministic across Rust versions)
3. Use `blake3` (already available, ~3GB/s, deterministic)

**Decision:** blake3. It's already a dependency, it's faster than seahash, and it's cryptographically deterministic (same input → same output across all platforms/versions/builds).

**Tradeoff:** blake3 is overkill for partitioning (we don't need crypto properties). But:
- No new dependency
- Determinism is critical
- Performance is excellent (~500ns per hash for 100-byte paths)

### 6.2. Why DatabaseConfig in multi_shard.rs, not config.rs?

**Don's plan suggested separate `config.rs` file.**

**Decision:** Keep it in `multi_shard.rs`. Rationale:
- Config is 30 LOC total (struct + read + write)
- Only used by MultiShardStore
- Separate file is premature abstraction for L0

**Future:** If we add more database-level config (compression settings, bloom filter tuning), extract to `config.rs` then.

### 6.3. Why node_to_shard HashMap?

**Problem:** `EdgeRecordV2` only has `src: u128`, not file path. To route edges to the correct shard, we need to know which shard contains the source node.

**Options:**
1. Require caller to provide shard_id with each edge (breaks API)
2. Require EdgeRecordV2 to include file path (changes type definition)
3. Maintain `HashMap<u128, u16>` mapping node ID → shard_id

**Decision:** Option 3. Updated in `add_nodes`, queried in `add_edges`.

**Memory cost:** 10 bytes per node (u128 + u16). For 1M nodes: ~10MB. Acceptable.

**Alternative considered:** Store file path in EdgeRecordV2. Rejected because:
- Increases edge record size (~100 bytes per edge)
- Duplicates file path data (already in source node)
- Breaks existing type definition

### 6.4. Why sequential flush, not parallel?

**Don's plan noted rayon is available for parallel flush.**

**Decision:** Sequential for L0. Rationale:
- ManifestStore is single-threaded (no lock-free manifest updates)
- Segment ID allocation needs coordination (single counter in ManifestStore)
- Correctness first, parallelism in T4.x

**Future:** T4.x adds atomic segment ID counter + parallel flush with rayon.

### 6.5. Why no shard-aware query routing?

**Example:** If query specifies `file="src/routes/api.js"`, only query the shard containing `src/routes/`.

**Decision:** Not in L0. Rationale:
- Adds complexity (need to track directory→shard mapping)
- Invalidation is tricky (what if directory moves between shards after refactoring?)
- O(N) fan-out is acceptable for N=8

**Future:** T4.x adds shard-aware routing with cache invalidation.

### 6.6. Why no shards/ directories?

**Don's plan had `shards/00/`, `shards/01/` directories.**

**Decision:** Not needed for L0. Rationale:
- `Shard::create(path)` already creates its directory
- Shard path IS the shard directory
- Segments go in `segments/00/`, `segments/01/` (already supported by SegmentDescriptor::file_path)

**Directory layout for L0:**
```
mydb.rfdb/
├── db_config.json             # shard_count, version
├── current.json               # Manifest pointer
├── manifest_index.json        # Manifest index
├── manifests/
│   ├── 000001.json
│   └── 000002.json
└── segments/
    ├── 00/                    # Shard 0 segments
    │   ├── seg_000001_nodes.seg
    │   └── seg_000002_edges.seg
    └── 01/                    # Shard 1 segments
        └── seg_000003_nodes.seg
```

No `shards/` directory. Shard state is ephemeral (write buffer only).

---

## 7. What NOT To Do

### 7.1. No Query Optimization

**Excluded:**
- Shard-aware routing (skip shards based on file filter)
- Parallel fan-out with rayon
- Caching of file→shard mapping

**Why:** L0 is correctness. Optimization in T4.x after we have real workload data.

### 7.2. No Resharding

**Excluded:**
- Changing shard_count after database creation
- Rebalancing shards (moving files between shards)

**Why:** Resharding is operational feature (T5.x). For L0, shard_count is immutable.

**If user creates with shard_count=2 and later needs 64:**
- Create new database with shard_count=64
- Copy data from old to new (T5.x: add `grafema migrate-shards` command)

### 7.3. No Per-Shard WAL

**Excluded:**
- Write-ahead log for crash recovery
- Concurrent writes to different shards

**Why:** ManifestStore provides crash recovery via atomic current.json. Per-shard WAL is optimization for concurrent writes (T4.x).

### 7.4. No Cross-Shard Transactions

**Excluded:**
- Atomic writes spanning multiple shards
- Two-phase commit for multi-shard flush

**Why:** RFDB is append-only. All writes go to write buffers, then flush atomically via single manifest commit. Cross-shard transactions are unnecessary.

### 7.5. No Cross-Shard Edge Index

**Excluded:**
- Reverse index mapping dst → list of shards with incoming edges
- Optimization for incoming edge queries

**Why:** Incoming edge queries fan out to all shards. For L0 with N=8, this is acceptable. Optimization in T4.x.

---

## 8. File Changes Summary

### New Files

1. `packages/rfdb-server/src/storage_v2/shard_planner.rs` — 150 LOC
2. Add to `packages/rfdb-server/src/storage_v2/multi_shard.rs` — 690 LOC

### Modified Files

1. `packages/rfdb-server/src/storage_v2/mod.rs` — +2 lines (exports)

### Total Changes

- **New code:** 840 LOC
- **Tests:** 200 LOC (included in above)
- **Modified:** 2 LOC
- **Total:** 842 LOC

---

## 9. Test Plan

### 9.1. ShardPlanner Tests (5 tests)

1. **test_compute_shard_id_deterministic**
   - Verify: same file path → same shard_id across 100 calls
   - Verifies: blake3 determinism

2. **test_compute_shard_id_same_directory**
   - Files: `src/a.js`, `src/b.js`, `src/c.js`
   - Verify: all map to same shard_id
   - Verifies: directory-based partitioning

3. **test_compute_shard_id_different_directories**
   - Files: `src/a.js`, `lib/b.js`, `test/c.js`
   - Verify: likely map to different shards (probabilistic, not guaranteed)
   - Verifies: hash distribution

4. **test_plan_groups_by_shard**
   - Files: 20 files across 5 directories
   - Verify: `plan()` returns HashMap<shard_id, Vec<file>>
   - Verify: sum of vec lengths = 20

5. **test_plan_every_file_assigned**
   - Files: 100 random file paths
   - Verify: every input file appears exactly once in output

### 9.2. DatabaseConfig Tests (3 tests)

1. **test_config_roundtrip**
   - Create config with shard_count=8
   - Write to temp dir
   - Read back
   - Verify: shard_count, version, created_at match

2. **test_config_read_nonexistent**
   - Try to read from nonexistent path
   - Verify: returns error (not panic)

3. **test_config_atomic_write**
   - Write config
   - Verify: temp file was created and deleted
   - Verify: final file exists

### 9.3. MultiShardStore Core Tests (8 tests)

1. **test_create_multi_shard_db**
   - Create with shard_count=8
   - Verify: db_config.json exists and has shard_count=8
   - Verify: segments/00/ through segments/07/ don't exist yet (created on flush)

2. **test_ephemeral_multi_shard**
   - Create ephemeral with shard_count=4
   - Add 100 nodes, 200 edges
   - Query: get_node, find_nodes
   - Verify: all data queryable

3. **test_add_nodes_distributes_by_directory**
   - Add 30 nodes: 10 in `src/`, 10 in `lib/`, 10 in `test/`
   - Check shard_stats()
   - Verify: nodes grouped by directory

4. **test_add_edges_routes_to_source_shard**
   - Add node A in `src/` (→ shard 0)
   - Add node B in `lib/` (→ shard 1)
   - Add edge A→B
   - Flush
   - Verify: edge is in shard 0's edge segment

5. **test_add_edges_src_not_found_error**
   - Add node B
   - Try to add edge A→B (where A doesn't exist)
   - Verify: returns error

6. **test_flush_all_commits_manifest**
   - Add nodes/edges to 3 different shards
   - Flush
   - Read manifest
   - Verify: manifest contains segments with shard_id=0, 1, 2

7. **test_flush_empty_shards_skipped**
   - Create with shard_count=8
   - Add data only to shards 0, 1, 2
   - Flush
   - Verify: manifest only has segments for shards 0, 1, 2

8. **test_open_existing_db**
   - Create → add data → flush → drop store
   - Open with manifest_store
   - Query: get_node, find_nodes
   - Verify: all data queryable

### 9.4. Query Fan-Out Tests (4 tests)

1. **test_get_node_finds_across_shards**
   - Add 80 nodes distributed across 8 shards
   - For each node: get_node(id) → verify found
   - Verifies: point lookup fan-out

2. **test_find_nodes_deduplicates**
   - Add same node to buffer
   - Flush
   - Add updated version to buffer (upsert)
   - find_nodes(type, file)
   - Verify: only 1 result, buffer version wins

3. **test_cross_shard_edges_queryable**
   - Node A in shard 0 (`src/a.js`)
   - Node B in shard 7 (`lib/b.js`)
   - Edge A→B
   - Flush
   - get_outgoing_edges(A) → verify finds edge
   - get_incoming_edges(B) → verify finds edge

4. **test_incoming_edges_fans_out**
   - Node Z in shard 5
   - Edges from 10 different nodes (in different shards) → Z
   - Flush
   - get_incoming_edges(Z)
   - Verify: finds all 10 edges

### 9.5. Integration Tests (5 tests)

1. **test_equivalence_single_vs_multi_shard**
   - Generate 1000 nodes, 5000 edges (random data)
   - Build single-shard store
   - Build 8-shard store (same data)
   - Compare query results:
     - get_node for 100 random IDs
     - find_nodes(type) for 5 types
     - get_outgoing_edges for 50 random nodes
   - Verify: results identical (modulo order)

2. **test_full_lifecycle**
   - Create → add 100 nodes → flush → close
   - Open → query → verify data
   - Add 100 more nodes → flush → close
   - Open → query → verify 200 nodes

3. **test_uneven_distribution**
   - 100 files: 80 in `src/`, 10 in `lib/`, 10 in `test/`
   - Add nodes
   - Check shard_stats()
   - Verify: one shard is "hot" (has most data)
   - Verify: all queries work correctly

4. **test_empty_shards_ok**
   - Create with shard_count=8
   - Add only 3 nodes (each in different dir → likely 3 different shards)
   - Flush
   - Query: get_node, find_nodes
   - Verify: no crashes, all data queryable

5. **test_node_to_shard_mapping_persistent**
   - Add nodes → node_to_shard populated
   - Flush → close
   - Open → node_to_shard should still be valid
   - Add edges referencing old nodes
   - Verify: edges route to correct shards

**CORRECTION:** Test 5 reveals a design gap. `node_to_shard` is NOT persisted. After open, it's empty. Need to rebuild it on open.

**Solution:** In `MultiShardStore::open`, after loading segments, scan all shards' node segments and rebuild `node_to_shard`:

```rust
// After opening all shards
for (shard_idx, shard) in shards.iter().enumerate() {
    let nodes = shard.find_nodes(None, None); // Get all nodes
    for node in nodes {
        node_to_shard.insert(node.id, shard_idx as u16);
    }
}
```

**Complexity:** O(total_nodes). Acceptable for L0.

**Updated test 5:**
- Add nodes → flush → close
- Open → verify node_to_shard rebuilt
- Add edges → verify route to correct shards

---

## 10. Corner Cases & Error Handling

### 10.1. Empty Shards

**Scenario:** shard_count=8, but only 3 files added.

**Behavior:**
- 5 shards have empty write buffers
- `flush_all()` skips empty shards (no segments created)
- Manifest only contains segments for 3 active shards
- Queries work correctly (fan-out to all 8, empty shards return empty results)

**Test:** `test_empty_shards_ok`

### 10.2. Edge with Missing Source Node

**Scenario:** `add_edges([Edge(src=123, dst=456)])` where node 123 doesn't exist.

**Behavior:**
- `add_edges` looks up 123 in `node_to_shard`
- Key not found → returns error: `GraphError::InvalidOperation("Edge src node 123 not found")`

**Test:** `test_add_edges_src_not_found_error`

### 10.3. Shard Count Mismatch

**Scenario:** Database created with shard_count=8, config file manually edited to shard_count=4.

**Behavior:**
- `open()` reads config → shard_count=4
- Tries to open 4 shards
- Manifest has segments with shard_id=0..7
- Error: segments reference nonexistent shards

**Mitigation:** Add validation in `open()`:
```rust
let max_shard_id = manifest.node_segments.iter()
    .chain(manifest.edge_segments.iter())
    .filter_map(|d| d.shard_id)
    .max()
    .unwrap_or(0);

if max_shard_id >= config.shard_count {
    return Err(GraphError::InvalidFormat(
        format!("Manifest references shard {} but shard_count is {}",
                max_shard_id, config.shard_count)
    ));
}
```

**Test:** `test_shard_count_mismatch` (add to Phase 5)

### 10.4. Duplicate Node IDs Across Shards

**Scenario:** Bug causes same node to be added to two different shards.

**Behavior:**
- `find_nodes` uses HashSet dedup → first shard's version wins
- `get_node` uses early exit → first shard's version wins

**Mitigation:** This is a bug if it happens. Write buffer dedup prevents it:
- Node ID is derived from file path
- File path determines shard
- Same node ID → same file → same shard

**Test:** No explicit test (this would be testing a bug that shouldn't exist)

### 10.5. Uneven Distribution (Hot Shard)

**Scenario:** 90% of files in one directory → one shard gets 90% of data.

**Behavior:**
- Queries still work (fan-out is uniform)
- Hot shard takes longer to flush (more data)
- Hot shard segments larger (more bloom filter checks)

**Mitigation:** None for L0. This is expected behavior. Future: monitor shard balance, recommend resharding if one shard >10x others.

**Test:** `test_uneven_distribution`

---

## 11. Performance Estimates

### Write Path

| Operation | Per-Record Cost | Notes |
|-----------|----------------|-------|
| `add_nodes(1 node)` | ~1.5 μs | blake3 hash (0.5 μs) + HashMap insert (1 μs) |
| `add_edges(1 edge)` | ~0.5 μs | HashMap lookup + Vec push |
| `flush_all(N shards)` | N * 50ms | Sequential flush, 50ms per shard |

**Example:** 10k nodes + 50k edges + flush:
- add_nodes: 10k * 1.5 μs = 15ms
- add_edges: 50k * 0.5 μs = 25ms
- flush_all (N=8): 8 * 50ms = 400ms
- **Total: 440ms**

### Read Path

| Operation | Cost | Notes |
|-----------|------|-------|
| `get_node(id)` | ~10 μs | N=8 shards * ~1 μs bloom check, early exit |
| `find_nodes(type)` | ~N * 5ms | N shards * segment scan |
| `get_outgoing_edges(id)` | ~10 μs | Bloom filters prune most shards |
| `get_incoming_edges(id)` | ~N * 5ms | No bloom prune on dst, scan all |

**Example queries:**
- Point lookup: 10 μs
- Attribute search: 8 * 5ms = 40ms (for 10k-node database)
- Neighbor query: 10 μs (outgoing), 40ms (incoming)

### Memory

| Component | Size | Notes |
|-----------|------|-------|
| `node_to_shard` | 10 bytes/node | u128 + u16, for 1M nodes: ~10MB |
| Write buffers (N shards) | ~1MB/shard | Flushed regularly |
| Loaded segments | mmap (not in RAM) | Virtual memory only |

**Total for 1M nodes, 8 shards:** ~10MB + 8MB = 18MB.

---

## 12. Risk Analysis

### Risk 1: Uneven Shard Distribution

**Likelihood:** Medium (depends on directory structure)

**Impact:** Low for L0 (performance, not correctness)

**Mitigation:**
- Monitor shard balance in tests
- Log warning if one shard >10x others
- Document recommended directory structure (avoid deep nesting under one root)

**Acceptance criteria:** Even if one shard has 90% of data, all queries must work correctly.

### Risk 2: node_to_shard Rebuild Cost on Open

**Likelihood:** Certain (happens on every open)

**Impact:** Low for small databases, medium for large (1M nodes = ~1s rebuild)

**Mitigation:**
- Accept cost for L0
- T4.x: persist node_to_shard to disk (separate file or in manifest)

**Acceptance criteria:** open() time scales linearly with node count.

### Risk 3: Edge Routing Requires node_to_shard

**Likelihood:** Certain

**Impact:** Medium (memory cost, rebuild cost)

**Alternative considered:** Store file path in EdgeRecordV2. Rejected due to memory cost (100 bytes/edge vs 10 bytes/node).

**Acceptance criteria:** Add nodes → add edges must work without caller tracking shard IDs.

### Risk 4: Sequential Flush Bottleneck

**Likelihood:** Medium (depends on data volume)

**Impact:** Medium (flush latency scales with shard count)

**Mitigation:**
- For L0, N=8, flush time is 8 * 50ms = 400ms (acceptable)
- T4.x: parallel flush with atomic segment ID counter

**Acceptance criteria:** flush_all() completes in <1s for typical workload (100k records).

### Risk 5: ManifestStore Scales to 8x Segments

**Likelihood:** Low (manifest is JSON, scales to millions of segments)

**Impact:** Low (slightly larger manifest file)

**Mitigation:**
- Monitor manifest file size in tests
- Acceptable up to 10MB manifest

**Acceptance criteria:** Manifest commit time <100ms even with 1000 segments.

---

## 13. Success Criteria

### Correctness

1. **Determinism:** Same files → same shard plan (100 runs, 0 variance)
2. **Completeness:** Every file assigned exactly once
3. **Query correctness:** Multi-shard results identical to single-shard (modulo order)
4. **Cross-shard edges:** Edge A→B queryable regardless of shard placement
5. **Persistence:** Flush → close → open → all data queryable

### Performance

1. **Point lookup:** <20 μs average (N=8 shards, bloom filters working)
2. **Attribute search:** <100ms for 10k-node database
3. **Flush time:** <1s for 100k records (N=8 shards)

### Robustness

1. **Empty shards:** No crashes, all queries work
2. **Uneven distribution:** No crashes, hot shard doesn't break queries
3. **Edge routing errors:** Clear error message if src node not found

---

## 14. Integration with Existing Code

### ManifestStore

**Already supports sharding** via `SegmentDescriptor.shard_id: Option<u16>`.

No changes needed. MultiShardStore uses existing API:
```rust
let desc = SegmentDescriptor::from_meta(
    segment_id,
    SegmentType::Nodes,
    Some(shard_id),  // ← Already supported
    meta,
);
manifest_store.commit(node_descs, edge_descs)?;
```

### Shard

**Already supports shard_id** in constructor (though unused in RFD-6).

No changes needed. MultiShardStore creates shards:
```rust
let shard = Shard::create(&shard_path)?;
```

### Segment File Paths

**Already supports shard_id** via `SegmentDescriptor::file_path()`:
```rust
// If shard_id = Some(5):
// → "segments/05/seg_000001_nodes.seg"
```

No changes needed.

---

## 15. Future Extensions (T4.x+)

### Shard-Aware Query Routing

**Idea:** If query specifies `file="src/routes/api.js"`, only query the shard containing `src/routes/`.

**Benefit:** Skip N-1 shards, O(1) query instead of O(N).

**Complexity:**
- Need to track directory→shard mapping
- Invalidation if directory moves
- Cache coherency

**Decision:** Defer to T4.x after measuring real query patterns.

### Parallel Fan-Out with rayon

**Idea:** Use `rayon::par_iter()` to query all shards in parallel.

**Benefit:** O(1) fan-out time instead of O(N).

**Complexity:**
- Need to ensure Shard is Send+Sync (currently !Send)
- Thread pool management

**Decision:** Defer to T4.x.

### Cross-Shard Edge Index

**Idea:** During flush, build reverse index mapping dst → list of shards with incoming edges.

**Benefit:** Incoming edge queries skip shards with no incoming edges.

**Complexity:**
- Index maintenance
- Invalidation on updates

**Decision:** Defer to T4.x. Bloom filter pruning is good enough for L0.

### Persist node_to_shard

**Idea:** Store node_to_shard mapping in separate file (e.g., `node_shard_map.bin`).

**Benefit:** Skip rebuild on open (faster startup).

**Complexity:**
- Need to update file on every flush
- Atomic write protocol

**Decision:** Defer to T4.x after measuring open() cost on large databases.

---

## 16. Open Questions (Resolved)

### Q1: How to route edges without file path?

**Answer:** Maintain `node_to_shard: HashMap<u128, u16>`. Updated in `add_nodes`, queried in `add_edges`.

### Q2: Where do segment files go?

**Answer:** `segments/00/`, `segments/01/`, etc. Already supported by `SegmentDescriptor::file_path()`.

### Q3: Do we need shards/ directories?

**Answer:** No. Shard path IS the shard directory. Shard state is ephemeral (write buffer only).

### Q4: How to rebuild node_to_shard on open?

**Answer:** Scan all shards' node segments, rebuild mapping. O(total_nodes), acceptable for L0.

### Q5: What if shard_count changes?

**Answer:** Error on open (validation check). Resharding is T5.x.

---

## Conclusion

Multi-shard layer is a **transparent abstraction** over single-shard. API stays the same, just fan-out internally. ManifestStore already supports sharding. Directory-based partitioning exploits file locality.

**Key invariants:**
- Same files → same plan (deterministic)
- Every file in exactly one shard (completeness)
- Query results identical to single-shard (correctness)
- Manifest commit is atomic (crash safety)

**Estimated timeline:** 8-10 hours implementation + 2 hours testing = **10-12 hours total** (~1.5 days).

**Ready for Kent Beck to write tests.**
