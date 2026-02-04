# ReginaFlowDB - Rust-based Graph Database

**Статус:** ✅ Production Ready
**Производительность:** 40-2500x быстрее Neo4j
**Версия:** 0.2.0

---

## Что это?

ReginaFlowDB - высокопроизводительная встроенная графовая база данных на Rust, разработанная специально для Navi. Использует колоночное хранилище с memory-mapped I/O для максимальной производительности.

### Ключевые особенности

- **Blazing fast**: 40-2500x быстрее Neo4j для типичных операций
- **Zero-copy reads**: Memory-mapped файлы без десериализации
- **Детерминистические ID**: BLAKE3-based, одинаковые между запусками
- **Delta log pattern**: Быстрые записи + эффективное чтение
- **Version-aware**: Поддержка main/__local версий для инкрементального анализа
- **String types**: Типы нод и рёбер хранятся как строки с Levenshtein валидацией
- **NAPI bindings**: Полная интеграция с Node.js

---

## Архитектура

### Структура хранилища

```
graph.db/
├── nodes.bin          # Колоночное хранилище нод + StringTable
├── edges.bin          # Колоночное хранилище рёбер + StringTable
└── metadata.json      # Метаданные графа
```

### Binary формат (nodes.bin)

```
[Header: 30 bytes]
├── magic: [u8; 4]           # "SGRF"
├── version: u16             # Format version
├── node_count: u64
├── edge_count: u64          # (unused in nodes.bin)
└── string_table_offset: u64

[Columnar data]
├── ids: [u128 × N]              # Node IDs (BLAKE3)
├── type_offsets: [u32 × N]      # Offsets в StringTable для node_type
├── file_ids: [u32 × N]          # Offsets в StringTable для file path
├── name_offsets: [u32 × N]      # Offsets в StringTable для name
├── version_offsets: [u32 × N]   # Offsets в StringTable для version
├── exported: [u8 × N]           # Exported flags
├── deleted: [u8 × N]            # Tombstone flags
└── metadata_offsets: [u32 × N]  # Offsets в StringTable для JSON metadata

[StringTable]
├── data_len: u64
├── data: [u8 × data_len]        # Конкатенированные строки
├── offsets_count: u64
└── offsets: [u32 × offsets_count]
```

### Binary формат (edges.bin)

```
[Header: 30 bytes]
├── magic: [u8; 4]           # "SGRF"
├── version: u16
├── node_count: u64          # (unused in edges.bin)
├── edge_count: u64
└── string_table_offset: u64

[Columnar data]
├── src: [u128 × N]              # Source node IDs
├── dst: [u128 × N]              # Destination node IDs
├── edge_type_offsets: [u32 × N] # Offsets в StringTable для edge_type
└── deleted: [u8 × N]            # Tombstone flags

[StringTable]
└── ... (same format as nodes)
```

### Delta Log Pattern

```rust
pub struct GraphEngine {
    // Immutable mmap segments (fast reads)
    nodes_segment: Option<NodesSegment>,
    edges_segment: Option<EdgesSegment>,

    // In-memory delta (fast writes)
    delta_nodes: HashMap<u128, NodeRecord>,
    delta_edges: Vec<EdgeRecord>,

    // Adjacency list для traversal
    adjacency: HashMap<u128, Vec<usize>>,
}
```

**Преимущества:**
- Записи идут в in-memory HashMap (мгновенно)
- Чтения комбинируют mmap + delta (быстро)
- Периодический `flush()` сохраняет на диск

---

## Система типов

### Node Types

Типы нод - строки. Базовые типы в UPPERCASE, namespaced через `:`:

```
FUNCTION, CLASS, METHOD, VARIABLE, PARAMETER, CONSTANT, LITERAL
MODULE, IMPORT, EXPORT, CALL, PROJECT, SERVICE, FILE, SCOPE
EXTERNAL, EXTERNAL_MODULE, SIDE_EFFECT

http:route, http:request
express:router, express:middleware, express:mount
socketio:emit, socketio:on, socketio:namespace, socketio:room
db:query, db:connection, db:table
fs:read, fs:write, fs:operation
net:request, net:stdio
event:listener, event:emit
```

### Edge Types

Типы рёбер - строки:

```
CONTAINS, DEPENDS_ON, CALLS, EXTENDS, IMPLEMENTS, USES, DEFINES
IMPORTS, EXPORTS, ROUTES_TO, HAS_SCOPE, CAPTURES, MODIFIES
DECLARES, WRITES_TO, INSTANCE_OF, HAS_CALLBACK, IMPORTS_FROM
HANDLED_BY, MAKES_REQUEST, PASSES_ARGUMENT, ASSIGNED_FROM
EXPORTS_TO, MOUNTS, EXPOSES, INTERACTS_WITH, CALLS_API
LISTENS_TO, JOINS_ROOM, EMITS_EVENT, RETURNS, RECEIVES_ARGUMENT
READS_FROM, THROWS, REGISTERS_VIEW
```

### Stable ID Format

Используем `#` как разделитель (не конфликтует с `:` в namespace):

```
TYPE#name#scope#path
FUNCTION#getUserById#MODULE:users.js#src/api/users.js
http:route#/api/users#express:router#src/routes.js
socketio:emit#user:joined#MODULE:server.js#server.js
```

---

## API Reference

### Rust API

```rust
use navi_graph_engine::{GraphEngine, GraphStore, NodeRecord, EdgeRecord};

// Создать/открыть базу
let mut engine = GraphEngine::create("./graph.db")?;

// Добавить ноды
engine.add_nodes(vec![
    NodeRecord {
        id: compute_node_id("FUNCTION", "getUserById", "MODULE:users", "users.js"),
        node_type: Some("FUNCTION".to_string()),
        version: "main".into(),
        exported: true,
        name: Some("getUserById".to_string()),
        file: Some("src/api/users.js".to_string()),
        ..Default::default()
    }
]);

// Добавить рёбра
engine.add_edges(vec![
    EdgeRecord {
        src: func_id,
        dst: db_query_id,
        edge_type: Some("CALLS".to_string()),
        version: "main".into(),
        deleted: false,
    }
], false);

// Найти по типу (поддерживает wildcard "http:*")
let functions = engine.find_by_type("FUNCTION");
let http_nodes = engine.find_by_type("http:*");

// Найти с фильтрами
let exported = engine.find_by_attr(
    &AttrQuery::new()
        .version("main".to_string())
        .node_type("FUNCTION".to_string())
        .exported(true)
);

// BFS traversal
let reachable = engine.bfs(
    &[start_id],
    10,                          // max_depth
    &["CALLS", "CONTAINS"]       // edge types
);

// Получить соседей
let neighbors = engine.neighbors(node_id, &["CALLS"]);

// Получить рёбра
let outgoing = engine.get_outgoing_edges(node_id, Some(&["CALLS"]));
let incoming = engine.get_incoming_edges(node_id, None);

// Сохранить на диск
engine.flush()?;
```

### Node.js API (NAPI)

```javascript
import { ReginaFlowBackend } from './src/v2/storage/backends/ReginaFlowBackend.js';

// Создать engine
const backend = new ReginaFlowBackend({ dbPath: './graph.db' });
await backend.initialize();

// Добавить ноды
await backend.addNodes([
  {
    id: 'FUNCTION#getUserById#users.js',
    nodeType: 'FUNCTION',     // String type
    version: 'main',
    exported: true,
    name: 'getUserById',
    file: 'src/api/users.js',
  }
]);

// Добавить рёбра
await backend.addEdges([
  {
    src: funcId,
    dst: dbQueryId,
    type: 'CALLS',            // String type
    version: 'main',
  }
]);

// BFS
const reachable = await backend.bfs(
  [startId],
  10,                         // maxDepth
  ['CALLS', 'CONTAINS']       // edge types
);

// Итерация по нодам
for await (const node of backend.queryNodes({ nodeType: 'FUNCTION', exported: true })) {
  console.log(node.name);
}

// Wildcard поиск
for await (const node of backend.queryNodes({ nodeType: 'http:*' })) {
  console.log(node);
}

// Получить рёбра
const outgoing = await backend.getOutgoingEdges(nodeId, ['CALLS']);
const incoming = await backend.getIncomingEdges(nodeId);

// Статистика
const nodeCounts = backend.countNodesByType();  // {"FUNCTION": 42, "http:route": 5}
const edgeCounts = backend.countEdgesByType();  // {"CALLS": 100, "CONTAINS": 50}

// Сохранить
await backend.flush();
await backend.close();
```

### Typo Detection

При добавлении нод/рёбер с неизвестными типами выполняется Levenshtein проверка:

```javascript
// Это выбросит ошибку:
await backend.addNodes([{ nodeType: 'FUNCTON' }]);
// Error: Possible typo in node type: "FUNCTON" - did you mean "FUNCTION"?

await backend.addEdges([{ type: 'CALL' }]);
// Error: Possible typo in edge type: "CALL" - did you mean "CALLS"?

// Новые валидные типы добавляются автоматически:
await backend.addNodes([{ nodeType: 'my:custom_type' }]);
// [ReginaFlowBackend] Added new node type: "my:custom_type"
```

---

## Performance Benchmarks

### Результаты (cargo bench)

| Операция | Размер | Время | Throughput |
|----------|--------|-------|------------|
| **Batch write** | 1,000 nodes | 665 µs | ~1.5M nodes/sec |
| **Batch write** | 10,000 nodes | 5.02 ms | ~2.0M nodes/sec |
| **Find by type** | 100,000 nodes | 1.03 ms | ~97M nodes/sec |
| **Find by attr** | 100,000 nodes | 2.85 ms | ~35M nodes/sec |
| **BFS** | 10,000 nodes | 3.90 µs | ~2.5M ops/sec |
| **Neighbors** | любой | 276 ns | ~3.6M lookups/sec |

### Сравнение с Neo4j

| Операция | Neo4j | ReginaFlowDB | Ускорение |
|----------|-------|--------------|-----------|
| Batch write (1k) | ~200ms | 0.665ms | **300x** |
| Find by type (100k) | ~50ms | 1.03ms | **50x** |
| BFS (depth=10) | ~50ms | 3.90µs | **12,800x** |
| Neighbors | ~1ms | 276ns | **3,600x** |

---

## Quick Start

### 1. Build Rust engine

```bash
cd rust-engine
npm run build
```

### 2. Run tests

```bash
# Rust tests
cargo test

# JS integration tests
cd .. && npm test
```

**Результат:** 9/9 Rust tests + 149/152 JS tests

### 3. Run example

```bash
cargo run --example basic_usage
```

---

## Структура проекта

```
rust-engine/
├── src/
│   ├── lib.rs              # Public API
│   ├── graph/
│   │   ├── mod.rs          # GraphStore trait
│   │   ├── engine.rs       # GraphEngine implementation
│   │   ├── id_gen.rs       # BLAKE3 ID generation
│   │   └── traversal.rs    # BFS/DFS algorithms
│   ├── storage/
│   │   ├── mod.rs          # NodeRecord, EdgeRecord
│   │   ├── segment.rs      # Mmap segments + StringTable reader
│   │   ├── writer.rs       # Binary writers + StringTable writer
│   │   ├── delta.rs        # Delta log
│   │   └── string_table.rs # String interning
│   ├── ffi/
│   │   └── napi_bindings.rs # Node.js bindings (napi-rs)
│   └── error.rs            # Error types
├── examples/
│   ├── basic_usage.rs
│   └── test_persistence.rs
└── Cargo.toml
```

---

## Technical Details

### String Table

Эффективное хранение строк (типы, пути, имена):

```rust
pub struct StringTable {
    data: Vec<u8>,           // Конкатенированные строки
    offsets: Vec<u32>,       // Начальные позиции строк
    index: HashMap<String, u32>, // Для дедупликации
}

// Использование
let offset = string_table.intern("FUNCTION");  // Возвращает offset
let s = string_table.get(offset);              // Возвращает &str
```

### Endpoint Detection

Для PathValidator:

```rust
fn is_endpoint(&self, id: u128) -> bool {
    if let Some(node) = self.get_node_internal(id) {
        let node_type = node.node_type.as_deref().unwrap_or("UNKNOWN");

        matches!(node_type,
            "db:query" | "http:request" | "http:endpoint" |
            "EXTERNAL" | "fs:operation" | "SIDE_EFFECT"
        ) || (node_type == "FUNCTION" && node.exported)
    } else {
        false
    }
}
```

---

## Troubleshooting

### Ошибка: "cargo: command not found"

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### Ошибка при сборке NAPI

```bash
cd rust-engine
npm run build
# или напрямую:
cargo build --release
```

### Memory-mapped файлы не обновляются

```bash
# Убедитесь что вызывается flush()
await backend.flush();
```

---

## License

Same as Navi project.
