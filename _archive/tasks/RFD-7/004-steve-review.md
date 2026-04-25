# Steve Jobs Review: RFD-7 Multi-Shard Plan

**Date:** 2026-02-13
**Reviewer:** Steve Jobs (High-level Review)
**Task:** RFD-7 (T2.3 Multi-Shard)

---

## Verdict: REJECT

This plan has **three critical architectural errors** that would result in broken code and a confusing user experience. Two are implementation bugs that would fail immediately. One is a subtle semantic mismatch that reveals incomplete understanding of the existing architecture.

---

## Critical Issues

### 1. **ManifestStore API Misuse — Code Will Not Compile**

**Location:** Joel's spec line 477, Don's plan line 384

**The error:**
```rust
// Joel's code (WRONG):
manifest_store.commit(all_node_descriptors, all_edge_descriptors)?;
```

**What the real API is:**
```rust
// manifest.rs lines 759-787 + 789-833
pub fn create_manifest(
    &self,
    node_segments: Vec<SegmentDescriptor>,  // FULL list
    edge_segments: Vec<SegmentDescriptor>,  // FULL list
    tags: Option<HashMap<String, String>>,
) -> Result<Manifest>

pub fn commit(&mut self, manifest: Manifest) -> Result<()>
```

**Why this matters:**

1. `create_manifest` takes the **FULL** list of segments (current + new), not just new ones
2. `create_manifest` returns a `Manifest`, not void
3. `commit` takes a `Manifest` object, not descriptor lists
4. This is a **two-step protocol**: create manifest, then commit it

**Correct code:**
```rust
// Step 1: Collect FULL segment lists (current + new)
let mut all_node_segs = manifest_store.current().node_segments.clone();
let mut all_edge_segs = manifest_store.current().edge_segments.clone();
all_node_segs.extend(new_node_descriptors);
all_edge_segs.extend(new_edge_descriptors);

// Step 2: Create manifest
let manifest = manifest_store.create_manifest(all_node_segs, all_edge_segs, None)?;

// Step 3: Commit
manifest_store.commit(manifest)?;
```

**Impact:** Joel's code will not compile. This is not a minor detail — it shows the spec author didn't actually look at the ManifestStore API before writing pseudocode.

---

### 2. **GraphError::InvalidOperation Does Not Exist**

**Location:** Joel's spec line 408

**The error:**
```rust
// Joel's code (WRONG):
return Err(GraphError::InvalidOperation(
    format!("Edge src node {} not found", edge.src)
));
```

**What error.rs actually has:** Lines 8-54 show all variants. There is no `InvalidOperation` variant.

**Correct error:**
```rust
return Err(GraphError::NodeNotFound(edge.src));
```

**Impact:** Code will not compile. Using the correct error type also improves error semantics — it's not an "invalid operation" to try to add an edge, it's that the source node is missing.

---

### 3. **Shard Paths vs Segment Paths — Architectural Confusion**

**Location:** Don's plan lines 414-450, Joel's spec lines 759-776

**The claimed directory structure:**
```
mydb.rfdb/
├── shards/
│   ├── 00/                # Don says "Shard 0 directory"
│   ├── 01/
│   └── ...
└── segments/
    ├── 00/                # Segment files for shard 0
    │   ├── seg_000001_nodes.seg
```

**What the code actually does:**

From `shard.rs` line 565:
```rust
fn segment_file_path(shard_path: &Path, seg_id: u64, type_suffix: &str) -> PathBuf {
    shard_path.join(format!("seg_{:06}_{}.seg", seg_id, type_suffix))
}
```

When you call `Shard::create(path)`, segments are written **directly to `path`**, not to `<db_path>/segments/<shard_id>/`.

From `manifest.rs` line 189:
```rust
if let Some(shard_id) = self.shard_id {
    db_path
        .join("segments")
        .join(format!("{:02}", shard_id))
        .join(filename)
}
```

`SegmentDescriptor::file_path()` constructs paths under `<db_path>/segments/<shard_id>/`.

**The problem:**

- Shard writes to `shard_path` (e.g., `<db_path>/shards/00/seg_000001_nodes.seg`)
- SegmentDescriptor expects files at `<db_path>/segments/00/seg_000001_nodes.seg`
- **These are different directories.**

**On open, the database will fail:**

```rust
// MultiShardStore::open constructs descriptors with shard_id=0
// SegmentDescriptor::file_path returns <db_path>/segments/00/seg_000001_nodes.seg
let file_path = desc.file_path(db_path);
let seg = NodeSegmentV2::open(&file_path)?;  // FILE NOT FOUND
```

**The fix:**

Don't pass `<db_path>/shards/00/` to `Shard::create()`. Pass `<db_path>` and let `SegmentDescriptor::file_path()` handle the shard subdirectories.

**But wait — that breaks single-shard too.** The real issue is that `Shard` currently writes segments to `shard_path` directly, but `MultiShardStore` needs segments to go to `<db_path>/segments/<shard_id>/`.

**Two options:**

A. Change `Shard::flush_with_ids` to accept `db_path` and compute segment paths using `SegmentDescriptor::file_path()` (correct, but changes Shard API)

B. Pass `<db_path>/segments/<shard_id>/` as the shard path (hack, but works with existing Shard)

**Neither option is mentioned in the spec.** Joel's spec says "NO `shards/` directories" but then the flush algorithm assumes Shard will write to the right place. It won't.

---

## Smaller Issues (Would Be Caught in Code Review, But Still Wrong)

### 4. node_to_shard Rebuild is O(N) with Allocation Waste

**Location:** Joel's spec line 1016

```rust
// Joel's code:
for (shard_idx, shard) in shards.iter().enumerate() {
    let nodes = shard.find_nodes(None, None); // Get all nodes
    for node in nodes {
        node_to_shard.insert(node.id, shard_idx as u16);
    }
}
```

**Why this is bad:**

`shard.find_nodes(None, None)` returns `Vec<NodeRecordV2>`. For 1M nodes, this allocates 1M full records (~200 bytes each = 200MB) just to extract IDs.

**Better approach:**

Add `Shard::get_all_node_ids() -> Vec<u128>` that iterates segments and returns only IDs. Or better, `Shard::for_each_node_id(|id| { ... })` callback pattern (zero allocation).

**Impact:** Works, but wasteful. For large databases (1M+ nodes), open() will spike memory and be slower than necessary.

---

### 5. Blake3 Choice is Defended, But Never Questioned

**Location:** Joel's spec line 689

Joel corrects Don's seahash suggestion and proposes blake3 "because it's already available."

**But:** Blake3 is a cryptographic hash. It's deterministic, yes, but it's **slower** than a non-crypto hash and has **256-bit output** when we only need 64 bits for modulo.

**Better choice:** `std::collections::hash_map::DefaultHasher` with a **fixed seed**. Deterministic, faster, already in std.

```rust
use std::hash::{Hash, Hasher};
use std::collections::hash_map::RandomState;

fn compute_shard_id(file_path: &str, shard_count: u16) -> u16 {
    let state = RandomState::new();  // Or use a fixed seed for determinism
    let mut hasher = state.build_hasher();
    dir.hash(&mut hasher);
    let hash = hasher.finish();  // u64
    (hash % shard_count as u64) as u16
}
```

**Problem:** `RandomState::new()` is NOT deterministic. We need a hasher with a **fixed seed**.

**Actually correct choice:** Use `std::hash::DefaultHasher` but **avoid `RandomState`**. Or, just use `fxhash` (already in Cargo.toml? Let me check... no).

**Wait.** Let me re-read. Joel says blake3 is "deterministic across platforms/versions." That's true. `DefaultHasher` is **not** guaranteed deterministic across Rust versions.

**Okay, blake3 is defensible.** But the spec should explain why determinism matters (same file list must produce same shard plan after db restart) and why crypto-level determinism is needed (Rust's std hasher is not stable).

**Impact:** Low. Blake3 works. But the reasoning is shallow — "it's already available" is not the real reason (determinism is).

---

## Architectural Gaps

### 6. No Discussion of Why Directory-Based Partitioning

Don's plan says "files in the same directory go to the same shard" and cites "locality of reference."

**But:** What if a project has 10,000 files in one directory (`src/`)? That's one hot shard.

**The spec should discuss:**
- When does directory-based partitioning break down?
- What's the recommended directory structure for good balance?
- What's the fallback if a project has pathological structure?

**Missing from the plan:**
- Monitoring for shard imbalance
- Recommendation to users about directory structure
- Future work on rebalancing (acknowledged as T5.x, but no sketch of approach)

**Impact:** Medium. Users will create databases that perform poorly, and we'll have no tooling to help them understand why.

---

### 7. No Discussion of Shard Count Selection

Default is 8. Why?

Don says "good for 10k-100k files" but provides no formula or heuristic.

**What the spec should include:**
- Formula: `shard_count = max(4, files / 10000)`?
- CLI guidance: "For projects with >100k files, use --shard-count=16"
- Warning: "Shard count cannot be changed after creation"

**Impact:** Low for L0, but will bite us in production. Users will create databases with wrong shard count and have to recreate.

---

## What Would Embarrass Us If We Shipped This?

1. **Code doesn't compile** (ManifestStore API, GraphError variant)
2. **Database fails to open after flush** (segment path mismatch)
3. **Slow open() for large databases** (node_to_shard rebuild allocates 200MB for 1M nodes)

Issues #1 and #2 are **showstoppers**. Issue #3 is "we should fix this before GA" but not a blocker for L0.

---

## Did We Do The Right Thing?

**Architecture:** Yes, directory-based partitioning is reasonable.

**Design choices:**
- ✅ node_to_shard HashMap — correct solution to edge routing problem
- ✅ Sequential flush — correct for L0, parallelism later
- ✅ Fan-out queries — correct for L0, optimization later
- ❌ ManifestStore API misuse — shows incomplete research
- ❌ Segment path mismatch — shows disconnect between plan and code
- ❌ node_to_shard rebuild is wasteful — fixable but should be noted

**Process:**
- Don did web research (good)
- Joel expanded into detailed spec (good effort, but didn't validate against real code)
- **Neither Don nor Joel actually read the ManifestStore implementation**

This is the core problem. The spec is detailed, but it's **not grounded in the actual codebase**. It's a plan for how multi-shard *should* work, not a plan for how to integrate with the *existing* storage layer.

---

## Required Changes Before Implementation

1. **Fix ManifestStore usage** — two-step protocol (create_manifest, commit)
2. **Fix GraphError variant** — use NodeNotFound(edge.src)
3. **Resolve segment path mismatch** — either:
   - Change Shard to accept db_path and use SegmentDescriptor::file_path(), OR
   - Pass `<db_path>/segments/<shard_id>/` as shard_path (hacky but works)
4. **Add node_to_shard rebuild optimization** — use ID-only iteration, not full record allocation
5. **Document shard count selection** — formula, CLI guidance, warnings

**Back to Joel for revision.**

---

## Complexity Check (Per Instructions)

### Issue #1 — ManifestStore API

**Iteration space:** N/A (API usage, not iteration)

**Problem:** Wrong API signature, code will not compile

**Fix:** Two-step protocol (create_manifest + commit)

### Issue #3 — Segment Paths

**Iteration space:** N/A (path construction)

**Problem:** Shard writes to `shard_path`, SegmentDescriptor expects `segments/<shard_id>/`

**Fix:** Either change Shard API or use hacky shard_path

### Issue #4 — node_to_shard Rebuild

**Iteration space:** O(total_nodes) — acceptable for L0, but wasteful

**Problem:** Allocates full NodeRecordV2 (200 bytes) when only ID (16 bytes) needed

**Fix:** Add `get_all_node_ids() -> Vec<u128>` or callback pattern

**Complexity verdict:** The O(N) rebuild is acceptable. The allocation waste is not.

---

## Alignment With Vision

**"AI should query the graph, not read code."**

This task is infrastructure (multi-shard storage layer). No direct impact on user-facing query API.

**But:** If shard count selection is wrong, queries will be slow. If node_to_shard rebuild is slow, database open is slow. Both hurt UX.

**Requirement:** Add monitoring/tooling so users can diagnose shard imbalance and open() slowness.

---

## Root Cause Analysis

Why did this happen?

1. **Joel wrote pseudocode without checking real APIs** — ManifestStore, GraphError
2. **Joel trusted Don's directory structure** — didn't validate against SegmentDescriptor::file_path()
3. **Neither Don nor Joel traced through a flush-open cycle** — would have caught segment path mismatch

**Process failure:** Spec writing without code validation.

**Fix:** Before Steve reviews, spec author must:
- Compile-check all pseudocode against real type signatures
- Trace through one full lifecycle (write → flush → open → query) on paper

---

## Decision

**REJECT** — Fix critical issues #1, #2, #3, and add optimization note for #4.

Joel: revise the spec, validate API usage, resolve segment path design, then resubmit for Steve review.

---

## Appendix: What Good Looks Like

**For ManifestStore usage:**

```rust
// Correct implementation
pub fn flush_all(&mut self, manifest_store: &mut ManifestStore) -> Result<()> {
    // Step 1: Start with current segments
    let mut all_node_segs = manifest_store.current().node_segments.clone();
    let mut all_edge_segs = manifest_store.current().edge_segments.clone();

    // Step 2: Flush each shard, collect new descriptors
    for (shard_idx, shard) in self.shards.iter_mut().enumerate() {
        let shard_id = shard_idx as u16;

        let node_seg_id = if shard.has_unflushed_nodes() {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };
        let edge_seg_id = if shard.has_unflushed_edges() {
            Some(manifest_store.next_segment_id())
        } else {
            None
        };

        if let Some(result) = shard.flush_with_ids(node_seg_id, edge_seg_id)? {
            if let Some(meta) = result.node_meta {
                let desc = SegmentDescriptor::from_meta(
                    node_seg_id.unwrap(),
                    SegmentType::Nodes,
                    Some(shard_id),
                    meta,
                );
                all_node_segs.push(desc);
            }
            if let Some(meta) = result.edge_meta {
                let desc = SegmentDescriptor::from_meta(
                    edge_seg_id.unwrap(),
                    SegmentType::Edges,
                    Some(shard_id),
                    meta,
                );
                all_edge_segs.push(desc);
            }
        }
    }

    // Step 3: Create manifest with FULL segment list
    let manifest = manifest_store.create_manifest(all_node_segs, all_edge_segs, None)?;

    // Step 4: Commit
    manifest_store.commit(manifest)?;

    Ok(())
}
```

**For segment paths:**

Either change `Shard::flush_with_ids` signature to:
```rust
pub fn flush_with_ids(
    &mut self,
    db_path: &Path,           // NEW: for SegmentDescriptor::file_path()
    shard_id: Option<u16>,    // NEW: for segment path construction
    node_segment_id: Option<u64>,
    edge_segment_id: Option<u64>,
) -> Result<Option<FlushResult>>
```

Or (hacky but works with current Shard API):
```rust
// In MultiShardStore::create
for shard_id in 0..shard_count {
    let shard_path = db_path.join("segments").join(format!("{:02}", shard_id));
    let shard = Shard::create(&shard_path)?;
    shards.push(shard);
}
```

**Recommendation:** Change Shard API. The current API assumes Shard owns its directory, but in multi-shard mode, segment paths are determined by SegmentDescriptor::file_path(). Make this explicit.

---

**End of review.**
