# RFD-2: Enricher Contract v2

## Linear Issue
https://linear.app/reginaflow/issue/RFD-2/t12-enricher-contract-v2

## Description

Enricher Contract v2 (Track 2, TS). Orchestrator Phase A. New enricher contract — no RFDB v2 dependency.

**~400 LOC, ~20 tests**

### Subtasks

1. Define `EnricherV2` interface (`relevantFiles()`, `processFile()`)
2. Define `EnricherMetadata` with `consumes: EdgeType[]`, `produces: EdgeType[]`
3. Audit all 14 enrichers: determine consumes/produces for each
4. Implement `V1EnricherAdapter` for backward compatibility
5. Add `relevantFiles()` to existing enrichers (default: all changed files)
6. Add `processFile()` alongside existing `execute()`
7. Build enricher dependency graph from consumes/produces (Kahn's algorithm)

### Validation

- Unit tests: enricher metadata declares correct consumes/produces
- Dependency graph: no cycles (Kahn's detects)
- V1Adapter: legacy enricher through adapter = same results as direct
- All existing enrichment tests pass through V1Adapter

### Deliverables

`EnricherV2.ts`, adapter, metadata updates

### Dependencies

None
