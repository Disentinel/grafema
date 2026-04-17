---
id: kb:decision:hex-atlas-2d-mode-three-ortho-not-canvas2d
type: DECISION
status: active
effective_from: 2026-04-17
projections:
  - epistemic
created: 2026-04-17
---

## Three.js orthographic camera for 2D mode, NOT HTML5 Canvas 2D

### Decision
`<HexAtlas mode="2d">` swaps SceneManager's camera to `OrthographicCamera` + flips `SceneMode.tileElevation = 'flat'` + `flowStyle = 'line'`. Same WebGL pipeline as 3D.

### Rejected alternative: Canvas 2D renderer
Initial plan (002-plan.md) proposed a parallel `renderers/canvas/` subtree with 6 new layer files (HexCanvasLayer, HullCanvasLayer, FlowCanvasLayer, etc.) using HTML5 Canvas 2D.

**Why rejected (Dijkstra P1-c, verification #1):** real target scale is **40k atoms** (grafema self-analysis via tectonic layout). Canvas2D per-tile stroke+fill benchmarks at 200–400 ms/frame on 40k. Three.js WebGL handles 40k in <16 ms. Canvas2D would have required a second perf-equivalent implementation from scratch.

### Consequences
- One renderer codebase; HexLayer/FlowLayer/HullLayer/SceneManager gain `setMode` branches rather than parallel Canvas classes.
- Hull overlay needed perf rework anyway: exact-boundary trace from sandbox (O(|boundary|)) replaces the O(tiles²×levels) morph-close that made the old HullLayer unusable at 15k+ tiles.
- 2D still feels "map-like" (flat tiles, line flows, orthographic projection) — not a gimmick; users describe it as "top-down navigation" vs 3D's "landscape feel".

### Fallback
If at 3-Review or user demo the ortho feel rejects, fallback is Canvas2D with benchmark gate in a new chunk. Three.js abstractions (Layer interface) don't prevent this.
