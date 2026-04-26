# Steve Jobs Review: RFDB v2 Roadmap & Task Specs

> Reviewer: Steve Jobs (High-level Review)
> Date: 2026-02-12
> Scope: All 25 task specs, roadmap (002), expert concerns (004), orchestrator design (005), milestones (008)
> Default stance: REJECT

---

## Verdict: CONDITIONAL APPROVE

I came in looking for fatal flaws. I found a plan that is architecturally sound, deeply considered, and honest about its constraints. The expert concerns process was real -- they found genuine contradictions (C3 vs C4, the TRIZ separation-in-time resolution) and didn't paper over them.

That said, this is a conditional approval. There are structural risks that need acknowledgment and mitigation before I'd put this on stage. Let me be precise.

---

## What This Plan Gets Right (and Why It Matters)

### 1. The Architecture is Correct

Immutable segments + manifest chain + MVCC = the proven pattern (Parquet, RocksDB, DuckDB). This isn't novel -- it's deliberately not novel. For a storage engine rewrite, "boring and proven" is exactly what you want. The team resisted the temptation to invent new data structures and instead composed well-understood ones.

The key insight -- semantic ID as a first-class column, not a metadata hack -- is the kind of decision that makes everything downstream cleaner. 30-40% metadata bloat eliminated. Round-trip without parse-and-reconstruct. This is infrastructure that pays dividends in every query.

### 2. The Expert Concerns Process Was Genuine

The C3/C4 contradiction is the kind of thing that kills projects in production. Tombstone filtering hides the exact edges blast radius needs. The TRIZ resolution (query dependents BEFORE commit) is elegant and sound -- it exploits the temporal ordering rather than fighting it.

The I2 enrichment shard model (`__enrichment__/{enricher}/{file}`) is a clean abstraction. No `_owner` metadata field, no read-during-write. Ownership = shard = file context string. Simple.

Content hash (I4) serving dual duty as precision diff AND analyzer coverage canary -- that's the kind of "one mechanism, multiple uses" thinking Grafema's architecture demands.

### 3. The Dependency Graph is Honest

The parallelism map clearly shows Track 2 and Track 3 are idle during M2 (storage engine build). The plan doesn't pretend all three tracks are always busy. This honesty is more valuable than an optimistic fiction.

### 4. The Critical Gate Pattern

"All 120 existing tests pass on v2" as the M4 gate -- this is the right approach. Not "we wrote new tests that pass" but "the existing contract, which was never designed for v2, validates the new engine." This is real proof, not theater.

### 5. Vision Alignment

Does this plan deliver "AI should query the graph, not read code"? Yes. The combination of:
- Snapshot diff (what changed between commits)
- Blast radius (who is affected)
- Incremental enrichment (only update what changed)
- Streaming (handle arbitrarily large results)

...makes the graph a live, queryable representation of the codebase that stays current as files change. This is directly on vision.

---

## Structural Risks (Must Acknowledge, Must Mitigate)

### RISK 1: The "Dead Zone" -- Track 2/3 Idle During M2

The parallelism map shows Track 2 (Orchestrator) and Track 3 (Client) are "(free)" for the entire M2 milestone (T2.1 -> T2.2 -> T2.3). This is a sequential Rust chain. No TS work can proceed.

**Why it matters:** If M2 takes longer than expected (which Rust work often does -- borrow checker, mmap edge cases, alignment bugs), the entire project timeline slides. Track 2/3 engineers either work on other things or sit idle.

**Mitigation:** The plan already identifies this risk implicitly by marking "(free)". Explicitly: during M2, Track 2/3 should work on product features from the v0.2 backlog. Do NOT invent make-work for them inside rfdb-v2. But DO track M2 velocity and have contingency if it's slower than estimated.

**Status:** Acknowledged, not a blocker.

### RISK 2: T4.1 Complexity is Under-Estimated (Even After I1 Acknowledgment)

The expert concerns document notes I1: "Phase 5 likely under-estimated." The resolution says "addressed by Track 3." But T4.1 itself (Wire Protocol v3 Integration) is estimated at ~500 LOC. This is the task that:

- Implements GraphEngine trait for v2 (every method, including edge cases)
- Switches all protocol handlers
- Adds batch commit handlers
- Adds DiffSnapshots handler
- Adds streaming support
- Handles removed commands (GetAllEdges, UpdateNodeVersion, DeleteNode/DeleteEdge)
- Adapts ~120 existing tests
- Adds version handshake
- Handles ephemeral databases

500 LOC of *refactoring* plus adapting 120 tests is a significant undercount. Adapting 120 tests alone could take days if behavioral differences surface. The task spec for T4.1 is also thinner than earlier specs (T1.1, T1.2, T1.4 have much more detail about edge cases and nuances).

**Mitigation:** T4.1 should be decomposed into sub-tasks BEFORE starting. The spec needs the same level of nuance as T1.1. At minimum:
1. GraphEngine trait implementation + unit tests
2. Protocol handler switchover + adapted tests (batch of ~30 at a time)
3. New protocol commands (batch, diff, streaming)
4. Ephemeral database support
5. Test adaptation for removed commands

**Status:** Must address before reaching M4. Not a blocker for starting M1.

### RISK 3: Performance Regression Between M4 and M6

The plan explicitly accepts that v2 pre-compaction will be slower than v1 for point lookups (50us vs 1us -- 50x regression). The milestones doc says "within 2x for L0" but the task specs say "<50us" vs v1's "<1us" -- that's 50x, not 2x.

This means from M4 (Integration Gate, all tests pass) to M6 (Compaction delivers performance), Grafema users experience a 50x regression on point lookups. If M5 (Enrichment) takes time, this regression is live for weeks or months.

**Why it matters:** If someone tries Grafema during this window, their first impression is "it got way slower." First impressions matter. You don't get a second chance to make a first one.

**Mitigation:** Two options:
1. **Don't ship v2 as default until M6 is complete.** Keep v1 as default, v2 as opt-in flag. This is explicitly supported by the architecture (both engines in one binary, runtime switch).
2. **Accept 50x on point lookups** if Datalog profiling (I3) shows zone maps prevent the real-world regression. Most queries go through Datalog rules or attribute search, not raw point lookups.

**Status:** Needs explicit decision. I recommend option 1 (v2 opt-in until M6).

### RISK 4: Semantic ID v2 (T1.4) is a Breaking Change Coupled with a Storage Rewrite

T1.4 changes ALL node IDs. RFDB v2 changes the storage engine. Coupling both in one migration means: if anything goes wrong with ID stability, it's extremely hard to tell whether the problem is the ID format or the storage layer.

**Why it matters:** Debug surface area doubles. A query returning wrong results could be: wrong ID generation, wrong ID hashing, wrong segment storage, wrong bloom filter, wrong tombstone application, or wrong enrichment shard routing. With both changes landing simultaneously, bisection is painful.

**Mitigation:** The plan already partially handles this: T1.4 has comprehensive stability tests (#26-30). But consider:
- T1.4 can be validated independently on v1 storage (run analysis with v2 IDs, store in v1 engine, compare)
- The migration tool (T7.1) explicitly says "semantic ID update happens when user runs `grafema analyze` after migration" -- good, this separates the concerns
- Add a T4.4 validation step: "Run v2 engine with v1 semantic IDs first, then run with v2 semantic IDs, compare"

**Status:** Mitigated by test strategy. Not a blocker.

### RISK 5: findDependentFiles (C4 Blast Radius) Performance

T3.2 implements `findDependentFiles` as a client-side loop: for each node in each changed file, get incoming edges, resolve src node file. This is O(nodes_in_file x incoming_edges). For a file with 500 nodes, each with 5 incoming edges, that's 2,500 `getNode()` round trips.

The spec acknowledges this: "server-side command needed for production" and defers to T4.1. But T4.1's spec mentions `FindDependentFiles` as one line item among many.

**Why it matters:** Blast radius is the critical path in watch mode. If it takes 2 seconds on every file save, watch mode is unusable. The entire incremental enrichment story depends on this being fast.

**Mitigation:** T4.1 MUST implement `FindDependentFiles` as a server-side command using dst bloom filters. This is not optional. The client-side fallback in T3.2 is acceptable for integration testing only.

**Status:** Must be prioritized within T4.1. Not a blocker for starting.

---

## Concerns That Are NOT Problems (Dismissing False Alarms)

### "12,250 LOC is too much"

No. v1 engine.rs alone is 2,500 LOC of tangled HashMap state management. 12,250 LOC of well-factored modules with 537 tests is a dramatic improvement in maintainability. The LOC count is proportional to the scope.

### "9 phases is too many"

Each phase has clear deliverables, clear tests, and clear gates. The alternative -- fewer, larger phases -- would make each phase harder to validate. The granularity is correct.

### "Pre-compaction performance regression"

This is by design, not by accident. The plan is explicit: compaction is optimization, not correctness. L0-only mode works, it's just slower for point lookups. The architecture document explains why this tradeoff exists. I'd be more worried if the plan claimed zero regression.

### "Enrichment shard count (17 enrichers x 1000 files = 17,000 virtual shards)"

The plan addresses this: LSM compaction handles naturally. Each "shard" is just a file context string -- not 17,000 directories. Segment count grows, compaction merges. Standard LSM behavior.

---

## Mandatory Complexity Checklist

1. **Any O(n) over ALL nodes = RED FLAG?**
   - No. Queries use bloom filters for point lookup, zone maps for attribute search, dst bloom for reverse edges. Full scan only when explicitly requested (queryNodes without filter).
   - Compaction iterates all records in affected segments -- but only affected segments, not the entire graph. And it's a background operation.
   - **PASS.**

2. **Any backward pattern scanning = RED FLAG?**
   - No. The enrichment model uses forward registration (enricher produces edges, orchestrator commits to shard). No enricher searches for patterns. Blast radius uses pre-commit query (forward: "who points to changed files?").
   - **PASS.**

3. **Any brute-force where targeted queries are possible = RED FLAG?**
   - The findDependentFiles client fallback (T3.2) IS brute-force. But it's explicitly marked as fallback, with server-side command in T4.1.
   - Multi-shard point lookup fans out to all shards -- but bloom filters make this O(shards) with tiny constant, not O(nodes). Global index (T6.1) makes it O(1).
   - **PASS with caveat on T3.2 fallback.**

---

## The Demo Test

**M4 demo (Integration Gate):** "We replaced our entire storage engine. Every single one of our 120 tests passes. Same protocol, same API, same results. But now we have atomic commits, snapshot diff, and streaming."

Would I show this on stage? **Yes.** Clean engine swap with behavioral proof is impressive. It's infrastructure, but it's the kind of infrastructure that enables everything else.

**M5 demo (Enrichment Pipeline):** "Edit a file. The system knows exactly what changed, queries who depends on it, re-runs only the affected analysis, and tells you what broke -- in under a second."

Would I show this on stage? **Absolutely.** This is the moment Grafema goes from "batch analysis tool" to "live code understanding engine." This is the demo that sells the product.

**M7 demo (Real Codebase):** "2,500 files, 50 million nodes. 500MB of RAM. Edit any file, get impact analysis in real-time."

Would I show this on stage? **This is the keynote moment.** This is where "AI should query the graph, not read code" becomes real for massive codebases.

---

## What Could Make This FAIL

The #1 risk is not technical. It's **motivation decay over a long sequential build.**

M2 is a sequential Rust chain. M3 adds batch commit. M4 is the integration gate. Until M4, nothing externally visible changes. That's potentially 6-8 weeks of pure infrastructure work before any user-facing improvement.

The mitigation is already in the plan: the critical gate pattern at M4 forces a concrete "all tests pass" milestone. And M5's demo (live incremental enrichment) is a compelling reward. But the team needs to understand: M1-M4 is a march through the desert. The oasis is M5.

---

## Final Assessment

This plan is:
- **Architecturally sound** -- proven patterns, correct abstractions, no over-engineering
- **Honest about tradeoffs** -- explicit performance regression, explicit idle tracks, explicit limitations
- **Vision-aligned** -- directly enables "AI should query the graph, not read code" for massive codebases
- **Expert-reviewed** -- genuine contradictions found and resolved, not rubber-stamped

**Conditions for approval:**
1. Explicit decision on v2-as-default timing (recommend: opt-in until M6)
2. T4.1 must be decomposed into sub-tasks before execution
3. `FindDependentFiles` server-side command must be prioritized in T4.1 (not deferred)
4. Acknowledge M2 "dead zone" in sprint planning -- Track 2/3 work on backlog items, not make-work

With these conditions addressed: **APPROVE.**

This is the right plan. Now execute it.

---

*"Real artists ship." -- But they ship when it's ready, not before.*
