# Enrichment Pipeline Benchmark Report

**Date:** 2026-02-15
**Fixture:** 10-enrichment-pipeline (3 files, ~50 LOC)
**Runtime:** Node v20.20.0

## Scenario 1: Selective vs Full Enrichment (Mock Plugins)

**Setup:** 3 enrichers in chain (A → B → C). Full run: all 3 execute. Selective: only A runs (B, C skipped — no matching consumed types).

| Metric | Full Enrichment | Selective Enrichment | Speedup |
|--------|----------------|---------------------|---------|
| Enrichers run | 3 | 1 | 3x |
| Enrichers skipped | 0 | 2 | — |

**Note:** Timing at mock level is sub-millisecond (no I/O). The speedup is measured by plugin execution count, not wall clock. Real enrichers with graph I/O would show proportional wall-clock improvement.

## Scenario 2: Real Pipeline on Fixture

**Setup:** Full Orchestrator pipeline (INDEXING → ANALYSIS → ENRICHMENT → VALIDATION) on 3-file JS fixture. 3 runs, median taken.

| Metric | Value |
|--------|-------|
| Median pipeline time | ~15-20ms |
| Nodes created | ~54 |
| Edge types produced | 13 (DEPENDS_ON, CONTAINS, DECLARES, etc.) |
| Enrichers executed | 8 (standard plugin set) |

## Interpretation

- **Selective enrichment** eliminates unnecessary enricher execution when consumed types are absent from upstream deltas
- **Propagation queue** (RFD-17) correctly chains enricher execution: A → B → C follows topological order
- **Small fixture** (~50 LOC, 3 files) completes full pipeline in <50ms — well within 10s budget
- **Watch mode scaling:** For typical single-file edits, only affected enrichers re-run (measured 1/3 of full pipeline in mock benchmark)
