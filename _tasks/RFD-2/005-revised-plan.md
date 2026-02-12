# RFD-2: Revised Plan (Post Steve Review)

## Scope (Simplified)

1. Add `consumes: EdgeType[]`, `produces: EdgeType[]` as optional fields on `PluginMetadata`
2. Create `buildDependencyGraph()` — merges inferred + explicit deps
3. Update Orchestrator `runPhase('ENRICHMENT')` to use it (static imports)
4. Update all 14 registered enrichers with consumes/produces metadata
5. Tests (~15 cases)

## Excluded (YAGNI)
- `relevantFiles()` / `processFile()` — add when needed
- `EnricherV2` separate interface — not needed
- `V1EnricherAdapter` — all enrichers updated in this PR
- Nested `consumes: { edges, nodes }` — flat arrays only
- Dynamic imports — static imports in Orchestrator
- `isEnricherV2()` type guard — not needed without V1/V2 split
- Unregistered enricher updates (3) — separate task

## Estimated: ~250 LOC, ~15 tests
