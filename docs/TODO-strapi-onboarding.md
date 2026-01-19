# Navi MCP - Найденные баги при онбординге Strapi

## MCP Tools

### BUG-001: query_graph - results.slice is not a function
**Severity:** High
**File:** `src/mcp/server.ts` или handler для query_graph
**Reproduce:**
```javascript
mcp__navi__query_graph({ query: 'violation(X) :- node(X, "CALL").' })
```
**Error:** `results.slice is not a function`

---

### BUG-002: get_schema возвращает пустой результат
**Severity:** Medium
**File:** `src/mcp/server.ts`
**Reproduce:** При графе с 255 nodes и 221 edges `get_schema` возвращает:
```
Node Types (0):
Edge Types (0):
```

---

### BUG-003: get_coverage - db.findByType is not a function
**Severity:** Medium
**File:** `src/mcp/server.ts`
**Reproduce:**
```javascript
mcp__navi__get_coverage({ path: '/path/to/project' })
```
**Error:** `db.findByType is not a function`

---

### BUG-004: find_calls - параметр name не передаётся
**Severity:** Medium
**File:** `src/mcp/server.ts`
**Reproduce:**
```javascript
mcp__navi__find_calls({ name: 'bytesToKbytes' })
```
**Result:** `No calls found for "undefined"` — параметр name теряется

---

## RFDB Server

### BUG-005: Нестабильное подключение к RFDB
**Severity:** High
**File:** `src/v2/storage/backends/RFDBServerBackend.js`
**Symptoms:**
- MCP сервер падает при вызове `analyze_project`
- Лог обрывается на "Using RFDB server backend"
- Требуется ручной запуск rfdb_server перед анализом

---

### BUG-006: Duplicate IDs при flush
**Severity:** Low
**File:** `rust-engine/src/`
**Symptoms:** При flush появляются warning'и:
```
[RUST FLUSH] !!! Duplicate ID 272180990746082545670107291140432895734 in flush - delta overwrites segment
```
19 дубликатов при записи 255 nodes

---

## Indexer/Analyzer

### BUG-007: TypeScript module resolution неполный
**Severity:** Medium
**File:** `src/v2/plugins/indexing/JSModuleIndexer.js`
**Status:** Частично исправлено (добавлены .ts/.tsx extensions)
**TODO:**
- [ ] Поддержка tsconfig.json paths
- [ ] Резолв package imports в монорепозиториях (@strapi/core -> packages/core/...)
- [ ] Поддержка baseUrl

---

## Архитектурные улучшения

### FEATURE-001: Языковые анализаторы
Под каждый язык нужен свой анализатор и индексатор:
- [ ] TypeScriptAnalyzer (с полной поддержкой TS синтаксиса)
- [ ] PythonAnalyzer
- [ ] GoAnalyzer
- [ ] и т.д.

### FEATURE-002: Discovery - явный подход
Discovery должен быть project-specific (это by design):
- Разработчик создаёт `.rflow/plugins/MyProjectDiscovery.mjs`
- Явно указывает структуру проекта
- Никакого "магического" auto-detect

---

## Исправления сделанные в этой сессии

1. **Cargo.toml** — добавлен `rmp-serde = "1.3"`
2. **rfdb_server.rs** — заменён `EvaluatorExplain` на `Evaluator`, убран `engine.clear()`
3. **RFDBServerBackend.js** — исправлено имя бинарника `rfdb-server` -> `rfdb_server`
4. **JSModuleIndexer.js** — добавлена поддержка .ts/.tsx/.mjs extensions
5. **StrapiServiceDiscovery.mjs** — создан Discovery плагин для Strapi, исправлен path (файл вместо директории)
