# REG-322: HANDLED_BY edge находит неправильную anonymous function для http:route

## Проблема

ExpressRouteAnalyzer создаёт HANDLED_BY edge от http:route к неправильной anonymous function. Вместо handler функции находит анонимную функцию внутри другого handler.

### Пример

```typescript
// invitations.ts:199
router.post('/:id/accept',
  authenticateToken,
  idParamValidation,
  invitationAcceptValidation,
  async (req, res) => {  // <-- должен быть этот handler
    // ...
    const invitation = await new Promise((resolve, reject) => {  // <-- находит этот
      // ...
    });
  }
);
```

### Root Cause (предположение)

ExpressRouteAnalyzer использует location для поиска handler function, но:

1. Возможно берёт не последний аргумент (который обычно handler)
2. Или ищет первую анонимную функцию по line number без учёта вложенности
3. Или JSASTAnalyzer создаёт anonymous functions в неправильном порядке

### Impact

* Навигация по HANDLED_BY ведёт не туда
* Нельзя правильно проследить data flow от route к handler

### Файлы для исследования

* `packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`
* `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (нумерация anonymous functions)

### Acceptance Criteria

- [ ] HANDLED_BY edge ведёт к правильному handler (последний аргумент router method)
- [ ] Nested anonymous functions не путаются с route handlers
- [ ] Тесты покрывают scenario с nested anonymous functions
