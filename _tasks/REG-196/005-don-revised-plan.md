# REG-196 Revised Plan: RFDB Performance Regression Detection

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-09
**Status:** Addressing Steve Jobs feedback

## Response to Steve's Feedback

### What We Agree With (Cuts)

Steve is right about scope creep. Original plan had:
- 15+ benchmarks (many redundant)
- 5 new files (premature abstraction)
- Mixed workloads (noise, not signal)
- Invented performance targets (baselines not measured first)

**Cuts:**
1. **No new files** — expand existing `graph_operations.rs` only
2. **No shared utilities module** — inline data generation, avoid abstraction
3. **No mixed workloads** — remove read_heavy, write_heavy, balanced scenarios. Primitive ops catch regressions.
4. **No redundant benchmarks**:
   - `node_exists` (same as get_node, returns bool)
   - `node_count`/`edge_count` (O(1) lookups, no regression risk)
   - `count_nodes_by_type`/`count_edges_by_type` (same iteration pattern as find_by_type)
   - `get_all_edges` (covered by find operations)
   - `get_node_identifier` (thin wrapper)
   - `update_node_version` (same as delete + add)
5. **Baseline-first approach** — run existing benchmarks NOW, get real numbers before writing code

**Revised scope: 8 new benchmarks in 1 file. Estimated: 6-10 hours.**

### What We Push Back On (Keeping)

1. **"We don't know if we have performance problems"**
   → This is **prevention**, not reaction. v0.3 is stability & infrastructure. By the time we discover regressions in production, it's too late.

2. **"100K nodes shouldn't exist in practice"**
   → Cross-file graphs (full project analysis) absolutely reach 100K+ nodes. `grafema analyze` on a real project creates a single graph, not per-file graphs. We need to know how operations scale.

3. **"Defer CI until 2+ manual regressions"**
   → REG-196 explicitly asks for CI regression detection. But we simplify: GitHub Actions benchmark job, no baseline versioning script. Just fail if >20% regression vs main.

## What We're Building

### Phase 1: Baseline Measurement (1 hour)

Before writing ANY code:

```bash
cd packages/rfdb-server
cargo bench --bench graph_operations > /tmp/baseline.txt
```

Extract actual numbers. Use these as references, not invented targets.

### Phase 2: New Benchmarks (4-6 hours)

**Add to `packages/rfdb-server/benches/graph_operations.rs`:**

| Benchmark | Operation | Sizes | Why It Matters |
|-----------|-----------|-------|----------------|
| `add_edges_batch` | Batch edge insertion | 100, 1K, 10K | Different codepath from add_nodes — adjacency list updates |
| `get_node` | Point lookup by ID | 100, 1K, 10K, 100K | Fundamentally different from find_by_type scan — tests index performance |
| `get_outgoing_edges` | Adjacency list traversal | 100, 1K, 10K | Different from neighbors (returns full edges, not just IDs) |
| `get_incoming_edges` | Reverse adjacency | 100, 1K, 10K | Verify reverse index is not slower than forward |
| `delete_node` | Soft-delete node | 100, 1K, 10K | Mutation operations — important for versioning overhead |
| `delete_edge` | Soft-delete edge | 100, 1K, 10K | Separate from delete_node — different tombstone tracking |
| `compact` | Compact after deletions | After 10%, 50%, 90% deletes | Even if currently = flush, when it diverges we need baseline |
| `find_by_type_wildcard` | Regex type matching | 100, 1K, 10K | Real question: is wildcard matching significantly slower than exact? |

**Scale rationale:**
- 100, 1K, 10K for most ops (catches O(n) vs O(log n) differences)
- 100K ONLY for `get_node` (point lookup should be O(1) regardless of size)
- Compact uses % of graph deleted (size-independent metric)

**Data generation:**
- Inline in each benchmark function (no shared module)
- Use `format!("test_node_{}", i)` pattern from existing benchmarks
- For edges: connect nodes in patterns that exist in real graphs (tree, DAG, some cycles)

### Phase 3: CI Integration (2-3 hours)

**GitHub Actions workflow** (`.github/workflows/benchmark-regression.yml`):

```yaml
name: Performance Regression Check

on:
  pull_request:
    paths:
      - 'packages/rfdb-server/src/**'
      - 'packages/rfdb-server/benches/**'

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable

      # Benchmark PR branch
      - name: Run benchmarks (PR)
        run: |
          cd packages/rfdb-server
          cargo bench --bench graph_operations -- --save-baseline pr

      # Benchmark main branch
      - uses: actions/checkout@v4
        with:
          ref: main
      - name: Run benchmarks (main)
        run: |
          cd packages/rfdb-server
          cargo bench --bench graph_operations -- --save-baseline main

      # Compare (fail if >20% regression)
      - name: Compare baselines
        run: |
          cd packages/rfdb-server
          cargo bench --bench graph_operations -- --baseline main
```

**Simplified approach:**
- No baseline versioning script
- No historical tracking (just PR vs main)
- Fail CI if >20% regression detected by criterion
- Manual investigation for failures

**Note:** 20% threshold is chosen conservatively. Real regressions are usually 2-10x, not marginal.

### Phase 4: Documentation (1 hour)

**Update `packages/rfdb-server/README.md`:**

```markdown
## Performance Benchmarks

### Running Locally

```bash
cd packages/rfdb-server
cargo bench --bench graph_operations
```

### CI Regression Detection

GitHub Actions runs benchmarks on every PR touching RFDB code.
Fails if >20% regression vs main branch.

### Adding New Benchmarks

When adding new RFDB operations:
1. Add benchmark to `benches/graph_operations.rs`
2. Use existing scale patterns (100, 1K, 10K)
3. Inline data generation (no shared utilities)
4. PR will verify no regression introduced
```

## Testing Strategy

1. **Verify benchmarks compile and run:**
   ```bash
   cargo bench --bench graph_operations -- --test
   ```

2. **Verify CI workflow:**
   - Create test PR changing RFDB code
   - Verify workflow triggers
   - Verify both baselines run
   - Verify comparison executes

3. **Verify regression detection:**
   - Temporarily add `std::thread::sleep(100ms)` to get_node
   - Verify CI fails with clear message
   - Revert sleep, verify CI passes

## Deliverables

1. **Code:**
   - 8 new benchmarks in `packages/rfdb-server/benches/graph_operations.rs`
   - GitHub Actions workflow `.github/workflows/benchmark-regression.yml`

2. **Documentation:**
   - Updated `packages/rfdb-server/README.md` with benchmark instructions

3. **Validation:**
   - Baseline measurements from existing benchmarks (real numbers)
   - CI workflow tested with intentional regression
   - All benchmarks passing

## Estimated Effort

- Phase 1 (Baseline): 1 hour
- Phase 2 (Benchmarks): 4-6 hours
- Phase 3 (CI): 2-3 hours
- Phase 4 (Docs): 1 hour

**Total: 8-11 hours** (includes testing and validation)

## Success Criteria

1. ✅ All new benchmarks compile and run
2. ✅ CI workflow triggers on RFDB changes
3. ✅ CI detects intentional regression (sleep injection test)
4. ✅ Benchmarks cover operations missing from current suite
5. ✅ Documentation clear enough for contributors to add benchmarks

## What This Gives Us

- **Regression detection:** CI catches performance degradation before merge
- **Baseline for optimization:** When we do optimize, we have numbers to compare against
- **Coverage of missing ops:** get_node, edges, deletes, compact now benchmarked
- **Scalability verification:** 100K node test confirms O(1) lookups don't degrade

## What This Does NOT Give Us (and that's OK)

- Historical trend tracking (deferred until needed)
- Performance targets ("must be <10ms") — we measure, not guess
- Mixed workload scenarios (primitives catch regressions)
- Comprehensive coverage of every API method (focus on high-value ops)

---

**Next Step:** Kent writes tests for benchmark infrastructure (verify criterion setup, baseline comparison logic). Then Rob implements benchmarks following existing patterns in `graph_operations.rs`.
