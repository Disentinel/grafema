# Phase 4: Enrichment Plugins — DEFERRED

## Goal

Migrate 18 enricher plugins from core-v2 JavaScript to Haskell plugins using the unified plugin protocol.

## Status

**Deferred** — will be planned when Phases 1–3 are complete and the plugin infrastructure is proven.

## Scope (preliminary)

Enricher plugins from core-v2 that need migration:
- Data flow analysis (ASSIGNED_FROM, READS_FROM edges)
- Property resolution (HAS_PROPERTY edges)
- Return type inference
- Callback detection
- Promise chain analysis
- Event emitter wiring
- Route handler detection
- Middleware chain analysis
- Configuration value tracking
- And others (full inventory TBD)

## Planning Prerequisites

- Phase 1 complete: analyzer output is stable
- Phase 2 complete: plugin DAG runner is working
- Phase 3 complete: resolution plugins validate the protocol
- Performance baseline established for current plugins
