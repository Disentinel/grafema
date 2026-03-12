# Grafema v0.3 Release Checklist

**Цель:** тихий релиз для early adopters, `npm install grafema` → всё работает.
**Не цель:** публичный анонс (до SWE-bench proof).
**Не цель:** backwards compat, migration path, CI usage — мы в альфе, отсекаем.

---

## 1. Zero-install pipeline (БЛОКЕР)

Должно работать без вопросов:
```
npm install grafema
grafema init
grafema analyze .
```

- [ ] **CI: `binaries-v*` тег билдит Rust бинарники** — build-binaries.yml тестирован
- [ ] **CI: `binaries-v*` тег билдит Haskell бинарники** — build-haskell-binaries.yml тестирован
- [ ] **`download-platform-binaries.sh` скачивает бинарники** — dry run на реальном release
- [ ] **Platform packages содержат рабочие бинарники** — file type проверен (Mach-O / ELF)
- [ ] **`npm install grafema` на чистой машине** — тест на darwin-arm64
- [ ] **`npm install grafema` на чистой машине** — тест на linux-x64
- [ ] **`npx grafema --version`** — выводит версию
- [ ] **`npx grafema-mcp --version`** (или аналог) — запускается
- [ ] **`grafema analyze` без `server start`** — auto-start по умолчанию (сейчас нужен `--auto-start`)
- [ ] **`grafema init` на JS проекте** → рабочий конфиг → analyze проходит
- [ ] **`grafema init` на TS проекте** → рабочий конфиг → analyze проходит
- [ ] **`grafema doctor`** — проверяет наличие бинарников (orchestrator + rfdb-server)
- [ ] **`grafema doctor`** — ловит stale rfdb.sock после crash
- [ ] **`npm publish --dry-run`** для всех 9 пакетов — без ошибок

### Стратегия доставки бинарников (РЕШИТЬ)

**Вопрос:** бинарники в npm package vs скачка с GitHub при первом запуске?

| Вариант | Плюсы | Минусы |
|---------|-------|--------|
| **Всё в npm** (текущий план) | `npm install` = готово, offline работает | 75MB platform package, npm storage cost |
| **Orchestrator в npm, остальное с GitHub** | npm package ~12MB, нормальный размер | postinstall скачка может сломаться (proxy, air-gap), двойная инфраструктура |
| **Всё с GitHub при первом запуске** | npm package легчайший | UX хуже, нужен интернет при `analyze`, postinstall unreliable |

**Рекомендация:** orchestrator + rfdb-server в npm (~12MB), Haskell-анализаторы скачиваются при первом `analyze` для конкретного языка (lazy download). Тогда:
- `npm install grafema` = 12MB, быстро
- `grafema analyze .` на JS проекте → скачивает grafema-analyzer + grafema-resolve (~20MB one-time)
- Другие языки = on-demand

- [ ] **РЕШЕНИЕ принято** — какая стратегия доставки

---

## 2. Core функции — must work (БЛОКЕР)

### Human-first CLI vocabulary

| Команда | Вопрос | Что делает |
|---------|--------|------------|
| `grafema tldr <file>` | "Что тут вообще?" | file overview в notation DSL |
| `grafema wtf <symbol>` | "Откуда это?" | backward dataflow trace |
| `grafema who <symbol>` | "Кто это использует?" | incoming calls/refs |
| `grafema why <symbol>` | "Почему так?" | KB decisions |

Это **основные команды**, не алиасы. Достаточно mainstream чтобы быть primary interface.

- [ ] **`grafema tldr`** — notation DSL file overview; `grafema tldr --save` генерит `file.tldr` рядом с исходником (опция `--ext .grafema` для альтернативного расширения)
- [ ] **`grafema wtf`** — backward trace, arrow-formatted output
- [ ] **`grafema who`** — incoming calls/refs with file:line
- [ ] **`grafema why`** — KB decisions for symbol
- [ ] **VS Code context menu** — все 4 команды доступны через right-click на символе
- [ ] **MCP** — те же 4 операции доступны через MCP tools

**Позже (post-v0.3):** `boom` (blast radius), `rip` (dead code), `nuke` (deletion impact)

### 2a. MCP Server — AI-агент должен понимать как юзать

**Текущее состояние (аудит):**
- `instructions` в Server() — 10-строчный workflow, ОК
- 24+ tool descriptions — подробные, с examples и use cases
- `get_documentation` tool — 6 topics (queries, types, guarantees, notation, onboarding, overview)
- `onboard_project` prompt — step-by-step для нового проекта
- Skill `grafema-codebase-analysis` (CLI) — 296-строчный SKILL.md с decision tree, workflows, anti-patterns

**Что проверить/доделать:**

- [ ] **MCP instructions достаточны** — агент без skill должен понять workflow (сейчас 10 строк — хватает?)
- [ ] **Tool descriptions не обрезаются** — проверить что LLM видит полные descriptions (некоторые 500+ chars)
- [ ] **`get_documentation` актуален** — все 6 topics возвращают свежую информацию
- [ ] **`onboard_project` prompt работает** — прогнать через Claude, проверить output
- [ ] **Skill SKILL.md актуален** — ссылки на `references/query-patterns.md` и `references/node-edge-types.md` — файлы существуют?
- [ ] **Skill версия** — сейчас "0.2.5", обновить до 0.3
- [ ] **`grafema setup-skill` работает** — устанавливает skill в Claude Code

**Возможное улучшение — MCP Skill вместо/помимо SKILL.md:**
- Claude Code Skills (`.claude/skills/`) — для CLI users
- MCP `instructions` + tool descriptions — для любого MCP client (Cursor, Windsurf, etc.)
- Оба канала должны быть consistent

### 2b. Notation DSL (file overview для coding agents)

**Это потенциально главный selling point** — экономия токенов для AI-агентов.

```
login {
  o- imports bcrypt
  > calls UserDB.findByEmail, createToken
  < reads config.auth
  => writes session
  >x throws AuthError
  ~>> emits 'auth:login'
}
```

- [ ] **`describe` MCP tool возвращает DSL** — на реальном файле, не test fixture
- [ ] **Все archetype operators покрыты** — imports, calls, reads, writes, throws, emits, extends
- [ ] **Budget работает** (budget=7 лимитирует строки) — не обрезает критичное
- [ ] **Depth=2 (nested)** — показывает вложенные блоки (класс → методы)
- [ ] **Сравнение: DSL vs полный файл** — измерить экономию токенов (ожидание: 5-10x)
- [ ] **Тест на 5+ реальных файлах** разного размера (50, 200, 500, 1000+ строк)

### 2c. find_calls — "Кто вызывает эту функцию?"

- [ ] **Работает на JS** — функции, методы
- [ ] **Работает на TS** — с типами, дженериками
- [ ] **Cross-file resolution** — вызов из другого файла резолвится
- [ ] **Показывает resolved vs unresolved** — честно

### 2d. trace_dataflow — "Откуда приходят данные?" aka `grafema wtf`

**CLI:** `grafema wtf req.user` — backward trace, "What The Flow"
**VS Code:** Right-click → "Grafema: WTF?" → backward trace в treeview
**MCP:** `trace_dataflow(target, direction="backward")`

```
$ grafema wtf req.user
  ← auth/middleware.ts:42  validateToken()
  ← lib/jwt.ts:18         decode()
  ← routes/api.ts:7       express.Request
```

- [ ] **Forward trace работает** — от переменной к sinks
- [ ] **Backward trace работает** — от переменной к sources
- [ ] **Cross-file trace** — через imports/exports
- [ ] **Глубина 5+ работает** без зависания
- [ ] **CLI `grafema wtf <symbol>`** — backward trace команда
- [ ] **VS Code "Grafema: WTF?"** — context menu на символе → treeview trace
- [ ] ~~(допиливается в другой ветке — влить и протестировать)~~

### 2e. get_file_overview — "Что делает этот файл?"

- [ ] **Возвращает imports, exports, functions, classes, variables**
- [ ] **include_edges=true** показывает связи (CALLS, EXTENDS)
- [ ] **На файле 500+ строк** — не пустой результат

### 2f. Cross-package resolution

- [ ] **Статус REG-618** — что починено, что нет
- [ ] **`import { X } from '@scope/pkg'`** — резолвится в node_modules
- [ ] **Re-exports** — `export { X } from './internal'` цепочка следуется
- [ ] Если не работает — **честно задокументировать** в "Known Limitations"

---

## 3. Языки — coverage таблица (БЛОКЕР для честности)

Для каждого языка нужна fixture и таблица:
"что мы парсим, что анализируем, что резолвим, что НЕ работает".

### Тест-методология per language:
1. Взять fixture 200-500 строк с основными конструкциями языка
2. `grafema analyze` → записать node count, edge count
3. `find_nodes type=FUNCTION` → все ли функции найдены?
4. `find_calls name=X` → вызовы резолвятся?
5. `get_file_overview` → полнота
6. `trace_dataflow` → работает?

### JS/TS (primary, must be excellent)

| Конструкция | Parse | Analyze | Resolve | Dataflow | Notation |
|-------------|-------|---------|---------|----------|----------|
| Functions/arrows | | | | | |
| Classes/methods | | | | | |
| Imports/exports | | | | | |
| Re-exports (`export * from`) | | | | | |
| Destructuring | | | | | |
| Async/await | | | | | |
| Generators | | | | | |
| TypeScript interfaces | | | | | |
| TypeScript generics | | | | | |
| TypeScript enums | | | | | |
| JSX/TSX | | | | | |
| Dynamic imports | | | | | |
| Decorators | | | | | |
| Template literals (tagged) | | | | | |
| Switch/case | | | | | |
| Try/catch/finally | | | | | |
| For-of/for-in | | | | | |

_Существующая AST coverage: docs/_internal/AST_COVERAGE.md (v2 covers ~95% Babel nodes)_

### Rust (packages: rust-analyzer, rust-resolve — 20 src files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| fn / impl fn | | | | |
| struct / enum | | | | |
| trait / impl | | | | |
| use / mod | | | | |
| Generics / lifetimes | | | | |
| Pattern matching | | | | |
| Async/await | | | | |
| Macros (usage) | | | | |
| Error handling (?) | | | | |

### Java (packages: java-analyzer, java-resolve, java-parser — 20 src files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| class / interface | | | | |
| methods / constructors | | | | |
| import (static, wildcard) | | | | |
| Generics | | | | |
| Annotations | | | | |
| Lambdas | | | | |
| Switch expressions | | | | |
| Records | | | | |
| Sealed classes | | | | |

### Kotlin (packages: kotlin-analyzer, kotlin-parser — 13 src files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| fun / class / object | | | | |
| data class / sealed class | | | | |
| Coroutines | | | | |
| Extension functions | | | | |
| Null safety (?. !!) | | | | |
| when expression | | | | |

### Go (packages: go-analyzer, go-parser, go-resolve — 16 src files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| func / method | | | | |
| struct / interface | | | | |
| import | | | | |
| Goroutines/channels | | | | |
| Error handling | | | | |
| Generics (1.18+) | | | | |

### Python (packages: python-analyzer, python-resolve — 18 src files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| def / class | | | | |
| import / from import | | | | |
| Decorators | | | | |
| Async/await | | | | |
| Comprehensions | | | | |
| Type hints | | | | |
| Dataclasses | | | | |

### Haskell (packages: haskell-analyzer, haskell-resolve — 23 src files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| Functions / patterns | | | | |
| Data / newtype / type | | | | |
| Typeclasses / instances | | | | |
| Import / module | | | | |
| do-notation | | | | |
| Guards | | | | |

### C/C++ (packages: cpp-analyzer, cpp-resolve — 29 src files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| Functions / methods | | | | |
| Classes / structs | | | | |
| #include | | | | |
| Templates | | | | |
| Namespaces | | | | |
| Lambdas (C++11) | | | | |

### PHP (packages: php-resolve — 6 src files, resolver only!)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| _Parser missing_ | | | | **Нет php-analyzer — только resolve** |

---

## 4. Баги и known limitations (БЛОКЕР для честности)

- [ ] **`report_issue` MCP tool** — токен истёк, заменить на текстовую инструкцию (агент формирует issue text, юзер сам заводит или даёт разрешение)
- [ ] **Собрать список всех известных багов** из Linear (REG-*, RFD-*)
- [ ] **Протестировать `attr()` Datalog** — RFD-48 (не находит атрибуты)
- [ ] **Cross-package import resolution** — REG-618
- [ ] **Linux-arm64 Haskell binaries** — нет в CI (только 3 платформы)
- [ ] **PHP** — есть только resolver, нет analyzer/parser
- [ ] **Написать KNOWN_LIMITATIONS.md** — честный список что не работает, когда планируется

---

## 5. Документация (БЛОКЕР)

- [ ] **README.md обновлён** — `npm install grafema` (не `@grafema/cli`)
- [ ] **README показывает beta-статус** — banner вверху
- [ ] **README: Quick Start** — init → analyze → query (3 команды)
- [ ] **README: MCP setup** — `.mcp.json` для Claude Code, Claude Desktop
- [ ] **CHANGELOG v0.3.0-beta** — секция написана
- [ ] **docs/getting-started.md** — актуализирован под unified package
- [ ] **docs/configuration.md** — проверен, ссылка из README не битая
- [ ] **RELEASING.md** — обновлён под новый pipeline (platform packages)
- [ ] **ROADMAP.md** — обновлён (CLI ссылается на `@grafema/cli`, надо `grafema`)
- [ ] **Env vars документированы** — `GRAFEMA_ORCHESTRATOR`, `GRAFEMA_RFDB_SERVER`
- [ ] **Language support table** — в README, честная (JS/TS: excellent, Rust/Java: beta, ...)

---

## 6. SWE-bench proof (БЛОКЕР перед ПИАРОМ, не перед релизом)

Релизнуть можно без этого. Кричать нельзя.

### 6a. Инфраструктура
- [ ] **swe-bench-runbook.md актуален** — пути, версии, budget config
- [ ] **mini-SWE-agent работает** — `source .venv/bin/activate`, запуск на 1 задаче
- [ ] **Docker setup** — grafema-install в контейнерах для pre-built graph
- [ ] **Pre-built graphs** для SWE-bench repos (preact, svelte, etc.)
- [ ] **MCP server** стартует внутри Docker + mini-SWE-agent его видит

### 6b. Baseline run (без Grafema)
- [ ] **43 JS/TS задачи из SWE-bench Multilingual**
- [ ] **Записать:** resolved/total, total tokens, avg steps per task
- [ ] **Budget:** step_limit=75, cost_limit=$3, sonnet-4-5

### 6c. Grafema run (с MCP)
- [ ] **Те же 43 задачи, тот же бюджет**
- [ ] **Записать:** resolved/total, total tokens, avg steps per task
- [ ] **Записать per-tool usage:** сколько раз вызван каждый MCP tool

### 6d. Notation DSL proof (ключевая метрика)
- [ ] **Изолированный тест:** describe(file) vs cat(file) — токены на один и тот же файл
- [ ] **5+ файлов разного размера** → таблица: file_lines, cat_tokens, describe_tokens, ratio
- [ ] **Качество:** агент с DSL находит нужную функцию / понимает структуру? (manual eval)
- [ ] **Ожидание:** 5-10x reduction. Если меньше 3x — пересмотреть rendering.

### 6e. Анализ и публикация
- [ ] **Дельта статистически значима** — не 1-2 задачи, а ≥5 delta
- [ ] **Per-category breakdown** — на каких типах задач Grafema помогает больше всего
- [ ] **Failure analysis** — задачи где Grafema не помогла (или помешала)
- [ ] **Написать blog post** — методология, raw numbers, честный анализ
- [ ] **Reproducible** — скрипты, конфиги, docker images, seed random

---

## 7. GUI / Визуализация графа

### 7a. Интерактивная веб-демка на сайте (wow-фактор)

**Идея:** на `grafema.dev` встроен интерактивный граф Grafema-self (сам себя анализирует).
Посетитель может полазить: кликать на ноды, раскрывать модули, видеть связи.

**Текущее состояние:**
- `docs/_internal/GUI_SPEC.md` — спека визуализации (D3, hexagon layout, service map)
- `docs/_internal/GUI_ROADMAP.md` — roadmap MVP phases
- `packages/api/` — GraphQL API готов, но без потребителя
- Docker demo (`demo/`) — code-server в браузере, но это IDE а не демка графа

**Что нужно:**

- [ ] **Экспорт графа в JSON** — `grafema export --format json` (или GraphQL dump) → статический файл
- [ ] **Граф самого Grafema** — проанализировать монорепо, сохранить snapshot
- [ ] **Web viewer (standalone)** — D3/WebGL компонент, читает JSON, рендерит граф
  - Минимум: force-directed layout, zoom/pan, клик на ноду → детали
  - Нод: цвет по типу (MODULE, FUNCTION, CLASS), размер по fan-out
  - Ребро: по archetype (calls, imports, writes) с разными стилями
- [ ] **Embed на `grafema.dev`** — iframe или inline, pre-loaded с Grafema-self графом
- [ ] **Permalink на ноду** — URL fragment `#node=src/mcp/tools.ts->FUNCTION->handleDescribe`

### 7b. VSCode extension — graph canvas (v0.5+, но подготовить)

**Текущее:** 7 tree-based панелей (callers, edges, blast radius, etc.) — работает.
**Нужно:** webview panel с тем же D3 компонентом что на сайте.

- [ ] **Shared visualization library** — один D3 компонент для сайта и extension
- [ ] **VSCode webview integration** — `panel.webview.html` загружает viewer
- [ ] **Навигация:** клик на ноду в графе → открыть файл в редакторе
- [ ] **Scope:** текущий файл / модуль / весь проект (toggle)

### 7c. VSCode extension — текущие панели (проверить к релизу)

- [ ] **Extension работает с v0.3 unified package** — бинарники находятся
- [ ] **Все 7 панелей работают** на реальном проекте (не fixture)
- [ ] **Extension version bump** — текущая 0.2.12, нужна 0.3.0
- [ ] **Extension marketplace** — опубликовать обновлённую версию

---

## 8. Маркетинг и анонс (ПОСЛЕ proof)

- [ ] Landing page `grafema.dev` — обновить, **встроить интерактивную демку графа (§7a)**
- [ ] MCP Hub листинг — подготовить metadata
- [ ] GitHub stars CTA в README
- [ ] Blog posts (стратегия в `docs/_internal/strategy/blog-plan.md`)
- [ ] SEO для лендинга
- [ ] **Demo video** — DSL → Trace → Map, 3 модальности одного графа. Детали: `_tasks/demo-video-checklist.md`
- [ ] Discord / GitHub Discussions
- [ ] `homepage` в package.json → grafema.dev

---

## 9. Порядок действий

### Phase 1: Merge & Test (сейчас)
1. Влить все ветки (trace_dataflow, etc.)
2. `pnpm build && pnpm test` — всё зелёное
3. Реанализ графа (grafema analyze .)
4. Заполнить language coverage таблицы ^^
5. Написать KNOWN_LIMITATIONS.md

### Phase 1.5: Smoke test на Jodit (ОБЯЗАТЕЛЬНО)
Jodit multi-repo setup: `/Users/vadimr/jodit-multi/` (3 публичных репо)
6. `grafema init` + `grafema analyze` на jodit-play
7. `find_calls`, `get_file_overview`, `describe` — работает?
8. **Cross-repo вызовы** — jodit-play → jodit-ai-adapter, трассировка через границы
9. **Plugin семантика** — расширение графа через plugins для Jodit-специфичных паттернов
10. **Notation DSL** — `describe` на реальном Jodit файле, оценка качества

### Phase 2: Pipeline (следующий шаг)
6. Пушнуть `binaries-v0.3.0-beta` тег → CI builds
7. `download-platform-binaries.sh` → скачать
8. `npm publish --dry-run` для всех 9 пакетов
9. Тест: `npm install grafema` на чистой машине

### Phase 3: Docs & Release
10. README, CHANGELOG, getting-started — обновить
11. `./scripts/release.sh 0.3.0-beta --publish`
12. Проверить: `npx grafema@beta --version`
13. Дать early adopters

### Phase 4: Proof (параллельно)
14. SWE-bench baseline run
15. SWE-bench + Grafema run
16. Анализ результатов

### Phase 5: Public (когда proof есть)
17. Landing page
18. Blog post с benchmarks
19. MCP Hub
20. Анонс

---

## 10. Обсуждённые и отложенные пункты

| Пункт | Статус | Комментарий |
|-------|--------|-------------|
| Smoke test на 3+ OSS проектах | ЗАМЕНЕНО | Jodit multi-repo smoke test (Phase 1.5) |
| Graceful degradation (нет бинарника) | TODO | `grafema doctor` + понятное сообщение при отсутствии бинарника |
| Upgrade path 0.2 → 0.3 | NOT TARGET v0.3 | Мы в альфе, нет существующих юзеров для миграции |
| npm package size / security audit | ЗАВИСИТ | Ждёт решения по стратегии доставки бинарников (§1) |
| CI usage (GitHub Actions) | NOT TARGET v0.3 | Фича для team version, рано |
| Concurrent access (несколько Claude Code) | DONE | Работает — каждый worktree = свой rfdb.sock |
| Telemetry / usage analytics | NOT TARGET v0.3 | Рано, сначала early adopters |
| RFDB stale socket cleanup | В ЧЕКЛИСТЕ | §1 `grafema doctor` — ловит stale rfdb.sock |
| `report_issue` MCP tool (expired token) | В ЧЕКЛИСТЕ | §4 — заменить на текстовую инструкцию |
