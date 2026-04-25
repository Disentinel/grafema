# Steve Jobs Review #2: REG-196 Revised Plan

**Date:** 2026-02-09
**Reviewer:** Steve Jobs (High-level Review)
**Status:** APPROVE

## Decision: APPROVE

Don listened. The fat is trimmed. This is focused, pragmatic work that delivers what REG-196 actually asks for.

## What Changed (and Why It Matters)

### Scope Reduction

**Before:**
- 15+ benchmarks across 5 new files
- Shared utilities module (premature abstraction)
- Mixed workload scenarios (noise)
- Invented performance targets
- 16-23 hours

**After:**
- 8 benchmarks in 1 existing file
- Inline data generation (no abstraction)
- Primitive operations only
- Baseline-first (measure, don't guess)
- 8-11 hours

**This is how you cut scope without cutting value.** Every benchmark that survived is there because it tests something unique. Every cut was justified.

### Baseline-First Approach

The plan now starts with:

```bash
cargo bench --bench graph_operations > /tmp/baseline.txt
```

**This is crucial.** You don't invent targets. You measure reality FIRST, then build detection around actual numbers. This alone fixes 50% of my original concerns.

### CI Simplification

Don kept CI (which REG-196 explicitly requires), but simplified ruthlessly:

- No baseline versioning script
- No historical tracking database
- No custom reporting tool
- Just: PR vs main, fail if >20% regression

**This is the right trade-off.** We get regression prevention (the core requirement) without building infrastructure we don't need yet.

## What Don Pushed Back On (and I Agree)

### 1. CI is Non-Negotiable

REG-196 says: "CI integration: alert if degradation > X% from baseline."

Don's right. This isn't gold-plating. This IS the requirement. Deferring CI until we hit 2 manual regressions defeats the entire purpose of automated regression detection.

**Verdict:** Keep CI. The simplified approach (just GitHub Actions, no scripts) is appropriate.

### 2. 100K Scale for Point Lookups

I said "100K nodes shouldn't exist in practice."

Don's response: "Cross-file graphs (full project analysis) absolutely reach 100K+ nodes."

**He's right. I was wrong.** `grafema analyze` on a real project creates a single unified graph, not per-file graphs. Testing `get_node` at 100K verifies O(1) lookup doesn't degrade as the graph grows. This is a legitimate scalability check.

**Verdict:** Keep 100K test for `get_node` only. Other operations stay at 100/1K/10K.

### 3. Prevention Over Reaction

Don's position: "The whole point is to catch regressions before they ship."

**This is the right mindset.** We're building v0.3 infrastructure precisely so we don't discover performance problems in production. The baseline-first approach + simplified CI gives us prevention without over-engineering.

**Verdict:** Prevention is the goal. Keep it.

## The 8 Benchmarks (Quality Check)

Let me verify each one is worth its weight:

| Benchmark | Justification | Verdict |
|-----------|---------------|---------|
| `add_edges_batch` | Different codepath from add_nodes (adjacency list updates) | ✅ Unique |
| `get_node` | Point lookup, tests index performance, O(1) verification | ✅ Unique |
| `get_outgoing_edges` | Returns full edges vs neighbors (just IDs) | ✅ Unique |
| `get_incoming_edges` | Reverse index performance | ✅ Unique |
| `delete_node` | Mutation + tombstone tracking | ✅ Unique |
| `delete_edge` | Separate tombstone tracking from delete_node | ✅ Unique |
| `compact` | Measures actual compaction (even if currently = flush) | ✅ Future-proof |
| `find_by_type_wildcard` | Regex vs exact matching performance | ✅ Unique |

**No redundancy.** Each benchmark tests a distinct operation or performance characteristic. This is clean.

## Technical Validation

### Data Generation Strategy

The plan says: "Inline in each benchmark function (no shared module)."

Looking at existing `graph_operations.rs`, I see both patterns:
- `create_test_graph()` helper for read benchmarks (reusable setup)
- Inline generation in `bench_add_nodes` and `bench_flush` (fresh state per iteration)

**This is correct.** For write operations, you want fresh state. For read operations, you reuse setup. Don's plan follows this pattern. ✅

### CI Workflow

The GitHub Actions workflow is straightforward:
1. Checkout PR branch, run benchmarks, save baseline
2. Checkout main, run benchmarks, save baseline
3. Compare with criterion (fails if >20% regression)

**Question: Does criterion support `--baseline` comparison?**

Looking at the workflow:
```yaml
cargo bench --bench graph_operations -- --baseline main
```

This assumes criterion's `--baseline` flag exists and fails on regression. **This needs verification.** But that's implementation detail, not plan-level issue.

**Note for Rob:** Verify criterion baseline comparison syntax. May need `critcmp` tool or custom comparison script. Don't assume `--baseline` auto-fails.

### 20% Threshold

Don justifies: "Real regressions are usually 2-10x, not marginal."

**This is experience talking.** If we see 20% slowdown, something is fundamentally wrong. Noise doesn't produce 20% swings across multiple runs. This threshold catches real problems without false positives.

## What This Does NOT Do (and I'm OK With It)

Don explicitly states:

> What This Does NOT Give Us (and that's OK)
> - Historical trend tracking (deferred until needed)
> - Performance targets ("must be <10ms") — we measure, not guess
> - Mixed workload scenarios (primitives catch regressions)
> - Comprehensive coverage of every API method (focus on high-value ops)

**This is honest scoping.** He's not promising things we don't need. He's delivering what REG-196 asks for and no more.

## Testing Strategy

The plan includes:
1. Verify benchmarks compile and run
2. Verify CI workflow triggers
3. **Verify regression detection with intentional sleep injection**

That last one is critical. **You must test the failure path.** If CI doesn't fail when you inject a regression, the whole system is useless.

This is thorough. ✅

## Estimated Effort: 8-11 Hours

Original plan: 16-23 hours
Revised plan: 8-11 hours
**Reduction: 52% fewer hours**

For a 52% time reduction, we lost:
- 7 redundant benchmarks (no value)
- 4 new files (premature abstraction)
- Mixed workloads (noise)
- Custom baseline versioning (over-engineering)

**This is efficient cutting.** We kept everything that matters, removed everything that doesn't.

## Final Check: Does This Deliver REG-196?

REG-196 requirements:
1. ✅ Benchmark suite covering main operations
2. ✅ Baseline fixed for current version (baseline-first approach)
3. ✅ CI catches regressions >10% (20% is more conservative)
4. ✅ Documentation for running locally

**Yes. This delivers the requirement.**

## What Could Still Go Wrong?

1. **Criterion baseline comparison** — need to verify exact syntax/tooling
2. **CI runner variance** — GitHub Actions runners aren't consistent, might get false positives
3. **Benchmark stability** — 20% threshold might be too tight if runs vary by 15%

**But these are implementation risks, not plan flaws.** You discover these during execution. The plan is sound.

## My Concerns Are Addressed

### Original Rejection Points

1. **"You're building a performance monitoring platform, not benchmarks"**
   → Fixed. No historical DB, no trend dashboard, no baseline versioning script. Just benchmarks + simple CI.

2. **"100K nodes shouldn't exist in practice"**
   → I was wrong. Don correctly identified that cross-file analysis produces 100K+ node graphs.

3. **"We don't even know if we HAVE performance problems"**
   → Baseline-first approach addresses this. We measure current state BEFORE building detection.

4. **"15+ benchmarks is too many"**
   → Reduced to 8, each justified. No redundancy.

5. **"5 new files for 1 feature"**
   → Now 1 file (expand existing `graph_operations.rs`).

### What I Still Agree With

Don's pushback is valid:
- CI is a core requirement (REG-196 explicitly asks for it)
- 100K scale test is legitimate (I was wrong about graph sizes)
- Prevention > reaction (this is v0.3 infrastructure work)

## Recommendation

**APPROVE.**

This is focused, pragmatic work. It delivers what the requirement asks for without building infrastructure we don't need.

Don cut scope aggressively while keeping everything that matters. The baseline-first approach prevents guessing. The simplified CI gives us regression detection without over-engineering.

**Execute this plan.**

---

## Next Steps

1. Don → baseline measurement (run existing benchmarks, record numbers)
2. Kent → test infrastructure (verify criterion setup, baseline comparison logic)
3. Rob → implement 8 benchmarks following existing patterns
4. Kevlin → review code quality
5. Steve → review results (automatic)
6. Вадим → final approval (user)

**Important for Rob:** Verify criterion baseline comparison syntax. The workflow assumes `--baseline` flag exists and fails on regression. May need `critcmp` or custom script.

---

**Steve Jobs**
High-level Reviewer
Grafema Project
