# Grafema: Paid-Ready Quality Bar

**REG-75 | v1.0 | 2026-02-15**

---

## Философия монетизации

**Open-core модель.** Бесплатное ядро — полноценный инструмент, не trial. Платные тиры добавляют ценность поверх, не срезают фичи.

**Принцип:** если open-source Grafema не вызывает восторг — никто не заплатит за Pro. Качество free-тира = фундамент всей монетизации.

**Аналогия:** Git (free) → GitHub (collaboration layer). VS Code (free) → Extensions marketplace.

---

## Тиры

### Free (open-source)

**Кому:** все — индивидуальные разработчики, AI агенты, open-source проекты.

**Что входит:**
- CLI (полный функционал)
- MCP server (25 tools для AI агентов)
- Все базовые анализаторы (JS/TS: функции, вызовы, импорты, dataflow, Express routes)
- RFDB (локальный граф)
- Гарантии как код (определение + проверка)
- Multi-repo через config (multi-root)
- `grafema doctor` (диагностика)
- Datalog запросы
- Plugin API (написание собственных анализаторов)

**Качество free-тира — это и есть главный quality bar.** Если здесь плохо — всё остальное не имеет смысла.

---

### Pro ($X/мес) — индивидуальный разработчик

**Кому:** разработчик, который хочет видеть граф в процессе работы, не переключаясь в терминал.

**Ключевой продукт: VSCode Extension — Visual Intelligence Layer**

Не "CLI в sidebar". Визуальный слой, который делает граф видимым прямо в коде:

| Фича | Описание |
|---|---|
| **CodeLens** | Над каждой функцией: `→ 5 callers · 3 deps · 1 guarantee violation` |
| **Inline dataflow hints** | "переменная userId → HTTP response (auth.js:47)" |
| **Hover graph** | Навёл на функцию — мини-граф связей (callers, callees, deps) |
| **Dataflow highlight** | Клик на переменную — подсветка всего пути данных через файлы |
| **Guarantee badges** | Зелёный/красный индикатор в gutter — нарушения гарантий |
| **Sidebar: Graph Explorer** | Визуальное дерево зависимостей, навигация по связям |
| **Sidebar: File Overview** | Структура файла через граф (не AST, а семантика) |

**Дополнительно:**
- GUI web dashboard (локальный — browse граф, explore dataflow)
- Guarantee trend tracking (история нарушений со временем)
- Доступ к premium analyzers из маркетплейса

**Ценность:** то, что ни CLI, ни AI агент дать не могут — контекстная визуальная информация в момент чтения кода. Открыл файл — видишь.

---

### Team ($Y/мес/чел) — команда 5+

**Кому:** команда, которой нужна единая картина и контроль качества.

**Проблемы, которые решает:**
- Разные люди видят разный граф (разные ветки, локальные сборки)
- Гарантии — индивидуальная инициатива, а не командная политика
- Нет единого dashboard "как дела в проекте"

**Что входит (поверх Pro):**
| Фича | Описание |
|---|---|
| **Shared graph server** | Один граф на команду, всегда актуальный |
| **Auto-rebuild в CI** | Граф обновляется на каждый push (GitHub Action / hook) |
| **Team dashboard** | Состояние кодовой базы: гарантии, нарушения, тренды |
| **Guarantee policies** | Гарантии как командные правила с enforcement |
| **PR checks** | "PR нарушает гарантию X" — блокирует merge |
| **Violation history** | Кто нарушил, когда, в каком PR, тренд за месяц |
| **Private analyzer registry** | Внутренние анализаторы для команды |
| **Shared VSCode settings** | Единые настройки extension для всей команды |

---

### Enterprise ($Z/мес) — организация

**Кому:** организация с десятками репозиториев, сотнями разработчиков, требованиями compliance.

**Что входит (поверх Team):**
| Фича | Описание |
|---|---|
| **SSO/SAML** | Интеграция с корпоративной аутентификацией |
| **RBAC** | Контроль доступа: кто какие репо/графы видит |
| **Audit log** | Полная история: кто что запрашивал, менял, утверждал |
| **On-premise / private cloud** | Развёртывание в контуре заказчика |
| **Compliance analyzers** | GDPR data flow tracking, PCI-DSS scope mapping |
| **Organizational policies** | Гарантии на уровне организации, наследование между командами |
| **Cross-team dashboard** | "Состояние всех проектов" для CTO/VP Engineering |
| **Custom SLA** | Гарантированное время ответа, dedicated support |
| **Private marketplace** | Внутренний маркетплейс анализаторов организации |

---

### Marketplace (revenue share)

**Модель:** платформа для анализаторов — как App Store для Grafema.

**Участники:**
- **Grafema** — premium анализаторы (security, framework-specific, compliance)
- **Community** — open-source и paid анализаторы от сторонних разработчиков
- **Enterprise** — private анализаторы для внутреннего использования

**Категории анализаторов:**

| Категория | Примеры |
|---|---|
| **Security** | OWASP patterns, data leak detection, injection tracking |
| **Frameworks** | React component tree, Next.js pages/API, Vue reactivity, Angular DI |
| **Backend** | Django models, Laravel Eloquent, Spring beans, Rails ActiveRecord |
| **Legacy/Migration** | jQuery→modern advisor, CJS→ESM migration, class→hooks |
| **Compliance** | GDPR data flow, PCI-DSS, SOC2 evidence |
| **Custom DSL** | Handlebars, EJS, Blade, internal template engines |

**Экономика:**
- Free analyzers — community goodwill, adoption
- Paid analyzers — 70/30 split (автор / Grafema)
- Enterprise private — включено в Enterprise тир

**Flywheel:** больше анализаторов → больше пользователей → больше авторов анализаторов → больше ценность платформы.

---

## Quality Bar по тирам

### Free (open-source) — ФУНДАМЕНТ

Если free-тир не безупречен, платные тиры не продаются. Это витрина.

| Критерий | Метрика | Целевое значение | Статус |
|---|---|---|---|
| **Корректность** | Test pass rate | >95% | ✅ Исправлено |
| **Корректность** | AST coverage для JS/TS | Все основные конструкции | В процессе |
| **Производительность** | Время запроса (p95) | <1с (complex), <200ms (simple) | Нужен benchmark |
| **Производительность** | Скорость анализа | >1K LOC/sec | Нужен benchmark |
| **Надёжность** | Crash-free rate на реальных проектах | >95% | Нужен benchmark |
| **Надёжность** | Ошибки с actionable messages | 100% user-facing | Частично |
| **Ценность** | Экономия токенов vs чтение кода | >30% | ✅ Подтверждено |
| **Onboarding** | Время от install до первого результата | <15 мин с AI агентом | ✅ Проверено на open-source |
| **Документация** | Все MCP tools с примерами | 100% | В процессе |
| **Стабильность** | Работает на 10+ реальных open-source проектах | Без ручного вмешательства | Нужна проверка |

### Pro (VSCode Extension)

| Критерий | Метрика | Целевое значение |
|---|---|---|
| **Отзывчивость** | CodeLens отображение после открытия файла | <500ms |
| **Отзывчивость** | Hover graph rendering | <300ms |
| **Отзывчивость** | Dataflow highlight | <1s |
| **Точность** | CodeLens показывает верное количество callers | >90% accuracy |
| **Покрытие** | % поддерживаемых конструкций JS/TS | Совпадает с CLI |
| **Стабильность** | Extension crash-free rate | >99% |
| **UX** | Первое впечатление: открыл файл — увидел полезную информацию | User testing (n=5) |
| **GUI dashboard** | Загрузка и навигация | <2s page load |

### Team

| Критерий | Метрика | Целевое значение |
|---|---|---|
| **Shared graph** | Время синхронизации после push | <2 мин для 100K LOC |
| **Dashboard** | Загрузка team overview | <3s |
| **PR checks** | Время проверки гарантий на PR | <30s |
| **Policies** | Создание и enforcement гарантий | GUI + CLI + API |
| **History** | Хранение истории нарушений | >90 дней |
| **Надёжность** | Uptime shared graph server | >99.5% |

### Enterprise

| Критерий | Метрика | Целевое значение |
|---|---|---|
| **SSO** | SAML 2.0 integration | Standard providers (Okta, Azure AD) |
| **RBAC** | Гранулярность | Repo-level + team-level |
| **Audit** | Полнота логирования | Все запросы, изменения policies, admin actions |
| **Scale** | Количество репо | 100+ |
| **Scale** | Количество разработчиков | 500+ |
| **SLA** | Uptime | 99.9% |
| **SLA** | Support response time | <4h (critical), <24h (normal) |

### Marketplace

| Критерий | Метрика | Целевое значение |
|---|---|---|
| **Plugin API** | Стабильность API | Semver, breaking changes только в major |
| **SDK** | Время создания простого анализатора | <1 день для опытного разработчика |
| **Документация** | Plugin development guide | Полный tutorial + examples |
| **Review** | Время review нового анализатора | <5 рабочих дней |
| **Quality** | Минимальные требования к анализатору | Tests, docs, version pinning |

---

## Что НЕ входит в v1 каждого тира

| Тир | Не требуется для v1 |
|---|---|
| **Free** | Incremental analysis, classes as CLASS nodes, полное покрытие AST, GUI |
| **Pro** | AI query builder (MCP и так работает с агентами), real-time graph updates, debugging integration |
| **Team** | Distributed graph (один сервер достаточно), merge conflict resolution для графа |
| **Enterprise** | Multi-region deployment, FedRAMP, SOC2 certification (v2+) |
| **Marketplace** | Auto-review/approval, revenue analytics для авторов, A/B testing |

---

## Приоритеты запуска

### Phase 1: Free quality bar (текущий фокус — v0.2.x)

Сделать open-source безупречным:
- [ ] Benchmark suite (query performance, analysis speed, accuracy)
- [ ] Тестирование на 10+ реальных open-source проектах
- [ ] Все error messages — actionable
- [ ] Документация: Getting Started tutorial, все MCP tools с примерами
- [ ] Опубликовать метрики: "-30% токенов" и другие результаты

### Phase 2: Pro MVP (v1.0)

- [ ] VSCode Extension: CodeLens + Sidebar Graph Explorer
- [ ] GUI web dashboard (browse, explore)
- [ ] Guarantee trend tracking
- [ ] Лицензирование и оплата

### Phase 3: Team MVP

- [ ] Shared graph server
- [ ] CI integration (auto-rebuild)
- [ ] Team dashboard
- [ ] Guarantee policies + PR checks

### Phase 4: Marketplace MVP

- [ ] Plugin SDK + documentation
- [ ] 3-5 premium analyzers от Grafema
- [ ] Marketplace UI (browse, install)
- [ ] Revenue share infrastructure

### Phase 5: Enterprise

- [ ] SSO/SAML
- [ ] RBAC
- [ ] Audit log
- [ ] On-premise deployment guide

---

## The Litmus Test

**Free:** "Я установил Grafema на свой open-source проект и за 15 минут получил ответы, которые раньше требовали часа чтения кода. Бесплатно."

**Pro:** "Я открыл файл в VS Code — и сразу вижу кто вызывает эту функцию, куда утекают данные, какие гарантии нарушены. Не надо ничего спрашивать. Стоит своих денег."

**Team:** "Наш тимлид видит состояние всей кодовой базы в одном dashboard. PR не мержится если нарушает гарантию. Мы ловим проблемы до code review."

**Enterprise:** "100 репозиториев, 300 разработчиков, единые стандарты качества. Compliance-отчёт генерируется автоматически."

**Marketplace:** "Кто-то написал анализатор для нашего внутреннего фреймворка. Мы его поставили — и Grafema понимает наш код так же хорошо, как vanilla JS."
