# Guarantee Development Workflow

Гарантии — это Datalog правила, которые код должен соблюдать. Этот документ описывает процесс создания новых гарантий.

## Концепция

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   ANALYSIS   │ →   │  ENRICHMENT  │ →   │  GUARANTEES  │
├──────────────┤     ├──────────────┤     ├──────────────┤
│ Сырая        │     │ Семантические│     │ Datalog      │
│ структура    │     │ связи        │     │ запросы      │
│              │     │              │     │              │
│ http:route   │     │ HAS_ERROR_   │     │ violation(X) │
│ FUNCTION     │     │   HANDLER    │     │   :- ...     │
│ CALL         │     │ VALIDATES_   │     │              │
│              │     │   INPUT      │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

**Ключевой принцип**: Гарантии работают только с тем, что есть в графе. Если нужной информации нет — сначала нужно обогатить граф через анализаторы/enrichers.

## Workflow

### Step 1: Define Intent

Сформулируй что хочешь гарантировать на естественном языке:

> "Все HTTP endpoints должны иметь error handling"

> "Все входные данные от пользователя должны валидироваться"

> "Никакие SQL запросы не должны использовать string concatenation"

### Step 2: Draft Datalog Rule

Напиши правило так, как будто нужные данные уже есть в графе:

```prolog
% Все HTTP routes должны иметь error handler
violation(X) :-
  node(X, "http:route"),
  \+ edge(X, _, "HAS_ERROR_HANDLER").

% Все параметры из request должны валидироваться
violation(X) :-
  node(X, "PARAMETER"),
  attr(X, "source", "request"),
  \+ edge(X, _, "VALIDATED_BY").

% Никаких SQL инъекций
violation(X) :-
  node(X, "db:query"),
  attr(X, "has_concatenation", "true").
```

### Step 3: Validate Against Schema

Используй `check_guarantee_feasibility` чтобы проверить rule:

```javascript
// MCP tool: check_guarantee_feasibility
{
  "rule": "violation(X) :- node(X, \"http:route\"), \\+ edge(X, _, \"HAS_ERROR_HANDLER\")."
}

// Response:
// ⚠️ Rule has missing dependencies
//
// **Used in rule:**
//   Node types: http:route
//   Edge types: HAS_ERROR_HANDLER
//   Attributes: (none)
//
// **Missing edge types:**
//   ❌ "HAS_ERROR_HANDLER" — needs to be created in analyzer/enricher plugin
//
// **Next steps:**
//   1. Review docs/guarantee-workflow.md for the full workflow
//   2. Design the semantic model for missing types
//   3. Implement in appropriate analyzer/enricher plugin
//   4. Re-run this check
```

Результат показывает:
- ✅ `http:route` — есть (ExpressRouteAnalyzer)
- ❌ `HAS_ERROR_HANDLER` — нет в графе, нужно добавить

### Step 4: Design Semantic Model

Ответь на вопросы:

**Что это означает в контексте кода?**

Для "error handler" в Express это может быть:
- `try-catch` вокруг async handler
- `.catch()` в promise chain
- middleware с 4 параметрами `(err, req, res, next)`
- wrapper типа `express-async-handler`

**Как представить в графе?**

```
Edge: HAS_ERROR_HANDLER
From: http:route node
To: FUNCTION node (handler) или CALL node (wrapper)

Attributes:
- type: "try-catch" | "catch-chain" | "error-middleware" | "wrapper"
```

**Где эта информация в AST?**

- `TryStatement` wrapping the handler body
- `CallExpression` с `.catch()` как callee
- `FunctionExpression` с 4 параметрами

### Step 5: Find/Create Plugin

Определи где реализовать создание недостающих edges:

| Подход | Когда использовать |
|--------|-------------------|
| Расширить существующий анализатор | Логика тесно связана с тем что анализатор уже делает |
| Создать новый enricher | Логика независима, может применяться к разным node types |
| Создать validation plugin | Нужна только проверка, без создания edges |

**Пример: расширение ExpressRouteAnalyzer**

```javascript
// src/v2/plugins/analysis/ExpressRouteAnalyzer.js

analyzeRoute(routeNode, handlerAST) {
  // ... existing logic ...

  // Add error handler detection
  if (this.hasErrorHandling(handlerAST)) {
    this.graph.addEdge({
      type: 'HAS_ERROR_HANDLER',
      src: routeNode.id,
      dst: handlerNode.id,
      handlerType: this.detectHandlerType(handlerAST)
    });
  }
}

hasErrorHandling(ast) {
  // Check for try-catch
  if (this.hasTryCatch(ast)) return true;
  // Check for .catch() chain
  if (this.hasCatchChain(ast)) return true;
  // Check for wrapper like express-async-handler
  if (this.hasAsyncWrapper(ast)) return true;
  return false;
}
```

**Пример: новый enricher**

```javascript
// src/v2/plugins/enrichment/ErrorHandlerEnricher.js

export class ErrorHandlerEnricher extends EnrichmentPlugin {
  static id = 'error-handler-enricher';

  async enrich(graph) {
    for await (const route of graph.queryNodes({ type: 'http:route' })) {
      const handler = await this.findHandler(route);
      if (handler && this.hasErrorHandling(handler)) {
        await graph.addEdge({
          type: 'HAS_ERROR_HANDLER',
          src: route.id,
          dst: handler.id
        });
      }
    }
  }
}
```

### Step 6: Implement & Test

1. Добавь логику в плагин
2. Запусти анализ на тестовом проекте
3. Проверь что edges создаются:

```javascript
// MCP: query_graph
{
  "query": "violation(X) :- edge(X, _, \"HAS_ERROR_HANDLER\")."
}
// Должны появиться результаты
```

### Step 7: Create Guarantee

```javascript
// MCP: create_guarantee
{
  "id": "http-error-handling",
  "name": "HTTP Error Handling",
  "rule": "violation(X) :- node(X, \"http:route\"), \\+ edge(X, _, \"HAS_ERROR_HANDLER\").",
  "severity": "error",
  "governs": ["src/api/**/*.js", "src/routes/**/*.js"]
}
```

### Step 8: Verify & Export

```javascript
// MCP: check_guarantees
{ "id": "http-error-handling" }

// Result:
{
  "passed": false,
  "violations": [
    { "file": "src/api/users.js", "line": 45, "name": "GET /users/:id" }
  ]
}
```

Когда guarantee работает как ожидается:

```javascript
// MCP: export_guarantees
{ "path": ".rflow/guarantees.yaml" }
```

Закоммить в репозиторий:
```bash
git add .rflow/guarantees.yaml
git commit -m "Add HTTP error handling guarantee"
```

## Примеры гарантий

### API Security

```yaml
- id: auth-on-protected-routes
  name: Authentication on Protected Routes
  rule: |
    violation(X) :-
      node(X, "http:route"),
      attr(X, "path", P),
      protected_path(P),
      \+ edge(X, _, "HAS_AUTH_MIDDLEWARE").
  severity: error
  governs: ["src/api/**/*.js"]
```

Требует: `HAS_AUTH_MIDDLEWARE` edge, `protected_path/1` predicate

### Input Validation

```yaml
- id: validate-user-input
  name: User Input Validation
  rule: |
    violation(X) :-
      node(X, "PARAMETER"),
      attr(X, "source", "request.body"),
      \+ edge(_, X, "VALIDATES").
  severity: warning
  governs: ["src/**/*.js"]
```

Требует: `VALIDATES` edge, `source` attribute на PARAMETER nodes

### Database Safety

```yaml
- id: no-sql-injection
  name: No SQL String Concatenation
  rule: |
    violation(X) :-
      node(X, "db:query"),
      attr(X, "query_type", "raw"),
      edge(X, V, "DERIVES_FROM"),
      node(V, "VARIABLE"),
      attr(V, "tainted", "true").
  severity: error
  governs: ["src/**/*.js"]
```

Требует: taint tracking через `DERIVES_FROM`, `tainted` attribute

### Event Schema Compatibility

```yaml
- id: socketio-schema-match
  name: Socket.IO Event Schema Compatibility
  rule: |
    violation(X) :-
      node(X, "socketio:emit"),
      attr(X, "event", E),
      node(Y, "socketio:on"),
      attr(Y, "event", E),
      \+ schemas_compatible(X, Y).
  severity: error
  governs: ["src/**/*.js"]
```

Требует: schema extraction, `schemas_compatible/2` predicate

## Checklist для новой гарантии

- [ ] Intent сформулирован на естественном языке
- [ ] Datalog rule написан
- [ ] Проверено что есть в схеме графа
- [ ] Missing edges/attributes определены
- [ ] Семантическая модель спроектирована
- [ ] Плагин выбран/создан
- [ ] Реализация добавлена
- [ ] Тесты написаны
- [ ] Guarantee создан и проверен
- [ ] Экспортирован в YAML
- [ ] Закоммичен в репозиторий

## MCP Tools Reference

| Tool | Назначение |
|------|-----------|
| `get_schema` | Посмотреть доступные node/edge types |
| `query_graph` | Выполнить Datalog запрос |
| `check_guarantee_feasibility` | Проверить feasibility rule против схемы графа |
| `create_guarantee` | Создать новую гарантию |
| `list_guarantees` | Список всех гарантий |
| `check_guarantees` | Проверить гарантию(и) |
| `delete_guarantee` | Удалить гарантию |
| `export_guarantees` | Экспорт в YAML |
| `import_guarantees` | Импорт из YAML |
| `guarantee_drift` | Показать drift между графом и файлом |

## См. также

- [Datalog Cheat Sheet](./datalog-cheat-sheet.md)
- [Plugin Development Guide](./plugin-development.md)
- [Graph Schema](./graph-schema.md)
