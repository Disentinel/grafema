# Semantic Coverage Guide

Руководство по достижению полного семантического покрытия кода.

## Что такое семантическое покрытие

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         КОД ПРОЕКТА                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  Функции    │  │   Классы    │  │   Вызовы    │  │ Переменные  │    │
│  │  ████████   │  │  ████████   │  │  ████░░░░   │  │  ████████   │    │
│  │  100%       │  │  100%       │  │  60%        │  │  100%       │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ HTTP Routes │  │  DB Queries │  │  WebSocket  │  │    React    │    │
│  │  ████████   │  │  ░░░░░░░░   │  │  ████████   │  │  ░░░░░░░░   │    │
│  │  100%       │  │  0%         │  │  100%       │  │  0%         │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                         │
│  ████ = покрыто семантикой    ░░░░ = не покрыто                        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Семантическое покрытие** — это процент кода, для которого в графе есть:
- Правильные типы нод (не просто CALL, а `http:route`, `db:query`)
- Разрешённые связи (CALLS edge от вызова к определению)
- Контекстная информация (какой HTTP метод, какая таблица БД)

## Метрики покрытия

### 1. Call Resolution Rate

Процент вызовов функций/методов для которых известно что вызывается.

```javascript
// MCP tool: query_graph

// Всего вызовов
{ "query": "violation(X) :- node(X, \"CALL\")." }

// Неразрешённые вызовы
{ "query": "violation(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"CALLS\")." }

// Формула: (total - unresolved) / total * 100
```

**Целевое значение:** > 80%

### 2. Method Call Resolution Rate

```javascript
// Всего method calls
{ "query": "violation(X) :- node(X, \"METHOD_CALL\")." }

// Неразрешённые
{ "query": "violation(X) :- node(X, \"METHOD_CALL\"), \\+ edge(X, _, \"CALLS\")." }
```

**Целевое значение:** > 70%

### 3. Framework Coverage

Сколько framework-specific паттернов распознано:

```javascript
// HTTP endpoints
{ "query": "violation(X) :- node(X, \"http:route\")." }

// Database queries
{ "query": "violation(X) :- node(X, \"db:query\")." }

// WebSocket events
{ "query": "violation(X) :- node(X, \"socketio:emit\")." }
{ "query": "violation(X) :- node(X, \"socketio:on\")." }

// React components
{ "query": "violation(X) :- node(X, \"react:component\")." }
```

### 4. Dependency Coverage

```javascript
// Внешние зависимости (библиотеки)
{ "query": "violation(X) :- node(X, \"MODULE\"), attr(X, \"external\", \"true\")." }

// Импорты которые не разрешились
{ "query": "violation(X) :- edge(_, X, \"DEPENDS_ON\"), \\+ node(X, \"MODULE\")." }
```

## Диагностика проблем

### Найти неразрешённые вызовы по файлам

```javascript
// MCP tool: query_graph
{
  "query": "violation(F) :- node(C, \"CALL\"), attr(C, \"file\", F), \\+ edge(C, _, \"CALLS\")."
}

// Результат покажет файлы с наибольшим количеством проблем
```

### Найти паттерны неразрешённых вызовов

```javascript
// Какие функции чаще всего не разрешаются
{
  "query": "violation(N) :- node(C, \"CALL\"), attr(C, \"name\", N), \\+ edge(C, _, \"CALLS\")."
}

// Какие объекты.методы не разрешаются
{
  "query": "violation(X) :- node(C, \"METHOD_CALL\"), attr(C, \"object\", O), attr(C, \"method\", M), \\+ edge(C, _, \"CALLS\")."
}
```

### Найти используемые но не покрытые библиотеки

```javascript
// Импорты внешних модулей
{
  "query": "violation(X) :- edge(M, X, \"DEPENDS_ON\"), node(M, \"MODULE\"), \\+ node(X, \"MODULE\")."
}
```

## Типичные причины низкого покрытия

### 1. Динамические вызовы

```javascript
// Статический анализ не может разрешить:
const method = getMethodName();
obj[method]();  // ← какой метод?

const handler = routes[path];
handler(req, res);  // ← какая функция?
```

**Решение:** ValueDomainAnalyzer пытается отследить возможные значения, но полное покрытие невозможно.

### 2. Библиотека без плагина

```javascript
// Fastify, NestJS, Koa — нет встроенного анализатора
import Fastify from 'fastify';
const app = Fastify();
app.get('/users', handler);  // ← не распознаётся как http:route
```

**Решение:** Написать плагин. См. `get_documentation({ topic: "plugin-development" })`.

### 3. Алиасы и реэкспорты

```javascript
// utils.js
export { query } from './db';

// handler.js
import { query } from './utils';
query('SELECT...');  // ← может не разрешиться через реэкспорт
```

**Решение:** AliasTracker должен отследить цепочку.

### 4. Monkey patching

```javascript
// Расширение прототипов
Array.prototype.customMethod = function() {...};
[1,2,3].customMethod();  // ← не разрешится
```

**Решение:** Практически невозможно статически.

## Улучшение покрытия

### Шаг 1: Измерить текущее состояние

```javascript
// MCP tool: get_stats
// Посмотреть общую картину

// Затем детально:
// 1. Call resolution rate
// 2. Method call resolution rate
// 3. Framework-specific nodes
```

### Шаг 2: Найти главные проблемы

```javascript
// Топ файлов по неразрешённым вызовам
{
  "query": "violation(F) :- node(C, \"CALL\"), attr(C, \"file\", F), \\+ edge(C, _, \"CALLS\")."
}
```

Сгруппировать по причинам:
- Динамические вызовы → ничего не сделать
- Отсутствует плагин → написать плагин
- Баг в существующем плагине → исправить

### Шаг 3: Приоритизировать

| Причина | Усилия | Влияние | Приоритет |
|---------|--------|---------|-----------|
| Написать плагин для основного фреймворка | Высокие | Высокое | 1 |
| Исправить баг в enricher | Низкие | Среднее | 2 |
| Добавить поддержку паттерна | Средние | Низкое | 3 |
| Динамические вызовы | Невозможно | — | — |

### Шаг 4: Итеративно улучшать

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Измерить │ →  │ Найти    │ →  │ Исправить│ →  │ Проверить│
│ метрики  │    │ проблему │    │          │    │ улучшение│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
      ↑                                               │
      └───────────────────────────────────────────────┘
```

## Пример: Анализ покрытия проекта

```javascript
// 1. Общая статистика
get_stats()
// → Nodes: MODULE=45, FUNCTION=234, CALL=567, METHOD_CALL=123
// → Edges: CONTAINS=890, CALLS=456, DEPENDS_ON=44

// 2. Call resolution
query_graph({ query: "violation(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"CALLS\")." })
// → 111 результатов
// → Resolution rate: (567-111)/567 = 80%

// 3. Файлы с проблемами
query_graph({ query: "violation(F) :- node(C, \"CALL\"), attr(C, \"file\", F), \\+ edge(C, _, \"CALLS\")." })
// → src/legacy/oldModule.js: 45 unresolved
// → src/utils/dynamic.js: 30 unresolved
// → src/api/handlers.js: 20 unresolved

// 4. Паттерны неразрешённых
query_graph({ query: "violation(N) :- node(C, \"CALL\"), attr(C, \"name\", N), \\+ edge(C, _, \"CALLS\")." })
// → "require": 25 (dynamic requires)
// → "emit": 15 (EventEmitter, нужен плагин)
// → "dispatch": 10 (Redux, нужен плагин)

// 5. Framework coverage
query_graph({ query: "violation(X) :- node(X, \"http:route\")." })
// → 23 routes найдено ✓

query_graph({ query: "violation(X) :- node(X, \"db:query\")." })
// → 0 results ← проблема! Используется Prisma, нет плагина
```

## Что считать "достаточным" покрытием

| Метрика | Минимум | Хорошо | Отлично |
|---------|---------|--------|---------|
| Call resolution | 60% | 80% | 90%+ |
| Method call resolution | 50% | 70% | 85%+ |
| HTTP routes | Все найдены | + middleware | + параметры |
| DB queries | Основные | + таблицы | + схемы |

**Практический подход:**
1. Достигнуть 80% call resolution
2. Покрыть основные framework паттерны (routes, queries)
3. Создать гарантии для критичных инвариантов
4. Итеративно улучшать по мере необходимости

## Автоматический мониторинг

### Гарантия минимального покрытия

```javascript
// MCP tool: create_guarantee
{
  "id": "min-call-resolution",
  "name": "Minimum Call Resolution",
  "rule": "violation(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"CALLS\").",
  "severity": "warning"
}

// Проверять в CI — если слишком много violations, разобраться
```

### Tracking в CI

```yaml
# .github/workflows/coverage.yml
- name: Check semantic coverage
  run: |
    npx navi analyze
    npx navi check-coverage --min-call-resolution 80
```

## См. также

- `get_documentation({ topic: "project-onboarding" })` — начало работы
- `get_documentation({ topic: "plugin-development" })` — написание плагинов
- `get_documentation({ topic: "guarantee-workflow" })` — создание гарантий
