# UX Дизайн: Онбординг Отслеживания Кардинальности

**Автор:** Steve Jobs (Product Design / Demo)
**Дата:** 2 февраля 2026
**Статус:** UX-исследование

---

## Философия

> "Design is not just what it looks like and feels like. Design is how it works."

Проблема холодного старта — это не техническая проблема. Это проблема **доверия**. Пользователь включает новую фичу и получает:
- Ничего (система молчит, потому что ничего не аннотировано)
- Шум (система кричит на всё подряд, потому что всё "unknown")

В обоих случаях пользователь думает: "Это не работает". И выключает.

**Наша задача:** За первые 30 секунд показать, что система умная. Что она понимает код. Что она даёт ценность без усилий.

---

## 1. First Run Experience

### 1.1 Принцип: Zero-Config Value

При первом включении система ДОЛЖНА показать что-то полезное. Не спрашивать конфигурацию. Не требовать аннотации. Показать результат.

### 1.2 Сценарий Первого Запуска

```bash
$ grafema complexity

Analyzing codebase...

Found 3 potential O(N^2) patterns without any configuration:

  1. src/reports/generate.js:47
     Nested loops over array parameters
     Inner: for (const item of items)      <- parameter, scale unknown
     Outer: for (const user of users)      <- parameter, scale unknown

     Risk: If both arrays are large (>10K), this becomes O(N^2)

  2. src/sync/reconcile.js:128
     Nested loops with database patterns
     Inner: for (const local of localRecords)     <- hint: "local*" pattern
     Outer: for (const remote of remoteRecords)   <- hint: "remote*" pattern

     This looks like a reconciliation loop.
     Common in sync code, but often a performance trap.

  3. src/import/parser.js:89
     Triple-nested loop detected
     Outer: for (const file of files)
     Middle: for (const block of file.blocks)
     Inner: for (const token of block.tokens)

     Depth: 3 levels. If files=1K, blocks=100, tokens=50 -> 5M ops

No cardinality annotations found.
Add annotations to get precise estimates: grafema complexity --init
```

### 1.3 Что Здесь Происходит

**Без единой аннотации** система:

1. **Находит структурные паттерны** — вложенные циклы всегда подозрительны
2. **Использует naming heuristics** — `local*` и `remote*` намекают на reconciliation
3. **Даёт контекст** — "common in sync code, but often a performance trap"
4. **Показывает математику** — 1K x 100 x 50 = 5M операций
5. **Предлагает следующий шаг** — `grafema complexity --init`

**Ключевая идея:** Показать паттерны, а не конкретные числа. Пользователь видит: "О, система понимает структуру моего кода. Она права, это reconciliation loop."

### 1.4 Режим Скептика

```bash
$ grafema complexity --skeptical

Only showing high-confidence issues (structural patterns):

  src/import/parser.js:89
  Triple-nested loop (depth=3)

  This is almost certainly O(N^3) or worse.
  Current estimates: unknown (no annotations)

  Even with conservative assumptions (100 elements each level):
  100 x 100 x 100 = 1,000,000 operations

  Action required:
  [ ] Confirm this is intentional: // @grafema-ok: intentional-nested-loops
  [ ] Add cardinality annotations for precise analysis
  [ ] Refactor to reduce nesting
```

Режим `--skeptical` для новых пользователей:
- Только high-confidence паттерны (структурные, не эвристические)
- Математика с консервативными предположениями
- Явные действия: confirm / annotate / refactor

---

## 2. Progressive Disclosure

### 2.1 Четыре Уровня Зрелости

```
Level 0: Structural Analysis (zero config)
   |
   | + naming heuristics
   v
Level 1: Pattern-Based Inference
   |
   | + entry point annotations
   v
Level 2: Scale-Aware Analysis
   |
   | + custom transformations
   v
Level 3: Full Cardinality Tracking
```

### 2.2 Level 0: Structural Analysis

**Что работает без конфигурации:**
- Поиск вложенных циклов (любой глубины)
- Поиск циклов внутри циклов разных функций (через call graph)
- Предупреждения о `.forEach` внутри `.forEach`
- Обнаружение `array.includes()` / `array.find()` в циклах

**Сообщения:**
```
Structural Warning: Linear search inside loop

  for (const user of users) {
    if (groups.includes(user.groupId)) {  // O(N) search inside O(M) loop
      ...
    }
  }

This is O(M x N) regardless of actual sizes.
Convert groups to Set for O(1) lookup: new Set(groups)
```

### 2.3 Level 1: Pattern-Based Inference

**Автоматически включается** после создания `.grafema/` директории.

```bash
$ grafema complexity --init

Created .grafema/cardinality.json with smart defaults:

  Detected patterns:
    query*()     -> returns collection (inferred from name)
    fetch*()     -> returns collection (inferred from name)
    get*ById()   -> returns single item (inferred from name)
    find*()      -> returns single item (inferred from name)

  Detected database patterns:
    db.query()   -> returns collection (common pattern)
    db.find()    -> returns collection (common pattern)

  Your codebase uses these collection-returning methods:
    graph.queryNodes()  -> likely returns many items
    graph.queryEdges()  -> likely returns many items
    db.getUsers()       -> likely returns many items

Run 'grafema complexity' again to see improved analysis.
```

**Что изменилось:**
- Система использует naming conventions
- Предупреждения становятся конкретнее
- Появляется prompt для уточнения

### 2.4 Level 2: Scale-Aware Analysis

**Пользователь добавляет первые аннотации** (entry points):

```json
// .grafema/cardinality.json
{
  "scales": {
    "nodes": { "typical": "100K", "max": "10M" },
    "edges": { "typical": "500K", "max": "50M" }
  },
  "entryPoints": {
    "graph.queryNodes": { "returns": "nodes" },
    "graph.queryEdges": { "returns": "edges" }
  }
}
```

**Теперь предупреждения содержат числа:**

```
Complexity Warning: O(N x M) = ~50 billion operations

  const nodes = graph.queryNodes();     // scale:nodes (~100K)
  const edges = graph.queryEdges();     // scale:edges (~500K)
  for (const node of nodes) {
    for (const edge of edges) {         // <- 100K x 500K iterations
```

### 2.5 Level 3: Full Cardinality Tracking

**Для power users.** Полная конфигурация трансформаций:

```json
{
  "functions": {
    "groupBySource": {
      "transform": "reduce",
      "returns": { "scale": "nodes", "accessTime": "O(1)" }
    },
    "flatMapChildren": {
      "transform": "expand",
      "factor": { "scale": "constant", "typical": 5 }
    }
  }
}
```

---

## 3. Quick Wins: Немедленная Ценность

### 3.1 "Instant Insight" — Самый Простой Вход

```bash
$ grafema complexity src/problematic-file.js

Analyzing single file...

src/problematic-file.js
=======================

Line 47: Nested iteration
  Outer: users.forEach()
  Inner: permissions.includes()
  Pattern: Linear search in loop
  Complexity: O(N x M)

Line 89: Triple nesting
  Levels: files -> blocks -> tokens
  Pattern: Tree traversal
  Complexity: O(N x M x K)

Line 134: Recursive call with collection
  Function: processNode() calls itself
  Each call iterates over: node.children
  Pattern: Tree recursion
  Complexity: O(N) where N = tree size

Summary:
  3 patterns found
  Worst case: Line 89 (triple nesting)

Quick fix suggestions:
  Line 47: groups = new Set(permissions)
  Line 89: Consider streaming or pagination
```

**Один файл. Одна команда. Мгновенный результат.**

### 3.2 "Did You Mean?" — Умные Подсказки

При первом использовании показываем связь с реальной проблемой:

```
$ grafema complexity

Tip: Your codebase has 12 nested loops.
     3 of them use collections returned by graph.query*() methods.

     If graph.queryNodes() returns ~100K nodes, these loops
     execute 100K+ iterations each.

     Want to tell me how big your graph is?
     Run: grafema complexity --annotate graph.queryNodes
```

### 3.3 Guided Annotation

```bash
$ grafema complexity --annotate graph.queryNodes

Let's annotate graph.queryNodes()

What does this function return?
  [1] A few items (1-100) — configuration, settings
  [2] Moderate collection (100-10K) — files, routes
  [3] Large collection (10K-1M) — records, users
  [4] Very large (1M+) — graph nodes, log entries
  [5] I don't know / varies

> 4

Good. How would you name this scale? (e.g., "nodes", "records")
> nodes

What's the typical size?
> 100K

Added to .grafema/cardinality.json:
  "graph.queryNodes": { "returns": "nodes", "typical": "100K" }

Re-analyzing with new information...
[Shows updated warnings with real numbers]
```

---

## 4. Annotation Assistance

### 4.1 Автоматический Анализ Entry Points

```bash
$ grafema complexity --suggest-annotations

Analyzing your codebase for annotation candidates...

High-value annotation targets (used in nested loops):

  1. graph.queryNodes() — used in 8 loops
     Suggested scale: "nodes" (common graph pattern)
     Add annotation? [Y/n]

  2. db.getUsers() — used in 5 loops
     Suggested scale: "users"
     Add annotation? [Y/n]

  3. api.fetchOrders() — used in 3 loops
     Suggested scale: "orders"
     Add annotation? [Y/n]

Low-value (not in critical paths):
  - config.getSettings() — used outside loops
  - utils.getConstants() — already O(1) access
```

### 4.2 Inference от Call Sites

```bash
$ grafema complexity --infer

Inferring cardinality from usage patterns...

processUsers(users) is called with:
  - db.getActiveUsers()     <- annotated: scale:users (~10K)
  - db.getAllUsers()        <- annotated: scale:users (~100K)
  - [testUser]              <- literal array: 1 item

Inference: processUsers() receives scale:users (pessimistic: ~100K)
Apply this inference? [Y/n]
```

### 4.3 Propagation Visualization

```bash
$ grafema complexity --trace graph.queryNodes

Tracing cardinality of graph.queryNodes()...

graph.queryNodes() → scale:nodes (~100K)
  │
  ├─> const nodes = graph.queryNodes()    [src/analyzer.js:12]
  │   │
  │   ├─> nodes.filter(isActive)          [src/analyzer.js:15]
  │   │   Result: scale:nodes (preserve)
  │   │   │
  │   │   └─> for (const node of filtered) [src/analyzer.js:18]
  │   │       Iterations: ~100K
  │   │       Contains: graph.queryEdges() → scale:edges
  │   │       WARNING: O(N x M) = ~50B operations
  │   │
  │   └─> nodes.map(toSummary)            [src/reporter.js:34]
  │       Result: scale:nodes (map 1:1)
  │
  └─> processNodes(graph.queryNodes())    [src/processor.js:56]
      Passed to function, tracks through parameter
```

---

## 5. Gamification: Coverage Meter

### 5.1 Почему Gamification

Аннотации — это инвестиция. Пользователь должен видеть прогресс. Чувствовать, что каждая аннотация делает систему умнее.

### 5.2 Coverage Dashboard

```bash
$ grafema complexity --coverage

Cardinality Coverage Report
===========================

Overall: ████████░░░░░░░░ 47%

Entry Points:
  Annotated:     12 / 28 (43%)
  Auto-inferred: 8
  Unknown:       8

Critical Paths (loops with unknown collections):
  Covered:       5 / 12 (42%)

  Uncovered critical paths:
    src/sync/reconcile.js:128  — 2 unknown collections
    src/reports/generate.js:47 — 1 unknown collection

Impact of Next Annotation:
  Annotating 'db.getRecords()' would cover:
    - 3 nested loops
    - 2 critical paths
    - +15% coverage

Suggested next: grafema complexity --annotate db.getRecords
```

### 5.3 Progress Milestones

```
Cardinality Tracking Progress
=============================

[x] Level 0: Structural analysis active
[x] Level 1: Pattern-based inference enabled
[ ] Level 2: Entry points annotated (12/28)
    Progress: ████████░░░░░░░░ 43%
    Next milestone: 50% (annotate 2 more)

[ ] Level 3: Critical paths covered (5/12)
    Progress: ████░░░░░░░░░░░░ 42%

Achievements:
  [x] First annotation added
  [x] 10 annotations
  [ ] 25 annotations
  [ ] All critical paths covered
  [ ] Zero unknown collections in hot paths
```

### 5.4 Team Leaderboard (для больших команд)

```
$ grafema complexity --team-stats

Cardinality Annotations by Team
================================

Frontend:    ████████████░░░░ 75% (Sarah +5 this week)
Backend:     ██████░░░░░░░░░░ 38% (needs attention)
Data:        ██████████░░░░░░ 62%
DevOps:      ████████████████ 100% (complete!)

Top Contributors This Sprint:
  1. @sarah     +12 annotations
  2. @mike      +8 annotations
  3. @alex      +5 annotations
```

---

## 6. Escape from Noise

### 6.1 Принцип: Сначала Тишина, Потом Звук

Новый пользователь не должен получить 500 warnings. Это убивает доверие.

**Стратегия:** Показываем от важного к менее важному.

### 6.2 Tiered Output

```bash
# Default: только critical (structural + large known collections)
$ grafema complexity
Found 2 critical issues

# Verbose: добавляет warnings
$ grafema complexity -v
Found 2 critical, 8 warnings

# Very verbose: добавляет hints
$ grafema complexity -vv
Found 2 critical, 8 warnings, 23 hints

# Everything (для CI)
$ grafema complexity --all
Found 2 critical, 8 warnings, 23 hints, 45 info
```

### 6.3 Smart Filtering

```bash
# Только файлы, которые я изменил
$ grafema complexity --changed

# Только новые проблемы (не было в прошлом коммите)
$ grafema complexity --new

# Исключить тесты и миграции
$ grafema complexity --exclude "tests/**,migrations/**"
```

### 6.4 Confidence-Based Filtering

```bash
$ grafema complexity --min-confidence high

Only showing issues with high confidence:
  - Based on annotated collections
  - Or structural patterns (triple nesting)

Hiding 15 issues with medium/low confidence.
Run with --min-confidence medium to see more.
```

### 6.5 Baseline для Legacy Codebases

```bash
# Создать baseline (игнорировать существующие проблемы)
$ grafema complexity --create-baseline
Created .grafema/complexity-baseline.json
Baseline contains 47 known issues

# Теперь показывает только новые
$ grafema complexity
No new complexity issues!
(47 known issues in baseline, use --include-baseline to see)

# Постепенно разбираем baseline
$ grafema complexity --baseline-progress
Baseline Progress: 47 -> 42 issues (-5 this week)
```

---

## 7. Три Персоны Пользователей

### 7.1 Persona 1: "Quick Checker" (Тимлид перед релизом)

**Потребность:** Быстро проверить, нет ли явных проблем.

**Сценарий:**
```bash
$ grafema complexity --quick

Quick Complexity Check
======================
Critical issues: 0
Warnings: 2 (known)

Status: PASS (no new issues)
```

**Время:** 5 секунд.

### 7.2 Persona 2: "Systematic Improver" (Tech Lead)

**Потребность:** Планомерно улучшать codebase.

**Сценарий:**
```bash
$ grafema complexity --coverage

Coverage: 47%
This week: +12%
Remaining critical paths: 7

Next high-impact annotation:
  graph.queryNodes() — would cover 3 loops

$ grafema complexity --annotate graph.queryNodes
[Interactive annotation wizard]
```

**Время:** 10-15 минут в неделю.

### 7.3 Persona 3: "Legacy Inheritor" (Новый разработчик)

**Потребность:** Понять чужой код, не сломать.

**Сценарий:**
```bash
$ grafema complexity src/critical-module/

This module has 3 complexity warnings:

  1. reconcileData() — O(N x M) nested loops
     This is KNOWN and ACCEPTED (see baseline)
     Reason: "Legacy reconciliation, refactor planned Q3"

  2. processRecords() — O(N^2) potential
     This is UNKNOWN — needs annotation or review

  3. generateReport() — O(N) with large collection
     This is MONITORED — works now, watch for growth

Before making changes, consider:
  - processRecords() needs attention
  - Touch reconcileData() carefully
```

---

## 8. Error Messages как UX

### 8.1 Принцип: Сообщение — это Диалог

Плохо:
```
Warning: O(N^2) complexity detected at line 47
```

Хорошо:
```
I found a potential O(N^2) pattern.

  for (const user of users) {
    for (const order of orders) {
      ────────────────────────
      This inner loop runs for EACH user.
      If you have 1000 users and 1000 orders,
      that's 1,000,000 iterations.

Why this matters:
  This code works fine with small data.
  It breaks at scale.

What you can do:
  1. Index orders by userId (O(1) lookup)
  2. Use database join instead of code loop
  3. Mark as intentional: // @grafema-ok: reconciliation
```

### 8.2 Контекстуальные Рекомендации

Система понимает паттерн и предлагает специфичное решение:

```
Pattern detected: Reconciliation Loop
  (matching local vs remote records)

This is a common pattern with a known solution:

  // Instead of O(N x M):
  for (const local of localRecords) {
    for (const remote of remoteRecords) {
      if (local.id === remote.id) ...

  // Use O(N + M):
  const remoteById = new Map(remoteRecords.map(r => [r.id, r]));
  for (const local of localRecords) {
    const remote = remoteById.get(local.id);
```

---

## 9. Демо Сценарий

> "Если я не могу показать это на сцене, это не готово."

### 9.1 30-Second Demo

```bash
# Clone любой JS проект
$ git clone github.com/example/medium-project
$ cd medium-project

# Одна команда
$ npx grafema complexity

# БЕЗ конфигурации показывает:
"Found 5 potential complexity issues..."
"Worst: src/sync.js has triple-nested loops..."
"Quick win: src/search.js uses .includes() in loop — use Set"
```

**Реакция:** "Вау, оно нашло проблему которую я знал, но забыл исправить!"

### 9.2 2-Minute Demo

```bash
# Добавляем одну аннотацию
$ grafema complexity --annotate db.getUsers
> Large collection (10K-1M)
> users
> 50K

# Запускаем снова
$ grafema complexity

# Теперь показывает конкретные числа:
"src/reports.js:47 — O(N^2) = ~2.5 billion operations"
"This will take approximately 4 minutes on production data"
```

**Реакция:** "4 минуты? Это объясняет почему отчёт тормозит!"

---

## 10. Метрики Успеха

### 10.1 North Star Metric

> **"Time to First Insight"** — время от `grafema complexity` до "а, понял, вот проблема!"

Target: < 10 секунд для structural issues, < 60 секунд для cardinality issues.

### 10.2 Adoption Funnel

```
Install grafema          100%
Run complexity once      ?%    <- Track this
Add first annotation     ?%    <- Track this
Reach 50% coverage       ?%    <- Track this
Use in CI                ?%    <- Track this
```

### 10.3 Quality Metrics

- False positive rate: < 10% на Level 1
- User-reported "это полезно": > 80%
- Annotation time: < 30 seconds per entry point

---

## 11. Заключение

### Ключевые Принципы

1. **Zero-Config Value** — работает из коробки, показывает структурные паттерны
2. **Progressive Disclosure** — от простого к сложному, по мере готовности пользователя
3. **Quick Wins** — мгновенная ценность для одного файла, одной команды
4. **Guided Annotation** — система ведёт за руку, не требует читать документацию
5. **Escape from Noise** — сначала тишина, потом звук, с контролем пользователя
6. **Error Messages as Dialogue** — объясняем, не ругаем

### Холодный Старт Решается

Проблема "ничего не аннотировано" решается так:

1. **Level 0 работает без аннотаций** — структурные паттерны всегда подозрительны
2. **Naming heuristics** — `query*` → collection, `get*ById` → single
3. **Guided annotation** — система сама предлагает что аннотировать
4. **Coverage meter** — видимый прогресс мотивирует продолжать
5. **Baseline** — legacy код не душит новичка

### Финальный Тест

> Если разработчик за 30 секунд не понял, зачем ему это нужно — мы провалились.

Grafema Cardinality должен быть как хороший врач:
- Не пугает без причины
- Объясняет понятным языком
- Предлагает конкретные действия
- Помнит историю пациента (baseline)
- Празднует прогресс (coverage meter)

---

*"Simple can be harder than complex. You have to work hard to get your thinking clean to make it simple."*

— Steve Jobs
*2 февраля 2026*
