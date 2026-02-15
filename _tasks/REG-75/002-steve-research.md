# Paid-Ready Quality Bar Research: REG-75
**Author:** Steve Jobs (Product Visionary)
**Date:** 2026-02-15
**Context:** Defining "ready to charge money for" threshold for Grafema v1

---

## Executive Summary

**The First Impression Problem:** When someone pays for a tool that promises "AI should query the graph, not read code," they will judge us in the first 5 minutes. If the graph is incomplete, queries return empty results, or performance is sluggish, they'll assume the vision is flawed—not that we're in beta. Money changes the relationship. Beta forgives gaps; paid demands delivery.

**Bottom Line:** Grafema can charge money when:
1. **The graph is trustworthy** (>85% accuracy, minimal false positives)
2. **Performance feels instant** (<1s for queries, <5min for analysis on typical codebases)
3. **It never crashes** (99%+ reliability, graceful degradation)
4. **AI agents actually prefer it over reading files** (measurable in task completion time)
5. **Documentation enables self-service** (new user to first insight in <15min)

**What we should NOT require for v1:** Perfect language coverage, incremental analysis, GUI, enterprise SSO, multi-repo federation. These are v2+ features.

---

## Industry Research: How Dev Tools Define "Paid-Ready"

### 1. Quality Bars from Static Analysis Tools (2024-2025)

#### Accuracy Standards

Industry benchmarks for false positive rates (2025):
- **Best-in-class:** 5-15% false positive rate ([Graphite Guide](https://graphite.com/guides/ai-code-review-false-positives))
- **CodeQL (gold standard):** 88% accuracy, 5% false positives ([sanj.dev benchmark](https://sanj.dev/post/ai-code-security-tools-comparison))
- **Acceptable range:** 16-35% depending on tool and use case ([Mend.io blog](https://www.mend.io/blog/benchmark-of-false-positives/))

**Key insight:** Tools emphasizing precision over recall (fewer false positives, potentially missing some issues) are preferred for paid tiers. Teams will tolerate missing features but NOT unreliable results.

#### Performance Expectations

From [SaaS performance benchmarking](https://www.binadox.com/blog/saas-performance-benchmarking-industry-standards-for-speed-uptime-and-user-satisfaction/):
- **API response time:** <200ms for 95% of requests during peak load
- **Availability:** 99.9%+ uptime baseline
- **Analysis speed:** Semgrep reports 20K-100K loc/sec per rule vs SonarQube's 0.4K loc/sec ([Aikido comparison](https://www.aikido.dev/blog/sonarqube-vs-semgrep))

**Grafema implication:** Sub-second query response is table stakes. Analysis time should feel fast enough to run multiple times per day.

### 2. Production Readiness Checklists (2025)

Key categories from [production readiness guides](https://www.port.io/blog/production-readiness-checklist-ensuring-smooth-deployments):

**Testing & Quality:**
- Automated test coverage with threshold enforcement before deployment
- Vulnerability scanning on every commit, blocking critical CVEs
- Load testing to identify bottlenecks under peak traffic

**Observability:**
- Clear error messages (not stack traces)
- Health check endpoints (`grafema doctor` serves this role)
- Metrics for performance tracking

**Security:**
- Authentication, authorization, encryption (less relevant for local-first CLI/MCP)
- Dependency scanning (npm audit)

**Documentation:**
- Self-service onboarding in <15 minutes
- Clear examples for common use cases
- Troubleshooting guide

### 3. Graph Database Performance Benchmarks

From [TigerGraph](https://www.tigergraph.com/benchmark/) and [GraphBenchmark](https://graphbenchmark.com/):
- **Modern in-memory graph DBs:** Sub-millisecond latency for typical queries
- **Neo4j (disk-based):** Optimized for larger persistent graphs with mature clustering
- **Memgraph (in-memory):** Optimized for sub-millisecond streaming analytics on RAM-sized datasets

**Grafema's RFDB:** Rust-based graph DB with unix socket IPC. Need to benchmark against 10K-1M node graphs to understand current performance profile.

---

## Grafema-Specific Quality Dimensions

### Dimension 1: Graph Accuracy & Coverage

**What it means:** Does the graph faithfully represent the codebase?

**Metrics:**
- **Node extraction accuracy:** % of expected entities (functions, classes, calls) correctly identified
  - Target: >90% for supported language constructs
  - Minimum: >85% (below this, graph becomes unreliable)

- **Edge resolution accuracy:** % of CALLS/DEPENDS_ON edges correctly resolved to targets
  - Target: >80% resolved (vs unresolved/dynamic)
  - Minimum: >70% (below this, dataflow is too incomplete)

- **False positive rate:** % of extracted nodes/edges that don't match source code
  - Target: <10% (match CodeQL standard)
  - Minimum: <20% (higher = noise drowns signal)

- **Coverage:** % of files successfully analyzed without errors
  - Target: >95% of entrypoint-reachable files
  - Minimum: >90% (gaps should be documented)

**Current state (from codebase analysis):**
- ~73 AST node types implemented, ~50+ missing (from `babel-ast-gaps-analysis.md`)
- Test suite: 1982 tests, 1600 passing, 360 failing (80.7% pass rate)
- Known gaps: import resolution incomplete for TS monorepos, classes not extracted as CLASS nodes, control flow layer missing

**Paid-ready criteria:**
- ✅ **MUST:** Test pass rate >95% (currently 80.7% — BLOCKER)
- ✅ **MUST:** All critical AST gaps (control flow, classes, imports) resolved
- ✅ **MUST:** `grafema doctor` validates graph health with actionable errors
- ⚠️ **SHOULD:** Graph accuracy benchmarks on 3-5 representative codebases
- 🔮 **NICE-TO-HAVE:** Automated accuracy regression tests (compare graph to known ground truth)

### Dimension 2: Query Performance

**What it means:** Does querying the graph feel instant?

**Metrics:**
- **Simple queries (<3 predicates):** <100ms p95
- **Complex queries (joins, transitive):** <1s p95
- **Find calls/nodes by name:** <200ms p95
- **Dataflow trace (depth <5):** <500ms p95

**Benchmarking approach:**
1. Create representative query suite (25-30 queries covering common patterns)
2. Run against 3 codebases of varying sizes:
   - Small: <10K LOC, <5K nodes
   - Medium: 50K-100K LOC, 20K-50K nodes
   - Large: 500K+ LOC, 100K+ nodes
3. Track p50, p95, p99 latencies

**Current state:**
- No performance benchmarks exist
- RFDB backend uses unix socket IPC (low overhead)
- MCP handlers have pagination (limit/offset) — good sign

**Paid-ready criteria:**
- ✅ **MUST:** Performance benchmark suite exists and passes targets
- ✅ **MUST:** Query timeout protection (kill queries >10s, return partial results)
- ⚠️ **SHOULD:** Query explain mode (`--explain` flag in MCP tools exists)
- 🔮 **NICE-TO-HAVE:** Query result caching for repeated queries

### Dimension 3: Analysis Speed & Reliability

**What it means:** Can users analyze real codebases without pain?

**Metrics:**
- **Analysis speed:** LOC/second throughput
  - Target: >10K LOC/sec (competitive with fast tools like Semgrep)
  - Minimum: >1K LOC/sec (acceptable for local CLI)

- **Crash-free rate:** % of analysis runs that complete without errors
  - Target: >99% on valid codebases
  - Minimum: >95%

- **Memory usage:** Peak memory during analysis
  - Target: <500MB for 100K LOC codebase
  - Minimum: <2GB (acceptable on dev machines)

**Current state:**
- Test suite has 360 failing tests (potential crash/correctness issues)
- `grafema doctor` command exists with 9 diagnostic checks (good foundation)
- No analysis speed benchmarks

**Paid-ready criteria:**
- ✅ **MUST:** Crash-free rate >95% measured on 10+ real codebases
- ✅ **MUST:** Analysis timeout protection (configurable max time)
- ✅ **MUST:** Incremental analysis OR clear docs on when to re-analyze
- ⚠️ **SHOULD:** Progress reporting during analysis (spinner, % complete)
- 🔮 **NICE-TO-HAVE:** Analysis speed benchmarks published (competitive positioning)

### Dimension 4: AI Agent UX (Value Delivery)

**What it means:** Do AI agents actually prefer the graph over reading files?

**Metrics:**
- **Task completion time:** Time for agent to answer typical questions
  - Target: 30-50% faster with graph vs direct file reads
  - Measurement: A/B test on representative tasks

- **Query success rate:** % of queries that return actionable results
  - Target: >80% (empty results are useless)
  - Minimum: >70%

- **Tool usage rate:** When graph + file reads available, how often does agent choose graph?
  - Target: >60% of exploration tasks use graph first
  - Measurement: Dogfooding metrics (tracked in task reports)

**Current state:**
- MCP server with 25 tools (comprehensive coverage)
- Dogfooding metrics tracked but data limited (see CLAUDE.md workflow v2.0)
- Known from dogfooding: import resolution gaps force fallback to file reads

**Paid-ready criteria:**
- ✅ **MUST:** 20+ real-world test scenarios documented with expected results
- ✅ **MUST:** Dogfooding metrics show graph-first workflow is faster for >50% of tasks
- ✅ **MUST:** Error messages guide users to correct tool/query (not just "no results")
- ⚠️ **SHOULD:** Prompt library (pre-built queries for common patterns)
- 🔮 **NICE-TO-HAVE:** Auto-suggest similar queries when no results found (already implemented in `handleQueryGraph`)

### Dimension 5: Documentation & Onboarding

**What it means:** Can a new user get value without asking for help?

**Metrics:**
- **Time to first insight:** From `npm install` to answering a real question
  - Target: <15 minutes
  - Measurement: User testing with 5+ developers unfamiliar with Grafema

- **Self-service success rate:** % of users who complete onboarding without support
  - Target: >75%
  - Minimum: >60%

- **Documentation coverage:** % of MCP tools with examples in docs
  - Target: 100%
  - Minimum: 90%

**Current state:**
- CLI README exists with basic examples
- MCP README exists with tool table and configuration
- No step-by-step tutorial ("Getting Started" guide)
- MCP `get_documentation` tool exists (onboarding, queries, types, guarantees topics)

**Paid-ready criteria:**
- ✅ **MUST:** "Getting Started" tutorial (init → analyze → 3 example queries → first guarantee)
- ✅ **MUST:** All 25 MCP tools have runnable examples in docs
- ✅ **MUST:** Troubleshooting guide (common errors + fixes)
- ⚠️ **SHOULD:** Video walkthrough (5-10 min screencast)
- 🔮 **NICE-TO-HAVE:** Interactive tutorial (CLI wizard mode)

### Dimension 6: Reliability & Error Handling

**What it means:** Does the tool degrade gracefully, or explode unpredictably?

**Metrics:**
- **Error message quality:** % of errors that explain WHAT + WHY + HOW TO FIX
  - Target: 100% of user-facing errors
  - Minimum: 90%

- **Partial success handling:** Can tool return partial results when some files fail?
  - Target: Yes, with clear warnings

- **Data corruption risk:** Does analysis ever leave graph in inconsistent state?
  - Target: 0% (transactional guarantees or clear rebuild)

**Current state:**
- `grafema doctor` provides diagnostic checks (good foundation)
- Error formatter exists (`packages/cli/src/utils/errorFormatter.ts`)
- RFDB auto-starts on MCP first query (reduces setup friction)

**Paid-ready criteria:**
- ✅ **MUST:** All CLI/MCP errors have actionable messages (no raw stack traces)
- ✅ **MUST:** `grafema analyze` handles partial failures gracefully (log warnings, complete what it can)
- ✅ **MUST:** Graph corruption detection + auto-rebuild recommendation
- ⚠️ **SHOULD:** Telemetry opt-in (crash reporting to improve reliability)
- 🔮 **NICE-TO-HAVE:** Automatic issue reporting with user consent (already implemented: `report_issue` MCP tool)

---

## Recommended "Paid-Ready" Thresholds

### Critical Blockers (MUST FIX)

| Dimension | Metric | Current | Target | Gap |
|-----------|--------|---------|--------|-----|
| **Accuracy** | Test pass rate | 80.7% | >95% | Fix 300+ failing tests |
| **Accuracy** | AST coverage | ~73 types | +Control Flow, Classes, TS imports | ~30 missing types |
| **Reliability** | Crash-free rate | Unknown | >95% | Benchmark on 10+ codebases |
| **Performance** | Query latency | Unknown | <1s p95 | Create benchmark suite |
| **Onboarding** | Time to first insight | Unknown | <15min | Create "Getting Started" guide |

### Important (SHOULD FIX)

| Dimension | Metric | Current | Target | Priority |
|-----------|--------|---------|--------|----------|
| **Accuracy** | Edge resolution | Unknown | >70% | Measure on test codebases |
| **Performance** | Analysis speed | Unknown | >1K LOC/sec | Benchmark + document |
| **Value Delivery** | Dogfooding success | Limited data | >50% prefer graph | More dogfooding |
| **Documentation** | Tool examples | Partial | 100% coverage | Write examples for all 25 tools |

### Nice-to-Have (v2+)

- Incremental analysis (RFDBv2 dependency)
- Classes extracted as CLASS nodes (design in progress)
- GUI visualization (v0.5+ roadmap)
- Query result caching
- Interactive tutorial mode

---

## What We Should NOT Require for v1

**Scope Control Principles:**

1. **Language Coverage:** V1 focuses on JS/TS. Python, Rust, PHP are v2+. Full TS type system support is v3+.

2. **Scale:** V1 targets codebases <500K LOC. Multi-million LOC enterprise scale is v2+ with RFDB optimizations.

3. **Features:** Incremental analysis, distributed analysis, federation are NOT v1. Clear docs on when to re-analyze are sufficient.

4. **Integrations:** V1 is local-first (CLI + MCP). CI/CD integrations, GitHub App, VS Code extension are v2+.

5. **Enterprise:** SSO, RBAC, audit logs, SLA guarantees are NOT v1. Early adopters are technical users who value capability over compliance.

**Why this matters:** Every "nice-to-have" feature delays the core value delivery. Ship the vision first, polish later.

---

## Product Intuition: What Makes or Breaks First Impression

### The 5-Minute Test

**Scenario:** User installs Grafema, follows docs, runs first query.

**Make-or-break moments:**

1. **Installation (0-2 min):**
   - ✅ `npm install -g @grafema/cli` works on Mac/Linux/Windows
   - ❌ Fails with unclear RFDB binary error → BLOCKER

2. **Initialization (2-3 min):**
   - ✅ `grafema init` auto-detects entrypoints, writes config
   - ❌ Requires manual plugin configuration → FRICTION

3. **Analysis (3-7 min):**
   - ✅ `grafema analyze` shows progress, completes in <5min for 50K LOC
   - ❌ Crashes on common JS patterns (optional chaining, nullish coalescing) → BLOCKER

4. **First Query (7-9 min):**
   - ✅ `grafema query "function login"` returns results with file:line
   - ❌ Returns empty results because imports not resolved → DISAPPOINTMENT

5. **First "Aha!" (9-12 min):**
   - ✅ `grafema trace "userId"` shows data flow across files
   - ❌ Trace incomplete, misses obvious path → DISTRUST

**The Distrust Problem:** If graph data is incomplete/wrong, user assumes the APPROACH is flawed, not just the implementation. They won't wait for fixes—they'll go back to grep.

### The Dogfooding Litmus Test

**Question:** Would I pay $50/month for Grafema in its current state for my own work on Grafema?

**Honest answer (Feb 2026):** Not yet. Why?
- 360 failing tests → reliability concerns
- Import resolution gaps → incomplete graph
- No performance benchmarks → unknown if it scales
- Missing control flow → dataflow analysis incomplete

**When would I pay?**
- Test pass rate >95%
- Critical AST gaps closed
- Dogfooding metrics show it's faster than file reads >50% of time
- Documentation exists so I don't need to remember CLI syntax

**This is the bar.** If I wouldn't pay for it, neither will early adopters.

---

## Proposed Paid-Ready Checklist (v1.0)

### Phase 1: Correctness (4-6 weeks)

- [ ] Fix failing tests → test pass rate >95%
- [ ] Implement control flow layer (BRANCH, LOOP nodes) — REG-267 in backlog
- [ ] Fix import resolution for TS monorepos
- [ ] Extract classes as CLASS nodes (design + implement)
- [ ] Benchmark graph accuracy on 5 test codebases (compare to manual audit)

### Phase 2: Performance (2-3 weeks)

- [ ] Create query performance benchmark suite (25-30 queries)
- [ ] Measure on small/medium/large codebases
- [ ] Optimize queries failing p95 targets (<1s for complex queries)
- [ ] Benchmark analysis speed (LOC/sec)
- [ ] Document performance characteristics in README

### Phase 3: Reliability (2-3 weeks)

- [ ] Test on 10+ real codebases (not curated test fixtures)
- [ ] Measure crash-free rate, fix top crashes
- [ ] Improve error messages (actionable WHAT+WHY+HOW)
- [ ] Add graph corruption detection to `grafema doctor`
- [ ] Handle partial analysis failures gracefully

### Phase 4: Value Delivery (2-3 weeks)

- [ ] Document 20+ test scenarios with expected results
- [ ] Run dogfooding metrics on 10+ tasks (graph vs file reads)
- [ ] Verify >50% of exploration tasks prefer graph
- [ ] Add prompt library (common patterns)
- [ ] Fix top "empty results" queries with better error hints

### Phase 5: Onboarding (1-2 weeks)

- [ ] Write "Getting Started" tutorial (init → analyze → 3 queries → 1 guarantee)
- [ ] Add runnable examples to all 25 MCP tools
- [ ] Write troubleshooting guide (top 10 errors + fixes)
- [ ] User test with 5+ unfamiliar developers (measure time to first insight)
- [ ] Record 10-min video walkthrough

**Total Estimated Timeline:** 11-17 weeks (3-4 months)

---

## Success Metrics (How We'll Know We're Ready)

### Quantitative Thresholds

| Metric | Target | Measurement |
|--------|--------|-------------|
| Test pass rate | >95% | CI dashboard |
| Graph accuracy | >85% nodes/edges correct | Manual audit of 5 codebases |
| Query latency (p95) | <1s complex, <200ms simple | Benchmark suite |
| Analysis crash-free | >95% | 10+ real codebase runs |
| Time to first insight | <15 min | User testing (n=5) |
| Dogfooding preference | >50% tasks use graph first | Task metrics from real work |

### Qualitative Signals

- [ ] **Internal dogfooding:** Grafema team uses it daily on Grafema codebase
- [ ] **External validation:** 3+ beta users report "this is faster than reading code"
- [ ] **Support volume:** <10% of users need help getting started
- [ ] **Error quality:** No user reports "cryptic error message" bugs

### The Ultimate Test

**Invite 10 technical early adopters (not friends).** Tell them:
> "This tool helps AI agents understand code by querying a graph instead of reading files. $50/month. Try it for 30 days."

**If <5 convert to paid after trial → NOT READY.**

Why? Because early adopters are optimists who WANT to believe. If they don't convert, mainstream users definitely won't.

---

## Sources

**Industry Benchmarks & Standards:**
- [Graphite: AI Code Review False Positives](https://graphite.com/guides/ai-code-review-false-positives) — Expected false-positive rates 5-15%
- [sanj.dev: AI Code Security Benchmark 2025](https://sanj.dev/post/ai-code-security-tools-comparison) — CodeQL 88% accuracy, 5% FP
- [Mend.io: SAST False Positive Benchmarks](https://www.mend.io/blog/benchmark-of-false-positives/) — Setting organizational benchmarks
- [Aikido: SonarQube vs Semgrep](https://www.aikido.dev/blog/sonarqube-vs-semgrep) — Performance comparison (20K-100K LOC/sec vs 0.4K)
- [Qodo: Code Quality Metrics 2025](https://www.qodo.ai/blog/code-quality/) — Quality in 2025 = context, review, architectural fit
- [Binadox: SaaS Performance Benchmarking](https://www.binadox.com/blog/saas-performance-benchmarking-industry-standards-for-speed-uptime-and-user-satisfaction/) — 99.9% uptime, <200ms API response
- [Port.io: Production Readiness Checklist](https://www.port.io/blog/production-readiness-checklist-ensuring-smooth-deployments) — Security, reliability, performance standards

**Graph Database Performance:**
- [TigerGraph Benchmarks](https://www.tigergraph.com/benchmark/) — Graph DB performance comparisons
- [GraphBenchmark](https://graphbenchmark.com/) — Micro-benchmarks for graph capabilities

**Production Readiness Frameworks:**
- [Cortex: Production Readiness Review](https://www.cortex.io/post/how-to-create-a-great-production-readiness-checklist) — Best practices for readiness checklists
- [OpsLevel: Production Readiness Guide](https://www.opslevel.com/resources/production-readiness-in-depth) — In-depth guide to production standards
- [SigNoz: Production Readiness for Developers](https://signoz.io/guides/production-readiness-checklist/) — Essential checklist for developers

---

## Conclusion

**Grafema can charge money when the core promise is reliably delivered:** AI agents query the graph and get better answers faster than reading code.

**Critical path (blockers):**
1. Fix correctness (test pass rate >95%, AST gaps closed)
2. Prove performance (benchmark suite passing targets)
3. Demonstrate value (dogfooding shows graph > files for >50% of tasks)

**Timeline:** 3-4 months of focused execution, assuming no major architectural pivots.

**Risk:** If we ship before these are met, we'll train users that "the graph doesn't work" — a perception that's nearly impossible to reverse. Better to stay in beta longer than to launch and disappoint.

**The Steve Jobs Question:** "Would this embarrass us?"

Current answer: Yes, because 20% test failure rate and unknown performance characteristics scream "unfinished."

Ready answer: No, because we've proven the core thesis on real codebases and can stand behind the quality.

---

**Next Steps:** Present to Вадим (user) for validation, then transition to Don Melton for technical planning of the 5-phase roadmap.
