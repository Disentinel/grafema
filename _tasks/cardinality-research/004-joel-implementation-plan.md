# План Реализации: Отслеживание Кардинальности для Анализа Сложности

**Автор:** Joel Spolsky (Implementation Planner)
**Дата:** 2 февраля 2026
**Статус:** Технический план реализации

---

## 1. Синтез Исследовательских Отчётов

### 1.1 Ключевые Решения из Отчётов

| Аспект | Anders Hejlsberg | Patrick Cousot | Robert Tarjan |
|--------|------------------|----------------|---------------|
| **Домен** | Именованные шкалы (nodes, edges, constant) | Гибридный: (Scale, Interval, Confidence) | Категории: TINY, SMALL, MEDIUM, LARGE, HUGE |
| **Inference** | Maximum inference, minimum annotation | Forward dataflow analysis | Worklist algorithm |
| **Transforms** | preserve/map/reduce/expand | Transfer functions | — |
| **Вложенные циклы** | — | Умножение кардинальностей | DFS с контекстом, O(V + E) |
| **Алгоритмы** | — | Fixpoint computation, widening | Доминаторы, SCC Тарьяна |

### 1.2 Принятая Архитектура

Объединяю три перспективы в единую систему:

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONFIGURATION LAYER                          │
│  - Именованные шкалы (Anders): nodes, edges, files, constant    │
│  - Pattern-based inference: query* → collection, find* → 1      │
│  - Escape hatches: @grafema-ignore, @grafema-scale              │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ABSTRACT DOMAIN (Patrick)                    │
│  Cardinality = (Scale, Interval, Confidence)                    │
│  - Scale: constant < config < routes < files < functions < nodes│
│  - Interval: [lo, hi] ⊆ ℕ ∪ {∞}                                 │
│  - Confidence: exact | upper_bound | estimate                   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ANALYSIS ENGINE (Tarjan)                     │
│  Phase 1: FindNestedLoops — DFS, O(V + E)                       │
│  Phase 2: PropagateCardinality — Worklist, O(V × E)             │
│  Phase 3: ComplexityEstimation — O(L²)                          │
│  Phase 4: RecursiveAnalysis — SCC Тарьяна, O(V + E)             │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     WARNING SYSTEM (Anders)                      │
│  - Threshold-based severity: hint/warning/error/critical        │
│  - Cardinality traces: граф → исходный код                      │
│  - Actionable recommendations: pagination, indexing, streaming  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Обзор Существующих Инструментов

### 2.1 COSTA (Cost and Termination Analyzer)

[COSTA](https://link.springer.com/chapter/10.1007/978-3-540-92188-2_5) — анализатор стоимости и завершимости для Java bytecode.

**Ключевые особенности:**
- Генерирует cost relations (CRs) — расширенные рекуррентные соотношения
- Автоматически выводит верхние и нижние границы потребления ресурсов
- Использует difference constraints для анализа сложности ([статья](https://link.springer.com/article/10.1007/s10817-016-9402-4))
- Интегрирован с KeY для формальной верификации bounds ([When COSTA Met KeY](https://link.springer.com/chapter/10.1007/978-3-031-08166-8_2))

**Релевантность для Grafema:**
- Cost relations подход слишком тяжёл для нашей задачи
- Но идея difference constraints полезна для loop bounds

### 2.2 RAML (Resource Aware ML)

[RAML](https://www.raml.co/) — автоматический анализ ресурсов для функциональных программ.

**Ключевые особенности:**
- Amortized resource analysis — амортизационный анализ
- Выводит полиномиальные bounds как функции от размеров входов
- Multivariate polynomials для сложных структур данных
- Поддержка higher-order functions

**Релевантность для Grafema:**
- Идея amortized analysis полезна для flatMap/reduce
- Polynomial bounds — слишком сложно для MVP
- Начнём с линейных/квадратичных оценок

### 2.3 Общие Static Analysis Tools

Современные инструменты ([обзор 2025](https://www.comparitech.com/net-admin/best-static-code-analysis-tools/)) фокусируются на:
- Security vulnerabilities (SAST)
- Code quality metrics (cyclomatic complexity)
- AI-powered pattern detection

**Gap:** Никто не делает cardinality-aware complexity analysis для untyped кода.

---

## 3. Детальная Спецификация Типов

### 3.1 Абстрактный Домен Кардинальности

```typescript
// packages/types/src/cardinality.ts

/**
 * Категории размера в решётке шкал.
 * Порядок важен: константа ⊏ config ⊏ ... ⊏ nodes ⊏ unbounded
 */
export type ScaleCategory =
  | 'constant'    // ~1-10 элементов
  | 'config'      // ~10-100 (конфигурации, env)
  | 'routes'      // ~100-5K (HTTP endpoints)
  | 'files'       // ~1K-50K (файлы проекта)
  | 'functions'   // ~10K-500K (функции в проекте)
  | 'nodes'       // ~100K-100M (узлы в графе)
  | 'unbounded';  // потенциально бесконечно

/**
 * Уровень уверенности в оценке.
 */
export type ConfidenceLevel =
  | 'exact'       // Точное значение (литерал, slice(0, 10))
  | 'upper_bound' // Гарантированная верхняя граница
  | 'estimate';   // Эвристическая оценка

/**
 * Основной тип кардинальности — гибридный домен.
 */
export interface Cardinality {
  /** Семантическая категория размера */
  scale: ScaleCategory;

  /** Числовой интервал [lo, hi], hi может быть Infinity */
  interval: CardinalityInterval;

  /** Уровень уверенности в оценке */
  confidence: ConfidenceLevel;

  /** Опциональная метка источника (для трассировки) */
  source?: string;
}

export interface CardinalityInterval {
  lo: number;
  hi: number; // Infinity для unbounded
}

/**
 * Типы трансформации кардинальности для методов коллекций.
 */
export type CardinalityTransform =
  | 'preserve'  // filter, slice: N → [0, N]
  | 'map'       // map: N → N (1:1)
  | 'reduce'    // reduce, find: N → 1
  | 'expand'    // flatMap, concat: N → N*M
  | 'unknown';  // пользовательские функции

/**
 * Определение именованной шкалы в конфигурации.
 */
export interface ScaleDefinition {
  name: string;
  category: ScaleCategory;
  typical?: number;  // Типичное значение
  max?: number;      // Максимальное значение
}

/**
 * Аннотация кардинальности для функции.
 */
export interface FunctionCardinalityAnnotation {
  /** Semantic ID функции или glob-паттерн */
  functionPattern: string;

  /** Кардинальность возвращаемого значения */
  returns?: Cardinality | string; // string = ссылка на scale

  /** Трансформация (для методов коллекций) */
  transform?: CardinalityTransform;

  /** Фактор расширения для expand (flatMap) */
  expandFactor?: Cardinality | string;
}
```

### 3.2 Расширение Существующих Типов

```typescript
// Расширение LoopInfo в packages/core/src/plugins/analysis/ast/types.ts

export interface LoopInfo {
  // ... существующие поля ...

  // === CARDINALITY FIELDS (Phase 2) ===

  /** Оценка кардинальности итерируемой коллекции */
  iteratesOverCardinality?: Cardinality;

  /** ID вложенных циклов (для быстрого поиска) */
  nestedLoopIds?: string[];

  /** ID внешнего цикла (если вложен) */
  outerLoopId?: string;

  /** Оценка общей сложности тела цикла */
  bodyComplexity?: ComplexityEstimate;
}

/**
 * Оценка вычислительной сложности.
 */
export interface ComplexityEstimate {
  /** O-нотация: O(1), O(N), O(N²), O(N×M), O(N log N) */
  notation: string;

  /** Числовая оценка при заданных кардинальностях */
  estimatedOperations?: number;

  /** Компоненты сложности (для трассировки) */
  components?: ComplexityComponent[];
}

export interface ComplexityComponent {
  /** Источник сложности (loop ID, call ID) */
  sourceId: string;

  /** Тип: iteration, nested_loop, recursive_call */
  type: 'iteration' | 'nested_loop' | 'recursive_call';

  /** Кардинальность этого компонента */
  cardinality: Cardinality;
}
```

### 3.3 Метаданные Рёбер

```typescript
// Расширение IteratesOverEdge в packages/types/src/edges.ts

export interface IteratesOverEdge extends EdgeRecord {
  type: 'ITERATES_OVER';
  metadata?: {
    /** Что итерирует: 'keys' для for-in, 'values' для for-of */
    iterates: 'keys' | 'values';

    // === CARDINALITY FIELDS (Phase 2) ===

    /** Оценка кардинальности коллекции */
    cardinality?: Cardinality;

    /** Источник оценки: annotation, inference, heuristic */
    cardinalitySource?: 'annotation' | 'inference' | 'heuristic';
  };
}
```

---

## 4. Фазы Реализации

### Фаза 1: Базовая Инфраструктура Типов

**Цель:** Определить типы и конфигурацию без изменения анализа.

**Задачи:**

1.1. **Создать `packages/types/src/cardinality.ts`**
   - Типы: `Cardinality`, `ScaleCategory`, `ConfidenceLevel`
   - Transfer functions: `preserveCardinality`, `mapCardinality`, `reduceCardinality`, `expandCardinality`
   - Операции решётки: `joinCardinality`, `meetCardinality`, `compareCardinality`

1.2. **Создать `packages/core/src/cardinality/config.ts`**
   - Загрузка `.grafema/cardinality.json`
   - Defaults для стандартных методов (Array.prototype.*)
   - Pattern matching для имён функций

1.3. **Юнит-тесты типов и конфигурации**

**Сложность:** O(1) — статические определения

**Acceptance Criteria:**
- [ ] Типы компилируются без ошибок
- [ ] Конфигурация загружается и валидируется
- [ ] Тесты transfer functions покрывают все комбинации

**Зависимости:** Нет

**Оценка:** 2-3 дня

---

### Фаза 2: Анализ Вложенных Циклов

**Цель:** Обнаруживать вложенные циклы через DFS по CONTAINS-дереву.

**Задачи:**

2.1. **Реализовать `findNestedLoops(graph)`**
   - DFS по CONTAINS-рёбрам
   - Stack ancestor_loops для отслеживания контекста
   - Результат: список пар (outer_loop_id, inner_loop_id)

```typescript
// packages/core/src/cardinality/nestedLoops.ts

interface NestedLoopPair {
  outerLoopId: string;
  innerLoopId: string;
  depth: number; // Глубина вложенности
}

export function findNestedLoops(graph: GraphBackend): NestedLoopPair[] {
  // O(V + E) — один DFS проход
}
```

2.2. **Индекс для быстрого доступа**
   - `Map<loopId, NestedLoopPair[]>` — вложенные в данный цикл
   - `Map<loopId, string | null>` — внешний цикл

2.3. **Интеграционные тесты**
   - 3 уровня вложенности
   - Параллельные циклы (не вложенные)
   - Циклы в разных функциях

**Big-O Анализ:**
- Построение дерева CONTAINS: O(E)
- DFS: O(V)
- Генерация пар: O(d × L), где d — макс. глубина, L — число циклов
- **Итого: O(V + E)**

**Acceptance Criteria:**
- [ ] Корректно находит все вложенные пары
- [ ] Не путает параллельные циклы с вложенными
- [ ] Линейная сложность на больших графах (benchmark)

**Зависимости:** Фаза 1 (типы)

**Оценка:** 3-4 дня

---

### Фаза 3: Пропагация Кардинальности

**Цель:** Распространять кардинальность через граф data flow.

**Задачи:**

3.1. **Реализовать worklist algorithm**

```typescript
// packages/core/src/cardinality/propagation.ts

export function propagateCardinality(
  graph: GraphBackend,
  annotations: Map<string, Cardinality>,
  builtins: BuiltinTransforms
): Map<string, Cardinality> {
  const cardinality = new Map<string, Cardinality>();
  const worklist: string[] = [];

  // Initialize from annotations
  for (const [nodeId, card] of annotations) {
    cardinality.set(nodeId, card);
    worklist.push(nodeId);
  }

  // Propagate until fixpoint
  while (worklist.length > 0) {
    const nodeId = worklist.shift()!;
    const card = cardinality.get(nodeId)!;

    // Follow DATAFLOW edges
    const outgoing = graph.queryEdges({
      src: nodeId,
      type: ['ASSIGNED_FROM', 'FLOWS_INTO', 'RETURNS']
    });

    for (const edge of outgoing) {
      const targetCard = applyTransfer(card, edge, builtins);
      const existing = cardinality.get(edge.dst);

      if (!existing || isNarrower(targetCard, existing)) {
        cardinality.set(edge.dst, targetCard);
        worklist.push(edge.dst);
      }
    }
  }

  return cardinality;
}
```

3.2. **Transfer functions для стандартных операций**
   - `filter`: (s, [lo, hi], c) → (s, [0, hi], upper_bound)
   - `map`: (s, [lo, hi], c) → (s, [lo, hi], c)
   - `flatMap`: (s1, i1, c1) × (s2, i2, c2) → (s1 ⊔ s2, i1 × i2, min(c1, c2))
   - `reduce`, `find`: (s, i, c) → (constant, [1, 1], exact)
   - `slice(0, k)`: (s, [lo, hi], c) → (s, [min(lo, k), min(hi, k)], exact)

3.3. **Widening для циклов**
   - Если hi растёт → hi := ∞
   - Предотвращает бесконечную итерацию

3.4. **Связь LOOP → коллекция через ITERATES_OVER**
   - Для каждого LOOP с ITERATES_OVER → присвоить кардинальность

**Big-O Анализ:**
- Инициализация: O(A), где A — число аннотаций
- Worklist iterations: O(V × H × E), где H — высота решётки
- H = 7 (число категорий) → O(V × E)
- **Итого: O(V × E)**, на практике близко к O(E)

**Acceptance Criteria:**
- [ ] Кардинальность корректно распространяется через chain of operations
- [ ] filter().map().filter() сохраняет scale
- [ ] flatMap корректно умножает интервалы
- [ ] Widening предотвращает зацикливание

**Зависимости:** Фаза 1, Фаза 2

**Оценка:** 5-7 дней

---

### Фаза 4: Оценка Сложности

**Цель:** Вычислять сложность вложенных циклов с учётом кардинальности.

**Задачи:**

4.1. **Реализовать `estimateComplexity`**

```typescript
// packages/core/src/cardinality/complexity.ts

export interface ComplexityWarning {
  type: 'quadratic' | 'cubic' | 'exponential' | 'recursive';
  outerLoopId: string;
  innerLoopId?: string;
  outerCardinality: Cardinality;
  innerCardinality?: Cardinality;
  estimatedOperations: number;
  severity: 'hint' | 'warning' | 'error' | 'critical';
  trace: ComplexityTrace;
}

export function estimateComplexity(
  nestedPairs: NestedLoopPair[],
  cardinalities: Map<string, Cardinality>,
  thresholds: ComplexityThresholds
): ComplexityWarning[] {
  const warnings: ComplexityWarning[] = [];

  for (const pair of nestedPairs) {
    const outerCard = cardinalities.get(pair.outerLoopId);
    const innerCard = cardinalities.get(pair.innerLoopId);

    if (!outerCard || !innerCard) continue;

    const operations = multiply(outerCard.interval, innerCard.interval);

    if (operations.hi > thresholds.quadraticWarning) {
      warnings.push({
        type: 'quadratic',
        outerLoopId: pair.outerLoopId,
        innerLoopId: pair.innerLoopId,
        outerCardinality: outerCard,
        innerCardinality: innerCard,
        estimatedOperations: operations.hi,
        severity: determineSeverity(operations.hi, thresholds),
        trace: buildTrace(pair, cardinalities)
      });
    }
  }

  return warnings;
}
```

4.2. **Анализ доминаторов (опционально)**
   - Если внешний цикл доминирует над внутренним → умножаем
   - Иначе → max(outer, inner)
   - Можно отложить до следующей версии

4.3. **Определение severity**
   - hint: < 1K операций
   - warning: 1K - 1M операций
   - error: 1M - 1B операций
   - critical: > 1B операций или O(N²) с N > 10K

**Big-O Анализ:**
- Перебор пар: O(P), где P — число вложенных пар
- P ≤ d × L (d — глубина, L — циклы)
- **Итого: O(d × L)**, на практике O(L)

**Acceptance Criteria:**
- [ ] O(N²) паттерн обнаруживается
- [ ] O(N³) (три уровня вложенности) обнаруживается
- [ ] Severity корректно определяется по thresholds
- [ ] Trace содержит путь до исходных аннотаций

**Зависимости:** Фаза 2, Фаза 3

**Оценка:** 3-4 дня

---

### Фаза 5: Система Предупреждений и CLI

**Цель:** Интеграция с CLI и понятные сообщения об ошибках.

**Задачи:**

5.1. **Форматирование предупреждений (Anders-style)**

```typescript
// packages/core/src/cardinality/warnings.ts

export function formatWarning(warning: ComplexityWarning): string {
  return `
Complexity Warning: O(N×M) pattern detected

   8 | const nodes = graph.queryNodes();     // scale:nodes
   9 | const edges = graph.queryEdges();     // scale:edges
  10 | for (const node of nodes) {
  11 |   for (const edge of edges) {
      |        ^^^^^^^^^^^^^^^
  12 |     if (edge.source === node.id) {

This creates ~${warning.estimatedOperations.toExponential()} operations.

Consider:
  • Index by source: const edgesBySource = groupBy(edges, 'source');
  • Use graph traversal: graph.getOutgoing(node)

Cardinality trace:
  ${formatTrace(warning.trace)}
`;
}
```

5.2. **CLI команда `grafema complexity`**

```bash
# Проверка сложности
grafema complexity --check

# С пользовательскими thresholds
grafema complexity --warning-threshold 10000 --error-threshold 1000000

# Только конкретный файл
grafema complexity src/analyzer.js

# JSON output для CI
grafema complexity --format json
```

5.3. **Интеграция в `grafema analyze`**
   - Флаг `--complexity` для включения анализа
   - По умолчанию выключен (для скорости)

**Acceptance Criteria:**
- [ ] Сообщения содержат номера строк и код
- [ ] Trace показывает путь до источника кардинальности
- [ ] Рекомендации специфичны для паттерна
- [ ] JSON output для CI интеграции

**Зависимости:** Фаза 4

**Оценка:** 3-4 дня

---

### Фаза 6: Escape Hatches

**Цель:** Возможность подавления ложных срабатываний.

**Задачи:**

6.1. **Парсинг комментариев**
   - `// @grafema-ignore cardinality-warning`
   - `// @grafema-scale: constant`
   - `/* @grafema-disable cardinality-warnings */`

6.2. **Конфигурация игнорирования**

```json
// .grafema/cardinality.json
{
  "ignoreFiles": ["scripts/migration/*.js", "tests/**/*.js"],
  "ignorePatterns": [
    { "function": "legacyProcessor", "reason": "Known O(N²)" }
  ]
}
```

6.3. **Аудит подавлений**

```bash
grafema audit --cardinality-suppressions
```

**Acceptance Criteria:**
- [ ] Inline suppression работает
- [ ] File-level ignore работает
- [ ] Аудит показывает все подавления и их возраст

**Зависимости:** Фаза 5

**Оценка:** 2-3 дня

---

### Фаза 7: MCP Интеграция

**Цель:** Экспозиция анализа сложности через MCP.

**Задачи:**

7.1. **Новый tool: `grafema_complexity_check`**

```typescript
{
  name: 'grafema_complexity_check',
  description: 'Check for O(N²) or worse complexity patterns in code',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File to analyze' },
      function: { type: 'string', description: 'Function to analyze' },
      threshold: { type: 'number', description: 'Warning threshold' }
    }
  }
}
```

7.2. **Расширение `grafema_explain`**
   - Если объясняем LOOP → показать кардинальность
   - Если есть вложенные циклы → показать complexity warning

7.3. **Расширение `grafema_query`**
   - Новый фильтр: `WHERE complexity > 1000000`
   - Новое поле в результатах: `cardinality`, `complexity`

**Acceptance Criteria:**
- [ ] MCP tool возвращает warnings в structured формате
- [ ] AI-agent может использовать для анализа PR
- [ ] Интеграция с explain работает

**Зависимости:** Фаза 5

**Оценка:** 3-4 дня

---

## 5. Сводка Временных Оценок

| Фаза | Название | Дни | Cumulative |
|------|----------|-----|------------|
| 1 | Типы и конфигурация | 2-3 | 2-3 |
| 2 | Вложенные циклы | 3-4 | 5-7 |
| 3 | Пропагация кардинальности | 5-7 | 10-14 |
| 4 | Оценка сложности | 3-4 | 13-18 |
| 5 | CLI и предупреждения | 3-4 | 16-22 |
| 6 | Escape hatches | 2-3 | 18-25 |
| 7 | MCP интеграция | 3-4 | 21-29 |

**Итого: 21-29 дней** (4-6 недель)

---

## 6. Граф Зависимостей

```
Фаза 1 (Типы)
     │
     ├──────────┐
     │          │
     ▼          ▼
Фаза 2       Фаза 3
(Nested)     (Propagation)
     │          │
     └────┬─────┘
          │
          ▼
       Фаза 4
     (Complexity)
          │
          ▼
       Фаза 5
        (CLI)
          │
     ┌────┴────┐
     │         │
     ▼         ▼
  Фаза 6    Фаза 7
 (Escape)   (MCP)
```

**Критический путь:** 1 → 3 → 4 → 5 → 7

Фазы 2 и 3 можно делать параллельно. Фазы 6 и 7 можно делать параллельно.

---

## 7. Риски и Митигации

### 7.1 False Positives

**Риск:** Слишком много ложных предупреждений → пользователи игнорируют.

**Митигация:**
- Консервативные thresholds по умолчанию
- Хорошие escape hatches (Фаза 6)
- Confidence level в warnings

### 7.2 Performance на Больших Графах

**Риск:** O(V × E) может быть медленным при V = 10M, E = 50M.

**Митигация:**
- Анализ только при явном запросе (--complexity flag)
- Инкрементальность: при изменении файла — только affected paths
- Кэширование результатов

### 7.3 Сложность Конфигурации

**Риск:** Пользователи не захотят писать аннотации.

**Митигация:**
- Maximum inference, minimum annotation (Anders)
- Pattern-based defaults для стандартных имён
- Автоматическая генерация стартовой конфигурации

---

## 8. Версионирование

| Версия | Фазы | Функциональность |
|--------|------|------------------|
| v0.2.0 | 1-4 | Базовый анализ, только API |
| v0.3.0 | 5-6 | CLI, escape hatches |
| v0.4.0 | 7 | MCP интеграция |

---

## 9. Открытые Вопросы (для обсуждения)

### 9.1 Кардинальность Параметров Функций

```javascript
function processItems(items) {
  for (const item of items) { ... }
}
```

**Варианты:**
- A) Вывод из call sites (может быть неоднозначно)
- B) Требовать аннотацию
- C) Conservative: `scale:unknown`

**Рекомендация:** Вариант A с fallback на C.

### 9.2 Conditional Cardinality

```javascript
const data = isProduction
  ? fetchAllUsers()      // scale:users (~1M)
  : getMockUsers();      // scale:constant (~10)
```

**Рекомендация:** Пессимистичный выбор (scale:users).

### 9.3 Async Streams

```javascript
for await (const batch of streamRecords()) {
  // batch: scale:constant (~1K), но stream: unbounded
}
```

**Рекомендация:** Отдельная шкала `scale:batched(batch_size, total)`. Отложить до v0.4.

---

## 10. Заключение

Предложенный план реализует систему отслеживания кардинальности поэтапно:

1. **Типы** — формальный фундамент (Patrick)
2. **Алгоритмы** — эффективные O(V + E) и O(V × E) реализации (Tarjan)
3. **UX** — понятные сообщения и escape hatches (Anders)

Ключевой принцип: **start simple, add complexity**. MVP (Фазы 1-4) можно выпустить через 2-3 недели, затем итеративно улучшать.

---

## Источники

- [COSTA: Design and Implementation](https://link.springer.com/chapter/10.1007/978-3-540-92188-2_5)
- [RAML: Resource Aware ML](https://www.raml.co/)
- [Complexity Analysis with Difference Constraints](https://link.springer.com/article/10.1007/s10817-016-9402-4)
- [When COSTA Met KeY](https://link.springer.com/chapter/10.1007/978-3-031-08166-8_2)
- [Static Code Analysis Tools 2025](https://www.comparitech.com/net-admin/best-static-code-analysis-tools/)

---

*Joel Spolsky*
*2 февраля 2026*
