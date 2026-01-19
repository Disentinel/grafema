# Navi Test Suite - TDD Approach

## Философия

Мы начинаем с нуля в TDD-манере: **сначала тесты, потом код**.

Все тесты сейчас закомментированы (`// TODO: implement`), потому что реализация ещё не написана. По мере разработки новой архитектуры мы будем раскомментировать тесты и добиваться их прохождения.

## Структура тестов

```
test/
├── fixtures/              # Тестовые проекты для анализа
│   ├── 01-simple-script/  # Простой скрипт
│   ├── 02-api-service/    # Express API сервис
│   └── 03-frontend-app/   # Frontend приложение
│
├── helpers/               # Утилиты для тестирования
│   ├── GraphAsserter.js   # Проверка графов в текстовом виде
│   └── MockNeo4j.js       # Mock Neo4j для тестов
│
└── scenarios/             # Тестовые сценарии
    ├── 01-simple-script.test.js
    ├── 02-api-service.test.js
    └── 03-frontend-app.test.js
```

## Тестовые fixtures

### 01-simple-script
Простейший сценарий:
- Одна функция `greet(name)`
- Одна функция `main()`
- Два `console.log()`
- Вызов `greet()` из `main()`

**Что проверяем:**
- Обнаружение SERVICE из package.json
- Создание MODULE node
- Создание FUNCTION nodes
- Обнаружение CALLS рёбер
- Обнаружение WRITES_TO → __stdio__

### 02-api-service
Express API сервис:
- 4 модуля (index, users routes, orders routes, db)
- 6 endpoints (GET/POST на /users, /orders, /health)
- Database queries (SELECT, INSERT)
- Console.log calls

**Что проверяем:**
- Обнаружение BACKEND service
- Создание MODULE nodes для всех файлов
- Создание ENDPOINT nodes
- Связи MODULE → EXPOSES → ENDPOINT
- Database operations → __database__
- ENDPOINT → CALLS → __network__

### 03-frontend-app
Frontend приложение:
- 5 модулей (index, api, UserList, OrderForm)
- HTTP requests (fetch)
- Console.log calls

**Что проверяем:**
- Обнаружение FRONTEND service
- HTTP fetch calls → __network__
- Импорты между модулями
- UI component hierarchy

## GraphAsserter API

Утилита для проверки графов в читаемом виде:

```javascript
import { assertGraph } from '../helpers/GraphAsserter.js';

const graph = neo4j.export();

assertGraph(graph)
  // Проверить наличие ноды
  .hasNode('FUNCTION', 'greet')

  // Проверить отсутствие ноды
  .doesNotHaveNode('FUNCTION', 'nonexistent')

  // Проверить наличие ребра
  .hasEdge('FUNCTION', 'main', 'CALLS', 'FUNCTION', 'greet')

  // Проверить количество нод типа
  .hasNodeCount('FUNCTION', 2)

  // Проверить количество рёбер типа
  .hasEdgeCount('CALLS', 1)

  // Проверить путь через граф
  .hasPath(
    'SERVICE:simple-script',
    'CONTAINS',
    'MODULE:index.js',
    'CONTAINS',
    'FUNCTION:greet',
    'WRITES_TO',
    'EXTERNAL_STDIO:__stdio__'
  )

  // Валидация целостности
  .allEdgesValid()
  .noDuplicateIds();
```

## MockNeo4j API

Mock для Neo4j, не требует подключения к реальной БД:

```javascript
import { MockNeo4j } from '../helpers/MockNeo4j.js';

const neo4j = new MockNeo4j();
await neo4j.connect();

// Добавить ноду
await neo4j.addNode({
  id: 'service-1',
  type: 'SERVICE',
  name: 'my-service'
});

// Добавить ребро (с валидацией)
await neo4j.addEdge({
  type: 'CONTAINS',
  fromId: 'service-1',
  toId: 'module-1'
});  // throws if nodes don't exist

// Batch операции
await neo4j.addNodesBatch([...]);
await neo4j.addEdgesBatch([...]);

// Экспорт для assertions
const graph = neo4j.export();
// { nodes: [...], edges: [...] }

// Статистика
const stats = await neo4j.getStats();
// { nodeCount, edgeCount, nodeTypes, edgeTypes }
```

## Как запускать тесты

```bash
# Запустить все тесты
npm test

# Запустить конкретный тест
npm test -- test/scenarios/01-simple-script.test.js

# Запустить тесты с coverage
npm run test:coverage
```

**Пока тесты не проходят** (все TODO), но это нормально - мы начинаем с TDD.

## TDD Workflow

### Этап 1: Написать тесты (DONE ✅)
- [x] Создать fixtures с тестовыми проектами
- [x] Написать тесты с ожидаемым поведением
- [x] Создать хелперы для проверки графов

### Этап 2: Запустить тесты (все fail)
```bash
npm test
# Все тесты fail, потому что Orchestrator не реализован
```

### Этап 3: Реализовать минимальный код
Начинаем с базовой инфраструктуры:
1. Orchestrator
2. MockNeo4j интеграция
3. Phase 0: Discovery

```bash
# Тесты начинают проходить по одному
npm test -- test/scenarios/01-simple-script.test.js
```

### Этап 4: Итеративно развивать
- Раскомментировать следующий тест
- Запустить - он fail
- Реализовать функциональность
- Тест проходит
- Перейти к следующему

### Этап 5: Refactor
Когда все тесты проходят, можно рефакторить код с уверенностью что ничего не сломали.

## Ожидаемые графы

### Simple Script
```
SERVICE: simple-script
  └─ CONTAINS ─> MODULE: index.js
      ├─ CONTAINS ─> FUNCTION: greet
      │   └─ CONTAINS ─> METHOD_CALL: console.log
      │       └─ WRITES_TO ─> EXTERNAL_STDIO: __stdio__
      │
      └─ CONTAINS ─> FUNCTION: main
          ├─ CALLS ─> FUNCTION: greet
          └─ CONTAINS ─> METHOD_CALL: console.log
              └─ WRITES_TO ─> EXTERNAL_STDIO: __stdio__
```

### API Service
```
SERVICE: @test/api-service (BACKEND)
  ├─ CONTAINS ─> MODULE: src/index.js
  │   └─ EXPOSES ─> ENDPOINT: GET /health
  │       └─ CALLS ─> EXTERNAL_NETWORK: __network__
  │
  ├─ CONTAINS ─> MODULE: src/routes/users.js
  │   ├─ EXPOSES ─> ENDPOINT: GET /api/users
  │   │   └─ CALLS ─> EXTERNAL_NETWORK: __network__
  │   ├─ EXPOSES ─> ENDPOINT: GET /api/users/:id
  │   └─ EXPOSES ─> ENDPOINT: POST /api/users
  │
  ├─ CONTAINS ─> MODULE: src/routes/orders.js
  │   ├─ EXPOSES ─> ENDPOINT: GET /api/orders
  │   └─ EXPOSES ─> ENDPOINT: POST /api/orders
  │
  └─ CONTAINS ─> MODULE: src/db.js
      └─ CONTAINS ─> METHOD: query
          ├─ READS_FROM ─> EXTERNAL_DATABASE: __database__ (SELECT)
          └─ WRITES_TO ─> EXTERNAL_DATABASE: __database__ (INSERT)
```

### Frontend App
```
SERVICE: @test/frontend-app (FRONTEND)
  ├─ CONTAINS ─> MODULE: src/index.js
  │   ├─ CALLS ─> FUNCTION: init
  │   └─ WRITES_TO ─> EXTERNAL_STDIO: __stdio__
  │
  ├─ CONTAINS ─> MODULE: src/api.js
  │   └─ CONTAINS ─> FUNCTION: fetchUsers
  │       └─ CALLS ─> fetch
  │           └─ CALLS ─> EXTERNAL_NETWORK: __network__
  │
  ├─ CONTAINS ─> MODULE: src/components/UserList.js
  │   └─ CONTAINS ─> FUNCTION: renderUserList
  │
  └─ CONTAINS ─> MODULE: src/components/OrderForm.js
      └─ CONTAINS ─> FUNCTION: renderOrderForm
```

## Assertions матрица

| Fixture | Services | Modules | Functions | Endpoints | External Systems |
|---------|----------|---------|-----------|-----------|------------------|
| 01-simple-script | 1 | 1 | 2 | 0 | __stdio__ |
| 02-api-service | 1 | 4 | ~10 | 6 | __stdio__, __database__, __network__ |
| 03-frontend-app | 1 | 5 | ~8 | 0 | __stdio__, __network__ |

## Критерии success

Тесты считаются пройденными когда:

1. ✅ Все SERVICE обнаружены
2. ✅ Все MODULE созданы
3. ✅ Все FUNCTION обнаружены
4. ✅ Все ENDPOINT обнаружены (для API)
5. ✅ Все внешние системы (__stdio__, __database__, __network__) созданы
6. ✅ Все рёбра валидны (обе ноды существуют)
7. ✅ Нет дубликатов ID
8. ✅ Пути от SERVICE до EXTERNAL_* валидны

## Следующие шаги

1. **Запустить тесты**: `npm test` (все должны fail)
2. **Начать реализацию**: следовать [IMPLEMENTATION_ROADMAP.md](../docs/IMPLEMENTATION_ROADMAP.md)
3. **Итеративно**: раскомментировать тест → реализовать → тест проходит
4. **Рефакторинг**: когда все проходят

## Добавление новых тестов

Чтобы добавить новый тестовый сценарий:

1. Создать fixture в `test/fixtures/XX-name/`
2. Написать реальный код проекта в fixture
3. Создать тест в `test/scenarios/XX-name.test.js`
4. Использовать `assertGraph()` для проверок
5. Запустить тест - он fail
6. Реализовать функциональность
7. Тест проходит

## Примеры будущих сценариев

- **04-monorepo**: Multiple services in one repo
- **05-microservices**: Services calling each other
- **06-database-heavy**: Complex DB queries with transactions
- **07-websockets**: Real-time communication
- **08-graphql**: GraphQL API
- **09-cron-jobs**: Scheduled tasks
- **10-k8s-services**: Kubernetes deployments

---

**Помните**: Тесты - это спецификация. Они описывают что должно работать, до того как мы это реализуем. Это и есть TDD.
