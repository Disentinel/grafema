# GDD: Graph-Driven Development / Guarantee-Driven Development

**Методология разработки программных систем через автоматически выводимые и верифицируемые гарантии**

---

## Оглавление

1. [Введение и мотивация](#1-введение-и-мотивация)
2. [Ключевые концепции](#2-ключевые-концепции)
3. [Архитектура системы](#3-архитектура-системы)
4. [Типы гарантий](#4-типы-гарантий)
5. [Жизненный цикл гарантии](#5-жизненный-цикл-гарантии)
6. [Приоритизация](#6-приоритизация)
7. [Интеграция с AI-агентами](#7-интеграция-с-ai-агентами)
8. [Примеры использования](#8-примеры-использования)
9. [Сравнение с существующими подходами](#9-сравнение-с-существующими-подходами)
10. [Заключение](#10-заключение)

---

## 1. Введение и мотивация

### 1.1. Проблема современной разработки

Разработка и эволюция программных систем традиционно рассматриваются как эвристический, слабо формализуемый процесс. Изменения в коде принимаются на основе локальных соображений и человеческого опыта. Несмотря на наличие формальных методов, автоматического тестирования и инструментов статического анализа, большая часть архитектурных и эволюционных решений остаётся неявной.

В современных распределённых системах и монорепозиториях эта проблема усугубляется:

- **Масштаб**: миллионы строк кода, сотни сервисов
- **Связность**: изменение в одном сервисе может сломать десятки других
- **Неявность**: контракты между компонентами существуют как "устные договорённости"
- **Скорость**: требуется быстрая итерация без потери стабильности

### 1.2. Наблюдение

В любой существующей системе можно обнаружить набор устойчивых свойств, которые сохраняются при большинстве изменений. Эти свойства проявляются в:

- Структуре кода (допустимые пути вызовов, владение данными)
- Контрактных ограничениях (схемы данных, API, очереди)
- Инфраструктурных зависимостях (permissions, сетевые политики)
- Поведенческих закономерностях (latency, error rates)

Мы называем такие свойства **гарантиями системы**.

### 1.3. Ключевая идея GDD

GDD предлагает рассматривать гарантии как объекты первого класса, определяющие и направляющие процесс разработки. Название отражает двойственность подхода:

- **Graph-Driven**: граф кода и инфраструктуры как основа для анализа
- **Guarantee-Driven**: проверяемые гарантии как цель и результат

Эволюция системы формулируется как задача перехода от текущего состояния к новому, удовлетворяющему изменённому набору гарантий, при сохранении обязательных существующих свойств.

### 1.4. Для кого эта методология

GDD разработан для:

- **Разработчиков**: понимание последствий изменений до merge
- **Tech Leads/Архитекторов**: формализация архитектурных решений
- **Product Managers**: участие в управлении техническими рисками
- **AI-агентов**: структурированный контекст для автономной разработки

---

## 2. Ключевые концепции

### 2.1. Граф системы

Программная система представляется в виде многослойного аннотированного графа:

```
┌─────────────────────────────────────────────────────────────┐
│  Слой кода                                                  │
│  • Функции, классы, модули                                  │
│  • Call graph, data flow                                    │
│  • Типы: FUNCTION, CLASS, MODULE, CALL, VARIABLE           │
│  • Namespaced типы: http:route, db:query, queue:publish    │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ связи принадлежности
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Слой инфраструктуры                                        │
│  • Сервисы, deployments, IAM roles                         │
│  • Terraform resources, K8s manifests                       │
│  • Связи: service → role → policy                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ связи измерения
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Слой observability                                         │
│  • Метрики, алерты, SLO                                    │
│  • Трейсы, логи                                            │
│  • Связи: code → metric → alert                            │
└─────────────────────────────────────────────────────────────┘
```

### 2.2. Гарантия (Guarantee)

Гарантия — это формализованное утверждение о поведении системы, которое:

- **Проверяемо**: можно автоматически определить выполняется ли
- **Версионируемо**: имеет историю изменений
- **Приоритизировано**: имеет уровень критичности
- **Владеемо**: имеет ответственную команду/человека

Гарантии делятся на два класса:

**Наблюдаемые (Observed)** — автоматически выведенные из текущего состояния системы:
- "Сервис A публикует в очередь X сообщения с полями {a, b, c}"
- "Endpoint /api/users защищён middleware auth"
- "Функция processOrder достигает db:query"

**Требуемые (Required)** — явно заданные как целевые ограничения:
- "Все endpoints /api/* должны требовать авторизацию"
- "Схема очереди orders не должна меняться без approval"
- "Latency p99 для /api/checkout < 500ms"

### 2.3. Терминология

Вместо академических терминов GDD использует практичный словарь:

| Академический термин | GDD термин | Описание |
|---------------------|------------|----------|
| Инвариант | Guarantee | Гарантия поведения |
| Предикат | Check | Проверка условия |
| Нарушение | Breaking change | Изменение ломающее гарантию |
| Формальная спецификация | Contract | Контракт между компонентами |

Контексты использования:
- **Contract** — межсервисные соглашения (очереди, API)
- **Rule** — внутренние ограничения (архитектурные, security)
- **Guarantee** — внешние обещания (что продукт гарантирует клиенту)

### 2.4. Трансформация

Изменение системы описывается как последовательность трансформаций графа. Каждая трансформация:

- Локальна (затрагивает ограниченное число узлов)
- Проверяема (можно определить какие гарантии затронуты)
- Версионируема (создаёт новую версию затронутых узлов)

Версионирование позволяет сравнивать состояния "до" и "после":

```
main     — текущее production состояние
__local  — состояние после предлагаемых изменений
```

---

## 3. Архитектура системы

### 3.1. Обзор компонентов

```
┌─────────────────────────────────────────────────────────────┐
│  Интерфейсы                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │  IDE/CLI    │ │  Web UI     │ │  CI/CD      │           │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘           │
│         │               │               │                   │
│         └───────────────┼───────────────┘                   │
│                         │                                   │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  MCP Server (Model Context Protocol)                │   │
│  │  • Инструменты для AI-агентов                      │   │
│  │  • API для интеграций                               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Ядро анализа                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Orchestrator                                        │   │
│  │  • Координация анализа                              │   │
│  │  • Pipeline: Discovery → Indexing → Analysis →      │   │
│  │              Enrichment → Validation                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Плагины анализа                                    │   │
│  │  • JSASTAnalyzer — базовый анализ JS/TS            │   │
│  │  • ExpressAnalyzer — HTTP routes                   │   │
│  │  • QueueAnalyzer — RabbitMQ, Kafka, SQS           │   │
│  │  • DatabaseAnalyzer — SQL queries                  │   │
│  │  • AWSSDKAnalyzer — AWS API calls                  │   │
│  │  • TerraformParser — инфраструктура                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Плагины вывода гарантий                            │   │
│  │  • SchemaInference — схемы из деструктуризации     │   │
│  │  • ContractLinker — связь code ↔ infra             │   │
│  │  • PriorityCalculator — автоприоритизация          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Хранилище                                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Graph Database (ReginaFlowDB)                      │   │
│  │  • Граф кода (nodes + edges)                        │   │
│  │  • Гарантии как узлы графа                         │   │
│  │  • Версионирование (main / __local)                │   │
│  │  • BFS/DFS для path queries                        │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2. Граф как единое хранилище

Гарантии хранятся в том же графе, что и код:

```
# Гарантия как узел графа
guarantee:queue#orders
  ├── type: guarantee:queue
  ├── priority: critical
  ├── status: active
  ├── schema: {orderId: string, items: array, userId: string}
  └── owner: @backend-team

# Связи с кодом
guarantee:queue#orders ──governs──▶ queue:publish#order-api#...
guarantee:queue#orders ──governs──▶ queue:consume#processor#...
```

Преимущества единого графа:
- Версионирование гарантий вместе с кодом
- Запросы через единый интерфейс
- Трассировка влияния изменений

### 3.3. MCP Server

Model Context Protocol обеспечивает интеграцию с AI-агентами и инструментами:

**Основные инструменты:**

| Инструмент | Назначение |
|------------|-----------|
| `analyze_changes` | Анализ влияния изменений в файлах |
| `get_guarantees` | Получение гарантий по scope/priority |
| `check_guarantee` | Проверка конкретной гарантии |
| `propose_change` | Создание запроса на изменение гарантии |
| `diff_versions` | Сравнение версий гарантий |
| `get_implementation_context` | Контекст для реализации задачи |

---

## 4. Типы гарантий

### 4.1. Контрактные гарантии (Contracts)

Формализуют соглашения между компонентами системы.

#### Очереди сообщений

Гарантии на схему и структуру сообщений в очередях:

**Что анализируется:**
- Вызовы publish/send с сериализацией JSON
- Обработчики consume/receive с деструктуризацией
- Имена очередей, routing keys, exchanges

**Что гарантируется:**
- Совместимость схем: поля отправляемые ⊇ поля ожидаемые
- Наличие обработчиков для всех публикуемых очередей
- Сохранение backward compatibility при изменениях

**Пример гарантии:**
```
Queue: orders
Producers: order-api, admin-service
Consumers: order-processor, analytics, notifications

Schema (inferred):
  Required: {orderId, items, userId}
  Optional: {metadata, timestamp}

Guarantee: All producers send at least {orderId, items, userId}
Priority: CRITICAL (breaking change = incident)
```

#### API контракты

Гарантии на HTTP/gRPC endpoints:

**Что анализируется:**
- Определения routes с методами и paths
- Middleware chains (auth, validation, rate limiting)
- Request/response schemas

**Что гарантируется:**
- Сохранение публичных endpoints
- Наличие required middleware
- Backward compatibility response schemas

#### Файловые форматы

Гарантии на структуру файлов ввода/вывода:

**Что анализируется:**
- Операции чтения/записи с path patterns
- Парсинг/сериализация структур

**Что гарантируется:**
- Сохранение структуры output файлов
- Совместимость при миграции между сервисами

### 4.2. Инфраструктурные гарантии (Rules)

Формализуют связь кода с инфраструктурой.

#### Permissions

Гарантии на наличие необходимых разрешений:

**Цепочка трассировки:**
```
aws:s3:putObject (в коде)
    ↓ belongs_to
SERVICE: order-processor
    ↓ deployed_as
K8s Pod с ServiceAccount
    ↓ assumes_role
IAM Role: order-processor-role
    ↓ has_policy
IAM Policy: allows s3:PutObject on bucket/*
```

**Что гарантируется:**
- Для каждого AWS/cloud API call существует permission path
- Отсутствие избыточных permissions (least privilege)

#### Network policies

Гарантии на сетевую достижимость:

**Что гарантируется:**
- Сервис A может достичь сервис B (если есть http:request)
- Egress/ingress rules соответствуют реальным вызовам

### 4.3. Архитектурные гарантии (Rules)

Формализуют архитектурные решения и паттерны.

#### Слоёная архитектура

**Примеры гарантий:**
- "Controllers не вызывают Database напрямую"
- "Repository слой не содержит бизнес-логики"
- "Utility модули не имеют side effects"

**Как проверяется:**
Отсутствие путей в графе между запрещёнными типами узлов.

#### Security patterns

**Примеры гарантий:**
- "User input не достигает SQL query без sanitization"
- "Sensitive data не логируется"
- "External calls имеют timeout"

**Как проверяется:**
Taint analysis: трассировка от источников к стокам с проверкой guards.

### 4.4. Runtime гарантии

Связывают статический анализ с observability.

#### Performance SLO

**Источник:** Monitoring config с alert levels

**Пример:**
```
Endpoint: /api/checkout
Metric: checkout_latency_p99
Threshold: < 500ms
Alert Level: CRITICAL

Affected code:
  - processCheckout()
  - validatePayment()
  - createOrder()

Guarantee: Changes to affected code require performance review
```

#### Reliability

**Примеры:**
- Error rate < 0.1%
- Availability > 99.9%
- Throughput > 1000 rps

---

## 5. Жизненный цикл гарантии

### 5.1. Состояния

```
┌──────────────┐
│  DISCOVERED  │  Автоматически выведена из кода
└──────┬───────┘
       │ review
       ▼
┌──────────────┐
│   REVIEWED   │  Человек просмотрел и классифицировал
└──────┬───────┘
       │ activate
       ▼
┌──────────────┐
│    ACTIVE    │  Проверяется при каждом изменении
└──────┬───────┘
       │ change request
       ▼
┌──────────────┐
│   CHANGING   │  Миграция в процессе
└──────┬───────┘
       │ complete
       ▼
┌──────────────┐
│   UPDATED    │  Новая версия активна
└──────────────┘
       │
       │ deprecate (optional)
       ▼
┌──────────────┐
│  DEPRECATED  │  Больше не проверяется
└──────────────┘
```

### 5.2. Discovery: автоматический вывод

Система анализирует код и выводит наблюдаемые гарантии:

**Процесс:**
1. Анализ кода → граф
2. Pattern matching → потенциальные гарантии
3. Schema inference → структуры данных
4. Связывание → code ↔ infra ↔ metrics

**Результат:**
```
DISCOVERED: 47 new guarantees

Queues (3):
  • orders: {orderId, items, userId} — 2 producers, 3 consumers
  • payments: {paymentId, amount, status} — 1 producer, 1 consumer
  • notifications: {userId, message, type} — 4 producers, 1 consumer

APIs (12):
  • /api/users/* — 5 endpoints, all with auth
  • /api/orders/* — 8 endpoints, 2 without rate limiting ⚠️
  ...

Permissions (8):
  • s3:PutObject on processed-orders — used, has permission ✓
  • sqs:SendMessage on notifications — used, has permission ✓
  • dynamodb:Query on users — used, MISSING PERMISSION ✗
  ...
```

### 5.3. Review: классификация человеком

Человек просматривает выведенные гарантии и назначает приоритет:

**Уровни приоритета:**

| Уровень | Название | Поведение при нарушении |
|---------|----------|------------------------|
| 🔴 | CRITICAL | Блокирует merge, требует approval |
| 🟡 | IMPORTANT | Warning, требует review |
| ⚪ | OBSERVED | Трекинг изменений, без блокировки |
| 📝 | TRACKED | Silent tracking, только в detailed view |

**Решения при review:**
- **Activate** — гарантия важна, активировать проверку
- **Adjust** — изменить scope или приоритет
- **Dismiss** — ложноположительная, игнорировать
- **Defer** — отложить решение

### 5.4. Active: проверка при изменениях

Активные гарантии проверяются при каждом изменении кода:

**При commit/PR:**
```
Checking guarantees...

✅ 34 guarantees unchanged
✅ 2 guarantees satisfied (new code follows existing patterns)

🔴 CRITICAL VIOLATION
   Guarantee: orders queue schema
   Change: Removed field 'userId' from publish
   Impact: 3 consumers expect this field

   Action required: Fix or request change

🟡 WARNING
   Guarantee: /api/users requires auth
   Change: New endpoint /api/users/export without auth middleware

   Suggestion: Add authMiddleware
```

### 5.5. Change Request: изменение гарантии

Когда нужно изменить существующую гарантию:

**Создание запроса:**
```
Change Request: Add 'timestamp' to orders queue schema

Requester: @developer
Reason: Need for audit logging

Impact Analysis:
  Consumers to update: 3
  • order-processor — needs code change
  • analytics — needs code change
  • notifications — optional field, no change needed

Approval required from:
  • @queue-owner (technical)
  • @product-lead (business impact)
```

**Процесс миграции:**
1. Change request создан
2. Approvals получены
3. Миграция consumers (parallel)
4. Update producer
5. Verify all consumers handle new field
6. Activate updated guarantee

### 5.6. Deprecation

Когда гарантия больше не актуальна:

**Причины:**
- Функциональность удалена
- Заменена новой гарантией
- Была временной (feature flag)

**Процесс:**
1. Mark as deprecated с reason
2. Notify dependents
3. Grace period (optional)
4. Remove from active checks

---

## 6. Приоритизация

### 6.1. Принцип: External Impact

Приоритет гарантии определяется степенью влияния на внешний мир:

```
                         HIGH PRIORITY
                              ▲
                              │
┌─────────────────────────────┼─────────────────────────────────┐
│  CLIENT-FACING              │                                 │
│  • HTTP endpoints           │  Клиент видит напрямую          │
│  • WebSocket responses      │  Сломать = пользователь страдает│
│  • Public API               │                                 │
└─────────────────────────────┼─────────────────────────────────┘
                              │
┌─────────────────────────────┼─────────────────────────────────┐
│  DATA PERSISTENCE           │                                 │
│  • Database writes          │  Меняет состояние системы       │
│  • File writes              │  Сломать = данные повреждены    │
│  • External storage         │                                 │
└─────────────────────────────┼─────────────────────────────────┘
                              │
┌─────────────────────────────┼─────────────────────────────────┐
│  INTER-SERVICE              │                                 │
│  • Queue publish            │  Влияет на другие сервисы       │
│  • Internal API calls       │  Сломать = каскадный сбой       │
│  • gRPC                     │                                 │
└─────────────────────────────┼─────────────────────────────────┘
                              │
┌─────────────────────────────┼─────────────────────────────────┐
│  INTERNAL ONLY              │                                 │
│  • Pure functions           │  Не влияет на внешний мир       │
│  • Internal transforms      │  Сломать = починим              │
│  • Utilities                │                                 │
└─────────────────────────────┼─────────────────────────────────┘
                              │
                              ▼
                         LOW PRIORITY
```

### 6.2. Источники приоритета

#### Статический анализ

Автоматический расчёт на основе достижимости в графе:

```
Для гарантии G:
  endpoints = nodes governed by G
  for each endpoint:
    reachable = BFS(endpoint, [CALLS, WRITES, SENDS])
    impact = max(getImpactScore(node) for node in reachable)
  priority = impactToPriority(max(impacts))
```

**Impact scores:**
- http:route → 100 (client-facing)
- db:query (write) → 80 (persistence)
- queue:publish → 60 (inter-service)
- FUNCTION → 10 (internal)

#### Monitoring config

Использование существующей разметки alert levels:

```yaml
# monitoring/alerts.yaml
alerts:
  - metric: payment_success_rate
    level: CRIT    # → priority: CRITICAL

  - metric: order_latency_p99
    level: URG     # → priority: CRITICAL

  - metric: cache_hit_rate
    level: ERR     # → priority: IMPORTANT
```

**Маппинг:**
- CRIT/URG → CRITICAL
- ERR → IMPORTANT
- WARN → OBSERVED

#### Явная разметка

Человек может override автоматический приоритет:

```
Guarantee: internal-cache-format
Auto-priority: OBSERVED (internal only)
Manual-priority: IMPORTANT (performance critical)
Reason: "Cache format change requires cache invalidation across cluster"
```

### 6.3. Комбинированный расчёт

```
final_priority = max(
  static_analysis_priority,
  monitoring_config_priority,
  manual_override_priority
)
```

Всегда берётся максимальный приоритет из всех источников.

---

## 7. Интеграция с AI-агентами

### 7.1. Два режима работы

#### Reactive: проверка после изменений

```
Agent: "Я изменил файл order-processor.js"

System: "Проверяю гарантии...
         ❌ orders queue schema violation
         ❌ Missing auth on new endpoint

         Исправь и попробуй снова"

Agent: [исправляет]

System: "✅ Все гарантии соблюдены"
```

#### Proactive: направление во время разработки

```
Human: "Добавь поддержку markdown формата в /api/content"

System → Agent: "Контекст для реализации:

  Файлы для изменения:
    • src/api/content/articles.js
    • src/api/content/pages.js

  Существующие гарантии (не ломай):
    • content-api-auth: все endpoints требуют auth
    • content-response-schema: структура ответа

  Похожий паттерн:
    • src/api/export/index.js — format switching

  Ограничения:
    • Preserve existing Content-Type for non-markdown
    • Use marked library for conversion"

Agent: [реализует с учётом контекста]

System: "Проверяю...
         ✅ Новая функциональность работает
         ✅ Существующие гарантии не нарушены

         Ready for review"
```

### 7.2. MCP Tools для агентов

#### get_implementation_context

Получение полного контекста перед началом работы:

**Input:** задача или требование

**Output:**
- Affected files — какие файлы менять
- Related guarantees — какие гарантии не ломать
- Existing patterns — как делали похожее раньше
- Constraints — ограничения и требования

#### check_implementation

Проверка текущего состояния реализации:

**Input:** id гарантии, список изменённых файлов

**Output:**
- satisfied — выполнена ли гарантия
- missing — что ещё не сделано
- violations — что сломано
- suggestions — как исправить

#### find_similar_patterns

Поиск похожих реализаций в кодовой базе:

**Input:** описание требуемой функциональности

**Output:** список существующих реализаций с файлами и сниппетами

#### verify_no_regressions

Проверка что изменения не сломали существующее:

**Input:** список изменённых файлов

**Output:** список потенциально затронутых гарантий с status

### 7.3. Contract-Driven Development Flow

```
┌─────────────────────────────────────────────────────────────┐
│  1. DEFINE                                                  │
│     Человек создаёт requirement/contract                    │
│     (через UI, YAML, или natural language)                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. CONTEXTUALIZE                                           │
│     Система автоматически находит:                          │
│     • Affected files                                        │
│     • Related guarantees                                    │
│     • Existing patterns                                     │
│     • Constraints                                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. IMPLEMENT                                               │
│     Agent получает структурированный контекст               │
│     и реализует с continuous feedback                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. VERIFY                                                  │
│     • Новая гарантия выполняется?                          │
│     • Существующие гарантии не сломаны?                    │
│     • Тесты проходят?                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. ACTIVATE                                                │
│     Новая гарантия становится active                        │
│     Теперь защищает от будущих изменений                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. Примеры использования

### 8.1. Контракт очереди сообщений

**Сценарий:** Команда добавляет новое поле в сообщения очереди orders.

**Текущее состояние:**
```
Queue: orders
Schema: {orderId, items, userId}
Producers: order-api
Consumers: order-processor, analytics, notifications
Priority: CRITICAL
```

**Изменение:** Добавить поле `timestamp` для аудита.

**Процесс GDD:**

1. **Change Request:**
   ```
   Request: Add 'timestamp' field to orders queue
   Requester: @developer
   Reason: Audit logging requirement
   ```

2. **Impact Analysis (автоматический):**
   ```
   Affected consumers: 3

   order-processor:
     Uses: {orderId, items, userId}
     Impact: No change needed (doesn't use timestamp)

   analytics:
     Uses: {orderId, items, userId}
     Impact: Should use timestamp for accurate reporting

   notifications:
     Uses: {orderId, userId}
     Impact: No change needed
   ```

3. **Approval Flow:**
   - Technical owner approves
   - Consumers notified

4. **Migration:**
   - Producer updated (timestamp added)
   - Analytics updated (timestamp used)
   - Verification: all consumers handle new schema

5. **Guarantee Updated:**
   ```
   Queue: orders
   Schema: {orderId, items, userId, timestamp?}
   Status: ACTIVE
   ```

### 8.2. AWS Permission Validation

**Сценарий:** Разработчик добавляет запись в S3 в новой функции.

**Код:**
```javascript
async function saveReport(report) {
  await s3.putObject({
    Bucket: 'reports-bucket',
    Key: `reports/${report.id}.json`,
    Body: JSON.stringify(report)
  });
}
```

**Проверка GDD:**

1. **Обнаружение:** Новый узел `aws:s3:putObject` в графе

2. **Трассировка permission path:**
   ```
   aws:s3:putObject (saveReport)
       ↓ belongs_to
   SERVICE: report-service
       ↓ deployed_as
   ECS Task: report-task
       ↓ assumes_role
   IAM Role: report-service-role
       ↓ has_policy
   ???
   ```

3. **Результат:**
   ```
   ❌ PERMISSION NOT FOUND

   AWS call: s3:PutObject on reports-bucket/*
   Service: report-service
   Role: report-service-role

   Missing: IAM policy allowing s3:PutObject

   Suggestion: Add to terraform/iam.tf:
     resource "aws_iam_role_policy" "report-s3" {
       role = aws_iam_role.report-service-role.id
       policy = jsonencode({
         Statement = [{
           Action = ["s3:PutObject"]
           Resource = "arn:aws:s3:::reports-bucket/*"
         }]
       })
     }
   ```

### 8.3. Миграция сервиса

**Сценарий:** Миграция обработки файлов из сервиса A в сервис B с сохранением структуры output.

**Текущее состояние (Service A):**
```
Input: /data/raw/{date}/*.json
Output: /data/processed/{date}/result.json
Schema: {id, status, items[], processedAt}
```

**Требование:** Service B должен писать те же файлы, но с сортировкой items.

**Процесс GDD:**

1. **Создание гарантии эквивалентности:**
   ```
   Guarantee: output-file-compatibility

   Assertion:
     output_path(A) == output_path(B)
     output_schema(A) == output_schema(B)

   Allowed differences:
     - Order of items (sorting OK)
     - Additional optional fields

   Forbidden differences:
     - Missing required fields
     - Changed field types
     - Different output path
   ```

2. **Реализация Service B:**
   - Agent получает контекст с гарантией
   - Реализует с учётом ограничений
   - Система проверяет совместимость

3. **Верификация:**
   ```
   ✅ Output path: /data/processed/{date}/result.json — match
   ✅ Schema fields: {id, status, items[], processedAt} — match
   ✅ Field types: all compatible
   ℹ️  Difference: items sorted by 'id' — allowed

   Migration approved
   ```

4. **Traffic switch:**
   - Постепенное переключение трафика
   - Мониторинг гарантии в runtime
   - Rollback при нарушении

### 8.4. Proactive Agent Implementation

**Сценарий:** Product manager хочет новую функциональность через UI.

**Запрос (в UI):**
```
Feature: Export user data in CSV format
Endpoint: GET /api/users/export?format=csv
Requirements:
  - Same data as GET /api/users
  - CSV format with headers
  - Auth required
```

**GDD Process:**

1. **UI создаёт pending guarantee:**
   ```
   Guarantee: user-export-csv (PENDING)
   Type: http:route
   Path: /api/users/export
   Requirements:
     - format=csv returns text/csv
     - Auth middleware required
     - Response contains same fields as /api/users
   ```

2. **Система готовит контекст для agent:**
   ```
   Implementation Context:

   Files to modify:
     • src/api/users/index.js (add route)

   Related guarantees (don't break):
     • user-api-auth — all /api/users/* require auth
     • user-response-schema — {id, name, email, createdAt}

   Similar pattern:
     • src/api/orders/export.js — CSV export implementation

   Constraints:
     • Use papaparse for CSV (existing dependency)
     • Preserve auth middleware from /api/users
   ```

3. **Agent implements:**
   - Получает контекст
   - Находит похожий паттерн
   - Реализует с соблюдением гарантий

4. **Verification:**
   ```
   ✅ New endpoint /api/users/export created
   ✅ Auth middleware present
   ✅ CSV format correct
   ✅ Fields match /api/users response

   Guarantee: user-export-csv → ACTIVE
   ```

---

## 9. Сравнение с существующими подходами

### 9.1. Contract Testing (Pact)

| Аспект | Pact | GDD |
|--------|------|-----|
| Scope | API между сервисами | Всё: API, очереди, files, infra |
| Discovery | Ручное написание | Автоматический вывод |
| Priority | Нет | Автоматический + ручной |
| AI integration | Нет | Native (MCP) |

### 9.2. Architecture Testing (ArchUnit)

| Аспект | ArchUnit | GDD |
|--------|----------|-----|
| Language | Java only | Polyglot (JS/TS, Terraform) |
| Scope | Code structure | Code + Infra + Runtime |
| Lifecycle | Static rules | Evolving guarantees |
| Discovery | Ручное написание | Автоматический вывод |

### 9.3. Policy as Code (OPA)

| Аспект | OPA | GDD |
|--------|-----|-----|
| Focus | Infrastructure policies | Application + Infra |
| Language | Rego | Declarative + inferred |
| Integration | K8s admission | Full development lifecycle |
| Tracing | Resource level | Code to resource path |

### 9.4. Formal Methods (TLA+)

| Аспект | TLA+ | GDD |
|--------|------|-----|
| Precision | Mathematical proofs | Practical guarantees |
| Learning curve | Steep | Gradual |
| Automation | Manual specification | Auto-discovery |
| Scale | Small critical systems | Monorepo scale |

### 9.5. Уникальность GDD

GDD объединяет лучшие идеи существующих подходов:

```
                Contract Testing
                      │
                      │ inter-service contracts
                      │
Architecture Testing ─┼─ Policy as Code
        │             │           │
        │ structural  │  infra    │
        │ rules       │  policies │
        │             │           │
        └─────────────┼───────────┘
                      │
                      ▼
              ┌───────────────┐
              │               │
              │      GDD      │
              │               │
              │ + Auto-       │
              │   discovery   │
              │ + Multi-layer │
              │ + AI-native   │
              │ + Monorepo    │
              │   scale       │
              │               │
              └───────────────┘
```

---

## 10. Заключение

### 10.1. Философия GDD

GDD — это не линтер который ругается на код, а система которая помогает понять последствия изменений и принять осознанное решение.

Ключевые принципы:

1. **Guarantees as first-class citizens** — гарантии так же важны как код
2. **Auto-discovery** — система выводит, человек уточняет
3. **Graph-powered** — граф как единая модель системы
4. **AI-native** — проектирование для агентной разработки
5. **Practical over theoretical** — практичность важнее формальной строгости

### 10.2. Выгоды

**Для разработчиков:**
- Понимание последствий изменений до merge
- Контекст для безопасного рефакторинга
- Автоматическая документация системных контрактов

**Для Tech Leads:**
- Формализация архитектурных решений
- Контроль за эволюцией системы
- Снижение knowledge silos

**Для Product:**
- Visibility технических рисков
- Участие в управлении breaking changes
- Прозрачность статуса системы

**Для AI-агентов:**
- Структурированный контекст для реализации
- Автоматическая верификация результатов
- Снижение "глупых ошибок"

### 10.3. Эволюция методологии

GDD сама является эволюционирующей системой. Гарантии, механизмы вывода и интеграции будут развиваться вместе с практикой применения.

> "From code graph to system guarantees — automatically discovered, collectively owned, continuously verified."
