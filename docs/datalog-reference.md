# Datalog Query Reference

Справочник по Datalog запросам в Navi.

## Базовый синтаксис

```prolog
violation(X) :- <условия>.
```

- `violation(X)` — головная часть правила, X — переменная результата
- `:-` — "если" (условия справа должны выполняться)
- `.` — конец правила

## Предикаты

### node/2 — Поиск нод по типу

```prolog
node(X, "TYPE")
```

| Параметр | Описание |
|----------|----------|
| X | Переменная, связывается с ID ноды |
| "TYPE" | Тип ноды в кавычках |

**Примеры:**
```prolog
% Все функции
violation(X) :- node(X, "FUNCTION").

% Все HTTP routes
violation(X) :- node(X, "http:route").

% Все вызовы
violation(X) :- node(X, "CALL").
```

**Типы нод:**

| Категория | Типы |
|-----------|------|
| Структура | `MODULE`, `FUNCTION`, `CLASS`, `METHOD`, `VARIABLE`, `PARAMETER` |
| Вызовы | `CALL`, `METHOD_CALL`, `EXPRESSION` |
| HTTP | `http:route`, `http:request`, `http:api` |
| Database | `db:query`, `db:table` |
| WebSocket | `socketio:emit`, `socketio:on` |
| React | `react:component`, `react:hook` |
| Meta | `GUARANTEE` |

### edge/3 — Поиск связей

```prolog
edge(Src, Dst, "TYPE")
```

| Параметр | Описание |
|----------|----------|
| Src | Переменная или ID исходной ноды |
| Dst | Переменная или ID целевой ноды |
| "TYPE" | Тип связи в кавычках |

**Примеры:**
```prolog
% Функции которые вызывают eval
violation(F) :-
  node(F, "FUNCTION"),
  edge(F, C, "CONTAINS"),
  node(C, "CALL"),
  attr(C, "name", "eval").

% Модули которые зависят от express
violation(M) :-
  node(M, "MODULE"),
  edge(M, E, "DEPENDS_ON"),
  attr(E, "name", "express").
```

**Типы связей:**

| Категория | Типы |
|-----------|------|
| Структура | `CONTAINS`, `DEPENDS_ON` |
| Вызовы | `CALLS`, `PASSES_ARGUMENT`, `HAS_PARAMETER` |
| Данные | `ASSIGNED_FROM`, `DERIVES_FROM` |
| Типы | `INSTANCE_OF` |
| HTTP | `USES_MIDDLEWARE`, `HANDLED_BY` |
| Гарантии | `GOVERNS`, `VIOLATES` |

### attr/3 — Проверка атрибутов

```prolog
attr(Node, "attribute", Value)
```

| Параметр | Описание |
|----------|----------|
| Node | Переменная или ID ноды |
| "attribute" | Имя атрибута в кавычках |
| Value | Переменная или конкретное значение в кавычках |

**Примеры:**
```prolog
% Функции с именем "handleClick"
violation(X) :-
  node(X, "FUNCTION"),
  attr(X, "name", "handleClick").

% Вызовы в конкретном файле
violation(X) :-
  node(X, "CALL"),
  attr(X, "file", "/src/api/users.js").

% HTTP routes с методом POST
violation(X) :-
  node(X, "http:route"),
  attr(X, "method", "POST").
```

**Распространённые атрибуты:**

| Атрибут | Описание | Пример значения |
|---------|----------|-----------------|
| `name` | Имя элемента | `"handleClick"` |
| `file` | Путь к файлу | `"/src/index.js"` |
| `line` | Номер строки | `42` |
| `method` | HTTP метод | `"GET"`, `"POST"` |
| `path` | URL путь | `"/users/:id"` |
| `object` | Объект method call | `"console"` |
| `async` | Асинхронная функция | `"true"` |

## Переменные

- Начинаются с заглавной буквы: `X`, `Y`, `Module`, `Func`
- `_` — анонимная переменная (игнорируется)

```prolog
% X — результат, Y — промежуточная переменная
violation(X) :-
  node(X, "CALL"),
  edge(X, Y, "CALLS"),
  node(Y, "FUNCTION").

% _ — нам не важен ID целевой ноды
violation(X) :-
  node(X, "CALL"),
  edge(X, _, "CALLS").
```

## Negation (отрицание)

```prolog
\+ условие
```

**Примеры:**
```prolog
% Вызовы которые НЕ разрешились
violation(X) :-
  node(X, "CALL"),
  \+ edge(X, _, "CALLS").

% Функции БЕЗ документации (если бы был такой атрибут)
violation(X) :-
  node(X, "FUNCTION"),
  \+ attr(X, "documented", "true").

% Модули которые НЕ тестируются
violation(X) :-
  node(X, "MODULE"),
  \+ edge(_, X, "TESTS").
```

## Комбинирование условий

Все условия соединяются через `,` (AND):

```prolog
% Все условия должны выполняться
violation(X) :-
  node(X, "CALL"),           % И это
  attr(X, "name", "eval"),   % И это
  attr(X, "file", F),        % И это
  \+ attr(F, "test", "true"). % И это
```

## Паттерны запросов

### Найти все ноды определённого типа

```prolog
violation(X) :- node(X, "FUNCTION").
```

### Найти ноды с атрибутом

```prolog
violation(X) :-
  node(X, "CALL"),
  attr(X, "name", "eval").
```

### Найти связанные ноды

```prolog
% Функции и их вызовы
violation(X) :-
  node(F, "FUNCTION"),
  edge(F, X, "CONTAINS"),
  node(X, "CALL").
```

### Найти ноды БЕЗ связи

```prolog
% Вызовы без разрешения
violation(X) :-
  node(X, "CALL"),
  \+ edge(X, _, "CALLS").
```

### Найти цепочки

```prolog
% Модуль → Функция → Вызов eval
violation(M) :-
  node(M, "MODULE"),
  edge(M, F, "CONTAINS"),
  node(F, "FUNCTION"),
  edge(F, C, "CONTAINS"),
  node(C, "CALL"),
  attr(C, "name", "eval").
```

### Группировка по атрибуту

```prolog
% Уникальные файлы с проблемами
violation(F) :-
  node(X, "CALL"),
  \+ edge(X, _, "CALLS"),
  attr(X, "file", F).
```

## Примеры запросов

### Безопасность

```prolog
% Использование eval
violation(X) :-
  node(X, "CALL"),
  attr(X, "name", "eval").

% Использование Function constructor
violation(X) :-
  node(X, "CALL"),
  attr(X, "name", "Function").

% SQL с конкатенацией строк (если есть атрибут)
violation(X) :-
  node(X, "db:query"),
  attr(X, "has_concatenation", "true").
```

### Качество кода

```prolog
% console.log в production коде
violation(X) :-
  node(X, "METHOD_CALL"),
  attr(X, "object", "console"),
  attr(X, "method", "log").

% Неиспользуемые функции (нет входящих CALLS)
violation(X) :-
  node(X, "FUNCTION"),
  \+ edge(_, X, "CALLS").

% Большие функции (если бы был атрибут lineCount)
violation(X) :-
  node(X, "FUNCTION"),
  attr(X, "lineCount", L),
  L > 100.
```

### API анализ

```prolog
% Все HTTP endpoints
violation(X) :-
  node(X, "http:route").

% POST endpoints без валидации (если бы был edge)
violation(X) :-
  node(X, "http:route"),
  attr(X, "method", "POST"),
  \+ edge(X, _, "VALIDATES_INPUT").

% Endpoints без аутентификации
violation(X) :-
  node(X, "http:route"),
  \+ edge(X, _, "HAS_AUTH_MIDDLEWARE").
```

### Зависимости

```prolog
% Внешние зависимости
violation(X) :-
  edge(M, X, "DEPENDS_ON"),
  node(M, "MODULE"),
  \+ node(X, "MODULE").

% Циклические зависимости (упрощённо, A→B→A)
violation(A) :-
  edge(A, B, "DEPENDS_ON"),
  edge(B, A, "DEPENDS_ON").
```

### Покрытие

```prolog
% Неразрешённые вызовы
violation(X) :-
  node(X, "CALL"),
  \+ edge(X, _, "CALLS").

% Неразрешённые method calls
violation(X) :-
  node(X, "METHOD_CALL"),
  \+ edge(X, _, "CALLS").

% Файлы с неразрешёнными вызовами
violation(F) :-
  node(X, "CALL"),
  \+ edge(X, _, "CALLS"),
  attr(X, "file", F).
```

## Debugging запросов

### Запрос ничего не возвращает

1. Проверьте типы — используйте `get_schema` для списка существующих типов
2. Проверьте атрибуты — возможно атрибут называется иначе
3. Упростите запрос — уберите условия по одному

```javascript
// Проверить существует ли тип
get_schema()

// Проверить feasibility правила
check_guarantee_feasibility({
  rule: "violation(X) :- node(X, \"NONEXISTENT\")."
})
```

### Слишком много результатов

Добавьте фильтры:

```prolog
% Ограничить по файлу
violation(X) :-
  node(X, "CALL"),
  attr(X, "file", "/src/api/users.js").

% Ограничить по паттерну имени (если поддерживается)
violation(X) :-
  node(X, "FUNCTION"),
  attr(X, "name", N),
  starts_with(N, "handle").
```

### Explain mode

```javascript
// MCP tool: query_graph с explain
{
  "query": "violation(X) :- node(X, \"CALL\"), attr(X, \"name\", \"nonexistent\").",
  "explain": true
}

// Покажет пошаговое выполнение:
// Step 1: node(X, "CALL") → 567 results
// Step 2: attr(X, "name", "nonexistent") → 0 results
// ← Проблема на шаге 2
```

## Ограничения

1. **Нет рекурсии** — нельзя писать рекурсивные правила
2. **Нет агрегации** — нельзя считать COUNT, SUM и т.п.
3. **Нет OR** — только AND через `,`
4. **Нет сравнений** — `>`, `<`, `=` ограниченно поддерживаются

## См. также

- `get_documentation({ topic: "guarantee-workflow" })` — использование в гарантиях
- `get_documentation({ topic: "semantic-coverage" })` — запросы для анализа покрытия
- MCP tool `get_schema` — список типов в графе
- MCP tool `check_guarantee_feasibility` — проверка валидности правила
