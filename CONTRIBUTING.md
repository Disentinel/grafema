# Contributing to Grafema

## Development setup

```bash
pnpm install
pnpm build
```

## Running with the compaction enricher

The compaction enricher synthesizes shortcut edges (CO_DEPENDS_ON, DIRECT_CALLS, etc.) between
nodes that are connected through hidden pass-through nodes. Without it, `grafema analyze` only
produces raw parser edges.

The enricher is configured in `.grafema/orchestrator.config.yaml`, which is gitignored so each
developer maintains their own copy. A template is provided:

```bash
cp _ai/orchestrator.config.example.yaml .grafema/orchestrator.config.yaml
sed -i '' "s|<GRAFEMA_ROOT>|$(pwd)|g" .grafema/orchestrator.config.yaml
```

Then run:

```bash
grafema analyze
```

If the city map shows "flow types = 0" after analysis, check that the `command` path in
`.grafema/orchestrator.config.yaml` points to a built `compactionEnricher.js` (`pnpm build` first).

## Running tests

```bash
pnpm test
```

Rust packages:

```bash
cargo test -p grafema-orchestrator
cargo test -p rfdb-server
```
