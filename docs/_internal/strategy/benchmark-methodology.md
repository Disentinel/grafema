# Grafema Competitive Benchmark: Методология

**Версия:** 2.0
**Дата:** 2026-02-08
**Принцип:** Честное инженерное сравнение. Исполнитель — AI-агент. Если факты не в нашу пользу — фиксируем и учимся.

---

## 1. Философия

### Зачем
- Понять где Grafema объективно сильнее, где слабее, где просто другое
- Найти реальные gap'ы для приоритизации разработки
- Протестировать AI-friendliness обоих инструментов (это сам по себе ценный сигнал)
- Воспроизводимый материал для публикации

### Принципы
1. **Одинаковые условия:** один репо, одна машина, один AI-агент, одинаковый промпт
2. **AI выполняет всё:** setup, индексация, queries, замеры — агент, не человек
3. **Измеримые метрики:** числа, а не мнения
4. **Воспроизводимость:** промпт + репо + версии = любой может повторить
5. **Честность:** если конкурент лучше — агент это зафиксирует
6. **Без подгонки:** промпт и вопросы фиксируются ДО прогона

---

## 2. Execution Model

```
Human (Vadim)
  │
  ├─ Пишет промпт + фиксирует target repo + tool versions
  ├─ Запускает агента 2 раза:
  │    Run A: агент работает с Grafema
  │    Run B: агент работает с CodeGraphContext
  │
  └─ Ревьюит отчёты, НЕ редактирует данные
       (может добавить commentary секцию)

AI Agent (Claude Opus 4.6 / Codex 5.3xhigh)
  │
  ├─ Клонирует репо
  ├─ Устанавливает tool
  ├─ Индексирует
  ├─ Прогоняет все queries
  ├─ Замеряет время, считает метрики
  ├─ Проверяет accuracy (sample)
  └─ Генерирует отчёт по фиксированному формату
```

**Почему агент, а не человек:**
- Устраняет bias — агент не знает "за кого болеть"
- Тестирует реальный use-case — AI-агент онбордится на проект через tool
- Воспроизводимость — один и тот же промпт даёт сравнимые результаты
- Экономит время — прогон бенчмарка = один запуск агента

**Важно:** два прогона (Grafema и CGC) делаются ОТДЕЛЬНЫМИ сессиями агента. Агент в Run B не знает результатов Run A. Это предотвращает сравнительный bias.

---

## 3. Выбор репозиториев

### Критерии
- Публичный OSS, минимум 50k LOC
- Monorepo с frontend + backend (чтобы cross-boundary имел смысл)
- Разные стеки для обобщаемости

### Набор

| # | Репозиторий | Стек | Почему |
|---|------------|------|--------|
| 1 | **ToolJet** | NestJS + React | Есть Grafema baseline, начинаем с него |
| 2 | **Cal.com** | Next.js + tRPC | Другая модель связности (tRPC vs REST) |
| 3 | **Medusa** | Express + React | Event-driven, e-commerce data flows |

---

## 4. Agent Prompt (template)

Ниже — единый промпт, подставляется `{TOOL}`, `{TOOL_SETUP}`, `{REPO}`.

```markdown
# Benchmark Task: {TOOL} on {REPO}

## Context
You are running a benchmark of the code analysis tool "{TOOL}" on an open-source
repository. Your job is to install the tool, index the repository, run a fixed set
of queries, measure results, and produce a structured report. Be thorough and honest.

## Environment
- Repository: {REPO_URL}
- Commit: pin to HEAD at start, record the hash
- Tool: {TOOL} version {TOOL_VERSION}
- Setup: {TOOL_SETUP_INSTRUCTIONS}

## Step 1: Setup & Onboarding

1. Clone the repository (exclude node_modules, dist, .git from analysis)
2. Record baseline metrics:
   - `cloc` output (total files, LOC per language)
   - Total source files count
3. Install {TOOL} following official docs only (no workarounds unless docs fail)
4. Record:
   - Number of commands from clone to first meaningful output
   - Wall clock time for setup (including dependency installation)
   - External dependencies required (databases, runtimes, etc.)
   - Disk usage after installation
   - Any errors encountered and whether docs addressed them

## Step 2: Indexing

1. Run the tool's indexing/analysis command
2. Record:
   - Wall clock time for indexing
   - Peak memory usage (if measurable)
   - Graph/index size on disk
   - Any errors or warnings during indexing

## Step 3: Graph Coverage

After indexing, extract:
- Total number of nodes (or equivalent entities)
- Breakdown by node type (with counts)
- Total number of edges (or equivalent relationships)
- Breakdown by edge type (with counts)
- File coverage: files represented in graph / total source files
- Languages covered vs languages present in repo

## Step 4: Queries

Run each query below. For each, record:
- The exact command/query you used
- The result (or "no capability" if tool cannot answer)
- Wall clock time for the query
- Assessment: ✅ full answer, ⚠️ partial, ❌ no answer, ⬜ out of scope

### Tier 1: Code-Level (both tools should handle)

| ID | Query |
|----|-------|
| C1 | List all functions/methods in file `{SAMPLE_BACKEND_FILE}` |
| C2 | Who calls function `{SAMPLE_FUNCTION}`? (callers) |
| C3 | What does function `{SAMPLE_FUNCTION}` call? (callees) |
| C4 | Show class hierarchy for `{SAMPLE_CLASS}` |
| C5 | What files does module `{SAMPLE_MODULE}` import? |
| C6 | Find dead code: functions with no callers |

### Tier 2: System-Level

| ID | Query |
|----|-------|
| S1 | List all HTTP routes defined in the backend |
| S2 | List all HTTP requests made by the frontend |
| S3 | Which frontend requests map to which backend routes? (cross-boundary links) |
| S4 | If I change route `{SAMPLE_ROUTE}`, which frontend files are affected? |
| S5 | What services/modules exist in this system? |
| S6 | Trace the data flow for endpoint `{SAMPLE_ROUTE}` from request to response |

### Tier 2.5: Schema Inference

| ID | Query |
|----|-------|
| SC1 | What is the request body structure for `{SAMPLE_POST_ENDPOINT}`? |
| SC2 | What does `{SAMPLE_GET_ENDPOINT}` return? (response shape) |
| SC3 | What fields does interface/type `{SAMPLE_TYPE}` have? |
| SC4 | Which fields of `{SAMPLE_TYPE}` are actually used in `{SAMPLE_FUNCTION}`? |
| SC5 | If I add a field to `{SAMPLE_DTO}`, which consumers will see it? |

### Tier 3: Advanced

| ID | Query |
|----|-------|
| A1 | Are there circular dependencies between modules? |
| A2 | Which environment variables are used and where? |
| A3 | Which DB tables/models are accessed by which service/module? |

## Step 5: Accuracy Check

For queries that returned results (✅ or ⚠️), pick a random sample of 10 items
from the results and verify them manually against the source code:
- Open the actual file, check if the claimed relationship exists
- Record: correct / incorrect / uncertain for each
- Calculate precision = correct / (correct + incorrect)

## Step 6: Report

Generate the report in the EXACT format specified below. Do not skip sections.
Do not editorialize beyond the designated commentary fields.
```

---

## 5. Report Format

Агент должен выдать отчёт строго в этом формате. Один файл на прогон.

```markdown
# Benchmark Report: {TOOL} on {REPO}

## Meta
- **Date:** {ISO date}
- **Agent:** {agent model and version}
- **Repository:** {repo URL}
- **Commit:** {hash}
- **Tool:** {tool name} v{version}
- **Machine:** {OS, CPU, RAM}

## A. Onboarding

| Metric | Value | Notes |
|--------|-------|-------|
| Commands to first result | {N} | |
| Time to first result | {Nm Ns} | |
| External dependencies | {list} | |
| Disk usage (tool only) | {N MB} | |
| Setup errors encountered | {N} | {brief description} |
| Docs sufficient? | yes/no | {what was missing} |

## B. Indexing

| Metric | Value |
|--------|-------|
| Index time | {Nm Ns} |
| Peak RAM | {N MB} (or "not measured") |
| Index/graph size on disk | {N MB} |
| Errors during indexing | {N}: {description} |

## C. Graph Coverage

| Metric | Value |
|--------|-------|
| Total nodes | {N} |
| Total edges | {N} |
| File coverage | {N}/{M} ({P}%) |
| Languages covered | {list} |
| Languages in repo but not covered | {list} |

### Node types
| Type | Count |
|------|-------|
| ... | ... |

### Edge types
| Type | Count |
|------|-------|
| ... | ... |

## D. Query Results

### Tier 1: Code-Level

| ID | Command used | Result summary | Time | Assessment |
|----|-------------|----------------|------|------------|
| C1 | `...` | {N} functions found | {Ns} | ✅/⚠️/❌/⬜ |
| ... | | | | |

### Tier 2: System-Level

| ID | Command used | Result summary | Time | Assessment |
|----|-------------|----------------|------|------------|
| S1 | `...` | {N} routes found | {Ns} | ✅/⚠️/❌/⬜ |
| ... | | | | |

### Tier 2.5: Schema Inference

| ID | Command used | Result summary | Time | Assessment |
|----|-------------|----------------|------|------------|
| SC1 | `...` | ... | {Ns} | ✅/⚠️/❌/⬜ |
| ... | | | | |

### Tier 3: Advanced

| ID | Command used | Result summary | Time | Assessment |
|----|-------------|----------------|------|------------|
| A1 | `...` | ... | {Ns} | ✅/⚠️/❌/⬜ |
| ... | | | | |

## E. Accuracy

### Sample verification (10 random items from results with ✅ or ⚠️)

| # | Query ID | Claimed result | Verified against source | Correct? |
|---|----------|----------------|------------------------|----------|
| 1 | C2 | `foo()` calls `bar()` in file X:42 | Checked X:42 — yes | ✅ |
| ... | | | | |

**Precision:** {correct}/{total} = {N}%

## F. Extensibility (qualitative)

| Aspect | Assessment |
|--------|-----------|
| Plugin/extension system | {yes/no, brief description} |
| Custom node types | {yes/no} |
| Custom edge types | {yes/no} |
| Query language | {what's available, how flexible} |
| MCP integration | {yes/no, how} |

## G. AI-Friendliness (agent's perspective)

| Aspect | Rating (1-5) | Notes |
|--------|-------------|-------|
| Docs clarity for automated setup | {N} | {what confused the agent} |
| Error messages actionability | {N} | {could agent self-recover?} |
| Output parsability (structured data) | {N} | {JSON? plain text? tables?} |
| Query interface intuitiveness | {N} | {how easy to translate question → command} |
| Overall agent experience | {N} | {summary} |

## H. Summary

### Scores

| Dimension | Score |
|-----------|-------|
| Onboarding (steps) | {N} |
| Graph nodes | {N} |
| Graph edges | {N} |
| Tier 1 queries (/6) | {N}/6 |
| Tier 2 queries (/6) | {N}/6 |
| Tier 2.5 queries (/5) | {N}/5 |
| Tier 3 queries (/3) | {N}/3 |
| Precision | {N}% |
| Index time | {Ns} |

### Strengths observed
- ...

### Weaknesses observed
- ...

### Notable findings
- ...
```

---

## 6. Параметры для ToolJet (Phase 1)

Подставляются в промпт перед запуском:

```yaml
REPO_URL: https://github.com/ToolJet/ToolJet
SAMPLE_BACKEND_FILE: server/src/modules/session/controller.ts
SAMPLE_FUNCTION: getSessionDetails
SAMPLE_CLASS: SessionController
SAMPLE_MODULE: server/src/modules/session
SAMPLE_ROUTE: GET /session
SAMPLE_POST_ENDPOINT: POST /api/authenticate
SAMPLE_GET_ENDPOINT: GET /api/session
SAMPLE_TYPE: User
SAMPLE_DTO: CreateUserDto
```

### Tool-specific setup instructions

**For Grafema run:**
```
TOOL: Grafema
TOOL_VERSION: @grafema/cli@0.2.4-beta
TOOL_SETUP_INSTRUCTIONS: |
  npm install -g @grafema/cli@0.2.4-beta
  cd <repo>
  npx @grafema/cli init
  npx @grafema/cli analyze --clear
  # Use `npx @grafema/cli ls`, `npx @grafema/cli get`, `npx @grafema/cli query` for queries
  # Refer to: https://grafema.dev/docs/getting-started
```

**For CGC run:**
```
TOOL: CodeGraphContext
TOOL_VERSION: latest from PyPI
TOOL_SETUP_INSTRUCTIONS: |
  pip install codegraphcontext
  cd <repo>
  cgc index .
  # Use `cgc analyze`, `cgc list`, Cypher queries for results
  # Refer to: https://github.com/CodeGraphContext/CodeGraphContext
```

---

## 7. Правила честности

1. **Промпт и вопросы фиксируются ДО прогона.** Нельзя менять после.
2. **Агент не знает о другом прогоне.** Отдельные сессии.
3. **Vanilla setup в базовом сравнении.** Custom plugins — отдельная бонусная секция.
4. **Одна машина.** Оба прогона на одном железе.
5. **Версии фиксируются.** Записываются в meta.
6. **Сырые данные сохраняются.** Чтобы любой мог проверить.
7. **Человек не редактирует данные.** Может добавить commentary, но не менять числа.
8. **"Вне scope" — не штраф.** ⬜ не считается в score.

---

## 8. Структура файлов

```
demo/benchmarks/
  methodology.md                          # этот документ
  tooljet/
    {date}/
      meta.yaml
      grafema/
        report.md                         # отчёт агента
        raw/                              # сырые выводы команд
      cgc/
        report.md
        raw/
      comparison.md                       # сравнительная таблица (генерируется вручную или третьим прогоном)
  calcom/
    ...
```

---

## 9. Comparison Report (post-benchmark)

После обоих прогонов — человек (или третий прогон агента) составляет сравнение:

```markdown
# Benchmark Comparison: Grafema vs CGC on {REPO}

## Side-by-side

| Dimension | Grafema | CGC | Winner | Notes |
|-----------|---------|-----|--------|-------|
| Onboarding (steps) | N | N | — | |
| Index time | Ns | Ns | — | |
| Graph nodes | N | N | — | |
| Graph edges | N | N | — | |
| Tier 1 (/6) | N | N | — | |
| Tier 2 (/6) | N | N | — | |
| Tier 2.5 (/5) | N | N | — | |
| Tier 3 (/3) | N | N | — | |
| Precision | N% | N% | — | |
| AI-friendliness (avg) | N | N | — | |

## Key findings
...

## Where Grafema wins
...

## Where CGC wins
...

## Where neither satisfies
...

## Implications for roadmap
...
```

---

## 10. Roadmap

| Phase | Что | Когда |
|-------|-----|-------|
| 1 | ToolJet: Grafema + CGC прогоны | Ближайшие дни |
| 2 | +2 репо после фиксов REG-380/381/382 | После стабилизации |
| 3 | Публикация результатов (блог) | После Phase 2 |
| 4 | Повторный прогон после schema inference | Когда feature готова |

---

*Living document. Обновляется по мере прогонов.*
