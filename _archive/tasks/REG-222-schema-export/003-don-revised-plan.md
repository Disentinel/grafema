# Don Melton: REG-222 Revised Analysis

## Correct Understanding

**Это POC для core value proposition Grafema.**

Цель: доказать что Grafema может анализировать UNTYPED код и понимать "какие значения могут попасть в эту точку".

Если мы просто экспортируем статические TypeScript типы — это не доказывает ничего. Любой тул умеет читать типы.

Если Grafema через data flow analysis находит все возможные значения node/edge types — это доказывает её ценность для legacy/untyped кодовых баз.

## Current Capabilities

**Что Grafema УМЕЕТ сейчас:**
1. Трейсить переменные: `const x = 'FUNCTION'; addNode({type: x})` → можем проследить `x` до литерала
2. `ASSIGNED_FROM`, `DERIVES_FROM`, `FLOWS_INTO` edges для value flow
3. `ValueDomainAnalyzer` резолвит computed property access
4. `trace` команда следует по data flow backward/forward
5. `PASSES_ARGUMENT` edges для литералов в аргументах (REG-202)

**Что Grafema НЕ УМЕЕТ:**
1. **Object literal property analysis**: `{type: 'FUNCTION'}` — литерал внутри объекта не трекается отдельно
2. **Argument-to-parameter binding**: Нет связи между аргументом вызова и параметром функции
3. **Sink-based query**: Нет API "какие значения могут прийти в этот аргумент?"

## RFDB Integration Points (Sinks)

Ноды создаются в:
```typescript
// GraphBuilder.ts
this._bufferNode(nodeData)  // nodeData.type содержит тип ноды

// Данные приходят из:
// - FunctionVisitor: { type: 'FUNCTION', ... }
// - ClassVisitor: { type: 'CLASS', ... }
// - и т.д.
```

Edges создаются в:
```typescript
// GraphBuilder.ts
this._bufferEdge(edge)  // edge.type содержит тип edge

// Данные приходят из разных мест в GraphBuilder
```

## Feasibility Assessment

**Статус: НЕ РЕАЛИЗУЕМО с текущими возможностями**

### Путь данных для node types:

```
FunctionVisitor.ts:
  const info: FunctionInfo = { type: 'FUNCTION', ... }  // литерал в объекте
  collector.functions.push(info)                        // FLOWS_INTO array

JSASTAnalyzer.ts:
  return { functions: collector.functions, ... }        // return

GraphBuilder.ts:
  for (const func of functions) {
    this._bufferNode(funcData)                          // func.type используется
  }
```

### Что нужно чтобы это работало:

1. **LITERAL ноды для свойств объектов** — `{type: 'FUNCTION'}` должен создавать LITERAL ноду для `'FUNCTION'`
2. **HAS_PROPERTY edges** — связь от объекта к его свойствам
3. **Argument-parameter binding** — связь вызова функции с её параметрами
4. **Sink-based query API** — `grafema trace --to "addNode#arg0.type"`

## Product Gaps

### Gap 1: Object property literal tracking
**Проблема:** Литералы внутри object literals не создают LITERAL ноды.
```typescript
const obj = { type: 'FUNCTION' }  // 'FUNCTION' не трекается как LITERAL
```

### Gap 2: Argument-to-parameter binding
**Проблема:** Нет связи между аргументом при вызове и параметром функции.
```typescript
function addNode(data) { ... }
addNode(nodeData)  // нет edge: nodeData -> data parameter
```

### Gap 3: Sink-based value domain query
**Проблема:** Нет API чтобы спросить "какие значения могут прийти в этот sink?"
Нужен новый режим trace или query.

## Recommendation

**Статус: BLOCKED**

REG-222 заблокирован отсутствием необходимых capabilities.

### Предлагаемые задачи-блокеры:

1. **Object property literal tracking** — создавать LITERAL ноды для значений свойств объектов
2. **Argument-to-parameter binding** — связывать аргументы вызовов с параметрами функций
3. **Sink-based value query** — API для запроса "что может прийти в этот sink"

После реализации этих gaps, REG-222 станет возможным и будет убедительным POC.
