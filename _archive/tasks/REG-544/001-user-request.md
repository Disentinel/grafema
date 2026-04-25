# REG-544: Datalog: нет предиката parent_function(Call, Function) для CALL→FUNCTION traversal

## Источник
Linear issue REG-544, создан 2026-02-21

## Проблема

Нет удобного способа в Datalog найти родительскую функцию для CALL-ноды. Путь через граф: `CALL → parentScopeId → SCOPE → incoming CONTAINS → TRY_BLOCK/SCOPE → ... → FUNCTION` требует нескольких хопов и непрактичен в правилах.

## Нужно

Предикат `parent_function(CallId, FunctionId)` — прямая связь от CALL до ближайшей содержащей функции.

## Пример использования

```datalog
# Найти все функции, которые напрямую вызывают addNode
answer(FnName) :-
  node(C, "CALL"),
  attr(C, "method", "addNode"),
  parent_function(C, F),
  attr(F, "name", FnName).
```

Сейчас это требует ручного traversal через scope chain и не выражается в одном правиле.

## Варианты реализации

1. **Новый предикат в Datalog eval** — `parent_function(Node, Function)`: идёт вверх по CONTAINS edges до первой FUNCTION ноды
2. **Предвычисленное поле** `parentFunctionId` на CALL/EXPRESSION/SCOPE нодах (как уже есть `parentScopeId`)
3. **Вспомогательный предикат** `in_scope(Node, Scope)` + `scope_function(Scope, Function)`

## Контекст

Обнаружено при написании гарантии для REG-541. Хотели проверить "вызов addNode находится в функции которая является частью NodeFactory" — невозможно выразить в одном Datalog правиле.

## Acceptance Criteria
- Предикат `parent_function(NodeId, FunctionId)` доступен в Datalog правилах
- Работает для CALL нод (и желательно для других нод в теле функции)
- Пример из задачи работает корректно
- Тесты покрывают базовый случай и edge cases
