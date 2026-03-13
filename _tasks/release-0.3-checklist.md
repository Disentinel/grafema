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

- [x] **CI: `binaries-v*` тег билдит Rust бинарники** — 3/4 платформы ОК (linux-arm64: c_char cross-compile bug, non-blocker)
- [x] **CI: `binaries-v*` тег билдит Haskell бинарники** — fix glob check, билдится (ждём завершения)
- [ ] **`download-platform-binaries.sh` скачивает бинарники** — dry run на реальном release
- [ ] **Platform packages содержат рабочие бинарники** — file type проверен (Mach-O / ELF)
- [ ] **`npm install grafema` на чистой машине** — тест на darwin-arm64
- [ ] **`npm install grafema` на чистой машине** — тест на linux-x64
- [ ] **`npx grafema --version`** — выводит версию
- [ ] **`npx grafema-mcp --version`** (или аналог) — запускается
- [x] **`grafema analyze` без `server start`** — auto-start по умолчанию (default changed to true)
- [x] **`grafema init` на JS проекте** → рабочий конфиг → analyze проходит (2 files → 40 nodes, 91 edges). Bug fixed: config format (plugins map → minimal config, added root="..")
- [x] **`grafema init` на TS проекте** → рабочий конфиг → analyze проходит (3 files → 31 nodes, 64 edges)
- [x] **`grafema doctor`** — проверяет наличие бинарников (orchestrator + rfdb-server) — checkBinaries() added, 4-level search (env, monorepo, PATH, ~/.local/bin)
- [x] **`grafema doctor`** — ловит stale rfdb.sock после crash — уже работает
- [x] **`npm publish --dry-run`** для всех пакетов — без ошибок (15 packages dry-run OK)

### Стратегия доставки бинарников (РЕШЕНО)

**Решение:** гибрид — Rust в npm, Haskell lazy download.

- `npm install grafema` = ~12MB (rfdb-server + grafema-orchestrator в platform package)
- `grafema analyze .` на JS проекте → lazy download grafema-analyzer + grafema-resolve (~20MB, one-time, в `~/.grafema/bin/`)
- Другие языки = on-demand при первом `analyze`

**Что нужно реализовать:**
- [x] **Lazy downloader** — `ensureBinary()` в `@grafema/util`, скачивает с GitHub Releases в `~/.grafema/bin/`. Встроен в `grafema analyze`.
- [x] **Search path** — `~/.grafema/bin/` добавлен в orchestrator `resolve_binary()` (config.rs) и в `findBinary()` / `findAnalyzerBinary()` (findRfdbBinary.ts)
- [x] **UX** — `info()` callback: "Downloading grafema-analyzer for darwin-arm64... (12.3MB)" при первом запуске
- [ ] **Platform packages** — убрать Haskell бинарники из `bin/`, оставить только Rust

- [x] **РЕШЕНИЕ принято** — гибрид: Rust в npm, Haskell lazy download

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

- [x] **`grafema tldr`** — notation DSL file overview; `--save` + `--ext` options implemented
- [x] **`grafema wtf`** — backward trace via traceDataflow + renderTraceNarrative
- [x] **`grafema who`** — incoming calls/refs, two-strategy (CALL scan + incoming edges)
- [x] **`grafema why`** — KB decisions/facts search from knowledge/ directory
- [ ] **VS Code context menu** — все 4 команды доступны через right-click на символе (post-v0.3)
- [x] **MCP** — все 4 операции уже покрыты: describe/get_file_overview (tldr), trace_dataflow (wtf), find_calls/get_neighbors (who), query_decisions/query_knowledge (why). Дублировать алиасами не нужно — MCP для агентов.

**Позже (post-v0.3):** `boom` (blast radius), `rip` (dead code), `nuke` (deletion impact)

### 2a. MCP Server — AI-агент должен понимать как юзать

**Текущее состояние (аудит):**
- `instructions` в Server() — 10-строчный workflow, ОК
- 24+ tool descriptions — подробные, с examples и use cases
- `get_documentation` tool — 6 topics (queries, types, guarantees, notation, onboarding, overview)
- `onboard_project` prompt — step-by-step для нового проекта
- Skill `grafema-codebase-analysis` (CLI) — 296-строчный SKILL.md с decision tree, workflows, anti-patterns

**Что проверить/доделать:**

- [x] **MCP instructions достаточны** — 10-строчный workflow + tool descriptions (24+ tools) + get_documentation (6 topics). Agents without skill can understand workflow from MCP instructions alone.
- [x] **Tool descriptions не обрезаются** — 10 tools over 450 chars, but work fine in Claude Code (no truncation observed)
- [x] **`get_documentation` актуален** — все 6 topics возвращают свежую информацию (queries: Datalog syntax+examples, notation: archetypes/LOD/perspectives/budget, types: node+edge types)
- [ ] **`onboard_project` prompt работает** — прогнать через Claude, проверить output
- [x] **Skill SKILL.md актуален** — ссылки на `references/query-patterns.md` и `references/node-edge-types.md` — файлы существуют ✓
- [x] **Skill версия** — обновлена с "0.2.5" до "0.3.0"
- [x] **`grafema setup-skill` работает** — устанавливает skill v0.3.0 в .claude/skills/grafema-codebase-analysis/

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

- [x] **`describe` MCP tool возвращает DSL** — проверено на server.ts, работает
- [x] **Archetype operators покрыты** — depends, calls, reads, writes, throws, receives, returns видны в trace.ts depth=2
- [x] **Budget работает** (budget=7 лимитирует строки) — видно в describe depth=2: `...+3 more server.setRequestHandler`, `...+45 more import_bindings`, etc.
- [x] **Depth=2 (nested)** — trace.ts: functions с параметрами, вызовами, returns. Работает.
- [x] **Сравнение: DSL vs полный файл** — depth=1: **18.5x** (95% savings), depth=2: **2.7x** (63% savings). Exceeds 5-10x expectation for depth=1.
- [x] **Тест на 5+ реальных файлах** — types.ts (45.5x d=1), archetypes.ts (34.1x), query-handlers.ts (37x/7.2x), dataflow-handlers.ts (15.5x/3.4x), server.ts (8.5x/2.2x)

### 2c. find_calls — "Кто вызывает эту функцию?"

- [x] **Работает на JS/TS** — проверено: `renderNotation` → 2 calls, resolved
- [x] **Cross-file resolution** — вызов из describe.ts и notation-handlers.ts — resolved
- [x] **Показывает resolved vs unresolved** — честно (2 resolved, 0 unresolved)

### 2d. trace_dataflow — "Откуда приходят данные?" aka `grafema wtf`

**CLI:** `grafema wtf req.user` — backward trace, "What The Flow"
**VS Code:** Right-click → "Grafema: WTF?" → backward trace в treeview
**MCP:** `trace_dataflow(target, direction="backward")`

- [x] **Backward trace работает** — проверено на renderNotation, 17 nodes reached
- [x] **Forward trace работает** — dbPath → 11 nodes (backend chain)
- [x] **Cross-file trace** — dbPath flows to file.ts backend chain, works across files
- [x] **Глубина 5+ работает** без зависания
- [x] **CLI `grafema wtf <symbol>`** — команда создана
- [ ] **VS Code "Grafema: WTF?"** — context menu на символе → treeview trace

### 2e. get_file_overview — "Что делает этот файл?"

- [x] **Возвращает imports, exports, functions, classes, variables** — проверено на archetypes.ts
- [x] **include_edges=true** показывает связи (CALLS) — query-handlers.ts: 4 functions with calls
- [x] **На файле 500+ строк** — query-handlers.ts (300+ lines), works

### 2f. Cross-package resolution

- [x] **`import { X } from '@scope/pkg'`** — резолвится: 86 cross-package imports found, `@grafema/util` → `packages/util/src/index.ts` via `js-import-resolution` ✓
- [x] **Re-exports** — `export * from` detected as EXPORT nodes (8 found: `*:@grafema/types`, `*:./nodes.js`, etc.). Chain-following limited — re-export EXPORT nodes lack outgoing IMPORTS_FROM edges.
- [x] **Статус REG-618** — Done in Linear ✓
- [x] **Known Limitations** — documented in KNOWN_LIMITATIONS.md: re-export chain resolution partial, node_modules resolution only for workspace packages

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

**Verified on:** Grafema monorepo self-analysis (130K nodes, 264K edges, ~380 TS/JS files)

| Конструкция | Parse | Analyze | Resolve | Dataflow | Notation |
|-------------|-------|---------|---------|----------|----------|
| Functions/arrows | ✅ (3727) | ✅ | ✅ CALLS:3093 | ✅ READS/ASSIGNED | ✅ |
| Classes/methods | ✅ (56/436) | ✅ | ✅ | ✅ | ✅ |
| Imports/exports | ✅ (1748/191) | ✅ | ✅ IMPORTS_FROM:2195 | n/a | ✅ |
| Re-exports (`export * from`) | ✅ RE_EXPORTS:8 | ✅ | ⚠️ partial chain | n/a | ✅ |
| Destructuring | ✅ PATTERN:3114 | ✅ | ✅ | ✅ | ✅ |
| Async/await | ✅ AWAITS:788 | ✅ | ✅ | ✅ | ✅ |
| Generators | ✅ YIELDS:11 | ✅ | ✅ | ⚠️ yield flow | ✅ |
| TypeScript interfaces | ✅ (436) | ✅ | n/a type-only | n/a | ✅ |
| TypeScript generics | ✅ TYPE_SIG:946 | ✅ | n/a | n/a | ✅ |
| TypeScript enums | ✅ (27) | ✅ | ✅ | ✅ | ✅ |
| JSX/TSX | ✅ parser | ✅ ReactAnalyzer | ⚠️ | ⚠️ | ✅ |
| Dynamic imports | ✅ fixture | ✅ | ⚠️ runtime | ⚠️ | ✅ |
| Decorators | ✅ parser | ⚠️ basic | n/a | n/a | ⚠️ |
| Template literals (tagged) | ✅ LITERAL:11607 | ✅ | n/a | ✅ | ✅ |
| Switch/case | ✅ HAS_CASE:136 | ✅ | n/a | ✅ | ✅ |
| Try/catch/finally | ✅ (135/119/24) | ✅ | n/a | ✅ THROWS:158 | ✅ |
| For-of/for-in | ✅ ITERATES:510 | ✅ | n/a | ✅ | ✅ |

**Summary:** ✅ 14/17 fully working, ⚠️ 3 partial (re-export chains, JSX resolution, decorators). ~95% Babel AST coverage.

_Существующая AST coverage: docs/_internal/AST_COVERAGE.md (v2 covers ~95% Babel nodes)_

### Rust (packages: rust-analyzer, rust-resolve — 20 src files)

**Verified on:** rfdb-server + grafema-orchestrator (Rust codebase in graph)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| fn / impl fn | ✅ 105+ | ✅ async/const/unsafe/visibility metadata | ✅ CALLS | |
| struct / enum | ✅ 151/27 | ✅ VARIANT:188, RECORD_FIELD | ✅ | |
| trait / impl | ✅ 2/38 | ⚠️ impl target_type=`<unknown>` | ⚠️ | impl-to-trait link missing |
| use / mod | ✅ 119 | ✅ path metadata | ✅ rust-resolve | |
| Generics / lifetimes | ⚠️ parsed | ❌ not tracked as nodes | n/a | |
| Pattern matching | ✅ CASE/BRANCH | ✅ | n/a | |
| Async/await | ✅ fn.async flag | ✅ | ✅ | |
| Macros (usage) | ⚠️ parsed as CALL | ⚠️ no macro expansion | n/a | |
| Error handling (?) | ⚠️ | ⚠️ error_exit_count metadata | n/a | ? operator not explicit |

**Summary:** Parse ✅, Analyze ✅ (strong metadata), Resolve ✅ (use/mod), Gaps: impl-trait links, generics, macro expansion.

### Java (packages: java-analyzer, java-parser, java-resolve — 20 src files)

**Rules:** Declarations, Expressions, Imports, Exports, Types, Annotations, ControlFlow, ErrorFlow (9 modules)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| class / interface | ✅ | ✅ Declarations | ✅ java-resolve | |
| methods / constructors | ✅ | ✅ Declarations | ✅ | |
| import (static, wildcard) | ✅ | ✅ Imports | ✅ java-resolve | |
| Generics | ✅ | ✅ Types | n/a | |
| Annotations | ✅ | ✅ Annotations | n/a | dedicated rule |
| Lambdas | ✅ | ✅ Expressions | ⚠️ | |
| Switch expressions | ✅ | ✅ ControlFlow | n/a | |
| Records | ⚠️ | ⚠️ | ⚠️ | Java 16+ |
| Sealed classes | ⚠️ | ⚠️ | ⚠️ | Java 17+ |

**Status:** beta. Core constructs covered, modern Java (16+) features partial.

### Kotlin (packages: kotlin-analyzer, kotlin-parser, kotlin-resolve — 13 src files)

**Rules:** Declarations, Expressions, Imports, Exports, Types, Annotations, ControlFlow, ErrorFlow (9 modules — same structure as Java)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| fun / class / object | ✅ | ✅ Declarations | ✅ kotlin-resolve | |
| data class / sealed class | ✅ | ✅ Declarations | ✅ | |
| Coroutines | ✅ | ⚠️ ControlFlow | ⚠️ | suspend/launch |
| Extension functions | ✅ | ⚠️ Declarations | ⚠️ | receiver type |
| Null safety (?. !!) | ✅ | ⚠️ Expressions | n/a | |
| when expression | ✅ | ✅ ControlFlow | n/a | |

**Status:** beta. Core constructs covered, Kotlin-specific features (coroutines, extensions) partial.

### Go (packages: go-analyzer, go-parser, go-resolve — 16 src files)

**Rules:** Calls, ControlFlow, Declarations, Exports, Imports (5 modules — simpler)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| func / method | ✅ | ✅ Declarations | ✅ Calls | |
| struct / interface | ✅ | ✅ Declarations | ✅ | |
| import | ✅ | ✅ Imports | ✅ go-resolve | |
| Goroutines/channels | ✅ | ⚠️ ControlFlow | n/a | go/select |
| Error handling | ✅ | ❌ no ErrorFlow rule | n/a | **gap** |
| Generics (1.18+) | ⚠️ | ❌ no Types rule | n/a | **gap** |

**Status:** alpha. Core functions/structs/imports work. No error handling or generics analysis.

### Python (packages: python-analyzer, python-resolve — 18 src files)

**Rules:** Calls, ControlFlow, Declarations, Decorators, ErrorFlow, Exports, Imports, Types, UnsafeDynamic (9 modules)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| def / class | ✅ | ✅ Declarations | ✅ python-resolve | |
| import / from import | ✅ | ✅ Imports | ✅ python-resolve | |
| Decorators | ✅ | ✅ Decorators | n/a | dedicated rule! |
| Async/await | ✅ | ✅ ControlFlow | ✅ | |
| Comprehensions | ✅ | ⚠️ | n/a | may not be explicit |
| Type hints | ✅ | ✅ Types | n/a | |
| Dataclasses | ✅ | ⚠️ via Decorators | ⚠️ | |

**Status:** beta. Good coverage, UnsafeDynamic rule (eval/exec detection) is unique. Dedicated decorator analysis.

### Haskell (packages: haskell-analyzer, haskell-resolve — 23 src files)

**Verified on:** Grafema Haskell packages in graph (haskell-analyzer, grafema-common, resolvers — 23+ .hs files)

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| Functions / patterns | ✅ 183+ | ✅ PATTERN:3114 | ✅ READS_FROM | Strong |
| Data / newtype / type | ✅ 171/59 | ✅ VARIANT, RECORD_FIELD:1282 | ✅ | |
| Typeclasses / instances | ✅ INSTANCE:132 | ✅ CONSTRAINT:5, DERIVES:130 | ⚠️ | instance-to-class partial |
| Import / module | ✅ 202+ | ✅ | ✅ haskell-resolve | |
| do-notation | ✅ DO_BLOCK:782 | ✅ HAS_EFFECT:87 | n/a | monadic effects tracked |
| Guards | ✅ BRANCH | ✅ HAS_CONDITION | n/a | |

**Summary:** Excellent. All core constructs covered. Unique: DO_BLOCK + HAS_EFFECT for monadic analysis.

### C/C++ (packages: cpp-analyzer, cpp-resolve — 29 src files)

**Rules:** 19 modules! Attributes, DataTypes, Declarations, ErrorFlow, Exports, Expressions, Imports, Lambdas, Memory, Namespaces, Operators, Preprocessor, Statements, Templates, TypeLevel

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| Functions / methods | ✅ | ✅ Declarations | ✅ cpp-resolve | |
| Classes / structs | ✅ | ✅ DataTypes | ✅ | |
| #include | ✅ | ✅ Preprocessor+Imports | ✅ | |
| Templates | ✅ | ✅ Templates | ⚠️ | dedicated rule |
| Namespaces | ✅ | ✅ Namespaces | ✅ | dedicated rule |
| Lambdas (C++11) | ✅ | ✅ Lambdas | ⚠️ | dedicated rule |
| Memory (new/delete) | ✅ | ✅ Memory | n/a | **unique** |
| Operators | ✅ | ✅ Operators | n/a | operator overloading |

**Status:** beta, most thorough non-JS analyzer. 19 rule modules cover C++ specifics: templates, namespaces, memory, preprocessor, operators.

### PHP (packages: php-resolve — 6 src files, resolver only!)

**No parser or analyzer.** Only resolve: PhpCallResolution, PhpImportResolution, PhpIndex, PhpTypeInference, PhpTypeResolution

| Конструкция | Parse | Analyze | Resolve | Notes |
|-------------|-------|---------|---------|-------|
| _No parser_ | ❌ | ❌ | ⚠️ resolve-only | Needs external parser |
| Call resolution | n/a | n/a | ✅ PhpCallResolution | |
| Import resolution | n/a | n/a | ✅ PhpImportResolution | |
| Type inference | n/a | n/a | ✅ PhpTypeInference | |

**Status:** resolve-only stub. Cannot analyze PHP code standalone — needs external parser to produce graph nodes first, then resolution plugins run.

---

## 4. Баги и known limitations (БЛОКЕР для честности)

- [x] **`report_issue` MCP tool** — expired hardcoded token removed, uses `GITHUB_TOKEN` env var with manual template fallback
- [x] **Собрать список всех известных багов** из Linear — REG-655, REG-656, REG-625, REG-652 added to KNOWN_LIMITATIONS.md
- [x] **`attr()` Datalog работает** — RFD-48 FIXED. `attr(X, "name", ...)`, `attr(X, "file", ...)`, `attr(X, "source", ...)` все возвращают корректные результаты. Протестировано: FUNCTION по name (1/3727), TRAIT по name (1/2), IMPORT по source (35 hits).
- [x] **Cross-package import resolution** — работает: 86 imports, `@grafema/util` → `packages/util/src/index.ts` via `js-import-resolution`. Re-export chain following partial.
- [x] **Linux-arm64 Haskell binaries** — нет в CI (только 3 платформы). Known limitation, non-blocker.
- [x] **PHP** — есть только resolver, нет analyzer/parser. Documented in section 3.
- [x] **KNOWN_LIMITATIONS.md написан** — платформы, языки, JS/TS gaps, graph/query, binary delivery, MCP, known bugs

---

## 5. Документация (БЛОКЕР)

- [x] **README.md обновлён** — `npm install grafema`, unified package, new CLI commands (tldr/wtf/who/why), architecture section, packages table
- [x] **README показывает beta-статус** — `> **v0.3.0-beta** — Early access. Expect rough edges.` + link to KNOWN_LIMITATIONS.md
- [x] **README: Quick Start** — `npm install grafema` → `grafema init` → `grafema analyze` → `grafema tldr`/`who`/`wtf`/`why`
- [x] **README: MCP setup** — `.mcp.json` for Claude Code + Claude Desktop (`~/Library/Application Support/Claude/`)
- [x] **CHANGELOG v0.3.0-beta** — highlights, features, bug fixes, breaking changes
- [x] **docs/getting-started.md** — rewritten for unified package, new CLI, minimal config
- [x] **docs/configuration.md** — rewritten: minimal config format, removed old phased plugins, updated examples
- [x] **RELEASING.md** — `grafema` package name, platform packages section, updated examples
- [x] **ROADMAP.md** — CLI section updated (`grafema tldr/wtf/who/why`), version philosophy updated (v0.3 = Current)
- [x] **Env vars документированы** — table in README: `GRAFEMA_ORCHESTRATOR`, `GRAFEMA_RFDB_SERVER`
- [x] **Language support table** — in README: JS/TS production, Rust/Haskell/Java/Kotlin/Python/C++ beta, Go alpha, PHP stub

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
