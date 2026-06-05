# DAI-22 Chunk-3 — Merge Gate Result

**Date:** 2026-04-24
**Status:** ✅ PASSED (by large margin — no §A.3b mitigations needed)

## Setup
- Real grafema self-analysis graph (328,711 nodes / 632,977 edges)
- Loader output post Chunk-1 (commit `da3716ff`)
- Binary: `grafema-orchestrator layout --socket … --config …` (no `--commit`)
- Default RunOpts (pack + iswap + xswap, no mitigations applied)

## Metrics
```
Tree: 767 folders (max depth 6), 1502 liftable edges, 28637 placeable symbols
pack:   55 ms   Σlinks = 11418
iswap:  199 ms  5217 swaps, Σlinks = 2561 (−77.6%)
xswap:  5 ms    0 swaps, Σlinks = 2561
total:  1861 ms
```

## Gate
- Budget: 30,000 ms
- Actual: 1,861 ms
- Margin: ~16× under budget

## Notes
- 1 torn folder (`packages/swift-analyzer/src/Rules` — 146/157 connected) and 2854 sibling_gaps are quality metrics from `validate.rs`, not correctness errors.
- Liftable edge count is low (1502). Most CALL/READS_FROM edges in the graph have at least one endpoint that is a CALL or REFERENCE node (non-placeable), so they are dropped by the "both endpoints in placeable set" rule. Cohesion signal is modest but structural folder tree carries 77.6% of the layout quality via iswap reduction.
- Synthetic A.3a bench (159s on 30k, shallow 3-depth tree) was a pessimistic extreme — real depth-6 tree with K≈37/folder avg is ~15× faster than synthetic K≈275/folder.

## A.3b mitigation application
**Not applied.** All ladder items remain available as options if future larger codebases blow the gate, but v1 ships without them.

## Decision
Proceed directly to Chunk-2 (commit path) without mitigations.
