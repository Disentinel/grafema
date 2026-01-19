# Advanced Routing Test Fixture

Этот fixture тестирует сложные сценарии Express роутинга.

## Структура файлов

```
src/
├── index.js                    # Главный файл с app.use()
├── routes/
│   ├── inline-router.js        # Inline router (роутер в том же файле)
│   ├── nested-parent.js        # Родительский роутер с вложенным
│   ├── nested-child.js         # Дочерний роутер
│   └── shared-router.js        # Роутер с множественным mounting
└── middleware/
    └── auth.js                 # Middleware без префикса
```

## Сценарии тестирования

### Сценарий #1: app.use() без префикса (middleware)
```javascript
app.use(authMiddleware);
app.use(loggingMiddleware);
```

**Ожидаемое поведение:**
- Создаются MOUNT_POINT ноды БЕЗ prefix (или prefix = '/')
- Не влияет на endpoints (это middleware, не router)

### Сценарий #2: Nested routers
```javascript
// nested-parent.js
router.use('/child', nestedChild);

// index.js
app.use('/api/nested', nestedParent);
```

**Ожидаемые endpoints:**
- `GET /api/nested/` (из nested-parent.js)
- `GET /api/nested/child/` (из nested-child.js)
- `POST /api/nested/child/action` (из nested-child.js)

**Граф:**
```
MOUNT_POINT(/api/nested) → nested-parent.js
  MOUNT_POINT(/child) → nested-child.js
    ENDPOINT(GET /) → fullPath = /api/nested/child/
    ENDPOINT(POST /action) → fullPath = /api/nested/child/action
  ENDPOINT(GET /) → fullPath = /api/nested/
```

### Сценарий #3: Inline router
```javascript
// inline-router.js
const router = express.Router();
router.get('/', ...);

// index.js
app.use('/api/inline', inlineRouter);
```

**Ожидаемые endpoints:**
- `GET /api/inline/`
- `POST /api/inline/`
- `GET /api/inline/:id`

**Проблема:** targetVariable = 'inlineRouter', но это default export из модуля.
Нужно связать import с inline router в файле.

### Сценарий #4: Variable-based prefix
```javascript
const API_VERSION = '/api/v3';
const resourcesPath = '/resources';
app.use(API_VERSION + resourcesPath, sharedRouter);
```

**Ожидаемое поведение:**
- Prefix детектируется как выражение (не простая строка)
- Можно вычислить статически через AST анализ BinaryExpression
- Или пометить как `prefix: '${API_VERSION}${resourcesPath}'` для sandbox eval

**Ожидаемые endpoints после eval:**
- `GET /api/v3/resources/`
- `GET /api/v3/resources/:id`

### Сценарий #5: Multiple mount points
```javascript
app.use('/api/v1/shared', sharedRouter);
app.use('/api/v2/shared', sharedRouter);
```

**Ожидаемое поведение:**
- Endpoints из shared-router.js должны иметь **НЕСКОЛЬКО** fullPath вариантов
- Или создавать отдельные ENDPOINT ноды для каждого mount point

**Ожидаемые endpoints:**
- `GET /api/v1/shared/` (из shared-router.js)
- `GET /api/v1/shared/:id` (из shared-router.js)
- `GET /api/v2/shared/` (из shared-router.js)
- `GET /api/v2/shared/:id` (из shared-router.js)

## Граф статистика

### Ожидаемые ноды:
- **MODULE**: 6 (index.js, 3 routes, 1 middleware, shared-router дважды не считается)
- **MOUNT_POINT**: 7
  - 2 middleware (authMiddleware, loggingMiddleware)
  - 1 для inline-router
  - 1 для nested-parent
  - 1 для nested-child (внутри nested-parent)
  - 3 для shared-router (v1, v2, v3)
- **ENDPOINT**: 11
  - 3 из inline-router (GET /, POST /, GET /:id)
  - 1 из nested-parent (GET /)
  - 2 из nested-child (GET /, POST /action)
  - 2 из shared-router × 3 mount points = 6 (или 2 ноды с multiple fullPath)
  - 1 health check

### Ожидаемые edges:
- **MOUNTS**: 7 (каждый MOUNT_POINT → MODULE)
- **EXPOSES**: 11 (каждый MODULE → ENDPOINT)
- **DEFINES**: 7 (MODULE → MOUNT_POINT)

## Текущее покрытие MVP

### Что РАБОТАЕТ:
- ✅ Простой mount с функцией из импорта

### Что НЕ РАБОТАЕТ:
- ❌ app.use() без префикса (сценарий #1)
- ❌ Nested routers (сценарий #2)
- ❌ Inline router через default export (сценарий #3)
- ❌ Variable-based prefix (сценарий #4)
- ❌ Multiple mount points (сценарий #5)
