# Project Onboarding Guide

Это руководство поможет внедрить Navi в существующий проект и итеративно улучшать покрытие кода семантическим анализом.

## Обзор процесса

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   SETUP     │ →   │  ANALYZE    │ →   │   ASSESS    │ →   │ GUARANTEES  │ →   │    CI/CD    │
├─────────────┤     ├─────────────┤     ├─────────────┤     ├─────────────┤     ├─────────────┤
│ Настройка   │     │ Первый      │     │ Оценка      │     │ Создание    │     │ Интеграция  │
│ .rflow/     │     │ анализ      │     │ покрытия    │     │ инвариантов │     │ в pipeline  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

Все плагины включены по умолчанию ("batteries included"). Если используется библиотека для которой нет плагина — можно написать кастомный.

## Step 1: Начальная настройка

### 1.1 Структура директории

Navi хранит конфигурацию и данные в `.rflow/`:

```
your-project/
├── .rflow/
│   ├── config.json        # Конфигурация плагинов
│   ├── guarantees.yaml    # Гарантии (version controlled)
│   └── graph.rfdb         # База графа (gitignore)
├── src/
└── ...
```

### 1.2 Создание конфигурации

```bash
mkdir -p .rflow
```

Создайте `.rflow/config.json`:

```json
{
  "entryPoints": ["src/index.js"],
  "ignore": ["node_modules", "dist", "build", "*.test.js", "*.spec.js"]
}
```

По умолчанию включены все плагины — "batteries included". Плагины которые не находят релевантных паттернов просто ничего не делают.

**Встроенные плагины:**

| Фаза | Плагины | Что делают |
|------|---------|------------|
| Indexing | JSModuleIndexer | Строит дерево зависимостей модулей |
| Analysis | JSASTAnalyzer | Базовый AST: функции, классы, вызовы |
| | ExpressRouteAnalyzer | HTTP routes (Express) |
| | SocketIOAnalyzer | WebSocket события |
| | DatabaseAnalyzer | SQL/NoSQL запросы |
| | FetchAnalyzer | HTTP клиентские запросы |
| | ReactAnalyzer | React компоненты и хуки |
| Enrichment | MethodCallResolver | Разрешение method calls |
| | AliasTracker | Отслеживание алиасов переменных |
| | InstanceOfResolver | Определение типов через instanceof |
| | ValueDomainAnalyzer | Анализ возможных значений |
| | MountPointResolver | Разрешение mount points (Express) |
| | PrefixEvaluator | Вычисление префиксов путей |
| Validation | CallResolverValidator | Проверка разрешения вызовов |

### 1.3 Добавьте в .gitignore

```gitignore
# Navi
.rflow/graph.rfdb
.rflow/*.log
```

## Step 2: Первый анализ

### 2.1 Запуск анализа

```javascript
// MCP tool: analyze_project
{ "force": true }
```

Или через CLI:
```bash
node path/to/navi/src/cli.js analyze --project .
```

### 2.2 Проверка результатов

```javascript
// MCP tool: get_stats
{}

// Пример ответа:
// Nodes: 1,234 total
//   MODULE: 45
//   FUNCTION: 234
//   CALL: 567
//   VARIABLE: 388
// Edges: 2,456 total
//   CONTAINS: 890
//   CALLS: 123
//   DEPENDS_ON: 44
```

### 2.3 Проверка схемы

```javascript
// MCP tool: get_schema
{}

// Показывает все типы нод и edges в графе
```

## Step 3: Оценка покрытия

### 3.1 Найти "слепые зоны"

Запросы для поиска непокрытого кода:

```javascript
// Вызовы которые не разрешились (нет CALLS edge)
// MCP tool: query_graph
{
  "query": "violation(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"CALLS\")."
}

// Method calls которые не разрешились
{
  "query": "violation(X) :- node(X, \"METHOD_CALL\"), \\+ edge(X, _, \"CALLS\")."
}
```

### 3.2 Анализ по файлам

```javascript
// Найти файлы с наибольшим количеством неразрешённых вызовов
// MCP tool: query_graph
{
  "query": "violation(F) :- node(C, \"CALL\"), attr(C, \"file\", F), \\+ edge(C, _, \"CALLS\")."
}
```

### 3.3 Проверить используемые зависимости

Navi определяет зависимости по импортам (надёжнее чем package.json):

```javascript
// MCP tool: query_graph
// Найти все внешние зависимости (импорты не из проекта)
{
  "query": "violation(X) :- node(X, \"MODULE\"), attr(X, \"external\", \"true\")."
}
```

## Step 4: Метрики покрытия

Отслеживайте эти метрики:

```javascript
// 1. Call resolution rate
// MCP tool: get_stats показывает общее количество

// 2. Unresolved calls (должно уменьшаться)
{
  "query": "violation(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"CALLS\")."
}

// 3. Semantic coverage (HTTP routes, DB queries, etc.)
{
  "query": "violation(X) :- node(X, \"http:route\")."  // Сколько routes найдено
}
```

### 4.1 Когда писать кастомный плагин

Если:
- Используется библиотека для которой нет встроенного плагина (например Fastify, NestJS)
- Есть project-specific паттерны (custom ORM, internal frameworks)
- Нужна специфичная семантика

См. `get_documentation({ topic: "plugin-development" })` для гайда.

## Step 5: Создание гарантий

### 5.1 Начните с простых гарантий

После достижения хорошего покрытия, создайте базовые гарантии:

```javascript
// Запрет eval()
// MCP tool: create_guarantee
{
  "id": "no-eval",
  "name": "No eval() usage",
  "rule": "violation(X) :- node(X, \"CALL\"), attr(X, \"name\", \"eval\").",
  "severity": "error"
}

// Запрет console.log в production
{
  "id": "no-console-log",
  "name": "No console.log",
  "rule": "violation(X) :- node(X, \"METHOD_CALL\"), attr(X, \"object\", \"console\"), attr(X, \"method\", \"log\").",
  "severity": "warning",
  "governs": ["src/**/*.js"]
}
```

### 5.2 Проверьте гарантии

```javascript
// MCP tool: check_guarantees
{}
```

### 5.3 Экспортируйте для version control

```javascript
// MCP tool: export_guarantees
{}
```

```bash
git add .rflow/guarantees.yaml
git commit -m "Add code guarantees"
```

### 5.4 Сложные гарантии

Для сложных гарантий используйте workflow:

```javascript
// MCP tool: get_documentation
{ "topic": "guarantee-workflow" }
```

## Step 6: CI/CD интеграция

### 6.1 Проверка гарантий в CI

```yaml
# .github/workflows/navi.yml
name: Code Analysis
on: [push, pull_request]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx navi analyze --project .
      - run: npx navi check-guarantees --fail-on-violation
```

### 6.2 Pre-commit hook

```bash
#!/bin/bash
# .git/hooks/pre-commit

npx navi check-guarantees --fail-on-violation
```

## Чеклист внедрения

- [ ] Создана директория `.rflow/`
- [ ] Настроен `.rflow/config.json` (entryPoints, ignore)
- [ ] Добавлен `.rflow/graph.rfdb` в `.gitignore`
- [ ] Первый анализ выполнен
- [ ] Проверена схема графа (`get_schema`)
- [ ] Проверены метрики покрытия (unresolved calls)
- [ ] Созданы базовые гарантии
- [ ] Гарантии экспортированы в YAML
- [ ] Настроена CI/CD интеграция

## Troubleshooting

### Анализ занимает слишком много времени

- Проверьте `ignore` в конфигурации — исключите node_modules, dist, тесты
- Используйте `entryPoints` вместо анализа всех файлов

### Много неразрешённых вызовов

- Добавьте `MethodCallResolver` и `AliasTracker` в enrichment
- Проверьте есть ли плагины для используемых библиотек
- Некоторые динамические паттерны не могут быть разрешены статически

### Плагин не находит паттерны

- Проверьте что плагин добавлен в правильную фазу (analysis vs enrichment)
- Проверьте порядок плагинов — enrichers зависят от результатов analysis
- Посмотрите логи анализа для ошибок

## См. также

- `get_documentation({ topic: "guarantee-workflow" })` — создание гарантий
- `get_documentation({ topic: "plugin-development" })` — написание плагинов
- `get_documentation({ topic: "semantic-coverage" })` — покрытие семантикой
