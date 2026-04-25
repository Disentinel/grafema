# REG-230: Sink-based value domain query

## Problem

Нет API чтобы ответить на вопрос "какие значения могут прийти в эту точку (sink)?"

Например: "Какие значения могут быть в `data.type` при вызове `addNode(data)`?"

## Solution

Новый режим `trace` или отдельная команда:

```bash
# Найти все значения которые могут попасть в первый аргумент addNode, свойство type
grafema trace --to "addNode#0.type"

# Или через query
grafema query "TRACE_TO addNode ARGUMENT 0 PROPERTY type"
```

## Algorithm

1. Найти все call sites для target function (addNode)
2. Для каждого call site найти аргумент по индексу
3. Если аргумент — объект, найти свойство по имени
4. Trace backward от этого значения до всех LITERAL sources
5. Собрать уникальные значения

## Output Example

```json
{
  "sink": "addNode#0.type",
  "possible_values": [
    { "value": "FUNCTION", "sources": ["FunctionVisitor.ts:45"] },
    { "value": "CLASS", "sources": ["ClassVisitor.ts:32"] },
    { "value": "VARIABLE", "sources": ["VariableVisitor.ts:78"] }
  ]
}
```

## Acceptance Criteria

- [ ] API to query possible values at a sink point
- [ ] Supports function arguments as sinks
- [ ] Supports object property access (arg.property)
- [ ] Returns all possible literal values with source locations
- [ ] Deterministic output (sorted, for diffing)

## Blocker For

REG-222: grafema schema export (POC for data flow analysis)
