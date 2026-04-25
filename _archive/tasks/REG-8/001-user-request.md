# REG-8: 1.3. Guarantee storage API

## Request

CRUD операции для гарантий.

```javascript
// Создание
await graph.createGuarantee({
  type: 'guarantee:queue',
  name: 'orders',
  priority: 'critical',
  schema: { orderId: 'string', items: 'array' },
  governs: ['queue:publish#...', 'queue:consume#...']
});

// Поиск
const guarantees = await graph.findGuarantees({
  type: 'guarantee:queue',
  priority: 'critical'
});

// Проверка
const violations = await graph.checkGuarantee('guarantee:queue#orders');
```

## Files

* `src/v2/api/GuaranteeAPI.js` — новый файл

## Context

This is part of the Guarantee system (parent task REG-335). We need to implement the storage API for guarantees that allows:
1. Creating guarantees with type, name, priority, schema, and governed nodes
2. Finding guarantees by criteria
3. Checking guarantee violations
