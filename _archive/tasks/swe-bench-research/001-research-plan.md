# Research: Grafema на SWE-bench — измерение влияния граф-контекста на понимание кода AI-агентами

## Цель

Доказать измеримо, что Graph-Driven Development улучшает результаты AI-агентов на задачах понимания и модификации кода. Провести эксперимент: агент + Grafema vs агент без Grafema на стандартных бенчмарках.

## Гипотеза

AI-агенты тратят значительную часть усилий на навигацию по кодовой базе (поиск нужных файлов, понимание связей между модулями). Grafema как MCP-контекст даёт агенту "карту системы" вместо слепого grep'а, что должно:
- Увеличить resolve rate (% решённых задач)
- Уменьшить количество шагов/токенов до решения
- Особенно помочь на задачах, требующих multi-file изменений и понимания cross-module зависимостей

## Бенчмарки (обновлено после research)

### Основной: Multi-SWE-bench (ByteDance)

- **Репо:** https://github.com/multi-swe-bench/multi-swe-bench
- **Dataset:** https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench
- **Paper:** https://arxiv.org/html/2504.02605v1
- **Что:** 1,632 реальных GitHub issues из 7 языков (Java, TS, JS, Go, Rust, C, C++)
- **JS/TS repos (580 задач):**
  - sveltejs/svelte (272 задачи)
  - mui/material-ui (174 задачи)
  - iamkun/dayjs (56 задач)
  - vuejs/core (48 задач)
  - anuraghazra/github-readme-stats (19 задач)
  - expressjs/express (4 задачи)
  - axios/axios (4 задачи)
  - darkreader/darkreader (2 задачи)
  - Kong/insomnia (1 задача)
- **Evaluation:** Docker-based, тест-патч решает issue
- **Leaderboard:** IBM iSWE-Agent (Claude 4.5 Sonnet): 33.0% на Java
- **Подварианты:** Multi-SWE-bench flash (300 задач), mini (400 задач)

### Альтернативный: SWE-PolyBench (Amazon)

- **Репо:** https://github.com/amazon-science/SWE-PolyBench
- **Paper:** https://arxiv.org/html/2504.08703v3
- **Что:** 2,110 issues из 21 репозитория (Java, JS, TS, Python)
- **JS/TS:** 1,017 JS + 729 TS = **1,746 задач** (самый большой JS/TS набор!)
- **Verified subset (PBv):** 382 задачи (100 JS, 100 TS, 72 Java, 113 Python)

### Дополнительный: CrossCodeEval

- **Репо:** https://crosscodeeval.github.io/
- **Paper:** https://ar5iv.labs.arxiv.org/html/2310.11248
- **Что:** Cross-file code completion (Python, Java, TypeScript, C#)
- **Почему:** Прямо тестирует cross-file understanding — главный value prop Grafema
- **Находки:** SOTA модели показывают до 3x improvement с cross-file context, до 4.5x с oracle context

### Другие кандидаты

| Бенчмарк | JS/TS задач | Фокус | URL |
|-----------|-------------|-------|-----|
| SWE-bench Multilingual (Official) | 43 | 9 языков, мало JS/TS задач | swebench.com/multilingual.html |
| SWE-bench Multimodal | 619 | Visual/UI JavaScript | arxiv.org/html/2410.03859v1 |
| SWE-Lancer (OpenAI) | Включает | Реальные Upwork задачи $50-$32K | openai.com/index/swe-lancer/ |
| BugsJS | 453 | Чистый JS, реальные баги | bugsjs.github.io |
| IDE-Bench | 80 | Contamination-free, MERN stacks | arxiv.org/html/2601.20886 |

## Выбор стратегии

**Рекомендация:** Multi-SWE-bench как основной (индустриальный стандарт, leaderboard, Docker harness).

**Почему не SWE-PolyBench:** Больше задач (1,746 JS/TS), но менее известный, нет активного leaderboard для сравнения.

**CrossCodeEval как supplementary:** Специально тестирует cross-file understanding — идеальный showcase для Grafema.

## Python blocker — СНЯТ

Оригинальный plan предполагал Python support для Grafema. **Не нужен** — найдены 5+ бенчмарков с JS/TS support.

## План эксперимента (обновлённый)

### Phase 0: Подготовка (1-2 недели)
- [ ] Изучить инфраструктуру Multi-SWE-bench: Docker setup, evaluation harness
- [ ] Выбрать pilot subset: 50 JS/TS задач разной сложности
- [ ] Определить baseline агент: Claude через API + простой scaffolding
- [ ] Проверить что Grafema анализирует все репо из Multi-SWE-bench (svelte, MUI, vue, dayjs...)
- [ ] Определить формат MCP-интеграции: какие Grafema queries даём агенту

### Phase 1: Baseline (1 неделя)
- [ ] Прогнать baseline агент на 50 задачах БЕЗ Grafema
- [ ] Метрики: resolve rate, шаги, токены, время, типы ошибок
- [ ] Категоризировать: single-file fix, multi-file fix, cross-module

### Phase 2: Grafema-enhanced (2 недели)
- [ ] Интегрировать Grafema как MCP tool для агента
- [ ] Перед каждой задачей: агент запрашивает граф через MCP
- [ ] Прогнать на тех же 50 задачах С Grafema
- [ ] Те же метрики

### Phase 3: Анализ (1 неделя)
- [ ] Сравнить: overall resolve rate, по категориям
- [ ] Где Grafema помогает больше всего
- [ ] Failure analysis: где не помогла и почему
- [ ] Token efficiency

### Phase 4: Scale up (2 недели)
- [ ] Полный Multi-SWE-bench JS/TS (580 задач)
- [ ] Параллельно CrossCodeEval
- [ ] Сравнить с published results

## Метрики

| Метрика | Описание |
|---------|----------|
| Resolve rate | % задач где patch проходит все тесты |
| Resolve rate by category | single-file / multi-file / cross-module |
| Steps to solution | Количество tool calls / LLM invocations |
| Token consumption | Input + output токены |
| Time to solution | Wall clock time |
| Localization accuracy | Нашёл ли правильные файлы |

## Timeline

| Фаза | Срок |
|-------|------|
| Phase 0: Подготовка | 2 недели |
| Phase 1: Baseline | 1 неделя |
| Phase 2: Grafema-enhanced | 2 недели |
| Phase 3: Анализ | 1 неделя |
| Phase 4: Scale up | 2 недели |
| **Итого** | **~8 недель** |
