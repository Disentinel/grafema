# Don's Plan: RFD-7 Multi-Shard

**Date:** 2026-02-13
**Author:** Don Melton
**Task:** RFD-7 (T2.3 Multi-Shard)

---

## Executive Summary

Multi-shard layer for RFDB v2 storage. Directory-based partitioning where files in the same directory go to the same shard. New `ShardPlanner` computes shard assignments deterministically. New `MultiShardStore` wraps N independent `Shard` instances and fans out queries.

**Scope:** ~800 LOC, ~20 tests, 4-5 new files.

**Key design decisions:**
1. **Shard routing:** Hash(directory_path) → shard_id. Files in same dir = same shard.
2. **Edge placement:** Edges stored in source node's shard (standard graph partitioning).
3. **Query fan-out:** All queries broadcast to all shards, merge results with dedup.
4. **Parallel writes:** rayon for parallel segment writes within shards, not across shards.
5. **Bloom filter cross-shard lookup:** Point lookups iterate shards, bloom filters prune most.

This is L0 correctness-first implementation. No query optimization (we'll add shard-aware routing in T4.x after wire protocol is stable).

---

## Architecture Overview

### New Components

```
storage_v2/
├── shard.rs                    # [Existing] Single-shard unit
├── write_buffer.rs             # [Existing]
├── manifest.rs                 # [Existing] ManifestStore (database-level)
├── multi_shard.rs              # [NEW] MultiShardStore — N shards + fan-out queries
├── shard_planner.rs            # [NEW] File list → shard assignments
└── mod.rs                      # [UPDATE] Export new types
```

### Responsibility Matrix

| Component | Responsibility |
|-----------|---------------|
| `Shard` | Single-shard read/write, owns WriteBuffer + segments |
| `ShardPlanner` | Deterministic file→shard_id mapping |
| `MultiShardStore` | Owns N shards, fans out queries, merges results |
| `ManifestStore` | Database-level manifest chain (already supports shard_id in descriptors) |

---

## 1. Shard Routing Strategy: Directory-Based Partitioning

### Design

Files in the same directory go to the same shard. This exploits **locality of reference**: files in the same directory typically have high interconnection (e.g., `src/routes/*.js` all import from `src/lib/auth.js`).

**Algorithm:**
```rust
fn compute_shard_id(file_path: &str, shard_count: u16) -> u16 {
    let dir = Path::new(file_path).parent().unwrap_or(Path::new(""));
    let hash = seahash::hash(dir.as_os_str().as_bytes());
    (hash % shard_count as u64) as u16
}
```

**Why seahash?** Already in Cargo.toml (used elsewhere in RFDB). Fast non-crypto hash sufficient for partitioning.

### Shard Count

Fixed at database creation time. Stored in database root config file:

```json
{
  "version": 2,
  "shard_count": 8,
  "created_at": 1738876800
}
```

**Configuration:**
- Default: 8 shards (good for 10k-100k files)
- CLI flag: `--shard-count N` when creating database
- Immutable after creation (resharding = future T4.x)

**Rationale for 8:**
- Power of 2 (clean modulo arithmetic)
- Parallelism: 8 concurrent segment writes without thrashing on 8-16 core machines
- Not too fine-grained (avoids small-shard overhead)

### Deterministic Guarantees

**Validation test:**
```rust
#[test]
fn test_planner_deterministic() {
    let files1 = vec!["src/a.js", "src/b.js", "lib/c.js"];
    let files2 = files1.clone();

    let plan1 = ShardPlanner::new(8).plan(&files1);
    let plan2 = ShardPlanner::new(8).plan(&files2);

    assert_eq!(plan1, plan2);
}
```

**Plan stability:** If we add `src/new.js`, only `src/` files **might** move (if `src/` directory is reassigned). But most directories stay stable.

---

## 2. Edge Placement Strategy

### Rule: Edges stored in source node's shard

**Example:**
- Node A in shard 0 (file: `src/routes/api.js`)
- Node B in shard 1 (file: `lib/auth.js`)
- Edge A→B (CALLS)

**Storage:** Edge A→B goes in shard 0 (with node A).

**Rationale:**
- Standard graph partitioning (adjacency list co-location)
- Outgoing edge queries are O(1) shard lookup (no fan-out)
- Incoming edge queries fan out to all shards (acceptable for L0)

### Cross-Shard Edges

**Problem:** Edge A→B is in shard 0, but node B is in shard 1. If we do `get_node(B)`, we get the node. But if we do `get_incoming_edges(B)`, we need to check ALL shards for edges pointing to B.

**L0 solution:** Incoming edge queries **always fan out to all shards**. Bloom filters prune most shards instantly (O(k) where k=7 hash functions).

**Future optimization (T4.x):** Build a shard-level "cross-shard edge index" during flush. For now, fan-out is acceptable.

---

## 3. Multi-Shard Query Design

### Query Types

| Query | Strategy | Complexity |
|-------|----------|-----------|
| `get_node(id)` | Fan-out with bloom filter prune | O(1) per shard, N shards checked |
| `find_nodes(type, file)` | Fan-out to all, merge with dedup | O(N_shards) |
| `get_outgoing_edges(id)` | Fan-out with bloom filter prune | O(1) per shard, N shards checked |
| `get_incoming_edges(id)` | Fan-out to all shards (no bloom prune for dst) | O(N_shards) |

### Deduplication Rules

**Nodes:** Dedup by node id. If multiple shards return the same node (shouldn't happen, but defensive), newest version wins.

**Edges:** Dedup by (src, dst, edge_type). Edges are unique, so dedup is safety check only.

### MultiShardStore API

```rust
pub struct MultiShardStore {
    shards: Vec<Shard>,
    planner: ShardPlanner,
    shard_count: u16,
}

impl MultiShardStore {
    // -- Constructors --
    pub fn create(db_path: &Path, shard_count: u16) -> Result<Self>;
    pub fn open(db_path: &Path, manifest_store: &ManifestStore) -> Result<Self>;

    // -- Write Operations --
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>) -> Result<()>;
    pub fn add_edges(&mut self, records: Vec<EdgeRecordV2>) -> Result<()>;
    pub fn flush_all(&mut self, manifest_store: &mut ManifestStore) -> Result<()>;

    // -- Point Lookup --
    pub fn get_node(&self, id: u128) -> Option<NodeRecordV2>;
    pub fn node_exists(&self, id: u128) -> bool;

    // -- Attribute Search --
    pub fn find_nodes(&self, node_type: Option<&str>, file: Option<&str>) -> Vec<NodeRecordV2>;

    // -- Neighbor Queries --
    pub fn get_outgoing_edges(&self, id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecordV2>;
    pub fn get_incoming_edges(&self, id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecordV2>;

    // -- Stats --
    pub fn node_count(&self) -> usize;
    pub fn edge_count(&self) -> usize;
}
```

### Fan-Out Implementation Pattern

```rust
pub fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
    // Check all shards with bloom filter short-circuit
    for shard in &self.shards {
        if let Some(node) = shard.get_node(id) {
            return Some(node);
        }
    }
    None
}

pub fn find_nodes(&self, node_type: Option<&str>, file: Option<&str>) -> Vec<NodeRecordV2> {
    let mut seen_ids: HashSet<u128> = HashSet::new();
    let mut results: Vec<NodeRecordV2> = Vec::new();

    // Fan-out to all shards, dedup by node id
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

**Sequential scan for L0.** We'll parallelize in T4.x with rayon after correctness is proven.

---

## 4. Parallel Writes Design

### What rayon parallelizes

**Within a single shard's flush:**
- Segment writer already uses rayon internally (if we add it to writer.rs later)

**Across shards:**
- Not in L0. Flush shards sequentially: `for shard in shards { shard.flush_with_ids(...) }`

**Why not parallel flush in L0?**
- ManifestStore is single-threaded (no lock-free manifest updates yet)
- Segment ID allocation needs coordination
- Correctness first, parallelism later (T4.x with atomic segment ID counter)

### Where rayon IS used (existing)

Already in Cargo.toml. Used in:
- Writer compression (parallel column writes)
- Bloom filter construction (parallel hash computation)

**No new rayon usage in RFD-7.** We're just building the multi-shard layer, not optimizing flush yet.

---

## 5. Cross-Shard Point Lookup via Bloom Filters

### Problem

Node A could be in any of N shards. Naive: scan all N shards. Expensive if N=64.

### Solution: Bloom filter prune

Each shard has a bloom filter on node IDs. `shard.maybe_contains(id)` returns:
- `false` → definite no (skip shard)
- `true` → maybe yes (scan segment)

**Cost:** O(k) where k=7 hash functions per shard. For N=8 shards, 56 hash checks before linear scan.

### Implementation

Already exists in `Shard::get_node()`:
```rust
pub fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
    // Step 1: Check write buffer
    if let Some(node) = self.write_buffer.get_node(id) {
        return Some(node.clone());
    }

    // Step 2: Scan segments newest-to-oldest
    for i in (0..self.node_segments.len()).rev() {
        let seg = &self.node_segments[i];

        // Bloom filter: definite-no in O(k)
        if !seg.maybe_contains(id) {
            continue;
        }

        // Linear scan of ID column
        for j in 0..seg.record_count() {
            if seg.get_id(j) == id {
                return Some(seg.get_record(j));
            }
        }
    }
    None
}
```

**MultiShardStore just wraps this:**
```rust
pub fn get_node(&self, id: u128) -> Option<NodeRecordV2> {
    for shard in &self.shards {
        if let Some(node) = shard.get_node(id) {
            return Some(node);
        }
    }
    None
}
```

**Early exit:** As soon as we find the node, return. Average case: N/2 shards checked (bloom filters prune the rest).

---

## 6. Integration with ManifestStore

### Current State (RFD-6)

`ManifestStore` already supports `shard_id: Option<u16>` in `SegmentDescriptor`:

```rust
pub struct SegmentDescriptor {
    pub segment_id: u64,
    pub segment_type: SegmentType,
    pub shard_id: Option<u16>,  // ← Already exists!
    // ...
}
```

Segment file paths already use shard_id:
```rust
pub fn file_path(&self, db_path: &Path) -> PathBuf {
    if let Some(shard_id) = self.shard_id {
        db_path.join("segments").join(format!("{:02}", shard_id)).join(filename)
    } else {
        db_path.join("segments").join(filename)
    }
}
```

**Example:**
- Shard 0 segments: `segments/00/seg_000001_nodes.seg`
- Shard 1 segments: `segments/01/seg_000002_nodes.seg`

### Multi-Shard Flush Protocol

```rust
pub fn flush_all(&mut self, manifest_store: &mut ManifestStore) -> Result<()> {
    let mut all_node_descriptors = Vec::new();
    let mut all_edge_descriptors = Vec::new();

    for (shard_idx, shard) in self.shards.iter_mut().enumerate() {
        let shard_id = shard_idx as u16;

        // Allocate segment IDs from manifest store
        let node_seg_id = if shard.write_buffer_has_nodes() {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };
        let edge_seg_id = if shard.write_buffer_has_edges() {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };

        // Flush shard
        if let Some(result) = shard.flush_with_ids(node_seg_id, edge_seg_id)? {
            if let Some(meta) = result.node_meta {
                let desc = SegmentDescriptor::from_meta(
                    node_seg_id.unwrap(),
                    SegmentType::Nodes,
                    Some(shard_id),  // ← Set shard_id
                    meta,
                );
                all_node_descriptors.push(desc);
            }
            if let Some(meta) = result.edge_meta {
                let desc = SegmentDescriptor::from_meta(
                    edge_seg_id.unwrap(),
                    SegmentType::Edges,
                    Some(shard_id),  // ← Set shard_id
                    meta,
                );
                all_edge_descriptors.push(desc);
            }
        }
    }

    // Commit single manifest with all shards' segments
    manifest_store.commit(all_node_descriptors, all_edge_descriptors)?;
    Ok(())
}
```

**Key insight:** ManifestStore is database-level. It doesn't care about shards. It just stores all segment descriptors in a flat list. The `shard_id` field is metadata for routing during open.

### Opening Multi-Shard Database

```rust
pub fn open(db_path: &Path, manifest_store: &ManifestStore) -> Result<Self> {
    let manifest = manifest_store.current_manifest()?;
    let shard_count = read_shard_count_from_config(db_path)?;

    // Group descriptors by shard_id
    let mut nodes_by_shard: HashMap<u16, Vec<SegmentDescriptor>> = HashMap::new();
    let mut edges_by_shard: HashMap<u16, Vec<SegmentDescriptor>> = HashMap::new();

    for desc in manifest.node_segments {
        let shard_id = desc.shard_id.unwrap_or(0);
        nodes_by_shard.entry(shard_id).or_default().push(desc);
    }
    for desc in manifest.edge_segments {
        let shard_id = desc.shard_id.unwrap_or(0);
        edges_by_shard.entry(shard_id).or_default().push(desc);
    }

    // Open each shard
    let mut shards = Vec::new();
    for shard_id in 0..shard_count {
        let shard_path = db_path.join("shards").join(format!("{:02}", shard_id));
        let node_descs = nodes_by_shard.remove(&shard_id).unwrap_or_default();
        let edge_descs = edges_by_shard.remove(&shard_id).unwrap_or_default();

        let shard = Shard::open(&shard_path, db_path, node_descs, edge_descs)?;
        shards.push(shard);
    }

    Ok(Self {
        shards,
        planner: ShardPlanner::new(shard_count),
        shard_count,
    })
}
```

**Directory layout:**
```
mydb.rfdb/
├── config.json                     # shard_count, version
├── current.json                    # Atomic pointer
├── manifest_index.json             # Index
├── manifests/
│   ├── 000001.json
│   └── 000002.json
├── shards/
│   ├── 00/                         # Shard 0 directory (ephemeral, no state)
│   ├── 01/                         # Shard 1 directory
│   └── ...
└── segments/
    ├── 00/                         # Shard 0 segments
    │   ├── seg_000001_nodes.seg
    │   └── seg_000002_edges.seg
    ├── 01/                         # Shard 1 segments
    │   └── seg_000003_nodes.seg
    └── ...
```

**Note:** `shards/XX/` directories exist but are mostly empty (Shard doesn't persist state beyond segments). They're placeholders for future per-shard write-ahead logs (T4.x).

---

## 7. What NOT to Do (Explicit Exclusions)

### No Query Optimization

**Excluded:**
- Shard-aware routing (skip shards based on file path filter)
- Parallel fan-out with rayon
- Caching of shard→file mapping

**Why:** L0 is correctness. Optimization comes in T4.x after wire protocol is stable and we have real workload data.

**Example of what we're NOT doing:**
```rust
// ❌ NOT in L0 — premature optimization
pub fn find_nodes(&self, node_type: Option<&str>, file: Option<&str>) -> Vec<NodeRecordV2> {
    let target_shards = if let Some(f) = file {
        // Optimization: only query shards that might have this file
        vec![self.planner.compute_shard_id(f)]
    } else {
        // Query all shards
        (0..self.shard_count).collect()
    };
    // ...
}
```

**Problem with this:** If file moved between shards (due to refactoring), cache is stale. We'd need invalidation logic. Too complex for L0.

### No Resharding

**Excluded:**
- Changing shard_count after database creation
- Rebalancing shards (moving files between shards)

**Why:** Resharding is a major operational feature (T5.x). For L0, shard_count is immutable.

### No Shard-Level WAL

**Excluded:**
- Per-shard write-ahead log for crash recovery
- Concurrent writes to different shards

**Why:** ManifestStore already provides crash recovery via atomic current.json. Per-shard WAL is optimization for concurrent writes (T4.x).

### No Cross-Shard Transactions

**Excluded:**
- Atomic writes spanning multiple shards
- Two-phase commit for multi-shard flush

**Why:** RFDB is append-only. All writes go to write buffers, then flush atomically via single manifest commit. Cross-shard transactions are unnecessary.

---

## 8. Estimated Scope

### Files

| File | LOC | Purpose |
|------|-----|---------|
| `shard_planner.rs` | ~150 | File→shard_id mapping, deterministic hashing |
| `multi_shard.rs` | ~400 | MultiShardStore, fan-out queries, flush coordination |
| `mod.rs` | ~10 | Export new types |
| `config.rs` (new) | ~80 | Database config (shard_count, version) read/write |
| Tests in `multi_shard.rs` | ~200 | Correctness, determinism, cross-shard edge queries |

**Total: ~840 LOC**

### Test Coverage

**Correctness tests (~15 tests):**
1. Planner determinism (same files → same plan)
2. Planner completeness (every file assigned exactly once)
3. Multi-shard point lookup (find node regardless of shard)
4. Multi-shard find_nodes with dedup
5. Cross-shard edges (A in shard 0, B in shard 1, edge A→B queryable)
6. Flush → open → query (persistence)
7. Empty shard handling (some shards have no data)
8. All shards have data (even distribution)
9. File in root directory (no parent) maps to shard 0
10. Incoming edges fan-out (all shards queried)
11. Outgoing edges bloom filter prune
12. Node count / edge count aggregation
13. Write buffer visibility across shards
14. Manifest integration (shard_id in descriptors)
15. Config read/write (shard_count persistence)

**Performance smoke tests (~5 tests):**
1. 10k files distributed across 8 shards (check balance)
2. Point lookup doesn't scan all segments (bloom filter works)
3. Fan-out query scales linearly with shard count
4. Flush doesn't thrash (sequential, not parallel)
5. Open time scales with manifest size, not shard count

---

## 9. Dependencies & Risks

### Dependencies

**Upstream (must be done first):**
- RFD-6 (Single-Shard) — ✅ DONE

**Downstream (blocked by this):**
- RFD-8 (T4.1: Wire Protocol v3 Integration) — needs MultiShardStore API

### Risks

**Risk 1: Uneven shard distribution**
- **Likelihood:** Medium
- **Impact:** Low (L0 doesn't require perfect balance)
- **Mitigation:** Use seahash (good distribution), test with real codebase

**Risk 2: Bloom filter false positive rate too high**
- **Likelihood:** Low (10 bits/key = 0.82% FPR)
- **Impact:** Low (just means extra segment scan)
- **Mitigation:** Existing RFD-6 tests validate bloom filter correctness

**Risk 3: ManifestStore doesn't scale to 8x segment count**
- **Likelihood:** Low (manifest is just JSON, scales to millions of segments)
- **Impact:** Medium (would need manifest pagination)
- **Mitigation:** Monitor manifest size in tests (acceptable up to 10MB)

**Risk 4: Cross-shard edge queries are too slow**
- **Likelihood:** Medium (fan-out to all shards)
- **Impact:** Low (L0 correctness, not performance)
- **Mitigation:** Defer optimization to T4.x, measure in production first

---

## 10. Integration Testing Strategy

### Test Cases

**1. Single-file per shard (N=8, 8 files)**
- Each shard gets exactly 1 file
- Verify planner correctness

**2. Skewed distribution (N=8, 100 files, 80 in `src/`)**
- Most files in one directory → one shard gets hot
- Verify no crashes, queries work

**3. Empty shards (N=8, 3 files)**
- Only 3 shards have data, 5 are empty
- Verify empty shards don't break queries

**4. Cross-shard edge queries**
- File A in shard 0, File B in shard 7
- Edge A→B (CALLS)
- Verify `get_outgoing_edges(A)` finds edge
- Verify `get_incoming_edges(B)` finds edge

**5. Flush → close → reopen → query**
- Flush multi-shard database
- Close, reopen from manifest
- Verify all data queryable

### Equivalence Test

```rust
#[test]
fn test_multi_shard_equivalence_to_single_shard() {
    // Build two databases: one single-shard, one 8-shard
    // Same data loaded into both
    // All queries must return identical results (modulo order)

    let nodes = generate_test_nodes(1000);
    let edges = generate_test_edges(5000);

    // Single-shard
    let mut single = Shard::ephemeral();
    single.add_nodes(nodes.clone());
    single.add_edges(edges.clone());

    // Multi-shard
    let mut multi = MultiShardStore::ephemeral(8);
    multi.add_nodes(nodes.clone());
    multi.add_edges(edges.clone());

    // Compare queries
    for node in &nodes {
        assert_eq!(single.get_node(node.id), multi.get_node(node.id));
    }

    let single_fns = single.find_nodes(Some("FUNCTION"), None);
    let multi_fns = multi.find_nodes(Some("FUNCTION"), None);
    assert_eq!(to_id_set(single_fns), to_id_set(multi_fns));
}
```

This proves multi-shard is a **transparent abstraction** — behavior identical to single-shard, just partitioned.

---

## 11. Future Extensions (T4.x+)

### Shard-Aware Query Routing

**Idea:** If query specifies `file="src/routes/api.js"`, only query the shard containing `src/routes/`.

**Benefit:** Skip N-1 shards, O(1) query instead of O(N).

**Complexity:** Need to track directory→shard mapping. What if directory moves? Need invalidation.

**Decision:** Defer to T4.x after we measure real query patterns.

### Parallel Fan-Out with rayon

**Idea:** Use `rayon::par_iter()` to query all shards in parallel.

```rust
pub fn find_nodes(&self, node_type: Option<&str>, file: Option<&str>) -> Vec<NodeRecordV2> {
    use rayon::prelude::*;

    let results: Vec<Vec<NodeRecordV2>> = self.shards
        .par_iter()
        .map(|shard| shard.find_nodes(node_type, file))
        .collect();

    // Merge with dedup
    // ...
}
```

**Benefit:** O(1) fan-out time instead of O(N).

**Complexity:** Need to ensure thread safety (Shard is currently !Send).

**Decision:** Defer to T4.x. L0 is single-threaded read path.

### Cross-Shard Edge Index

**Idea:** During flush, build a "reverse index" mapping dst → list of shards containing edges to dst.

**Benefit:** Incoming edge queries skip shards with no incoming edges.

**Complexity:** Need to maintain index, invalidate on updates.

**Decision:** Defer to T4.x. L0 bloom filter pruning is good enough.

### Resharding

**Idea:** Change shard_count from N to M. Rewrite all segments.

**Use case:** Database grows from 10k files to 1M files, need to scale from 8 to 64 shards.

**Complexity:** Full database rewrite, atomic switchover.

**Decision:** Defer to T5.x (operational features track).

---

## Research Notes

Based on web search for "directory-based graph database sharding partitioning approaches 2025":

**Key findings:**
1. **Directory-based sharding** uses a lookup table to determine data location, providing maximum flexibility but adding operational complexity. The directory can become a bottleneck. ([Source](https://sanket-panhale.medium.com/database-sharding-strategies-explained-range-hash-and-directory-based-sharding-8450cf8e54e7))

2. **Neo4j's property sharding** (2025) stores the graph structure (nodes/relationships) in a single cohesive unit while distributing property shards across machines. This preserves graph locality while scaling horizontally. ([Source](https://www.theregister.com/2025/09/11/neo4j_property_sharding_to_address_scalability_challenge/))

3. **Graph partitioning strategies** vary: some partition by vertex properties (geographic location, product type), others by edge types, or use clustering algorithms to keep related vertices in the same shard. ([Source](https://hypermode.com/blog/sharding-database))

**Our approach:**
- We're doing **hash-based partitioning with directory affinity**, not pure directory-based sharding (no lookup table bottleneck).
- Similar to Neo4j's approach: preserve locality (directory = locality unit), but use deterministic hashing (no central directory).
- Standard edge placement (edges with source node) is validated by graph database literature.

---

## Conclusion

Multi-shard layer is a **transparent abstraction** over single-shard. API stays the same, just fan-out internally. ManifestStore already supports sharding via `shard_id` field. Directory-based partitioning exploits file locality.

**Next steps:**
1. Joel expands this into detailed implementation plan
2. Uncle Bob reviews shard.rs/multi_shard.rs for refactoring opportunities
3. Kent writes tests (determinism, cross-shard edges, equivalence)
4. Rob implements

**Key invariants to preserve:**
- Same files → same plan (deterministic)
- Every file in exactly one shard (completeness)
- Query results identical to single-shard (correctness)
- Manifest commit is atomic (crash safety)

**Estimated timeline:** 2-3 days implementation + 1 day testing = **3-4 days total**.

---

## Sources

- [Database Sharding Strategies Explained: Range, Hash, and Directory Based Sharding | by Sanket Panhale | Dec, 2025 | Medium](https://sanket-panhale.medium.com/database-sharding-strategies-explained-range-hash-and-directory-based-sharding-8450cf8e54e7)
- [Database Sharding: A Comprehensive Guide for 2025 - Shadecoder](https://www.shadecoder.com/topics/database-sharding-a-comprehensive-guide-for-2025)
- [Sharding Strategies: Range, Hash, Directory-Based Sharding - DoHost](https://dohost.us/index.php/2025/08/01/sharding-strategies-range-hash-directory-based-sharding/)
- [How to Create Database Sharding Strategies](https://oneuptime.com/blog/post/2026-01-30-database-sharding-strategies/view)
- [What is Database Sharding?](https://www.nebula-graph.io/posts/what-is-database-sharding)
- [Database Sharding - System Design - GeeksforGeeks](https://www.geeksforgeeks.org/database-sharding-a-system-design-concept/)
- [What is Sharding in Graph Databases? Techniques and Benefits – Hypermode](https://hypermode.com/blog/sharding-database)
- [Distributed Graph Database: The Ultimate Guide](https://www.puppygraph.com/blog/distributed-graph-database)
- [Neo4j intros 'property sharding' to tackle scalability • The Register](https://www.theregister.com/2025/09/11/neo4j_property_sharding_to_address_scalability_challenge/)
- [Sharding and Partitioning Strategies in SQL Databases](https://www.rapydo.io/blog/sharding-and-partitioning-strategies-in-sql-databases)
