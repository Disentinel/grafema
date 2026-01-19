# Testing Documentation

Тестовый стенд для Navi: unit, integration, E2E и Rust benchmarks.

## Структура тестов

```
test/
├── unit/                         # Unit тесты
│   ├── DataFlowTracking.test.js  # Data flow tracking
│   ├── PathValidator.test.js     # Path validation
│   └── Levenshtein.test.js       # Typo detection for types
├── scenarios/                    # Integration тесты
│   ├── 01-simple-script.test.js
│   ├── 02-api-service.test.js
│   ├── 02-advanced-features.test.js
│   └── 03-complex-async.test.js
├── e2e/                          # E2E тесты (Playwright)
│   └── gui.spec.js
├── fixtures/                     # Тестовые проекты
│   ├── 01-simple-script/
│   ├── 02-api-service/
│   ├── 02-advanced-features/
│   ├── 03-complex-async/
│   ├── 03-frontend-app/
│   ├── 03-advanced-routing/
│   ├── 04-control-flow/
│   ├── 05-modern-syntax/
│   ├── 06-socketio/
│   ├── 07-http-requests/
│   └── 08-reexports/
└── helpers/                      # Test utilities
    ├── TestRFDB.js
    ├── GraphAsserter.js
    ├── SimpleServiceDiscovery.js
    └── createTestOrchestrator.js

rust-engine/
├── benches/                      # Performance benchmarks
│   ├── graph_operations.rs
│   └── neo4j_comparison.rs
└── examples/                     # Executable examples
    ├── basic_usage.rs
    ├── test_persistence.rs
    └── migrate_neo4j.rs
```

---

## Node.js тесты

### Запуск всех тестов

```bash
npm test
```

Эта команда запускает:
- `test/scenarios/*.test.js`
- `test/unit/*.test.js`
- `test-rfdb-simple.mjs`

### E2E тесты (Playwright)

```bash
# Установка браузеров (один раз)
npx playwright install

# Запуск E2E тестов
npx playwright test

# С UI для debugging
npx playwright test --ui
```

---

## Rust тесты

### Unit тесты

```bash
cd rust-engine
cargo test
```

### Benchmarks

```bash
cd rust-engine
cargo bench
```

**Измеряемые операции:**
- add_nodes (100, 1k, 10k)
- find_by_type (1k, 10k, 100k)
- bfs (100, 1k, 10k nodes)
- neighbors (1k, 10k, 100k edges)

Результаты в `target/criterion/report/index.html`

---

## Test Fixtures

Тестовые проекты в `test/fixtures/` покрывают:

| Fixture | Описание |
|---------|----------|
| 01-simple-script | Базовый JS файл |
| 02-api-service | Express API с роутами |
| 02-advanced-features | Продвинутые JS паттерны |
| 03-complex-async | Async/await, promises |
| 03-frontend-app | Frontend с компонентами |
| 03-advanced-routing | Сложный Express routing |
| 04-control-flow | if/else, loops, switch |
| 05-modern-syntax | ES6+ синтаксис |
| 06-socketio | Socket.IO сервер/клиент |
| 07-http-requests | HTTP клиент (fetch) |
| 08-reexports | export * from, barrel files |

**Текущий статус:** 152/152 tests pass ✅

---

## Test Helpers

### TestRFDB

Создаёт временную ReginaFlowDB для тестов:

```javascript
import { TestRFDB } from '../helpers/TestRFDB.js';

const rfdb = new TestRFDB();
// ... использовать rfdb ...
rfdb.cleanup(); // Удалить временные файлы
```

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

---

## Написание тестов

### Scenario тест

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('My Feature', () => {
  test('should analyze something', async () => {
    const { orchestrator, graph } = await createTestOrchestrator({
      rootDir: './test/fixtures/my-fixture'
    });

    await orchestrator.run();

    const nodes = graph.findNodes(n => n.type === 'FUNCTION');
    assert.ok(nodes.length > 0, 'Should find functions');
  });
});
```

### E2E тест (Playwright)

```javascript
import { test, expect } from '@playwright/test';

test('should display graph', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.fill('#project-path', './test/fixtures/01-simple-script');
  await page.click('#analyze-btn');

  await expect(page.locator('.node')).toHaveCount.greaterThan(0);
});
```

---

## CI Integration

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: npm test

  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - run: cd rust-engine && cargo test
```
