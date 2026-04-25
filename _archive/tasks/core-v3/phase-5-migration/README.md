# Phase 5: Migration — DEFERRED

## Goal

Integrate `grafema-orchestrator` into the main Grafema CLI, replacing the Node.js core-v2 pipeline. Migrate remaining plugins.

## Status

**Deferred** — will be planned when Phases 1–4 are complete.

## Scope (preliminary)

- Wire `grafema-orchestrator` into `grafema analyze` CLI command
- Maintain backward compatibility for existing config files
- Migration path for custom user plugins (if any)
- Deprecation warnings for core-v2 pipeline
- Performance benchmarks: v2 vs v3 on real codebases
- Documentation updates

## Planning Prerequisites

- Phases 1–4 complete and stable
- All enricher plugins migrated (Phase 4)
- Integration tests passing on real-world codebases
- Performance is at parity or better than v2
