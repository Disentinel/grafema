# Don Melton - Root Cause Analysis

## Executive Summary

**NodeCreationValidator фундаментально неспособен решить поставленную задачу.** Он работает на уровне построенного графа, ища вызовы `addNode`/`addNodes` и проверяя их аргументы. Но реальная проблема в том, что inline объекты создаются в ДРУГИХ местах (`_bufferNode()`, `push()`, etc.), а в `addNodes()` передаётся уже собранный массив.

## Detailed Analysis

### 1. Как работает NodeCreationValidator

Валидатор ищет в графе:
1. CALL ноды с `method === 'addNode'` или `method === 'addNodes'`
2. Через PASSES_ARGUMENT edges находит аргументы
3. Проверяет что аргументы (OBJECT_LITERAL) созданы через NodeFactory

### 2. Как реально создаются ноды в GraphBuilder

```typescript
// GraphBuilder.ts line 51-53
private _bufferNode(node: GraphNode): void {
  this._nodeBuffer.push(node);  // <-- inline literal здесь
}

// GraphBuilder.ts line 65-73
private async _flushNodes(graph: GraphBackend): Promise<number> {
  if (this._nodeBuffer.length > 0) {
    await graph.addNodes(this._nodeBuffer);  // <-- только переменная, не literal
    ...
  }
}
```

### 3. Почему валидатор не ловит нарушения

| Что ищет валидатор | Что реально в коде |
|--------------------|--------------------|
| `graph.addNode({ type: ... })` с inline literal | `graph.addNodes(this._nodeBuffer)` с переменной |
| OBJECT_LITERAL в аргументах addNode/addNodes | Inline literals в `push()` и `_bufferNode()` |

Валидатор ищет inline литералы в аргументах `addNode`/`addNodes`, но:
1. В `addNodes()` передаётся **переменная** `_nodeBuffer`
2. Inline литералы создаются в `_bufferNode()` и `push()`
3. Валидатор **не отслеживает** data flow через массивы

### 4. Масштаб проблемы

Inline объекты создаются во многих местах:

| Файл | Метод/Место | Тип нарушения |
|------|-------------|---------------|
| GraphBuilder.ts | `_bufferNode()`, `_bufferEdge()` | Все ноды/edges |
| GraphBuilder.ts | Все `bufferX` методы | Inline literals |
| JSASTAnalyzer.ts | `functions.push({...})` | FunctionInfo |
| JSASTAnalyzer.ts | `scopes.push({...})` | ScopeInfo |
| JSASTAnalyzer.ts | `callSites.push({...})` | CallSiteInfo |
| JSASTAnalyzer.ts | `variableDeclarations.push({...})` | VariableInfo |
| Visitors | Все visitor классы | Собирают данные |

## Root Cause

**Архитектурная ошибка:** Валидатор был спроектирован для простых случаев `graph.addNode({...})`, но реальная архитектура использует:
1. Visitor pattern для сбора данных (inline objects)
2. Batch buffer для оптимизации записи
3. GraphBuilder для преобразования info → nodes

## Solution Options

### Option A: Fix Validator (Complex, High Effort)
Переписать валидатор чтобы он отслеживал data flow через массивы:
- Отслеживать `.push()` вызовы
- Трассировать откуда приходят элементы массивов
- **Проблема:** Требует полного data flow анализа, сложно и ненадёжно

### Option B: Static Analysis (Recommended)
Использовать TypeScript/ESLint для проверки на этапе компиляции:
- ESLint правило: запретить inline objects в определённых контекстах
- TypeScript: строгая типизация через NodeFactory return types
- **Преимущество:** Работает до runtime, ловит ошибки сразу

### Option C: Refactor Architecture (Root Fix)
Изменить архитектуру так, чтобы NodeFactory был единственной точкой входа:
1. Все visitors вызывают `NodeFactory.createX()` вместо создания inline objects
2. GraphBuilder получает уже созданные через фабрику ноды
3. Валидатор становится ненужным - TypeScript гарантирует корректность

**Рекомендация:** Option C - это правильный архитектурный подход.

## Approach that Caused the Problem

### 1. Локальная оптимизация без глобального видения
- Добавлен `_bufferNode()` для batch writes (хорошо для производительности)
- Но inline objects остались (нарушает NodeFactory гарантию)
- Никто не проверил совместимость с existing invariants

### 2. Отсутствие enforcement на уровне типов
- NodeFactory создаёт правильные ноды, но его использование не обязательно
- Можно создать объект напрямую и всё скомпилируется
- TypeScript не заставляет использовать фабрику

### 3. Валидатор создан post-hoc
- Сначала код, потом попытка его валидировать
- Правильный подход: сначала гарантия (типы), потом код

## Workflow Changes Required

### 1. TDD for Invariants
**До написания кода:**
- Определить инварианты (все ноды через NodeFactory)
- Закодировать их в типах TypeScript
- Написать тесты проверяющие инвариант

### 2. Type-Level Enforcement
```typescript
// Запретить создание NodeRecord напрямую
// Только через NodeFactory.createX() методы
type NodeRecord = ReturnType<typeof NodeFactory['createFunction']>
                | ReturnType<typeof NodeFactory['createModule']>
                | ...;
```

### 3. Architecture Review Before Optimization
При добавлении оптимизаций (batch writes):
1. Проверить влияние на existing invariants
2. Обновить валидаторы если нужно
3. Добавить тесты на сохранение инвариантов

## Next Steps

1. Создать Linear issues для рефакторинга каждого типа нод
2. Начать с высокоприоритетных (FUNCTION, MODULE, CALL)
3. Обновить типы для type-level enforcement
4. Удалить или переписать NodeCreationValidator после рефакторинга
