# DAI-22 — Per-symbol layout + hull-based LOD

**Status:** DRAFT — awaiting Dijkstra review
**Supersedes hypothesis in:** `001-handoff.md` (phase-3 drift "neutered" — WRONG; real cause is `ATOM_TYPES=[MODULE]` + file_fallback in `http_server.rs`).

## 0. Decisions (fixed by user)

1. **No backward compatibility.** Drop server-side tectonic pipeline outright. No fallback for old bases.
2. **`layout` remains a separate CLI subcommand** of orchestrator. NOT auto-chained into `grafema analyze`. User runs it explicitly after analyze.
3. **Two-pass hierarchical pack (B).** Folder tree → file cluster → symbols inside file cluster. NOT flat leaves.
4. **Regions are hulls, not hexagonal clusters.** Morphological close (skill `hex-grid-morphological-close-hull`) over member cells. Hulls nest (folder contains file contains symbol).
5. **≥ 9 LOD zoom levels.** Small hulls hidden at low zoom; individual symbols appear only at high zoom. Actual level count determined by folder depth of real codebases (likely 10–14).
6. **Exhaustive verification.** Playwright against live 328k-node graph: load, render, hover, tooltip, pin, zoom transitions, route rendering, selection.

## 1. Architecture target

```
        ┌─────────────────────┐
        │  grafema analyze    │   (unchanged — produces RFDB with nodes/edges)
        └──────────┬──────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │  grafema layout     │   (extended: pack all symbols + hulls)
        │   --commit          │   writes LAYOUT_POSITION edges +
        └──────────┬──────────┘   REGION nodes + CONTAINS edges
                   │
                   ▼
                 RFDB
                   │
                   ▼
        ┌─────────────────────┐
        │  rfdb-server        │   (warmup reads LAYOUT_POSITION + REGION,
        │  /api/graph-stream  │    streams pos per node, no recomputation)
        └──────────┬──────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │  HexAtlas (GUI)     │   (hull computation + LOD rendering;
        │  React + Three.js   │    all interactions on real symbol tiles)
        └─────────────────────┘
```

Server becomes a dumb lookup: `node.id → (q, r)` from persisted `LAYOUT_POSITION`. No phases, no drift, no re-computation per request. This is the "lay out once, only render" property the user specified.

## 2. Phase A — Orchestrator: per-symbol layout

### A.1 — Extend loader to all symbol types

`packages/grafema-orchestrator/src/layout/loader.rs`

**Current:** `query_nodes_by_type("MODULE")` → 614 leaves, DEPENDS_ON edges.

**Change:** loop over symbol types that should be placed individually. Initial set (matching old tectonic comment in `http_server.rs:393-398`):

```
MODULE, FUNCTION, METHOD, CLASS, VARIABLE, INTERFACE, TYPE, ENUM, STRUCT, TRAIT
```

Excluded (too granular, too noisy): CALL, REFERENCE, PARAMETER, LITERAL, BRANCH, PATTERN, SCOPE, PROPERTY_ACCESS, IMPORT, CASE, EXPRESSION, DO_BLOCK, METRIC, EFFECT, CONSTRUCTOR, ISSUE, HEX.

Edge source (liftable across symbols) — union of:
```
CALLS, READS_FROM, WRITES_TO, IMPORTS_FROM, DEPENDS_ON,
PASSES_ARGUMENT, AWAITS, RETURNS, ITERATES_OVER, HAS_METHOD
```
(Same set as tectonic `liftable` in `http_server.rs:499-503`.)

Skip edges whose endpoints are not both in the symbol set. Dedup by `(src, dst, edge_type)`.

### A.2 — Two-level folder tree

**Current:** `FolderTree::build_from_paths(pairs)` where each `pair = (NodeIdx, path)`; leaf = file.

**Change:** each symbol node gets a synthetic path `<folders>/<file>/<symbol-semantic-id>`. File becomes a real folder in the tree (last folder before leaves). Symbols are leaves.

Two implementation options:
- **(i)** Extend `FolderTree::build_from_paths` to accept a flag marking files as folders (path ends with file extension → treat as folder level).
- **(ii)** Append symbol name as extra path segment, unchanged builder: `src/foo.ts/funcBar`.

**Pick (ii)** — no builder change. The existing `pack_folder` recursion naturally handles this: `src/foo.ts` becomes a folder containing per-symbol leaves.

Risk: path collisions. Two symbols with the same name in the same file (e.g. overloaded methods in class bodies). Use semantic id as the leaf segment — guaranteed unique.

### A.3 — Pack: performance & two-pass handling

**Validate before commit.** Benchmark current `pack` on 328k leaves (grafema self-analysis). Acceptance: ≤ 30s wallclock on dev laptop. If blown:

- **Split intra-file packing.** Folder pack stops at file level, reserving a cluster of `K = symbols_in_file` cells. Then a per-file sub-pack fills those cells by spiral from seed (order by node degree desc, so central functions get inner cells). `pack_folder` recursion can already do this — no new code needed; the sub-pack is just the innermost recursion level.
- **Cap iswap per-folder.** `iswap` is O(K²) intra-folder. For files with > 100 symbols, bound `max_passes` or use top-K neighbour heuristic. Benchmark first — maybe not needed.
- **Skip xswap for leaf files.** xswap is boundary swap between sibling folders; meaningful at folder level, not inside a single file. Skip when folder is a file.

### A.4 — Commit: LAYOUT_POSITION per symbol + REGION nodes

`packages/grafema-orchestrator/src/layout/commit.rs`

**Current:** one edge per MODULE, `MODULE_id → HEX::<q>,<r>`, type `LAYOUT_POSITION`.

**Change:** one edge per placed symbol, same shape. `semantic_ids[i]` is now the symbol's semantic id (not MODULE id).

**NEW: emit REGION nodes + CONTAINS edges for hull hierarchy.**

For each folder in `FolderTree`:
- `REGION` node with fields:
  - `id` = synthetic `REGION::<depth>::<path>`
  - `name` = folder name (e.g. `src`, `foo.ts`)
  - `depth` = folder level (0 = root)
  - `path` = full folder path
  - `kind` = `"folder"` | `"file"`
- `CONTAINS` edges:
  - `REGION(parent) → REGION(child)` for nesting
  - `REGION(file) → SYMBOL` for leaves

The hull itself is NOT pre-computed in Rust — client computes morphological close from member cells. Server ships the containment tree + positions; hull geometry derives on render.

Rationale for in-graph regions (vs sidecar JSON): stays queryable via Datalog, deletable via `DELETE edges WHERE type=LAYOUT_POSITION OR type=CONTAINS AND src.type=REGION`, and consistent with existing `LAYOUT_POSITION` pattern.

Scope of REGION writes: ensure we write/delete only layout-source ones (`_source: "layout-pack"` metadata tag — same pattern as current commit). Pre-existing CONTAINS edges from analyzer are untouched.

### A.5 — Delete the "synthetic mode guard" relaxation

Currently `commit_layout` refuses to run on synthetic-input layouts. Keep that guard as-is.

### A.6 — CLI UX

`grafema layout --commit` already exists (per main.rs:2808). Add:
- `--verbose` — per-phase timings
- Success output: `Committed N LAYOUT_POSITION edges, M REGION nodes, P CONTAINS edges`
- Error when RFDB has zero symbol nodes (analyze not run yet)

## 3. Phase B — Server: drop tectonic, read persisted pos

### B.1 — Delete tectonic pipeline from warmup path

`packages/rfdb-server/src/http_server.rs`

- Remove `ATOM_TYPES` constant.
- Remove `build_atom_hierarchy`.
- Remove `tectonic_preprocess/phase1_place/phase2_flood_fill/phase3_drift/phase4_refine_boundaries` calls in `get_or_build_layout`.
- Remove `file_fallback` field from `CachedLayout`.
- Remove import of `tectonic_layout`.
- Delete `packages/rfdb-server/src/tectonic_layout.rs` (3637 lines) — no BC path needed.
- Delete related tests in `packages/rfdb-server/tests/` that assert on tectonic internals.

### B.2 — New warmup: load LAYOUT_POSITION + REGION

New `CachedLayout`:
```rust
struct CachedLayout {
    /// node_id → (q, r)
    positions: HashMap<u128, HexCoord>,
    /// region tree for LOD
    regions: Vec<RegionInfo>,
    /// region_id → children (region ids and/or symbol node ids)
    containment: HashMap<u128, Vec<u128>>,
}
```

Warmup reads:
- All `LAYOUT_POSITION` edges: `src` = symbol id, dst id encodes `(q, r)` — decode from the synthetic `HEX::<q>,<r>` semantic id via reverse lookup on node.id → node.semantic_id (or bake q/r into edge metadata at commit time to avoid a lookup round-trip — prefer **metadata** for directness).

  **Decision:** commit stores `(q, r)` **inline in edge metadata** as `{"_source":"layout-pack","q":N,"r":M}` — server reads q/r from metadata, no HEX:: lookup needed. HEX:: dst remains for Datalog queryability.

- All `REGION` nodes + CONTAINS edges rooted at them.

### B.3 — Stream emission

`build_graph_stream_body`:
- For each streamed node: `pos` = `positions.get(&node.id)` → `{q, r}` or `null` (symbol not in layout, e.g. CALL/LITERAL).
- Header frame: include `regions` as the REGION tree (depth, name, kind, children) — client uses this for LOD.
- Remove `tectonic_meta` message; replace with `layout_meta` (source tag, commit timestamp, symbol count).

### B.4 — Empty-layout UX

If `positions` is empty on warmup:
- eprintln WARN: "No LAYOUT_POSITION edges. Run `grafema layout --commit` after `grafema analyze`."
- `/api/graph-stream` still succeeds but emits `pos: null` for every node. `layout_meta` carries `source: "missing"` flag.
- GUI shows overlay: "Layout not computed. Run `grafema layout --commit` and reload."

### B.5 — Orchestrator: remove the in-memory layout cache for HTTP warmup

Keep `RwLock<Option<CachedLayout>>` but it now caches persisted-data-loads, not computation results. Invalidated on RFDB reload (existing `reload()` endpoint).

## 4. Phase C — Client: hull-based LOD

`packages/gui/src/HexAtlas.tsx` + `packages/gui/src/store/loadStream.ts`

### C.1 — Load path

- `loadStream` consumes new header `regions` (REGION tree) → stores in `viewStore.regions`.
- `layout_meta.source === "missing"` → dispatch overlay modal.
- Node `pos: null` handling: skip from tile rendering; include in search/tooltip datasets but mark as "unplaced".

### C.2 — Hull computation

For each REGION, on load compute:
- Member cells (leaves of its subtree).
- Morphological close hull via existing skill pattern (`hex-grid-morphological-close-hull`). Output: ordered outer boundary of cells, union-including 1-tile gaps.

Cache in a `regionHulls: Map<regionId, HullGeometry>` keyed by region id. Recompute on reload, not on zoom.

### C.3 — LOD policy

Depth-to-zoom mapping. If folder depth spans 0..D_max (D_max ≥ 9):

| Zoom | Visible hulls | Visible symbols |
|------|---------------|-----------------|
| min (fit-all) | depth 0..2 only | no |
| −N | depth 0..D_max-N | no |
| 0  | all depths | no |
| +1 | all depths | yes, faded |
| max | all depths | yes, full opacity |

Specific depth cutoffs: linear in log-zoom, tunable in `viewStore.lodPolicy`. Smallest hulls (below K cells at current zoom) hidden regardless of depth — reduces clutter.

### C.4 — Rendering

Three layers (Three.js groups):
- **Hulls layer** — one mesh per visible region, hull polygon extruded/flat per 2D/3D mode.
- **Symbols layer** — hex tiles, instanced mesh. Visible subset = in-frustum AND zoom-level allows.
- **Routes layer** — edges between symbols; at low zoom, edges between hulls (aggregated by `CALLS` count).

### C.5 — Interactions (every one exercised in Phase D tests)

- **Hover** — raycast against symbols layer first; fallback to hulls. Tooltip: symbol name + file + region path.
- **Click / select** — highlight hex tile + its ancestor hull chain (emphasis on containing hull).
- **Pin** — persistent marker + toolbar chip; survives pan/zoom; multiple allowed.
- **Routes** — "show path from A to B" control picks two pinned symbols, highlights all CALLS / READS_FROM edges on the shortest path; passing through regions emphasises their hulls.
- **Zoom transitions** — hulls fade in/out on depth threshold; symbols fade in on reaching highest LOD; hysteresis band prevents flicker.
- **2D ⇄ 3D toggle** — hulls re-projected on Z=0 plane (2D) vs slight extrusion (3D). No layout recompute.

## 5. Phase D — Verification (MANDATORY per user)

Playwright suite in `packages/gui/scripts/playwright-verify-dai22.mjs`, running against a fresh `grafema analyze . && grafema layout --commit` on the grafema repo.

### D.1 Data integrity
- Stream completes without error.
- Header `regions` tree has ≥ 9 depth levels.
- Placed-symbol count (non-null `pos`) ≥ 95% of symbol-typed nodes in graph.
- Distinct `(q, r)` count ≥ 80% of placed-symbol count (not more than 20% collision).

### D.2 Render
- At canonical "fit-all" zoom: ≥ 100 distinct hull meshes visible.
- At max zoom on a single file: ≥ 90% of that file's symbols rendered as distinct tiles.
- First-frame time ≤ 3s on 328k nodes.
- Pan/zoom frame time ≥ 30fps sustained (measured via `performance.measure`).

### D.3 Interactions (each asserted programmatically, not by screenshot)
- Hover over a known symbol tile → tooltip visible, text contains symbol name.
- Click symbol → selection DOM marker present; ancestor-hull emphasis class applied.
- Pin symbol → pin chip in toolbar; persists after pan; persists after zoom.
- Zoom out 5 levels → child-hull meshes removed from scene graph (assertion on `scene.children.length` or named group size).
- Zoom in 5 levels → symbol instanced mesh count rises to expected visible set.
- Route control: pin A, pin B, click "route" → route layer has edges; each edge connects endpoints whose `(q,r)` match visible tiles.

### D.4 Visual regression
- Pixel-content assertions (same methodology as `playwright-verify-real.mjs`) at 3 zoom levels: fit-all, mid, max.
- Fail if > 30% of screen is a single colour (screen-of-20-tiles detection).

### D.5 Performance gates
- `grafema layout --commit` on grafema-self graph: ≤ 30s wall clock.
- rfdb-server warmup post-layout: ≤ 2s (reading edges, not computing).

## 6. Phase E — 3-Review + commit + PR

Per `_ai/workflow.md` v3. Steve / Вадим auto / Uncle Bob Opus in parallel. Single batch. ANY REJECT → fix + re-run all 3.

## 7. Scope / sibling checks

- Delete `packages/rfdb-server/src/tectonic_layout.rs` entirely. Grep for other importers — none expected, but confirm.
- Delete tectonic tests in `packages/rfdb-server/tests/`. Confirm by list.
- `_archive/packages-gui-server/` — untouched (archived).
- `effects-db/` — untouched.
- BEAM / Haskell / Python analyzers — untouched.
- Parity script `packages/gui/scripts/test-cubeToWorld-parity.mjs` — untouched (hex math unchanged).

## 8. Atomic implementation chunks (for coding subagents)

1. **Chunk-1** `loader.rs` — multi-type symbol query + symbol-leaf paths. Red-first tests on synthetic input.
2. **Chunk-2** `commit.rs` — symbol-keyed edges + inline `(q, r)` metadata + REGION nodes + CONTAINS.
3. **Chunk-3** benchmark on 328k leaves; if fails, add per-file sub-pack optimisation.
4. **Chunk-4** `http_server.rs` — drop tectonic imports/calls, new `CachedLayout`, warmup reads persisted. Header emits `regions` tree.
5. **Chunk-5** delete `tectonic_layout.rs` + related tests; confirm grep-clean.
6. **Chunk-6** GUI header consumer + region store + `layout_meta.source === "missing"` overlay.
7. **Chunk-7** hull compute + caching in GUI.
8. **Chunk-8** LOD policy + rendering layers.
9. **Chunk-9** route rendering (existing? augment; else new).
10. **Chunk-10** Playwright verify script + assertions D.1–D.5.

Each chunk ≤ 3 files. TDD red-first. Each chunk landed behind a tmp branch commit before the next starts (so failures don't cascade).

## 9. Open questions for Dijkstra review

- Are all primitive symbol types from A.1 the right initial set, or too broad? (Risk: INTERFACE/TYPE/STRUCT may explode leaf count on typescript-heavy graphs — if so, include them behind a flag.)
- Is the "inline (q, r) in edge metadata" the right shape, or is a separate `LAYOUT_POS` node per symbol better? (Metadata is simpler, no node explosion; lean inline unless reviewer objects.)
- Should REGION node have its own hex cell or purely be a containment anchor? (I argue: containment only — hulls are derived geometry, no primary cell.)
- Zoom level mapping: log-linear, or content-adaptive (budget N cells per frame, pick deepest visible regions)? Content-adaptive is better; can start log-linear and iterate.

## 10. Risks

- **Layout compute time on 328k leaves may exceed 30s.** Mitigation: sub-pack per file; cap iswap; skip xswap on files. Benchmark before Phase B/C.
- **Server warmup loading 328k LAYOUT_POSITION edges + iterating to build positions HashMap.** Expected ~seconds; acceptable. If not, consider read-through cache.
- **Hull computation on client for ≥ 1000 regions may be slow.** Mitigation: compute incrementally (largest regions first, stream in); or precompute in Rust and ship ordered boundary.
- **Morphological close over disconnected cells (same region spread across hex areas due to non-perfect pack)** — skill `hex-grid-morphological-close-hull` explicitly handles this.
- **Playwright flake on animated transitions** — use deterministic zoom steps (no animation) in test mode.
