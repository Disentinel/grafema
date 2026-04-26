# Phase 2: Rust Orchestrator

## Goal

`grafema-orchestrator` binary that discovers files, parses with OXC, spawns `grafema-analyzer` per file, ingests results into RFDB, and runs plugins via DAG.

## Current State

- RFDB server exists: Rust, MessagePack over unix socket, protocol v3
- No orchestrator exists — currently Node.js `packages/core/` does this
- OXC is available as Rust crate (`oxc_parser`, `oxc_ast`)
- CommitBatch protocol: batch nodes/edges with `changedFiles` for GC

## Tasks

| Task | Title | Depends On | Status |
|------|-------|------------|--------|
| 2.1 | [Cargo scaffold](2.1-cargo-scaffold.md) | — | Todo |
| 2.2 | [RFDB client](2.2-rfdb-client.md) | 2.1 | Todo |
| 2.3 | [Config and discovery](2.3-config-and-discovery.md) | 2.1 | Todo |
| 2.4 | [OXC parsing](2.4-oxc-parsing.md) | 2.1 | Todo |
| 2.5 | [Analysis spawning](2.5-analysis-spawning.md) | 2.2, 2.3, 2.4 | Todo |
| 2.6 | [Plugin DAG runner](2.6-plugin-dag-runner.md) | 2.2 | Todo |
| 2.7 | [Generation-based GC](2.7-generation-gc.md) | 2.2 | Todo |
| 2.8 | [Integration tests](2.8-integration-tests.md) | 2.5, 2.6, 2.7 | Todo |

## Dependency Graph

```
2.1 ─┬─ 2.2 ──┬─ 2.5 ─┐
     ├─ 2.3 ──┤        ├── 2.8
     └─ 2.4 ──┘        │
         2.6 ───────────┤
         2.7 ───────────┘
```

## Success Criteria

1. `grafema-orchestrator analyze --config grafema.config.yaml` discovers files, analyzes them, ingests into RFDB
2. Plugin DAG execution works: plugins run in dependency order
3. Incremental analysis: only changed files re-analyzed
4. Generation GC cleans up stale nodes/edges
5. `cargo test` passes all integration tests
