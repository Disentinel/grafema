# Revised Plan: RFD-14 Integration Gate Validation

## Architecture Findings

### Batching (session.rs)
- `ClientSession.pending_batch_id` is purely in-memory session state
- `BeginBatch`/`AbortBatch` only set/clear a flag
- No durable mid-batch state exists

### v1 Engine (storage/delta.rs)
- `DeltaLog` is purely in-memory (`Vec<Delta>`)
- No disk-backed delta log
- Flush writes directly to segments

### v2 Engine (storage_v2/multi_shard.rs, manifest.rs)
- `commit_batch`: 9-phase atomic operation ending with manifest commit (atomic pointer swap via `current.json`)
- Crash safety: manifest commit is atomic (temp file + fsync + rename)
- Tombstones persist in manifest

### What survives restart
- Manifests (immutable, atomic commit)
- Segments (immutable after flush)
- Tombstone lists (in manifest)

### What doesn't survive restart
- Write buffers (in-memory only)
- Pending batches (session state)
- DeltaLog (v1 only, in-memory)

---

## Test Plan

### Phase 1: Test Infrastructure

**Location**: `packages/rfdb-server/tests/`

```
tests/
├── common/
│   └── mod.rs              # Shared helpers
└── integration/
    ├── basic_ops.rs        # v1/v2 equivalence
    ├── deletes.rs          # Tombstone behavior
    ├── semantic_ids.rs     # ID handling
    ├── crash_recovery.rs   # Persistence tests
    └── client_isolation.rs # Session isolation
stress.rs                   # Correctness under load
```

**Helpers** (`tests/common/mod.rs`):
- `create_test_engines()` — both v1 and v2 with temp directories
- `make_test_nodes(count)` / `make_test_edges(count)` — test data builders
- `assert_nodes_equivalent(v1, v2)` — cross-engine comparison
- `assert_topology_identical(v1, v2)` — full graph comparison

### Phase 2: Correctness Tests (~10 tests)

**2.1 Basic Operations Equivalence** (`basic_ops.rs`)
- `add_nodes` / `get_node` — same node retrievable from both engines
- `add_edges` / `get_outgoing_edges` / `get_incoming_edges`
- `find_by_type` (exact + wildcard)
- `find_by_attr`
- `bfs` / `neighbors`

**2.2 Delete Operations** (`deletes.rs`)
- `delete_node` → node not visible in queries (v1: HashMap removal, v2: tombstone)
- `delete_edge` → edge not in `get_outgoing_edges`

**2.3 Semantic ID Handling** (`semantic_ids.rs`)
- v1 input (no semantic_id) → v2 synthesizes correctly
- Lookup by numeric ID works after synthesis
- ID format: `"{type}:{name}@{file}"`

**2.4 Crash Recovery** (`crash_recovery.rs`)
- **Uncommitted buffer lost**: add nodes, DON'T flush, drop engine, reopen → 0 nodes
- **Committed data survives**: add nodes, flush, drop, reopen → all nodes present
- **Tombstones survive**: add, flush, delete, flush, drop, reopen → deleted nodes stay deleted
- **Manifest atomicity**: only committed manifest versions are loaded

**2.5 Client Isolation** (`client_isolation.rs`)
- Two sessions, uncommitted data not visible to other session
- NOTE: This tests server-level behavior — may require spawning actual server

### Phase 3: Stress Test (`tests/stress.rs`)

**Correctness under load, NOT benchmark**:
- 100K nodes + 700K edges load and query correctly
- Deep BFS (depth 100) on 10K node graph
- Large batch commit (50K nodes in one commit)

### Phase 4: v1 vs v2 Benchmarks (`benches/v1_v2_comparison.rs`)

Criterion benchmark comparing:
- `add_nodes` (100, 1K, 10K)
- `find_by_type` (exact, wildcard)
- `bfs` (100, 1K nodes)
- `flush` (1K, 10K records)

**Documented caveat**: Both engines accessed via GraphStore trait adapter. Not pure apples-to-apples.

### Phase 5: Concurrent Clients (TS Integration Test)

Original task requires: "two TS clients → same server → independent batches"

This requires:
- `test/helpers/spawnRFDBServer.ts` — spawn server binary, wait for socket
- `test/integration/rfdb/concurrent_clients.test.ts` — two RFDBClient instances

**Tests**:
- Two clients batch independently, both commit, verify merged state
- One client commits while another is mid-batch
- Interleaved operations maintain isolation

### Phase 6: CI Integration

- Integration tests: every PR (`cargo test --tests`)
- Stress tests: nightly only
- Benchmarks: manual / weekly / `benchmark` label

---

## File Summary

### New Files
- `packages/rfdb-server/tests/common/mod.rs` — test helpers
- `packages/rfdb-server/tests/integration/basic_ops.rs`
- `packages/rfdb-server/tests/integration/deletes.rs`
- `packages/rfdb-server/tests/integration/semantic_ids.rs`
- `packages/rfdb-server/tests/integration/crash_recovery.rs`
- `packages/rfdb-server/tests/integration/client_isolation.rs`
- `packages/rfdb-server/tests/stress.rs`
- `packages/rfdb-server/benches/v1_v2_comparison.rs`
- `test/helpers/spawnRFDBServer.ts` (for concurrent clients test)
- `test/integration/rfdb/concurrent_clients.test.ts`

### Modified Files
- `packages/rfdb-server/Cargo.toml` — register new benchmark

## Success Criteria

1. v1 and v2 produce identical results for same operations
2. v2 persistence: data survives flush + restart, uncommitted doesn't
3. Tombstones persist correctly across restarts
4. 100K nodes + 700K edges load + query without errors
5. Two TS clients can batch independently on same server
6. v2 performance within 2x of v1 for common operations
