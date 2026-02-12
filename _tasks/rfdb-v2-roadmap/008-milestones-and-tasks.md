# RFDB v2: Milestones, Tasks & Dependencies

> Date: 2026-02-11
> Input: 002-roadmap.md, 005-orchestrator-design.md, 006-client-spec.md, 007-semantic-id-stability-research.md
> Status: DRAFT — requires review

---

## Overview

3 трека, 7 милестонов, 25 задач.

```
Track 1 (RFDB, Rust):        Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9
Track 2 (Orchestrator, TS):   Phase A ──────────────────→ B → C → D
Track 3 (Client, TS):         Phase A ──────────────→ C → B,D,E
Analyzer (TS):                Semantic ID v2 ──────────────────────→
```

---

## Development Strategy: Hybrid (вариант C)

Новый v2 engine как **отдельный модуль внутри существующего `rfdb-server` package**. Shared код (protocol, datalog, metrics, session) не дублируется.

```
packages/rfdb-server/src/
  graph/
    engine.rs           ← v1 engine (HashMap) — НЕ ТРОГАЕМ
    engine_v2.rs        ← NEW: v2 engine (segments + shards)
    mod.rs              ← GraphEngine trait, обе реализации
  storage_v2/           ← NEW: всё v2 storage
    segment.rs          ← Phase 0: колоночный формат
    bloom.rs            ← Phase 0: src + dst bloom filters
    zone_map.rs         ← Phase 0: per-segment zone maps
    string_table.rs     ← Phase 0: embedded string table
    manifest.rs         ← Phase 1: snapshot chain + tags
    snapshot.rs         ← Phase 1: immutable views
    diff.rs             ← Phase 1: snapshot diff
    shard.rs            ← Phase 2: single-shard read/write
    write_buffer.rs     ← Phase 2: in-memory accumulation
    shard_planner.rs    ← Phase 3: file → shard assignment
    tombstone.rs        ← Phase 4: deleted IDs
    batch.rs            ← Phase 4: atomic multi-file commit
    compaction.rs       ← Phase 7: L0 → L1 merge
    inverted_index.rs   ← Phase 7: post-compaction indexes
    global_index.rs     ← Phase 7: node_id → location
    resource_manager.rs ← Phase 8: adaptive parameters
  bin/rfdb_server.rs    ← SHARED: protocol handlers (через trait)
  datalog/              ← SHARED: не меняется
  session.rs            ← SHARED: не меняется
  metrics.rs            ← SHARED: не меняется
```

### GraphEngine trait

```rust
trait GraphEngine {
    // Existing operations (v1 compatible)
    fn add_nodes(&mut self, nodes: &[NodeRecord]) -> Result<()>;
    fn add_edges(&mut self, edges: &[EdgeRecord]) -> Result<()>;
    fn get_node(&self, id: u128) -> Result<Option<NodeRecord>>;
    fn query_nodes(&self, query: &NodeQuery) -> Result<Vec<NodeRecord>>;
    fn get_outgoing_edges(&self, src: u128) -> Result<Vec<EdgeRecord>>;
    fn get_incoming_edges(&self, dst: u128) -> Result<Vec<EdgeRecord>>;
    // ... all existing operations

    // v2 additions (default = error for v1)
    fn begin_batch(&mut self) -> Result<()> { Err(unsupported()) }
    fn commit_batch(&mut self, tags: Option<&Tags>) -> Result<CommitDelta> { Err(unsupported()) }
    fn abort_batch(&mut self) -> Result<()> { Err(unsupported()) }
    fn diff_snapshots(&self, from: SnapshotRef, to: SnapshotRef) -> Result<SnapshotDiff> { Err(unsupported()) }
    // ...
}
```

### Ключевые свойства

1. **Оба engine в одном бинарнике** — `database_manager.rs` решает какой создавать
2. **Phase 5 = переключение**: handlers → v2 engine. Одна строка в конфиге.
3. **Side-by-side validation (Phase 9)**: один запрос → оба engine → сравнить результат
4. **v1 = fallback**: если v2 сломался — переключить обратно без пересборки
5. **Cleanup**: после полной валидации — удалить v1 код одним коммитом
6. **v2 opt-in until M6**: v1 остаётся default engine до завершения M6 (compaction). v2 доступен через `--engine v2` CLI flag. Причина: pre-compaction v2 до 50x медленнее на point lookups. Первое впечатление важно — не давать пользователям медленную версию как default.

### Когда удалять v1

После прохождения M7 (Validation):
- Все 120+ тестов проходят на v2
- Real codebase validation OK
- Stress test OK
- Performance >= v1

Один коммит: удалить `engine.rs`, `graph/index_set.rs`, старый `storage/`. Trait остаётся (может пригодиться для тестового in-memory engine).

---

## Milestone 1: Foundation

**Цель:** Заложить фундамент по всем трекам. Все задачи независимы — полный параллелизм.

**Sync point:** Все 4 задачи завершены + результаты валидированы.

### T1.1 — Segment Format (Track 1, Rust)
RFDB Phase 0. Атомарный строительный блок — иммутабельный колоночный сегмент.

**Подзадачи:**
1. `NodeSegment`: колоночный layout (semantic_id, id/u128, type, name, file, content_hash/u64, metadata)
2. `EdgeSegment`: колоночный layout (src/u128, dst/u128, type, metadata)
3. Per-segment string table (встроенная, не глобальная)
4. Src bloom filter per segment (10 bits/key, 1% FPR, keyed on u128)
5. **Dst bloom filter** per edge segment (N8 — для C4 blast radius)
6. **Zone maps** per segment footer: set of distinct values per key field (I3)
7. Segment header (magic, version, counts, offsets) + footer (bloom, zone maps, string table)
8. `SegmentWriter::write()` + `SegmentReader::open()`

**Валидация:**
- Property-based tests (proptest): any Vec<NodeRecord> → write → read → identical
- Semantic ID roundtrip: string survives without metadata
- u128 = BLAKE3(semantic_id) always
- content_hash roundtrip
- Bloom filter: zero false negatives, FPR < 2%
- Dst bloom filter: zero false negatives, FPR < 2%
- Zone maps: exact set of distinct values
- Binary stability: byte-exact roundtrip
- Corruption detection: truncated/flipped → clean error
- **Benchmark: write throughput > 500K nodes/sec, read latency baseline**

**Deliverables:** `segment.rs`, `bloom.rs`, `zone_map.rs`, `string_table.rs`, ~45 tests

**Зависимости:** нет
**Estimate:** ~1800 LOC

---

### T1.2 — Enricher Contract v2 (Track 2, TS)
Orchestrator Phase A. Новый контракт обогащателей — без зависимости от RFDB v2.

**Подзадачи:**
1. Определить `EnricherV2` interface (`relevantFiles()`, `processFile()`)
2. Определить `EnricherMetadata` с `consumes: EdgeType[]`, `produces: EdgeType[]`
3. Аудит всех 14 enrichers: определить consumes/produces для каждого
4. Реализовать `V1EnricherAdapter` для обратной совместимости
5. Добавить `relevantFiles()` к существующим enrichers (default: все changed files)
6. Добавить `processFile()` alongside existing `execute()`
7. Построить enricher dependency graph из consumes/produces (Kahn's algorithm уже есть)

**Валидация:**
- Unit tests: enricher metadata declares correct consumes/produces
- Dependency graph: no cycles (Kahn's detects)
- V1Adapter: legacy enricher через adapter = same results as direct
- **All existing enrichment tests pass through V1Adapter**

**Deliverables:** `EnricherV2.ts`, adapter, metadata updates, ~20 tests

**Зависимости:** нет
**Estimate:** ~400 LOC

---

### T1.3 — Client Request IDs (Track 3, TS)
Client Phase A. Request IDs в wire protocol — фундамент для streaming и multiplexing.

**Подзадачи:**
1. `requestId` field в каждом outgoing request (string, `r${counter}`)
2. `pending` Map: с FIFO matching на match-by-requestId
3. FIFO fallback если response без requestId (backward compat с v2 server)
4. Тривиальное изменение Rust сервера: echo requestId if present

**Валидация:**
- Request ID echo: send with requestId → response has same requestId
- FIFO fallback: response without requestId → matched to oldest pending
- Concurrent requests: 10 parallel sends → all responses matched correctly
- Timeout: request with requestId times out → only that request fails
- **All existing client tests pass (FIFO mode)**

**Deliverables:** Updated `RFDBClient`, minor server change, ~10 tests

**Зависимости:** нет
**Estimate:** ~150 LOC (TS) + ~30 LOC (Rust)

---

### T1.4 — Semantic ID v2 (Analyzer, TS)
Новый формат `file->TYPE->name[in:namedParent]`. Полностью TS-side, RFDB хранит строки — формат ему безразличен.

**Подзадачи:**
1. `computeSemanticIdV2()` в SemanticId.ts — новый формат с `[in:namedParent]`
2. `parseSemanticIdV2()` — парсинг нового формата
3. `ScopeTracker.getNamedParent()` — ближайший именованный предок
4. Content hash computation per node type (hash source table из 007)
5. Collision detection: Set<string> + graduated disambiguation (base → hash → counter)
6. `IdGenerator` v2 — switch generate/generateSimple to new format
7. Update FunctionVisitor (anonymous naming, arrow→variable, arrow→ObjectProperty)
8. Update CallExpressionVisitor (CALL, METHOD_CALL discriminators)
9. Update VariableVisitor (VARIABLE/CONSTANT)
10. Update ClassVisitor (methods, static blocks, private fields)
11. Update PropertyAccessVisitor
12. Update TypeScriptVisitor (INTERFACE, TYPE, ENUM)
13. **Migration tests**: v1 ID → v2 ID mapping for representative cases

**Валидация:**
- Roundtrip: computeV2 → parse → same components
- Stability: add lines above function → ID unchanged
- Stability: add if-block → IDs of children unchanged (no cascade)
- Collision: two `console.log` in same function → different IDs via hash
- Collision: identical calls → different IDs via counter
- Named parent: deep nesting → correct parent resolved
- Anonymous skip: nested anonymous → skip to named ancestor
- **Full analysis of test fixtures: compare v1 vs v2 IDs, document all changes**
- **Regression: analysis of real project → no duplicate IDs within any file**

**Deliverables:** Updated SemanticId.ts, ScopeTracker.ts, IdGenerator.ts, all visitors, ~30 tests

**Зависимости:** нет (но T1.2 enricher contract benefits from stable IDs)
**Estimate:** ~600 LOC changes

---

## Milestone 2: Storage Engine

**Цель:** Работающий storage engine (без batch commit, без tombstones). Read/write для одного и нескольких шардов.

**Sync point:** engine может хранить и отдавать данные. Начало интеграционного тестирования.

Задачи внутри M2 **последовательные** (каждая зависит от предыдущей).

Track 2/3 свободны во время M2 — могут работать над другими продуктовыми задачами или подготовительной работой.

### T2.1 — Manifest + Snapshot Chain (Track 1, Rust)
RFDB Phase 1.

**Подзадачи:**
1. Manifest JSON format: segment registry + stats + tags
2. Manifest chain: sequential version numbers (v1, v2, v3...)
3. Snapshot tags: optional key-value pairs per manifest
4. `current.json` atomic pointer (symlink or atomic rename)
5. Snapshot = immutable view of active segments
6. Diff computation: compare two manifests → added/removed segments
7. FindSnapshot (tag → number), ListSnapshots (filter by tag)
8. GC bookkeeping: old segments → gc/ directory

**Валидация:**
- Crash simulation: kill mid-write → `current.json` always valid
- Concurrent reads: one thread reads + another swaps → no torn reads
- GC safety: segments in gc/ not referenced by any snapshot
- Version monotonicity: snapshot numbers always increase
- Tag resolution: FindSnapshot correct for given tag
- **Diff correctness: DiffSnapshots returns exact added/removed/modified**

**Deliverables:** `manifest.rs`, `snapshot.rs`, `diff.rs`, ~25 tests

**Зависимости:** T1.1
**Estimate:** ~500 LOC

---

### T2.2 — Single-Shard Read/Write (Track 1, Rust)
RFDB Phase 2.

**Подзадачи:**
1. Shard = directory containing segments
2. Write path: Vec<NodeRecord> → segment file + manifest update
3. Point lookup: bloom filter check → segment scan → found/not found
4. Attribute search: zone map pruning → columnar scan
5. Neighbors query: edge segment scan (bloom on src/dst)
6. Write buffer: in-memory accumulation before flush

**Валидация:**
- **Equivalence tests: same data in v1 HashMap vs v2 shard → identical query results**
- Full CRUD: add nodes → query → verify → add edges → neighbors → verify
- Multiple segments: flush twice → both queryable
- Write buffer + segment: unflushed + flushed → both visible
- **Benchmark: query latency vs v1 (must be within 2x for L0)**

**Deliverables:** `shard.rs`, `write_buffer.rs`, `engine_v2.rs` (single-shard), ~28 tests

**Зависимости:** T1.1, T2.1
**Estimate:** ~2000 LOC

---

### T2.3 — Multi-Shard (Track 1, Rust)
RFDB Phase 3.

**Подзадачи:**
1. Shard planner: file list → shard assignments (directory-based)
2. Multi-shard queries: fan-out + merge
3. Parallel shard writes (rayon)
4. Cross-shard point lookup via bloom filters

**Валидация:**
- Deterministic: same files → same plan
- Completeness: every file in exactly one shard
- Parallel correctness: N workers = sequential result
- Query completeness: node findable regardless of shard
- Shard plan stability: small change → minimal reassignment

**Deliverables:** `shard_planner.rs`, multi-shard engine_v2, ~20 tests

**Зависимости:** T2.2
**Estimate:** ~800 LOC

---

## Milestone 3: Incremental Core

**Цель:** Batch commit, tombstones, snapshot isolation. Ядро инкрементального обновления.

**Sync point:** RFDB умеет атомарно обновлять файлы + возвращать delta. Client умеет посылать batch.

### T3.1 — Tombstones + Batch Commit (Track 1, Rust)
RFDB Phase 4.

**Подзадачи:**
1. Tombstone segments: mark deleted node/edge IDs
2. Query path: skip tombstoned records
3. BeginBatch / CommitBatch / AbortBatch protocol
4. File grouping: nodes grouped by `file` field → shard operations
5. Edge ownership: file context of CommitBatch (I2 — no read-during-write)
6. Enrichment file context: `__enrichment__/{enricher}/{source_file}`
7. Atomic manifest swap for entire batch
8. Auto-commit without BeginBatch (backward compat)
9. CommitBatch delta: changedFiles, nodesAdded/Removed/Modified, removedNodeIds, changedNodeTypes, changedEdgeTypes
10. Modified detection via content_hash (I4): same semantic_id + different content_hash = modified

**Валидация:**
- Idempotency: re-analyze same file → graph unchanged
- Delta correctness: modify 1 function → only that function's nodes change
- Tombstone + new: old invisible, new visible
- **Batch atomicity: 10 AddNodes → all-or-nothing**
- File grouping: same file → same shard operation
- Concurrent read during batch → previous snapshot
- **Delta accuracy: CommitBatch delta matches DiffSnapshots(prev, current)**
- changedTypes accuracy: exact set of types in delta
- ISSUE lifecycle: re-analyze → old ISSUEs gone, new present
- **Benchmark: re-analysis of 1 file = O(file_nodes), not O(total)**

**Deliverables:** `tombstone.rs`, `batch.rs`, updated engine_v2, ~35 tests

**Зависимости:** T2.1, T2.2 (manifest + shard)
**Estimate:** ~600 LOC

---

### T3.2 — Client Batch API (Track 3, TS)
Client Phase C.

**Подзадачи:**
1. `beginBatch()`, `commitBatch(tags?)`, `abortBatch()` methods
2. `CommitDelta` type definition + parsing
3. `findDependentFiles(changedFiles)` for C4 blast radius
4. Auto-commit detection (AddNodes without BeginBatch)

**Валидация:**
- Batch → commit → delta correct
- Batch → abort → nothing committed
- AddNodes without batch → auto-commit
- CommitBatch with tags → tags stored
- **Integration: TS client → Rust server → batch round-trip**

**Deliverables:** Updated `RFDBClient`, `CommitDelta` type, ~15 tests

**Зависимости:** T3.1 (Rust batch), T1.3 (request IDs)
**Estimate:** ~200 LOC

---

### T3.3 — Client Snapshot API (Track 3, TS)
Client Phase E.

**Подзадачи:**
1. `diffSnapshots(from, to)` — by number or by tag
2. `tagSnapshot(tags)`, `findSnapshot(tag, value)`, `listSnapshots(filter?)`
3. `SnapshotDiff` type definition
4. Snapshot reference types (number | {tag, value})

**Валидация:**
- tag → find → diff workflow
- Diff by number = diff by resolved tag
- listSnapshots with filter → correct subset

**Deliverables:** Updated `RFDBClient`, snapshot types, ~10 tests

**Зависимости:** T2.1 (Rust manifests), T3.1 (Rust snapshots)
**Estimate:** ~150 LOC

---

## Milestone 4: Integration Gate

**Цель:** v2 engine полностью заменяет v1 за тем же протоколом. **THE GATE: все ~120 существующих тестов проходят.**

**Sync point:** Самая критичная точка синхронизации. После M4 — v2 engine production-ready для существующего функционала.

### T4.1 — Wire Protocol v3 Integration (Track 1, Rust)
RFDB Phase 5. Замена v1 engine на v2 в серверных хендлерах.

**Подзадачи:**
1. `GraphEngine` trait implementation для v2 engine
2. Все существующие protocol handlers → v2 engine
3. DatabaseManager creates v2 engines
4. Ephemeral databases: in-memory write buffers
5. Batch commit handlers: BeginBatch, CommitBatch, AbortBatch
6. DiffSnapshots handler
7. Streaming response support (chunked `{chunk, done}` frames)
8. Removed commands: GetAllEdges → streaming QueryEdges, UpdateNodeVersion → noop, DeleteNode/DeleteEdge → batch
9. Version handshake: `hello` command returns protocol version + features

**Валидация:**
- **ALL ~120 existing protocol + Datalog tests pass** (adapted for removed commands)
- Wire backward compat: v1/v2 clients work unchanged
- Batch commit: 10-file batch → atomic
- DiffSnapshots: correct delta between two snapshots
- Streaming: 50K nodes → chunked, client reassembles
- Request ID correlation: concurrent requests → correct matching
- **Benchmark: protocol overhead vs v1**

**Deliverables:** Adapted `rfdb_server.rs`, `database_manager.rs`, ~20 new tests + ~120 adapted

**Зависимости:** T2.3, T3.1 (multi-shard + batch)
**Estimate:** ~500 LOC refactor

---

### T4.2 — Client Semantic ID Wire Format (Track 3, TS)
Client Phase B.

**Подзадачи:**
1. `WireNodeV3` / `WireEdgeV3` types with `semanticId`
2. Remove `originalId` / `_origSrc` / `_origDst` metadata hacks
3. Version handshake at connect time
4. RFDBServerBackend cleanup

**Валидация:**
- Semantic ID roundtrip: client → server → client = same string
- No metadata hacks in wire format
- Backward compat: client v3 → server v2 (degraded mode)
- **All existing TS integration tests pass with v3 wire format**

**Deliverables:** Updated `RFDBClient`, `RFDBServerBackend`, ~10 tests

**Зависимости:** T4.1 (Rust v3 protocol)
**Estimate:** ~300 LOC

---

### T4.3 — Client Streaming (Track 3, TS)
Client Phase D.

**Подзадачи:**
1. Streaming response parser (chunk accumulation)
2. `queryNodesStream()` async generator
3. Auto-fallback: server-initiated streaming detection
4. Backpressure via async iteration

**Валидация:**
- Small result (<100) → non-streaming
- Large result (>1000) → chunked
- Auto-fallback → client handles
- Backpressure: slow consumer → server doesn't OOM
- Stream abort: client cancels → server stops
- **Streaming result = non-streaming result (equivalence)**

**Deliverables:** Updated `RFDBClient` streaming, ~12 tests

**Зависимости:** T4.1 (Rust streaming)
**Estimate:** ~250 LOC

---

### T4.4 — Integration Gate Validation
Комплексная валидация после M4.

**Подзадачи:**
1. Full test suite: all Rust tests + all TS tests + integration
2. **Benchmark suite: v2 vs v1 performance comparison** (query latency, write throughput, memory)
3. Stress test: synthetic graph 100K nodes / 700K edges
4. Crash recovery test: kill during batch → restart → correct state
5. Concurrent clients test: two TS clients → same server → independent batches
6. **Semantic ID isolation test:** Run v2 engine with v1 semantic IDs first → validate. Then run with v2 semantic IDs → validate. Compare results. This separates storage engine bugs from ID format bugs — if something breaks, bisect which layer caused it.

**Зависимости:** T4.1, T4.2, T4.3, T3.2, T3.3
**Estimate:** ~15 tests + benchmark report

---

## Milestone 5: Enrichment Pipeline

**Цель:** Полный enrichment pipeline работает с RFDB v2. Blast radius, selective re-enrichment, guarantees.

**Sync point:** Orchestrator v2 полностью интегрирован с RFDB v2.

### T5.1 — Enrichment Virtual Shards (Track 1, Rust)
RFDB Phase 6.

**Подзадачи:**
1. Composite file context routing: `__enrichment__/{enricher}/{file}` → shard
2. CommitBatch с enrichment file context → tombstones only enrichment edges
3. Surgical deletion: replace one enricher's edges for one file

**Валидация:**
- Ownership via shard: correct edges in correct shard
- Surgical deletion: only targeted edges replaced
- No collision: analysis shard ≠ enrichment shard
- **Incremental: re-enrich = same as full re-enrich**

**Deliverables:** Enrichment shard support in engine_v2, ~18 tests

**Зависимости:** T4.1 (working v2 engine)
**Estimate:** ~700 LOC

---

### T5.2 — Orchestrator Batch Protocol (Track 2, TS)
Orchestrator Phase B.

**Подзадачи:**
1. Switch from `addEdge()` to CommitBatch calls
2. Enrichment shard file context (`__enrichment__/{enricher}/{file}`)
3. **Pre-commit blast radius query (C4):** query dependents BEFORE commit
4. Use CommitBatch delta for selective enrichment
5. Delta-driven enricher selection: changedNodeTypes ∩ enricher.consumes

**Валидация:**
- Enrichment produces correct shard structure
- Blast radius: add edge A→B, change B → A detected as dependent
- Selective enrichment: change FUNCTION → only enrichers consuming FUNCTION re-run
- **Full enrichment pipeline: analysis → blast radius → commit → selective enrichment → correct graph**

**Deliverables:** Updated `Orchestrator.ts`, blast radius query, ~20 tests

**Зависимости:** T4.1 (Rust v2), T3.2 (client batch), T1.2 (enricher contract)
**Estimate:** ~500 LOC

---

### T5.3 — Enricher Dependency Propagation (Track 2, TS)
Orchestrator Phase C.

**Подзадачи:**
1. Build enricher dependency graph from consumes/produces
2. Propagation: enricher A output changed → downstream enrichers re-run
3. Termination proof (DAG + bounded iterations)

**Валидация:**
- Change in enricher A → enricher B (consuming A) re-runs
- No cycles in dependency graph
- **Termination: worst case = all enrichers re-run (v1 behavior)**

**Deliverables:** Dependency propagation in orchestrator, ~10 tests

**Зависимости:** T5.2
**Estimate:** ~200 LOC

---

### T5.4 — Guarantee Integration (Track 2, TS)
Orchestrator Phase D.

**Подзадачи:**
1. Move guarantee checking to post-enrichment hook
2. Selective: check only rules matching changedNodeTypes/changedEdgeTypes
3. Coverage monitoring via content_hash canary (I4)
4. Remove guarantees from VALIDATION phase

**Валидация:**
- **Guarantees never fire between analysis and enrichment**
- Selective: change FUNCTION → only FUNCTION-related rules checked
- Coverage canary: content changed + analysis unchanged → warning
- All existing guarantee tests pass

**Deliverables:** Updated guarantee pipeline, coverage monitoring, ~12 tests

**Зависимости:** T5.2
**Estimate:** ~200 LOC

---

### T5.5 — Enrichment Pipeline Validation
Комплексная валидация M5.

**Подзадачи:**
1. End-to-end: edit file → analysis → blast radius → selective enrichment → guarantees
2. Watch mode simulation: sequence of file changes → correct incremental updates
3. **Benchmark: selective enrichment vs full re-enrichment (speedup measurement)**
4. Edge case: file deleted → all edges cleaned up
5. Edge case: enricher added/removed → correct re-enrichment

**Зависимости:** T5.1, T5.2, T5.3, T5.4
**Estimate:** ~15 tests + benchmark report

---

## Milestone 6: Performance

**Цель:** Compaction, resource adaptation, production-level performance.

**Может начинаться параллельно с M5** (Track 1 compaction не зависит от Track 2 enrichment).

### T6.1 — Background Compaction (Track 1, Rust)
RFDB Phase 7.

**Подзадачи:**
1. Compaction trigger: segment count threshold per shard
2. Merge: L0 segments → L1 (sorted, deduplicated, tombstones applied)
3. Inverted index built during compaction (by_type, by_name, by_file)
4. Global index: sorted mmap array (node_id → shard, segment, offset)
5. GC: old segments → gc/, deleted after no readers
6. Blue/green: build → swap → delete

**Валидация:**
- **Query equivalence: before compaction = after compaction**
- Tombstone application: compacted = no tombstoned records
- Inverted index: index query = scan query
- Global index: every node reachable
- Concurrent safety: compaction during queries → no torn reads
- **Benchmark: post-compaction query latency (target: 5-10x improvement)**

**Deliverables:** `compaction.rs`, `inverted_index.rs`, `global_index.rs`, ~25 tests

**Зависимости:** T4.1 (working engine)
**Estimate:** ~1500 LOC

---

### T6.2 — Resource Adaptation (Track 1, Rust)
RFDB Phase 8.

**Подзадачи:**
1. ResourceManager: monitor RAM, CPU
2. Adaptive write buffer, shard thresholds, compaction threads
3. Memory pressure handling
4. Prefetch strategy

**Валидация:**
- Low-memory (512MB) → works, slower
- High-memory (64GB) → larger batches, faster
- **No OOM: enforce limits, degrade gracefully**

**Deliverables:** `resource_manager.rs`, adaptive parameters, ~12 tests

**Зависимости:** T6.1
**Estimate:** ~400 LOC

---

### T6.3 — Performance Benchmark Suite
Комплексные бенчмарки.

**Подзадачи:**
1. Write throughput: nodes/sec at various sizes (1K, 10K, 100K, 1M)
2. Query latency: point lookup, attribute search, BFS, neighbors
3. Re-analysis cost: one file change in graph of N files
4. Compaction throughput: segments/sec, space amplification
5. Memory profile: RSS at various graph sizes
6. **Comparison matrix: v1 vs v2 across all metrics**

**Зависимости:** T6.1, T6.2

---

## Milestone 7: Validation & Release

**Цель:** Реальные кодовые базы. Миграция. Финальная проверка.

**Sync point:** Все треки сходятся. v2 готов к production.

### T7.1 — Migration Tool (Track 1, Rust)
RFDB Phase 9 (partial).

**Подзадачи:**
1. v1 database reader → v2 segment writer
2. Semantic ID conversion (legacy → v2 format)
3. Batch migration with progress reporting

**Deliverables:** Migration tool, ~10 tests

**Зависимости:** T4.1+

---

### T7.2 — Real Codebase Validation
RFDB Phase 9 (core).

**Подзадачи:**
1. **2500-file project**: full analysis with v2 → compare all query results with v1
2. Semantic ID v2 stability test: edit files → verify no cascading ID changes
3. Incremental re-analysis: edit 1 file → verify blast radius + selective enrichment
4. Watch mode: 10 sequential file edits → correct incremental graph
5. **Bit-for-bit query equivalence on real codebase**

**Зависимости:** T7.1, M5 (enrichment), M6 (compaction)

---

### T7.3 — Stress Test
**Подзадачи:**
1. Synthetic graph: 50M nodes / 350M edges (100K-file scale)
2. Memory: v2 uses < 500MB where v1 used 20GB
3. Query latency under load
4. Concurrent clients under stress
5. Crash recovery: kill mid-batch → restart → correct

**Зависимости:** M6 (compaction + resources)

---

## Dependency Graph

```
M1 (Foundation) — all parallel
├── T1.1  Segment Format ──────────────────────────────────┐
├── T1.2  Enricher Contract ──────────────────────────┐    │
├── T1.3  Client Request IDs ────────────────────┐    │    │
└── T1.4  Semantic ID v2 ─────────────────────┐  │    │    │
                                               │  │    │    │
M2 (Storage) — sequential                     │  │    │    │
├── T2.1  Manifest ◄───────────────────────────│──│────│────┘
├── T2.2  Single Shard ◄── T2.1                │  │    │
└── T2.3  Multi Shard ◄── T2.2                 │  │    │
                                               │  │    │
M3 (Incremental) — partial parallel            │  │    │
├── T3.1  Tombstones+Batch ◄── T2.1, T2.2     │  │    │
├── T3.2  Client Batch ◄── T3.1, T1.3 ────────│──┘    │
└── T3.3  Client Snapshots ◄── T2.1, T3.1     │       │
                                               │       │
M4 (Integration Gate) ★★★                      │       │
├── T4.1  Wire Protocol v3 ◄── T2.3, T3.1     │       │
├── T4.2  Client Semantic ID ◄── T4.1 ◄───────┘       │
├── T4.3  Client Streaming ◄── T4.1                    │
└── T4.4  Gate Validation ◄── T4.1-3, T3.2-3          │
                                                       │
M5 (Enrichment) — partial parallel                     │
├── T5.1  Virtual Shards ◄── T4.1 ◄───────────────────┘
├── T5.2  Orchestrator Batch ◄── T4.1, T3.2, T1.2
├── T5.3  Dependency Propagation ◄── T5.2
├── T5.4  Guarantee Integration ◄── T5.2
└── T5.5  Enrichment Validation ◄── T5.1-4

M6 (Performance) — can overlap with M5
├── T6.1  Compaction ◄── T4.1
├── T6.2  Resources ◄── T6.1
└── T6.3  Benchmarks ◄── T6.1-2

M7 (Validation) — everything converges
├── T7.1  Migration ◄── T4.1
├── T7.2  Real Codebase ◄── M5, M6
└── T7.3  Stress Test ◄── M6
```

---

## Parallelism Map

```
Time →

Track 1 (Rust):   [T1.1]→[T2.1]→[T2.2]→[T2.3]→[T3.1]→[T4.1]→─┬─[T5.1]→─────────[T7.1]→[T7.2]→[T7.3]
                                                                  └─[T6.1]→[T6.2]──────────────────┘

Track 2 (TS):     [T1.2]──────────────(free)──────────────────────[T5.2]→[T5.3]→[T5.5]
                                                                  [T5.2]→[T5.4]─┘

Track 3 (TS):     [T1.3]──────────────(free)────[T3.2]──[T4.2]──[T4.3]
                                                 [T3.3]

Analyzer (TS):    [T1.4]──────────────(free)──────────────────────────────────────[T7.2]

                  ╟═══════╢═══════════════════╢════════╢════════╢═══════════╢═══════════╢
                    M1        M2                 M3       M4        M5+M6       M7
```

**Максимальный параллелизм:**
- M1: 4 задачи одновременно (4 разработчика)
- M2: 1 задача (Rust sequential), Track 2/3/Analyzer свободны
- M3: T3.1 (Rust) + T3.2/T3.3 (TS) частично параллельны
- M4: T4.1 (Rust) → T4.2+T4.3 (TS параллельно)
- M5+M6: T5.1 (Rust) ∥ T5.2-5.4 (TS) ∥ T6.1 (Rust) — **3 потока**
- M7: последовательно, всё сходится

---

## Sync Points (обязательная синхронизация)

| Point | After | Before | What to verify |
|-------|-------|--------|---------------|
| **S1** | M1 complete | M2 start | Segment format frozen, enricher contract stable, Semantic ID v2 validated |
| **S2** | T3.1 complete | T3.2, T3.3 | Batch protocol wire format frozen |
| **S3** ★ | M4 complete | M5, M6 | **ALL 120+ tests pass. v2 replaces v1.** Performance baseline established. |
| **S4** | M5 complete | T7.2 | Full enrichment pipeline validated end-to-end |
| **S5** | M6 complete | T7.3 | Compaction + resources stable for stress test |
| **S6** ★ | M7 complete | Release | Real codebase validated. Performance confirmed. Ready for production. |

★ = major gate, requires full review

---

## Summary

| Milestone | Tasks | Parallelism | Estimated LOC | Tests |
|-----------|-------|-------------|---------------|-------|
| M1: Foundation | 4 | Full (4 streams) | ~2950 | ~105 |
| M2: Storage | 3 | Sequential (Rust) | ~3300 | ~73 |
| M3: Incremental | 3 | Partial (Rust → TS) | ~950 | ~60 |
| M4: Gate | 4 | Partial (Rust → TS) | ~1050 | ~162 |
| M5: Enrichment | 5 | Partial (Rust ∥ TS) | ~1600 | ~75 |
| M6: Performance | 3 | Sequential (Rust) | ~1900 | ~37 |
| M7: Validation | 3 | Sequential | ~500+ | ~25+ |
| **Total** | **25** | | **~12,250** | **~537** |
