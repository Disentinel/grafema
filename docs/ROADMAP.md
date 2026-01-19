# Navi Roadmap: Реализация GDD

Технический план реализации методологии Graph-Driven Development.

---

## Текущее состояние

### Готово (Core)

- ✅ **ReginaFlowDB** — Rust graph database с колоночным хранилищем
- ✅ **Граф кода** — FUNCTION, CLASS, MODULE, CALL, VARIABLE, PARAMETER
- ✅ **Namespaced типы** — http:route, db:query, socketio:*, event:*
- ✅ **String types** — node_type и edge_type как строки с Levenshtein валидацией
- ✅ **NAPI bindings** — полная интеграция Rust ↔ Node.js
- ✅ **Версионирование** — main / __local
- ✅ **PathValidator** — прототип проверки reachability
- ✅ **Orchestrator** — pipeline анализа с батчевой обработкой
- ✅ **Плагины анализа** — JS AST, Express, Socket.IO, Database, Fetch

### Готово (Call Resolution & Data Flow)

- ✅ **AliasTracker** — транзитивное отслеживание алиасов (killer feature)
- ✅ **ValueDomainAnalyzer** — abstract inference, value set analysis
- ✅ **Path-Sensitive CFG** — constraints на SCOPE нодах, getValueSetAtNode()
- ✅ **PARAMETER nodes** — параметры функций с HAS_PARAMETER, PASSES_ARGUMENT
- ✅ **Edge metadata** — argIndex, isSpread и др. метаданные на рёбрах
- ✅ **EvalBanValidator** — security инвариант запрета eval/Function
- ✅ **ShadowingDetector** — детекция cross-file shadowing

### Готово (MCP Server) — Фаза 5 ✅

- ✅ **MCP Server** — stdio транспорт, автоматический анализ
- ✅ **Core Tools**: query_graph, find_calls, trace_alias, check_invariant, analyze_project
- ✅ **Value Analysis Tools**: get_value_set (path-sensitive), trace_data_flow, get_stats
- ✅ **Discovery Tools**: discover_services, get_analysis_status
- ✅ **Logging** — .rflow/mcp.log

### Готово (Tests)

- ✅ **296/297 tests pass** (1 skipped, occasional flaky)
- ✅ **Cross-platform build** — macOS (.dylib) и Linux (.so)

---

## Фаза 1: Основа для гарантий

**Цель:** Инфраструктура для хранения и проверки гарантий.

### 1.1. Guarantee как тип узла

**Задача:** Добавить поддержку guarantee узлов в граф.

```
guarantee:queue#orders
guarantee:api#users
guarantee:permission#s3-write
```

**Файлы:**
- `src/v2/core/nodes/NodeKind.js` — добавить guarantee:* типы
- `src/v2/core/nodes/GuaranteeNode.js` — создать класс
- `rust-engine/src/graph/engine.rs` — поддержка в find_by_type

**Поля guarantee узла:**
- `priority`: critical | important | observed | tracked
- `status`: discovered | reviewed | active | changing | deprecated
- `owner`: string (team/person)
- `schema`: JSON (для queue/api contracts)
- `condition`: string (для rules)

### 1.2. Связь governs

**Задача:** Связь между гарантией и кодом который она покрывает.

```
guarantee:queue#orders --governs--> queue:publish#order-api#...
guarantee:queue#orders --governs--> queue:consume#processor#...
```

**Файлы:**
- `src/v2/storage/backends/ReginaFlowBackend.js` — добавить edge type `GOVERNS` в KNOWN_EDGE_TYPES
- Или использовать namespaced `guarantee:governs`

### 1.3. Guarantee storage API

**Задача:** CRUD операции для гарантий.

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

**Файлы:**
- `src/v2/api/GuaranteeAPI.js` — новый файл

---

## Фаза 2: Автоматический вывод гарантий

**Цель:** Плагины для обнаружения гарантий из кода.

### 2.1. Queue Contract Discovery

**Задача:** Находить publish/consume и выводить схемы.

**Анализ:**
1. Найти все `channel.publish()`, `channel.sendToQueue()` → producers
2. Найти все `channel.consume()` → consumers
3. Извлечь имена очередей
4. Связать producers ↔ consumers по имени очереди

**Schema inference:**
```javascript
// Из кода:
channel.sendToQueue('orders', JSON.stringify({ orderId, items, userId }));

// Извлечь:
schema: { orderId: 'unknown', items: 'unknown', userId: 'unknown' }
```

**Файлы:**
- `src/v2/plugins/analysis/RabbitMQAnalyzer.js` — новый плагин
- `src/v2/plugins/enrichment/QueueContractInference.js` — вывод контрактов

### 2.2. Schema Inference из деструктуризации

**Задача:** Извлекать ожидаемые поля из деструктуризации.

```javascript
// Consumer code:
const { orderId, items, userId } = JSON.parse(msg.content);

// Inference:
expected_fields: ['orderId', 'items', 'userId']
```

**Расширенный inference через data flow:**
```javascript
if (typeof orderId !== 'string') throw new Error();
// → orderId: string

items.forEach(item => ...);
// → items: array
```

**Файлы:**
- `src/v2/plugins/enrichment/SchemaInference.js` — новый плагин
- Использовать существующий data flow tracking

### 2.3. API Contract Discovery

**Задача:** Выводить контракты для HTTP endpoints.

**Анализ:**
1. Найти все http:route узлы
2. Проверить наличие middleware (auth, validation)
3. Извлечь request/response schemas (если есть validation)

**Файлы:**
- `src/v2/plugins/enrichment/APIContractInference.js` — новый плагин

### 2.4. Permission Discovery

**Задача:** Находить AWS/cloud API calls.

**Анализ:**
1. Найти вызовы AWS SDK: `s3.putObject()`, `sqs.sendMessage()`
2. Извлечь action + resource (bucket name, queue name)
3. Создать `aws:s3:putObject#bucket-name` узлы

**Файлы:**
- `src/v2/plugins/analysis/AWSSDKAnalyzer.js` — новый плагин

---

## Фаза 3: Инфраструктурный слой

**Цель:** Анализ Terraform/K8s для связи code ↔ infra.

### 3.1. Terraform Parser

**Задача:** Парсить .tf файлы и строить граф ресурсов.

**Типы узлов:**
```
terraform:resource#aws_iam_role.processor
terraform:resource#aws_iam_role_policy.s3-access
terraform:resource#aws_sqs_queue.orders
```

**Связи:**
```
aws_iam_role_policy --attaches_to--> aws_iam_role
aws_ecs_task_definition --uses_role--> aws_iam_role
```

**Библиотеки:**
- `@cdktf/hcl2json` — парсинг HCL в JSON
- Или простой regex-based парсер для MVP

**Файлы:**
- `src/v2/plugins/infrastructure/TerraformParser.js` — новый плагин

### 3.2. IAM Policy Analyzer

**Задача:** Извлекать разрешения из IAM policies.

```hcl
resource "aws_iam_role_policy" "s3-access" {
  policy = jsonencode({
    Statement = [{
      Action   = ["s3:PutObject"]
      Resource = "arn:aws:s3:::reports-bucket/*"
    }]
  })
}
```

**В граф:**
```
iam:policy#s3-access
  └── allows: s3:PutObject on reports-bucket/*
```

**Файлы:**
- `src/v2/plugins/infrastructure/IAMPolicyAnalyzer.js` — новый плагин

### 3.3. Permission Path Tracer

**Задача:** Трассировка от AWS call до IAM policy.

```
aws:s3:putObject (code)
    ↓ belongs_to
SERVICE
    ↓ deployed_as (из Terraform)
ECS Task / Lambda
    ↓ assumes_role (из Terraform)
IAM Role
    ↓ has_policy (из Terraform)
IAM Policy
    ↓ allows
s3:PutObject on bucket/*
```

**Реализация:** BFS по связям с фильтрацией по типам.

**Файлы:**
- `src/v2/validation/PermissionValidator.js` — новый валидатор

---

## Фаза 4: Приоритизация

**Цель:** Автоматический расчёт приоритета гарантий.

### 4.1. Impact Score Calculator

**Задача:** Расчёт impact на основе достижимости.

```javascript
function calculateImpact(guaranteeId) {
  const governed = graph.getGoverned(guaranteeId);
  let maxScore = 0;

  for (const node of governed) {
    const reachable = graph.bfs(node, { edgeTypes: ['CALLS', 'WRITES'] });
    for (const r of reachable) {
      maxScore = Math.max(maxScore, getImpactScore(r.type));
    }
  }

  return maxScore;
}

const IMPACT_SCORES = {
  'http:route': 100,
  'db:query': 80,
  'queue:publish': 60,
  'FUNCTION': 10,
};
```

**Файлы:**
- `src/v2/plugins/enrichment/PriorityCalculator.js` — новый плагин

### 4.2. Monitoring Config Parser

**Задача:** Парсить конфиг мониторинга для priority hints.

```yaml
# monitoring/alerts.yaml
alerts:
  - metric: payment_success_rate
    pattern: "payment_*"
    level: CRIT
```

**Маппинг:**
- CRIT/URG → critical
- ERR → important
- WARN → observed

**Файлы:**
- `src/v2/plugins/infrastructure/MonitoringConfigParser.js` — новый плагин

### 4.3. Priority Aggregator

**Задача:** Комбинировать приоритеты из разных источников.

```javascript
function calculateFinalPriority(guaranteeId) {
  return Math.max(
    calculateImpact(guaranteeId),
    getMonitoringPriority(guaranteeId),
    getManualOverride(guaranteeId)
  );
}
```

---

## Фаза 5: MCP Server ✅ DONE

**Цель:** API для интеграции с Claude Code и другими агентами.

### 5.1. MCP Server Setup ✅

- [x] `src/mcp/server.js` — MCP сервер с @modelcontextprotocol/sdk
- [x] stdio транспорт для интеграции с Claude Code
- [x] Автоматический анализ при подключении
- [x] Поддержка существующей БД

### 5.2. Core Tools ✅

**Реализованные tools:**

| Tool | Описание |
|------|----------|
| `query_graph` | Выполнить Datalog запрос на графе кода |
| `find_calls` | Найти все вызовы функции/метода |
| `trace_alias` | Трассировка алиаса до источника |
| `check_invariant` | Проверка инварианта через Datalog |
| `analyze_project` | Анализ/переанализ проекта |
| `get_value_set` | Анализ множества значений переменной (path-sensitive) |
| `trace_data_flow` | Трассировка data flow от источника |
| `get_stats` | Статистика проекта |
| `discover_services` | Обнаружение сервисов в проекте |
| `get_analysis_status` | Статус текущего анализа |

**Конфиг для Claude Code:**
```json
{
  "mcpServers": {
    "navi": {
      "command": "node",
      "args": ["src/mcp/server.js", "--project", "/path/to/project"],
      "cwd": "/path/to/navi"
    }
  }
}
```

### 5.3. Proactive Tools (TODO)

**find_similar_patterns** — поиск похожих паттернов (для Guarantee система)

**verify_no_regressions** — проверка регрессий (требует Guarantee инфраструктуру)

---

## Фаза 6: UI

**Цель:** Web интерфейс для управления гарантиями.

### 6.1. Dashboard

- Health overview: violations, warnings, healthy count
- Filter by priority, status, owner
- Search guarantees

### 6.2. Guarantee Detail View

- Schema visualization
- Governed code locations
- History of changes
- Related guarantees

### 6.3. Change Request Flow

- Create change request form
- Impact analysis display
- Approval workflow
- Migration progress tracking

### 6.4. Discovery Review

- List of discovered guarantees
- Bulk actions: activate, dismiss, defer
- Priority assignment

---

## Приоритеты реализации

### Готово ✅

- [x] **MCP Server** — query_graph, find_calls, trace_alias, check_invariant, get_value_set, trace_data_flow

### MVP (минимум для демо) — NEXT

1. **Guarantee узлы** — хранение в графе (Фаза 1)
2. **Queue Contract Discovery** — RabbitMQ анализ (Фаза 2.1)
3. **Schema Inference** — базовый из деструктуризации (Фаза 2.2)
4. **MCP Tools для гарантий** — get_guarantees, check_guarantee (Фаза 5.3)

### Следующий этап

5. **Terraform Parser** — IAM policies
6. **Permission Validator** — проверка paths
7. **Priority Calculator** — автоматический

### Полная версия

8. **Monitoring Config** — priority из alerts
9. **UI Dashboard** — управление гарантиями
10. **Proactive Tools** — get_implementation_context

---

## Зависимости

```
Фаза 1 (Guarantee storage)
    │
    ├──► Фаза 2 (Discovery)
    │        │
    │        └──► Фаза 4 (Priority)
    │
    ├──► Фаза 3 (Infrastructure)
    │        │
    │        └──► Фаза 4 (Priority)
    │
    └──► Фаза 5 (MCP Server)
             │
             └──► Фаза 6 (UI)
```

---

## Технический долг (текущий)

**Текущий статус тестов:** 296/297 pass ✅ (1 skipped)

### Закрыто

- [x] Рефакторинг edge types на строки (как node types) ✅
- [x] DataFlowTracking NewExpression test ✅
- [x] Reexports DEPENDS_ON edges ✅
- [x] PARAMETER nodes + HAS_PARAMETER edges ✅
- [x] PASSES_ARGUMENT edges с metadata ✅
- [x] Path-Sensitive CFG (ConditionParser, constraints) ✅
- [x] Cross-file shadowing detection ✅
- [x] Cross-platform Rust build (macOS/Linux) ✅

### Известные ограничения

- **Parameter usage inside function bodies**: `data.map()` не создаёт DERIVES_FROM → PARAMETER
  - Требует расширения JSASTAnalyzer для трекинга внутри function bodies
  - 1 тест пропущен в ParameterDataFlow.test.js

- **Scope-aware shadowing**: требует parentScopeId для переменных внутри функций
  - Текущая реализация детектит только cross-file shadowing

- **Flaky test**: редкий race condition при cleanup между тестами

---

## Метрики успеха

### Качество

- Precision: % выведенных гарантий которые реально полезны (target: >80%)
- Recall: % реальных контрактов которые обнаружены (target: >70%)
- False positive rate: < 20%

### Производительность

- Анализ 1000 файлов: < 30 секунд
- Incremental check: < 5 секунд
- MCP tool response: < 2 секунды

### Adoption

- Developers actively review discovered guarantees
- Change requests created through system
- AI agents use context tools
