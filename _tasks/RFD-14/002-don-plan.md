# Integration Gate Validation — Implementation Plan (RFD-14)

## Context

**Goal**: Create a comprehensive integration test suite that validates RFDB v2 before Early Access release.

**Why this matters**:
- RFDB v2 introduces columnar storage and native semantic IDs — fundamentally different from v1
- We need high confidence that v2 is correct, performant, and crash-resistant
- The integration gate prevents shipping broken code to Early Access users

**Current state**:
- Rust benchmarks exist for v2 only (`benches/graph_operations.rs` — 16 benchmark groups)
- TS unit tests exist for client (`packages/rfdb/ts/client.test.ts` — mock-based)
- TS integration tests exist for Grafema pipeline (`test/unit/*.test.js` — ~20 files)
- CI benchmark infrastructure exists (PR comments, regression detection)
- **No v1 vs v2 comparison benchmarks**
- **No integration tests directory** in Rust (`packages/rfdb-server/tests/` doesn't exist)
- **No stress tests, crash recovery tests, or concurrent client tests**

**Config**: Mini-MLA (Don → Uncle Bob → Kent || Rob → Auto-Review → Vadim)

## Architectural Decisions

### 1. Test Organization

| Test Type | Location | Language | Runs Against |
|-----------|----------|----------|--------------|
| Unit tests (v2) | `src/**/*.rs` (`#[cfg(test)]` blocks) | Rust | Direct API |
| Benchmarks (v2 only) | `benches/graph_operations.rs` | Rust | Direct API |
| v1 vs v2 benchmarks | `benches/v1_vs_v2.rs` (NEW) | Rust | GraphStore trait |
| Stress tests | `benches/stress.rs` (NEW) | Rust | Direct API |
| Crash recovery | `packages/rfdb-server/tests/crash_recovery.rs` (NEW) | Rust | Server binary |
| Concurrent clients | `test/integration/rfdb/concurrent_clients.test.ts` (NEW) | TypeScript | Server binary |
| Semantic ID isolation | `test/integration/rfdb/semantic_id_isolation.test.ts` (NEW) | TypeScript | Server binary |

### 2. v1 vs v2 Benchmark Strategy

Create `benches/v1_vs_v2.rs` using `GraphStore` trait (both engines implement it). Same workload, Criterion groups, CI uses `critcmp` for comparison.

**Operations to compare**: add_nodes, find_by_type, find_by_attr, bfs, neighbors, get_node

### 3. Stress Test as Criterion Benchmark

100K nodes + 700K edges in `benches/stress.rs`. Criterion provides statistical rigor and CI tracking.

### 4. Crash Recovery — Rust Integration Test

Spawn server subprocess, send SIGKILL mid-batch, restart, verify state. Rust chosen for direct signal handling.

### 5. Concurrent Clients — TS Integration Test

Two `RFDBClient` instances, independent batches. TS chosen for real client protocol validation.

### 6. Semantic ID Isolation — TS Integration Test

Same workload with v1-style IDs vs v2-style IDs on v2 engine. Compare topology.

## Implementation Order

### Phase 1: Infrastructure
- Create TS server spawning helper (`test/helpers/spawnRFDBServer.ts`)
- Create test directory (`test/integration/rfdb/`)

### Phase 2: Subtask 1 — Full Test Suite
- Run all existing Rust + TS tests
- Document results in report

### Phase 3: Subtask 2 — v1 vs v2 Benchmarks
- `packages/rfdb-server/benches/v1_vs_v2.rs` (NEW, ~300-400 LOC)
- Register in `Cargo.toml`
- Run and generate comparison report

### Phase 4: Subtask 3 — Stress Test
- `packages/rfdb-server/benches/stress.rs` (NEW, ~150-200 LOC)
- Register in `Cargo.toml`

### Phase 5: Subtask 4 — Crash Recovery
- `packages/rfdb-server/tests/crash_recovery.rs` (NEW, ~200-250 LOC)
- Server spawning + SIGKILL + restart + verify

### Phase 6: Subtask 5 — Concurrent Clients
- `test/integration/rfdb/concurrent_clients.test.ts` (NEW, ~150-200 LOC)

### Phase 7: Subtask 6 — Semantic ID Isolation
- `test/integration/rfdb/semantic_id_isolation.test.ts` (NEW, ~200-250 LOC)

### Phase 8: CI Integration
- Add new benchmarks to `.github/workflows/benchmark.yml`

## File Summary

### New Files
- `packages/rfdb-server/benches/v1_vs_v2.rs` — v1 vs v2 comparison benchmarks
- `packages/rfdb-server/benches/stress.rs` — stress test (100K nodes / 700K edges)
- `packages/rfdb-server/tests/crash_recovery.rs` — crash recovery integration test
- `test/helpers/spawnRFDBServer.ts` — TS server spawning helper
- `test/integration/rfdb/concurrent_clients.test.ts` — concurrent clients test
- `test/integration/rfdb/semantic_id_isolation.test.ts` — semantic ID isolation test

### Modified Files
- `packages/rfdb-server/Cargo.toml` — register new benchmarks
- `.github/workflows/benchmark.yml` — add stress + v1 vs v2

## Success Criteria

1. All existing tests pass (documented in report)
2. v1 vs v2 benchmark shows v2 is faster or comparable
3. Stress test: 100K nodes + 700K edges load and query correctly
4. Crash recovery: uncommitted batch doesn't survive, committed does
5. Concurrent clients: independent batches, no corruption
6. Semantic ID isolation: both ID styles produce identical topology
