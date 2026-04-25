# Steve Jobs — High-level Review: REG-196

**Date:** 2026-02-09
**Reviewer:** Steve Jobs
**Status:** **REJECT**

---

## Summary

This plan attempts to add comprehensive benchmarking for RFDB, which is fundamentally the right thing to do. Performance is absolutely a core feature for Grafema — if queries are slow, AI will fall back to reading files, and we've failed our mission.

However, this spec has **critical architectural and scope problems** that will create long-term maintenance burden and deliver unclear value.

---

## Critical Issues

### 1. Benchmark Complexity Exploded Without Clear Value Proposition

**The Problem:**

Joel's spec balloons to **5 new benchmark files** with **20+ individual benchmarks**, plus shared infrastructure, CI integration, baseline management scripts, and extensive documentation. The implementation checklist spans **16-23 hours** across 6 phases.

**What's wrong:**

We currently have **8 benchmarks** in `graph_operations.rs` that cover the most critical operations. The spec proposes adding **15+ more benchmarks** without answering a fundamental question:

**What decisions will these benchmarks inform that our current 8 benchmarks don't?**

The spec benchmarks operations like `node_exists` (O(log n)) separately from `get_node` (also O(log n)). It benchmarks `count_nodes_by_type` with and without wildcards. It creates "mixed workload" simulations.

**But why?**

- Will we ever optimize `node_exists` differently from `get_node`? No — they use the same index.
- Do we need to know wildcard regex overhead separately? Not unless we're choosing between regex engines.
- Will "mixed workload" benchmarks catch regressions that operation-specific benchmarks miss? Unlikely — regressions appear in primitives first.

**This is benchmark theater.** We're measuring because we can, not because we need to.

### 2. Iteration Space Violations — O(n) Scans Over ALL Nodes

**The Problem:**

Multiple benchmarks iterate over dataset sizes up to **100K nodes**:

```rust
for size in [1000, 10000, 100000] {
    let (_dir, engine) = create_test_graph(size, ...);
    // Benchmark operations on 100K node graph
}
```

Operations benchmarked at 100K scale include:
- `find_by_type` (O(n) full scan)
- `find_by_attr` (O(n) full scan)
- `count_nodes_by_type` (O(n) aggregation)
- `get_all_edges` (O(m) full scan)

**Why this violates our architecture principles:**

Grafema is NOT designed for 100K-node single graphs. Our target is:
- **Node granularity:** functions, classes, imports (not expressions, not AST nodes)
- **Realistic file:** 500-2000 nodes per file in massive legacy codebases
- **Query patterns:** targeted queries via Datalog, not full scans

Benchmarking 100K-node graphs suggests we're optimizing for a use case that shouldn't exist. If an AI agent needs to scan 100K nodes, **the query is wrong** — they should be using Datalog to narrow the search space.

**This sends the wrong architectural signal.**

### 3. Missing Baseline — No Reference for "Good" Performance

**The Problem:**

The spec includes a "Performance Expectations" table:

```markdown
| Operation | Dataset | Target |
|-----------|---------|--------|
| add_nodes | 10K | <5ms |
| get_node | 100K graph | <50µs |
| bfs (depth=10) | 10K graph | <2ms |
```

**But these targets are invented.** There's no analysis of:
- What performance do we currently get?
- What performance do we need for AI agents to prefer graph queries over file reading?
- What performance do competing solutions (Neo4j, SQLite with graph extensions) achieve?

Without a baseline, these benchmarks measure **something** but don't tell us if it's **good enough**.

The spec even admits this: "These are guidelines, not hard requirements. Actual performance varies by hardware."

**Translation: these numbers are meaningless.**

### 4. Premature CI Integration — Optimization Before Measurement

**The Problem:**

The spec dedicates an entire phase (Phase 3) to CI integration with:
- Automated baseline tracking via `gh-pages` branch
- 10% regression threshold
- PR comment automation
- Baseline versioning scripts

**But we don't know if we have performance problems yet.**

CI regression detection makes sense when:
1. You have established performance targets
2. You've experienced regressions in the past
3. The cost of regression (user impact) justifies the CI complexity

We have NONE of these. This is **infrastructure for infrastructure's sake.**

**Better approach:** Run benchmarks manually when changing RFDB internals. Add CI automation ONLY when we've caught a real regression that CI would have prevented.

### 5. Shared Infrastructure Adds Complexity Without Reusability

**The Problem:**

The spec proposes `benches/common/mod.rs` with:
- Custom `BenchRng` (LCG implementation)
- `GraphTopology` enum (Chain, FanOut, Random)
- `create_test_graph` function
- Size constants

**Why this is over-engineered:**

1. **LCG RNG:** The justification is "no dependencies, deterministic, fast." But `rand` crate is already a dev-dependency. We're reinventing for no gain.

2. **GraphTopology enum:** Used by exactly 3 benchmarks (FanOut for outgoing edges, Chain for setup, Random for everything else). Not enough reuse to justify abstraction.

3. **create_test_graph:** Different benchmarks need different graph shapes. The "shared" function has 4 parameters and special-case logic. This will grow into a God function.

**Simpler approach:** Inline test data generation in each benchmark. Copy-paste is okay when abstraction doesn't simplify.

---

## Fundamental Questions This Spec Doesn't Answer

### Question 1: What specific performance problems are we solving?

**Not answered.** The spec says "performance is a core feature" (true) but doesn't identify current bottlenecks. Are we slow? Where?

### Question 2: How will benchmark results change our implementation?

**Not answered.** If `get_node` is 2× slower than target, do we switch from sled to redb? Add caching? The spec measures without defining action thresholds.

### Question 3: What's the ROI of 15+ new benchmarks vs improving the 8 we have?

**Not answered.** We could add dataset size variation to existing benchmarks. We could add statistical rigor (Criterion already does this). We could profile real-world workloads.

Instead, we're measuring `node_exists` separately from `get_node`.

---

## What Would Make This Acceptable

### Minimal Viable Benchmarking (4-6 hours instead of 16-23)

**Phase 1: Baseline Current Performance**
1. Run existing 8 benchmarks
2. Document current performance in README
3. Identify 2-3 operations that are slower than acceptable for AI agent workflows

**Phase 2: Targeted Benchmarks**
1. Add benchmarks ONLY for identified slow operations
2. Vary dataset sizes ONLY if we expect non-linear scaling
3. Inline test data generation (no shared infrastructure)

**Phase 3: Documentation**
1. Document when to run benchmarks (before RFDB changes)
2. Document acceptable performance (based on real AI agent usage patterns)
3. Skip CI automation until we have a real regression case

**Phase 4: Validate**
1. Run benchmarks locally
2. Verify results inform actual decisions (e.g., "flush is too slow, we need async")

**Defer to Future:**
- CI regression detection (add when we've caught 2+ real regressions manually)
- Mixed workload benchmarks (add when operation-specific benchmarks miss a regression)
- Versioned baselines (add when we're comparing across releases)

---

## Decision

**REJECT.**

**Reasoning:**

1. **Scope explosion without clear value.** 15+ new benchmarks, 5 files, 16-23 hours for infrastructure that measures "everything" but answers "nothing specific."

2. **Architecture violation.** Benchmarking 100K-node graphs signals we're optimizing for brute-force queries, not Datalog-driven targeted queries.

3. **Missing baseline.** Performance targets invented without reference to current performance, competitor performance, or user requirements.

4. **Premature optimization.** CI automation and baseline versioning before we know if we have performance problems.

5. **Over-engineered infrastructure.** Custom RNG, topology enums, shared test data generators for 5 files worth of benchmarks.

**This feels like "complete benchmarking" instead of "useful benchmarking."**

---

## Recommended Next Steps

1. **Don and Joel:** Create Minimal Viable Benchmarking spec (see above)
2. **Don:** Profile one real Grafema analysis session to identify actual bottlenecks
3. **Joel:** Expand minimal spec with targeted benchmarks for identified bottlenecks only
4. **Return for Steve review** after scope reduced to 4-6 hours and tied to real performance problems

---

## Steve Jobs Reminder

"Focus means saying no to good ideas so you can say yes to great ones."

Comprehensive benchmarking is a **good idea**. But right now, we don't have evidence that RFDB performance is a problem. We have 8 benchmarks. We haven't hit regressions.

**Saying no to premature benchmark infrastructure lets us say yes to shipping v0.2 features that users actually need.**

When we have performance problems, we'll benchmark the hell out of them. Until then, this is waste.

---

**Status: REJECT — Return to planning with reduced scope.**
