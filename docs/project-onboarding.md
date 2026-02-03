# Project Onboarding Guide

Это руководство поможет внедрить Grafema в существующий проект и итеративно улучшать покрытие кода семантическим анализом.

## Обзор процесса

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   SETUP     │ →   │  ANALYZE    │ →   │   ASSESS    │ →   │ GUARANTEES  │ →   │    CI/CD    │
├─────────────┤     ├─────────────┤     ├─────────────┤     ├─────────────┤     ├─────────────┤
│ Настройка   │     │ Первый      │     │ Оценка      │     │ Создание    │     │ Интеграция  │
│ .grafema/   │     │ анализ      │     │ покрытия    │     │ инвариантов │     │ в pipeline  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

Все плагины включены по умолчанию ("batteries included"). Если используется библиотека для которой нет плагина — можно написать кастомный.

## Step 1: Начальная настройка

### 1.1 Инициализация

Самый простой способ начать:

```bash
grafema init
```

Это создаст `.grafema/config.yaml` с настройками по умолчанию.

### 1.2 Структура директории

Grafema хранит конфигурацию и данные в `.grafema/`:

```
your-project/
├── .grafema/
│   ├── config.yaml       # Конфигурация плагинов (version controlled)
│   ├── guarantees.yaml   # Гарантии (version controlled)
│   └── graph.rfdb        # База графа (gitignore)
├── src/
└── ...
```

### 1.3 Конфигурация

По умолчанию Grafema использует все встроенные плагины — "batteries included".
Плагины которые не находят релевантных паттернов просто ничего не делают.

Пример минимальной конфигурации `.grafema/config.yaml`:

```yaml
plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
    - ExpressRouteAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
```

Полный справочник конфигурации: [configuration.md](configuration.md)

**Встроенные плагины:**

| Фаза | Плагины | Что делают |
|------|---------|------------|
| Indexing | JSModuleIndexer | Строит дерево зависимостей модулей |
| Analysis | JSASTAnalyzer | Базовый AST: функции, классы, вызовы |
| | ExpressRouteAnalyzer | HTTP routes (Express) |
| | SocketIOAnalyzer | WebSocket события |
| | DatabaseAnalyzer | SQL/NoSQL запросы |
| | FetchAnalyzer | HTTP клиентские запросы |
| | ServiceLayerAnalyzer | Service layer паттерны |
| Enrichment | MethodCallResolver | Разрешение method calls |
| | AliasTracker | Отслеживание алиасов переменных |
| | ValueDomainAnalyzer | Анализ возможных значений |
| | MountPointResolver | Разрешение mount points (Express) |
| | PrefixEvaluator | Вычисление префиксов путей |
| | HTTPConnectionEnricher | Связь frontend requests с backend routes |
| Validation | EvalBanValidator | Запрет eval() и Function() |
| | SQLInjectionValidator | Детектирование SQL injection |
| | CallResolverValidator | Проверка разрешения вызовов |

### 1.4 Добавьте в .gitignore

```gitignore
# Grafema
.grafema/graph.rfdb
.grafema/rfdb.sock
```

`grafema init` автоматически добавляет эти строки в `.gitignore`.

## Step 2: Первый анализ

### 2.1 Запуск анализа

```bash
grafema analyze
```

Или через MCP:
```javascript
// MCP tool: analyze_project
{ "force": true }
```

### 2.2 Проверка результатов

```bash
grafema overview
```

Или через MCP:
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

Grafema определяет зависимости по импортам (надёжнее чем package.json):

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

См. [plugin-development.md](plugin-development.md) для гайда.

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
git add .grafema/guarantees.yaml
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
# .github/workflows/grafema.yml
name: Code Analysis
on: [push, pull_request]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx grafema analyze
      - run: npx grafema check-guarantees --fail-on-violation
```

### 6.2 Pre-commit hook

```bash
#!/bin/bash
# .git/hooks/pre-commit

npx grafema check-guarantees --fail-on-violation
```

## Чеклист внедрения

- [ ] Выполнен `grafema init`
- [ ] Настроен `.grafema/config.yaml` (при необходимости)
- [ ] Добавлен `.grafema/graph.rfdb` в `.gitignore`
- [ ] Первый анализ выполнен (`grafema analyze`)
- [ ] Проверена схема графа (`get_schema`)
- [ ] Проверены метрики покрытия (unresolved calls)
- [ ] Созданы базовые гарантии
- [ ] Гарантии экспортированы в YAML
- [ ] Настроена CI/CD интеграция

## Troubleshooting

### Анализ занимает слишком много времени

- Используйте `exclude` в конфигурации для исключения тестов и сгенерированного кода
- Используйте `include` для ограничения анализа конкретными директориями

### Много неразрешённых вызовов

- Проверьте что `MethodCallResolver` и `AliasTracker` включены в enrichment
- Проверьте есть ли плагины для используемых библиотек
- Некоторые динамические паттерны не могут быть разрешены статически

### Плагин не находит паттерны

- Проверьте что плагин добавлен в правильную фазу (analysis vs enrichment)
- Проверьте порядок плагинов — enrichers зависят от результатов analysis
- Используйте `--log-level debug` для детальных логов

## См. также

- [Configuration Reference](configuration.md) — полный справочник конфигурации
- [Guarantee Workflow](guarantee-workflow.md) — создание гарантий
- [Plugin Development](plugin-development.md) — написание плагинов
- [Semantic Coverage](semantic-coverage.md) — покрытие семантикой
