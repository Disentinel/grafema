# REG-222: grafema schema export: extract config & graph schemas for contract tracking

## Problem

Контракты меняются (config schema, node/edge types), и нет способа:

1. Отследить что изменилось
2. Поймать breaking changes до релиза
3. Документировать актуальную схему автоматически

## Solution

Команда `grafema schema export` которая извлекает схемы из кода и сохраняет в файл. Pre-commit hook сравнивает с эталоном в репо.

**Implementation:** Grafema анализирует сама себя (dogfooding) — трейсит `createNode`/`createEdge` call sites чтобы найти все возможные node/edge types.

## Scope

### 1. Config Schema

```bash
grafema schema export --interface ConfigSchema > .grafema/schemas/config.json
```

Output:

```json
{
  "$schema": "grafema-contract-v1",
  "interface": "ConfigSchema",
  "extracted_from": "src/config/types.ts:15",
  "fields": {
    "entrypoints": { "type": "string[]", "required": true },
    "exclude": { "type": "string[]", "required": false, "default": [] },
    "port": { "type": "number", "required": false, "default": 3000 }
  },
  "checksum": "a1b2c3..."
}
```

### 2. Graph Schema (node types, edge types)

```bash
grafema schema export --graph > .grafema/schemas/graph.json
```

Output:

```json
{
  "$schema": "grafema-graph-v1",
  "node_types": {
    "FUNCTION": {
      "created_in": ["src/analyzers/function.ts:45"],
      "properties": ["name", "async", "generator", "loc"]
    },
    "CLASS": { ... }
  },
  "edge_types": {
    "CALLS": {
      "valid_connections": [
        { "from": "FUNCTION", "to": "FUNCTION" },
        { "from": "FUNCTION", "to": "METHOD" }
      ],
      "created_in": ["src/analyzers/calls.ts:67"]
    }
  }
}
```

### 3. Pre-commit workflow

```bash
# .husky/pre-commit or lefthook.yml
grafema schema export --interface ConfigSchema > .grafema/schemas/config.json
grafema schema export --graph > .grafema/schemas/graph.json

git diff --exit-code .grafema/schemas/ || {
  echo "⚠️  Schema changed! Review and commit if intentional."
  exit 1
}
```

## Why This Matters

1. **Contract tracking** — ломающие изменения видны сразу
2. **Always accurate** — схема генерируется из кода, не из документации
3. **CI integration** — новый node/edge type → схема автоматически обновляется
4. **Dogfooding** — Grafema доказывает свою полезность на себе ("we use Grafema to build Grafema")

## Acceptance Criteria

- [ ] `grafema schema export --interface <n>` extracts TS interface to JSON
- [ ] `grafema schema export --graph` extracts node/edge types via self-analysis
- [ ] Output is deterministic (same input → same output, for diffing)
- [ ] Checksum field for quick change detection
- [ ] `--format json|yaml|markdown` option

## Blocking Issues

- **REG-228**: Object property literal tracking: create LITERAL nodes for values in object literals
- **REG-230**: Sink-based value domain query: "what values can reach this point?"

These may be required for proper `createNode`/`createEdge` call site tracing.
