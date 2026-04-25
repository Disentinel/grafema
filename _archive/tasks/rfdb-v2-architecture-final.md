# RFDB v2: Final Architecture

> Дата: 2026-02-11
> Статус: Architecture design complete
> Предыдущий документ: rfdb-v2-architecture-research.md

---

## 1. Что это

Graph database для статического анализа кода. Хранит ноды (функции, переменные, классы, маршруты) и edges (вызовы, импорты, data flow) всего проекта. Оптимизирована под паттерн: **тяжёлая запись → кросс-файловое обогащение → интерактивные запросы → инкрементальное обновление**.

### Масштаб

| Проект | Файлы | Ноды | Edges | Диск |
|--------|-------|------|-------|------|
| Средний (текущий) | 2.5K | 1.3M | 9.3M | ~600 MB |
| Крупный | 100K | ~50M | ~350M | ~25 GB |
| Enterprise (SAP R/3) | 1M+ | ~500M | ~3.5B | ~250 GB |

### Требования

1. **O(metadata) RAM** — потребление пропорционально метаданным (bloom filters, manifest), не полному графу
2. **Immediate queryability** — данные доступны сразу после insert
3. **Incremental updates** — изменение 1 файла = O(файл), не O(граф)
4. **Horizontal scaling** — эффективное использование 128 CPU + доступной RAM
5. **Sharding** — для графов, не помещающихся на одну машину

---

## 2. Core Concepts

### 2.1. Shard = единица хранения

Shard = директория проекта. Файлы в одной папке тесно связаны — большинство edges intra-shard.

```
src/
├── controllers/auth/         # shard — 15 файлов, тесно связаны
├── controllers/orders/       # shard
├── services/payment/         # shard
├── utils/                    # shard
└── __enrichment__/           # виртуальные шарды
    ├── imports/              # ImportExportLinker
    ├── http-connections/     # HTTPConnectionEnricher
    └── mount-points/         # MountPointResolver
```

**Shard plan строится до записи (на этапе индексирования):**

Сегменты append-only и иммутабельны → можно спланировать шардирование заранее:
```
Indexing phase (до analysis):
  1. Обойти FS → список файлов + LOC каждого
  2. Эвристика: ~5-10 нод на строку кода (набрать статистику)
  3. Построить shard plan:
     - src/controllers/auth/ (15 файлов, ~3K LOC) → ~20K нод → 1 shard
     - src/utils.js (1 файл, 8K LOC) → ~50K нод → 1 shard (файл = шард)
     - src/generated/ (500 файлов, плоская) → hash(filename) % 4 → 4 шарда
  4. Analysis workers получают shard plan → пишут сразу в целевой сегмент
```

На выходе analysis: не 2500 мелких сегментов, а ~100-300 оптимальных.
Compaction между фазами может не понадобиться — шарды уже нужного размера.

**Стратегии шардирования:**
- **Directory-based** (default): файлы в одной папке → один шард
- **Hash fallback**: плоская директория с 3000 файлов → `hash(filename) % N`, N по estimated node count
- **Adaptive split/merge** (runtime): shard > threshold → split по поддиректориям (вплоть до 1 файла), shard < threshold → merge вверх
- Threshold зависит от доступных ресурсов (больше RAM → крупнее шарды)

**Re-analysis одного файла:** tombstones + append в существующий шард
(мелкий сегмент внутри шарда, компактить потом в фоне).

**Enrichment:** виртуальные шарды `__enrichment__/{enricher_name}/` — та же механика, но для кросс-файловых edges. Каждый enrichment edge несёт `_owner` = имя enricher-а.

### 2.2. Segment = иммутабельный файл данных

Внутри шарда — один или несколько segments. Segment иммутабелен (write-once, never modify).

```
Segment: shard_controllers_auth_v3.seg

  Header:
    shard_path: "src/controllers/auth/"
    record_count: 520
    level: 0 (fresh) | 1+ (compacted)
    created_at: timestamp

  Columnar data:
    id_column:   [u128; 520]        # semantic ID hashes
    type_column: [u16; 520]         # enum index
    name_column: [offset; 520] + string_data
    file_column: [offset; 520] + string_data
    meta_column: [offset; 520] + json_data

  Bloom filter:
    bits: [u8; 650]                 # 10 bits/key, 1% FPR

  (Level 1+ only):
    Inverted index:
      by_type: { "FUNCTION" → [0,3,7], "VARIABLE" → [1,2], ... }
      by_name: { "handleAuth" → [0], "token" → [1], ... }
```

### 2.3. LSM-tree: write → read optimized

Данные проходят через уровни, от быстрой записи к быстрому чтению:

```
Write path:
  Insert → Write buffer (RAM)
         → Flush → Level 0 segment (unsorted, bloom filter only)

Background compaction:
  Level 0 segments → merge-sort → Level 1 segment (sorted, inverted index)

Read path:
  1. Check write buffer (RAM)
  2. Bloom filter: skip segments без нужного ключа
  3. Level 0: columnar scan (мелкие, в L1 cache)
  4. Level 1+: inverted index O(1) или binary search O(log k)
```

### 2.4. Tombstones для инкрементальных обновлений

При re-analysis файла — не перезаписываем, а помечаем:

```
Re-analysis src/controllers/auth/login.ts:
  1. Tombstone segment: marks deleted node/edge IDs from old version
  2. New segment: contains new nodes/edges
  3. Manifest update: atomic pointer swap
  4. Compaction (background): merge, apply tombstones → clean segment
```

---

## 3. Storage Layout

```
.rfdb/
├── current.json                    # Atomic pointer → latest manifest
│
├── manifests/
│   ├── manifest-001.json           # Segment registry + stats
│   ├── manifest-002.json           # After re-analysis
│   └── ...
│
├── shards/
│   ├── src_controllers_auth/
│   │   ├── nodes_v1.seg            # Level 0 (fresh)
│   │   ├── nodes_v2.seg            # Level 0 (after re-analysis)
│   │   ├── nodes_v1.tombstones     # Deletions for v1
│   │   ├── edges_v1.seg
│   │   └── ...
│   ├── src_services_payment/
│   │   └── ...
│   └── __enrichment__/
│       ├── imports/
│       │   └── edges_v1.seg
│       └── http_connections/
│           └── edges_v1.seg
│
└── gc/                             # Old segments pending cleanup
```

---

## 4. Query Architecture

### 4.1. Point lookup: getNode(semanticId)

```
semanticId → blake3 hash → u128

Level 0 (write-heavy):
  for shard in shards:
    if shard.bloom.may_contain(hash):     # наносекунды, RAM
      scan shard segment → found?         # микросекунды, mmap
  Cost: O(shards) bloom checks + 1-2 segment reads

Level 1+ (post-compaction, global index available):
  global_index.binary_search(hash)        # O(log N), ~20 comparisons
  → (shard, segment, offset)              # direct read
  Cost: 1 binary search + 1 read

Global index: sorted mmap array [(node_id, shard_id, offset)]
  1.3M nodes × 24 bytes = 31 MB
```

### 4.2. Attribute search: queryNodes({type, name, file})

```
Level 0 (small segments, pre-compaction):
  1. Manifest stats → skip shards without matching types
  2. Columnar scan matching shards (10-40 KB, fits L1 cache)
  Cost: O(matching_shards × shard_size), fast for small shards

Level 1+ (compacted, inverted index available):
  1. Manifest stats → skip shards
  2. Inverted index: type["FUNCTION"] ∩ name["handleAuth"] = [offsets]
  3. Load records at offsets
  Cost: O(1) per shard via index
```

### 4.3. Neighbors: neighbors(nodeId)

```
Edge segments contain (src, dst, type).

1. Bloom filter: which shards may have edges with src=nodeId?
2. Scan matching shards, skip tombstoned edges
3. Return (dst, type) pairs

Reverse neighbors: same but filter on dst=nodeId
```

### 4.4. Substring search (future)

MVP: columnar scan + SIMD. Post-MVP: trigram index или FST per compacted segment.

---

## 5. Write Architecture

### 5.1. Analysis (bulk write)

```
Pre-analysis (indexing phase):
  1. Scan FS → file list + LOC
  2. Estimate nodes: ~5-10 nodes/LOC (calibrate from stats)
  3. Build shard plan:
     - Group files into shards by directory
     - Flat dirs (3000 files) → hash(filename) % N
     - Large files → own shard
  4. Assign shard → worker mapping

Parallel analysis pipeline:
  [Shard plan] → N workers (1 writer per shard) → segments

  Each worker:
    1. For each file in assigned shard:
       Parse file → AST → extract nodes + edges
    2. Accumulate in write buffer
    3. Flush as single immutable segment per shard
    4. Bloom filter built at flush time

Result: ~100-300 well-sized segments (not 2500 tiny ones).
Compaction between phases often unnecessary — shards already optimal.
Workers are independent — no shared state, embarrassingly parallel.
```

### 5.2. Enrichment (cross-file edges)

```
Enricher contract (new):

  Selector (declarative, orchestrator owns):
    inputs: [{ type: 'http:request', role: 'request' },
             { type: 'http:route', role: 'route' }]

  Processor (pure logic, plugin owns):
    process(inputs) → { edges: [...] }
    // No addEdge calls — returns edges to orchestrator

  Orchestrator:
    Full run:        collect ALL matching nodes → process → write with _owner
    Incremental run: collect ONLY changed nodes → process → write with _owner

Two enricher types:
  Join:      2+ node types, pairwise matching (HTTPConnectionEnricher)
  Traversal: seed nodes + read-only graph access (MountPointResolver)
```

### 5.3. Re-analysis (incremental update)

```
File src/controllers/auth/login.ts changed:

  1. Re-analyze file → new_nodes, new_edges
  2. Compute delta:
     - delta_nodes = diff(old_nodes, new_nodes)
     - delta_edges = diff(old_edges, new_edges)
  3. If delta == ∅ → done (file touched but nothing changed)
  4. Write tombstone segment for old data
  5. Write new segment with new data
  6. Atomic manifest swap
  7. Incremental re-enrichment:
     a. affected_ids = endpoints(delta_nodes ∪ delta_edges)
     b. Find enrichers where input_types ∩ types(affected) ≠ ∅
     c. DELETE enrichment edges where (src OR dst) IN affected_ids
     d. Re-enrich ONLY affected_ids
     e. Propagate transitively (with depth limit)
  8. Background compaction cleans tombstones
```

---

## 6. Resource Management

### 6.1. Adaptive resource budgeting

```
ResourceManager monitors: available_ram, cpu_count, disk_io

┌─────────────────┬──────────────┬───────────────┬──────────────┐
│ Parameter       │ Low (8 GB)   │ Med (64 GB)   │ High (512 GB)│
├─────────────────┼──────────────┼───────────────┼──────────────┤
│ Write buffer    │ 16 MB        │ 128 MB        │ 1 GB         │
│ Shard threshold │ 1K nodes     │ 10K nodes     │ 100K nodes   │
│ Compaction thrs │ 1            │ CPU/4         │ CPU/2        │
│ Prefetch        │ none (mmap)  │ moderate      │ aggressive   │
│ Global index    │ mmap         │ mmap          │ RAM          │
│ Bloom filters   │ RAM (~2 MB)  │ RAM (~2 MB)   │ RAM (~2 MB)  │
└─────────────────┴──────────────┴───────────────┴──────────────┘

Плавная деградация: больше RAM → больше batch → меньше I/O → быстрее.
Нет cliff — производительность падает пропорционально, не обрывом.
```

### 6.2. CPU parallelism

```
Embarrassingly parallel:
  - Analysis:   file → segment (no shared state)
  - Query scan: each shard independently
  - Compaction:  each shard independently
  - Adjacency:  partition by source node hash

Needs coordination:
  - Cross-shard enrichment (dependency between shards)
  - Manifest update (single writer, but fast)

Implementation: rayon (data parallelism) + crossbeam channels (pipeline)

Pipeline:
  [File Queue] → N workers (analysis) → [Segment Queue] → M workers (compaction)
                                                         → K workers (query serving)
```

---

## 7. Sharding for Scale

### 7.1. Single-machine sharding (default)

Directory-based sharding on one machine. Shards = directories.
All queries local. Good up to ~500M nodes.

### 7.2. Multi-machine sharding (out of scope)

Графы такого масштаба (~5B+ nodes) — за горизонтом текущей версии.
При необходимости: shard assignment по directory prefix → machine, coordinator для cross-machine queries. Будет медленнее из-за network latency. Не приоритет.

---

## 8. Lifecycle Phases

**Batch mode** (full analysis):
```
INDEXING → shard plan
  ↓
ANALYSIS (parallel, write-heavy)
  → ~100-300 well-sized segments (shard plan = no tiny segments)
  ↓
COMPACT + build adjacency index (optional, if needed)
  ↓
ENRICHMENT (sequential, query-heavy)
  → virtual shards for enrichment edges
  ↓
COMPACT (optional)
  ↓
VALIDATION (query-heavy)
  ↓
QUERY (interactive, read-only)
  ← background compaction continues
```

**Realtime mode** (watch / single file re-analysis):
```
File changed
  ↓
RE-ANALYSIS → tombstones + new segment in shard
  ↓
INCREMENTAL RE-ENRICHMENT → affected nodes only
  ↓
QUERY immediately (L0 scan, skip tombstones)
  ← background compaction cleans up later
```

---

## 9. Data Formats

### 9.1. Node record

```
NodeRecord:
  id:       u128          # blake3(semanticId)
  type:     u16           # enum (FUNCTION=1, VARIABLE=2, ...)
  name:     String        # human-readable name
  file:     String        # source file path (relative)
  metadata: JSON          # plugin-specific data
  owner:    String        # shard path (directory or __enrichment__/X)
```

### 9.2. Edge record

```
EdgeRecord:
  src:      u128          # source node ID
  dst:      u128          # destination node ID
  type:     u16           # enum (CALLS=1, IMPORTS=2, ...)
  metadata: JSON          # plugin-specific data
  _owner:   String        # enricher name (for enrichment edges)
```

### 9.3. Manifest

```json
{
  "version": 42,
  "created_at": "2026-02-11T12:00:00Z",
  "shards": {
    "src/controllers/auth/": {
      "segments": [
        {
          "file": "nodes_v3.seg",
          "level": 1,
          "record_count": 520,
          "node_types": ["FUNCTION", "VARIABLE", "CALL"],
          "bloom_filter_offset": 8192,
          "has_inverted_index": true
        }
      ],
      "tombstones": ["nodes_v1.tombstones"]
    },
    "__enrichment__/http-connections/": {
      "segments": [
        {
          "file": "edges_v1.seg",
          "level": 0,
          "record_count": 340,
          "edge_types": ["INTERACTS_WITH"],
          "depends_on_node_types": ["http:request", "http:route"]
        }
      ]
    }
  },
  "global_index_version": 41,
  "compaction_state": {
    "pending_shards": ["src/utils/"],
    "last_compaction": "2026-02-11T11:50:00Z"
  }
}
```

---

## 10. Key Design Decisions

| Решение | Выбор | Почему |
|---------|-------|--------|
| Storage model | LSM-tree with immutable segments | Write-optimized → read-optimized transition |
| Partitioning | Directory-based shards | Files in same dir are tightly coupled |
| Shard sizing | Adaptive split/merge by node count | Resource-aware, threshold depends on RAM |
| Columnar vs row | Columnar | Filtering queries scan 1-2 columns, not full records |
| String storage | Per-segment string table | Locality for attribute search |
| Point lookup | Bloom filter (L0) → Global mmap index (L1+) | Zero overhead on write path |
| Attr search | Columnar scan (L0) → Inverted index (L1+) | Index cost paid only at compaction |
| Adjacency | Same LSM in shards, not separate layer | One infrastructure for everything |
| Incremental | Tombstones + new segments + delta-based re-enrichment | O(changed) not O(total) |
| Enrichment | Virtual shards per enricher + _owner tracking | Clean ownership, surgical invalidation |
| Enricher contract | Selector/Processor split | Orchestrator controls incremental, plugin has pure logic |
| WAL | None | Re-analyze = recovery |
| Resource mgmt | Adaptive budgeting per available RAM/CPU | Graceful degradation, no cliff |
| Parallelism | rayon + crossbeam pipeline | Embarrassingly parallel per shard |

---

## 11. What's NOT Covered (Future Work)

1. **Orchestrator redesign** — full incremental enrichment pipeline (separate research)
2. **Multi-machine sharding** — coordinator, network protocol, consistency
3. **Concurrent writers** — multiple analysis processes writing to same shard
4. **Segment format spec** — exact binary layout, alignment, compression
5. **Compaction scheduling** — when to trigger, priority, resource limits
6. **Monitoring / observability** — metrics, health checks, compaction progress
7. **Migration path** — how to get from RFDB v1 to v2 incrementally
