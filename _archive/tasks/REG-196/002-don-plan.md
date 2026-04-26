# Don Melton — High-Level Plan for REG-196

## Research Summary

I've researched current best practices for Criterion benchmark regression detection in CI (2026):

**Key findings:**

1. **[github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark)** — most popular solution for Criterion in GitHub Actions
   - Supports automatic regression detection with configurable thresholds (default 200%, but we'll use 110% = 10% degradation)
   - Can comment on PRs with benchmark comparison
   - Can fail workflow on regression
   - Supports trend charts over time
   - Works with Criterion's JSON output

2. **[critcmp](https://github.com/BurntSushi/critcmp)** — CLI tool for comparing Criterion results
   - Slurps up benchmark data from Criterion's target directory
   - Can compare baselines saved with `--save-baseline` flag
   - Workflow: `cargo bench -- --save-baseline main`, then checkout PR branch, run `cargo bench`, compare with critcmp
   - Good for local development, but github-action-benchmark is better for CI automation

3. **[criterion-compare-action](https://github.com/boa-dev/criterion-compare-action)** — PR-specific comparison
   - Compares PR benchmarks against base branch
   - Simpler than github-action-benchmark but less feature-rich
   - Good alternative if we want PR-only comparison

4. **Baseline tracking approaches:**
   - Store baseline JSON in repo (simple, version-controlled, but bloats repo)
   - Store as GitHub Pages artifact (github-action-benchmark default)
   - Store as workflow artifact (lightweight, but limited retention)

**Decision:** Use github-action-benchmark with baseline stored as workflow artifact (lightweight, sufficient for regression detection).

## Gap Analysis

**Current benchmark coverage (graph_operations.rs):**
- ✅ add_nodes (100, 1K, 10K)
- ✅ find_by_type (1K, 10K, 100K)
- ✅ find_by_attr (1K, 10K, 100K)
- ✅ bfs (100, 1K, 10K)
- ✅ neighbors (1K, 10K, 100K)
- ✅ reachability forward (100, 1K, 10K)
- ✅ reachability backward (100, 1K, 10K)
- ✅ flush (1K, 10K, 50K)

**Missing GraphStore operations (from trait in `src/graph/mod.rs`):**

**Critical gaps:**
- ❌ add_edges (separate from add_nodes — currently only called inside create_test_graph)
- ❌ delete_node (soft delete)
- ❌ delete_edge
- ❌ get_node (single node lookup)
- ❌ node_exists
- ❌ get_outgoing_edges / get_incoming_edges (separate from neighbors)
- ❌ get_all_edges
- ❌ node_count / edge_count (stats)
- ❌ compact (delta log compaction)
- ❌ count_nodes_by_type / count_edges_by_type
- ❌ find_by_type with wildcard (e.g., "http:*")
- ❌ Mixed workloads (read + write interleaved)

**Neo4j comparison:**
- ❌ Neo4j client is stubbed, not functional
- Decision: **SKIP Neo4j comparison for v0.3**. Rationale:
  - Requires Neo4j installation in CI (complexity)
  - Adds 5-10x effort for questionable value
  - Not a blocker for regression detection (which is the core goal)
  - Can be added later if needed for marketing/positioning

## Architecture Plan

### 1. Expand Benchmark Suite

**Structure:**
```
packages/rfdb-server/benches/
├── graph_operations.rs        # Existing (enhance)
├── mutation_operations.rs     # NEW: delete_node, delete_edge
├── lookup_operations.rs       # NEW: get_node, node_exists, get_*_edges
├── aggregation_operations.rs  # NEW: count_*, node_count, edge_count
├── maintenance_operations.rs  # NEW: compact
├── mixed_workloads.rs         # NEW: read+write patterns
└── neo4j_comparison.rs        # Existing (leave as-is, don't expand)
```

**Why split into multiple files?**
- Each file runs as separate Criterion benchmark group
- Easier to run specific subsets (`cargo bench --bench lookup_operations`)
- Avoids single 2000+ line file
- Matches Grafema's modular architecture principle

**Synthetic datasets:**
- Sizes: 100, 1K, 10K, 100K (match existing pattern)
- Graph topology: random graph with configurable density (edges = nodes * multiplier)
- Fixed seed for reproducibility (use `rand::SeedableRng`)
- Cold start: each benchmark iteration creates fresh TempDir + GraphEngine

### 2. Baseline Tracking Strategy

**Storage:** JSON files in repo at `packages/rfdb-server/benches/baselines/`

```
packages/rfdb-server/benches/baselines/
├── v0.1.0.json       # Historical baselines
├── v0.2.0.json
└── current.json      # Current version baseline
```

**Why in-repo instead of GitHub Pages?**
- Simpler: no GitHub Pages setup, no cross-repo complexity
- Version-controlled: baselines evolve with code
- Transparent: team can see baseline changes in PRs
- Lightweight: JSON files are small (<100KB total)

**Baseline update workflow:**
1. On main branch push: update `current.json` automatically
2. On release: copy `current.json` → `v{X.Y.Z}.json`
3. PRs: compare against `current.json`, don't update it

### 3. CI Integration

**New workflow: `.github/workflows/benchmark.yml`**

```yaml
name: Benchmark

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - Checkout code
      - Setup Rust toolchain
      - Run: cargo bench --bench graph_operations -- --save-baseline pr
      - Run: cargo bench --bench mutation_operations -- --save-baseline pr
      - Run: cargo bench --bench lookup_operations -- --save-baseline pr
      - Run: cargo bench --bench aggregation_operations -- --save-baseline pr
      - Run: cargo bench --bench maintenance_operations -- --save-baseline pr
      - Run: cargo bench --bench mixed_workloads -- --save-baseline pr
      - Use: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'criterion'
          output-file-path: target/criterion/**/estimates.json
          fail-on-alert: true           # Fail workflow if regression detected
          alert-threshold: '110%'       # 10% degradation = alert
          comment-on-alert: true        # Post comment on PR
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auto-push: ${{ github.ref == 'refs/heads/main' }}  # Update baseline on main
```

**Execution time estimate:**
- 6 benchmark files × ~2 min each = ~12 minutes total
- Within GitHub Actions free tier (2000 min/month)
- Acceptable for main branch push
- For PRs: make it optional (manual trigger via comment or label)

**Regression detection logic:**
- Threshold: 10% degradation (alert-threshold: '110%')
- Action: fail workflow + comment on PR with details
- False positive mitigation: Criterion's statistical rigor (multiple iterations, outlier detection)

### 4. Console Output

**Current state:** Criterion already provides excellent console output:
- ops/sec (throughput)
- time/iter (latency)
- Change from previous run (if baseline exists)

**Enhancement:** Add custom reporter for p50/p95/p99 latency percentiles.

Criterion supports custom output via `Criterion::plotting_backend()`. We can add a small reporter that extracts percentiles from Criterion's statistics and prints them in a table format.

**Example output:**
```
graph_operations/add_nodes/1000
  time:   [127.45 µs 128.12 µs 128.89 µs]
  change: [-2.1% -1.5% -0.8%] (improvement)
  thrpt:  7,806 ops/sec
  p50:    125.3 µs
  p95:    132.1 µs
  p99:    135.8 µs
```

Criterion already collects this data internally; we just need to expose it.

## Implementation Scope

**Phase 1: Expand benchmark suite** (60% of effort)
1. Create 5 new benchmark files (mutation, lookup, aggregation, maintenance, mixed)
2. Implement missing operation benchmarks
3. Add fixed-seed test data generator
4. Verify all benchmarks run successfully locally

**Phase 2: Baseline tracking** (20% of effort)
1. Create `benches/baselines/` directory
2. Run benchmarks, save initial `current.json`
3. Add script `scripts/benchmark-release.sh` to snapshot baseline on release

**Phase 3: CI integration** (15% of effort)
1. Create `.github/workflows/benchmark.yml`
2. Configure github-action-benchmark
3. Test on PR (verify alert triggers on intentional slowdown)

**Phase 4: Documentation** (5% of effort)
1. Update `packages/rfdb-server/README.md` with:
   - How to run benchmarks locally
   - How to compare against baseline
   - How to interpret results
2. Add section to main `CONTRIBUTING.md` about performance testing

## Risks & Mitigations

**Risk 1: GitHub Actions benchmark noise**
- Problem: CI environments have variable performance (noisy neighbors, throttling)
- Mitigation: Criterion's statistical analysis filters outliers; 10% threshold is conservative enough to avoid false positives
- Fallback: If noise becomes an issue, increase threshold to 15% or make PR benchmarks optional

**Risk 2: Benchmark suite takes too long**
- Problem: 12 minutes might slow down PR feedback
- Mitigation:
  - Make benchmark workflow optional on PRs (manual trigger via comment)
  - Always run on main branch (regression detection is critical there)
  - Can parallelize benchmark jobs if needed

**Risk 3: Baseline drift over time**
- Problem: What if hardware changes or Criterion version updates?
- Mitigation: Baselines are versioned; when drift is detected, we can:
  1. Re-baseline all historical versions on new hardware
  2. Or accept the break and start fresh baseline history
  - Decision: accept the break (simpler, v0.3 improvement not critical infrastructure)

**Risk 4: Missing important operations**
- Problem: We might not benchmark something critical
- Mitigation: This plan covers ALL GraphStore trait operations; if something is missing from the trait, that's a separate architectural issue

## Alignment with Project Vision

**"AI should query the graph, not read code"** — RFDB performance directly impacts this:
- Slow queries → AI falls back to reading files → vision fails
- Fast queries → AI trusts the graph → vision succeeds

**Regression detection ensures we don't accidentally sabotage the core thesis.**

**TDD principle:** Benchmarks are NOT tests, but they serve a similar purpose:
- Tests verify correctness
- Benchmarks verify performance doesn't regress
- Both are guardrails against breaking changes

**Root Cause Policy:** If we detect a regression, we don't just revert — we understand WHY it happened and fix the root cause.

## Success Criteria

1. ✅ Benchmark suite covers ALL GraphStore operations (not just current subset)
2. ✅ Baseline stored in repo (`benches/baselines/current.json`)
3. ✅ CI detects 10%+ regressions and fails workflow
4. ✅ Documentation exists for local benchmark runs
5. ✅ Neo4j comparison skipped (out of scope for v0.3)

## Out of Scope

- Neo4j comparison (stubbed code remains, but not expanded)
- Custom visualization dashboard (Criterion's HTML reports are sufficient)
- Historical trend analysis (GitHub Pages charts)
- Benchmark profiling/flamegraphs (separate tooling, not needed for regression detection)
- Benchmarking on multiple platforms (Linux only for CI, local runs are developer's choice)

## Estimated Effort

- **Planning (Don):** 2 hours (done)
- **Technical spec (Joel):** 3 hours
- **Implementation (Rob + Kent):** 16-20 hours
  - 5 new benchmark files: 10-12 hours
  - CI setup: 2-3 hours
  - Baseline tracking: 2 hours
  - Documentation: 2-3 hours
- **Review (Kevlin + Steve):** 2 hours

**Total: 23-27 hours (~3-4 days)**

## Next Steps

1. Joel expands this into detailed technical spec with:
   - Exact function signatures for each benchmark
   - Test data generation strategy (RNG seed, graph topology)
   - CI workflow YAML (full file, not pseudocode)
   - Baseline JSON schema
2. Kent writes tests that verify benchmarks run successfully (meta-testing)
3. Rob implements benchmark suite
4. Kevlin reviews code quality
5. Steve reviews alignment with vision

## Sources

Research grounded in:
- [github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark) — CI benchmark regression detection
- [critcmp](https://github.com/BurntSushi/critcmp) — Criterion baseline comparison tool
- [Criterion.rs](https://github.com/criterion-rs/criterion.rs) — Statistics-driven benchmarking library
- [boa-dev/criterion-compare-action](https://github.com/boa-dev/criterion-compare-action) — PR-specific benchmark comparison
- [Is GitHub Actions suitable for running benchmarks? | Quansight Labs](https://labs.quansight.org/blog/2021/08/github-actions-benchmarks) — Analysis of GHA benchmark noise
