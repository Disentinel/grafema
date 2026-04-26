# REG-228: Object property literal tracking

## Problem

Литералы внутри object literals не создают LITERAL ноды и не трекаются в data flow.

```typescript
const obj = { type: 'FUNCTION', name: 'foo' }
// 'FUNCTION' и 'foo' не существуют как LITERAL ноды в графе
```

Это блокирует возможность ответить на вопрос "какие значения могут попасть в это свойство?"

## Solution

1. При анализе ObjectExpression создавать LITERAL ноды для значений свойств (StringLiteral, NumericLiteral, etc.)
2. Создавать HAS_PROPERTY edges: OBJECT_LITERAL -> LITERAL (или VARIABLE -> PROPERTY_VALUE)

## Example

```typescript
const config = { port: 3000, host: 'localhost' }
```

Должно создать:

* OBJECT_LITERAL node для `{ port: 3000, host: 'localhost' }`
* LITERAL node для `3000`
* LITERAL node для `'localhost'`
* HAS_PROPERTY edge: OBJECT_LITERAL -[port]-> LITERAL(3000)
* HAS_PROPERTY edge: OBJECT_LITERAL -[host]-> LITERAL('localhost')

## Acceptance Criteria

- [ ] Literal values in object properties create LITERAL nodes
- [ ] HAS_PROPERTY edges connect objects to their property values
- [ ] Works for nested objects
- [ ] `trace` command can follow through object properties

## Blocker For

REG-222: grafema schema export (POC for data flow analysis)
