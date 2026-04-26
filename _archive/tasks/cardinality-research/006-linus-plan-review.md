# Ревью Плана Реализации Cardinality Tracking

**Ревьюер:** Linus Torvalds (High-level Architecture Review)
**Дата:** 2 февраля 2026
**Статус:** Architectural Review

---

## Краткое Резюме

Joel написал добротный план на 800 строк. Детальный, с типами, с фазами, с Big-O анализом. **Но он проектирует параллельную вселенную** вместо того, чтобы использовать то, что уже есть в Grafema.

После нашего обсуждения стало очевидно:

> **Grafema уже имеет GuaranteeManager + Datalog. Cardinality Tracking не должен быть отдельным "Complexity Analysis Engine". Это должен быть enricher, который добавляет метаданные + Datalog правила для проверки.**

---

## 1. Что в Плане Джоэла ПРАВИЛЬНО

### 1.1 Типы Кардинальности (Фаза 1)

```typescript
export interface Cardinality {
  scale: ScaleCategory;
  interval: CardinalityInterval;
  confidence: ConfidenceLevel;
  source?: string;
}
```

**Вердикт: ОСТАВИТЬ.**

Это хорошая модель. Триплет (scale, interval, confidence) — правильная абстракция. Patrick Cousot одобрил, Anders тоже. Типы нужны как есть.

### 1.2 Трансформации (preserve/map/reduce/expand)

```typescript
type CardinalityTransform =
  | 'preserve'  // filter
  | 'map'       // map
  | 'reduce'    // reduce, find
  | 'expand'    // flatMap
  | 'unknown';
```

**Вердикт: ОСТАВИТЬ.**

Это стандартная классификация. Полезна для inference.

### 1.3 Конфигурация Scales и Entry Points

```json
{
  "scales": {
    "nodes": { "typical": "100K", "max": "10M" }
  },
  "entryPoints": {
    "graph.queryNodes": { "returns": "nodes" }
  }
}
```

**Вердикт: ОСТАВИТЬ.**

Хороший API для пользователя. Progressive disclosure работает.

### 1.4 Naming Heuristics (Level 0)

`query*` -> collection, `get*ById` -> single, `find*` -> single.

**Вердикт: ОСТАВИТЬ.**

Zero-config value. Steve Jobs одобрил.

---

## 2. Что в Плане Джоэла ЛИШНЕЕ

### 2.1 "Analysis Engine" (Фаза 2-4)

Joel предлагает:

```typescript
// packages/core/src/cardinality/nestedLoops.ts
export function findNestedLoops(graph: GraphBackend): NestedLoopPair[]

// packages/core/src/cardinality/propagation.ts
export function propagateCardinality(...): Map<string, Cardinality>

// packages/core/src/cardinality/complexity.ts
export function estimateComplexity(...): ComplexityWarning[]
```

**Вердикт: НЕ НУЖНО.**

Почему? Потому что это уже можно выразить через Datalog:

```prolog
% Найти вложенные циклы
nested_loops(Outer, Inner) :-
    node(Outer, "LOOP"),
    edge(Outer, Inner, "CONTAINS"),
    node(Inner, "LOOP").

% Найти циклы с большой кардинальностью
large_iteration(Loop) :-
    node(Loop, "LOOP"),
    edge(Loop, Coll, "ITERATES_OVER"),
    attr(Coll, "cardinality.scale", Scale),
    scale_is_large(Scale).

% Найти O(N^2) паттерны
quadratic_pattern(Outer, Inner) :-
    nested_loops(Outer, Inner),
    edge(Outer, OuterColl, "ITERATES_OVER"),
    edge(Inner, InnerColl, "ITERATES_OVER"),
    attr(OuterColl, "cardinality.scale", "nodes"),
    attr(InnerColl, "cardinality.scale", "edges").
```

**GuaranteeManager уже умеет:**
1. Хранить правила как GUARANTEE ноды
2. Выполнять их через `checkGuarantee(rule)`
3. Возвращать violations с node IDs
4. Экспортировать/импортировать через YAML

Зачем писать `findNestedLoops()`, `propagateCardinality()`, `estimateComplexity()` если это декларативно выражается в Datalog?

### 2.2 Warning System (Фаза 5)

Joel предлагает отдельную систему форматирования warnings с trace.

**Вердикт: ЧАСТИЧНО ЛИШНЕЕ.**

GuaranteeManager уже возвращает `EnrichedViolation`:

```typescript
interface EnrichedViolation {
  nodeId: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
}
```

Нужен только форматтер для человеко-читаемого вывода. Не нужна отдельная "warning system".

### 2.3 CLI команда `grafema complexity` (Фаза 5)

Joel предлагает:

```bash
grafema complexity --check
grafema complexity --warning-threshold 10000
```

**Вердикт: НЕ НУЖНО.**

Это уже есть:

```bash
grafema check                    # проверить все гарантии
grafema check --guarantee quadratic-loops
```

Не нужна отдельная CLI команда для complexity. Cardinality-related гарантии — это просто гарантии. Их проверяет `grafema check`.

### 2.4 MCP интеграция (Фаза 7)

Joel предлагает:

```typescript
{
  name: 'grafema_complexity_check',
  ...
}
```

**Вердикт: НЕ НУЖНО.**

MCP уже имеет:
- `check_guarantees` — проверить гарантии
- `query_graph` — выполнить Datalog запрос
- `explain` — объяснить ноду (можно расширить для показа cardinality)

Не нужен отдельный MCP tool.

---

## 3. BLOCKER: attr() не поддерживает вложенные пути

Текущая реализация `eval_attr()` в `rfdb-server/src/datalog/eval.rs`:

```rust
let attr_value: Option<String> = match attr_name {
    "name" => node.name.clone(),
    "file" => node.file.clone(),
    "type" => node.node_type.clone(),
    _ => {
        if let Some(ref metadata_str) = node.metadata {
            if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(metadata_str) {
                metadata.get(attr_name).and_then(|v| {
                    // ...
                })
            }
        }
    }
};
```

**Проблема:** `metadata.get(attr_name)` не поддерживает nested paths типа `cardinality.scale`.

**Это значит:**

```prolog
% Это НЕ работает сейчас:
attr(X, "cardinality.scale", "nodes")

% Работает только:
attr(X, "cardinality", ???)  % но это вернёт JSON объект, не строку
```

**Варианты решения:**

**A) Хранить cardinality плоско:**
```typescript
metadata: {
  cardinality_scale: "nodes",
  cardinality_lo: 0,
  cardinality_hi: 100000,
  cardinality_confidence: "upper_bound"
}
```

Тогда:
```prolog
attr(X, "cardinality_scale", "nodes")  % работает
```

**B) Добавить поддержку nested paths в attr():**
```rust
// В eval_attr():
let parts: Vec<&str> = attr_name.split('.').collect();
let mut current = &metadata;
for part in parts {
    current = current.get(part)?;
}
```

Тогда:
```prolog
attr(X, "cardinality.scale", "nodes")  % работает
```

**Рекомендация: Вариант B (nested paths).**

Причины:
1. Более выразительно — можно запрашивать любую глубину
2. Не загрязняет namespace — `cardinality.scale` vs `cardinality_scale`
3. Стандартный паттерн — JSON path, dot notation

**Это должен быть отдельный тикет: "Support nested paths in Datalog attr() predicate"**

---

## 4. ПЕРЕСМОТРЕННЫЙ Scope

### Что РЕАЛЬНО нужно для Cardinality Tracking:

#### Уровень 1: Базовая Инфраструктура

1. **Типы** (из плана Joel) — `Cardinality`, `ScaleCategory`, etc.
2. **Конфигурация** — `.grafema/cardinality.json` со scales и entry points
3. **Fix attr()** — поддержка nested paths в Datalog

#### Уровень 2: CardinalityEnricher Plugin

```typescript
// packages/core/src/plugins/enrichment/CardinalityEnricher.ts
export class CardinalityEnricher extends EnrichmentPlugin {
  static id = 'cardinality-enricher';

  async enrich(graph: GraphBackend, config: CardinalityConfig) {
    // 1. Добавить cardinality к результатам entry points
    for (const [pattern, info] of config.entryPoints) {
      const nodes = graph.queryNodes({ semanticId: pattern });
      for (const node of nodes) {
        await graph.updateNodeMetadata(node.id, {
          cardinality: {
            scale: info.returns,
            interval: config.scales[info.returns],
            confidence: 'annotation'
          }
        });
      }
    }

    // 2. Propagate через transform chains
    await this.propagateCardinality(graph, config);
  }
}
```

Ключевое: **enricher добавляет `metadata.cardinality` к нодам**. Он НЕ проверяет гарантии. Он только обогащает граф.

#### Уровень 3: Datalog Rules для Проверки

```yaml
# .grafema/guarantees.yaml
guarantees:
  - id: quadratic-nested-loops
    name: No O(N^2) nested loops over large collections
    rule: |
      violation(Outer, Inner) :-
        node(Outer, "LOOP"),
        edge(Outer, Inner, "CONTAINS"),
        node(Inner, "LOOP"),
        edge(Outer, OuterColl, "ITERATES_OVER"),
        edge(Inner, InnerColl, "ITERATES_OVER"),
        attr(OuterColl, "cardinality.scale", OuterScale),
        attr(InnerColl, "cardinality.scale", InnerScale),
        both_large(OuterScale, InnerScale).
    severity: error
    governs: ["src/**/*.js"]

  - id: large-collection-in-loop
    name: Warn when iterating over scale:nodes
    rule: |
      violation(Loop) :-
        node(Loop, "LOOP"),
        edge(Loop, Coll, "ITERATES_OVER"),
        attr(Coll, "cardinality.scale", "nodes").
    severity: warning
    governs: ["src/**/*.js"]
```

#### Уровень 4: UX (из плана Steve Jobs)

```bash
# Проверка всех гарантий включая cardinality
grafema check

# Guided annotation (можно добавить как подкоманду)
grafema annotate --cardinality graph.queryNodes

# Coverage report (расширение check)
grafema check --coverage
```

---

## 5. ПЕРЕСМОТРЕННЫЕ Фазы

### Фаза 0: Fix attr() (BLOCKER)

**Задача:** Добавить поддержку nested paths в Datalog `attr()`.

**Acceptance Criteria:**
- `attr(X, "metadata.foo.bar", V)` работает
- `attr(X, "cardinality.scale", "nodes")` работает
- Backward compatible — плоские атрибуты работают как раньше

**Оценка:** 1-2 дня (Rust изменение в `eval_attr()`)

### Фаза 1: Типы и Конфигурация

**Задача:** Создать типы `Cardinality`, `CardinalityConfig`, загрузку конфигурации.

**Acceptance Criteria:**
- Типы в `packages/types/src/cardinality.ts`
- Загрузка `.grafema/cardinality.json`
- Валидация конфигурации

**Оценка:** 2 дня

### Фаза 2: CardinalityEnricher

**Задача:** Плагин, который добавляет `metadata.cardinality` к нодам.

**Acceptance Criteria:**
- Entry points получают cardinality из конфигурации
- Transform chains (filter/map/flatMap) propagate cardinality
- ITERATES_OVER edges получают cardinality от коллекции

**Оценка:** 3-4 дня

### Фаза 3: Стандартные Гарантии

**Задача:** Набор готовых Datalog rules для типичных complexity проблем.

**Acceptance Criteria:**
- `quadratic-nested-loops` — O(N^2) паттерны
- `cubic-nested-loops` — O(N^3) паттерны
- `large-collection-iteration` — итерация по scale:nodes
- Все в `.grafema/guarantees.yaml` (пользователь может отключить)

**Оценка:** 2 дня

### Фаза 4: UX Polish

**Задача:** Человеко-читаемый вывод, guided annotation.

**Acceptance Criteria:**
- Форматтер violations с кодом и рекомендациями
- `grafema annotate --cardinality` wizard
- `grafema check --coverage` для cardinality

**Оценка:** 2-3 дня

### Фаза 5: Escape Hatches

**Задача:** `@grafema-ignore cardinality`, baseline.

**Acceptance Criteria:**
- Inline suppression парсится
- Baseline file support
- `grafema audit --suppressions`

**Оценка:** 2 дня

---

## 6. Проверка Big-O Claims Джоэла

Joel написал:

> **Фаза 2:** Построение дерева CONTAINS: O(E), DFS: O(V), Генерация пар: O(d × L). **Итого: O(V + E)**

**Вердикт: КОРРЕКТНО.**

Но это не нужно как отдельная функция. Datalog query `nested_loops(X, Y)` выполнит тот же DFS под капотом.

> **Фаза 3:** Worklist iterations: O(V × H × E), где H — высота решётки. H = 7. **Итого: O(V × E)**

**Вердикт: КОРРЕКТНО, но ОVERENGINEERED.**

Полный worklist propagation нужен для global dataflow analysis. Для cardinality это overkill. В 90% случаев достаточно:
1. Entry points → annotated nodes
2. Transform chains (filter/map) → local propagation
3. ITERATES_OVER → loop receives cardinality

Это O(E) на практике, не O(V × E).

> **Фаза 4:** Перебор пар: O(P), где P — число вложенных пар. **Итого: O(d × L)**

**Вердикт: КОРРЕКТНО.**

Но опять же, это просто Datalog query. Не нужна отдельная функция.

---

## 7. Итоговые Рекомендации

### 7.1 Что ДЕЛАТЬ

1. **Fix `attr()` в Datalog** — blocker, без этого ничего не работает
2. **Создать типы и конфигурацию** — из плана Joel, это хорошо
3. **Написать CardinalityEnricher** — плагин, не engine
4. **Написать Datalog rules** — декларативно, не императивно
5. **UX polish** — форматтер, wizard, из плана Steve

### 7.2 Что НЕ ДЕЛАТЬ

1. ~~Создавать "Analysis Engine"~~ — Datalog это и есть engine
2. ~~Писать `findNestedLoops()`~~ — это Datalog query
3. ~~Писать `propagateCardinality()`~~ — enricher делает проще
4. ~~Создавать отдельную CLI команду~~ — `grafema check` достаточно
5. ~~Создавать отдельный MCP tool~~ — `check_guarantees` достаточно

### 7.3 Пересмотренная Оценка

| Фаза | Название | Оригинал | Пересмотр |
|------|----------|----------|-----------|
| 0 | Fix attr() | — | 1-2 дня |
| 1 | Типы и конфигурация | 2-3 дня | 2 дня |
| 2 | CardinalityEnricher | 5-7 дней | 3-4 дня |
| 3 | Datalog rules | — | 2 дня |
| 4 | UX polish | 3-4 дня | 2-3 дня |
| 5 | Escape hatches | 2-3 дня | 2 дня |
| — | ~~Nested loops analysis~~ | 3-4 дня | 0 |
| — | ~~Complexity estimation~~ | 3-4 дня | 0 |
| — | ~~MCP integration~~ | 3-4 дня | 0 |

**Оригинал Joel: 21-29 дней**
**Пересмотр: 12-15 дней**

Экономим ~2 недели, убирая лишнее.

---

## 8. Архитектурная Диаграмма (Пересмотренная)

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONFIGURATION                                │
│  .grafema/cardinality.json                                      │
│  - scales: { nodes: { typical: "100K" } }                       │
│  - entryPoints: { "graph.queryNodes": "nodes" }                 │
│  - transforms: { "Array.filter": "preserve" }                   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CARDINALITY ENRICHER                           │
│  1. Read config                                                  │
│  2. Find entry point nodes                                       │
│  3. Add metadata.cardinality to nodes                           │
│  4. Propagate through transform chains                          │
│  5. Update ITERATES_OVER edges                                  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GRAPH (RFDB)                                │
│  NODE: { id, type, metadata: { cardinality: {...} } }           │
│  EDGE: ITERATES_OVER with cardinality reference                 │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   DATALOG GUARANTEES                             │
│  violation(X) :- node(X, "LOOP"),                               │
│                  edge(X, C, "ITERATES_OVER"),                   │
│                  attr(C, "cardinality.scale", "nodes").         │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   GUARANTEE MANAGER                              │
│  - check() → violations                                          │
│  - export/import YAML                                           │
│  - drift detection                                              │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        CLI / MCP                                 │
│  grafema check                                                   │
│  grafema check --guarantee quadratic-loops                      │
│  MCP: check_guarantees                                          │
└─────────────────────────────────────────────────────────────────┘
```

Это **простая архитектура**. Один enricher, Datalog rules, существующая инфраструктура.

Сравни с Joel'овским планом: 4 отдельных модуля (nestedLoops, propagation, complexity, warnings), отдельная CLI команда, отдельный MCP tool.

**Простота побеждает.**

---

## 9. Заключение

Joel проделал хорошую исследовательскую работу. Типы правильные, Big-O корректный, UX продуман. **Но он спроектировал систему так, будто GuaranteeManager не существует.**

Grafema уже имеет:
- Datalog engine
- GuaranteeManager
- YAML export/import
- CLI `grafema check`
- MCP `check_guarantees`

Cardinality Tracking — это **enricher + rules**, не "Complexity Analysis Engine".

**Следующий шаг:** Создать тикет на fix `attr()` nested paths. Это blocker для всего остального.

---

*"Talk is cheap. Show me the code."*
*— Linus Torvalds*

P.S. Joel, не обижайся. Твой план хороший. Просто мы уже построили инфраструктуру для этого. Используй её.
