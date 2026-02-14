# RFD-11: Wire Protocol v3 Integration -- Don Melton's High-Level Plan

## 1. Codebase Inventory

### Current Architecture

The rfdb-server consists of these layers:

1. **Wire Protocol** (`src/bin/rfdb_server.rs`, ~1580 LOC)
   - MessagePack over Unix socket, 4-byte length-prefixed frames
   - `Request` enum (serde-tagged by `cmd`) with ~35 command variants
   - `Response` enum (serde-untagged) with ~18 response variants
   - `RequestEnvelope`/`ResponseEnvelope` for requestId echo
   - `handle_request()` dispatches all commands, calls `with_engine_read`/`with_engine_write` helpers
   - Protocol v1 (legacy) auto-opens "default" database; Protocol v2 uses Hello + OpenDatabase

2. **Session Management** (`src/session.rs`, ~68 LOC)
   - `ClientSession` tracks: client ID, current database (Arc<Database>), access mode, protocol version
   - protocol_version field exists (1 or 2) but v2 negotiation is minimal

3. **Database Manager** (`src/database_manager.rs`, ~318 LOC)
   - Thread-safe registry of `Database` instances (name -> Arc<Database>)
   - Each `Database` wraps `RwLock<GraphEngine>` + ephemeral flag + atomic connection counter
   - Supports: create, open, drop, list, ephemeral cleanup

4. **GraphEngine (v1)** (`src/graph/engine.rs`, ~1000+ LOC)
   - Implements `GraphStore` trait (defined in `src/graph/mod.rs`)
   - v1 storage: mmap segments (nodes.bin, edges.bin) + DeltaLog + in-memory adjacency
   - IndexSet for secondary indexes over segment data
   - Has `create_ephemeral()` for in-memory databases
   - `CommitBatch` handler in server: delete-then-add pattern (not using v2's tombstone-based commit)

5. **GraphStore Trait** (`src/graph/mod.rs`, 89 LOC)
   - 17 methods: add_nodes, delete_node, get_node, node_exists, get_node_identifier, find_by_attr, find_by_type, add_edges, delete_edge, neighbors, get_outgoing_edges, get_incoming_edges, get_all_edges, count_nodes_by_type, count_edges_by_type, bfs, flush, compact, node_count, edge_count

6. **storage_v2** (MultiShardStore + Shard + Manifest + WriteBuffer + Segment, ~2500 LOC)
   - `MultiShardStore`: N shards with file-directory routing, fan-out queries
   - `Shard`: write buffer + immutable segments + tombstone set
   - `ManifestStore`: Delta-Lake-style manifest chain with snapshot management
   - `commit_batch()`: 9-phase atomic commit with tombstones + delta computation
   - Already has: `tag_snapshot`, `find_snapshot`, `list_snapshots`, `diff_snapshots`
   - Already has: `TombstoneSet`, `CommitDelta`, `SnapshotDiff`, `SnapshotInfo`

7. **Datalog** (`src/datalog/`, ~5 files)
   - Full Datalog evaluator operating against `GraphEngine` via `GraphStore` trait

### Test Count

**~495 `#[test]` functions in Rust code** (not the ~120 mentioned in the task description).
The ~120 refers to the **JS/TS integration tests** in `test/unit/` that exercise the wire protocol from the TypeScript client.

Key test distributions:
- `datalog/tests.rs`: 79 tests
- `graph/engine.rs`: 49 tests
- `storage_v2/manifest.rs`: 60 tests
- `storage_v2/shard.rs`: 41 tests
- `storage_v2/multi_shard.rs`: 38 tests
- `bin/rfdb_server.rs`: 27 tests (protocol-level)
- `database_manager.rs`: 27 tests
- `metrics.rs`: 21 tests
- Other storage_v2 modules: ~100 tests
- `session.rs`: 5 tests, `graph/`: ~15 tests

### What RFD-7 (T2.3 Multi-Shard) Delivered

- `MultiShardStore` with N independent shards
- `ShardPlanner` for file-directory-hash routing
- Node routing by file path, edge routing by source node's shard
- Fan-out queries for cross-shard searches
- Per-shard statistics
- Full test coverage (38 tests in multi_shard.rs)

### What RFD-8 (T3.1 Tombstones + Batch Commit) Delivered

- `TombstoneSet` (node IDs + edge keys) in Shard
- `commit_batch()` on MultiShardStore: 9-phase atomic commit
- `CommitDelta` struct (changed_files, nodes added/removed/modified, changed types, manifest version)
- Tombstone persistence in manifest (`tombstoned_node_ids`, `tombstoned_edge_keys`)
- Edge key discovery via `find_edge_keys_by_src_ids()`
- Idempotent re-commit, cross-file batch commit, enrichment file convention

### What ManifestStore Already Provides (Snapshot Infrastructure)

- `tag_snapshot(version, key, value)` -- tag existing manifest
- `find_snapshot(tag_key, tag_value)` -- find by tag
- `list_snapshots(filter_tag)` -- list with optional tag filter
- `diff_snapshots(from_version, to_version)` -- compute SnapshotDiff
- `SnapshotInfo { version, created_at, tags, stats }`
- `SnapshotDiff { added_node_types, removed_node_types, added_edge_types, removed_edge_types, added_files, removed_files, from_stats, to_stats }`

## 2. Gap Analysis: What's Needed for RFD-11

### T4.1a -- GraphEngine Trait Implementation

**Problem:** The protocol handler (`handle_request`) calls `GraphEngine` directly via `GraphStore` trait. But `MultiShardStore` does NOT implement `GraphStore`. It has its own API surface with different types (`NodeRecordV2` vs `NodeRecord`, `EdgeRecordV2` vs `EdgeRecord`).

**Gap:** There is NO common trait that both v1 `GraphEngine` and v2 `MultiShardStore` implement. The switchover requires either:
1. Make `MultiShardStore` implement `GraphStore` (requires v1<->v2 record conversion), OR
2. Create a NEW `GraphEngineV2` wrapper around `MultiShardStore` that implements `GraphStore`, OR
3. Create a NEW broader trait that the protocol handler uses, implemented by both engines

**Assessment:** Option 2 is the cleanest. Create `GraphEngineV2` that:
- Wraps `MultiShardStore` + `ManifestStore`
- Implements `GraphStore` trait (with v1<->v2 type conversion)
- Adds v2-specific methods: `commit_batch()`, snapshot operations
- The v1->v2 type conversion is mechanical: `NodeRecord` <-> `NodeRecordV2`, `EdgeRecord` <-> `EdgeRecordV2`

**Already partially exists:** The server's `handle_commit_batch()` already does a manual delete-then-add on v1 engine. v2's `commit_batch()` does this atomically with tombstones. Both produce similar wire `BatchCommitted` responses.

### T4.1b -- Protocol Handler Switchover

**Problem:** `handle_request()` calls `with_engine_read`/`with_engine_write` which directly access `db.engine` (a `RwLock<GraphEngine>`). Switching to v2 requires changing what's behind that lock.

**Gap:** The `Database` struct holds `engine: RwLock<GraphEngine>`. Switching requires either:
1. Change `Database.engine` from `RwLock<GraphEngine>` to `RwLock<Box<dyn GraphStore>>` (trait object), OR
2. Add a `GraphEngineV2` that also implements `GraphStore` and change Database to be generic/enum, OR
3. Replace `GraphEngine` entirely in `Database` and update all handlers

**Assessment:** Make `Database.engine` hold either v1 or v2 via an enum:
```rust
enum EngineImpl {
    V1(GraphEngine),
    V2 { store: MultiShardStore, manifest: ManifestStore },
}
```
OR use trait object: `Box<dyn GraphStore + Send + Sync>`. Trait object is simpler but requires GraphStore to be object-safe (it already is -- all methods use `&self`/`&mut self`, no generics, no `Self` in return position).

**Recommended:** Trait object approach. Change `Database.engine` to `RwLock<Box<dyn GraphStore + Send + Sync>>`. This way:
- `with_engine_read`/`with_engine_write` continue to work via `&dyn GraphStore`
- Zero changes needed in 90% of command handlers
- v2-specific commands (commit_batch, snapshots) use downcast or separate path

**The ~120 JS integration tests** exercise the wire protocol. If `GraphStore` is implemented correctly for v2, they pass automatically because the wire protocol doesn't change.

### T4.1c -- New Protocol Commands

New commands needed (from task description):
- `BeginBatch` / `CommitBatch` / `AbortBatch` -- CommitBatch already exists! Just needs to route to v2's `commit_batch()` instead of v1's delete-then-add
- `DiffSnapshots` -- ManifestStore.diff_snapshots() already exists
- `TagSnapshot` -- ManifestStore.tag_snapshot() already exists
- `FindSnapshot` -- ManifestStore.find_snapshot() already exists
- `ListSnapshots` -- ManifestStore.list_snapshots() already exists
- `QueryEdges` -- multi-shard get_outgoing_edges with filter (partially exists)
- `FindDependentFiles` -- reverse edge traversal to find files affected by a node change

**Assessment:** The v2 storage layer already implements ALL the snapshot operations. The gap is only in the wire protocol layer -- adding Request/Response variants and handlers that delegate to v2.

### T4.1d -- Ephemeral Database Support

**Already exists in v1:** `GraphEngine::create_ephemeral()` + `DatabaseManager.create_database(name, true)`.

**v2 equivalent:** `MultiShardStore::ephemeral(shard_count)` already exists.

**Gap:** When creating a `Database` with v2 engine + ephemeral flag, need to wire `MultiShardStore::ephemeral()` through `DatabaseManager`.

### T4.1e -- Test Adaptation for Removed Commands

Some v1-specific commands may be removed or changed:
- `UpdateNodeVersion` -- v2 has no version field (moved to manifest tags)
- `Compact` -- v2 doesn't have v1's compact semantics (future compaction is T4.x)
- `GetAllEdges` -- expensive, may need pagination in v2

These need backward-compatible stubs or deprecation responses.

## 3. Risk Assessment

### HIGH RISK

1. **GraphStore trait completeness for v2** -- MultiShardStore lacks several methods that GraphStore requires:
   - `find_by_attr()` (v2 has `find_nodes()` but with different filter API)
   - `find_by_type()` (v2 has `find_nodes(Some(type), None)` but needs wildcard support)
   - `get_all_edges()` (v2 doesn't have this -- fan-out across all shards expensive)
   - `count_nodes_by_type()` / `count_edges_by_type()` (not implemented in v2)
   - `bfs()` traversal (v2 has no traversal -- needs to be built from edge queries)
   - `delete_node()` / `delete_edge()` (v2 uses tombstones, not individual deletes)
   - `flush()` / `compact()` (v2 has `flush_all()` but semantics differ)
   - `declare_fields()` (metadata indexing -- v2 doesn't have this yet)

   This is the **largest implementation gap**. Each missing method needs a correct v2 implementation.

2. **Datalog evaluator coupling** -- `Evaluator::new(engine: &GraphEngine)` takes a concrete `&GraphEngine`, not `&dyn GraphStore`. The datalog evaluator may use GraphEngine-specific methods. Needs audit and possible refactoring.

### MEDIUM RISK

3. **CommitBatch semantic difference** -- v1's `handle_commit_batch` does delete-then-add (immediate mutations). v2's `commit_batch()` does tombstone-then-add (manifest-based). Wire response format (`WireCommitDelta`) differs from v2's `CommitDelta`. Need careful mapping.

4. **Thread safety** -- v1 uses `RwLock<GraphEngine>`. v2's `MultiShardStore` is `!Send + !Sync` by default. The `Database` struct wrapping it with `RwLock` needs careful handling.

5. **EdgeRecord type mismatch** -- v1 `EdgeRecord` has `version`, `deleted` fields. v2 `EdgeRecordV2` doesn't. Conversion must handle this correctly in both directions.

### LOW RISK

6. **Wire protocol format** -- MessagePack framing and serde tagging don't change. New commands are additive.

7. **Ephemeral databases** -- Already supported in both engines. Just wiring.

8. **Snapshot commands** -- Already implemented in ManifestStore. Just need wire protocol wrappers.

## 4. Plan (Phases)

### Phase 1: GraphStore Implementation for v2 (T4.1a)

**Goal:** Create `GraphEngineV2` that wraps `MultiShardStore` + `ManifestStore` and implements `GraphStore`.

**Steps:**

1.1. **Type conversion layer** (~50 LOC)
   - `NodeRecord <-> NodeRecordV2` bidirectional conversion
   - `EdgeRecord <-> EdgeRecordV2` bidirectional conversion
   - Handle version/deleted/exported fields that v2 lacks

1.2. **Create `GraphEngineV2` struct** (~300 LOC)
   - Fields: `MultiShardStore`, `ManifestStore`, path info
   - `create(path)` / `create_ephemeral()` / `open(path)` constructors

1.3. **Implement `GraphStore` for `GraphEngineV2`** (~400 LOC)
   - `add_nodes()`: convert v1 records to v2, call `store.add_nodes()`
   - `delete_node()`: add to tombstone set (or defer to next commit_batch)
   - `get_node()`: call `store.get_node()`, convert back to v1 format
   - `node_exists()`: delegate to `store.node_exists()`
   - `find_by_type()`: delegate to `store.find_nodes(Some(type), None)`, add wildcard
   - `find_by_attr()`: implement using `store.find_nodes()` + metadata filtering
   - `neighbors()`: build from `store.get_outgoing_edges()`
   - `get_outgoing_edges()` / `get_incoming_edges()`: delegate and convert
   - `get_all_edges()`: fan-out across all shards (or return error/empty for now)
   - `bfs()`: implement using `neighbors()` (reuse existing traversal module)
   - `count_nodes_by_type()` / `count_edges_by_type()`: implement from find_nodes/edges
   - `flush()`: delegate to `store.flush_all(&mut manifest)`
   - `compact()`: no-op for now (compaction is T4.x)
   - `node_count()` / `edge_count()`: delegate

1.4. **Add v2-specific methods** (~100 LOC)
   - `commit_batch()`: delegate to `store.commit_batch()`
   - `tag_snapshot()`, `find_snapshot()`, `list_snapshots()`, `diff_snapshots()`
   - `is_ephemeral()` / `clear()` / `declare_fields()`

1.5. **Unit tests** (~15 tests)
   - Type conversion roundtrips
   - Each GraphStore method through v2 engine
   - Equivalence: same operations on v1 and v2 produce same results

**Critical design decision:** Individual `delete_node()`/`delete_edge()` in v2.
v2 doesn't support individual deletes -- only batch commit with file-level tombstones. Options:
- A) Buffer deletes in a pending tombstone set, apply on next flush/commit
- B) Implement immediate delete by modifying tombstone set and re-committing manifest
- C) Return error for individual deletes (break backward compat)

**Recommendation:** Option A -- buffer deletes in a `pending_tombstones: TombstoneSet` field on `GraphEngineV2`. Apply during `flush()`. This preserves backward compatibility.

### Phase 2: Protocol Handler Switchover (T4.1b)

**Goal:** Change `Database` to hold either v1 or v2 engine transparently.

**Steps:**

2.1. **Make GraphStore object-safe** (~20 LOC)
   - Audit trait for object safety (it already looks safe)
   - Add `Send + Sync` bounds
   - Add `as_any()` method for downcasting to v2-specific operations

2.2. **Modify `Database` struct** (~30 LOC)
   - Change `engine: RwLock<GraphEngine>` to `engine: RwLock<Box<dyn GraphStore + Send + Sync>>`
   - Or: use enum `EngineKind { V1(GraphEngine), V2(GraphEngineV2) }`
   - Update `node_count()` / `edge_count()` accessors

2.3. **Update `with_engine_read` / `with_engine_write`** (~20 LOC)
   - Change from `&GraphEngine` / `&mut GraphEngine` to `&dyn GraphStore` / `&mut dyn GraphStore`
   - All existing command handlers that only use `GraphStore` methods work unchanged

2.4. **Handle v2-specific commands** (~50 LOC)
   - `CommitBatch`: detect v2 engine, call `commit_batch()` directly
   - Snapshot commands: downcast to v2, call snapshot methods
   - Fall back to v1 behavior when v1 engine is active

2.5. **Update `DatabaseManager`** (~50 LOC)
   - `create_database()` creates v2 engine by default
   - `create_default_from_path()` keeps v1 for backward compat (or migrates)
   - Configuration flag for engine version selection

2.6. **Adapt Datalog evaluator** (~30 LOC)
   - Change `Evaluator::new()` to accept `&dyn GraphStore` instead of `&GraphEngine`
   - Audit all Datalog built-in predicates for GraphEngine-specific methods

2.7. **Adapt ~120 JS integration tests** (~minimal changes)
   - Most tests should pass unchanged (same wire protocol)
   - Tests using v1-specific behavior (UpdateNodeVersion, Compact) need adaptation
   - Add test helper to select v1 or v2 engine

### Phase 3: New Protocol Commands (T4.1c)

**Goal:** Expose v2 capabilities through wire protocol.

**Steps:**

3.1. **Snapshot commands** (~100 LOC, 6 new command handlers)
   - `TagSnapshot { version, key, value }` -> `Ok`
   - `FindSnapshot { tagKey, tagValue }` -> `{ version: u64 | null }`
   - `ListSnapshots { filterTag? }` -> `{ snapshots: [...] }`
   - `DiffSnapshots { fromVersion, toVersion }` -> `{ diff: SnapshotDiff }`

3.2. **Batch commands** (~50 LOC)
   - `BeginBatch` -> `{ batchId }` (session-level state)
   - `CommitBatch` already exists, route to v2 when v2 active
   - `AbortBatch` -> clear pending batch state

3.3. **Query commands** (~80 LOC)
   - `QueryEdges { nodeId, direction, edgeTypes?, limit? }` -> `{ edges }`
   - `FindDependentFiles { fileOrNodeId }` -> `{ files }` (reverse reachability)

3.4. **Wire types** (~60 LOC)
   - `WireSnapshotInfo`, `WireSnapshotDiff`
   - `WireBatchState`
   - Request/Response variants for each new command

3.5. **Unit tests** (~12 tests)
   - Each new command with happy path + error case

### Phase 4: Ephemeral Database Support for v2 (T4.1d)

**Steps:**

4.1. **Wire `MultiShardStore::ephemeral()` through DatabaseManager** (~20 LOC)
   - When `create_database(name, ephemeral=true)`, create v2 ephemeral engine
   - Cleanup on last disconnect (already exists)

4.2. **Tests** (~3 tests)
   - Create ephemeral v2 database via wire protocol
   - CRUD operations on ephemeral v2
   - Cleanup after disconnect

### Phase 5: Test Adaptation for Removed/Changed Commands (T4.1e)

**Steps:**

5.1. **Audit all existing tests for v1-specific behavior** (~2h)
   - List tests that use `UpdateNodeVersion`, `Compact`, or rely on delta_log internals

5.2. **Create backward-compat stubs** (~30 LOC)
   - `UpdateNodeVersion` -> no-op `Ok` (v2 doesn't have node versions)
   - `Compact` -> no-op `Ok` (v2 compaction is future work)
   - `GetAllEdges` -> implement via fan-out (expensive but correct)

5.3. **Adapt tests** (~5 tests modified)
   - Tests expecting v1 compact behavior -> skip or modify assertions
   - Tests using UpdateNodeVersion -> remove or convert to tag-based

## 5. Implementation Order and Dependencies

```
Phase 1 (T4.1a)  -----> Phase 2 (T4.1b) -----> Phase 3 (T4.1c)
                                  |
                                  +-----> Phase 4 (T4.1d)
                                  |
                                  +-----> Phase 5 (T4.1e)
```

- Phase 1 is the foundation -- everything depends on it
- Phases 3, 4, 5 are independent of each other and can be parallelized after Phase 2
- Phase 2 is the integration point where v1->v2 switch happens

## 6. Estimated Scope

| Phase | New LOC | Modified LOC | Tests | Time Estimate |
|-------|---------|-------------|-------|---------------|
| Phase 1 (T4.1a) | ~850 | ~50 | 15 | 2-3 days |
| Phase 2 (T4.1b) | ~100 | ~200 | 0 (adapted) | 2-3 days |
| Phase 3 (T4.1c) | ~290 | ~30 | 12 | 1-2 days |
| Phase 4 (T4.1d) | ~20 | ~20 | 3 | 0.5 day |
| Phase 5 (T4.1e) | ~30 | ~50 | 5 | 0.5 day |
| **Total** | **~1290** | **~350** | **35** | **6-9 days** |

This is larger than the original "~500 LOC" estimate because the gap analysis reveals more work needed in Phase 1 (GraphStore implementation for v2) than anticipated.

## 7. Open Questions for Discussion

1. **Individual delete semantics in v2:** Buffer deletes and apply on flush (recommended), or implement immediate manifest rewrite?

2. **Datalog evaluator coupling:** How deeply coupled is `Evaluator` to `GraphEngine`? Needs audit before Phase 2.

3. **Engine selection strategy:** Should new databases default to v2? Should there be a migration path for existing v1 databases? Or keep v1 as default until v2 is proven?

4. **GetAllEdges in v2:** Fan-out across all shards is O(total_edges). Keep for backward compat? Add pagination? Remove?

5. **Batch session state:** Does `BeginBatch` need server-side buffering (accumulate in memory until CommitBatch)? Or is CommitBatch sufficient as a single atomic call?

## 8. Research Notes

Brief web search for Rust protocol handler switchover patterns confirms the trait-object approach is well-established:
- [Rust trait-based abstractions](https://blog.rust-lang.org/2015/05/11/traits.html) enable zero-cost polymorphism
- [Model Context Protocol Rust SDK](https://deepwiki.com/modelcontextprotocol/rust-sdk) uses Handler trait abstraction for server/client protocol layers
- [Rust Design Patterns](https://rust-unofficial.github.io/patterns/) documents the Strategy pattern via traits

The `dyn GraphStore` approach follows Rust's standard Strategy pattern -- swap implementation behind a trait interface. This is the correct approach for our switchover.

---

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-14
**Status:** Ready for Joel's technical expansion
