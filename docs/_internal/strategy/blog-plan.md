# Grafema Dev Blog: Стратегия и контент-план

**Дата:** 2026-02-08
**Платформа:** grafema.dev/blog (primary) + cross-post на dev.to, Hashnode, Medium
**Язык:** English (primary), отдельные посты на русском для RU-аудитории

---

## 1. Зачем блог

CGC пиарится через YouTube, Medium, Discord, MCP-каталоги. У нас есть академическая статья — это даёт легитимность, но не даёт трафик. Блог закрывает разрыв между "серьёзный исследовательский проект" и "живой продукт, который развивается".

**Цели:**
- SEO: "code knowledge graph", "graph-driven development", "MCP code analysis"
- Credibility: показать engineering depth, а не маркетинговый hype
- Community: привлечь early adopters через реальные технические посты
- Content flywheel: каждый бенчмарк, каждый фикс, каждый design decision — это пост

---

## 2. Тон и стиль

**Не:** "Look how amazing Grafema is! 🚀🔥"
**Да:** "Here's a hard engineering problem we're solving, here's what we tried, here's what works"

Принципы:
- **Инженерная честность** — если что-то не работает, пишем открыто
- **Show the work** — не только результат, но и процесс (design decisions, trade-offs)
- **Respect the reader** — никаких clickbait заголовков, никаких пустых обещаний
- **Depth over breadth** — лучше один глубокий пост чем три поверхностных
- **Data-driven** — числа, бенчмарки, конкретные примеры из реальных проектов

---

## 3. Контент-план: первые 8 постов

### Волна 1: Фундамент (февраль — март 2026)

**Post #1: "Why code indexers give AI the context of a junior developer"**
- Проблема: AI-агенты видят functions/classes, но не видят систему
- Примеры: попроси AI "что сломается если я изменю этот endpoint" — он не знает
- Подход Grafema: system-level graph, infra awareness, cross-boundary linking
- Не продающий пост, а problem statement
- *SEO: "AI code context", "code knowledge graph", "AI code understanding"*

**Post #2: "Grafema vs CodeGraphContext: honest benchmark on ToolJet"**
- Полные результаты Phase 1 бенчмарка
- Числа, таблицы, raw data
- Где CGC лучше — пишем прямо
- Где Grafema лучше — показываем с доказательствами
- Ссылка на методологию (тоже публикуем)
- *Это самый важный пост для привлечения внимания*

**Post #3: "How an AI agent onboarded onto ToolJet in 25 minutes using Grafema"**
- История из demo/onboarding-tests отчёта
- 322 routes, 318 requests, cross-boundary traces — конкретные числа
- AI-агент написал custom plugin на лету
- Workarounds и проблемы (честно)
- Что это значит для developer workflow
- *SEO: "AI onboarding codebase", "code graph MCP"*

### Волна 2: Глубина (март — апрель 2026)

**Post #4: "Designing cross-boundary data flow tracking"**
- Техническая статья: как трекать данные между frontend и backend
- Design decisions, trade-offs, prototype results
- Сравнение подходов: regex vs AST vs hybrid
- Roadmap к schema inference
- *Привлекает архитекторов и senior engineers*

**Post #5: "Plugin architecture: why Grafema is extensible and why it matters"**
- Как AI-агент написал NestJS plugin за 10 минут
- Сравнение с hardcoded парсерами CGC
- API плагинов, примеры
- Призыв к контрибуторам
- *Привлекает потенциальных контрибуторов*

**Post #6: "Schema inference for code graphs: the missing piece"**
- Research post: почему "endpoint X вызывается" — это 30% от нужного контекста
- Как выводить схему из runtime-типов, TypeScript interfaces, Zod schemas
- Прототип на реальном коде
- *Этот пост может стать вирусным в AI/dev-tools сообществе*

### Волна 3: Рост (апрель+)

**Post #7: "Benchmark round 2: Cal.com and Medusa"**
- Расширение бенчмарка на новые репо
- Тренды: где наши подходы масштабируются, где нет

**Post #8: "Building Graph-Driven Development: 6 months of lessons"**
- Ретроспектива: что работает, что нет, что удивило
- Метрики проекта: stars, downloads, community, papers
- Honest reflection

---

## 4. Платформа и дистрибуция

### Primary: grafema.dev/blog
- Static site, Markdown → HTML
- RSS feed
- Каждый пост = отдельная страница с мета-тегами для SEO

### Cross-posting:
- **dev.to** — основная dev-аудитория, хороший SEO, canonical link на grafema.dev
- **Hashnode** — техническая аудитория, особенно open source
- **Medium** — для охвата не-dev аудитории (если пост про AI context — релевантно)
- **LinkedIn** — короткие тизеры с ссылкой, personal brand Vadim
- **Twitter/X** — thread-формат для ключевых постов
- **Reddit** — r/programming, r/softwarearchitecture, r/devtools (осторожно, не спамить)

### Не делаем:
- YouTube (пока) — слишком трудоёмко, ROI неясен
- Discord-сервер (пока) — нет критической массы для community

---

## 5. Технические вопросы

### Где хостить блог?
Варианты:
1. **grafema.dev/blog** — Astro/Hugo/11ty, деплой на тот же хостинг
2. **blog.grafema.dev** — субдомен, можно отдельный деплой
3. **Просто dev.to + Hashnode** — без своего хостинга (быстрее, но теряем SEO)

Рекомендация: вариант 1 (grafema.dev/blog) для SEO + cross-post на dev.to.

### Частота
- 2 поста в месяц — реалистично для side project
- Лучше 1 хороший пост чем 4 пустых
- Бенчмарки и отчёты считаются за посты

---

## 6. Метрики успеха блога

| Метрика | Target (3 мес) | Как измеряем |
|---------|----------------|-------------|
| Посетители блога | 1000/мес | Analytics |
| Звёзды GitHub (органические) | +50 | GitHub stats |
| Backlinks | 5+ | Search console |
| dev.to reactions | 100+ total | dev.to dashboard |
| Первый внешний контрибутор | 1 | GitHub PRs |

---

## 7. Первый пост — draft outline

### "Why code indexers give AI the context of a junior developer"

**Hook:** You asked your AI coding assistant "what will break if I rename this endpoint?" It doesn't know. Because it can see every function in your codebase, but it can't see your system.

**Sections:**
1. The context problem: AI sees trees, not the forest
2. What code indexers actually give AI (functions, classes, calls — Tier 1)
3. What's missing: services, boundaries, data flows, schemas (Tier 2+)
4. A concrete example: ToolJet — 322 backend routes, 318 frontend requests, and the invisible links between them
5. Graph-Driven Development: from code graph to system graph
6. Where we are with Grafema (honest status: what works, what's roadmap)
7. Try it yourself: `npx @grafema/cli init`

**Length:** ~1500 words
**Visuals:** comparison table (code-level vs system-level context), maybe a simple graph diagram

---

*Этот план — living document. Приоритеты постов могут меняться по мере развития.*
