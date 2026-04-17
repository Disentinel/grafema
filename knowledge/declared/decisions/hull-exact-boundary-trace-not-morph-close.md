---
id: kb:decision:hull-exact-boundary-trace-not-morph-close
type: DECISION
status: active
effective_from: 2026-04-17
projections:
  - epistemic
created: 2026-04-17
---

## HullLayer uses exact-boundary trace (ported from sandbox), NOT morphological close

### Decision
`packages/gui/src/geom/hull.ts` ports `sandbox/hex-sandbox/src/hull.js`'s `computeHullPolygons(tiles, size)` — exact-boundary trace, O(|boundary_edges|) per region. Also exports `computeHullPolygonsBatched` — async generator yielding one region's loops per `requestIdleCallback` tick. HullLayer re-enabled in Canvas.tsx after being disabled for performance.

### Context
`packages/gui/src/components/Canvas.tsx` had explicitly disabled HullLayer with a comment saying "O(tiles² × levels) on real-project graphs. At 15k+ tiles × 5 levels it hangs the main thread for tens of seconds." That complexity came from morphological close (dilate → erode), NOT boundary trace.

### Rejected alternatives
- **Morphological close** (Dijkstra P1-a round 1): original 002-plan claimed `geom/hull.ts` would be morph close. Wrong on two counts — the sandbox algorithm is exact trace, and morph close is what made the original layer hang.
- **GPU fragment shader for 3D only** (Q1 option B): would have given 3D sharp hulls via region-id texture sampling but left 2D without. Feature-asymmetric; user rejected.
- **Skip hulls entirely** (Q1 option A): user rejected; hulls are useful as overlay.

### Consequences
- Batched via `requestIdleCallback` spreads 500 regions × 5 levels ≈ 250 ms over ~15 idle frames; AbortSignal honored for mid-flight mode toggle (E14 dual-abort).
- HullRegion type `{ path, tiles: HexCoord[] }` does NOT consume `dataStore.Region` directly — `Region.border` is always `[]`; C-SceneManager-equivalent wire-up (Canvas.tsx) derives tiles from nodes + `__grafemaTileCoords` globals.
