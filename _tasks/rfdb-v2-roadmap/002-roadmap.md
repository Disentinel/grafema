# RFDB v2: Development Roadmap

> Date: 2026-02-11
> Input: rfdb-v2-architecture-final.md, rfdb-v2-architecture-research.md
> Philosophy: prove correctness at every layer before building the next
> Updated: 2026-02-11 — ID unification, batch commit API, snapshot isolation

---

## Architectural Decisions (from discussion)

### 1. Semantic ID — first-class citizen, not metadata hack

**Problem (v1):** 4 ID representations in the system:
- Semantic ID string (`src/app.js->global->FUNCTION->processData`)
- Legacy ID string (`src/app.js:FUNCTION:processData:42:5:0`)
- u128 BLAKE3 hash (Rust storage, one-way — can't recover string)
- `metadata.originalId` (duplicate of string ID, stuffed into JSON for round-tripping)

Plus `_origSrc`/`_origDst` on edges — another duplication.
~30-40% of metadata size is identity duplication.

**Decision (v2):** Semantic ID string is a first-class columnar field, NOT metadata.

```
Segment columns:
  semantic_id: String[]     ← THE identity, stored directly
  id:          u128[]       ← BLAKE3(semantic_id), derived index for fast lookup
  type:        u16[]
  name:        String[]
  file:        String[]
  metadata:    JSON[]       ← no more originalId/_origSrc/_origDst
```

- Round-trip via column, not via metadata
- u128 is a derived index, not the identity
- Legacy IDs: convert to semantic format at ingestion (one-time migration)
- Wire protocol sends semantic ID string; Rust computes u128 internally

### 2. Batch commit — atomic multi-file updates (black box)

**Problem:** Watch mode with AI agents modifying multiple files rapidly. Partial
updates (5 of 10 files written) would expose inconsistent graph state.

**Decision:** RFDB provides batch commit with snapshot isolation. Client sends
standard AddNodes/AddEdges within a transaction. RFDB infers file ownership internally.

```
Wire protocol:
  BeginBatch                          // start transaction
  AddNodes { nodes: [...] }           // same format as v1, nodes have `file` field
  AddEdges { edges: [...] }           // same format as v1
  CommitBatch                         // atomic: RFDB groups by file, tombstones, new segments, manifest swap
  AbortBatch                          // discard write buffer

RFDB server on CommitBatch (internal, invisible to client):
  1. Group nodes by `file` field → {"src/auth/login.ts": [...], "src/api/routes.ts": [...]}
  2. For each file in batch: tombstone ALL old nodes/edges for that file
  3. Edge ownership = file context of the CommitBatch (not src node lookup — no read-during-write)
  4. Enrichment edges: composite file context __enrichment__/{enricher}/{source_file} (I2)
  5. Write new segments per shard
  6. Atomic manifest swap

Guarantee:
  Before commit() → readers see previous consistent snapshot
  After commit()  → readers see new consistent snapshot
  Between         → impossible (atomic manifest swap)
```

**Black box principle:** client doesn't know about files, shards, segments, tombstones.
It sends AddNodes/AddEdges (which already have `file` field on nodes), RFDB handles everything.

**Backward compatibility:** AddNodes/AddEdges without BeginBatch = implicit single-operation
batch with auto-commit. Old code works unchanged.

**Responsibility split:**
- **Orchestrator** owns: debouncing (when to collect a batch), analysis (parse files → nodes/edges)
- **RFDB** owns: atomicity (batch either fully visible or not), file grouping, shard assignment, snapshot isolation

No leaking abstractions. Orchestrator doesn't know about shards, segments, or manifests.

### 3. Snapshot isolation — readers never blocked

Immutable segments + atomic manifest pointer = MVCC for free:
- Writers create new segments (invisible until manifest swap)
- Readers hold reference to current manifest (immutable snapshot)
- Manifest swap = atomic file rename
- Old segments stay on disk until no readers reference them → GC
- Zero locks, zero reader blocking

### 4. Edge ID resolution — u128 internal, strings at API boundary

**Problem:** Edges store src/dst as u128 (fast, fixed-size). Clients need semantic ID
strings. Storing string IDs in edges = +~1.1 GB on 9.3M edges (redundant, strings
already exist in node segments).

**Decision:** u128 everywhere internally, batch resolve at API boundary only.

```
Internal operations (BFS, enrichment, adjacency):
  All u128 — zero string lookups. Fixed-size, cache-friendly, one CPU instruction compare.

API boundary (wire protocol response):
  1. Operation returns u128[] (fast)
  2. Collect unique u128s from response
  3. Batch resolve: u128 → semantic_id (bloom filter / global index)
  4. Substitute strings in response
  5. Client sees only semantic ID strings
```

**Key optimization: resolve only what the client sees.**

| Operation | Internal traversal | IDs resolved | Overhead |
|-----------|-------------------|-------------|----------|
| getNode(id) | 1 lookup | 1 | ~microseconds |
| neighbors(id) → 50 edges | 1 + scan | ~50 | ~50 µs |
| BFS depth=3 → 200 results | ~2000 nodes | 200 | ~200 µs |
| queryNodes({type}) → 5000 | scan | 5000 | ~5 ms |

BFS traversing 10,000 intermediate nodes but returning 200 results →
resolves 200, not 10,000. Internal operations never pay for string resolution.

After compaction: resolve = O(1) via global index binary search.
Before compaction: resolve = O(shards) bloom checks, still microseconds.

### 5. Versioning via snapshot chain, not per-node mutation

**Problem (v1):** `UpdateNodeVersion` mutates a field on individual nodes. This is
incompatible with immutable segments. Also, change blast radius analysis needs
understanding of what changed between versions.

**Decision (v2):** Version = manifest snapshot number. Each CommitBatch creates a new
manifest. The manifest chain IS the version history. No per-node version field.

```
Manifest v42: {segments: [a, b, c, d]}     ← before commit
Manifest v43: {segments: [a, b, e, f]}     ← after commit (c,d tombstoned, e,f new)
```

**CommitBatch with tags — tie snapshots to external context:**
```
CommitBatch {
  tags: {
    "git_commit": "abc123def",
    "git_branch": "main",
    "analysis_type": "full"
  }
} → {
  ok: true,
  snapshot: 43,
  previousSnapshot: 42,
  delta: {
    changedFiles: ["src/auth/login.ts", "src/auth/session.ts"],
    nodesAdded: 15,
    nodesRemoved: 12,
    nodesModified: 3,       // same semantic_id, different content
    edgesAdded: 20,
    edgesRemoved: 18,
  }
}
```

Tags are optional key-value pairs stored in manifest. Enable:
- Associating graph snapshots with git commits
- Navigating graph history by commit, branch, or custom labels
- Retention policies based on meaning, not age

**Detailed diff on demand — by snapshot number or by tag:**
```
// By snapshot number:
DiffSnapshots { from: 42, to: 43 }

// By tag (resolves to snapshot numbers internally):
DiffSnapshots {
  from: { tag: "git_commit", value: "abc122" },
  to:   { tag: "git_commit", value: "abc123" }
}

→ {
  addedNodes: ["src/auth/login.ts->AuthService->METHOD->validate", ...],
  removedNodes: ["src/auth/login.ts->AuthService->METHOD->oldMethod", ...],
  modifiedNodes: ["src/auth/login.ts->AuthService->METHOD->login"],
  addedEdges: [{ src: "...", dst: "...", type: "CALLS" }, ...],
  removedEdges: [...],
}
```

Can diff ANY two snapshots, not just consecutive. "What changed between two git commits?"

**Snapshot navigation:**
```
FindSnapshot { tag: "git_commit", value: "abc123" } → { snapshot: 43, tags: {...} }
ListSnapshots { tag: "git_branch", value: "main" } → [43, 41, 38, ...]
```

**No extra storage:** diffs computed from manifests. Manifest v42 lists segments [a,b,c,d],
manifest v43 lists [a,b,e,f]. Diff = removed segments [c,d] + added segments [e,f].
Read those segments → concrete node/edge lists. Modified = intersection of removed IDs ∩ added IDs.

**Tag-based retention policy:**
- Tagged snapshots → keep (meaningful checkpoints tied to git commits)
- Untagged snapshots → GC after N days or disk space threshold
- Manual cleanup: `DeleteSnapshot { snapshot: 42 }` or
  `DeleteSnapshotsByTag { tag: "git_branch", value: "feature-x" }`
- GC only removes segments not referenced by ANY remaining snapshot

**Blast radius = composition of existing primitives:**
```
// Step 1: what changed between two commits?
delta = DiffSnapshots(
  from: { tag: "git_commit", value: "abc122" },
  to:   { tag: "git_commit", value: "abc123" }
)

// Step 2: who is affected? (reverse reachability from changed nodes)
affected = Reachability(
  startIds: delta.modifiedNodes + delta.addedNodes,
  maxDepth: 5,
  edgeTypes: ["CALLS", "IMPORTS", "DEPENDS_ON"],
  backward: true
)
```

No dedicated "blast radius" command needed. DiffSnapshots + Reachability = blast radius.

### 6. Wire Protocol v3 — complete API surface

**New commands:**
```
BeginBatch                              // start write transaction
CommitBatch { tags? }                   // atomic commit, optional tags (git_commit, etc.), returns delta summary
AbortBatch                              // discard buffered writes
DiffSnapshots { from, to }              // detailed diff; from/to = snapshot number or { tag, value }
FindSnapshot { tag, value }             // resolve tag to snapshot number
ListSnapshots { tag?, value? }          // list snapshots, optionally filtered by tag
DeleteSnapshot { snapshot }             // remove snapshot + GC unique segments
```

**Streaming support (via request IDs):**
```
Request:  { requestId: "r1", cmd: "queryNodes", query: {...} }

Non-streaming response:
          { requestId: "r1", nodes: [...] }

Streaming response:
          { requestId: "r1", chunk: [...100 nodes...], done: false }
          { requestId: "r1", chunk: [...100 nodes...], done: false }
          { requestId: "r1", chunk: [...50 nodes...], done: true }
```

Request IDs enable: streaming, multiplexing, error correlation.
Backward compat: no requestId → FIFO matching (v1/v2 behavior).

**Unchanged (28 commands):**
All read operations, database management, datalog, stats, DeclareFields,
IsEndpoint, GetNodeIdentifier, Ping, Shutdown.

**Evolved:**
- AddNodes/AddEdges → work inside BeginBatch/CommitBatch (or auto-commit without batch)
- Flush → no-op (backward compat; segment writes happen at commit)
- Compact → manual trigger for background compaction
- Clear → drop all segments + reset manifest

**Removed:**
- GetAllEdges → replace with streaming QueryEdges with filters
- UpdateNodeVersion → snapshot chain replaces per-node versioning
- DeleteNode/DeleteEdge → handled internally via tombstones on CommitBatch

---

## Development Strategy: Hybrid (new module in same package)

v2 engine lives as `storage_v2/` module + `engine_v2.rs` inside existing `rfdb-server` package. Shared code (protocol, datalog, metrics, session) not duplicated. Both engines behind `GraphEngine` trait — runtime switch in `database_manager.rs`.

**Key properties:**
- Both engines in one binary — side-by-side validation possible
- Phase 5 = switch handlers to v2 engine (one config change)
- v1 = fallback if v2 broken (no rebuild needed)
- After full M7 validation → delete v1 code in one commit

See `008-milestones-and-tasks.md` for full directory layout and trait definition.

---

## Scope Boundary

**What's new (v2 storage engine, alongside v1):**
- `storage_v2/*` — segments, shards, manifest, compaction, bloom, zone maps
- `graph/engine_v2.rs` — v2 engine implementing `GraphEngine` trait

**What evolves (backward compatible):**
- `graph/mod.rs` — `GraphEngine` trait abstraction over v1/v2
- Wire protocol → v3: request IDs, batch commit, streaming, DiffSnapshots (MessagePack over Unix socket stays)
- Database manager (`database_manager.rs`) — creates v1 or v2 engine
- `bin/rfdb_server.rs` — handlers work through `GraphEngine` trait
- TypeScript `RFDBClient` — batch commit, streaming, diff methods
- TypeScript `RFDBServerBackend` — remove ID metadata hacks

**What stays as-is:**
- Datalog engine (`datalog/*`)
- Metrics system (`metrics.rs`)
- Session management (`session.rs`)
- ID generation (`id_gen.rs` — BLAKE3)

**What gets deleted (after M7 validation):**
- `graph/engine.rs` — v1 HashMap engine
- `graph/index_set.rs` — v1 indexes
- Old `storage/` files replaced by `storage_v2/`

**The contract:** all ~120 existing protocol + Datalog tests must pass on v2 without modification. They ARE the correctness specification.

---

## Phase 0: Segment Format (foundation)

**Goal:** The immutable columnar segment — the atomic building block everything depends on.

**Scope:**
- `NodeSegment`: columnar layout with **semantic_id (string) as first-class column**
  - Columns: semantic_id, id (u128, derived via BLAKE3), type, name, file, **content_hash (u64)**, metadata
  - semantic_id is THE identity; u128 is a derived index for fast lookup
  - **content_hash**: computed by analyzer from source text span, sent as node field. Enables precision diff (I4): same semantic_id + same content_hash = unchanged. Also serves as analyzer coverage canary.
  - No `originalId` in metadata — identity lives in its own column
- `EdgeSegment`: columnar layout (src, dst, type, metadata)
  - No `_origSrc`/`_origDst` in metadata — src/dst reference node semantic_ids
- Per-segment string table (names, files, types, semantic_ids — embedded, not global)
- Bloom filter per segment (10 bits/key, 1% FPR, keyed on u128)
- **Dst bloom filter** per edge segment (keyed on dst u128). Enables reverse edge lookup without full scan — critical for C4 blast radius query on fresh L0 segments. (N8)
- **Zone maps** per segment: set of distinct values per key field (nodeType, type, file) stored in footer. Enables segment skipping for attribute queries — 90%+ segments eliminated before scan. (I3)
- Segment header: magic, version, record counts, offsets
- Segment footer: bloom filter, dst bloom filter, zone maps, string table offsets
- Read/write API: `SegmentWriter::write(records) -> segment file`, `SegmentReader::open(path)`

**Proof strategy:**
- Property-based tests (proptest): any valid Vec<NodeRecord> → write → read → identical records
- **Semantic ID roundtrip**: write with string ID → read back → exact same string (no metadata dependency)
- **u128 derivation**: BLAKE3(semantic_id) = stored u128 (always, no exceptions)
- **content_hash roundtrip**: write with content_hash → read back → exact same value
- Roundtrip tests for edge cases: empty segment, single record, max metadata size
- Bloom filter: zero false negatives (mathematical guarantee), measure FPR < 2%
- **Dst bloom filter**: zero false negatives on dst field, measure FPR < 2%
- **Zone maps correctness**: zone map for nodeType contains exactly the set of distinct nodeTypes in segment
- Binary stability: write segment, read back byte-exact comparison
- Corruption detection: truncated file, flipped bits → clean error, not panic
- Benchmark: write throughput (target: > 500K nodes/sec), read latency

**Dependencies:** none (pure data structure)

**Deliverables:**
- `storage/segment.rs` (new, replaces current — node + edge segments with footer)
- `storage/bloom.rs` (src bloom + dst bloom)
- `storage/zone_map.rs` (per-field distinct value sets)
- `storage/string_table.rs` (evolved from current)
- Test suite: ~35-45 tests

---

## Phase 1: Manifest, Snapshot Chain & Versioning

**Goal:** Track which segments exist, their stats, enable atomic view switches,
and maintain version history for diff queries. Snapshots taggable with external context.

**Scope:**
- Manifest JSON format: segment registry with stats (record count, node types, bloom offset)
- **Manifest chain**: sequential version numbers (v1, v2, v3...), each commit creates new manifest
- **Snapshot tags**: optional key-value pairs per manifest (e.g., `git_commit`, `git_branch`)
  - Stored in manifest JSON
  - Enable: navigation by git commit, retention by meaning, cross-commit diffs
- `current.json` atomic pointer to latest manifest
- Snapshot: immutable view of "which segments are active"
- **Diff computation from manifests**: compare two manifests → added/removed segments → node/edge delta
  - Addressable by snapshot number OR by tag (`{ tag: "git_commit", value: "abc123" }`)
- **Snapshot navigation**: FindSnapshot (tag → number), ListSnapshots (filter by tag)
- GC bookkeeping: old segments → gc/ directory, safe to delete after no readers
- **Tag-based retention**: tagged snapshots kept (meaningful checkpoints), untagged GC'd by age/space
- Manifest stats for query planning: node_types, edge_types per segment

**Proof strategy:**
- Atomic swap: simulate crash mid-write → `current.json` always points to valid manifest
- Concurrent reads: one thread reads snapshot while another swaps → no torn reads
- GC safety: segments in gc/ not referenced by any active snapshot
- Manifest consistency: segment files referenced in manifest actually exist on disk
- **Version monotonicity**: snapshot numbers always increase, never reused
- **Tag uniqueness**: same tag key+value → at most one snapshot (or error)
- **Tag resolution**: FindSnapshot returns correct snapshot for given tag
- **Diff correctness**: DiffSnapshots(v42, v43) returns exact added/removed/modified sets
- **Retention**: tagged snapshots survive GC, untagged cleaned up per policy

**Dependencies:** Phase 0 (segment format for stats)

**Deliverables:**
- `storage/manifest.rs` (with tags support)
- `storage/snapshot.rs` (with tag index)
- `storage/diff.rs` (snapshot diff computation)
- Test suite: ~22-28 tests

---

## Phase 2: Single-Shard Read/Write

**Goal:** Complete lifecycle for one shard — write nodes+edges, read them back, query.

**Scope:**
- Shard = directory containing segments
- Write path: Vec<NodeRecord> → segment file in shard dir + manifest update
- Point lookup: bloom filter check → segment scan → found/not found
- Attribute search: manifest stats pruning → columnar scan matching segments
- Neighbors query: edge segment scan (bloom on src/dst)
- Write buffer: in-memory accumulation before flush to segment

**Proof strategy:**
- Equivalence tests: same data in v1 HashMap vs v2 shard → identical query results
- Full CRUD cycle: add nodes → query → verify → add edges → query neighbors → verify
- Multiple segments within shard: flush twice → both segments queryable
- Write buffer + segment: unflushed data in buffer + flushed in segment → both visible
- Benchmark: query latency vs v1 (must be within 2x for Level 0)

**Dependencies:** Phase 0, Phase 1

**Deliverables:**
- `storage/shard.rs`
- `storage/write_buffer.rs`
- `graph/engine_v2.rs` (new engine, single-shard mode)
- Test suite: ~25-30 tests

---

## Phase 3: Multi-Shard & Shard Planning

**Goal:** Directory-based sharding with automatic shard plan from file system scan.

**Scope:**
- Shard planner: file list + LOC → shard assignments
  - Directory-based default (files in same dir → same shard)
  - Hash fallback for flat directories
  - Adaptive thresholds based on resource budget
- Multi-shard queries: fan-out across shards, merge results
- Parallel shard writes: one writer per shard, no shared state (rayon)
- Cross-shard point lookup: bloom filters across all shards

**Proof strategy:**
- Deterministic sharding: same file list → same shard plan (no randomness)
- Completeness: every file assigned to exactly one shard
- Parallel write correctness: N parallel workers → identical result to sequential
- Query completeness: node findable regardless of which shard it's in
- Shard plan stability: small file change → minimal shard reassignment

**Dependencies:** Phase 2

**Deliverables:**
- `storage/shard_planner.rs`
- Multi-shard support in engine_v2
- Test suite: ~20 tests

---

## Phase 4: Tombstones, Incremental Updates & Batch Commit

**Goal:** Re-analyze files without rewriting entire graph. Atomic multi-file updates.

**Scope:**
- Tombstone segments: mark deleted node/edge IDs
- Query path: skip tombstoned records during scan
- **Batch commit (black box API)**:
  - `BeginBatch` → `AddNodes/AddEdges` (same format as v1) → `CommitBatch`
  - RFDB internally: group nodes by `file` field, determine shard from file context
  - **Enrichment edges (I2):** composite file context `__enrichment__/{enricher}/{source_file}`. Ownership = shard = file context string. No `_owner` in metadata needed. Granular re-enrichment per enricher per file.
  - Single atomic manifest swap for entire batch
  - Without BeginBatch → auto-commit (backward compat)
- **CommitBatch returns rich delta summary**:
  - `changedFiles`: which files were affected
  - `nodesAdded/Removed/Modified`: counts + **removed node semantic IDs (N7)** (always full list — file-scoped batches naturally bound size)
  - `edgesAdded/Removed`: counts
  - **Modified detection (I4)**: same semantic_id + different content_hash = truly modified. Same content_hash = unchanged (skip from delta).
  - **`changedNodeTypes`**: set of node types in the delta (e.g., ["FUNCTION", "VARIABLE"])
  - **`changedEdgeTypes`**: set of edge types in the delta (e.g., ["CALLS", "CONTAINS"])
  - changedTypes are critical for: incremental enrichment (which enrichers to re-run)
    AND incremental guarantee checking (which rules to re-evaluate)
- **Snapshot isolation**: readers hold reference to current manifest, never blocked by writers
- Delta computation: diff(old segments, new segments) to detect actual changes
- Skip re-enrichment when delta is empty (file touched but unchanged)

**Interaction with guarantees and ISSUE nodes:**
- **ISSUE nodes**: automatic lifecycle from file ownership. File re-analyzed → old ISSUE nodes
  tombstoned with all other nodes of that file → new ISSUE nodes in new segment. Zero special code.
- **Cross-file ISSUE nodes** (from enrichment): live in enrichment shard `__enrichment__/{enricher}/{file}`.
  Re-enrichment of that enricher+file context tombstones + recreates them. Also automatic.
- **Guarantee checking**: orchestrator receives delta from CommitBatch, checks
  `changedNodeTypes ∩ rule_dependencies` to determine which rules need re-evaluation,
  calls CheckGuarantee only for affected rules. RFDB provides the delta, orchestrator decides.
- **No materialized violations**: guarantees are checked on-demand by orchestrator, not stored
  in the graph. This keeps RFDB a storage layer, not a policy engine.

**Proof strategy:**
- Idempotency: re-analyze same file twice → graph unchanged
- Delta correctness: modify 1 function in file → only that function's nodes change
- Tombstone + new segment: old data invisible, new data visible, nothing lost
- Cross-reference integrity: edges pointing to tombstoned nodes → handled gracefully
- **Batch atomicity**: 10 AddNodes calls in batch → either all visible or none (no partial state)
- **File grouping correctness**: nodes with same `file` field → grouped into same shard operation
- **Edge ownership inference**: edge owned by src node's file; _owner edges → enrichment shard
- **Concurrent read during batch**: reader during CommitBatch → sees previous consistent snapshot
- **Delta summary accuracy**: CommitBatch delta matches DiffSnapshots(prev, current)
- **changedTypes accuracy**: changedNodeTypes/changedEdgeTypes = exact set of types in delta segments
- **ISSUE lifecycle**: re-analyze file with ISSUE nodes → old ISSUEs gone, new ones present
- Benchmark: re-analysis of 1 file = O(file_nodes), not O(total_nodes)

**Dependencies:** Phase 2, Phase 1 (manifest swap + snapshot chain)

**Deliverables:**
- `storage/tombstone.rs`
- `storage/batch.rs` (batch commit: file grouping, edge ownership, atomic commit)
- Re-analysis workflow in engine_v2
- Test suite: ~30-35 tests

---

## Phase 5: Wire Protocol v3 Integration

**Goal:** Replace v1 GraphEngine with v2. Protocol v3 with batch commit, streaming,
request IDs, and snapshot diff. Backward compatible with v1/v2 clients.

**Scope:**

*Engine integration:*
- `GraphEngine` trait implementation for v2 engine
- All existing protocol handlers call v2 engine instead of v1
- DatabaseManager creates v2 engines for new databases
- Ephemeral databases: in-memory write buffers, no disk segments

*Protocol v3 additions:*
- **Request IDs** (optional): `{ requestId: "r1", cmd: "...", ... }`
  - Enables streaming, multiplexing, error correlation
  - Without requestId → FIFO matching (v1/v2 backward compat)
- **Batch commit**: BeginBatch → AddNodes/AddEdges → CommitBatch/AbortBatch
  - CommitBatch returns snapshot number + delta summary
  - Without BeginBatch → auto-commit (backward compat)
- **DiffSnapshots**: `{ from: 42, to: 43 }` → detailed node/edge delta
- **Streaming responses**: large result sets returned as chunks with `{ chunk, done }` frames
- **Removed commands**: GetAllEdges, UpdateNodeVersion, DeleteNode, DeleteEdge

*Client-side cleanup:*
- Wire protocol returns semantic_id string (from column, not from metadata.originalId)
- TypeScript RFDBServerBackend: stop stuffing originalId/_origSrc/_origDst into metadata
- u128 → semantic_id batch resolve at response boundary (Decision #4)

**Proof strategy:**
- **THE CRITICAL GATE:** all ~120 existing protocol + Datalog tests pass (may need minor
  adaptation for removed commands — DeleteNode/DeleteEdge tests converted to batch operations)
- Wire-level backward compat: v1/v2 clients (no requestId, no BeginBatch) work unchanged
- Batch commit: 10-file batch → atomic, delta summary matches DiffSnapshots
- DiffSnapshots: compare v42 vs v43 → correct added/removed/modified sets
- Streaming: queryNodes returning 50K nodes → arrives in chunks, client reassembles correctly
- Request ID correlation: concurrent requests on same socket → responses matched correctly

**Dependencies:** Phase 3 (multi-shard engine), Phase 4 (tombstones, batch commit)

**Deliverables:**
- Adapted `bin/rfdb_server.rs` handlers (request IDs, batch, streaming, diff)
- Adapted `database_manager.rs`
- Updated TypeScript `RFDBClient` (batch commit, streaming, diff methods)
- Updated TypeScript `RFDBServerBackend` (no more metadata ID hacks)
- Test suite: ~15-20 new tests (batch, streaming, diff) + existing ~120 adapted

---

## Phase 6: Enrichment Virtual Shards

**Goal:** Enrichment edges stored in virtual shards with ownership tracking.

**Scope:**
- **Enrichment shard model (I2):** composite file context `__enrichment__/{enricher}/{source_file}`. No `_owner` metadata field — ownership = shard = file context string. CommitBatch for enrichment uses this context.
- Enrichment write path: enricher output → CommitBatch with file context `__enrichment__/{enricher}/{file}`
- Granular re-enrichment: replace one enricher's edges for one file without touching others
- Incremental re-enrichment: delta from Phase 4 → find affected enrichers (I5: enricher dependency graph) → re-run on affected files only
- Selector/Processor contract (new enricher API)
- **Pre-commit blast radius (C4):** orchestrator queries dependents BEFORE CommitBatch (separation in time)

**Proof strategy:**
- Ownership via shard: edges in `__enrichment__/calls/app.ts` → owned by enricher "calls" for file "app.ts"
- Surgical deletion: CommitBatch for `__enrichment__/calls/app.ts` replaces only those edges
- No collision: analysis shard `app.ts` ≠ enrichment shard `__enrichment__/calls/app.ts`
- Incremental correctness: re-enrich after file change → same result as full re-enrich
- No orphaned edges: after re-analysis + re-enrichment, no edges point to deleted nodes

**Dependencies:** Phase 4 (tombstones), Phase 5 (working protocol)

**Note:** This phase requires parallel work on the TypeScript orchestrator side (separate research per architecture doc). The Rust side provides the storage primitives; the TS side owns the enrichment logic.

**Deliverables:**
- Enrichment shard support in engine_v2 (composite file context routing)
- Test suite: ~15-20 tests

---

## Phase 7: Background Compaction

**Goal:** Merge Level 0 segments into Level 1+ with inverted indexes. Performance, not correctness.

**Scope:**
- Compaction trigger: segment count threshold per shard
- Merge: multiple L0 segments → one L1 segment (sorted, deduplicated, tombstones applied)
- Inverted index built during compaction (by_type, by_name, by_file)
- Global index: sorted mmap array (node_id → shard, segment, offset)
- GC: old segments moved to gc/, deleted after no active readers
- Blue/green: build new structures → atomic swap → delete old

**Proof strategy:**
- **Query equivalence: results before compaction = results after compaction** (the fundamental invariant)
- Tombstone application: compacted segment contains no tombstoned records
- Inverted index correctness: index-based query = scan-based query (same results)
- Global index correctness: every node reachable via global index
- Concurrent safety: compaction while queries running → no torn reads
- Benchmark: post-compaction query latency improvement (target: 5-10x for attribute search)

**Dependencies:** Phase 5 (full working system to compact)

**Deliverables:**
- `storage/compaction.rs`
- `storage/inverted_index.rs`
- `storage/global_index.rs`
- Test suite: ~20-25 tests

---

## Phase 8: Resource Adaptation

**Goal:** Graceful performance across different hardware — laptop 8GB to server 512GB.

**Scope:**
- ResourceManager: monitor available RAM, CPU count
- Adaptive write buffer size (16MB → 1GB based on RAM)
- Adaptive shard thresholds (smaller shards on low RAM)
- Compaction thread pool sizing (1 → CPU/2 based on available cores)
- Prefetch strategy (none → aggressive based on RAM)
- Memory pressure handling: shrink buffers, defer compaction

**Proof strategy:**
- Low-memory mode: 512MB budget → system works (slower, more I/O, but correct)
- High-memory mode: 64GB budget → larger batches, faster throughput
- No OOM: enforce memory limits, degrade gracefully
- Benchmark matrix: measure throughput at 512MB, 4GB, 64GB budgets

**Dependencies:** Phase 7 (compaction tuning depends on resource awareness)

**Deliverables:**
- `storage/resource_manager.rs`
- Adaptive parameters throughout engine
- Test suite: ~10-15 tests

---

## Phase 9: Migration & Validation

**Goal:** Prove v2 works on real codebases. Provide migration path from v1.

**Scope:**
- Migration tool: v1 database → v2 (read v1 segments, write v2 sharded segments)
- Side-by-side validation: analyze same project with v1 and v2, compare all query results
- Real codebase benchmarks: the 2500-file project that triggered this work
- Stress test: synthetic graph at 50M nodes / 350M edges (100K-file scale)
- Performance comparison: v1 vs v2 memory, throughput, query latency

**Proof strategy:**
- **Bit-for-bit query equivalence on real codebase** (the ultimate proof)
- Memory measurement: v2 uses < 500MB where v1 used 20GB
- Regression benchmarks: no query slower than v1 (post-compaction)
- Crash recovery: kill during analysis → restart → correct state

**Dependencies:** Phase 5+ (working system), Phase 7 (for full performance comparison)

**Deliverables:**
- Migration tool
- Validation suite
- Benchmark report

---

## Dependency Graph

```
Phase 0: Segment Format ─────────────────────────┐
    │                                             │
    v                                             │
Phase 1: Manifest ──────────┐                     │
    │                       │                     │
    v                       v                     │
Phase 2: Single Shard ──> Phase 4: Tombstones     │
    │                       │                     │
    v                       │                     │
Phase 3: Multi-Shard ───────┤                     │
                            │                     │
                            v                     │
                    Phase 5: Wire Protocol ◄──────┘
                      (THE GATE: all tests pass)
                            │
                     ┌──────┴──────┐
                     v             v
              Phase 6:       Phase 7:
              Enrichment     Compaction
                     │             │
                     └──────┬──────┘
                            v
                     Phase 8: Resources
                            │
                            v
                     Phase 9: Migration
```

## Critical Gates

| Gate | Phase | Criterion | If fails |
|------|-------|-----------|----------|
| **Segment roundtrip** | 0 | Property-based: any records → write → read → identical. Semantic ID survives roundtrip without metadata. | Fix segment format |
| **Atomic snapshot** | 1 | Crash simulation: never corrupted manifest | Fix atomic swap |
| **Diff correctness** | 1 | DiffSnapshots returns exact added/removed/modified sets | Fix diff computation |
| **Query equivalence** | 2 | Same data → same results as v1 HashMap | Fix query path |
| **Batch atomicity** | 4 | 10-file batch commit: readers see all-or-nothing, never partial | Fix batch commit |
| **Delta summary accuracy** | 4 | CommitBatch delta matches DiffSnapshots(prev, current) | Fix delta computation |
| **ALL PROTOCOL TESTS** | 5 | ~120 existing tests pass (adapted for removed commands) | Fix v2 engine |
| **Streaming correctness** | 5 | 50K-node query via streaming = same result as non-streaming | Fix streaming |
| **Compaction invariant** | 7 | Pre-compaction results = post-compaction results | Fix compaction |
| **Real codebase validation** | 9 | v1 results = v2 results on 2500-file project | Fix everything |
| **Blast radius composition** | 9 | DiffSnapshots + Reachability = correct affected node set | Validate on real project |

---

## Phase Sizing (rough estimates, NOT commitments)

| Phase | Complexity | New Rust code | Tests |
|-------|-----------|---------------|-------|
| 0: Segment Format | Medium | ~1800 LOC | ~45 |
| 1: Manifest | Low-Medium | ~500 LOC | ~18 |
| 2: Single Shard | Medium-High | ~2000 LOC | ~28 |
| 3: Multi-Shard | Medium | ~800 LOC | ~20 |
| 4: Tombstones | Medium | ~600 LOC | ~22 |
| 5: Wire Protocol | Medium | ~500 LOC (refactor) | 0 (existing) |
| 6: Enrichment | Medium | ~700 LOC | ~18 |
| 7: Compaction | High | ~1500 LOC | ~22 |
| 8: Resources | Low-Medium | ~400 LOC | ~12 |
| 9: Migration | Medium | ~500 LOC + tooling | ~15 |
| **Total** | | **~9000 LOC** | **~190** |

Current v1 engine.rs alone is ~2500 LOC. v2 replaces it with well-factored modules.

---

## What We're NOT Building (explicitly out of scope)

1. **Multi-machine sharding** — out of scope, single-machine up to ~500M nodes
2. **Concurrent writers to same shard** — shard plan ensures one writer per shard; parallel writers to different shards is supported. Watch mode uses batch commit (multiple files → atomic commit), not concurrent writes
3. **WAL** — re-analyze = recovery (per architecture decision)
4. **Substring/trigram index** — columnar scan + SIMD for MVP, trigram later
5. **Orchestrator redesign** — separate research (architecture doc Section 5.2). RFDB provides batch commit + snapshot isolation primitives; orchestrator owns debouncing and analysis
6. **Cypher query language** — REG-255, separate track
7. **Legacy ID support** — v2 only accepts semantic IDs. Legacy → semantic conversion at ingestion boundary (TypeScript side)

---

## Relationship to Existing Linear Issues

| Issue | Status | Roadmap impact |
|-------|--------|---------------|
| REG-404 (flush optimization research) | Research done → mark Done | Findings became this roadmap |
| REG-405 (20GB RAM delta log) | Backlog | **Solved by Phase 0-3** (no delta log in v2) |
| REG-91 (benchmarks on real projects) | Backlog | **Phase 9** covers this |
| REG-196 (performance benchmarks) | Done | Existing benchmarks reused for regression |
| REG-360 (comparative benchmark) | Backlog | After Phase 9 |
| REG-150 (issue lifecycle on reanalysis) | Done | Phase 4 tombstones improve this |
| REG-338 (rename to Rega Flow) | In Review | Orthogonal, can do anytime |

---

## Development Principles

1. **Each phase is self-contained and shippable.** Phase 5 is the first externally useful checkpoint — v2 works behind the same protocol.

2. **Tests before code, always.** Each phase starts with test skeletons that define "done". Implementation fills them in.

3. **Prove, don't hope.** Property-based tests for data structures. Equivalence tests against v1 for queries. Real codebase validation at the end.

4. **No feature flags or gradual rollout inside the engine.** v2 engine is a clean implementation. The switch happens at Phase 5 (protocol integration).

5. **Compaction is optimization, not correctness.** The system must work correctly WITHOUT compaction (Level 0 only). Compaction makes it faster, not more correct.

6. **One phase at a time.** Resist the urge to jump ahead. Each layer must be solid before building on it.
