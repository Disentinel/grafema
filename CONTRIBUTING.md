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

## What runs in CI

The `CI / Tests` job (`.github/workflows/ci.yml`) gates these suites on every PR:

| Suite | Command | Gated | Notes |
|-------|---------|-------|-------|
| Root unit | `pnpm test:coverage` (`test/unit/*.test.js`) | ✅ | |
| MCP | `pnpm --filter @grafema/mcp test` | ✅ | |
| VSCode unit | `packages/vscode/test/unit/*.test.ts` | ✅ | |
| API + types | `pnpm --filter @grafema/api --filter @grafema/types test` | ✅ | |
| CLI unit (backend-free) | `pnpm --filter @grafema/cli test:unit` | ✅ | REG-1153 — pure-unit files, no spawned binary |
| CLI integration | `pnpm --filter @grafema/cli test` (full) | ❌ | spawns `dist/cli.js` + needs native orchestrator/rfdb binaries not built in CI |

`@grafema/cli test:unit` covers only files that import functions directly (no cli spawn, no
`.grafema` db): `analyze-utils`, `formatNode`, `pathutils-resolveprojectroot`,
`progressRenderer`, `query-raw-predicate-warning`. The remaining cli tests spawn the built
binary and/or run `analyze`, so they require the Rust/Haskell native binaries; CI-gating them
needs the workflow to build or fetch those first.
