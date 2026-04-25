# REG-421: Infra — Graph snapshot tests for refactoring safety net

## Цель

Создать behavior-locking тесты, которые фиксируют **точный** набор nodes и edges, производимых анализатором. Это safety net для всего последующего рефакторинга в REG-331.

## Что делаем

1. **Golden file fixtures** — набор JS/TS файлов покрывающих все конструкции:
   * Функции, стрелки, классы, методы
   * Control flow: if/else, loops, switch, try/catch
   * Mutations: array push, object assign, variable reassignment
   * Calls: method calls, HOF, new expressions, promise patterns
   * Imports/exports, destructuring, template literals
2. **Snapshot test runner** — для каждой fixture:
   * Запуск `analyzeModule` → получение всех nodes + edges
   * Сравнение с golden file (сохранённый JSON)
   * При первом запуске — создание golden file
   * При последующих — strict equality check
3. **Granular snapshots** — не один гигантский JSON, а отдельные snapshots по категориям:
   * `functions.json`, `scopes.json`, `calls.json`, `mutations.json`, `control-flow.json` и т.д.
   * Это позволяет при рефакторинге одного handler'а проверять только его категорию

## Acceptance Criteria

- [ ] Fixture files покрывают все node types, которые создаёт JSASTAnalyzer
- [ ] Fixture files покрывают все edge types, которые создаёт GraphBuilder
- [ ] Snapshot тесты проходят на текущем коде
- [ ] Любое изменение в nodes/edges вызывает fail теста
- [ ] Команда для обновления golden files (когда изменение намеренное)

## Блокирует

- REG-422: Refactor JSASTAnalyzer.ts — Extract Function Body Handlers
- REG-423: Refactor GraphBuilder.ts — Extract Domain Builders
- REG-424: Refactor CallExpressionVisitor.ts — Reduce Complexity
- REG-425: Refactor ReactAnalyzer.ts — Reduce Complexity
