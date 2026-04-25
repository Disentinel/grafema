# RFD-8: T3.1 Tombstones + Batch Commit -- Joel's Tech Spec

> Date: 2026-02-14
> Author: Joel Spolsky (Implementation Planner)
> Based on: Don's Plan (002-don-plan.md)
> Status: Ready for Steve Jobs review

---

## 0. Scope

Add tombstone-based deletion and batch commit to RFDB v2 storage. When files are re-analyzed, old nodes and edges are tombstoned (logically deleted) and new data is written atomically via `commit_batch()`. Tombstones are in-memory HashSets persisted in manifests, not separate segment files.

**Total budget:** ~600 LOC across 5 commits, ~35 tests.

**What this spec DOES cover:**
- `TombstoneSet` struct in `shard.rs` for tombstone state
- Tombstone fields on `Manifest` with backward-compatible serde
- Query path changes in `Shard` (all 5 read methods)
- `find_edge_keys_by_src_ids()` on `Shard` and `MultiShardStore` (bloom-assisted)
- `CommitDelta` struct and `enrichment_file_context()` helper in `types.rs`
- `commit_batch()` on `MultiShardStore`
- Tombstone accumulation across manifests

**What this spec does NOT cover:**
- Compaction (T4.x): physically removing tombstoned records
- Wire protocol (T4.1): `BeginBatch`/`CommitBatch`/`AbortBatch` commands
- `BatchState` struct: per-connection staging lives in the connection layer, outside storage_v2
- Concurrent batch isolation: `commit_batch` takes `&mut self`, so commits are serialized

**CRITICAL CORRECTIONS to Don's plan:**

1. **`add_nodes()` returns `()`**, not `Result<()>`. Don's plan is correct on this point. Actual signature: `pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>)`.
2. **`flush_all()` returns `Result<usize>`** (number of flushed shards), not `Result<()>`. The `commit_batch()` implementation must account for this.
3. **`ManifestStore::create_manifest()` takes 3 args:** `(node_segments, edge_segments, tags: Option<HashMap<String, String>>)` -- not a `Manifest` struct. Tags go here, not tombstones. Tombstones must be set directly on the `Manifest` struct AFTER `create_manifest()` returns it.
4. **`Shard` fields are private.** We cannot access `shard.write_buffer` or `shard.edge_segments` from `MultiShardStore`. The `find_edge_keys_by_src_ids()` method MUST live on `Shard`, with a fan-out wrapper on `MultiShardStore`.
5. **`Manifest` struct needs tombstone fields set BETWEEN `create_manifest()` and `commit()`.** The `create_manifest` method constructs the manifest with `version = current + 1` but does NOT set tombstones. We mutate the returned `Manifest` before calling `commit()`.
6. **`all_node_ids()` already exists on `Shard`** and returns `Vec<u128>`. We must add `all_node_ids()` to `MultiShardStore` for completeness, OR use existing per-shard iteration.

---

## 1. Exact Data Structures

### 1.1. TombstoneSet (`shard.rs`)

```rust
use std::collections::HashSet;

/// Tombstone state for a shard.
///
/// In-memory set of logically deleted node IDs and edge keys.
/// Persisted in manifest, loaded on shard open.
/// Cleared when compaction (T4.x) physically removes records.
///
/// Query paths check this set before returning any record.
/// O(1) per check via HashSet.
pub struct TombstoneSet {
    /// Deleted node IDs. Queries skip records with these IDs.
    pub node_ids: HashSet<u128>,
    /// Deleted edge keys (src, dst, edge_type). Queries skip matching edges.
    pub edge_keys: HashSet<(u128, u128, String)>,
}

impl TombstoneSet {
    /// Create empty tombstone set.
    pub fn new() -> Self {
        Self {
            node_ids: HashSet::new(),
            edge_keys: HashSet::new(),
        }
    }

    /// Create from manifest data (loaded on shard open).
    pub fn from_manifest(
        node_ids: Vec<u128>,
        edge_keys: Vec<(u128, u128, String)>,
    ) -> Self {
        Self {
            node_ids: node_ids.into_iter().collect(),
            edge_keys: edge_keys.into_iter().collect(),
        }
    }

    /// Check if a node ID is tombstoned.
    #[inline]
    pub fn contains_node(&self, id: u128) -> bool {
        self.node_ids.contains(&id)
    }

    /// Check if an edge key is tombstoned.
    #[inline]
    pub fn contains_edge(&self, src: u128, dst: u128, edge_type: &str) -> bool {
        // Avoid allocating String for every check.
        // HashSet<(u128, u128, String)> requires owned key for lookup.
        // Use a borrowed lookup via the raw HashSet API isn't available,
        // so we construct the key. This is O(1) amortized, acceptable
        // because edge_type strings are short (<50 bytes).
        self.edge_keys.contains(&(src, dst, edge_type.to_string()))
    }

    /// Add tombstoned node IDs (union with existing).
    pub fn add_nodes(&mut self, ids: impl IntoIterator<Item = u128>) {
        self.node_ids.extend(ids);
    }

    /// Add tombstoned edge keys (union with existing).
    pub fn add_edges(&mut self, keys: impl IntoIterator<Item = (u128, u128, String)>) {
        self.edge_keys.extend(keys);
    }

    /// Number of tombstoned nodes.
    pub fn node_count(&self) -> usize {
        self.node_ids.len()
    }

    /// Number of tombstoned edges.
    pub fn edge_count(&self) -> usize {
        self.edge_keys.len()
    }

    /// True if no tombstones.
    pub fn is_empty(&self) -> bool {
        self.node_ids.is_empty() && self.edge_keys.is_empty()
    }
}

impl Default for TombstoneSet {
    fn default() -> Self {
        Self::new()
    }
}
```

**Design rationale:**
- Separate struct (not inlined into Shard) for testability and clarity.
- `contains_edge` allocates a String for the lookup key. This is acceptable because: (a) edge type strings are short, (b) the allocation is O(1) amortized, (c) optimizing with a custom hash/borrowed lookup is premature for L0. If profiling shows this is hot, we can switch to a `HashSet<(u128, u128, u64)>` where the u64 is a hash of the edge_type string.
- `from_manifest` converts `Vec` to `HashSet` in O(N). Called once per shard open.

### 1.2. Manifest Tombstone Fields (`manifest.rs`)

New fields on `Manifest`:

```rust
pub struct Manifest {
    // ... existing fields (version, created_at, node_segments, etc.) ...

    /// Tombstoned node IDs (logically deleted).
    /// Query path skips records matching these IDs.
    /// Cleared by compaction (T4.x).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tombstoned_node_ids: Vec<u128>,

    /// Tombstoned edge keys (src, dst, edge_type).
    /// Query path skips matching edges.
    /// Cleared by compaction (T4.x).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tombstoned_edge_keys: Vec<(u128, u128, String)>,
}
```

**Design rationale:**
- `Vec` not `HashSet` for serde: JSON serialization of HashSet is unordered and non-deterministic. Using Vec ensures deterministic manifests (important for diffing/debugging). Conversion to HashSet happens at load time.
- `#[serde(default)]` ensures old manifests without tombstone fields load correctly (empty Vec).
- `#[serde(skip_serializing_if = "Vec::is_empty")]` avoids bloating manifests when no tombstones exist.
- Database-wide (not per-shard): a tombstoned node ID means "deleted regardless of shard."

### 1.3. Shard Tombstone Field (`shard.rs`)

New field on `Shard`:

```rust
pub struct Shard {
    // ... existing fields ...

    /// Tombstone state (loaded from manifest on open).
    tombstones: TombstoneSet,
}
```

All constructors (`create`, `open`, `ephemeral`, `create_for_shard`, `open_for_shard`) initialize `tombstones: TombstoneSet::new()`. The `open_for_shard` variant will accept tombstone data as a parameter after Phase 4 integration.

### 1.4. CommitDelta (`types.rs`)

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Structured diff returned by `MultiShardStore::commit_batch()`.
///
/// Describes what changed in this commit: files, node counts, edge types.
/// Used by the Grafema pipeline to determine which enrichment passes
/// need to re-run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDelta {
    /// Files that were committed in this batch.
    pub changed_files: Vec<String>,

    /// Number of nodes added (new, not in previous snapshot).
    pub nodes_added: u64,

    /// Number of nodes removed (tombstoned from previous snapshot).
    pub nodes_removed: u64,

    /// Number of nodes modified (same id, different content_hash).
    pub nodes_modified: u64,

    /// IDs of removed (tombstoned) nodes.
    pub removed_node_ids: Vec<u128>,

    /// Node types affected (from both added and removed nodes).
    pub changed_node_types: HashSet<String>,

    /// Edge types affected (from both added and tombstoned edges).
    pub changed_edge_types: HashSet<String>,

    /// Manifest version after this commit.
    pub manifest_version: u64,
}
```

**Design rationale:**
- `Serialize`/`Deserialize` so CommitDelta can be sent over wire protocol (T4.1).
- `removed_node_ids: Vec<u128>` -- needed by enrichment pipeline to know which nodes disappeared.
- `changed_node_types` / `changed_edge_types` -- enrichment pipeline uses these to decide which passes need re-run (e.g., if FUNCTION nodes changed, re-run call graph enrichment).
- `nodes_modified` uses content_hash comparison (I4): if old and new node have same id but different content_hash (both non-zero), it's a modification.

### 1.5. Enrichment File Context Helper (`types.rs`)

```rust
/// Construct the file context path for enrichment data.
///
/// Convention: `__enrichment__/{enricher}/{source_file}`
///
/// When `source_file` is re-analyzed, the caller includes the enrichment
/// file context in `changed_files` so old enrichment data is tombstoned.
///
/// # Examples
///
/// ```
/// assert_eq!(
///     enrichment_file_context("data-flow", "src/utils.js"),
///     "__enrichment__/data-flow/src/utils.js"
/// );
/// ```
pub fn enrichment_file_context(enricher: &str, source_file: &str) -> String {
    format!("__enrichment__/{}/{}", enricher, source_file)
}
```

---

## 2. Complete API Signatures

### 2.1. TombstoneSet API (new, `shard.rs`)

```rust
impl TombstoneSet {
    pub fn new() -> Self;
    pub fn from_manifest(node_ids: Vec<u128>, edge_keys: Vec<(u128, u128, String)>) -> Self;
    pub fn contains_node(&self, id: u128) -> bool;              // O(1)
    pub fn contains_edge(&self, src: u128, dst: u128, edge_type: &str) -> bool; // O(1)
    pub fn add_nodes(&mut self, ids: impl IntoIterator<Item = u128>);
    pub fn add_edges(&mut self, keys: impl IntoIterator<Item = (u128, u128, String)>);
    pub fn node_count(&self) -> usize;
    pub fn edge_count(&self) -> usize;
    pub fn is_empty(&self) -> bool;
}
```

### 2.2. Modified Shard Methods (changed, `shard.rs`)

Existing methods that need tombstone checks (all read methods):

```rust
impl Shard {
    // MODIFIED: check tombstones.contains_node(id) FIRST
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2>;

    // MODIFIED: check tombstones.contains_node(id) FIRST
    pub fn node_exists(&self, id: u128) -> bool;

    // MODIFIED: skip tombstoned node IDs in results
    pub fn find_nodes(&self, node_type: Option<&str>, file: Option<&str>) -> Vec<NodeRecordV2>;

    // MODIFIED: skip tombstoned edge keys in results
    pub fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecordV2>;

    // MODIFIED: skip tombstoned edge keys in results
    pub fn get_incoming_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecordV2>;

    // MODIFIED: exclude tombstoned node IDs
    pub fn all_node_ids(&self) -> Vec<u128>;
}
```

### 2.3. New Shard Methods (`shard.rs`)

```rust
impl Shard {
    /// Set tombstone state (called by MultiShardStore after commit).
    ///
    /// Replaces the entire tombstone set. Used when loading from manifest
    /// or after commit_batch updates tombstones.
    ///
    /// Complexity: O(1) (pointer swap)
    pub fn set_tombstones(&mut self, tombstones: TombstoneSet);

    /// Get reference to current tombstone set (for reading).
    pub fn tombstones(&self) -> &TombstoneSet;

    /// Find edge keys (src, dst, edge_type) where src is in the given ID set.
    ///
    /// Uses bloom filter on each edge segment for pre-filtering.
    /// Also scans write buffer.
    ///
    /// Returns Vec of (src, dst, edge_type) tuples for tombstoning.
    ///
    /// Complexity: O(S * (B + N_matching))
    ///   where S = edge segments, B = bloom check per ID, N_matching = records in matching segments
    pub fn find_edge_keys_by_src_ids(
        &self,
        src_ids: &HashSet<u128>,
    ) -> Vec<(u128, u128, String)>;
}
```

### 2.4. New MultiShardStore Methods (`multi_shard.rs`)

```rust
impl MultiShardStore {
    /// Find edge keys with src in the given ID set, across all shards.
    ///
    /// Fan-out to all shards, merge results.
    ///
    /// Complexity: O(N * S * (B + N_matching))
    ///   where N = shard_count
    pub fn find_edge_keys_by_src_ids(
        &self,
        src_ids: &HashSet<u128>,
    ) -> Vec<(u128, u128, String)>;

    /// Atomic batch commit: tombstone old data for changed files,
    /// add new nodes/edges, flush, commit manifest with tombstones.
    ///
    /// Returns CommitDelta describing what changed.
    ///
    /// Complexity: O(F * N_per_file + E_tombstone + flush_cost)
    ///   where F = changed files, N_per_file = nodes per file,
    ///   E_tombstone = edge tombstoning cost
    pub fn commit_batch(
        &mut self,
        nodes: Vec<NodeRecordV2>,
        edges: Vec<EdgeRecordV2>,
        changed_files: &[String],
        tags: HashMap<String, String>,
        manifest_store: &mut ManifestStore,
    ) -> Result<CommitDelta>;
}
```

---

## 3. Algorithms (Pseudocode)

### 3.1. Tombstone-Guarded Point Lookup

```rust
// Shard::get_node (MODIFIED)
fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
    // NEW: tombstone check FIRST (O(1))
    if self.tombstones.contains_node(id) {
        return None;
    }

    // EXISTING: write buffer check
    if let Some(node) = self.write_buffer.get_node(id) {
        return Some(node.clone());
    }

    // EXISTING: segment scan
    for i in (0..self.node_segments.len()).rev() {
        let seg = &self.node_segments[i];
        if !seg.maybe_contains(id) { continue; }
        for j in 0..seg.record_count() {
            if seg.get_id(j) == id {
                return Some(seg.get_record(j));
            }
        }
    }
    None
}
```

**Key insight:** Tombstone check is BEFORE write buffer check. A tombstoned node ID should NOT be visible even if it's in the current write buffer. This handles the case where a node was tombstoned in a previous commit but the write buffer hasn't been flushed yet.

**Wait -- correction.** Actually, the write buffer only contains live data from the current batch. Tombstones apply to data in flushed segments. If a node is in the write buffer AND tombstoned, something is wrong (the caller added a node that was already tombstoned). The tombstone check before write buffer is still correct behavior: tombstone wins, which is safe. But in practice, `commit_batch()` clears relevant tombstones when adding new data for the same file. So this edge case shouldn't occur in normal flow. The defensive ordering is: tombstone check first = always safe.

### 3.2. Tombstone-Guarded find_nodes

```rust
// Shard::find_nodes (MODIFIED)
fn find_nodes(&self, node_type: Option<&str>, file: Option<&str>) -> Vec<NodeRecordV2> {
    let mut seen_ids: HashSet<u128> = HashSet::new();
    let mut results: Vec<NodeRecordV2> = Vec::new();

    // Step 1: Scan write buffer (authoritative)
    for node in self.write_buffer.iter_nodes() {
        seen_ids.insert(node.id);

        // NEW: skip tombstoned nodes
        if self.tombstones.contains_node(node.id) {
            continue;
        }

        // EXISTING: filter checks
        if let Some(nt) = node_type {
            if node.node_type != nt { continue; }
        }
        if let Some(f) = file {
            if node.file != f { continue; }
        }
        results.push(node.clone());
    }

    // Step 2: Scan segments newest-to-oldest
    for i in (0..self.node_segments.len()).rev() {
        // ... existing zone map pruning ...
        for j in 0..seg.record_count() {
            let id = seg.get_id(j);
            if seen_ids.contains(&id) { continue; }

            // NEW: skip tombstoned nodes
            if self.tombstones.contains_node(id) {
                seen_ids.insert(id); // mark seen so we don't check again
                continue;
            }

            // EXISTING: filter + collect
            // ...
        }
    }
    results
}
```

### 3.3. Tombstone-Guarded Edge Queries

```rust
// Shard::get_outgoing_edges (MODIFIED)
fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecordV2> {
    let mut results: Vec<EdgeRecordV2> = Vec::new();

    // Step 1: Write buffer
    for edge in self.write_buffer.find_edges_by_src(node_id) {
        // NEW: skip tombstoned edges
        if self.tombstones.contains_edge(edge.src, edge.dst, &edge.edge_type) {
            continue;
        }
        // EXISTING: type filter
        if let Some(types) = edge_types {
            if !types.contains(&edge.edge_type.as_str()) { continue; }
        }
        results.push(edge.clone());
    }

    // Step 2: Edge segments
    for i in 0..self.edge_segments.len() {
        let seg = &self.edge_segments[i];
        if !seg.maybe_contains_src(node_id) { continue; }
        // ... existing zone map / type filter ...
        for j in 0..seg.record_count() {
            if seg.get_src(j) != node_id { continue; }
            let dst = seg.get_dst(j);
            let edge_type = seg.get_edge_type(j);

            // NEW: skip tombstoned edges
            if self.tombstones.contains_edge(node_id, dst, edge_type) {
                continue;
            }

            // EXISTING: type filter + collect
            if let Some(types) = edge_types {
                if !types.contains(&edge_type) { continue; }
            }
            results.push(seg.get_record(j));
        }
    }
    results
}
```

Same pattern for `get_incoming_edges`, checking `self.tombstones.contains_edge(src, node_id, edge_type)`.

### 3.4. Bloom-Assisted Edge Key Discovery

```rust
// Shard::find_edge_keys_by_src_ids (NEW)
fn find_edge_keys_by_src_ids(
    &self,
    src_ids: &HashSet<u128>,
) -> Vec<(u128, u128, String)> {
    let mut keys = Vec::new();

    // Step 1: Scan edge segments with bloom pre-filter
    for seg in &self.edge_segments {
        // Bloom check: does this segment MAYBE contain edges from any of the src IDs?
        let may_match = src_ids.iter().any(|id| seg.maybe_contains_src(*id));
        if !may_match {
            continue; // Bloom says "definitely not" for all src IDs
        }

        // Scan matching segment
        for j in 0..seg.record_count() {
            let src = seg.get_src(j);
            if src_ids.contains(&src) {
                let dst = seg.get_dst(j);
                let edge_type = seg.get_edge_type(j).to_string();
                keys.push((src, dst, edge_type));
            }
        }
    }

    // Step 2: Scan write buffer
    for edge in self.write_buffer.iter_edges() {
        if src_ids.contains(&edge.src) {
            keys.push((edge.src, edge.dst, edge.edge_type.clone()));
        }
    }

    keys
}
```

**Complexity analysis:**
- Let S = number of edge segments, K = |src_ids|, N_seg = records per segment.
- Bloom check per segment: O(K * 7) where 7 = hash functions per bloom check.
- If bloom passes: O(N_seg) scan with O(1) HashSet lookup per record.
- If bloom rejects: O(K * 7) only (no scan).
- Best case (all bloom rejects): O(S * K * 7).
- Worst case (all bloom pass): O(S * K * 7 + S * N_seg).
- Write buffer scan: O(E_buf) where E_buf = buffered edges.

### 3.5. commit_batch Algorithm

```rust
// MultiShardStore::commit_batch (NEW)
fn commit_batch(
    &mut self,
    nodes: Vec<NodeRecordV2>,
    edges: Vec<EdgeRecordV2>,
    changed_files: &[String],
    tags: HashMap<String, String>,
    manifest_store: &mut ManifestStore,
) -> Result<CommitDelta> {
    // ── Phase 1: Snapshot old state for delta computation ──
    let mut old_nodes_by_id: HashMap<u128, NodeRecordV2> = HashMap::new();
    for file in changed_files {
        for node in self.find_nodes(None, Some(file)) {
            old_nodes_by_id.insert(node.id, node);
        }
    }
    let old_node_ids: HashSet<u128> = old_nodes_by_id.keys().copied().collect();

    // ── Phase 2: Compute tombstones ──
    // 2a. Node tombstones = all old nodes for changed files
    let tombstone_node_ids: HashSet<u128> = old_node_ids.clone();

    // 2b. Edge tombstones = edges with src in tombstoned nodes (bloom-assisted)
    let tombstone_edge_keys: Vec<(u128, u128, String)> =
        self.find_edge_keys_by_src_ids(&tombstone_node_ids);

    // ── Phase 3: Collect metadata for delta ──
    let mut changed_node_types: HashSet<String> = HashSet::new();
    let mut changed_edge_types: HashSet<String> = HashSet::new();

    // From tombstoned nodes/edges
    for node in old_nodes_by_id.values() {
        changed_node_types.insert(node.node_type.clone());
    }
    for (_, _, edge_type) in &tombstone_edge_keys {
        changed_edge_types.insert(edge_type.clone());
    }

    // From new nodes/edges
    for node in &nodes {
        changed_node_types.insert(node.node_type.clone());
    }
    for edge in &edges {
        changed_edge_types.insert(edge.edge_type.clone());
    }

    // ── Phase 4: Apply tombstones to all shards ──
    // Build combined tombstone set (existing + new)
    let current_manifest = manifest_store.current();
    let mut all_tomb_node_ids: HashSet<u128> =
        current_manifest.tombstoned_node_ids.iter().copied().collect();
    all_tomb_node_ids.extend(&tombstone_node_ids);

    let mut all_tomb_edge_keys: HashSet<(u128, u128, String)> =
        current_manifest.tombstoned_edge_keys.iter().cloned().collect();
    all_tomb_edge_keys.extend(tombstone_edge_keys.iter().cloned());

    let combined_tombstones = TombstoneSet {
        node_ids: all_tomb_node_ids.clone(),
        edge_keys: all_tomb_edge_keys.clone(),
    };

    for shard in &mut self.shards {
        shard.set_tombstones(TombstoneSet {
            node_ids: combined_tombstones.node_ids.clone(),
            edge_keys: combined_tombstones.edge_keys.clone(),
        });
    }

    // ── Phase 5: Add new data ──
    let new_node_count = nodes.len() as u64;
    self.add_nodes(nodes.clone());
    self.add_edges(edges)?;

    // ── Phase 6: Compute modified count ──
    let new_nodes_by_id: HashMap<u128, &NodeRecordV2> =
        nodes.iter().map(|n| (n.id, n)).collect();

    let mut nodes_modified: u64 = 0;
    let mut purely_new: u64 = 0;
    for (id, new_node) in &new_nodes_by_id {
        if let Some(old_node) = old_nodes_by_id.get(id) {
            // Same id exists in old and new -> check content_hash
            if old_node.content_hash != new_node.content_hash
                && new_node.content_hash != 0
                && old_node.content_hash != 0
            {
                nodes_modified += 1;
            }
        } else {
            purely_new += 1;
        }
    }

    // ── Phase 7: Flush and commit manifest ──
    // Flush all shards (this handles segment creation)
    self.flush_all(manifest_store)?;

    // CRITICAL: flush_all already committed a manifest. But we need
    // tombstones on the manifest. So we need a DIFFERENT approach:
    // We must NOT call flush_all (which commits its own manifest).
    // Instead, replicate the flush logic but with tombstone-aware manifest.
    //
    // Actually, let me reconsider. flush_all() does:
    //   1. Flush each shard
    //   2. Build manifest with current + new segments
    //   3. Commit manifest
    //
    // We need to interpose between steps 2 and 3 to add tombstones.
    // Two options:
    //   A. Duplicate flush logic in commit_batch (code duplication, bad)
    //   B. Split flush_all into flush_shards() + commit_manifest()
    //   C. Do flush, then immediately commit another manifest with tombstones
    //
    // Option C wastes a manifest version. Option B is clean.
    // Option A is pragmatic for L0. Let's use a variant: inline the flush
    // logic in commit_batch, which is what Don's plan implies.
    //
    // REVISED APPROACH: commit_batch does NOT call flush_all.
    // It inlines the flush coordination + manifest commit with tombstones.

    // ... see Section 3.6 for the revised full algorithm ...
}
```

### 3.6. commit_batch -- Revised Full Algorithm

After careful analysis of the `flush_all` and `create_manifest` interaction, the correct approach is to inline the flush coordination in `commit_batch` to inject tombstone data into the manifest. Here is the complete algorithm:

```rust
pub fn commit_batch(
    &mut self,
    nodes: Vec<NodeRecordV2>,
    edges: Vec<EdgeRecordV2>,
    changed_files: &[String],
    tags: HashMap<String, String>,
    manifest_store: &mut ManifestStore,
) -> Result<CommitDelta> {
    // ── Phase 1: Snapshot old state for delta ──
    let mut old_nodes_by_id: HashMap<u128, NodeRecordV2> = HashMap::new();
    for file in changed_files {
        for node in self.find_nodes(None, Some(file)) {
            old_nodes_by_id.insert(node.id, node);
        }
    }
    let old_node_ids: HashSet<u128> = old_nodes_by_id.keys().copied().collect();

    // ── Phase 2: Compute tombstones ──
    let tombstone_node_ids: HashSet<u128> = old_node_ids.clone();
    let tombstone_edge_keys: Vec<(u128, u128, String)> =
        self.find_edge_keys_by_src_ids(&tombstone_node_ids);

    // ── Phase 3: Collect changed types ──
    let mut changed_node_types: HashSet<String> = HashSet::new();
    let mut changed_edge_types: HashSet<String> = HashSet::new();
    for node in old_nodes_by_id.values() {
        changed_node_types.insert(node.node_type.clone());
    }
    for (_, _, et) in &tombstone_edge_keys {
        changed_edge_types.insert(et.clone());
    }
    for node in &nodes {
        changed_node_types.insert(node.node_type.clone());
    }
    for edge in &edges {
        changed_edge_types.insert(edge.edge_type.clone());
    }

    // ── Phase 4: Apply tombstones to shards ──
    let current = manifest_store.current();
    let mut all_tomb_nodes: HashSet<u128> =
        current.tombstoned_node_ids.iter().copied().collect();
    all_tomb_nodes.extend(&tombstone_node_ids);

    let mut all_tomb_edges: HashSet<(u128, u128, String)> =
        current.tombstoned_edge_keys.iter().cloned().collect();
    all_tomb_edges.extend(tombstone_edge_keys.iter().cloned());

    for shard in &mut self.shards {
        shard.set_tombstones(TombstoneSet {
            node_ids: all_tomb_nodes.clone(),
            edge_keys: all_tomb_edges.clone(),
        });
    }

    // ── Phase 5: Add new data ──
    let new_node_count = nodes.len() as u64;
    self.add_nodes(nodes.clone());
    self.add_edges(edges)?;

    // ── Phase 6: Compute modified count ──
    let new_nodes_by_id: HashMap<u128, &NodeRecordV2> =
        nodes.iter().map(|n| (n.id, n)).collect();
    let mut nodes_modified: u64 = 0;
    let mut purely_new: u64 = 0;
    for (id, new_node) in &new_nodes_by_id {
        if let Some(old_node) = old_nodes_by_id.get(id) {
            if old_node.content_hash != 0
                && new_node.content_hash != 0
                && old_node.content_hash != new_node.content_hash
            {
                nodes_modified += 1;
            }
        } else {
            purely_new += 1;
        }
    }

    // ── Phase 7: Flush shards (inlined from flush_all) ──
    let shard_count = self.shards.len();
    let mut new_node_descs: Vec<SegmentDescriptor> = Vec::new();
    let mut new_edge_descs: Vec<SegmentDescriptor> = Vec::new();

    for shard_idx in 0..shard_count {
        let shard_id = shard_idx as u16;
        let (wb_nodes, wb_edges) = self.shards[shard_idx].write_buffer_size();
        let node_seg_id = if wb_nodes > 0 {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };
        let edge_seg_id = if wb_edges > 0 {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };

        let flush_result = self.shards[shard_idx]
            .flush_with_ids(node_seg_id, edge_seg_id)?;

        if let Some(result) = flush_result {
            if let (Some(meta), Some(seg_id)) = (&result.node_meta, node_seg_id) {
                new_node_descs.push(SegmentDescriptor::from_meta(
                    seg_id, SegmentType::Nodes, Some(shard_id), meta.clone(),
                ));
            }
            if let (Some(meta), Some(seg_id)) = (&result.edge_meta, edge_seg_id) {
                new_edge_descs.push(SegmentDescriptor::from_meta(
                    seg_id, SegmentType::Edges, Some(shard_id), meta.clone(),
                ));
            }
        }
    }

    // ── Phase 8: Build and commit manifest WITH tombstones ──
    let mut all_node_segs = manifest_store.current().node_segments.clone();
    let mut all_edge_segs = manifest_store.current().edge_segments.clone();
    all_node_segs.extend(new_node_descs);
    all_edge_segs.extend(new_edge_descs);

    let mut manifest = manifest_store.create_manifest(
        all_node_segs,
        all_edge_segs,
        Some(tags),
    )?;

    // INJECT tombstones into manifest before commit
    manifest.tombstoned_node_ids = all_tomb_nodes.into_iter().collect();
    manifest.tombstoned_edge_keys = all_tomb_edges.into_iter().collect();

    let manifest_version = manifest.version;
    manifest_store.commit(manifest)?;

    // ── Phase 9: Build CommitDelta ──
    Ok(CommitDelta {
        changed_files: changed_files.to_vec(),
        nodes_added: purely_new,
        nodes_removed: tombstone_node_ids.len() as u64,
        nodes_modified,
        removed_node_ids: tombstone_node_ids.into_iter().collect(),
        changed_node_types,
        changed_edge_types,
        manifest_version,
    })
}
```

**Why inline flush instead of calling `flush_all()`:**
`flush_all()` calls `manifest_store.create_manifest()` + `manifest_store.commit()` internally. We need to inject `tombstoned_node_ids` and `tombstoned_edge_keys` into the manifest BETWEEN `create_manifest()` and `commit()`. Calling `flush_all()` would commit a manifest WITHOUT tombstones, wasting a version. Inlining the flush logic (which is ~40 lines) avoids this.

**Future refactor opportunity:** Extract the flush coordination into a `flush_shards_only()` method that returns segment descriptors without committing a manifest. Then both `flush_all()` and `commit_batch()` can call it. Defer to T4.x.

---

## 4. Big-O Complexity Analysis

### Write Path

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `commit_batch(N nodes, E edges, F files)` | O(F * N_per_file + K * S * B + N + E + flush) | See breakdown below |

**commit_batch breakdown:**
1. Phase 1 (snapshot old): O(F * N_per_file) -- find_nodes per file
2. Phase 2a (node tombstones): O(N_old) -- HashSet construction
3. Phase 2b (edge tombstones): O(S_edge * K * 7 + S_matching * N_seg) -- bloom-assisted scan
4. Phase 3 (changed types): O(N_old + N + E) -- iterate all records
5. Phase 4 (apply tombstones): O(T_nodes + T_edges) per shard, N shards -- clone tombstone sets
6. Phase 5 (add data): O(N + E) -- existing add_nodes/add_edges
7. Phase 6 (modified count): O(N) -- HashMap lookup per new node
8. Phase 7 (flush): O(shard_count * flush_cost)
9. Phase 8 (manifest commit): O(S_total) -- create_manifest + commit
10. Phase 9 (delta): O(1) -- construction

**Where:**
- F = |changed_files|, N = |new_nodes|, E = |new_edges|
- N_per_file = nodes per file (typically 10-100)
- K = |tombstone_node_ids| (= sum of N_per_file)
- S = edge segments per shard, B = bloom filter check cost (7 hash ops)
- T = total tombstone set size (accumulated across commits)

### Read Path (with tombstones)

| Operation | Added Cost | Notes |
|-----------|-----------|-------|
| `get_node(id)` | +O(1) | Single HashSet lookup before any other work |
| `node_exists(id)` | +O(1) | Same |
| `find_nodes(type, file)` | +O(1) per record | HashSet lookup per candidate |
| `get_outgoing_edges(id, types)` | +O(1) per edge | HashSet lookup with String alloc per candidate |
| `get_incoming_edges(id, types)` | +O(1) per edge | Same |
| `all_node_ids()` | +O(1) per ID | HashSet membership check |

**Key observation:** Tombstone overhead is O(1) per record, which is negligible compared to the existing O(N) segment scan costs.

### Memory

| Component | Size | Notes |
|-----------|------|-------|
| TombstoneSet node_ids | 16 bytes/tombstone | u128 in HashSet |
| TombstoneSet edge_keys | ~64 bytes/tombstone | (u128, u128, String) in HashSet |
| 10K tombstoned nodes | ~160 KB | Well within bounds |
| 100K tombstoned nodes | ~1.6 MB | Acceptable until compaction |
| Manifest tombstone JSON | ~20 bytes/node_id | u128 as JSON number |

---

## 5. Step-by-Step Implementation Phases (5 Atomic Commits)

### Commit 1: TombstoneSet + Manifest Fields (~150 LOC, 10 tests)

**Files modified:**
- `packages/rfdb-server/src/storage_v2/shard.rs`
- `packages/rfdb-server/src/storage_v2/manifest.rs`
- `packages/rfdb-server/src/storage_v2/mod.rs`

**Changes:**

**`shard.rs`:**
1. Add `TombstoneSet` struct (definition + impl, ~80 LOC)
2. Add `tombstones: TombstoneSet` field to `Shard`
3. Initialize `tombstones: TombstoneSet::new()` in ALL constructors:
   - `create()` (line ~86)
   - `open()` (line ~125)
   - `ephemeral()` (line ~139)
   - `create_for_shard()` (line ~156)
   - `open_for_shard()` (line ~196)
4. Add `set_tombstones(&mut self, tombstones: TombstoneSet)` method
5. Add `tombstones(&self) -> &TombstoneSet` method
6. Modify `get_node()`: add tombstone check as FIRST line
7. Modify `node_exists()`: add tombstone check as FIRST line
8. Modify `find_nodes()`:
   - In write buffer loop: add `if self.tombstones.contains_node(node.id) { continue; }`
   - In segment loop: add `if self.tombstones.contains_node(id) { seen_ids.insert(id); continue; }`
9. Modify `get_outgoing_edges()`:
   - In write buffer loop: add `if self.tombstones.contains_edge(edge.src, edge.dst, &edge.edge_type) { continue; }`
   - In segment loop: add same check after getting src, dst, edge_type
10. Modify `get_incoming_edges()`: same pattern as outgoing
11. Modify `all_node_ids()`: add `if self.tombstones.contains_node(id) { continue; }`

**`manifest.rs`:**
1. Add two fields to `Manifest` struct (after `parent_version`):
   ```rust
   #[serde(default, skip_serializing_if = "Vec::is_empty")]
   pub tombstoned_node_ids: Vec<u128>,

   #[serde(default, skip_serializing_if = "Vec::is_empty")]
   pub tombstoned_edge_keys: Vec<(u128, u128, String)>,
   ```
2. Update `create_with_config()` initial manifest: add `tombstoned_node_ids: Vec::new(), tombstoned_edge_keys: Vec::new()`
3. Update `ephemeral()` initial manifest: same
4. Update `create_manifest()` method: add `tombstoned_node_ids: Vec::new(), tombstoned_edge_keys: Vec::new()` to the Manifest construction

**`mod.rs`:**
1. Add `TombstoneSet` to re-exports from `shard`:
   ```rust
   pub use shard::{Shard, FlushResult, TombstoneSet};
   ```

**Tests (in `shard.rs`):**
1. `test_tombstone_set_empty` -- new TombstoneSet is empty, contains nothing
2. `test_tombstone_set_from_manifest` -- roundtrip Vec -> TombstoneSet -> contains checks
3. `test_tombstone_blocks_get_node` -- add node, tombstone it, get_node returns None
4. `test_tombstone_blocks_node_exists` -- add node, tombstone it, node_exists returns false
5. `test_tombstone_blocks_find_nodes` -- add 3 nodes, tombstone 1, find_nodes returns 2
6. `test_tombstone_blocks_outgoing_edges` -- add edges, tombstone one, get_outgoing_edges skips it
7. `test_tombstone_blocks_incoming_edges` -- same for incoming
8. `test_tombstone_excludes_from_all_node_ids` -- tombstoned IDs not in all_node_ids
9. `test_tombstone_empty_set_no_effect` -- empty tombstones, all queries work normally
10. `test_tombstone_set_add_union` -- add_nodes/add_edges unions with existing

**Tests (in `manifest.rs`):**
- `test_manifest_serde_with_tombstones` -- manifest with tombstone fields serializes/deserializes
- `test_manifest_serde_backward_compat` -- old JSON without tombstone fields loads correctly (Vec::default)

### Commit 2: find_edge_keys_by_src_ids (~80 LOC, 5 tests)

**Files modified:**
- `packages/rfdb-server/src/storage_v2/shard.rs`
- `packages/rfdb-server/src/storage_v2/multi_shard.rs`

**Changes:**

**`shard.rs`:**
1. Add `find_edge_keys_by_src_ids(&self, src_ids: &HashSet<u128>) -> Vec<(u128, u128, String)>` method (~35 LOC)
   - Scan edge segments with bloom pre-filter on each src_id
   - Scan write buffer
   - Return collected (src, dst, edge_type) tuples

**`multi_shard.rs`:**
1. Add `find_edge_keys_by_src_ids(&self, src_ids: &HashSet<u128>) -> Vec<(u128, u128, String)>` method (~15 LOC)
   - Fan-out to all shards, concatenate results

**Tests (in `shard.rs`):**
1. `test_find_edge_keys_by_src_ids_from_buffer` -- edges in write buffer found
2. `test_find_edge_keys_by_src_ids_from_segment` -- edges in flushed segment found
3. `test_find_edge_keys_by_src_ids_bloom_skips_irrelevant` -- segment with no matching src is skipped
4. `test_find_edge_keys_by_src_ids_empty_input` -- empty src_ids returns empty
5. `test_find_edge_keys_by_src_ids_across_segments` -- edges found in multiple segments

**Tests (in `multi_shard.rs`):**
- `test_find_edge_keys_by_src_ids_multi_shard` -- edges found across multiple shards

### Commit 3: CommitDelta + enrichment_file_context (~50 LOC, 5 tests)

**Files modified:**
- `packages/rfdb-server/src/storage_v2/types.rs`
- `packages/rfdb-server/src/storage_v2/mod.rs`

**Changes:**

**`types.rs`:**
1. Add `CommitDelta` struct (~25 LOC, with derives and doc comments)
2. Add `enrichment_file_context()` function (~5 LOC)

**`mod.rs`:**
1. Add `CommitDelta` and `enrichment_file_context` to re-exports:
   ```rust
   pub use types::{CommitDelta, enrichment_file_context};
   ```
   Note: `types.rs` is already exported via `pub use types::*;` on line 18, so `CommitDelta` and `enrichment_file_context` will be automatically available. No change needed if using `pub use types::*`.

**Tests (in `types.rs`):**
1. `test_commit_delta_serde_roundtrip` -- serialize/deserialize CommitDelta
2. `test_enrichment_file_context_basic` -- "data-flow" + "src/utils.js" -> "__enrichment__/data-flow/src/utils.js"
3. `test_enrichment_file_context_nested_path` -- nested source file path
4. `test_enrichment_file_context_multiple_enrichers` -- different enrichers produce different contexts
5. `test_commit_delta_default_values` -- zero counts, empty collections

### Commit 4: commit_batch on MultiShardStore (~250 LOC, 10 tests)

**Files modified:**
- `packages/rfdb-server/src/storage_v2/multi_shard.rs`

**Changes:**

1. Add `commit_batch()` method (~120 LOC, the core algorithm from Section 3.6)
2. Add necessary imports: `TombstoneSet` from shard, `CommitDelta` from types

**Tests (in `multi_shard.rs`):**
1. `test_commit_batch_basic` -- add nodes for a file, verify visible
2. `test_commit_batch_tombstones_old_nodes` -- commit file, re-commit with different nodes, old nodes gone
3. `test_commit_batch_tombstones_old_edges` -- old edges for tombstoned nodes removed
4. `test_commit_batch_delta_counts` -- verify nodes_added, nodes_removed, nodes_modified counts
5. `test_commit_batch_delta_changed_types` -- verify changed_node_types and changed_edge_types
6. `test_commit_batch_modified_detection` -- same id, different content_hash -> modified
7. `test_commit_batch_content_hash_zero_skip` -- content_hash=0 skips modified check
8. `test_commit_batch_multi_file` -- commit 3 files atomically, all old data tombstoned
9. `test_commit_batch_enrichment_convention` -- enrichment files in changed_files, old enrichment data tombstoned
10. `test_commit_batch_manifest_has_tombstones` -- after commit, manifest contains tombstone lists

### Commit 5: Validation + Integration (~70 LOC, 5 tests)

**Files modified:**
- `packages/rfdb-server/src/storage_v2/multi_shard.rs` (test module)

**Tests:**
1. `test_commit_batch_idempotent` -- analyze file twice with same nodes+edges -> second commit shows 0 added, 0 removed (nodes with same id and content_hash)
2. `test_commit_batch_atomicity` -- 10 nodes in batch, all visible after commit (not partial)
3. `test_commit_batch_tombstone_accumulation` -- two commits, tombstones from first still present in second manifest
4. `test_commit_batch_then_query_consistent` -- after commit, all queries (get_node, find_nodes, edges) return consistent results
5. `test_commit_batch_existing_api_unchanged` -- add_nodes/add_edges/flush_all still work without commit_batch (backward compat)

---

## 6. Design Decisions

### 6.1. Why in-memory HashSet tombstones, not tombstone segments?

**Don's plan analyzed this thoroughly. Summary:**

Delta Lake Deletion Vectors pattern: lightweight markers in manifest, not new segment files. Creating `SegmentType::Tombstone = 2` would require: new writer, new reader, new footer format, bloom filters for tombstones. This is ~200+ LOC for what is essentially `HashSet<u128>`.

**Scale analysis:**
- 10K tombstoned nodes = 160 KB in manifest JSON. Acceptable.
- 100K tombstoned nodes = 1.6 MB. Still acceptable.
- Compaction (T4.x) clears tombstones by rewriting segments.

### 6.2. Why inline flush in commit_batch, not call flush_all?

`flush_all()` commits its own manifest. `commit_batch()` needs to inject tombstone data into the manifest BETWEEN `create_manifest()` and `commit()`. Two options:

**Option A (chosen):** Inline the 40-line flush coordination in `commit_batch`. Slightly duplicated, but self-contained.

**Option B (future):** Extract `flush_shards() -> (Vec<SegmentDescriptor>, Vec<SegmentDescriptor>)` that returns descriptors without committing. Both `flush_all()` and `commit_batch()` call it. This is cleaner but requires refactoring `flush_all()` first.

**Decision:** Option A for this commit. Option B can be a refactoring in T4.x.

### 6.3. Why tombstone check before write buffer in get_node?

Tombstones apply to ALL data (buffer + segments). If a node is tombstoned, it should not be visible regardless of where it lives. Checking tombstones first is O(1) and always safe.

In practice, `commit_batch()` applies tombstones and adds new data in the same call. New data for re-analyzed files goes into the write buffer AFTER tombstones are set. So the write buffer should only contain live data. But defensive ordering (tombstone first) handles edge cases correctly.

### 6.4. Why edge tombstone by (src, dst, edge_type), not by src only?

Tombstoning all edges from a src node would be incorrect if we later add edges from that same src to different destinations. The (src, dst, edge_type) triple is the unique edge key (matches `WriteBuffer::edge_keys` pattern).

### 6.5. Why not per-shard tombstones?

Tombstones are database-wide. A tombstoned node ID means "deleted regardless of shard." This simplifies the model: one TombstoneSet loaded from manifest, broadcast to all shards. If tombstones were per-shard, cross-shard queries would need shard-specific tombstone checks, adding complexity.

**Cost:** Each shard holds a clone of the full tombstone set. For 100K tombstoned nodes across 8 shards = 8 * 1.6 MB = 12.8 MB. Acceptable.

### 6.6. Why `contains_edge` allocates String?

`HashSet<(u128, u128, String)>::contains()` requires an owned `(u128, u128, String)` key. We could use a custom hash to avoid allocation, but:
- Edge type strings are short (<50 bytes)
- Allocation is O(1) amortized
- Custom hash adds complexity
- Profiling can identify if this is actually hot (it won't be for L0)

### 6.7. Why CommitDelta has Serialize/Deserialize?

`CommitDelta` will be sent over the wire protocol in T4.1 (BeginBatch/CommitBatch commands). Adding serde derives now avoids a breaking change later.

---

## 7. What NOT To Do

### 7.1. Do NOT modify WriteBuffer

Tombstones apply to flushed segments, not the write buffer. The write buffer only contains live data from the current batch. No tombstone checks needed in WriteBuffer.

### 7.2. Do NOT create a BatchState struct in storage_v2

`BatchState` is a connection-layer concept. It accumulates mutations across multiple `add_nodes`/`add_edges` calls before calling `commit_batch`. It does NOT live in `storage_v2/`. The storage layer only sees the final `commit_batch` call.

### 7.3. Do NOT modify segment.rs, bloom.rs, zone_map.rs, string_table.rs, writer.rs

Segments are immutable. Tombstones are a read-time filter, not a write-time concern. No segment format changes needed.

### 7.4. Do NOT remove tombstoned records from segments

That's compaction (T4.x). Tombstones accumulate until compaction runs.

### 7.5. Do NOT refactor flush_all

Inlining the flush logic in `commit_batch` is acceptable for L0. Refactoring `flush_all` into composable parts is T4.x.

---

## 8. File Changes Summary

### Modified Files

1. `packages/rfdb-server/src/storage_v2/shard.rs` -- TombstoneSet struct, tombstone field, query modifications, find_edge_keys_by_src_ids, set_tombstones, tombstones accessor (~200 LOC)
2. `packages/rfdb-server/src/storage_v2/manifest.rs` -- tombstone fields on Manifest, update constructors (~20 LOC)
3. `packages/rfdb-server/src/storage_v2/multi_shard.rs` -- find_edge_keys_by_src_ids fan-out, commit_batch (~180 LOC)
4. `packages/rfdb-server/src/storage_v2/types.rs` -- CommitDelta struct, enrichment_file_context (~35 LOC)
5. `packages/rfdb-server/src/storage_v2/mod.rs` -- re-export TombstoneSet (~1 LOC)

### Unchanged Files

- `packages/rfdb-server/src/storage_v2/write_buffer.rs` -- no changes
- `packages/rfdb-server/src/storage_v2/segment.rs` -- no changes
- `packages/rfdb-server/src/storage_v2/bloom.rs` -- no changes
- `packages/rfdb-server/src/storage_v2/zone_map.rs` -- no changes
- `packages/rfdb-server/src/storage_v2/string_table.rs` -- no changes
- `packages/rfdb-server/src/storage_v2/writer.rs` -- no changes
- `packages/rfdb-server/src/storage_v2/shard_planner.rs` -- no changes
- `packages/rfdb-server/src/error.rs` -- no changes (existing error variants sufficient)

### Total

- **New code:** ~435 LOC
- **Tests:** ~165 LOC
- **Total:** ~600 LOC

---

## 9. Test Plan

### 9.1. TombstoneSet Unit Tests (10 tests, Commit 1)

1. **test_tombstone_set_empty**
   - Setup: `TombstoneSet::new()`
   - Assert: `is_empty() == true`, `contains_node(42) == false`, `contains_edge(1, 2, "CALLS") == false`

2. **test_tombstone_set_from_manifest**
   - Setup: `TombstoneSet::from_manifest(vec![1, 2, 3], vec![(10, 20, "CALLS".into())])`
   - Assert: `contains_node(1) == true`, `contains_node(99) == false`, `contains_edge(10, 20, "CALLS") == true`, `contains_edge(10, 20, "OTHER") == false`

3. **test_tombstone_blocks_get_node**
   - Setup: ephemeral shard, add node with id=X, flush, set tombstones with X
   - Action: `get_node(X)`
   - Assert: returns `None`

4. **test_tombstone_blocks_node_exists**
   - Setup: same as above
   - Action: `node_exists(X)`
   - Assert: returns `false`

5. **test_tombstone_blocks_find_nodes**
   - Setup: ephemeral shard, add 3 nodes (A, B, C), flush, tombstone B
   - Action: `find_nodes(None, None)`
   - Assert: returns 2 nodes (A and C), not B

6. **test_tombstone_blocks_outgoing_edges**
   - Setup: ephemeral shard, add edges E1(A->B, CALLS), E2(A->C, CALLS), flush, tombstone E1
   - Action: `get_outgoing_edges(A, None)`
   - Assert: returns 1 edge (E2 only)

7. **test_tombstone_blocks_incoming_edges**
   - Setup: ephemeral shard, add edges E1(A->C, CALLS), E2(B->C, CALLS), flush, tombstone E1
   - Action: `get_incoming_edges(C, None)`
   - Assert: returns 1 edge (E2 only)

8. **test_tombstone_excludes_from_all_node_ids**
   - Setup: ephemeral shard, add 5 nodes, flush, tombstone 2
   - Action: `all_node_ids()`
   - Assert: returns 3 IDs (not the 2 tombstoned)

9. **test_tombstone_empty_set_no_effect**
   - Setup: ephemeral shard with data, tombstones = empty
   - Assert: all queries return same results as without tombstones

10. **test_tombstone_set_add_union**
    - Setup: TombstoneSet with nodes {1, 2}, add_nodes({2, 3})
    - Assert: `node_ids == {1, 2, 3}` (union, not replace)

### 9.2. Manifest Tombstone Tests (2 tests, Commit 1)

11. **test_manifest_serde_with_tombstones**
    - Setup: Manifest with `tombstoned_node_ids = [1, 2, 3]`, `tombstoned_edge_keys = [(10, 20, "CALLS")]`
    - Action: serialize to JSON, deserialize back
    - Assert: roundtrip is equal

12. **test_manifest_serde_backward_compat**
    - Setup: JSON string of old manifest (no tombstone fields)
    - Action: deserialize to Manifest
    - Assert: `tombstoned_node_ids.is_empty()`, `tombstoned_edge_keys.is_empty()`

### 9.3. find_edge_keys_by_src_ids Tests (6 tests, Commit 2)

13. **test_find_edge_keys_by_src_ids_from_buffer**
    - Setup: ephemeral shard, add edges with src=A and src=B to buffer (unflushed)
    - Action: `find_edge_keys_by_src_ids({A})`
    - Assert: returns edges from A only

14. **test_find_edge_keys_by_src_ids_from_segment**
    - Setup: ephemeral shard, add edges, flush to segment
    - Action: `find_edge_keys_by_src_ids({A})`
    - Assert: returns matching edges from segment

15. **test_find_edge_keys_by_src_ids_bloom_skips_irrelevant**
    - Setup: ephemeral shard, flush edges with src=X to segment 1, flush edges with src=Y to segment 2
    - Action: `find_edge_keys_by_src_ids({X})`
    - Assert: returns edges from segment 1 only (segment 2 skipped by bloom)
    - Note: we can't directly verify bloom skip, but we verify correct results

16. **test_find_edge_keys_by_src_ids_empty_input**
    - Setup: ephemeral shard with edges
    - Action: `find_edge_keys_by_src_ids(empty set)`
    - Assert: returns empty Vec

17. **test_find_edge_keys_by_src_ids_across_segments**
    - Setup: flush edges to 3 segments with overlapping src IDs
    - Action: `find_edge_keys_by_src_ids({A, B})`
    - Assert: returns all matching edges from all segments

18. **test_find_edge_keys_by_src_ids_multi_shard**
    - Setup: ephemeral MultiShardStore, add nodes to different shards, add edges, flush
    - Action: `find_edge_keys_by_src_ids({node_A_id})`
    - Assert: returns edges across shards

### 9.4. CommitDelta + Enrichment Tests (5 tests, Commit 3)

19. **test_commit_delta_serde_roundtrip**
    - Setup: CommitDelta with sample values
    - Action: serde_json roundtrip
    - Assert: equal

20. **test_enrichment_file_context_basic**
    - Assert: `enrichment_file_context("data-flow", "src/utils.js") == "__enrichment__/data-flow/src/utils.js"`

21. **test_enrichment_file_context_nested_path**
    - Assert: `enrichment_file_context("import-resolver", "src/a/b/c.js") == "__enrichment__/import-resolver/src/a/b/c.js"`

22. **test_enrichment_file_context_multiple_enrichers**
    - Assert: different enrichers produce different contexts for same file

23. **test_commit_delta_default_values**
    - Setup: CommitDelta with all zeros/empty
    - Assert: all fields accessible, no panics

### 9.5. commit_batch Tests (10 tests, Commit 4)

24. **test_commit_batch_basic**
    - Setup: ephemeral MultiShardStore + ManifestStore
    - Action: commit_batch with 3 nodes, 2 edges, 1 changed file
    - Assert: all nodes/edges queryable, manifest version incremented

25. **test_commit_batch_tombstones_old_nodes**
    - Setup: commit file "a.js" with nodes A, B, C
    - Action: re-commit "a.js" with nodes A', D (A modified, B/C removed, D added)
    - Assert: get_node(B) == None, get_node(C) == None, get_node(D) == Some, find_nodes(file="a.js") == [A', D]

26. **test_commit_batch_tombstones_old_edges**
    - Setup: commit nodes A, B with edge A->B, flush
    - Action: re-commit "a.js" (A's file), which tombstones A and its edges
    - Assert: get_outgoing_edges(A_old) returns empty (A tombstoned)

27. **test_commit_batch_delta_counts**
    - Setup: commit 5 nodes, then re-commit with 3 nodes (2 same id, 1 new)
    - Assert: delta.nodes_added correct, delta.nodes_removed correct

28. **test_commit_batch_delta_changed_types**
    - Setup: commit FUNCTION nodes, re-commit with CLASS nodes
    - Assert: changed_node_types contains both "FUNCTION" and "CLASS"

29. **test_commit_batch_modified_detection**
    - Setup: commit node A with content_hash=100, re-commit A with content_hash=200
    - Assert: delta.nodes_modified == 1

30. **test_commit_batch_content_hash_zero_skip**
    - Setup: commit node A with content_hash=0, re-commit A with content_hash=0
    - Assert: delta.nodes_modified == 0 (both zero, skip)

31. **test_commit_batch_multi_file**
    - Setup: commit "a.js" and "b.js" in one batch
    - Action: re-commit both files with new data
    - Assert: old data from both files tombstoned, new data visible

32. **test_commit_batch_enrichment_convention**
    - Setup: commit nodes with file="__enrichment__/data-flow/src/a.js"
    - Action: re-commit with changed_files=["__enrichment__/data-flow/src/a.js"]
    - Assert: old enrichment nodes tombstoned

33. **test_commit_batch_manifest_has_tombstones**
    - Setup: commit, then re-commit
    - Action: inspect manifest_store.current()
    - Assert: tombstoned_node_ids is non-empty, tombstoned_edge_keys is non-empty

### 9.6. Validation + Integration Tests (5 tests, Commit 5)

34. **test_commit_batch_idempotent**
    - Setup: commit file with nodes [A(hash=100), B(hash=200)]
    - Action: re-commit same file with SAME nodes [A(hash=100), B(hash=200)]
    - Assert: delta.nodes_added == 0, delta.nodes_removed == 0 (or: nodes_added == 2 and nodes_removed == 2, since we tombstone-then-add; the important thing is the graph state is identical)
    - Note: Actually, nodes_added and nodes_removed will both be 2 because we tombstone ALL old nodes for changed files and add ALL new ones. The graph state is identical but the delta reflects the churn. nodes_modified should be 0 (same content_hash).

35. **test_commit_batch_atomicity**
    - Setup: commit 10 nodes in one batch
    - Action: query all 10 by ID
    - Assert: all 10 found (not partial)

36. **test_commit_batch_tombstone_accumulation**
    - Setup: commit "a.js" with nodes A, B; commit "b.js" with nodes C, D; re-commit "a.js" with node E
    - Assert: manifest.tombstoned_node_ids contains A and B (from re-commit), AND any prior tombstones
    - Assert: nodes C, D still queryable (not affected)

37. **test_commit_batch_then_query_consistent**
    - Setup: commit file, re-commit with modifications
    - Assert: get_node, find_nodes, get_outgoing_edges, get_incoming_edges ALL return consistent results (no stale data from old commit)

38. **test_commit_batch_existing_api_unchanged**
    - Setup: use add_nodes + add_edges + flush_all (old API, no commit_batch)
    - Assert: works exactly as before (backward compatible)

---

## 10. Corner Cases & Error Handling

### 10.1. Empty changed_files

**Scenario:** `commit_batch(nodes, edges, changed_files=[], ...)`

**Behavior:** No tombstones computed (no old nodes to tombstone). New nodes/edges added. CommitDelta shows only additions.

**Test coverage:** Implicitly covered by test_commit_batch_basic.

### 10.2. changed_files with no existing data

**Scenario:** `commit_batch(nodes, edges, changed_files=["new_file.js"], ...)`

**Behavior:** `find_nodes(None, Some("new_file.js"))` returns empty. No tombstones. New data added normally.

**Test coverage:** test_commit_batch_basic (first commit for any file has no old data).

### 10.3. Tombstoned node re-added in same batch

**Scenario:** File "a.js" has node A. Re-commit "a.js" with same node A (same id).

**Behavior:**
1. Phase 1: old_nodes_by_id = {A}
2. Phase 2: tombstone_node_ids = {A}
3. Phase 4: set tombstones on shards (A is tombstoned)
4. Phase 5: add_nodes with new A -> goes to write buffer, replacing tombstoned version
5. Phase 7: flush -> A is in new segment
6. After commit: A is in tombstone set AND in new segment. Tombstone check runs first, so A would be invisible!

**THIS IS A BUG in the naive algorithm.** When new data has the same node ID as tombstoned data, the tombstone must NOT apply to the new version.

**Fix:** After adding new nodes, remove their IDs from the tombstone set. The tombstone should only apply to the OLD segment data, not the newly written data.

```rust
// Phase 5.5: Remove new node IDs from tombstone set
// New data supersedes tombstones for the same ID.
for node in &nodes {
    all_tomb_nodes.remove(&node.id);
}
// Re-apply updated tombstones to shards
for shard in &mut self.shards {
    shard.set_tombstones(TombstoneSet {
        node_ids: all_tomb_nodes.clone(),
        edge_keys: all_tomb_edges.clone(),
    });
}
```

**Similarly for edges:** New edges with the same (src, dst, edge_type) as tombstoned edges should be visible.

```rust
for edge in &edges_to_add {  // need to store edges before consuming
    all_tomb_edges.remove(&(edge.src, edge.dst, edge.edge_type.clone()));
}
```

**CRITICAL: This is a correctness fix that MUST be included in the commit_batch implementation.**

**Test coverage:** test_commit_batch_tombstones_old_nodes covers this (re-commit with node A' that has same id as old A).

### 10.4. Edge tombstoning when src node is re-added

**Scenario:** Node A in "a.js" has edges A->B and A->C. Re-commit "a.js" with same node A but only edge A->B (A->C is removed).

**Behavior:**
1. Tombstone A's node ID -> find all edges with src=A -> tombstone (A,B,CALLS) and (A,C,CALLS)
2. Add new A
3. Add new edge A->B
4. Remove A from node tombstones (new A supersedes)
5. Remove (A,B,CALLS) from edge tombstones (new edge supersedes)
6. After commit: A->B visible (new), A->C invisible (tombstoned)

**This is correct.** The edge tombstone for A->C remains because no new edge with same key was added.

### 10.5. Concurrent flush_all and commit_batch

**Scenario:** Not possible. `commit_batch` takes `&mut self`, so it's serialized.

### 10.6. Tombstone accumulation growth

**Scenario:** After N re-analysis runs without compaction, tombstone set grows.

**Behavior:** Each commit_batch adds new tombstones (union with previous). Manifest JSON grows.

**Scale:** 1000 re-analysis runs * 100 tombstoned nodes per run = 100K tombstone IDs = 1.6 MB in manifest. Acceptable until compaction (T4.x).

**Mitigation:** Monitor tombstone count in ManifestStats (future enhancement). Warn when tombstone count exceeds threshold.

---

## 11. Risk Analysis

### Risk 1: contains_edge String Allocation (LOW)

**Likelihood:** Certain (every edge tombstone check allocates).

**Impact:** Low for L0 workloads (~10K edges).

**Mitigation:** If profiling shows this is hot, switch to `HashSet<(u128, u128, u64)>` where u64 = hash of edge_type string. Defer to T4.x.

### Risk 2: Tombstone Set Size (LOW)

See Section 10.6. Compaction (T4.x) clears tombstones.

### Risk 3: Inline Flush Duplication (LOW)

**Likelihood:** Certain (commit_batch duplicates ~40 lines from flush_all).

**Impact:** Low (maintenance burden, not correctness).

**Mitigation:** Extract shared flush logic in T4.x.

### Risk 4: Node Re-Addition Bug (MITIGATED)

See Section 10.3. Fix included in algorithm.

### Risk 5: Serde Backward Compatibility (LOW)

`#[serde(default)]` on new Manifest fields ensures old manifests load correctly. Already proven pattern in existing codebase.

---

## 12. Success Criteria

### Correctness

1. **Tombstone blocks queries:** Tombstoned node not visible via get_node, node_exists, find_nodes, all_node_ids
2. **Tombstone blocks edges:** Tombstoned edge not visible via get_outgoing_edges, get_incoming_edges
3. **Re-commit replaces:** Re-analyzing a file replaces old data with new data atomically
4. **No stale data:** After commit_batch, no query returns data from old version of changed files
5. **Backward compatible:** Old manifests without tombstone fields load correctly. Existing add_nodes/add_edges/flush_all API unchanged.

### Performance

1. **Tombstone overhead:** <1 microsecond per record (HashSet lookup)
2. **commit_batch latency:** <500ms for typical workload (10 files, 1000 nodes, 5000 edges)
3. **Manifest size:** <2 MB with 100K accumulated tombstones

### Robustness

1. **Crash safety:** Manifest commit is atomic. Crash before commit -> old state. Crash after -> new state with tombstones.
2. **Empty inputs:** commit_batch with empty nodes, empty edges, empty changed_files all work correctly.
3. **Idempotency:** Re-committing identical data produces correct graph state (same content_hash -> nodes_modified = 0).

---

## Conclusion

Tombstones + Batch Commit is the foundation for incremental re-analysis. The design follows Delta Lake Deletion Vectors: lightweight tombstones in manifests, not separate segment files. Tombstones are in-memory HashSets for O(1) query-time checks.

**Key invariants:**
- Tombstoned records are invisible to ALL query paths
- New data for the same ID supersedes tombstones
- Tombstones accumulate until compaction
- Manifest commit is atomic (crash safety preserved)
- Existing API (add_nodes/add_edges/flush_all) unchanged

**Estimated timeline:** 8-12 hours implementation + 2-3 hours testing = **10-15 hours total** (~2 days).

**Ready for Kent Beck to write tests.**
