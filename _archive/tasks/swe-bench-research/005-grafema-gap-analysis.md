# Gap Analysis: Grafema vs Agent on axios__axios-4731

## Задача

**Bug:** `maxBodyLength: -1` (unlimited) не передаётся в `follow-redirects`, который по умолчанию ставит 10MB лимит.

**Файл с багом:** `lib/adapters/http.js:279`
**Файл с дефолтом:** `lib/defaults/index.js:106` (`maxBodyLength: -1`)

## Grafema Coverage

```
Total files:     111
Analyzed:        23 (21%)
Unreachable:     88 (79%) — NOT imported from entrypoints
```

**Критические файлы НЕ проанализированы:**

| Файл | Зачем нужен | Grafema статус | Root cause |
|------|-------------|----------------|------------|
| `lib/adapters/http.js` | Файл с багом | NOT_ANALYZED | Conditional require |
| `lib/defaults/index.js` | Default value maxBodyLength | NOT_ANALYZED | Directory index resolution |
| `lib/defaults/transitional.js` | Дефолты | NOT_ANALYZED | Unreachable |
| `lib/platform/*` | Platform detection | NOT_ANALYZED | Dynamic require |

## Вопросы агента vs Grafema

### Q1: "Где используется maxBodyLength?"
- **Агент (5 команд):** `grep -n "maxBodyLength" lib/adapters/http.js`, `grep -r "maxBodyLength" node_modules/follow-redirects/`
- **Grafema:** `query "maxBodyLength"` → **No results**
- **Gap: Grafema не индексирует property accesses/assignments.** `config.maxBodyLength` — это обращение к свойству объекта, не именованная функция/переменная.

### Q2: "Что в файле lib/adapters/http.js?"
- **Агент (2 команды):** `cat lib/adapters/http.js`, `sed -n '265,285p' lib/adapters/http.js`
- **Grafema:** `explain lib/adapters/http.js` → **NOT_ANALYZED**
- **Gap: Dependency tree не дошла до http adapter.** `lib/defaults/index.js` загружает adapter через `require('../adapters/http')` внутри if/else блока.

### Q3: "Где определён дефолт maxBodyLength?"
- **Агент (3 команды):** `find -name "defaults.js"`, `ls lib/defaults/`, `cat lib/defaults/index.js`
- **Grafema:** `explain lib/defaults/index.js` → **NOT_ANALYZED**
- **Gap: `require('./defaults')` не resolve'ится в `./defaults/index.js`.** Directory index resolution не работает.

### Q4: "Как follow-redirects обрабатывает maxBodyLength?"
- **Агент (2 команды):** `grep -A5 maxBodyLength node_modules/follow-redirects/index.js`
- **Grafema:** N/A
- **Gap: Grafema не анализирует node_modules.** Это ожидаемо и правильно — внешние зависимости не в графе. Но для SWE-bench задач часто нужно понять взаимодействие с зависимостями.

### Q5: "Общая структура проекта"
- **Агент (2 команды):** `find /testbed -type f -name "*.js" | grep "(lib|src)"`, `ls -la /testbed`
- **Grafema:** `overview` → **Работает!** Показывает 23 modules, 109 functions, 304 call sites
- **Частичный успех:** overview даёт структурированный ответ, но покрывает только 21% файлов.

### Q6: "Кто вызывает httpAdapter?"
- **Агент:** Не спрашивал (не нужно для этой задачи)
- **Grafema:** `impact "httpAdapter"` → **No node found** (файл не проанализирован)
- **Gap:** Если бы это была задача на рефакторинг, Grafema бы не помогла.

## Root Cause Gaps (эмпирически подтверждено)

### Gap 1: Directory Index Resolution (CONFIRMED — REG-393)
**`require('./defaults')` → `./defaults/index.js`**

Debug log подтверждает:
```
[DEBUG] Resolved dependency {"from":"lib/defaults","to":"/lib/defaults"}
[DEBUG] Parse error {"file":"lib/defaults","error":"EISDIR: illegal operation on a directory, read"}
```

Grafema разрешает `require('./defaults')` в `/lib/defaults` (директорию) и пытается прочитать её как файл → EISDIR error → всё поддерево потеряно (adapters, platform, defaults).

**Серьёзность: CRITICAL** — единственный баг, ломающий 79% coverage.

### ~~Gap 2: Conditional / Dynamic Requires~~ — FALSE (REG-394 Canceled)

Don эмпирически подтвердил: `node-source-walk` выполняет полный рекурсивный AST traversal, посещая ВСЕ ноды включая if/else и try/catch. Conditional requires работают корректно.

Гипотеза была неверной — основана на теоретическом анализе, не на тестировании.

### Gap 2 (was 3): Property Access / Config Object Tracking (REG-395)
`config.maxBodyLength` — это property access на объекте `config`. Grafema не индексирует обращения к свойствам объектов, поэтому `query "maxBodyLength"` не находит ничего.

**Серьёзность: MEDIUM для navigation, LOW для graph** — нужен `grafema grep` fallback.

## Что Grafema МОГЛА бы помочь (если бы gaps были закрыты)

Если бы coverage = 100%:

1. **`query "httpAdapter"` →** Показала бы функцию, её location, вызывающих
2. **`impact "httpAdapter"` →** Кто зависит, какие модули затронутся
3. **`trace "config.maxBodyLength from httpAdapter"` →** Data flow: откуда приходит значение, как используется
4. **`explain lib/adapters/http.js` →** Все функции, переменные, вызовы в файле

**Экономия для агента:** ~15 команд из 49 (30%) — навигация и understanding. Остальные 34 — reproduction, editing, testing (Grafema не помогает).

## Рекомендации

### Для SWE-bench эксперимента

1. **Нельзя запускать A/B тест с текущим coverage** — 21% coverage на axios бесполезен
2. **Нужно сначала закрыть Gap 1 (directory index resolution)** — это даст ~60-80% coverage
3. **Gap 2 (conditional requires)** — менее критичен, но нужен для адаптеров
4. **Gap 3** — добавить `grafema grep` fallback для text search, не index

### Для продукта Grafema

| Gap | Priority | Effort | Impact |
|-----|----------|--------|--------|
| Directory index resolution | P0 | LOW (2-3 дня) | +50-60% coverage на CJS проектах |
| Conditional requires | P1 | MEDIUM (3-5 дней) | Platform-specific adapters |
| Text search fallback | P2 | LOW (1 день) | UX: `grafema grep` как fallback |

### Для SWE-bench (workaround)

Можно обойти gap без фиксов — добавить в `grafema init` автоматическое обнаружение всех `.js` файлов и добавление их как standalone entrypoints. Это даст 100% coverage ценой потери dependency tree info.

```yaml
# .grafema/config.yaml workaround
analysis:
  standalone_files: "lib/**/*.js"  # analyze ALL files, not just reachable
```

## Post-mortem: Ложный REG-394

### Ошибка

REG-394 (conditional requires) был заведён на основании теоретического анализа:
- Увидел conditional require в `lib/defaults/index.js`
- Увидел что `lib/adapters/http.js` NOT_ANALYZED
- **Предположил** причинно-следственную связь без проверки

### Реальная причина

`lib/defaults/index.js` никогда не был **прочитан** (EISDIR error на `lib/defaults`).
Conditional requires внутри него просто не имели шанса выполниться.
Одна ошибка (directory resolution) объясняла ВСЕ пропущенные файлы.

### Правило

**Debug log BEFORE diagnosis:**
1. `grafema analyze --log-level debug` → найти ФАКТИЧЕСКУЮ ошибку
2. Один симптом → одна причина → проверить что она объясняет всё
3. НЕ заводить несколько багов на один симптом без независимого подтверждения
4. "Этот паттерн мог бы вызвать проблему" ≠ "этот паттерн вызвал проблему"
