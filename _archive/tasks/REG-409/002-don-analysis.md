# Don Melton Analysis: REG-409 Duplicate Edges

## Root Cause

**Two bugs in RFDB's `GraphEngine`, both in the same file:**

`/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/graph/engine.rs`

### Bug 1: `flush()` does NOT deduplicate edges (PRIMARY)

Lines 1122-1153 of `engine.rs` — the `flush()` method collects all edges from segment + delta and writes them to disk WITHOUT deduplication:

```rust
// Собираем все рёбра
let mut all_edges = Vec::new();

// Из segment  (old persisted edges)
if let Some(ref segment) = self.edges_segment {
    for idx in 0..segment.edge_count() {
        if !segment.is_deleted(idx) {
            // ... push to all_edges
        }
    }
}

// From delta  (new edges from current session)
for edge in &self.delta_edges {
    if !edge.deleted {
        all_edges.push(edge.clone());  // NO DEDUP CHECK!
    }
}
```

Compare with `get_all_edges()` (lines 1368-1415) which DOES deduplicate using a `HashMap<(src, dst, edge_type), EdgeRecord>`. The flush path was never given the same treatment.

### Bug 2: `add_edges()` does NOT check for existing edges (CONTRIBUTING)

Lines 972-993 — edges are pushed unconditionally to `delta_edges`:

```rust
fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool) {
    for edge in edges {
        // Only validates node existence, NOT edge existence
        if !skip_validation {
            if !self.node_exists(edge.src) { continue; }
            if !self.node_exists(edge.dst) { continue; }
        }
        self.delta_log.push(Delta::AddEdge(edge.clone()));
        self.apply_delta(&Delta::AddEdge(edge));  // Just pushes to Vec
    }
}
```

And `apply_delta(AddEdge)` (lines 312-330) simply pushes the edge to `delta_edges` Vec without checking if an identical edge already exists.

## How Duplication Happens

### Scenario A: Re-analysis without `--clear` (most likely for host vs Docker diff)

1. First `grafema analyze` creates edges, flush writes them to segment
2. Second `grafema analyze` (without `--clear`) re-creates the same edges as delta
3. `flush()` combines segment + delta without dedup -> duplicates on disk
4. Each subsequent re-analysis compounds the problem

The CLI defaults to `forceAnalysis: false` (line 354 of `analyze.ts`):
```typescript
forceAnalysis: options.clear || false,
```

Running `grafema analyze` without `--clear` leaves old edges in the graph and adds new ones on top.

### Scenario B: Memory-triggered flush mid-analysis

Although `AUTO_FLUSH_THRESHOLD` is disabled (`usize::MAX`), memory-triggered flush still runs (80% memory threshold, line 478). If this triggers mid-analysis:

1. Analysis creates edges X -> Y (delta)
2. Memory flush -> edge goes to segment, delta cleared
3. Analysis continues, creates same edge X -> Y again (delta) — because GraphBuilder buffers edges per-file and doesn't check existing
4. Final flush -> both segment and delta copies written

### Scenario C: Analysis + Enrichment overlap (less likely but possible)

1. Analysis phase (GraphBuilder) creates CALLS edge X -> Y
2. Enrichment (FunctionCallResolver/MethodCallResolver) checks `getOutgoingEdges` — finds it, skips
3. This path is SAFE because enrichers check before creating

Enrichers are NOT the source of duplication. They correctly check for existing edges (FunctionCallResolver line 137, MethodCallResolver line 372).

## Why Host vs Docker Differs

- **Docker**: Fresh container, fresh graph, single analysis run -> ~12718 edges (correct)
- **Host**: Persistent graph from previous runs. If `grafema analyze` was run multiple times without `--clear`, edges accumulate -> ~19421 edges
- The ~6700 extra edges = roughly one full duplicate set from a second analysis run

## Which Layer Should Own Deduplication

**RFDB (engine.rs) — the storage layer.**

Rationale:
1. **Principle of least surprise**: A graph database should not store duplicate edges with the same (src, dst, type) triple. This is a fundamental graph property.
2. **Defense in depth**: Even if callers are well-behaved, the storage layer should enforce invariants.
3. **Performance**: Checking at add-time is O(1) with a HashSet; fixing at flush-time is also O(n) but happens less often.
4. **The fix in `get_all_edges()` already exists** — it proves the team already recognized this need, just didn't apply it to `flush()` or `add_edges()`.

Do NOT fix this in:
- Context command (output layer) — that would be a bandaid
- Enrichers — they already check correctly
- GraphBuilder — it should be able to add edges idempotently

## High-Level Plan

### Phase 1: Fix `flush()` deduplication (the direct fix)

Apply the same deduplication logic that `get_all_edges()` uses to the `flush()` method:

```rust
// Replace Vec with HashMap for dedup
let mut edges_map: HashMap<(u128, u128, String), EdgeRecord> = HashMap::new();

// Delta edges first (more recent, take priority)
for edge in &self.delta_edges {
    if !edge.deleted {
        let key = (edge.src, edge.dst, edge.edge_type.clone().unwrap_or_default());
        edges_map.insert(key, edge.clone());
    }
}

// Segment edges (don't overwrite delta)
if let Some(ref segment) = self.edges_segment {
    for idx in 0..segment.edge_count() {
        // ... same as current, but:
        if !edges_map.contains_key(&key) {
            edges_map.insert(key, edge);
        }
    }
}

let all_edges: Vec<EdgeRecord> = edges_map.into_values().collect();
```

### Phase 2: Add edge deduplication at `add_edges()` (preventive)

Add a check in `add_edges()` or `apply_delta(AddEdge)` to skip edges that already exist with the same (src, dst, type). This prevents duplicates from accumulating in delta_edges during a single session.

Options:
- **Option A**: HashSet index on `(src, dst, edge_type)` for O(1) lookup — best performance
- **Option B**: Check adjacency list + delta scan — already available data, no new structure
- **Option C**: Accept duplicates in delta, only dedup at flush — simplest, less memory-safe

Recommendation: **Option A** — add a `HashSet<(u128, u128, String)>` field `edge_keys` to GraphEngine. Check before inserting, maintained alongside delta_edges.

### Phase 3: Test

- Unit test: add same edge twice, verify edge_count() == 1
- Unit test: add edge, flush, add same edge, flush, verify edge_count() == 1
- Unit test: verify `get_outgoing_edges` returns no duplicates after flush cycle

## Files That Need Changes

1. **`packages/rfdb-server/src/graph/engine.rs`** — Primary fix:
   - `flush()` method: add dedup via HashMap (lines 1122-1153)
   - `add_edges()` / `apply_delta()`: add edge existence check (lines 972-993, 312-330)
   - Add `edge_keys: HashSet<(u128, u128, String)>` field to `GraphEngine` struct
   - Update `clear()`, `open()`, `create()` to initialize/maintain edge_keys

2. **`packages/rfdb-server/src/graph/mod.rs`** — No changes needed (trait interface is fine)

3. **Test file** (new or existing in rfdb-server tests) — Add deduplication tests

## Risk Assessment

- **flush() dedup**: LOW risk. Direct translation of proven `get_all_edges()` logic.
- **add_edges() dedup**: MEDIUM risk. Must ensure the HashSet is kept in sync across all code paths (add, delete, clear, open, flush rebuild). Must also handle metadata differences (same src/dst/type but different metadata — which metadata wins?).
- **Metadata policy**: When deduplicating, the delta (more recent) edge's metadata should win over segment metadata. This matches `get_all_edges()` behavior.

## Scope Estimate

- Rust changes: ~50-80 lines
- Tests: ~50 lines
- Total: 1-2 hours implementation, small and focused
