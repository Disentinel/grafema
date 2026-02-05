# REG-323: ExpressRouteAnalyzer: использовать semantic ID вместо line/column для HANDLED_BY

## Контекст

REG-322 исправлен прагматичным способом — post-filter по line+column. Но архитектурно правильнее использовать semantic ID.

## Текущее состояние

ExpressRouteAnalyzer находит handler function по line+column:

```typescript
for await (const fn of graph.queryNodes({ type: 'FUNCTION', file })) {
  if (fn.line === handlerLine && fn.column === handlerColumn) {
    // create HANDLED_BY edge
  }
}
```

## Проблема

Line/column — это location-based identification, которое:

* Может сломаться при форматировании кода
* Не соответствует философии semantic ID (стабильные идентификаторы)

## Желаемое состояние

ExpressRouteAnalyzer вычисляет semantic ID handler'а и делает прямой lookup:

```typescript
const handlerId = computeSemanticId('FUNCTION', funcName, scopeContext);
const handler = await graph.getNode(handlerId);
if (handler) {
  // create HANDLED_BY edge
}
```

## Требования

1. ExpressRouteAnalyzer должен уметь вычислять scope context для handler AST node
2. Нужно правильно определять `anonymous[N]` индекс
3. Либо переиспользовать логику из JSASTAnalyzer, либо создать shared utility

## Acceptance Criteria

- [ ] HANDLED_BY edge создаётся через semantic ID lookup
- [ ] Не используется line/column для поиска
- [ ] Работает для named и anonymous handlers
