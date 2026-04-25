# REG-229: Argument-to-parameter binding

## Problem

При вызове функции нет связи между аргументами вызова и параметрами функции.

```typescript
function processNode(data) {
  console.log(data.type)  // откуда пришло data?
}

processNode(nodeInfo)  // nodeInfo должен быть связан с data
```

Сейчас Grafema не может ответить "какие значения могут попасть в параметр `data`?"

## Solution

При обработке CallExpression:

1. Найти definition вызываемой функции
2. Связать аргументы с параметрами через RECEIVES_ARGUMENT edge

```
nodeInfo ──PASSES_TO_PARAMETER──> data (parameter)
```

## Technical Details

* Нужен enrichment phase (после analysis), т.к. функция может быть определена в другом файле
* Использовать CALLS edge чтобы найти target function
* Матчить аргументы по позиции (и по имени для named/object args)

## Acceptance Criteria

- [ ] RECEIVES_ARGUMENT edges connect call arguments to function parameters
- [ ] Works for direct function calls
- [ ] Works for method calls
- [ ] Works for arrow functions and callbacks
- [ ] `trace` command can follow through function boundaries

## Blocker For

REG-222: grafema schema export (POC for data flow analysis)
