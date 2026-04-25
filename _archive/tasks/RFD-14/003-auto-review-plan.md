# Auto-Review: RFD-14 Integration Gate Validation Plan

**Verdict:** REJECT

## Vision & Architecture

**CRITICAL ISSUE: Batching architecture misunderstood**

The plan proposes crash recovery tests that kill the server "mid-batch" and verify uncommitted state doesn't survive. However, after reviewing the codebase:

**Current batch implementation (`src/session.rs`, `src/bin/rfdb_server.rs`):**
- `BeginBatch` / `AbortBatch` only set session-level flags (`pending_batch_id`)
- No durable state is written during batch operation
- Batch state lives entirely in memory (in-process session state)
- Killing server mid-batch = killing entire process = losing all session state

**What this means:**
- There's NOTHING to test for "uncommitted batch doesn't survive"
- Batches are purely in-memory coordination primitives
- The real persistence happens via `CommitBatch` which calls `handle_commit_batch` → atomically deletes old nodes/edges for changed files and adds new ones
- After `CommitBatch`, data may still be in delta log (memory) until explicit `flush()`

**Real crash recovery scenarios should test:**
1. Crash AFTER `CommitBatch` but BEFORE `flush()` — verify delta log recovery on restart
2. Crash DURING `flush()` — verify partial writes don't corrupt segments
3. Multiple clients with independent transactions — verify isolation

The current plan's crash recovery test (Phase 5) is testing a non-existent mechanism.

---

## Practical Quality

### 1. v1 Engine Availability: OK

✅ `GraphEngine` (v1) exists at `src/graph/engine.rs`
- Implements `GraphStore` trait (line 736)
- Has `create()` and `open()` constructors (lines 144, 222)
- Used in existing benchmarks (`benches/graph_operations.rs` line 21)

### 2. v1 vs v2 Benchmarks: CONCERN

**Issue:** v2 engine requires `semantic_id` field on all nodes.

From `src/graph/engine_v2.rs` lines 96-98:
```rust
let semantic_id = v1.semantic_id.clone()
    .unwrap_or_else(|| format!("{}:{}@{}", node_type, name, file));
```

**What this means:**
- When v1-style nodes (no `semantic_id`) are sent to v2 engine, it synthesizes IDs
- This is ALREADY happening in production via the `GraphStore` trait adapter
- v1 vs v2 benchmarks will work, BUT they won't measure pure v1 behavior — they'll measure v1 nodes going through v2's adapter layer

**Recommendation:** Benchmarks should:
1. v1 engine with v1-style records (no `semantic_id`)
2. v2 engine with v2-style records (explicit `semantic_id`)
3. Clearly document that v2's GraphStore adapter adds overhead (not a pure apples-to-apples comparison)

### 3. Test Harness: MISSING

**Issue:** The plan assumes TS server spawning helper exists (`test/helpers/spawnRFDBServer.ts`)

**Current state:**
- `test/helpers/` directory DOES NOT EXIST
- `test/integration/` directory EXISTS but only has TS tests that don't spawn servers
- Existing TS tests (`packages/rfdb/ts/client.test.ts`) use MOCKS, not real servers

**This means:**
- Phase 1 is underestimated — need to build server spawning infrastructure from scratch
- Should look at how other projects spawn Rust binaries from Node.js tests
- Need: port allocation, socket path handling, cleanup on test failure, timeout handling

### 4. Semantic ID Isolation Test (Phase 7): UNCLEAR VALUE

**Concern:** What is this test actually validating?

The plan says "same workload with v1-style IDs vs v2-style IDs on v2 engine, compare topology."

But v2 engine ALWAYS synthesizes semantic IDs if not provided (see above). So:
- v1-style input (no `semantic_id`) → v2 synthesizes them
- v2-style input (explicit `semantic_id`) → v2 uses them directly

The topology should be IDENTICAL because v2 synthesizes the same IDs using the same formula.

**If the goal is to test semantic ID handling:**
- Test collision detection (two different nodes with same semantic_id)
- Test ID stability across restarts
- Test that lookups work with both numeric IDs and semantic IDs

But "topology comparison" seems like it would always pass and doesn't test anything meaningful.

### 5. File Structure: MINOR ISSUE

**Concern:** Mixing Rust integration tests with benchmarks

- `benches/stress.rs` — this is a STRESS TEST, not a benchmark for performance regression tracking
- Criterion benchmarks run on CI and track regressions
- Stress tests verify correctness under load, not performance

**Better location:** `packages/rfdb-server/tests/stress.rs` (integration test, not benchmark)

Criterion should only contain tests where we TRACK performance over time. Stress tests that just verify "doesn't crash with 100K nodes" belong in `tests/`.

---

## Code Quality

### Structure Issues

1. **Phase ordering:** Infrastructure (Phase 1) should include ALL helper code, not just TS spawning. Need Rust server control utilities too.

2. **Missing scope:** No mention of:
   - How long do these tests take to run?
   - Do they run on every CI run or only nightly?
   - What's the max acceptable duration per test?

3. **CI integration underspecified:** Phase 8 just says "add to benchmark.yml" but doesn't address:
   - Stress tests should NOT be in benchmark workflow (they don't produce comparison data)
   - Integration tests with server spawning need special CI setup (permissions, cleanup)

### Estimates

File size estimates look reasonable (~150-400 LOC per file) but timeline missing:
- How long for each phase?
- Dependencies between phases?
- Can any phases run in parallel?

---

## Specific Fixes Required

### 1. CRITICAL: Redesign Crash Recovery (Phase 5)

Current proposal tests non-existent batching persistence. Should test:

**Scenario A: Delta log recovery**
- Start server, load 10K nodes (don't flush)
- Send SIGTERM (graceful shutdown)
- Restart, verify delta log is lost (ephemeral by design) OR persisted (if delta log has disk backing — CHECK THIS)

**Scenario B: Segment corruption resistance**
- Start server, load 10K nodes, flush
- Kill during flush (harder to test, may require instrumentation)
- Restart, verify data is intact or gracefully degraded

**Scenario C: Multiple clients (real isolation test)**
- Client A: begin batch, add nodes, DON'T commit
- Client B: query nodes, should NOT see Client A's uncommitted nodes
- Client A: commit batch
- Client B: query nodes, should NOW see them

### 2. REQUIRED: Clarify v1 vs v2 benchmark methodology

Document in plan:
- v1 = GraphEngine with v1-style NodeRecords (no semantic_id)
- v2 = GraphEngineV2 with v2-style NodeRecordV2 (semantic_id required)
- Acknowledge that both go through GraphStore trait, so there's adapter overhead
- Primary goal: verify v2 is NOT SLOWER than v1 for common operations

### 3. REQUIRED: Add test infrastructure phase details

Phase 1 should include:
- TS server spawning helper (`test/helpers/spawnRFDBServer.ts`)
- Rust test utilities for server control (if needed)
- Port allocation strategy (random ports? fixed range?)
- Cleanup utilities (kill orphaned processes, remove temp DBs)
- Estimated LOC: ~200-300 for robust spawning infrastructure

### 4. REQUIRED: Move stress test out of benchmarks

`benches/stress.rs` → `tests/stress.rs`

Criterion benchmarks are for REGRESSION TRACKING. Stress tests are for CORRECTNESS. Don't mix them.

### 5. RECOMMENDED: Reconsider semantic ID isolation test

Either:
- Drop it (low value, will always pass)
- OR replace with meaningful semantic ID tests:
  - Collision detection
  - Lookup by semantic_id vs numeric ID
  - ID stability across restarts

### 6. REQUIRED: Add timeline and CI strategy

For each phase:
- Estimated hours
- Can it run in parallel with other phases?
- CI: every PR, nightly, manual only?
- Max acceptable duration per test

---

## Summary

The plan shows good intent but has fundamental architecture misunderstandings:

1. **Batch crash recovery is testing phantom behavior** — batches are in-memory session state, not durable
2. **Stress test misplaced** — belongs in `tests/`, not `benches/`
3. **Test infrastructure underspecified** — spawning servers from TS is non-trivial, need detailed plan
4. **Semantic ID test unclear** — either drop or replace with meaningful test

**Required before proceeding:**
1. Verify delta log persistence model (is it disk-backed or fully ephemeral?)
2. Redesign crash recovery tests based on actual architecture
3. Expand Phase 1 to cover ALL test infrastructure (TS + Rust utilities)
4. Add timeline estimates per phase
5. Clarify CI strategy (which tests run when, duration limits)

**Recommendation:** Don should revise the plan addressing these architectural gaps before moving to Uncle Bob review.
