# 008 — SWE-bench Grafema Research: Сводный отчёт о результатах

**Дата:** 2026-02-11
**Период:** 2026-02-09 — 2026-02-11 (3 дня активной работы)
**Автор:** Claude Code (worker-1)

## Цель исследования

Измерить, помогает ли граф-контекст (Grafema) AI-агентам решать задачи SWE-bench
лучше, чем стандартный подход (grep/cat/find). Гипотеза: агент + Grafema тратит
меньше шагов на навигацию и чаще находит правильное решение.

## Инфраструктура

| Компонент | Версия / Детали |
|-----------|----------------|
| Бенчмарк | SWE-bench Multilingual (43 JS/TS задач из 300) |
| Агент | mini-SWE-agent v2.0.0a3 (bash-only, subprocess loop) |
| Модели | Sonnet 4.5, Haiku 4.5 |
| Grafema | 0.2.5-beta (REG-400 callback extraction + REG-406 context command) |
| Бюджет | step_limit=75, cost_limit=$3/задача |
| Среда | Docker containers (SWE-bench images) |

## Все прогоны

### Задача 1: axios__axios-4731 (maxBodyLength + follow-redirects)

**Сложность:** Простая. Один файл, одно условие, ясный баг.

| # | Условие | Модель | Steps | Cost | Grafema cmds | Результат |
|---|---------|--------|-------|------|-------------|-----------|
| 1 | Baseline (step_limit=50) | Sonnet 4.5 | 50/50 | $0.52 | — | NOT SUBMITTED (лимит) |
| 2 | Baseline (step_limit=75) | Sonnet 4.5 | 49/75 | $0.51 | — | **PASS** |
| 3 | Grafema (query/impact) | Haiku 4.5 | 45/75 | ~$0.05 | 1 (overview) | FAIL (overengineered fix) |

**Анализ axios:**
- Sonnet baseline решает задачу стабильно (step_limit=75)
- Haiku + Grafema: модель использовала Grafema 1 раз, потом ушла в grep/cat
- Grafema бесполезна на этой задаче: property access (`config.maxBodyLength`) не индексируется, проект маленький
- Haiku провалился из-за модельного reasoning (добавил лишнее условие на transport), не из-за навигации

### Задача 2: preactjs__preact-3345 (effect cleanup error handling)

**Сложность:** Средняя-высокая. Нужно изменить 2 места (invokeCleanup + unmount handler), gold patch меняет подход к error handling в forEach.

| # | Условие | Модель | Steps | Cost | Grafema cmds | Результат |
|---|---------|--------|-------|------|-------------|-----------|
| 4 | Baseline | Sonnet 4.5 | 40/75 | $0.37 | — | NOT SUBMITTED (exhausted) |
| 5 | Grafema v5 (query only) | Sonnet 4.5 | 48/75 | ~$0.53 | 4 (query) | FAIL (invokeCleanup only) |
| 6 | Grafema v6 broken paths | Sonnet 4.5 | ~50 | ~$0.50 | 3 (context w/o code) | FAIL (invokeCleanup only) |
| 7 | Grafema v6 startup fail | Sonnet 4.5 | — | — | 0 (rfdb not found) | FAIL |
| 8 | **Grafema v6 working context** | Sonnet 4.5 | 50/75 | ~$0.50 | 3 (overview+query+context) | FAIL (invokeCleanup only) |

**Анализ preact:**
- Baseline Sonnet даже не засабмитил патч (исчерпал шаги на исследовании)
- С Grafema агент стабильно сабмитит, но всегда одну и ту же неправильную фикс-стратегию
- `grafema context` ускорил понимание 3x (step 4 vs step 13), но не изменил решение
- Все 4 прогона с Grafema: агент добавляет try/catch ВНУТРИ invokeCleanup, вместо того чтобы менять forEach caller pattern

### Задача 3: preactjs__preact-4436 (ref cleanup functions — React 19 feature)

**Сложность:** Средняя. Feature addition, нужно изменить applyRef + types.

| # | Условие | Модель | Steps | Cost | Grafema cmds | Результат |
|---|---------|--------|-------|------|-------------|-----------|
| 9 | Baseline | Sonnet 4.5 | 50/75 | ~$0.51 | — | FAIL (vnode storage) |
| 10 | **Grafema context** | Sonnet 4.5 | 63/75 | ~$0.64 | 7 (1 overview, 3 query, 3 context) | FAIL (vnode storage + children.js fix) |

**Анализ preact-4436:**
- Обе версии FAIL: хранят cleanup на `vnode._refCleanup` вместо `ref._unmount` (function object)
- Gold patch: cleanup на function → можно skip ref(null) при unmount. Агенты: always call ref(null) → test fails
- **Grafema context полностью заменила cat/grep** — 0 file reads, всё через graph
- Grafema вариант нашёл **дополнительный баг в children.js** (wrong vnode parameter) — baseline не нашёл
- Grafema: 7 commands (11% of steps), заменили 53 file-reading commands baseline

## Ключевые находки

### 1. Grafema ускоряет навигацию, но не меняет reasoning

**preact-3345:**

| Метрика | Без Grafema | С Grafema (context) | Дельта |
|---------|-------------|---------------------|--------|
| Time to understanding | Step 13+ | Step 4 | **3x быстрее** |
| cat/sed reads | 21 | 18 | -14% |
| Fix strategy | invokeCleanup only | invokeCleanup only | **Без изменений** |
| Resolve rate | 0/1 | 0/1 | **Без изменений** |

**preact-4436:**

| Метрика | Без Grafema | С Grafema (context) | Дельта |
|---------|-------------|---------------------|--------|
| File exploration cmds | 53 (34 cat + 19 grep) | 0 | **-100%** |
| Grafema cmds | 0 | 7 | — |
| Found children.js bug | No | **Yes** | **+1 bug found** |
| Fix strategy | vnode storage | vnode storage | **Без изменений** |
| Resolve rate | 0/1 | 0/1 | **Без изменений** |

**Вывод:** Context помогает агенту быстрее понять структуру кода и находить больше
связанных проблем, но не помогает выбрать правильную стратегию фикса.
Это проблема model reasoning, не навигации.

### 1b. Grafema может ПОЛНОСТЬЮ заменить file exploration

На preact-4436 grafema agent сделал **0 cat и 0 grep** — все 53 file-reading операции
baseline были заменены 7 grafema commands. Это подтверждает продуктовый тезис:
"AI should query the graph, not read code."

### 2. Инфраструктурные проблемы отняли 80% времени

Из 3 дней работы ~80% ушло на инфраструктуру:

| Проблема | Время | Решение |
|----------|-------|---------|
| Node 18 vs 20 несовместимость | ~4h | Удаление ink/react из CLI (REG-396 pre-work) |
| Symlinks в Docker volumes | ~3h | pnpm pack + npm install from tarballs |
| Абсолютные пути в графе (REG-408) | ~4h | Docker commit workflow |
| rfdb-server binary discovery | ~2h | Ручной старт сервера |
| Background process в Docker exec | ~1h | setsid + disown pattern |
| step_limit calibration | ~1h | 50 → 75 |

**Вывод:** SWE-bench + Grafema Docker интеграция требует значительного one-time setup.
Docker commit workflow теперь стабилен и задокументирован.

### 3. REG-400 (callback resolution) — критическое улучшение графа

| Метрика | До REG-400 | После REG-400 | Изменение |
|---------|-----------|---------------|-----------|
| Nodes (preact) | 3799 | 3814 | +0.4% |
| Edges (preact) | 5190 | 12718 | **+2.4x** |
| invokeCleanup callers | 0 | 4 | **Fixed** |

REG-400 исправил паттерн `arr.forEach(fn)` — теперь Grafema видит, что `invokeCleanup`
вызывается из 4 мест. До этого фикса граф не содержал этой информации вообще.

### 4. Grafema context vs query — качественное сравнение

**`grafema query` (v5):** Показывает node metadata + список edges (IDs)
```
invokeCleanup: FUNCTION at hooks/src/index.js:344
  CALLS → forEach, _cleanup, _catchError
  CALLED_BY ← unmount, component.__hooks, ...
```

**`grafema context` (v6):** Показывает source code + edges С КОДОМ вызывающих
```
invokeCleanup: FUNCTION at hooks/src/index.js:344
  SOURCE:
    function invokeCleanup(hook) {
      const comp = currentComponent;
      if (typeof hook._cleanup == 'function') hook._cleanup();
      currentComponent = comp;
    }
  CALLED BY:
    unmount (hooks/src/index.js:328):
      oldHook.__hooks._pendingEffects.forEach(invokeCleanup);
    ...
```

**Разница для агента:** Context даёт "всё в одном" — не нужно `cat` для чтения кода
после `query`. Агент сразу видит и код, и его контекст.

## Обнаруженные продуктовые проблемы

| Issue | Приоритет | Описание |
|-------|-----------|----------|
| REG-408 | High | Абсолютные пути в графе → context не работает при переносе |
| REG-409 | Medium | Дупликаты edges (19K на хосте vs 12K в Docker для того же проекта) |
| REG-410 | Low | `--auto-start` не ищет rfdb-server в PATH |

## Граница Grafema: Structure vs Design Reasoning

**Обнаружено на preact-4436.** Grafema показывает КТО вызывает функцию и С КАКИМ КОДОМ —
и это достаточно. `grafema context` показал `applyRef(r, null, parentVNode)` — literal
`null` виден прямо в коде call site.

Агент мог бы сделать вывод: "null = unmount case, значит если есть cleanup, ref(null)
не нужен". Но не сделал. Это **не gap Grafema** — информация была доступна.

**Вывод:** Grafema покрывает structural understanding (кто, где, как связано). Design
reasoning (какой паттерн выбрать, где хранить состояние) — это domain модели, не графа.
Граница проходит между "что существует в коде" и "как правильно это изменить".

## Limitations текущего эксперимента

1. **Всего 3 задачи** — статистически незначимо. Нужно минимум 30-40 для выводов.
2. **Одна модель (Sonnet)** — Haiku только на axios, нужен fair comparison.
3. **Один тип задач** — обе preact задачи требуют non-obvious design decisions.
4. **Нет baseline PASS для preact** — baseline не решает ни одну preact задачу, baseline resolve rate = 0.
5. **Температура 0.0** — deterministic, нет variance. Нужно несколько прогонов для статистики.

## Стоимость

| Статья | Сумма |
|--------|-------|
| API calls (10 прогонов × ~$0.50) | ~$5.00 |
| Docker storage | ~8GB images |
| Человеко-часов (infrastructure) | ~15h |
| Человеко-часов (analysis) | ~7h |

## Выводы и рекомендации

### Что подтвердилось

1. **Grafema context ускоряет navigation** — 2-3x быстрее до понимания
2. **Grafema может ПОЛНОСТЬЮ заменить cat/grep** — 0 file reads на preact-4436
3. **Grafema находит БОЛЬШЕ связанных проблем** — children.js bug на preact-4436
4. **REG-400 критичен** — без callback resolution граф бесполезен для JS codebase
5. **Docker commit workflow стабилен** — повторяемая инфраструктура для экспериментов

### Что НЕ подтвердилось

1. **Grafema НЕ улучшает resolve rate** (0/3 задач) — навигация ≠ решение
2. **Haiku НЕ компенсирует слабый reasoning через Grafema** — overengineered fix
3. **Structural understanding ≠ design decisions** — агент видит call graph, но не выбирает правильный подход

### Emerging Pattern

| Task | Grafema helps understand? | Grafema helps fix? | Why not? |
|------|--------------------------|-------------------|----------|
| preact-3345 | Yes (3x faster) | No | Wrong "where to fix" (callee vs caller) |
| preact-4436 | Yes (+1 bug found) | No | Wrong "how to store" (vnode vs function) |

**Тезис:** Grafema помогает с "what exists" и "who connects to what", но не помогает
с "what pattern to use". Это reasoning boundary, не navigation boundary.

### Рекомендации по следующим шагам

**Приоритет 1: Попробовать простую задачу (props.js)**
- Задачи с props.js (2927, 3062, 3454, 4316) — attribute handling, возможно structure understanding IS enough
- Если Grafema помогает решить props задачу но не hooks — это уточняет boundary

**Приоритет 2: Масштабирование**
- Прогнать baseline Sonnet на всех 17 preact задачах
- Прогнать Grafema Sonnet на тех же 17 задачах
- Это даст статистически значимые данные

**Приоритет 3: Prompt engineering**
- Попробовать hint "consider storing state on the function object itself"
- Исследовать, можно ли через Grafema output подсказать pattern

**Приоритет 4: Продуктовые фиксы**
- REG-408 (relative paths) устранит docker commit workaround
- REG-409 (duplicate edges) повысит качество контекста
- ~~Argument value semantics~~ — retracted, не gap Grafema (info was available)

## Файлы и артефакты

| Артефакт | Путь |
|----------|------|
| Research plan | `_tasks/swe-bench-research/001-research-plan.md` |
| Infrastructure report | `_tasks/swe-bench-research/002-phase0-report.md` |
| Setup progress | `_tasks/swe-bench-research/003-phase0-setup-progress.md` |
| axios gap analysis | `_tasks/swe-bench-research/005-grafema-gap-analysis.md` |
| Haiku pilot | `_tasks/swe-bench-research/006-haiku-grafema-pilot.md` |
| Context experiment (3345) | `_tasks/swe-bench-research/007-context-experiment-report.md` |
| **This report** | `_tasks/swe-bench-research/008-overall-results-report.md` |
| Ref cleanup experiment (4436) | `_tasks/swe-bench-research/009-preact-4436-experiment.md` |
| SWE-bench skill | `.claude/skills/swe-bench-grafema-experiments/SKILL.md` |
| Docker images | `preact-3345-grafema`, `preact-4436-grafema` |
| Experiment configs | `/Users/vadimr/swe-bench-research/config/sonnet-grafema-context.yaml` |
| Results | `/Users/vadimr/swe-bench-research/results/` |
