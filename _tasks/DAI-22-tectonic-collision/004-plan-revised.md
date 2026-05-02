# DAI-22 — Plan v2 (revised after Dijkstra REJECT)

**Status:** DRAFT v2 — awaiting second Dijkstra pass and benchmark results
**Supersedes:** `002-plan.md` (preserved as historical record)
**Addresses Dijkstra findings:** `003-dijkstra-verification.md` (12 completeness tables, 6 blocking gaps, 3 preconditions)

## 0. Updated measurements (from live graph)

RFDB contains 328,711 nodes / 632,977 edges. Of those, the **placeable symbol set (revised per Dijkstra Table 1) is ~35k, not 328k**. Breakdown from live counts:

```
MODULE 614  FUNCTION 8763  METHOD 683  CLASS 70  VARIABLE 11542
CONSTANT 5171  INTERFACE 560  TYPE_ALIAS 87  TYPE_SYNONYM 133
DATA_TYPE 289  ENUM 34  STRUCT 229  TRAIT 2  IMPL_BLOCK 155
NAMESPACE 1  VARIANT 228  INSTANCE 216  GLOBAL_DEFINITION 38
EXTERNAL_FUNCTION 40  EXTERNAL_MODULE 10
→ core total 28,865
+ borderline (LAMBDA 328, CLOSURE 1566, TYPE_SIGNATURE 1738, METHOD_SIGNATURE 212, PROPERTY_SIGNATURE 2297)
→ grand total ≤ 35,006
```

Perf gate recomputed around 35k leaves, not 328k. Benchmark results (running live) will confirm before Phase B kickoff.

## 1. Decisions (fixed by user — unchanged from v1)

1. No backward compatibility.
2. `layout` remains separate CLI subcommand.
3. Two-pass hierarchical pack (B).
4. Regions = morphological hulls.
5. ≥ 9 LOD zoom levels.
6. Exhaustive Playwright verification.
7. **NEW (user answer to Gap 8):** hard-cap of 500 placed symbols per file. Overflow → file's red UI badge "N symbols not displayed, hard cap, raise in config at your own risk". No layout-level fallback; overflow is a rendering concern.

## 2. Architecture target — unchanged from v1 §1

## 3. Phase A — Orchestrator: per-symbol layout

### A.1 — Loader: extended node-type include list + explicit exclude list

`packages/grafema-orchestrator/src/layout/loader.rs`

**Include list (placeable, guaranteed to get their own tile):**
```rust
const PLACEABLE_TYPES: &[&str] = &[
    "MODULE", "FUNCTION", "METHOD", "CLASS",
    "VARIABLE", "CONSTANT",
    "INTERFACE", "TYPE_ALIAS", "TYPE_SYNONYM", "TYPE_CLASS",
    "DATA_TYPE", "ENUM", "VARIANT", "STRUCT", "TRAIT",
    "IMPL_BLOCK", "INSTANCE", "NAMESPACE",
    "MACRO",
    "PROCESS", "MESSAGE_TYPE",  // BEAM
    "ASYNC_FUNCTION",
    "GLOBAL_DEFINITION", "EXTERNAL_FUNCTION", "EXTERNAL_MODULE",
    // VARIANT deliberately excluded in v1 — see A.1 note below
];
```

**Borderline (co-placed with enclosing symbol — do NOT get own tile in v1):**
LAMBDA, CLOSURE, TYPE_SIGNATURE, METHOD_SIGNATURE, PROPERTY_SIGNATURE, CONSTRUCTOR, DECORATOR, HANDLER, GENERATOR, **VARIANT** (sum-type members — 228 in current graph).

**VARIANT decision (user answer Q3):** excluded in v1 for visual-noise management. Enum-with-20-variants would be 21 tiles clustered in a small region, hurting readability at medium zoom. Trade-off accepted: lose click-to-specific-variant navigability, lose sum-type-member cohesion signal for match-arm dataflow. Revisit in Playwright dogfooding — if users ask, 1-line include-list edit. Expose `--include-variant` override in Chunk-1.

**Dijkstra v2 Table 14 addenda:**
- **Dropped inbound-edge count (measured from current graph):** VARIANT is the `dst` of CALLS/READS_FROM/IMPLEMENTS/... edges — these are dropped from the cohesion signal by the "skip edges whose endpoint is not in the placeable set" rule. Measurement during Chunk-1 bench; for current grafema graph, expected ≤ few thousand edges across 228 VARIANTs (small impact on overall layout cost).
- **Cross-analyzer uniformity:** VARIANT is emitted by Rust analyzer for enum members and by Haskell analyzer for data constructors (`Just`, `Nothing`) — confirmed in live-graph counts (228 exists, Haskell-heavy repo contribution). TypeScript analyzer uses `INTERFACE` / `TYPE_ALIAS` for discriminated unions (no VARIANT emitted). So VARIANT-exclusion is de facto **Rust/Haskell-only bias**; TS is unaffected. Document in `--include-variant` help text.
- **Navigability:** VARIANT nodes remain queryable via search and Datalog; GUI tooltip on the enclosing ENUM tile lists its variants (added to REGION(ENUM) metadata in Chunk-2). Click-to-specific-variant-tile is what's lost, not click-to-variant-definition-in-source.

Rationale: these are declarative-annotation or nested-scope nodes. Placing them separately doubles tile count without adding navigational value. Revisit after first Playwright round.

**Explicit exclude list (must never enter pack input):**
```rust
const EXCLUDED_TYPES: &[&str] = &[
    // Analysis noise
    "CALL", "REFERENCE", "PARAMETER", "LITERAL", "BRANCH", "PATTERN",
    "SCOPE", "PROPERTY_ACCESS", "IMPORT", "CASE", "EXPRESSION",
    "DO_BLOCK", "METRIC", "EFFECT", "ISSUE", "PROPERTY",
    "IMPORT_BINDING", "EXPORT", "EXPORT_BINDING",
    "RECORD_FIELD", "LOOP", "LET_BLOCK", "CATCH_BLOCK", "TRY_BLOCK",
    "FINALLY_BLOCK", "TYPESPEC", "CONSTRAINT",
    // Synthetic/virtual (emitted by prior passes — must not feed back)
    "HEX", "REGION", "HASKELL_GLOBAL", "GLOBAL",
];
```

**Defensive filter in loader (on top of type filter):**
- Skip node if `file.is_empty()`.
- Skip node if `file.ends_with('/')` (DIRECTORY sentinel carried from `http_server.rs:466`).
- Skip node if `semantic_id` starts with a known virtual prefix (`HEX::`, `REGION::`, `HASKELL_GLOBAL::`, `GLOBAL::`).

**Liftable edge types (for cohesion signal) with explicit exclude list:**

Include:
```
CALLS, READS_FROM, WRITES_TO, IMPORTS_FROM, DEPENDS_ON,
PASSES_ARGUMENT, AWAITS, RETURNS, ITERATES_OVER, HAS_METHOD,
ASSIGNED_FROM, IMPLEMENTS, EXTENDS, INHERITS_FROM,
BROADCASTS_TO, DISPATCHES_TO, HANDLES_VARIANT,  // BEAM cohesion
THROWS, CATCHES,
```

Exclude (must NOT feed back into packer):
```
LAYOUT_POSITION,  // self-feedback loop — CRITICAL to exclude
CONTAINS, DECLARES, HAS_PARAMETER, HAS_FIELD,  // structural, already in folder tree
RESOLVES_TO, REFERENCES,  // weak signal, adds noise
```

Skip edges whose endpoint is not in the placeable set.

### A.2 — Folder tree with file-is-folder flag (Dijkstra Gap 3a — fixes `/` in semantic id)

**Chosen: option (i) — extend `FolderTree::build_from_paths`.**

Rationale: option (ii) shatters semantic ids containing `/` (Grafema V2 URI form). Option (i) keeps the builder pure on folder paths and passes leaves as opaque identifiers — no splitting of symbol IDs.

Extend `tree.rs`:
```rust
pub fn build_from_paths_with_leaves(
    leaf_pairs: &[(NodeIdx, /* folder path */ &str, /* opaque leaf id */ &str)]
) -> FolderTree
```

**NodeIdx contract (Dijkstra v2 Table 16 — CRITICAL):**
- `NodeIdx` is a dense `u32` index into the **placeable-symbol set only** (~35k), NOT the full RFDB graph (~328k). `placement_state.positions: Vec<HexCoord>` has length = placeable-symbol-count.
- Loader (Chunk-1) builds and owns a parallel **`Vec<u128>` of RFDB node ids keyed by NodeIdx** (plus the inverse `FxHashMap<u128, NodeIdx>` for edge resolution). This side-map is passed alongside `LayoutInput` into `run_layout` and consumed by `commit_layout` to emit `LAYOUT_POSITION` edges keyed by RFDB u128 id.
- The `leaf_id: &str` parameter is opaque: used only for deterministic intra-folder ordering (lex sort) and debug logging. It is NOT the RFDB id — that comes from the NodeIdx→u128 side-map.
- File path is split on `/` as today; file becomes the innermost folder. Leaf uniqueness: RFDB semantic ids are globally unique; if two pairs share the leaf id, loader logs a warning and dedups (defensive).

**Synthetic mode stays on `build_from_paths` (file-as-leaf).** `synthetic.rs`, `json_dump.rs`, and the existing synthetic benchmark path are untouched. The A.3a 30k-synthetic number is informational only; the merge-gate perf check runs on real loader output in Chunk-3 (see §A.3b).

### A.3 — Performance

**Split into A.3a (measure) → A.3b (mitigate if needed)** per Dijkstra Precondition 2.

**A.3a — benchmark result (measured 2026-04-23).**

`grafema-orchestrator layout --synthetic 30000 --edge-density 5` — 109 folders, depth 3:
- pack: **13ms** ✅
- iswap: **154,935ms** ❌ (342,465 intra-folder swaps — O(K²), K ≈ 275/folder)
- xswap: 4,128ms ✅
- **total: 159,166ms** vs 30,000ms gate ❌

**Verdict:** pack & xswap pass outright. iswap is the singular bottleneck at scale.

Synthetic is worst-case — 109 shallow folders concentrate K. Real grafema hierarchy is much deeper: 35k symbols in ~1247 regions → avg K ≈ 28 → expected iswap ≈ 1M swaps ≈ 4-5s. But this prediction must be validated **against the real loader output** in Chunk-3 before promising the 30s gate. Mitigations below are mandatory regardless.

**A.3b — mitigations (mandatory based on A.3a):**

1. **Cap iswap — total swaps across all passes in one invocation, per folder:** `max_swaps_per_invocation = min(K², 4K)`. This is NOT a per-pass limit (which would leak the K² × pass_count blow-up). Implementation: single counter initialized once inside `iswap(folder)`; passes continue only while counter < cap. On K=275 → 1100 swaps cap ≈ 1s vs current 155s. On K=28 (real projected) → 784 cap, a no-op relative to natural convergence.
2. **Skip iswap entirely for K > 500** (matches hard-cap — see A.7). Overflow files are excluded from intra-folder optimisation.
3. **Skip xswap on leaf-file folders** (O(K²) boundary swap meaningless inside a single file). Saves 4s on 30k synthetic.
4. **Parallel iswap across sibling folders via rayon with `split_at_mut` on positions vec.** Safety pattern: `node_to_folder` partitions `NodeIdx` disjointly per folder; each rayon worker gets a `&mut [HexCoord]` slice covering its folder's NodeIdx range — sibling folders are disjoint by construction, so `split_at_mut` produces non-overlapping mutable slices and the borrow checker is satisfied. Nested (parent-child) folders are NOT parallelized; only siblings at the same depth level.
5. Fallback if above insufficient: per-file sub-pack via spiral-fill around reserved cluster (replaces iswap for intra-file entirely).

**Chunk-3 is the MERGE GATE for perf**, not a post-merge check. Chunk-3 runs `grafema layout --commit` against the real grafema RFDB and measures wall-clock. If result > 30s, apply next mitigation from the ladder and re-measure. No Chunk-4+ code is merged until Chunk-3 green. If the full ladder is exhausted and we still exceed 30s, escalate to user for scope renegotiation (raise gate, split layout command, or accept larger budget).

### A.4 — Commit: LAYOUT_POSITION per symbol + REGION nodes + **delete-before-write** (Dijkstra Gaps 4a, 5)

`packages/grafema-orchestrator/src/layout/commit.rs`

**Pre-pass (delete):** before writing new edges/nodes, clear prior layout output:

1. Query all `LAYOUT_POSITION` edges with `metadata._source == "layout-pack"`.
2. Query all nodes of type `REGION` with `metadata._source == "layout-pack"`.
3. Also query their outgoing `CONTAINS` edges.
4. Issue `commit_batch` with non-empty `deleted_nodes` + `deleted_edges` lists.

**RFDB op needed — confirmed Chunk-0 scope.** Verified against `packages/rfdb-server/src/bin/rfdb_server.rs:2011-2083` (`handle_commit_batch`): current deletion model is file-scoped. Server runs `find_by_attr(file=<changed_file>)` → deletes matching nodes + their outgoing edges. `file_context` adds a virtual file to that list and injects `__file_context` metadata into new edges, but still deletes via node-file match.

This does **not** cover the DAI-22 case: LAYOUT_POSITION edges have `src = real_symbol_id`, and those symbols live in real files. File-scoped deletion would wipe the symbol itself + its analyzer-emitted outgoing edges. Unacceptable.

**Chunk-0 scope:** add two new RPC variants to rfdb-server wire protocol:
- `delete_edges_by_type_and_source(edge_type: String, source_tag: String)` — deletes edges where `edge_type == X` AND `metadata._source == Y`. Used to clear prior LAYOUT_POSITION edges.
- `delete_nodes_by_type_and_source(node_type: String, source_tag: String)` — deletes nodes + their outgoing edges where `node_type == X` AND `metadata._source == Y`. Used to clear prior REGION nodes.

**Implementation path — fast by construction:**
- Server handler uses `engine.get_edges_by_type(edge_type)` (confirmed exists — `engine_v2.rs:648`, used heavily by datalog eval) to enumerate candidates in O(N_type), then filters by metadata substring match on `"\"_source\":\"<tag>\""` (flat JSON, stable shape guaranteed by our own writer). NOT a full-edge scan.
- For nodes, analogous `get_nodes_by_type`; delete outgoing edges via existing `engine.get_outgoing_edges(id, None)`.
- `source_tag` match is **substring on serialized metadata JSON**, not a structured predicate. Acceptable because we control the writer; any future writer that uses `_source` keys a different way (e.g. nested) will produce a controlled collision we can detect.
- **Single-source invariant:** if `delete_edges_by_type_and_source("LAYOUT_POSITION", "layout-pack")` finds edges with `_source` values OTHER than `"layout-pack"`, the handler returns an error (fail-loudly — refuse to proceed until the DB is cleaned up manually). This prevents silent collisions with a future second layout writer.

**Atomicity boundary (hoisted from §8 Risks per Dijkstra v2 Table 13):** `layout --commit` issues delete-then-write as TWO separate RPCs. If crash between them, DB is left in "no-layout" state; user reruns `grafema layout --commit` and both delete-pass (finds 0 prior edges) and write-pass complete cleanly. No half-state rollback needed; the design tolerates the window because the only observable consequence is a stream with `layout_meta.source == "missing"` until the rerun finishes.

Files touched in Chunk-0 (max 3):
1. `packages/rfdb-server/src/bin/rfdb_server.rs` — new `Request::DeleteEdgesByTypeAndSource` / `Request::DeleteNodesByTypeAndSource` variants + handlers.
2. `packages/grafema-orchestrator/src/rfdb.rs` — client methods `delete_edges_by_type_and_source`, `delete_nodes_by_type_and_source`.
3. Tests in `packages/rfdb-server/tests/` — round-trip test for each new RPC.

This is a small, atomic prerequisite. No backward-compat concerns since nothing else uses this path yet.

**Write pass:**
- `LAYOUT_POSITION` edges: `src` = symbol semantic id, `dst` = `HEX::<q>,<r>`, `edge_type` = `LAYOUT_POSITION`, metadata:
  ```json
  {"_source":"layout-pack", "q": <i32>, "r": <i32>, "committed_at": "<ISO8601>"}
  ```
- `REGION` nodes: one per folder, type `REGION`, metadata:
  ```json
  {"_source":"layout-pack", "depth": <u32>, "path": "<str>",
   "kind": "folder" | "file", "name": "<str>"}
  ```
  Semantic id: `REGION::<depth>::<path-url-encoded>` (URL-encoding avoids embedded `:`, `/` collisions — Dijkstra Gap 5).
- `CONTAINS` edges (REGION→REGION, REGION→SYMBOL): metadata `{"_source":"layout-pack"}` so they can be filtered out from analyzer CONTAINS.

**Idempotency contract:** two consecutive identical runs produce identical RFDB state (same edge/node ids, same metadata except `committed_at`). Verified by a test that runs commit twice and asserts node/edge counts unchanged.

**Safety:** the pre-pass filters strictly by `_source == "layout-pack"`. Any CONTAINS edges without that tag (analyzer-emitted) are untouched.

### A.5 — synthetic-input guard retained from v1.

### A.6 — CLI UX + per-file hard-cap (Gap 8 resolution)

`grafema layout --commit`:

- `--verbose` — per-phase timings (load, pack, iswap, xswap, delete-pass, write-pass).
- `--max-symbols-per-file=N` — override hard-cap (default **500**).
- **Hard-cap behaviour (user answer Q2 — degree-desc):** if file has > N placeable symbols, only the top-N by degree are placed. Rationale: most-connected symbols are the navigational landmarks; leaving out a leaf with 1 edge is cheaper than leaving out a hub. **Degree definition (Dijkstra v2 Table 15):**
  - Counted edges: strictly the **liftable-include-list after exclude filter** (the set defined in §A.1 — CALLS, READS_FROM, WRITES_TO, IMPORTS_FROM, DEPENDS_ON, PASSES_ARGUMENT, AWAITS, RETURNS, ITERATES_OVER, HAS_METHOD, ASSIGNED_FROM, IMPLEMENTS, EXTENDS, INHERITS_FROM, BROADCASTS_TO, DISPATCHES_TO, HANDLES_VARIANT, THROWS, CATCHES). LAYOUT_POSITION / CONTAINS / DECLARES / HAS_* / RESOLVES_TO / REFERENCES are NOT counted. Same filter ensures consistency with cohesion-signal input.
  - Counted in both directions (incoming + outgoing).
  - Computed **in the loader** from the already-collected liftable edge set — no extra RFDB round-trip.
  - Tiebreak order: degree DESC → name lex ASC → **RFDB semantic id lex ASC** (final tiebreak, guaranteed unique in healthy DB).
- Skipped symbols get NO `LAYOUT_POSITION` edge. Metadata on the enclosing REGION(file) includes:
  ```json
  { "overflow_skipped": <count>, "hard_cap": <N> }
  ```
- Success output:
  ```
  Committed 34,982 LAYOUT_POSITION edges, 1,247 REGION nodes, 35,218 CONTAINS edges
  Overflow: 4 files exceeded hard-cap (max 847 symbols in src/heavy.ts)
  ```
- Errors: bail when RFDB has zero placeable symbols (analyze not run yet).

### A.7 — Hard-cap UX contract

- Client receives `overflow_skipped > 0` via REGION metadata in stream header.
- GUI renders red badge on the file's hull. Hover = "847 symbols not displayed (hard cap 500). Raise with `grafema layout --max-symbols-per-file=…`".

## 4. Phase B — Server: drop tectonic, read persisted pos

### B.1 — Complete deletion scope (Dijkstra Gap 12)

Named files to edit:
1. `packages/rfdb-server/src/http_server.rs` — remove `ATOM_TYPES`, `build_atom_hierarchy`, all tectonic phase calls, `file_fallback`, `tectonic_meta` emit.
2. `packages/rfdb-server/src/tectonic_layout.rs` — **delete entire file.**
3. `packages/rfdb-server/src/lib.rs` — remove `pub mod tectonic_layout;` line.
4. `packages/rfdb-server/src/bin/rfdb_server.rs` — check for any tectonic imports; remove if present.

Named tests to delete or rewrite (grep-driven list, confirmed before starting):
5. Any test in `packages/rfdb-server/tests/` referencing `tectonic_preprocess`, `phase1_place..phase4_refine_boundaries`, `ATOM_TYPES`, `file_fallback`, `tectonic_meta`. Grep to enumerate exhaustively before deletion.

Client-side consumer files to update:
6. `packages/gui/src/store/loadStream.ts` — drop `tectonic_meta` handler, add `layout_meta` handler.
7. `packages/vscode/src/mapPanel.ts` — same if it references `tectonic_meta`.

Grep-confirmation step as part of Chunk-5 pre-flight.

### B.2 — Warmup: load LAYOUT_POSITION + REGION; enumerate error modes (Dijkstra Gap 6)

New `CachedLayout`:
```rust
struct CachedLayout {
    positions: HashMap<u128, HexCoord>,
    regions: Vec<RegionInfo>,
    containment: HashMap<u128, Vec<u128>>,
    overflow_files: HashMap<String, (usize, usize)>,  // file → (skipped, cap)
    source: LayoutSource,  // Missing | Committed { committed_at, symbol_count }
}
```

**Parser error-recovery table** (fail loudly by default; warn + skip for minor corruption):

| Condition | Action |
|-----------|--------|
| No LAYOUT_POSITION edges | `source = Missing`, stream `pos: null` for every node |
| Edge missing `_source: "layout-pack"` metadata | Skip edge, counter logged |
| Edge without `q`/`r` in metadata — fall back to parse `HEX::q,r` from dst semantic id | Allowed fallback; log count |
| Metadata `q`/`r` not i32, or out of (-32768, 32767) | Skip with warn |
| Duplicate LAYOUT_POSITION for same src | Take first; warn count. Root cause = bug in delete-before-write; fail loudly above threshold |
| REGION node missing `depth`/`path`/`kind` | Skip region with warn |
| CONTAINS edge from REGION to non-existent node | Skip with warn |
| Cycle in REGION containment | Fail loudly — refuse warmup; caller must fix DB |

### B.3 — Stream emission + `unplaced_reason` discriminator (Dijkstra Gap 7)

Each node emits:
```json
{
  "type": "node",
  "i": <idx>, "t": <type>, "id": "...", "name": "...", "file": "...",
  "pos": { "q": ..., "r": ... } | null,
  "unplaced_reason": "excluded" | "missing_layout" | "skipped_overflow" | null
}
```

- `"excluded"` — node type is in EXCLUDED_TYPES. GUI silently hides from atlas.
- `"missing_layout"` — no LAYOUT_POSITION yet. GUI shows overlay "Run `grafema layout --commit`".
- `"skipped_overflow"` — hard-cap overflow. GUI renders as part of file's red-badge count.
- `null` — placed normally.

Header frame adds `regions` (region tree) + `layout_meta`:
```json
{
  "type": "layout_meta",
  "source": "missing" | "committed",
  "symbol_count": <u32>, "committed_at": "<ISO8601>",
  "overflow_files": [{"file": "...", "skipped": N, "cap": K}]
}
```

### B.4 — Empty-layout UX — unchanged from v1 §B.4.

### B.5 — Cache lifecycle — unchanged; invalidated on `reload()`.

## 5. Phase C — Client: hull-based LOD

### C.1 — Load path + unplaced_reason consumption — per B.3 above.

### C.2 — Hull computation (Dijkstra Gap 9 — algorithm inlined)

For each REGION:
1. Collect member cells: set of `(q, r)` = union of placed symbol positions + recursive union from child regions.
2. **Morphological close with configurable radius r (default r=1):**
   - Dilate: add every hex adjacent to a member cell (1 ring).
   - Erode: remove cells whose 6 neighbours are not all in dilated set.
   - Result: filled region that bridges 1-cell gaps.
3. **Boundary trace:** walk the outer ring of the dilated set (hex-grid boundary-walk — left-turn rule). Produces ordered polygon points.
4. **Policies:**
   - **1-cell region:** hull = single hex polygon (no dilation).
   - **Disjoint cells (distance > 2r):** emit multiple polygons per region — render as a hull group; tooltip/selection hits any of them.
   - **Ring with hole:** holes are dropped (filled in). Rationale: visual clarity > topological fidelity at map scale.
   - **Overlapping sibling hulls:** allowed; z-order by `depth` (deeper = on top). Shader blends with low alpha so overlap is visible.
   - **Zero-leaf folder:** no hull emitted.

Cache keyed by `regionId` in `regionHulls: Map<u128, HullGeometry>`. Invalidated on stream reload.

### C.3 — LOD depth mapping (Dijkstra Gap 8 — amended for variable depth)

Let `D_max` = max folder depth observed in region tree. Compute per-region visibility:

```
visibleAtZoom(region, zoom):
  depthNorm = region.depth / max(1, D_max)       // normalized 0..1
  minZoom   = 1.0 - depthNorm - 0.1              // deeper regions appear later
  sizeOK    = region.leafCount ≥ pixelThreshold(zoom, region)
  return zoom ≥ minZoom && sizeOK
```

- `D_max < 9` (shallow codebase): fallback — collapse table rows proportionally. Minimum 3 visible depth bands at any zoom.
- `D_max ≥ 15` (very deep): clamp to 12 visible bands; ultra-deep regions merge into parent at low zoom.
- `pixelThreshold(zoom, region)` = `(region.leafCount * hexArea(zoom)) >= MIN_VISIBLE_PIXELS` (default 64 px²). Small-hull hiding via this rule, not via depth.

Symbols (leaves) appear only at top zoom level (per v1).

### C.4 — Rendering — unchanged from v1.

### C.5 — Interactions — augmented per Dijkstra Gap 11:

- **2D ⇄ 3D toggle** — no layout recompute; pins and selection survive.
- **Route draw (user answer Q4):** shortest path by `CALLS`/`READS_FROM` edges — hide entirely at zoom levels where endpoints are inside collapsed hulls. No hull-to-hull aggregation in v1. **Rules (Dijkstra v2 Table 17):**
  - **Both endpoints visible, all intermediates visible:** draw polyline through every intermediate tile centre.
  - **Either endpoint collapsed:** hide whole route.
  - **Endpoints visible but ≥ 1 intermediate collapsed:** hide whole route (keeps the semantic "we would be lying about the path" honest). No straight-line shortcut, no hull-centroid stub.
  - **Multiple equal-length shortest paths:** deterministic pick by lexicographic ordering of the edge sequence (each edge identified by `(src_semantic_id, dst_semantic_id, edge_type)`, sorted tuple-wise).
  - Revisit aggregation after Playwright dogfooding.
- **Hover on red badge** — overflow tooltip per A.7.
- **Keyboard** — `Space` to reset camera, `Esc` to clear selection, `+/-` to zoom.
- **Context menu (right-click)** — "Pin here", "Copy semantic id", "Open file".

## 6. Phase D — Verification (Dijkstra Gap 11 — expanded)

Playwright suite in `packages/gui/scripts/playwright-verify-dai22.mjs`, against live graph after `grafema analyze . && grafema layout --commit`.

### D.1 Data integrity
- Stream completes, header present, node count matches.
- Header regions tree depth ≥ 9.
- Placed-symbol count ≥ 95% of `PLACEABLE_TYPES` total node count.
- Distinct (q,r) ≥ 80% of placed-symbol count.
- `layout_meta.source == "committed"` for populated DB.
- Rerun of `layout --commit` produces identical `placed_symbol_count` and `regions.length` (idempotency).

### D.2 Render
- Fit-all zoom: ≥ 100 distinct hull meshes visible.
- Max zoom on a file: ≥ 90% of its symbols rendered as distinct tiles.
- First-frame ≤ 3s on full graph.
- Pan/zoom ≥ 30fps sustained.

### D.3 Interactions (each scripted and asserted, not screenshot-compared)
- Hover → tooltip.
- Click → selection highlight + ancestor-hull emphasis.
- Pin → chip + survives pan + survives zoom + survives 2D/3D toggle + survives page reload.
- Zoom out → child hulls disappear at expected thresholds; scene-graph count reflects.
- Zoom in → instanced symbol count rises.
- Route draw: A + B pinned, `Ctrl+R` → route layer populated, edges connect visible tiles.
- 2D ⇄ 3D toggle: layout stable, camera only changes.
- Reload page: pins + selection persist via localStorage.
- Keyboard: `Space`, `Esc`, `+`, `-` each fire expected action.
- Right-click: context menu opens; items executable.
- **Red-badge assertions:** for a file with `overflow_skipped > 0`, badge present; hover tooltip text matches "N symbols not displayed, hard cap K".
- **Empty-layout overlay:** wipe LAYOUT_POSITION edges, reload; overlay visible; message contains "grafema layout --commit".
- **Missing-layout graceful mode:** ensure interactions (hover, tooltip on files with `pos: null` via region hulls) still work — app does not crash.

### D.4 Visual regression (pixel-content, not screenshot-exact) — unchanged.

### D.5 Performance gates (updated with real placeable count)
- `grafema layout --commit` on grafema-self graph (~35k symbols): ≤ 30s.
- Server warmup post-layout: ≤ 2s (edge iteration only).
- Re-commit of same layout: ≤ 30s total including delete pre-pass.

## 7. Chunks — unchanged structure, renumbered + new Chunk-0

**Chunk-0** — RFDB `commit_batch` delete-by-type / delete-by-metadata capability if missing. Prerequisite for Chunk-2.
**Chunk-1** — loader.rs: PLACEABLE/EXCLUDED lists, defensive filters, extended liftable edges, `file_ends_with('/')` sentinel.
**Chunk-2** — commit.rs: delete-before-write + symbol-keyed edges with inline `(q,r)` + REGION nodes + CONTAINS.
**Chunk-3** — benchmark sweep (synthetic 30k/60k/328k) — drop or pin mitigations from A.3b.
**Chunk-4** — http_server.rs rewrite per B.1–B.3.
**Chunk-5** — delete `tectonic_layout.rs` + grep-confirmed named tests + `lib.rs`/`bin` cleanup.
**Chunk-6** — GUI header consumer + region store + overlay + red-badge component.
**Chunk-7** — hull computation + cache per C.2.
**Chunk-8** — LOD policy per C.3 + rendering layers.
**Chunk-9** — route rendering (augment existing if any; else new).
**Chunk-10** — Playwright verify script with assertions per D.1–D.5.
**Chunk-11** — VS Code extension (`mapPanel.ts`) update if needed + Playwright across extension path.

Each chunk TDD red-first, ≤ 3 files, committed before next.

## 8. Risks — amended

- **Delete-before-write must be atomic with write.** If crash between delete and write, DB is in a "no-layout" state. Acceptable (rerun fixes it), but document.
- **35k placeable might be optimistic** — if INSTANCE/VARIANT counts blow up on Haskell-heavy targets (1M+ nodes). Benchmark guards against this.
- **Hull compute O(regions × cells).** For 1247 regions × 35k cells worst case ≈ 40M ops on client. Likely fine at ≈ 100ms. Measured in Chunk-7.
- **Morphological close parameter r** — default 1 may merge visually distinct clusters. Chunk-8 exposes it in config.

## 9. Open questions — resolved

1. ✅ `commit_batch` wire protocol — verified file-scoped deletion, insufficient. Chunk-0 adds `delete_{edges,nodes}_by_type_and_source` RPCs. See §A.4.
2. ✅ Hard-cap order — degree-desc (§A.6).
3. ✅ VARIANT — excluded in v1, tuneable via `--include-variant`.
4. ✅ Route rendering at low zoom — hide, no aggregation (§C.5).

## 10. Appendix — grep commands for Chunk-5 pre-flight

```bash
grep -rn 'tectonic_preprocess\|phase1_place\|phase2_flood_fill\|phase3_drift\|phase4_refine_boundaries' packages/
grep -rn 'ATOM_TYPES\|atom_positions\|file_fallback\|tectonic_meta\|build_atom_hierarchy' packages/
grep -rn 'tectonic_layout' packages/
```
Expected: zero hits outside `_archive/` after Chunk-5.
