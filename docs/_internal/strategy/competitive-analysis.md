# Grafema: Конкурентный анализ и стратегия позиционирования (v2)

**Дата:** 2026-02-08
**Автор:** Vadim Reshetnikov (Disentinel) + Claude
**Статус:** Draft v2

---

## 1. Ландшафт конкурентов (февраль 2026)

### 1.1 CodeGraphContext (ближайший по форме)

| Параметр | Детали |
|----------|--------|
| **Автор** | Shashank Shekhar Singh — студент 4-го курса IIT BHU (Индия) |
| **Стек** | Python, Neo4j / FalkorDB Lite |
| **GitHub** | ~340 stars, ~280 forks, 591 commits |
| **Модель** | MCP-сервер + CLI для индексации кода в графовую БД |
| **Языки** | 13 языков |
| **Фичи** | Callers/callees, class hierarchies, dead code, complexity, live file watching, pre-indexed bundles, MCP-интеграция |
| **Аудитория** | Индивидуальные разработчики, пользователи Cursor/Windsurf/Claude Desktop |

**Нюанс про метрики:** Issues помечены `SWoC26` (Script Winter of Code — индийский open-source хакатон). Значительная часть форков/контрибуторов — участники конкурса, не реальные пользователи. Но проект получил легитимную видимость через MCP-экосистему (~14.7k visitors на PulseMCP).

**Что делает хорошо:**
- Мгновенный onboarding: `pip install` + `cgc mcp setup`
- MCP-first подход — работает из коробки
- Хороший маркетинг: GIF-демки, YouTube, Discord
- Pre-indexed bundles для популярных репо

**Объективные слабости:**
- **Single-repo scope** — один проект за раз, нет понятия "система"
- **Regex-based парсинг** для большинства языков (не AST) — false positives на call analysis
- **Нет infra-level понимания** — не видит REST endpoints, message queues, shared databases, config boundaries
- **Нет cross-boundary data flow** — не трекает как данные перемещаются между частями системы
- **Тяжёлые зависимости** — Neo4j или FalkorDB, нет embeddable режима
- **Нет плагинной архитектуры** — жёстко закодированные парсеры
- **Solo-maintainer risk** — студент, вопрос долгосрочной поддержки

### 1.2 GitLab Knowledge Graph

| Параметр | Детали |
|----------|--------|
| **Автор** | GitLab (корпорация) |
| **Стек** | Rust, Kuzu → миграция |
| **Статус** | Public Beta в GitLab 18.4+, KuzuDB abandoned (окт 2025), ищут замену БД |

- Привязан к GitLab-платформе, не standalone
- 6-12 месяцев нестабильности из-за миграции БД
- **Не прямой конкурент**, но валидирует идею code knowledge graph на корпоративном уровне

### 1.3 Остальные

| Проект | Отношение к Grafema |
|--------|---------------------|
| FalkorDB CodeGraph | GraphRAG demo, визуализация, не глубокий анализ |
| KnackLabs CodeGraph | Коммерческий SaaS, не OSS |
| Augment Code | Enterprise SaaS, другой ценовой сегмент |
| jQAssistant | Идейно близок, но JVM-only и устаревший |
| CodeQL | Security-focused, не architecture |
| code-graph-rag | MCP-сервер, похож на CGC по scope |

---

## 2. Пересмотренное позиционирование

### 2.1 Чем Grafema НЕ является (и не должна обещать сейчас)

~~"Architecture enforcement engine"~~ — это вызывает ожидания enterprise-уровня, создаёт мишень для нападок ("а покажи как ты enforce'ишь X"), и требует зрелости продукта которой пока нет.

### 2.2 Чем Grafema ЯВЛЯЕТСЯ

**Grafema — context provider для AI-агентов, который понимает систему, а не только код.**

CGC и подобные инструменты дают AI контекст уровня "какие функции вызывают `processPayment`". Это код-уровень.

Grafema даёт контекст уровня:
- "Этот endpoint в сервисе A потребляет данные из очереди, которую наполняет сервис B"
- "Конфиг для этого модуля приходит из env-переменной, которая задаётся в k8s deployment"
- "Данные пользователя проходят через 4 сервиса прежде чем попасть в аналитику"

**Это то, что знает senior engineer с 6-летним опытом в distributed systems, но чего не знает ни один code indexer.**

### 2.3 Формула отличия

```
CGC и подобные:    AST парсинг → function/class граф → "кто вызывает X?"
Grafema:           AST + infra + config + boundaries → system граф → "как данные текут через систему?"
```

Оба — context providers. Но Grafema понимает **более широкий контекст**: не только код, но и инфраструктуру, конфигурацию, границы между сервисами, data flow.

Architecture enforcement — это **естественное следствие** богатого графа. Когда граф достаточно полон, проверка правил — это просто граф-запрос. Но обещать это на старте не нужно.

### 2.4 Матрица: что видит AI с разными context providers

| Вопрос к AI | CGC | Grafema |
|------------|-----|---------|
| "Кто вызывает `processOrder`?" | ✅ Список функций | ✅ + из какого сервиса, через какой API |
| "Что сломается если я изменю схему таблицы orders?" | ❌ Не знает про БД | ✅ Сервисы A, C читают эту таблицу, сервис B пишет |
| "Безопасно ли удалить этот endpoint?" | ❌ Видит только текущий репо | ✅ Его вызывают 2 других сервиса + cron job |
| "Откуда приходят данные в этот отчёт?" | ❌ | ✅ Data lineage через 3 сервиса |
| "Этот модуль нарушает наши правила?" | ❌ Нет правил | ✅ (когда граф достаточно полон) |

---

## 3. Стратегия: как занять нишу

### 3.1 Messaging

**Tagline варианты:**
- "Grafema: System-level context for AI agents"
- "Grafema: Your AI sees functions. Grafema shows it the system."
- "Grafema: Graph-driven development — from code to system understanding"

**Elevator pitch:**
> Code indexers give AI the context of a junior developer — who calls what. Grafema gives AI the context of a senior engineer — how services connect, where data flows, what the system boundaries are. Because the hardest bugs aren't in functions, they're in the spaces between services.

### 3.2 Приоритеты разработки

**Tier 1 — Немедленно (делает Grafema отличным от CGC):**

| # | Что | Зачем |
|---|-----|-------|
| 1 | **Cross-boundary data flow tracking MVP** | Killer feature, ни у кого нет в OSS |
| 2 | **Infra-aware парсинг** (Docker Compose, k8s manifests, env configs) | Это то, что отличает "system graph" от "code graph" |
| 3 | **Обновить grafema.dev и README** | Чёткое позиционирование как system-level context provider |

**Tier 2 — Ближайшие месяцы (видимость и доступность):**

| # | Что | Зачем |
|---|-----|-------|
| 4 | **MCP-сервер** | CGC доказал: MCP = visibility. Без MCP нас не видят в экосистеме |
| 5 | **3 реальных use-case из Bright Data** (anonymized) | Proof что инструмент решает реальные проблемы |
| 6 | **Сравнительная таблица** на сайте | Прозрачность, не "мы лучше", а "мы про другое" |

**Tier 3 — Среднесрочно (рост):**

| # | Что | Зачем |
|---|-----|-------|
| 7 | GitHub Action для CI | Первый шаг к enforcement (но не обещаем enforcement, а "system-aware CI checks") |
| 8 | VSCode extension | Визуализация system graph |
| 9 | Community rule library | Когда появится аудитория |

### 3.3 Что НЕ делать

1. **Не позиционировать как enterprise enforcement tool** — пока нет зрелости, это мишень для критики
2. **Не гнаться за количеством языков** — лучше TS + Python + Go с глубоким system-level пониманием, чем 13 языков с regex
3. **Не импортировать графы из CGC 1:1** — у них другая модель данных, другая гранулярность
4. **Не гнаться за звёздами** — SWoC-inflated метрики не = реальные пользователи

### 3.4 Как использовать наличие CGC в свою пользу

- **CGC валидирует рынок** — люди хотят code-as-graph для AI. Это хорошо.
- **CGC показал какие проблемы возникают** — regex parsing limits, single-repo scope, Neo4j dependency headaches. Мы можем учиться на их issues.
- **CGC создал категорию** в MCP-экосистеме. Когда Grafema появится с MCP-сервером и скажет "мы даём system-level context, а не только code-level", это будет понятное отличие.
- **Не конкурент, а другой уровень** — как Sourcegraph vs CAST Imaging. Оба полезны, но для разного.

---

## 4. Наши силы (итого)

| Сила | Обоснование |
|------|-------------|
| **Production опыт в distributed systems** | 6 лет в Bright Data. Студент не имеет этого видения — infra, boundaries, data flows |
| **System-level graph, не code-level** | Единственный OSS-инструмент с явным фокусом на систему |
| **Plugin architecture** | Расширяемость vs. monolithic парсеры |
| **TypeScript + embeddable** | Нативно в JS/TS экосистеме, легче интегрировать |
| **Академическая база** | Опубликованная статья (DOI), формальная методология GDD |
| **Bright Data как proving ground** | Реальный production use-case, не toy examples |
| **Cross-boundary data flow (planned)** | Feature без OSS-аналогов, рождённая из реального опыта |

---

## 5. Риски

| Риск | Mitigation |
|------|-----------|
| CGC наберёт ещё аудитории и станет "стандартом" | Позиционирование как complementary, не competing tool |
| GitLab KG стабилизируется и станет мощным | Они привязаны к GitLab; standalone Grafema — другой рынок |
| Augment/KnackLabs закроют нишу коммерчески | Они SaaS/enterprise; OSS-альтернатива всегда нужна |
| Не хватит времени (side project) | Фокус на 1-2 killer features, не breadth |
| Bright Data не даст IP clearance | Anonymized use-cases, generic patterns |

---

*Следующий шаг: зафиксировать решения по приоритетам → Linear issues.*
