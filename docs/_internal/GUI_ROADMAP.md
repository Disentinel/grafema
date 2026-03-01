# GUI Roadmap: Визуализация графа

План разработки визуализации для Grafema.

---

## Философия

**"Single source of truth" визуализация которая не устаревает** — в отличие от Confluence/Miro диаграмм которые врут через неделю.

**Один граф = одна история.** Разные Views для разных вопросов.

---

## Требования

### R1: Service Map View

Карта сервисов с их внешними взаимодействиями (DB, HTTP, queues, S3, etc.)

| Кто | Когда | Зачем |
|-----|-------|-------|
| Новичок | Первый день | "Что сервис делает?" — onboarding за часы |
| Tech Lead | Архитектурный review | "Где god-services? Где coupling?" |
| DevOps | Планирование инфры | "Какие внешние зависимости?" |

### R2: Hexagon Anchor Layout

6 категорий side effects по сторонам гексагона, сервисы/модули в центре.

| Категория | Namespace | Что включает |
|-----------|-----------|--------------|
| **DB** | `db:*` | Postgres, Redis, Mongo, Elastic |
| **FILE** | `file:*` | fs.*, S3, GCS |
| **API** | `api:*` | HTTP/gRPC к своим сервисам |
| **SAAS** | `saas:*` | Stripe, Twilio, SendGrid |
| **EVENT** | `event:*` | RabbitMQ, Kafka, SQS |
| **SYSTEM** | `sys:*` | env, process, timers |

| Кто | Когда | Зачем |
|-----|-------|-------|
| Разработчик | Перед изменением | "Что сломается если поменяю схему?" |
| Security | Аудит | "Где данные покидают систему?" |
| SRE | Инцидент | "Какие внешние зависимости проверять?" |

### R3: Semantic Spring Forces

Разная сила притяжения для разных типов связей. Сильно связанные сервисы стягиваются в кластеры.

| Кто | Когда | Зачем |
|-----|-------|-------|
| Tech Lead | Планирование | "Какие сервисы реально один продукт?" |
| Architect | Рефакторинг | "Что вынести в bounded context?" |

### R4: Expand vs Drill-down

- **Expand** — нода превращается в регион, связи перестраиваются к внутренностям
- **Drill-down** — фокус, всё остальное скрывается

| Кто | Когда | Зачем |
|-----|-------|-------|
| Разработчик | Исследование | Expand: "Какая функция ходит в DB?" |
| Debugger | Локализация | Drill-down: "Провалиться, убрать лишнее" |

### R5: VS Code Integration

Клик на ноду → открывается файл в VS Code на нужной строке.

### R6: HTML Nodes (Rich Content)

Ноды как HTML элементы с текстом, иконками, статистикой.

### R7: Regions (Видимые границы)

При expand модуля границы остаются видимой линией.

### R8: Tunable Force Parameters

UI для настройки силы пружин разных типов связей.

### R9: Layout в Rust + Worker Pool

Расчёт координат в Rust, в отдельном worker процессе. Большие графы быстро.

### R10: View / Lens / Filter Model

3-уровневая модель:
- **View** (mutually exclusive): Service Map, Data Flow, Call Graph
- **Lens** (coloring): Type, Complexity, Taint, Ownership, Recency
- **Filter** (view-specific): anchor filter, source/sink types, depth limit

### R11: ServiceInteractionResolver

Связывание `http:request` с `http:route` между сервисами.

### R12: MCP + HTTP Backend

MCP сервер с HTTP endpoint (один процесс, два транспорта).

### R13: Galaxy View

Обзор всех сервисов с иерархией Galaxy → Constellation → Service.
6 категорий как "якоря" вокруг галактики.

### R14: Graph Diff Visualization

Отображение изменений между состояниями графа (HEAD vs staged, branch vs main).

| Кто | Когда | Зачем |
|-----|-------|-------|
| Reviewer | Code review | "Что изменилось в архитектуре?" |
| Developer | Before commit | "Какие связи затронуты?" |
| Tech Lead | Before merge | "Impact на систему?" |

---

## MVP Scope: Single Service View

**Ограничение:** Один сервис + его модули + side effects.

### Включено:
1. Anchor-based layout — side effects по краям
2. Modules — модули сервиса в центре
3. Expand — раскрытие модуля в регион
4. Force-directed — с tunable parameters
5. vscode:// links — клик → код
6. HTML nodes — имя + базовая статистика
7. Regions — границы при expand

### НЕ включено в MVP:
- Multi-service view, Galaxy View
- ServiceInteractionResolver
- Drill-down (только expand)
- Lenses (только Service Map)
- Rust layout (JS для начала)

---

## План реализации

### Phase 0: Backend Prep
- [ ] HTTP endpoints в MCP server
- [ ] API для children (expand)
- [ ] Формат данных для GUI

### Phase 1: Basic Visualization
- [ ] D3.js setup с SVG
- [ ] Force-directed layout (JS)
- [ ] Anchor positions для side effects
- [ ] Click → sidebar с деталями
- [ ] vscode:// links

### Phase 2: Expand + Regions
- [ ] Expand модуля → children появляются
- [ ] Region boundary
- [ ] Collapse обратно

### Phase 3: Rich Nodes + Tuning
- [ ] HTML nodes (foreignObject)
- [ ] Force parameters UI
- [ ] Статистика на нодах

### Phase 4: Polish
- [ ] Поиск по нодам
- [ ] Фильтры по типам
- [ ] Zoom + pan improvements
- [ ] Keyboard shortcuts

### Future Phases
- [ ] Rust layout engine
- [ ] Worker pool
- [ ] Multi-service view
- [ ] ServiceInteractionResolver
- [ ] Data Flow Lens
- [ ] Security Lens
- [ ] Drill-down
- [ ] Galaxy View с Celestial Anchors
- [ ] Constellation detection (dual mode)
- [ ] View/Lens/Filter UI
- [ ] Graph Diff visualization
- [ ] JSDoc parsing
- [ ] Computed complexity
- [ ] Layout persistence

---

## Решённые вопросы

| Вопрос | Решение |
|--------|---------|
| Layout persistence | localStorage + export/import (RFDB append-only) |
| Deterministic positioning | File paths + gravity к 6 anchors |
| Constellation detection | Dual mode: file paths + semantic clustering |
| Complexity | Вычисляем из loop nesting, не тег |

---

## Открытые вопросы

1. **Real-time updates** — WebSocket push при изменении кода?
2. **Export** — PNG/SVG для документации?

---

## Ссылки

- [GUI_SPEC.md](./GUI_SPEC.md) — техническая спецификация
- [D3.js Force Layout](https://d3js.org/d3-force)
- [VS Code URL Handler](https://code.visualstudio.com/docs/editor/command-line#_opening-vs-code-with-urls)
