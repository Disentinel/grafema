# REG-413: Research Conclusion — Graph-Based Hints for AI Reasoning Augmentation

**Date:** 2026-02-15
**Status:** Research complete, actionable directions identified

## Executive Summary

Three research consultants analyzed the problem from different angles:

- **Tarjan** (graph algorithms): Identified tractable algorithms for all hint directions. WL hashing, Louvain clustering, betweenness centrality — all scale to 100K nodes, pre-compute in seconds.
- **Cousot** (formal analysis): Formalized change impact as sound abstract domain (dependency closure). Pattern detection lacks soundness but is measurable. Layered hint architecture recommended.
- **Альтшуллер** (ТРИЗ): Challenged the entire "hints" framing. Argued Grafema's 45%→20% drop signals information overload, proposed constraint-based navigation instead.

**Decision:** Proceed with **build → test → iterate** approach. Don's phased plan is sound. Incorporate Альтшуллер's constraint-based framing as an additional test direction, not a replacement. Fail fast if evidence shows hints don't help.

---

## Validated Directions (prioritized)

### Direction A: Call Site Context Expansion (Don's Direction 4)
**Effort:** 3-4 days | **Risk:** Low | **Evidence needed:** axios-5085 FAIL→PASS

**What:** When agent queries a function, automatically include code snippets at ALL call sites + sibling methods in same class/module.

**Why first:** Simplest intervention. Tests the basic hypothesis: "agent missed multi-location bug because it didn't see enough context." No new algorithms needed.

**Algorithm (Tarjan):** Simple fan-in traversal, O(degree) per query.
**Formal basis (Cousot):** Not a hint — just more context. No soundness concerns.
**ТРИЗ note:** This IS Альтшуллер's "semantic clustering" in minimal form — showing related code together.

**Test:** Re-run axios-5085 with expanded context. If PASS → direction validated. If FAIL → context wasn't the issue.

---

### Direction B: Graph-Derived Impact Hints (Don's Direction 2)
**Effort:** 6-8 days | **Risk:** Medium | **Evidence needed:** resolve rate improvement on multi-location bugs

**What:** When agent identifies a change target, surface structurally related nodes via graph analysis.

**Algorithm stack (Tarjan):**

| Algorithm | What it provides | Complexity | Pre-computed? |
|-----------|-----------------|------------|---------------|
| Fan-in/fan-out | "Called from N places" | O(1) lookup | Yes |
| Louvain community | "Part of N-node cluster with X, Y, Z" | O(E) | Yes |
| WL structural hash | "Structurally similar to: A, B" | O(3E) | Yes |
| Betweenness centrality | "Architectural choke point" | O(VE) | Yes |
| 2-hop neighborhood | "Closely coupled with: A, B, C" | O(deg²) | On-demand |

**Formal basis (Cousot):**
- Static dependency closure: **sound** (never miss required co-change)
- Hybrid static ∩ evolutionary: ~70-85% precision
- Layered presentation: structural (sound) → historical (empirical) → heuristic

**Implementation:**
1. Pre-compute metrics during graph build (~1-5s for 100K nodes, 60 bytes/node)
2. New MCP tool: `get_change_impact(semantic_id)` → returns ranked co-change candidates
3. Top-5 candidates with confidence scores

**Test:** Re-run failed multi-location tasks with impact hints. Measure if agent finds additional change locations.

---

### Direction C: Constraint-Based Navigation (Альтшуллер's alternative)
**Effort:** 10-12 days | **Risk:** Medium-High | **Evidence needed:** resolve rate > baseline (>45%)

**What:** Instead of adding hints, narrow the search space. Graph builds "impact zone" from bug description, agent sees only relevant nodes.

**Mechanism:**
1. New MCP tool: `get_impact_zone(bug_description)` → returns filtered node set
2. Agent works within impact zone for first N steps
3. Fallback to full graph if stuck

**Why test this:** Альтшуллер's root cause analysis (tunnel vision, semantic mismatch, premature optimization) may be partially correct even if the conclusion ("stop all hints") is too strong. The constraint approach and hints aren't mutually exclusive.

**Test:** Re-run all failed tasks with impact zone. Compare resolve rate vs baseline AND vs hints-only.

---

### Direction D: Co-Change Patterns from Git History (Don's Direction 1)
**Effort:** 8-10 days | **Risk:** Medium | **Evidence needed:** hint precision >70%

**What:** Mine git history for functions that frequently change together. Surface as co-change candidates.

**Algorithm (Tarjan):** CodeScene-style temporal coupling. O(commits × files). Pre-computed, incremental update O(files per commit).

**Formal basis (Cousot):** Empirical, not sound. But intersection with static closure improves precision without sacrificing soundness: `Hints = Static_closure ∩ Top_k(Cochange_scores)`.

**Prerequisite:** Requires repos with sufficient history (>50 commits). SWE-bench repos qualify.

**Test:** Compute co-change scores for axios/preact repos. Verify that gold patch locations appear in top-5 co-change candidates for at least 50% of multi-location bugs.

---

### Direction E: Architectural Pattern Detection (Don's Direction 3)
**Effort:** 10-12 days | **Risk:** High | **Evidence needed:** pattern precision >75%

**What:** Extract dominant coding patterns (error handling style, storage location, guard patterns) and surface when agent makes design decisions.

**Formal basis (Cousot):**
- No soundness guarantee (empirical, not logical)
- Semi-lattice over frequent subtrees
- File-level scope only, ≥60% prevalence threshold, ≥10 instances
- Expected precision: ~80% within-file, ~60% cross-file

**DEFER until Directions A-D validated.** Highest effort, weakest formal foundation, most likely to cause information overload (Альтшуллер's concern applies here most).

---

## Recommended Experiment Plan

### Phase 1: Quick Validation (2 weeks)

**Goal:** Determine if ANY graph-based intervention improves resolve rate.

| Experiment | Direction | Days | What we learn |
|-----------|-----------|------|---------------|
| 1a. Manual hint ceiling | — | 2-3 | Upper bound of hint approach |
| 1b. Call site expansion | A | 3-4 | Does more context help? |
| 1c. Impact zone (constraint) | C (simplified) | 3-4 | Does less context help? |

**Run 1a first** — if perfect manual hints don't improve resolve rate, the problem is model reasoning and no tool will help. This is the go/no-go gate.

**Go/No-Go after Phase 1:**
- **GO** if ANY of 1a/1b/1c shows >15% resolve rate improvement
- **PIVOT** if manual hints help but automated don't → focus on hint quality
- **NO-GO** if nothing helps → document boundary, focus Grafema on cost reduction

### Phase 2: Structural Hints (3 weeks)

**If Phase 1 shows promise:**

| Experiment | Direction | Days | Depends on |
|-----------|-----------|------|------------|
| 2a. Graph impact hints | B | 6-8 | Phase 1 GO |
| 2b. Co-change patterns | D | 8-10 | Phase 1 GO (can parallel with 2a) |

**Experiment design:**
- Full SWE-bench JS/TS subset (43 tasks) for statistical power
- A/B: baseline vs hints, paired comparison
- Same model (Sonnet 4.5), same agent, same budget
- p < 0.05 for significance

### Phase 3: Advanced (3-4 weeks)

**Only if Phase 2 validates:**
- Direction E (architectural patterns)
- Hybrid constraint + hints approach
- Semantic edge types (SIMILAR_STRUCTURE, HANDLES_SAME_DATA)

---

## Algorithm Implementation Spec (for future REG tickets)

### Pre-computation Pipeline (during `grafema analyze`)

```
1. Fan-in/Fan-out counts          → node metadata    [O(E)]
2. Louvain community detection    → community_id     [O(E)]
3. WL structural fingerprint (h=3) → wl_hash         [O(3E)]
4. Betweenness centrality         → centrality_score  [O(VE)]
5. Tarjan SCC                     → scc_id, scc_size  [O(V+E)]
```

Total: ~60 bytes metadata per node. 100K nodes = 6 MB overhead.
Build time: 1-5 seconds on modern CPU.

### MCP Tools to Build

| Tool | Direction | Input | Output |
|------|-----------|-------|--------|
| `get_change_impact` | B | semantic_id | Ranked co-change candidates with scores |
| `get_impact_zone` | C | bug_description text | Filtered node set (impact zone) |
| `get_similar_functions` | B | semantic_id | Structurally similar nodes (WL hash) |
| `get_cochange_history` | D | semantic_id | Git co-change partners with frequency |

### Hint Format (for AI consumption)

```
## Change Impact Analysis: AxiosHeaders.toJSON

**Fan-out:** 5 callers across 3 files
**Community:** AxiosHeaders cluster (12 nodes)
**Centrality:** Top 8% (architectural choke point)

**Co-change candidates (structural):**
1. AxiosHeaders.normalize() — same community, shared data flow [0.85]
2. AxiosHeaders.set() — same community, 2-hop neighbor [0.72]
3. utils.forEach() — high betweenness bridge [0.45]

**Structurally similar functions:**
- AxiosHeaders.normalize() — WL similarity 0.91
```

---

## Key Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Manual hints don't help (reasoning ceiling) | Medium | Research stops | Phase 1 gate catches this early (2-3 days) |
| Hints cause information overload | Medium | Negative resolve rate | Top-5 limit, confidence threshold, A/B test |
| Graph too incomplete for useful hints | Low | Low precision | Track graph coverage per task, fix gaps in parallel |
| SWE-bench not representative | Medium | Results don't generalize | Also test on real Grafema development tasks |
| Algorithms too slow at scale | Low | Latency issues | All algorithms validated tractable to 100K nodes |

---

## Deliverables Tracking

| Deliverable | Status | Location |
|-------------|--------|----------|
| Research plan (Don) | Done | 002-don-research-plan.md |
| Graph algorithms analysis (Tarjan) | Done | 003-tarjan-graph-algorithms.md |
| Formal analysis (Cousot) | Done | 004-cousot-formal-analysis.md |
| ТРИЗ analysis (Альтшуллер) | Done | 005-altshuller-triz.md |
| Synthesis & conclusion | Done | 006-synthesis-research-conclusion.md |
| Implementation tickets | TODO | Linear (after user approval) |

---

## Next Steps

1. **User approval** of research direction
2. **Create Linear tickets** for Phase 1 experiments (1a, 1b, 1c)
3. **Phase 1 execution** — 2 weeks, single worker
4. **Go/No-Go decision** based on Phase 1 results
5. If GO → Phase 2 tickets + execution
