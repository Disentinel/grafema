# Testing Documentation

Тестовый стенд для Grafema: unit, scenario, integration и Rust benchmarks.

## Структура тестов

```
test/
├── unit/                         # Unit тесты (~167 файлов)
│   ├── DataFlowTracking.test.js
│   ├── GraphFactory.test.js
│   ├── core/                     # Core-модуль (enrichers, diagnostics, etc.)
│   ├── analysis/                 # Анализ (async, promises)
│   ├── types/                    # Типы (control-flow, results)
│   ├── cardinality/              # Cardinality тесты
│   └── ...
├── scenarios/                    # Scenario тесты (fixture-based integration)
│   ├── 01-simple-script.test.js
│   ├── 02-api-service.test.js
│   └── ...
├── integration/                  # Integration тесты (CLI, RFDB, cross-service)
│   ├── cli-coverage.test.ts
│   ├── cross-service-tracing.test.ts
│   ├── rfdb/
│   └── ...
├── fixtures/                     # Тестовые проекты
│   ├── 01-simple-script/
│   ├── 02-api-service/
│   ├── galaxy-demo/
│   ├── workspaces/
│   └── ...
├── snapshots/                    # Snapshot тесты
└── helpers/                      # Test utilities
    ├── TestRFDB.js               # Shared RFDB server + createTestDatabase()
    ├── GraphAsserter.js
    ├── SimpleServiceDiscovery.js
    ├── createTestOrchestrator.js
    └── setupSemanticTest.js

packages/rfdb-server/
├── benches/                      # Performance benchmarks (Criterion)
│   ├── graph_operations.rs
│   ├── neo4j_comparison.rs
│   ├── v1_v2_comparison.rs
│   ├── compaction_bench.rs
│   └── reanalysis_cost.rs
├── tests/                        # Rust unit/integration тесты
└── examples/                     # Executable examples
```

---

## Node.js тесты

### Важно: сборка перед тестами

Тесты импортируют из `dist/`, не из `src/`. **Всегда** собирайте перед запуском:

```bash
pnpm build
```

### Запуск unit тестов

```bash
node --test --test-concurrency=1 'test/unit/*.test.js'
```

### Запуск с покрытием

```bash
pnpm test:coverage
# Эквивалент: c8 node --test --test-concurrency=1 'test/unit/*.test.js'
```

### Scenario тесты

```bash
pnpm test:scenarios
# Эквивалент: node --test test/scenarios/
```

### Запуск одного теста

```bash
node --test test/unit/DataFlowTracking.test.js
```

> **Внимание:** `npm test` в package.json не работает напрямую — используйте команды выше.

---

## Rust тесты

### Unit тесты

```bash
cd packages/rfdb-server
cargo test
```

### Benchmarks

```bash
cd packages/rfdb-server
cargo bench --bench graph_operations
```

Также доступны:
- `cargo bench --bench v1_v2_comparison` — сравнение v1 vs v2
- `cargo bench --bench compaction_bench` — тест компакции
- `cargo bench --bench reanalysis_cost` — стоимость реанализа

**Измеряемые операции (graph_operations):**
- add_nodes (100, 1k, 10k)
- find_by_type (1k, 10k, 100k)
- bfs (100, 1k, 10k nodes)
- neighbors (1k, 10k, 100k edges)

Результаты в `packages/rfdb-server/target/criterion/report/index.html`

---

## Test Helpers

### createTestDatabase()

Быстрое создание эфемерной базы через shared RFDB server (~10ms):

```javascript
import { createTestDatabase } from '../helpers/TestRFDB.js';

const db = await createTestDatabase();
await db.backend.addNodes([...]);
await db.cleanup(); // или автоматически при disconnect
```

Shared server запускается один раз и живёт по пути `/tmp/rfdb-test-shared.sock`. Каждый тест создаёт уникальную эфемерную базу — изоляция на уровне данных.

> **Внимание:** `createTestBackend()` — **deprecated**, выбрасывает ошибку. Используйте `createTestDatabase()`.

### createTestOrchestrator

Быстрое создание Orchestrator для тестов:

```javascript
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const { orchestrator, graph } = await createTestOrchestrator({
  rootDir: './test/fixtures/01-simple-script'
});
```

### GraphAsserter

Assertions для проверки графа:

```javascript
import { GraphAsserter } from '../helpers/GraphAsserter.js';

const asserter = new GraphAsserter(graph);
asserter.hasNodeOfType('FUNCTION');
asserter.hasEdge('CALLS', fromId, toId);
```

### setupSemanticTest

Помощник для semantic ID тестов — создаёт временный проект, записывает файлы, запускает анализ:

```javascript
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const result = await setupSemanticTest(backend, files, {
  testLabel: 'my-semantic-test'
});
```

---

## Написание тестов

### Unit тест

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase } from '../helpers/TestRFDB.js';

describe('My Feature', () => {
  test('should do something', async () => {
    const db = await createTestDatabase();

    // ... тест ...

    await db.cleanup();
  });
});
```

### Scenario тест

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('My Scenario', () => {
  test('should analyze fixture', async () => {
    const { orchestrator, graph } = await createTestOrchestrator({
      rootDir: './test/fixtures/my-fixture'
    });

    await orchestrator.run();

    const nodes = graph.findNodes(n => n.type === 'FUNCTION');
    assert.ok(nodes.length > 0, 'Should find functions');
  });
});
```

---

## CI Integration

CI использует pnpm и Node.js 22. Конфигурация: `.github/workflows/ci.yml`

### Jobs

| Job | Описание |
|-----|----------|
| **test** | Сборка + unit тесты с покрытием, проверка `.only`/`.skip` |
| **typecheck-lint** | TypeScript typecheck + ESLint |
| **build** | Сборка всех пакетов, проверка артефактов |
| **version-sync** | Синхронизация версий npm-пакетов и Cargo.toml |

### Benchmark CI

Конфигурация: `.github/workflows/benchmark.yml`

- Запускается на PR к main (с label `benchmark`) и push в main
- Сравнивает производительность PR vs main через Criterion + critcmp
- Порог регрессии: 20%
- Результаты публикуются комментарием в PR
