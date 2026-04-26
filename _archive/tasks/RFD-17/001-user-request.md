# RFD-17: T5.3 Enricher Dependency Propagation

## Source
Linear issue RFD-17

## Request
Implement enricher dependency propagation for the orchestrator (Phase C).

When an enricher's output changes, downstream enrichers that consume that output must be re-run.

## Subtasks
1. Build enricher dependency graph from consumes/produces
2. Propagation: enricher A output changed → downstream enrichers re-run
3. Termination proof (DAG + bounded iterations)

## Validation
- Change in enricher A → enricher B (consuming A) re-runs
- No cycles in dependency graph
- Termination: worst case = all enrichers re-run (v1 behavior)

## Dependencies
- ← RFD-16 (T5.2: Orchestrator Batch Protocol) — completed

## Scope
~200 LOC, ~10 tests
