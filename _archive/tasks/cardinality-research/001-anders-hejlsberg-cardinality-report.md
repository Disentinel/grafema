# Исследование: Отслеживание Кардинальности для Анализа Сложности

**Автор:** Anders Hejlsberg (консультант по системам типов)
**Дата:** 2026-02-02
**Статус:** Исследовательский отчёт

---

## Введение

Grafema предлагает интересную возможность: отслеживание кардинальности (количества элементов) через граф кода. Аналогия с TypeScript уместна — в обоих случаях мы хотим:

1. **Объявить один раз** — аннотировать определение
2. **Вывести везде** — автоматически распространить информацию на использования
3. **Предупредить при проблемах** — показать понятные сообщения

Этот отчёт анализирует дизайн системы кардинальности с точки зрения практического опыта создания TypeScript.

---

## 1. Дизайн Синтаксиса Аннотаций

### 1.1. Уроки из TypeScript

Когда мы проектировали синтаксис типов в TypeScript, ключевым принципом был:

> **Аннотации должны быть необязательными и неинвазивными.**

Код без аннотаций должен работать. Аннотации добавляют информацию, но не ломают базовый функционал.

### 1.2. Предлагаемый Синтаксис для Semantic ID

В контексте Grafema аннотации применяются к **semantic ID** функций. Я вижу три уровня:

#### Уровень 1: Декларативные Метаданные (Рекомендуется)

```typescript
// В plugin-определении или конфигурации
{
  "functions": {
    "graph.queryNodes": {
      "returns": {
        "cardinality": "nodes",      // именованная шкала
        "preservesCardinality": true  // map/filter сохраняют шкалу
      }
    },
    "graph.queryEdges": {
      "returns": {
        "cardinality": "edges"
      }
    }
  },
  "scales": {
    "nodes": { "typical": "10M", "max": "100M" },
    "edges": { "typical": "50M", "max": "500M" },
    "constant": { "typical": "1", "max": "100" }
  }
}
```

**Почему JSON/YAML:**
- Не загрязняет код
- Легко версионировать отдельно
- Можно генерировать из документации
- AI-агенты легко читают и модифицируют

#### Уровень 2: JSDoc-аннотации (Альтернатива)

```javascript
/**
 * @grafema-returns scale:nodes
 * @grafema-preserves-cardinality
 */
function queryNodes(filter) { ... }
```

**Плюсы:** Близко к коду, видно разработчику.
**Минусы:** Загрязняет исходники, требует парсинг комментариев.

#### Уровень 3: Специальный DSL (Избыточно)

```
FUNCTION#queryNodes RETURNS scale:nodes
FUNCTION#filter PRESERVES cardinality(input)
```

**Минусы:** Отдельный язык = отдельная кривая обучения. Не рекомендую.

### 1.3. Рекомендация

**Уровень 1 (декларативные метаданные) — оптимальный баланс.**

Причины:
1. Отделение concerns: код отдельно, метаданные отдельно
2. Версионирование: можно обновлять без изменения кода
3. AI-friendly: структурированные данные легче для LLM
4. Обратная совместимость: работает с legacy-кодом

---

## 2. Вывод через Дженерики (map, filter, reduce)

### 2.1. Проблема

```javascript
const nodes = graph.queryNodes();          // scale:nodes
const filtered = nodes.filter(predicate);  // ???
const mapped = filtered.map(transform);    // ???
const reduced = mapped.reduce(acc, init);  // ???
```

### 2.2. Подход TypeScript: Сигнатуры Типов

В TypeScript мы решаем это через generics:

```typescript
interface Array<T> {
  filter(pred: (x: T) => boolean): T[];  // Сохраняет T
  map<U>(fn: (x: T) => U): U[];          // Меняет T на U
  reduce<U>(fn: (acc: U, x: T) => U, init: U): U;  // Возвращает U
}
```

### 2.3. Адаптация для Кардинальности

Ввожу понятие **трансформации кардинальности**:

```typescript
type CardinalityTransform =
  | 'preserve'      // filter: scale:N -> scale:N (или меньше)
  | 'map'           // map: scale:N -> scale:N (1:1)
  | 'reduce'        // reduce: scale:N -> scale:1
  | 'expand'        // flatMap: scale:N -> scale:N*M
  | 'unknown';      // пользовательские функции
```

#### Конфигурация Стандартных Методов

```json
{
  "builtins": {
    "Array.prototype.filter": { "transform": "preserve" },
    "Array.prototype.map": { "transform": "map" },
    "Array.prototype.flatMap": { "transform": "expand", "factor": "elements" },
    "Array.prototype.reduce": { "transform": "reduce" },
    "Array.prototype.find": { "transform": "reduce" },
    "Array.prototype.slice": { "transform": "preserve" },
    "Array.prototype.concat": { "transform": "expand", "factor": "args" }
  }
}
```

### 2.4. Пример Вывода

```javascript
const nodes = graph.queryNodes();          // scale:nodes (~10M)
const filtered = nodes.filter(isActive);   // scale:nodes (preserve)
const mapped = filtered.map(toSummary);    // scale:nodes (map 1:1)
const first = mapped[0];                   // scale:1 (indexed access)
const count = mapped.length;               // scale:1 (property access)
const flat = nodes.flatMap(getChildren);   // scale:nodes*children (expand)
```

### 2.5. Обработка Неизвестных Функций

Когда функция не аннотирована:

```javascript
const result = customProcess(nodes);  // scale:unknown
```

**Стратегия:**
1. Предупреждение: "Unknown cardinality transformation"
2. Консервативное предположение: preserve (пессимистично)
3. Возможность аннотировать:

```json
{
  "functions": {
    "customProcess": { "transform": "reduce" }
  }
}
```

---

## 3. Практичность: Не Слишком Verbose, Хорошие Defaults

### 3.1. Принцип из TypeScript

> **Inference over Annotation.**

TypeScript выводит типы везде, где возможно. Пользователь аннотирует только точки входа.

### 3.2. Система Defaults для Кардинальности

```json
{
  "defaults": {
    "queryMethods": "scale:collection",    // query*, fetch*, get*
    "iterationMethods": "preserve",        // forEach, map, filter
    "aggregationMethods": "reduce",        // reduce, sum, count
    "unknownMethods": "preserve"           // консервативно
  },
  "patterns": [
    { "match": "query*", "returns": "scale:collection" },
    { "match": "get*ById", "returns": "scale:1" },
    { "match": "find*", "returns": "scale:1" },
    { "match": "count*", "returns": "scale:1" },
    { "match": "*All", "returns": "scale:collection" }
  ]
}
```

### 3.3. Минимальная Конфигурация для Типичного Проекта

```json
{
  "scales": {
    "entities": { "typical": "1M" },
    "relations": { "typical": "10M" }
  },
  "entryPoints": {
    "db.query": "scale:entities",
    "graph.edges": "scale:relations"
  }
}
```

Всё остальное — inference.

### 3.4. Progressive Disclosure

**Level 0:** Никакой конфигурации. Система использует эвристики:
- Имена методов (`query*` -> коллекция)
- Типы возврата (Array -> коллекция)
- Паттерны использования (for...of -> итерация по коллекции)

**Level 1:** Базовая конфигурация scales и entry points.

**Level 2:** Детальные аннотации для специфических функций.

**Level 3:** Custom transformations для сложных паттернов.

---

## 4. Сообщения об Ошибках

### 4.1. Принципы TypeScript

Хорошее сообщение об ошибке:

1. **Указывает ЧТО не так** (не только ГДЕ)
2. **Объясняет ПОЧЕМУ** это проблема
3. **Предлагает КАК исправить**

### 4.2. Примеры Сообщений для Кардинальности

#### Пример 1: Итерация по Большой Коллекции

```
Complexity Warning: Iterating over scale:nodes (~10M items)

  12 | const nodes = graph.queryNodes();
  13 | for (const node of nodes) {
     |      ^^^^^^^^^^^^^^^
  14 |   process(node);
  15 | }

This loop may process ~10M iterations.

Consider:
  • Use pagination: graph.queryNodes({ limit: 1000, offset: ... })
  • Use streaming: graph.streamNodes().pipe(processor)
  • Add filtering: graph.queryNodes({ where: { type: 'FUNCTION' } })

Cardinality trace:
  graph.queryNodes()  → scale:nodes (~10M)
  for...of            → O(N) iterations
```

#### Пример 2: Вложенные Циклы

```
Complexity Warning: O(N²) pattern detected

   8 | const nodes = graph.queryNodes();     // scale:nodes
   9 | const edges = graph.queryEdges();     // scale:edges
  10 | for (const node of nodes) {
  11 |   for (const edge of edges) {
      |        ^^^^^^^^^^^^^^^
  12 |     if (edge.source === node.id) {

This creates ~10M × 50M = 500T operations.

Consider:
  • Index by source: const edgesBySource = groupBy(edges, 'source');
  • Use graph traversal: graph.getOutgoing(node)
  • Database join: graph.query('MATCH (n)-[e]->()')

Cardinality trace:
  outer loop: nodes  → scale:nodes (~10M)
  inner loop: edges  → scale:edges (~50M)
  combined:          → O(N×M) = ~500T operations
```

#### Пример 3: Unbounded Accumulation

```
Memory Warning: Unbounded collection growth

  15 | const results = [];
  16 | for await (const batch of stream) {
  17 |   results.push(...batch);
      |   ^^^^^^^^^^^^^^^^^^^^^^
  18 | }

Each iteration adds scale:batch (~1K) items.
After ~10K iterations: ~10M items in memory.

Consider:
  • Process in batches without accumulation
  • Write to disk/database incrementally
  • Use reduce for aggregation

Cardinality trace:
  initial:    results = []             → scale:0
  per batch:  push(scale:batch)        → +~1K items
  after N:    results                  → scale:N*batch
```

### 4.3. Уровни Серьёзности

```typescript
type Severity =
  | 'hint'      // scale:1000 → информационно
  | 'warning'   // scale:1M   → рассмотреть оптимизацию
  | 'error'     // scale:1T   → вероятно баг
  | 'critical'; // O(N²) с N>10K → почти наверняка баг
```

Пороги настраиваемые:

```json
{
  "thresholds": {
    "hint": 1000,
    "warning": 1000000,
    "error": 1000000000,
    "nested_loop_warning": 10000
  }
}
```

---

## 5. Escape Hatches: Подавление Ложных Срабатываний

### 5.1. Урок из TypeScript: `any` и Type Assertions

TypeScript предоставляет escape hatches:
- `any` — отключить проверку типов
- `as Type` — утверждение типа
- `// @ts-ignore` — игнорировать строку

Это **необходимо** для практичности. Без них система была бы непригодна.

### 5.2. Escape Hatches для Кардинальности

#### Inline Suppression

```javascript
// @grafema-ignore cardinality-warning
for (const node of graph.queryNodes()) {
  // Мы знаем, что это временно пустой граф
}
```

#### Scoped Suppression

```javascript
/* @grafema-disable cardinality-warnings */
function legacyMigration() {
  // Весь файл миграции — особый случай
}
/* @grafema-enable cardinality-warnings */
```

#### Assertion (Утверждение)

```javascript
// @grafema-scale: constant
const config = graph.queryNodes({ type: 'CONFIG' });
// Разработчик утверждает: конфигов всегда мало
```

#### Per-File Configuration

```json
// .grafema/cardinality.json
{
  "ignoreFiles": [
    "scripts/migration/*.js",
    "tests/**/*.js"
  ],
  "ignorePatterns": [
    { "function": "legacyProcessor", "reason": "Known O(N²), scheduled for refactor" }
  ]
}
```

### 5.3. Аудит Подавлений

Важно отслеживать использование escape hatches:

```bash
grafema audit --cardinality-suppressions
```

```
Cardinality Suppression Audit
=============================

Total suppressions: 12

By type:
  @grafema-ignore:    8
  @grafema-scale:     3
  config ignoreFiles: 1

By age:
  < 30 days:  5
  30-90 days: 4
  > 90 days:  3  ← Consider reviewing

Files with most suppressions:
  src/legacy/importer.js: 4
  src/reports/generator.js: 3
```

---

## 6. Интеграция с Существующей Архитектурой Grafema

### 6.1. Связь с Semantic ID

Текущая система semantic ID в Grafema (`file->scope->TYPE->name#N`) идеально подходит для хранения метаданных кардинальности:

```typescript
// В types.ts
export interface FunctionInfo {
  id: string;
  semanticId?: string;
  // ... существующие поля ...

  // Новые поля для кардинальности
  returnCardinality?: CardinalityInfo;
}

export interface CardinalityInfo {
  scale: string;           // 'nodes', 'edges', 'constant', 'unknown'
  typical?: string;        // '10M', '1K', '1'
  max?: string;            // '100M', '10K', '100'
  preservesInput?: boolean; // для map/filter
  transform?: CardinalityTransform;
}
```

### 6.2. Связь с ControlFlowMetadata

Текущая `ControlFlowMetadata` уже отслеживает:
- `hasLoops` — есть ли циклы
- `cyclomaticComplexity` — сложность

Расширение для кардинальности:

```typescript
export interface ControlFlowMetadata {
  // Существующие
  hasBranches: boolean;
  hasLoops: boolean;
  cyclomaticComplexity: number;

  // Новые
  loopComplexity?: LoopComplexityInfo[];
}

export interface LoopComplexityInfo {
  loopId: string;          // semantic ID цикла
  iteratesOver?: string;   // semantic ID коллекции
  iteratesOverScale?: string;  // 'nodes', 'edges', etc.
  bodyComplexity: number;  // O(1), O(log N), O(N)
  nestedLoops?: string[];  // IDs вложенных циклов
  totalComplexity?: string; // 'O(N)', 'O(N²)', 'O(N log N)'
}
```

### 6.3. Новый Edge Type

```typescript
// В edges.ts
ITERATES_OVER: 'ITERATES_OVER',  // Уже есть!

// Добавить метаданные на edge
interface GraphEdge {
  // ...существующие...
  cardinality?: CardinalityInfo;
}
```

### 6.4. Пример Запроса

```cypher
// Найти функции с O(N²) паттернами
MATCH (f:FUNCTION)-[:CONTAINS]->(outer:LOOP)-[:CONTAINS]->(inner:LOOP)
WHERE outer.iteratesOverScale = 'nodes'
  AND inner.iteratesOverScale = 'edges'
RETURN f.name, outer.line, inner.line
```

---

## 7. Реализация: Фазы

### Фаза 1: Базовая Инфраструктура (v0.2)

1. Типы: `CardinalityInfo`, `LoopComplexityInfo`
2. Конфигурация: `scales`, `entryPoints`
3. Парсинг: распознавание `@grafema-scale` комментариев
4. Вывод: базовый для `filter`/`map`/`reduce`

### Фаза 2: Анализ Циклов (v0.2)

1. Связь LOOP → коллекция через ITERATES_OVER
2. Детекция вложенных циклов
3. Вычисление `totalComplexity`

### Фаза 3: Предупреждения (v0.3)

1. Генерация warnings с трассировкой
2. CLI: `grafema complexity --check`
3. MCP: интеграция в explain/query

### Фаза 4: Escape Hatches (v0.3)

1. Inline/scoped suppression
2. Конфигурация ignoreFiles
3. Аудит suppressions

---

## 8. Открытые Вопросы

### 8.1. Кардинальность Параметров

```javascript
function processItems(items) {
  for (const item of items) { ... }
}
```

Как определить scale:items? Варианты:
- Вывод из call sites
- Требовать аннотацию
- Conservative: `scale:unknown`

**Рекомендация:** Вывод из call sites + warning если неоднозначно.

### 8.2. Conditional Cardinality

```javascript
const data = isProduction
  ? fetchAllUsers()      // scale:users (~1M)
  : getMockUsers();      // scale:constant (~10)
```

**Рекомендация:** Пессимистичный выбор (scale:users) + hint.

### 8.3. Async Streams

```javascript
for await (const batch of streamRecords()) {
  // batch: scale:1K, но stream: scale:1M
}
```

**Рекомендация:** Отдельная шкала `scale:batched(1K, 1M)`.

---

## 9. Заключение

### Ключевые Решения

1. **Синтаксис:** JSON-конфигурация (не JSDoc, не DSL)
2. **Inference:** Maximum inference, minimum annotation
3. **Transforms:** preserve/map/reduce/expand классификация
4. **Messages:** Трассировка кардинальности + рекомендации
5. **Escapes:** @grafema-ignore, @grafema-scale, config

### Параллели с TypeScript

| TypeScript | Grafema Cardinality |
|------------|---------------------|
| Type annotation | Scale annotation |
| Type inference | Cardinality inference |
| `any` | `scale:unknown` |
| `as Type` | `@grafema-scale:...` |
| `@ts-ignore` | `@grafema-ignore` |
| Strict mode | Warning thresholds |
| Error messages | Cardinality traces |

### Риски

1. **False positives:** Могут раздражать. Mitigation: хорошие escape hatches.
2. **Complexity:** Система сама может стать сложной. Mitigation: progressive disclosure.
3. **Maintenance:** Аннотации устаревают. Mitigation: inference + аудит.

### Следующие Шаги

1. Прототип: базовый inference для стандартных методов
2. User testing: собрать feedback на реальном коде
3. Итерация: улучшить messages и defaults

---

*"Making something simple is hard. Making something complex is easy."*

Система кардинальности должна быть **невидимой** пока не нужна, и **полезной** когда нужна. Как типы в TypeScript — они там, но не мешают.

— Anders Hejlsberg
