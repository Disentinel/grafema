# RFD-16: T5.2 Orchestrator Batch Protocol

## Task

Orchestrator Phase B. Switch from `addEdge()` to CommitBatch. Delta-driven selective enrichment.

~500 LOC, ~20 tests

## New Pipeline

1. Analysis → CommitBatch(file) → delta
2. Pre-commit blast radius (C4) → dependent files
3. For each enricher (toposorted): processFile → CommitBatch(enrichment context) → enricher delta
4. Delta-driven enricher selection

## Enricher Selection (Type-Aware)

- **Level-0 enrichers** (consume analysis nodes): always run on changed files. Optional `nodeInterest` metadata for filtering.
- **Level-1+ enrichers** (consume edges from other enrichers): use `changedEdgeTypes ∩ consumes`

## Subtasks

1. Switch from `addEdge()` to CommitBatch calls
2. Enrichment shard file context (`__enrichment__/{enricher}/{file}`)
3. **Pre-commit blast radius query (C4):** query dependents BEFORE commit
4. Use CommitBatch delta for selective enrichment
5. Delta-driven enricher selection with correct type handling

## Validation

- Blast radius: add edge A→B, change B → A detected as dependent
- Selective enrichment: change FUNCTION → only relevant enrichers run
- Full pipeline: analysis → blast radius → commit → selective enrichment → correct graph

## Dependencies

← T4.1, T3.2, T1.2
