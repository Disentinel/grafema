# RFDB v2 Architecture Research

> Дата: 2026-02-10
> Участники: Вадим, Claude
> Linear issues: REG-404 (flush performance), REG-405 (memory 20GB)

---

## 1. Проблема: текущая архитектура RFDB не масштабируется

### Измерения на реальном проекте (2500 файлов)

- 1.3M nodes, 9.3M edges
- **20 GB RAM** при анализе
- Flush: 5 минут (из-за swap thrashing)
- На диске: nodes.bin ~117 MB, edges.bin ~495 MB

### Архитектура памяти (текущая)

```
GraphEngine {
    // ✅ На диске (mmap) — ОК
    nodes_segment: mmap(nodes.bin)
    edges_segment: mmap(edges.bin)

    // ⚠️ Временные — "очищаются" при flush (но capacity сохраняется!)
    delta_log: Vec<Delta>                    // O(ops) — ДУБЛЬ delta_nodes/edges
    delta_nodes: HashMap<u128, NodeRecord>   // O(new_nodes)
    delta_edges: Vec<EdgeRecord>             // O(new_edges)

    // 🔴 ВСЕГДА В RAM, масштабируются с ПОЛНЫМ графом
    adjacency: HashMap<u128, Vec<usize>>         // O(total_edges)
    reverse_adjacency: HashMap<u128, Vec<usize>> // O(total_edges)
    index_set.id_index: HashMap<u128, usize>     // O(total_nodes)
    index_set.type_index: HashMap<String, Vec<usize>>  // O(total_nodes)
    index_set.file_index: HashMap<String, Vec<usize>>  // O(total_nodes)
}
```

### 4 корневые причины потребления 20 GB

**1. Двойное хранение: delta_log дублирует delta_nodes/delta_edges**

```rust
// engine.rs:698-699 — каждый node клонируется ДВАЖДЫ
fn add_nodes(&mut self, nodes: Vec<NodeRecord>) {
    for node in nodes {
        self.delta_log.push(Delta::AddNode(node.clone()));  // CLONE #1
        self.apply_delta(&Delta::AddNode(node));             // inside: node.clone() → CLONE #2
    }
}
```

delta_log нигде не используется для чтения — только при flush, но delta_nodes/delta_edges уже содержат те же данные.

**2. Metadata strings огромные и избыточные**

Средний metadata per node: ~300-400 bytes JSON:
```json
{"originalId":"FUNCTION->handleAuth->AuthController->module->src/controllers/auth/AuthController.ts",
 "line":45,"column":2,"async":true,"generator":false,"arrowFunction":false,
 "isMethod":true,"isClassMethod":true,"params":["req","res","next"]}
```

Средний metadata per edge: ~250-300 bytes (ДВА originalId):
```json
{"_origSrc":"FUNCTION->handleAuth->...","_origDst":"FUNCTION->processOrder->...",
 "argIndex":0}
```

`originalId` дублирует info из id/name/file. `_origSrc/_origDst` дублируют src/dst.
~30-40% metadata — мусор.

**3. Vec::clear() не освобождает память**

```rust
self.delta_log.clear();      // len=0, capacity=10.6M → ~5 GB retained
self.delta_nodes.clear();    // entries=0, table=2M buckets → ~1 GB retained
self.delta_edges.clear();    // len=0, capacity=9.3M → ~4.5 GB retained
```

Rust `Vec::clear()` зануляет length, но сохраняет allocated capacity. Нужно `= Vec::new()`.

**4. Flush = полная материализация в RAM (Catch-22)**

```rust
let mut all_nodes = Vec::new();  // Clone #3: ВСЕ segment + delta → heap
let mut all_edges = Vec::new();  // Clone #3: ВСЕ segment + delta → heap
```

Нельзя flush при нехватке памяти — flush сам требует O(полный_граф) RAM.

### Расчёт памяти (1.3M nodes, 9.3M edges)

| Компонент | Per-record | Records | ×copies | Итого |
|-----------|-----------|---------|---------|-------|
| Nodes (delta_log + delta_nodes) | ~680B | 1.3M | ×2 | **1.77 GB** |
| Edges (delta_log + delta_edges) | ~470B | 9.3M | ×2 | **8.74 GB** |
| adjacency + reverse_adj | ~24B/edge | 9.3M | ×1 | **0.45 GB** |
| HashMap overhead + fragmentation | | | | **~0.5 GB** |
| **Pre-flush** | | | | **~11.5 GB** |

Пик при flush (+all_nodes +all_edges +StringTable): **~17 GB**
С аллокатором (fragmentation ~15-20%): **~20 GB**

### Post-flush: indexes масштабируются с ПОЛНЫМ графом

| Scale | Nodes | Edges | Post-flush RAM |
|-------|-------|-------|----------------|
| 2.5K файлов | 1.3M | 9.3M | ~500 MB (+ retained capacity) |
| 100K файлов | ~50M | ~350M | ~20 GB |
| 1B файлов | ~5B | ~35B | ~2 TB |

### Flush pipeline (текущий, однопоточный)

| Этап | Что делает | Данные | Время (SSD) |
|------|-----------|--------|-------------|
| 1. Collect nodes | Clone segment+delta | ~260 MB alloc | CPU |
| 2. Collect edges | Clone segment+delta | ~1.4 GB alloc | CPU |
| 3. Build StringTable | 9.3M HashMap lookups ×2 | CPU-bound | ~5-10 sec |
| 4. Write nodes.bin | 117 MB BufWriter | I/O | 0.06 sec |
| 5. Write edges.bin | 495 MB BufWriter | I/O | 0.25 sec |
| 6. Rebuild adjacency | 9.3M HashMap::insert | ~150 MB | CPU |
| 7. Rebuild reverse_adj | 9.3M HashMap::insert | ~150 MB | CPU |
| 8. Rebuild index_set | Scan all nodes | CPU+mmap | CPU |

rayon есть в Cargo.toml, но нигде не используется.

---

## 2. Фазы жизни графа Grafema

| Фаза | Паттерн | Приоритет |
|-------|---------|-----------|
| **1. Analysis** (файл → ноды/эджи) | Heavy write, batch, per-file | Write throughput |
| **2. Enrichment** (кросс-файловые связи) | Read many + write few, random access | Read by type/file + write |
| **3. Query** (MCP/CLI/GUI) | Read-only, random traversal | Read latency, adjacency |
| **4. Re-analysis** (изменился 1 файл) | Delete old + write new, per-file | Incremental update |

Текущий RFDB обслуживает все фазы одной структурой — корень проблемы.

---

## 3. Требования к RFDB v2

1. **Immediate queryability** — ноды/эджи доступны для запросов сразу после insert, без flush
2. **O(1) RAM** — RAM не зависит от размера графа, растёт только диск
3. **Incremental updates** — удалить/обновить данные одного файла без перезаписи всего
4. **Fast adjacency** — `neighbors(nodeId)` и `reverse_neighbors(nodeId)` за O(k)
5. **Type/file queries** — получить все ноды типа X или из файла Y за O(k)
6. **Attr search** — основная фича, поиск по metadata полям (object, method, etc.)

---

## 4. Мировой опыт: edge ownership и incremental updates

### Статические анализаторы (closest prior art)

| Система | Подход к инкрементальности |
|---------|--------------------------|
| **Sourcetrail** | SQLite, `DELETE FROM edges WHERE source_file_id = X`. Edges owned by файл с call site. |
| **CodeQL** | TRAP file per source → full rebuild (no real incremental). Research: iQL (2023) — diff relational tuples. |
| **Joern** | OverflowDB → flatgraph. Hash-based invalidation. In-memory, not O(1) RAM. |

### Graph databases

| Система | Архитектура | Применимость |
|---------|------------|-------------|
| **Neo4j** | Fixed-size records, doubly-linked edge lists. Нет source partitioning. | Не подходит |
| **NebulaGraph** | RocksDB, key = `[src][edge_type][dst]`. Edges stored ×2 (forward+reverse). | Ключевой паттерн |
| **TerminusDB** | Immutable layers, succinct data structures, 13.57 bytes/triple. | Идея layers |
| **DGraph** | Badger (LSM), RDF triples. Нет source partitioning. | Не подходит |

### Social graph systems

| Система | Ключевой паттерн |
|---------|-----------------|
| **Facebook TAO** | Edge хранится на шарде source node. Inverse edges — автоматически. |
| **LinkedIn LIquid** | Hash-based indexes (2-3 L3 cache misses). Fully in-memory. |

### Research

| Система | Ключевая идея |
|---------|--------------|
| **STINGER** | Blocked typed edge lists — edges grouped by type in contiguous memory |
| **LiveGraph** (VLDB 2020) | Transactional Edge Log в mmap, sequential adjacency scans |
| **BACH** (VLDB 2025) | LSM-tree: upper levels = adjacency list (write-friendly), lower levels = CSR (read-friendly) |
| **RDF Named Graphs** | `DROP GRAPH file:X` — удаляет все триплы графа. Прямой аналог нашей задачи. |

### Единогласный ответ: **source-tagged edges**

Все системы используют: каждый edge несёт `owner_file_id`. Re-analysis = `delete all where owner = file_X` + insert new.

Кросс-файловые edges: owner = файл, создавший edge (файл с call site, import statement).
Стабильные ID (BLAKE3 deterministic) решают проблему dangling references.

---

## 5. Columnar format

### Почему columnar — правильный выбор

Запросы RFDB — фильтрация: "найди все ноды типа FUNCTION в файле X".
Сканирует 1-2 колонки (4 bytes/node), не тянет полные записи (200+ bytes/node).

Query pattern из `find_by_attr()`:
1. IndexSet даёт candidate set K (O(1))
2. Scan candidates по каждой колонке (O(K))
3. Return IDs

Columnar + IndexSet = идеальная комбинация. Row-oriented не даёт выигрыша.

### String table

Отдельная глобальная string table = random access за каждой строкой = убийство attr search.
**Strings должны быть встроены в segment** (per-segment string table, как сейчас).

---

## 6. Apache Iceberg — архитектурное вдохновение

### Архитектура Iceberg

```
Catalog (atomic pointer to current metadata.json)
  └── metadata.json (schema, partition spec, snapshot history)
        └── Snapshot N (manifest-list-N.avro)
              ├── Manifest 1 (data files + stats: min/max per column, row count)
              │     ├── data-file-001.parquet  (IMMUTABLE)
              │     └── data-file-002.parquet
              └── Delete manifest
                    ├── delete-file-001 (position deletes)
                    └── delete-file-002 (equality deletes)
```

### Ключевые принципы Iceberg

1. **Data files иммутабельны** — никогда не перезаписываются
2. **Manifest знает статистики** — query planner пропускает нерелевантные файлы
3. **Write = create new files + new manifest + atomic pointer swap**
4. **Delete = отдельный delete file**, не tombstone в data file
5. **Compaction = background rewrite** — merge, apply deletes. Readers не блокируются.

### Mapping Iceberg → RFDB v2

| Iceberg | RFDB v2 |
|---------|---------|
| Data file (Parquet) | Segment (nodes/edges columnar) |
| Partition by date/region | **Partition by owner_file** |
| Manifest (file stats) | Segment registry (stats per segment) |
| Manifest list (snapshot) | Graph snapshot |
| Position delete file | Deletion bitmap per segment |
| Equality delete | `DELETE WHERE owner_file = X` |
| Compaction | Background segment merge |
| Catalog atomic swap | `current.json` → atomic rename |

### Что берём из Iceberg

1. **Immutable segments** — никогда не перезаписывать, только создавать новые
2. **Manifest со статистиками** — знаем что в каждом segment без его чтения
3. **Snapshot isolation** — atomic swap, readers не блокируются
4. **Partition by owner** — delete = drop partition
5. **Background compaction** — merge мелких файлов

### Что отличает нас от Iceberg

| Iceberg (analytics) | RFDB (graph) |
|---------------------|--------------|
| Sequential scan миллиардов строк | **Point queries** (get node by ID) |
| Нет adjacency | **Adjacency — ключевая операция** |
| Partition pruning по range | Partition pruning по **type + file** |
| Row groups ~128MB | Segments ~100KB-1MB per file |
| S3 (no mmap, high latency) | **Local FS (mmap, low latency)** |

### Что добавляем сверх Iceberg

1. **Adjacency layer** — sorted mmap files для forward/reverse neighbor queries
2. **Point query index** — node ID → (segment, offset), bloom filter per segment
3. **Columnar с встроенным StringTable** — оптимизирован под graph nodes

---

## 7. LSM-tree: write-optimized ↔ read-optimized

### Идея

Не копируем Iceberg, а берём ключевой принцип LSM-tree: **непрерывный спектр** между write-heavy и read-heavy режимами. База сама решает когда оптимизировать.

### Как работает LSM-tree

```
Write path:
  1. Insert → MemTable (in-memory sorted structure, напр. skiplist)
  2. MemTable полный → flush на диск как SSTable (Sorted String Table) → Level 0
  3. Level 0 накопился → compact (merge-sort) → Level 1
  4. Level 1 накопился → compact → Level 2
  ...

Read path:
  1. Проверить MemTable (RAM) — O(log n)
  2. Проверить Level 0 SSTables — может быть несколько, overlapping
  3. Проверить Level 1, 2, ... — каждый уровень sorted, binary search
  4. Bloom filter per SSTable — skip если точно нет нужного ключа
```

**Write быстрый:** всё sequential — append в лог, flush = sequential write. Нет random I/O.

**Read медленнее:** worst case = проверить все уровни. Bloom filters + sorted levels снижают до 1-2 disk reads обычно.

**Compaction** — переход write-optimized → read-optimized:
- Без compaction: много мелких файлов, read дорогой
- После compaction: меньше крупных файлов, read быстрый
- В фоне, не блокирует ни reads ни writes

### Mapping LSM → RFDB v2

| LSM концепт | RFDB v2 |
|-------------|---------|
| MemTable | Write buffer (текущий batch нод/эджей) |
| SSTable Level 0 | Свежие per-shard сегменты (unsorted, fast write) |
| SSTable Level 1+ | Merged shard сегменты (sorted columnar, fast read) |
| Compaction | Shard merge: мелкие сегменты → крупный sorted сегмент |
| Bloom filter | Per-segment node ID filter |

### Resource-adaptive batching

Окно батчинга завязано на доступные ресурсы:

```
ResourceManager:
  available_ram = system_ram - used_ram

  if available_ram > 4 GB:
    write_buffer_size = 1 GB       # большой MemTable, редкие flushes
    compaction_threads = CPU / 2
    prefetch = aggressive
  elif available_ram > 512 MB:
    write_buffer_size = 128 MB     # средний MemTable
    compaction_threads = 2
    prefetch = moderate
  else:
    write_buffer_size = 16 MB      # маленький, частые flushes на диск
    compaction_threads = 1
    prefetch = none, rely on mmap
```

Больше RAM → больше batch → меньше I/O → быстрее.
Меньше RAM → мелкие batch → больше I/O но не OOM.

### CPU параллелизм

`rayon` (уже в Cargo.toml) даёт data parallelism. Хорошо параллелятся:

- **Analysis** (файл → сегмент) — embarrassingly parallel, нет shared state
- **Query scan** (каждый сегмент независимо) — embarrassingly parallel
- **Compaction** (каждый shard независимо) — embarrassingly parallel
- **Adjacency build** (partition by source node hash) — parallel merge-sort

Плохо параллелятся:
- Cross-shard enrichment — зависимости между шардами
- Manifest update — single writer (но быстрый)

Processing pipeline:
```
[File Queue] → N workers (analysis) → [Segment Queue] → M workers (compaction)
                                                       → K workers (query serving)
```

---

## 8. Индексная архитектура

### Три паттерна поиска

| Паттерн | Пример | Требование |
|---------|--------|-----------|
| Point lookup | `getNode(semanticId)` | O(1), по hash u128 |
| Attribute search | `queryNodes({type: "FUNCTION", name: "handleAuth"})` | Exact match по полям |
| Substring search | `queryNodes({name: contains("auth")})` | Поиск подстроки |

### 1. Point lookup: SemanticID → node

SemanticID = deterministic u128 hash (BLAKE3). Классический key-value lookup.

**Два режима (write → read optimized):**

| | Bloom filter only | + Global index |
|---|---|---|
| Когда | Write-heavy (Level 0, свежие сегменты) | Read-heavy (post-compaction) |
| RAM | ~1.6 MB (весь граф 1.3M нод) | +31 MB |
| Point lookup | ~микросекунды | ~наносекунды |
| Строится | Сразу при записи | В фоне при compaction |

**Bloom filter** — вероятностная структура, 10 bits/key = 1% false positive rate.
Для сегмента 1000 нод = 1.2 KB. Ответ: "точно нет" (skip segment) или "может быть" (check segment).

```
getNode(0xAB12):
  for segment in segments:
    if !segment.bloom.may_contain(0xAB12):
      continue                      # skip, 0 I/O (наносекунды)
    return segment.binary_search(0xAB12)  # O(log k)
```

**Global index** (после compaction):
```
sorted array in mmap: [(node_id, segment_id, offset)]
1.3M нод × 24 bytes = 31 MB

getNode(0xAB12):
  binary_search(global_index, 0xAB12) → segment_42, offset 17  # O(log N), ~20 comparisons
```

### 2. Attribute search: per-segment inverted index

**Inverted index** = отображение term → list of offsets (posting list).

```
Segment shard_auth.seg:
  columns:
    id:   [0xAB12, 0xCD34, 0xEF56, ...]
    type: [FUNCTION, VARIABLE, CALL, ...]
    name: [handleAuth, token, handleAuth(), ...]

  inverted_index:
    name:
      "handleAuth" → [0, 2]     # offsets в columns
      "token"      → [1]
    type:
      "FUNCTION"   → [0]
      "VARIABLE"   → [1]
      "CALL"       → [2]
```

**Query flow:**
```
queryNodes({type: "FUNCTION", name: "handleAuth"}):
  1. Manifest stats: какие сегменты содержат type=FUNCTION?
     → skip нерелевантные сегменты
  2. Per-segment inverted index:
     → type["FUNCTION"] ∩ name["handleAuth"] = [0]
  3. Load full record at offset [0]
```

**Tradeoff inverted index:**
- Cost: write amplification (+5 записей/нода), +20-40% storage, дорогой merge при compaction
- Benefit: O(1) exact match vs O(n) scan, intersection для multi-field queries

**Ключевое решение: inverted index строить только при compaction (Level 1+).**

На Level 0 (свежие сегменты, 500-2000 нод):
- Name column ~10-40 KB → целиком в L1 cache
- Columnar scan = микросекунды, inverted index не нужен
- Write path: ноль overhead от индексов

На Level 1+ (compacted, 50-100K+ нод):
- Inverted index строится в фоне при compaction
- Read path: O(1) через index

### 3. Substring/prefix search

Для exact match — inverted index. Для подстроки — дополнительно:

**Опции:**
- **Trigram index** (как PostgreSQL pg_trgm): "handleAuth" → trigrams ["han","and","ndl",...], intersection сужает candidates, verify exact
- **FST (Finite State Transducer)** — Tantivy/Lucene подход, Rust крейт `fst`. Compact term dictionary, prefix/fuzzy
- **MVP: columnar scan + SIMD** — name column компактна, SIMD scan 1000 строк = микросекунды. Trigram/FST добавить позже

### 4. Metadata search

`queryNodes({metadata.async: true})` — поиск по вложенным полям metadata JSON.

Те же опции: columnar scan для мелких сегментов, inverted index по promoted metadata fields при compaction.

### Итого: индексная архитектура per-segment

```
Per-segment:
  ├── bloom_filter          # point lookup: ID in segment? O(1), строится СРАЗУ
  ├── sorted_id_column      # point lookup: binary search O(log k)
  ├── columnar_data         # attr search: scan для мелких сегментов
  └── (post-compaction):
      ├── inverted_index    # exact attr search: term → offsets O(1)
      │   ├── by_type
      │   ├── by_name
      │   └── by_file
      └── trigram_index     # substring search (optional, later)

Global (post-compaction):
  ├── id_index (mmap)       # node_id → (segment, offset), 31 MB for 1.3M nodes
  └── manifest stats        # query planning: skip irrelevant segments
```

**Rust libraries:** `fst` (FST), `tantivy` (search components), `bitvec` (bitmaps), `blake3` (hashing)

---

## 9. Предложение: RFDB v2 Architecture

### Storage layout

```
.rfdb/
├── current.json                    # Atomic pointer → latest snapshot
│
├── snapshots/
│   ├── snap-001.json              # Manifest: list of active segments + stats
│   ├── snap-002.json              # After re-analysis of 1 file
│   └── ...
│
├── segments/
│   ├── nodes/
│   │   ├── owner_{hash1}.seg      # Nodes from src/app.ts (columnar, immutable)
│   │   ├── owner_{hash2}.seg      # Nodes from src/auth.ts
│   │   └── ...
│   └── edges/
│       ├── owner_{hash1}.seg      # Edges owned by src/app.ts
│       ├── owner_{hash2}.seg      # Edges owned by src/auth.ts
│       └── ...
│
│   # Adjacency = НЕ отдельный слой. Edge segments в шардах уже содержат
│   # (src, dst, type). Bloom filter per shard для neighbors() queries.
│   # Tombstones при re-analysis, compaction чистит.
│
└── gc/                            # Deleted segments, pending cleanup
    ├── owner_{hash1}_v1.seg       # Old version, safe to delete after readers finish
    └── ...
```

### Write flow

```
analyzeFile("src/app.ts"):
  1. Write nodes/owner_{hash}.seg   (immutable columnar)
  2. Write edges/owner_{hash}.seg   (immutable columnar)
  3. New snapshot: snap-002 = snap-001 + {add: [hash], remove: [hash_old]}
  4. Atomic rename current.json → snap-002
  5. Old segments → gc/
```

### Delete flow (re-analysis)

```
reanalyzeFile("src/app.ts"):
  1. Mark old owner_{hash} segments as deleted in new snapshot
  2. Create new segments
  3. Rebuild adjacency (only changed edges)
  4. Atomic snapshot swap
  // O(nodes_in_file), NOT O(total_graph)
```

### Query flow

```
queryNodes({type: "FUNCTION", file: "src/app.ts"}):
  1. Read current.json → snapshot
  2. Manifest: owner_{hash}.seg has FUNCTION nodes, file=src/app.ts
  3. mmap segment, scan columnar data
  4. Return results

neighbors(nodeId):
  1. Binary search forward.seg for nodeId
  2. Return matching edges
```

### RAM budget

| Компонент | Размер | Масштабируется с |
|-----------|--------|-----------------|
| Manifest (snapshot JSON) | ~500KB | Segment count |
| Write buffer (current batch) | ~10-50MB | Batch size |
| OS page cache | Auto-managed | Hot data only |
| **Total app RAM** | **<100 MB** | **Ничего** |

---

## 10. Открытые вопросы

### ✅ Enrichment ownership → Виртуальные шарды + incremental re-enrichment

**Решение: enricher = виртуальный шард с ownership tracking.**

Enrichment edges хранятся в виртуальных шардах per enricher:
```
Shards:
  src/controllers/auth/           # analysis shard (реальные файлы)
  src/services/payment/           # analysis shard
  __enrichment__/imports/         # виртуальный shard — ImportExportLinker
  __enrichment__/mount-points/    # виртуальный shard — MountPointResolver
  __enrichment__/http-connections/ # виртуальный shard — HTTPConnectionEnricher
```

Каждый enrichment edge несёт `_owner` = имя enricher-а.

**Incremental re-enrichment при изменении файла:**

```
Re-analysis файла X:
  1. Re-analyze → new_nodes, new_edges
  2. delta = diff(old_nodes + old_edges, new_nodes + new_edges)
  3. if delta == ∅ → done
  4. changed_node_ids = endpoints(delta)
  5. Для каждого enricher у кого depends_on_node_types ∩ типы changed nodes ≠ ∅:
     a. SELECT enrichment edges WHERE (src OR dst) IN changed_node_ids AND _owner = enricher
     b. DELETE эти edges
     c. Re-enrich ТОЛЬКО changed_node_ids (не весь граф!)
  6. Транзитивное распространение: если enrichment создал новые edges →
     их endpoints тоже affected → propagate (с depth limit)
```

**Ключевой принцип:** дельта нод НЕДОСТАТОЧНА. Нужна дельта нод + edges.
Функция с тем же семантическим ID, но изменёнными CALLS edges — затронута.

**Архитектурное изменение enricher контракта (отдельный research):**

Сейчас enricher = монолит (`execute()` сам ищет + сам обрабатывает). Нужна декомпозиция:

**Selector** (декларативный, оркестратор владеет):
```typescript
get inputs(): EnricherInputSpec {
  return {
    sources: [
      { type: 'http:request', role: 'request' },
      { type: 'http:route', role: 'route' },
    ]
  };
}
```

**Processor** (чистая логика, плагин владеет):
```typescript
async process(inputs: GroupedNodes): EnricherOutput {
  // Только логика матчинга, без queryNodes
  // Возвращает edges, НЕ вызывает addEdge напрямую
  return { edges };
}
```

Оркестратор:
- Full run: подаёт ВСЕ ноды matching input types
- Incremental: подаёт ТОЛЬКО changed nodes + counterpart (вторая сторона join)
- Записывает edges с `_owner` tracking

**Два типа enrichers:**

| Тип | Selector | Incremental | Пример |
|-----|----------|-------------|--------|
| **Join** | 2+ node types, матчинг | Тривиален: подать changed × all_other | HTTPConnectionEnricher, ImportExportLinker |
| **Traversal** | seed nodes + graph reader | Оркестратор даёт seeds из дельты | MountPointResolver, ClosureCaptureEnricher |

В обоих случаях enricher НЕ вызывает `addEdge` напрямую — возвращает edges,
оркестратор записывает с ownership. Это даёт полный контроль над инвалидацией.

**TODO:** отдельный research по переосмыслению оркестратора для incremental updates.

### 🟡 Compaction: когда и зачем?

**Вадим**: "Что даёт compaction? Зачем нам более крупные сегменты?"

**Ответ**: Для query performance не критично (mmap + manifest pruning). Но:
- 2500 files × 2 (nodes+edges) = 5000 segments. File descriptors.
- macOS ulimit -n = 256 по умолчанию. Нужно поднимать или lazy mmap.
- Compaction нужен для чистки gc/ (удалённые сегменты) и merge мелких файлов

**Решение**: не приоритет. Blue/green в фоне: build new merged segment → swap in snapshot → delete old. Сначала "просто работает".

### 🟡 Index rebuilds

**Вадим**: "Приоритет — чтобы просто работало. В фоне сервер оптимизирует."

**Решение**: Blue/green подход:
1. Queries работают с текущими indexes (sorted mmap)
2. Background thread строит новые (после compaction)
3. Atomic swap когда готовы

### 🟢 WAL

**Вадим**: "WAL избыточен. Re-analyze = recovery."

**Решение**: нет WAL в v2. Если crash — re-analyze. Segment files immutable, так что partial writes = corrupted segment → удалить и re-analyze тот файл.

### ✅ Adjacency rebuild → LSM в шардах, без отдельного слоя

**Решение:** adjacency не отдельный слой (forward.seg/reverse.seg), а та же шардовая LSM механика.

Edge segments в шардах уже содержат (src, dst, type) — это и есть adjacency data.

**Re-analysis:**
1. Tombstones на удалённые edges в шарде
2. Новый сегмент с новыми edges
3. O(changed_edges), NOT O(total_edges)

**Query `neighbors(nodeId)`:**
1. Bloom filter: в каких шардах могут быть edges с src=nodeId?
2. Scan matching шарды, skip tombstones
3. Return results

**Compaction:** merge шарды, выкинуть tombstones → чистый сегмент, быстрые reads.

Никакого special case — одна инфраструктура (шарды + bloom + LSM + compaction) для всего.

### 🟡 Формат snapshot manifest

Что должен содержать manifest для эффективного query planning:
```json
{
  "version": 42,
  "segments": {
    "nodes/owner_a1b2c3.seg": {
      "owner_file": "src/app.ts",
      "node_count": 520,
      "node_types": ["FUNCTION", "VARIABLE", "CALL", "SCOPE"],
      "has_metadata_fields": ["object", "method", "async"],
      "min_id": "0x001...",
      "max_id": "0xFFF...",
      "created_at": "2026-02-10T12:00:00Z",
      "phase": "analysis"  // or "enrichment"
    }
  },
  "deleted_segments": ["nodes/owner_a1b2c3_v1.seg"],
  "adjacency_version": 41
}
```

### ✅ Small files problem → Ступенчатое шардирование

**Решение: адаптивное directory-based шардирование.**

Shard = директория. Файлы в одной папке тесно связаны (большинство edges — intra-shard), наружу торчит API/interface (немного cross-shard edges).

**Ступенчатый split/merge:**
- Shard слишком большой (>N нод, порог зависит от ресурсов) → split по поддиректориям, вплоть до 1 файла
- Shard слишком маленький (мало нод) → merge с родительской директорией
- Дерево файловой системы = дерево шардов, граница двигается вверх-вниз по дереву
- Операция дешёвая: пересобрать 2 сегмента, обновить manifest

**Threshold адаптивный:**
- Сервер 512 GB RAM → крупные шарды (меньше overhead на boundary edges)
- Ноутбук 8 GB → мелкие шарды (меньше RAM per shard)

**Enrichment edges:**
- Intra-shard enrichment → хранится в сегменте шарда
- Cross-shard enrichment (контроллер → сервис в другой папке) → отдельный boundary edges index, их объективно мало

**Re-analysis:** изменился файл → пересобирается только его shard, остальные не трогаются

**Иерархия:**
```
src/                          # mega-shard (cross-module queries)
├── controllers/auth/         # shard — 15 файлов, тесно связаны
├── controllers/orders/       # shard
├── services/payment/         # shard (большой → может split на подпапки)
└── utils/                    # shard (маленький → может merge вверх)
```

**Query:** `neighbors(nodeId)` → сначала local shard (быстро), потом boundary index для cross-shard edges

---

## 11. Решённые вопросы

| Вопрос | Решение |
|--------|---------|
| Columnar vs row-oriented | **Columnar** — правильный для нашего filtering-based query pattern |
| Global vs per-segment strings | **Per-segment** — locality для attr search |
| WAL | **Нет** — re-analyze = recovery |
| Index rebuild strategy | **Blue/green** в фоне, "просто работает" сначала |
| Edge ownership model | **Source-tagged** (единогласный мировой опыт) |
| Compaction priority | **Низкий** — blue/green в фоне, не блокер |
| Small files / sharding | **Ступенчатое directory-based** — shard=директория, адаптивный split/merge по размеру |
| Write/read mode | **LSM-style** — write-optimized (append) → read-optimized (sorted+indexed) через background compaction |
| Индексы: когда строить | **Bloom filter сразу** (дёшево), **inverted index при compaction** (дорого, в фоне) |
| Point lookup | **Bloom filter (L0)** → **Global mmap index (post-compaction)** |
| Attr search | **Columnar scan (мелкие сегменты)** → **inverted index (compacted)** |
| Resource management | **Adaptive** — write buffer, compaction threads, prefetch завязаны на available RAM/CPU |
| Adjacency | **LSM в шардах** — не отдельный слой, edges в шардах с bloom + tombstones при re-analysis + compaction |
| Enrichment ownership | **Виртуальные шарды** per enricher + `_owner` на edges + incremental re-enrichment по дельте |
| Enricher контракт | **Selector/Processor split** — оркестратор фильтрует, enricher обрабатывает, не вызывает addEdge напрямую |

---

## 12. Ссылки

### Статические анализаторы
- [Incrementalizing Production CodeQL (ESEC/FSE 2023)](https://arxiv.org/pdf/2308.09660)
- [SourcetrailDB](https://github.com/CoatiSoftware/SourcetrailDB)
- [Flatgraph (Joern successor to OverflowDB)](https://github.com/joernio/flatgraph)

### Graph databases
- [NebulaGraph Storage Format v2.0](https://www.nebula-graph.io/posts/storage-format-in-nebula-graph-2.0)
- [TerminusDB Succinct Data Structures](https://terminusdb.com/blog/succinct-data-structures-for-modern-databases/)

### Social graph systems
- [TAO: Facebook's Distributed Data Store (USENIX)](https://www.usenix.org/system/files/conference/atc13/atc13-bronson.pdf)
- [LIquid: LinkedIn's Graph Database](https://www.linkedin.com/blog/engineering/graph-systems/liquid-the-soul-of-a-new-graph-database-part-1)

### Research
- [LiveGraph (VLDB 2020)](https://vldb.org/pvldb/vol13/p1020-zhu.pdf)
- [BACH: LSM-Tree Graph Storage (VLDB 2025)](https://www.vldb.org/pvldb/vol18/p1509-miao.pdf)
- [STINGER: Streaming Graph Data Structure](https://ieee-hpec.org/2012/index_htm_files/ediger.pdf)

### Table formats (Iceberg-like)
- [Apache Iceberg Spec](https://iceberg.apache.org/spec/)
- [Iceberg Metadata Explained](https://olake.io/blog/2025/10/03/iceberg-metadata/)
- [Iceberg vs Delta Lake vs Hudi](https://www.onehouse.ai/blog/apache-hudi-vs-delta-lake-vs-apache-iceberg-lakehouse-feature-comparison)
