# Core V3: Task Decomposition

Graph-driven rewrite of Grafema's analysis pipeline: Haskell per-file analyzer + Rust orchestrator + plugin architecture.

## Architecture

```
Phase 1: Haskell Per-File Analyzer (grafema-analyzer)
  - Complete intra-file scope resolution
  - Clean external contract: { nodes, edges, exports }

Phase 2: Rust Orchestrator (grafema-orchestrator)
  - File discovery, OXC parsing, analyzer spawning
  - RFDB ingestion, plugin DAG execution, generation GC

Phase 3: Resolution Plugins (grafema-resolve)
  - Cross-file import resolution
  - Runtime globals matching
```

## Dependency Graph

```
Phase 1 (Haskell analyzer)     Phase 2 (Rust orchestrator)
  1.1 ─┐                         2.1 ─┬─ 2.2
  1.2 ─┤                               ├─ 2.3
       ├─ 1.3 ─── 1.4                  ├─ 2.4
  1.5 ─┘                         2.2 ──┤
                                 2.3 ──┼─ 2.5
                                 2.4 ──┘
                                 2.2 ──── 2.6
                                 2.5 ─┬── 2.8
                                 2.6 ─┤
                                 2.7 ─┘

Phase 3 (requires Phase 1 + Phase 2.6)
  3.1 ─── 3.2 ─┬─ 3.3
               └─ 3.4

1.6 runs in parallel throughout (tests for each task as it lands)
```

**Phase 1 and Phase 2 can run in parallel** — no code dependencies between them.
Phase 3 requires both.

## Key Decisions

- **Rust first**: orchestrator built before Haskell plugins
- **Independent core-v3**: built/tested separately, no core/ modifications
- **Plugins deferred**: 42-plugin migration is later phases
- **Scope persistence**: Option C — derive from emitted SCOPE/HAS_SCOPE/DECLARES graph data
- **Import resolution**: batch plugin (needs random RFDB access)
- **OXC**: Rust crate directly in orchestrator (not Node.js wrapper)
- **SemanticId**: string from Haskell, orchestrator converts to u128 via BLAKE3

## Phases

| Phase | Directory | Status |
|-------|-----------|--------|
| 1 | `phase-1-haskell-analyzer/` | Ready |
| 2 | `phase-2-rust-orchestrator/` | Ready |
| 3 | `phase-3-resolution-plugins/` | Ready |
| 4 | `phase-4-enrichment/` | Deferred |
| 5 | `phase-5-migration/` | Deferred |

## Task Naming Convention

`<phase>.<task>-<slug>.md` — e.g., `1.3-resolve-file-refs.md`

Each task file contains: goal, files to modify/create, subtasks, acceptance criteria, dependencies.
