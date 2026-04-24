# DAI-22 — Implementation Summary

**Branch:** `task/dai-22-per-symbol-layout`
**Session:** 2026-04-23/24, autonomous execution per plan v2 (`004-plan-revised.md`) + 3-pass Dijkstra v3 APPROVE.

## Before → After

| Metric | Before (tectonic file-LOD) | After (per-symbol) |
|---|---|---|
| Placed symbols on grafema self | 614 (files only) | 26,240 |
| Distinct (q,r) on 10k top stream | 35 | 608 |
| Worst collision | 858 nodes at one tile | **0 — every placed symbol is unique** |
| `layout_meta` contract | — | `source / symbol_count / committed_at / overflow_files[]` |
| Region tree | flat container list | nested depth-6 tree with hulls |
| Layout compute | 644ms (tectonic on 614 atoms) | 1.86s (orchestrator on 28,637 symbols) |
| `layout --commit` wall-clock | N/A | **7s** (gate 30s → 4× headroom) |
| Idempotency of re-commit | N/A | Identical counts across runs |

## Commits

| Chunk | SHA | Scope |
|---|---|---|
| Plan+Dijkstra | `6ef7ecf6` | Full planning + 3-pass verification docs |
| 0 | `4ea99e4d` | `delete_{edges,nodes}_by_type_and_source` RPCs (O(N_type), fail-loudly collision) |
| 1 | `da3716ff` | Per-symbol loader with NodeIdx↔u128 side-map + degree (20 PLACEABLE types, 19 LIFTABLE edge types, virtual-prefix filters) |
| 3 gate | `c1317b5f` | Merge-gate bench result — 1.86s on real graph, 16× under budget |
| 2 | `a1758969` | Commit pass: pre-pass delete + REGION nodes + CONTAINS + LAYOUT_POSITION per-symbol + `--max-symbols-per-file` hard-cap (degree-desc) |
| 4 | `9c9d85fd` | Server rewrite: drop tectonic consumer, read persisted LAYOUT_POSITION/REGION, emit `layout_meta` + `unplaced_reason` |
| 5 | `33f11123` | Delete `tectonic_layout.rs` (3,637 lines) + `lib.rs`/`loadStream.ts` cleanup |
| 6 | `0b1ffc90` | GUI consumer: `layoutStore` slice, empty-layout overlay, `OverflowBadge` (red badge per file, hard-cap tooltip) |
| 7 | `31293821` | Morphological-close hull per REGION (dilate/erode/trace + ring/disjoint/1-cell/zero-leaf policies) |
| 8 | `50e58f84` | LOD policy module: `visibleAtZoom`, D_max fallbacks, `hullCache` slice |
| 8b | `7aa30016` | Wire HullLayer to `hullCache` + per-frame LOD; retire `__grafemaTileCoords` path |
| 9 | `c8be3547` | Route LOD gate per §C.5: hide route on any collapsed node (no shortcut) |
| 10a | `e1187dff` | Data-integrity verify script — D.1 + D.5 all PASS |

**Total:** 13 commits. No push. No PR.

## Verification results

Run via `./scripts/dai22-verify-data.sh` against live `.grafema/graph.rfdb`:

```
regions.max_depth = 6
PASS D.1: regions.max_depth = 6
PASS D.1: layout_meta.source = committed, symbol_count = 26240
unplaced_reason: {None: 26240, excluded: 300822, missing_layout: 0, skipped_overflow: 2397}
placeable = 28637, placed = 26240, distinct positions = 26240
PASS D.1: placed/placeable = 91.63%
PASS D.1: distinct/placed = 100.00%
PASS D.1 idempotency: Committed 26240 LAYOUT_POSITION edges, 767 REGION nodes, 27006 CONTAINS edges
commit wall-clock: 7s (D.5 gate: 30s)
```

The original bug — "3,245 nodes stacked at (-10, 10), 858 worst collision, 35 distinct positions on 10k stream" — is resolved: **zero collisions**.

## What's deliberately deferred to Chunk-10b (Playwright)

§D.2 (rendering), §D.3 (interactions), §D.4 (visual regression) require a browser harness. Chunk-10a (`e1187dff`) covers the headless subset:

- §D.1 — data integrity ✅
- §D.5 — perf gates ✅
- §D.2 — rendering visible-at-zoom / first-frame / 30fps — ⏸ Playwright
- §D.3 — hover / click / pin / zoom transitions / route draw / selection ancestry / 2D/3D toggle / reload persistence / keyboard / context-menu / red-badge / empty-overlay — ⏸ Playwright
- §D.4 — pixel-content visual regression — ⏸ Playwright

Recommended follow-up scope: one subagent writing `packages/gui/scripts/playwright-verify-dai22.mjs` with the full D.3 scenario matrix. Prerequisite: the GUI already reads from the live rfdb-server (existing `playwright-verify-real.mjs` is the template).

## Known residual items

- Stale log string in `packages/rfdb-server/src/bin/rfdb_server.rs` still reads "tectonic layout" (cosmetic) — flagged in Chunk-5 report, not touched.
- VS Code extension (`packages/vscode/src/mapPanel.ts`) — grep found no tectonic references in Chunk-5; no action required.
- Hull compute on a root-aggregating tree: 580ms (Chunk-7 report). Mitigated in Chunk-8 by skipping depth-0 root hull — root never gets computed, per §C.3 policy.
- `parse-parity.test.ts` in GUI is pre-existing failing on `main` (verified before DAI-22 by Chunk-7 subagent) — unrelated.

## Architectural shift

Server transformed from a compute engine (tectonic pipeline per warmup) into a thin read layer: warmup is now `get_edges_by_type("LAYOUT_POSITION") + get_nodes_by_type("REGION") + metadata parse`. Compute moved to orchestrator `layout --commit` which runs once per analyze. Matches user intent: "layout once, render many; LOD at render time."

Client gained a full hull-based LOD pipeline — morphological-close geometry cached by region id, per-frame depth-normalized zoom gate with D_max fallbacks, painter's-algorithm z-order, symbols-at-top-zoom-only policy. Hard-cap of 500 symbols/file with red-badge UX for overflow.
