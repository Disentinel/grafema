# REG-321: MAKES_REQUEST edge должен линковать и к function scope и к CALL node

## Проблема

MAKES_REQUEST edge от http:request привязывается только к high-level scope (FUNCTION), а не к конкретному CALL node который делает запрос.

### Текущее поведение

```
http:request ←MAKES_REQUEST← FUNCTION (fetchInvitations)
```

### Ожидаемое поведение

```
http:request ←MAKES_REQUEST← FUNCTION (fetchInvitations)
http:request ←MAKES_REQUEST← CALL (authFetch#0)
```

Или как минимум связь с CALL node, чтобы можно было точно определить где в функции делается запрос.

### Impact

* При навигации в VS Code видно только что функция делает запрос, но не видно конкретное место
* Для data flow tracing важно знать точный CALL node

### Файлы для исправления

* `packages/core/src/plugins/analysis/FetchAnalyzer.ts` — добавить MAKES_REQUEST edge к CALL node
