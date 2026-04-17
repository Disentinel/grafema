# REG-1100 — Revised Plan (after Dijkstra REJECT)

**Workflow:** v3.0
**Date:** 2026-04-17
**Supersedes:** `002-plan.md`
**Responds to:** `003-dijkstra-verification.md`

---

## User decisions (2026-04-17)

- **Q1: Hull** = **C** (sandbox exact-boundary trace, used as overlay in both 2D and 3D).
- **Q2: 2D renderer** = **b** (Three.js orthographic camera, same WebGL pipeline; mode is camera + tile-config swap, no separate Canvas2D renderer). Rollback to (a) if problems emerge.
- **Q3: gui-server** = archive in this task. No users to worry about.

## What changed vs. 002-plan

| Area | Was | Now |
|---|---|---|
| 2D rendering | New Canvas2D renderer under `renderers/canvas/` (6 new files) | **Three.js with orthographic camera** — same pipeline, camera + tile config swap |
| Renderer abstraction | Dual-backend `Renderer` interface | **`SceneMode` config** passed into existing Three.js layers; camera and projection swap; no dual backend |
| Hull | Morphological close (wrong) | **Exact-boundary trace** from `sandbox/hex-sandbox/src/hull.js`, ported as `geom/hull.ts` |
| HullLayer | Left disabled (O(tiles² × levels) per comment in `Canvas.tsx:95-111`) | **Re-enabled with the exact-boundary algorithm** (O(|boundary|) per region per level) |
| Module-mutable singletons | Not addressed | **New chunk C-singletons** deletes `flowLayerRef`, `setShowCoordsRef`, `setHexLayerRef` — state flows through Zustand + `sceneApi` imperative handle |
| VS Code CSP | Hand-waved | **New chunk C0** sets explicit `<meta Content-Security-Policy frame-src http://localhost:*>` in `mapPanel.ts` |
| rfdb-server UI chunk | One chunk (C14) | **Split into C14a/C14b/C14c** per Dijkstra |
| Coordinate system | Unspecified | **World `(x, z)` kept throughout**; orthographic camera looks down `+y`; no `z→y` rename |
| loadStream → layoutClient handover | Undefined | **Defined**: `layoutClient.fetchLayout(opts)` resolves to `{nodes, edges, regions, ...}` shaped to match `DataState.setGraphData`; host entry point does `setGraphData(await fetchLayout(...))` |
| `cubeToWorld` drift | Ignored | `gui/server.js` Node.js copy audited; either re-imports from `geom/hex.ts` (via a small shared `.mjs`) or is marked authoritative + unit-tested for drift |
| gui-server archive | Conditional | **Unconditional** (Q3 resolved) |

---

## 1. Architecture (revised)

### Mode swap is a `SceneMode` config, not a renderer swap

```ts
// Version-discriminated to keep future fields additive without silent drift.
interface SceneMode {
  version: 1;
  kind: '2d' | '3d';                   // primary discriminator stored in viewStore

  // Camera
  projection: 'perspective' | 'orthographic';
  cameraUp: [number, number, number];  // (0,1,0) in 3D; (0,0,-1) top-down 2D
  frustumSize: number;                 // ortho half-extent in world units; ignored for perspective

  // Tiles
  tileElevation: 'on' | 'flat';        // 3D uses elevation by metric; 2D stays flat
  hoverLift: number;                   // hovered tile elevation (0 for flat)

  // Edges
  flowStyle: 'tube' | 'line';          // tubes in 3D, thin Line2 in 2D
  flowDensityCap: number;              // max flows rendered; lower in 2D to avoid clutter

  // Overlays
  hullStyle: 'line' | 'hidden';        // hulls as Line2 overlay in both modes by default
  labelTier: 'package+region+file' | 'package+region';   // fewer tiers in 2D zoomed out

  // Lighting / background
  background: number;                  // hex RGB; darker 3D, brighter 2D
  ambientOnly: boolean;                // true = no directional light, no shadows (2D default)
  fog: 'linear' | 'off';
}
```

`SceneManager.setMode(mode: SceneMode)` swaps camera, adjusts each Layer's rendering params. **Idempotency guard**: bails early if `deepEqual(incomingMode, currentMode)`. No layer rewrite; existing layers honor color/opacity/scale imperatively. Camera projection, tile elevation, flow style, lighting, and background change.

### Ortho-specific chunk responsibilities (C-mode owns all three)

1. **LOD math** (C2 pre-requisite): `lodFromView(view)` accepts `{kind: 'perspective', distance}` or `{kind: 'orthographic', zoom, frustumHeight}` and returns a monotone level. `Labels.tsx` + any other call sites that currently use `scene.getCameraDistance()` migrate to `scene.getView()` which returns the discriminated union.

2. **`flyTo` semantics** (C-mode): `SceneManager.flyTo(x, z, ms)` branches on camera kind:
   - `perspective`: current behavior (pan + maintain distance).
   - `orthographic`: animate `camera.position.x/z` for pan, and `camera.zoom` to a target computed from the target's depth band (LOD-based). Y-axis is fixed above the scene plane.

3. **Raycaster + OrbitControls** (C-mode): raycaster works for both camera kinds (Three.js handles projection internally) but the current code may hard-code perspective assumptions. Audit and make ortho-safe. OrbitControls reconfigured per mode:
   - 3D: `enableRotate: true, enablePan: true`, free orbit.
   - 2D: `enableRotate: false, enableZoom: true, enablePan: true, maxPolarAngle: 0, minPolarAngle: 0`, plus `target` clamped to XZ-plane; `zoom` drives LOD instead of `distance`.

### Renderer interface (deprioritised)

The `Renderer` interface proposed in 002-plan is removed. Without Canvas2D there is only Three.js. Keep existing layer classes (`HexLayer`, `FlowLayer`, `HullLayer`, `RegionLayer`, `RouteLayer`, `SceneManager`) and evolve them.

A thin **`sceneApi`** imperative handle is exposed (via `React.useImperativeHandle` or simple ref) that replaces module-mutable `flowLayerRef`/`setShowCoordsRef`.

**Surface enumerated from actual panel needs** (no "extended as needed"):

```ts
interface SceneApi {
  // Mode
  setMode(mode: SceneMode): void;
  getMode(): SceneMode;
  getView(): { kind: 'perspective', distance: number } | { kind: 'orthographic', zoom: number, frustumHeight: number };

  // Camera
  flyTo(x: number, z: number, ms?: number): void;
  fitToScene(): void;

  // Sidebar / toolbar
  setShowCoords(visible: boolean): void;

  // FlowPanel
  setFlowVisible(name: string, visible: boolean): void;
  recolorFlowsByNodes(colorFn: ((nodeIdx: number) => number) | null): void;

  // LensPanel
  applyLens(lensName: string): void;

  // RoutePanel
  addRoute(id: string, nodeIndices: number[], color: number, label: string): void;
  removeRoute(id: string): void;
  setRouteVisible(id: string, visible: boolean): void;

  // PinPanel
  pin(nodeIdx: number, color: number, label: string): void;
  unpin(nodeIdx: number): void;

  // DiffPanel
  enterDiff(removed: Set<number>, changed: Map<number, unknown>): void;
  exitDiff(): void;

  // Live layout (replaces setHexLayerRef)
  setTargetPositions(x: Float32Array, z: Float32Array): void;

  // Lifecycle
  dispose(): void;
}
```

Panels access `sceneApi` through a React context (`<SceneApiProvider value={apiRef.current}>` + `useSceneApi()` hook). **Scope lock:** adding a new SceneApi method requires a plan update, not silent growth.

### Hull as overlay (O(|boundary|))

`geom/hull.ts` ports `sandbox/hex-sandbox/src/hull.js` into TypeScript. The algorithm:
1. Collect boundary edges per tile set (O(|tiles| × 6)).
2. Build corner → edge map.
3. Walk loops via corner-sharing.

Concave regions and islands handled natively (multiple loops). `HullLayer` consumes this and draws Line2 strips over the tile mesh. Re-enable in `Canvas.tsx`; fix the comment noting the O(tiles² × levels) was about morph-close, which we are NOT doing.

---

## 2. File-by-file changes (revised)

### 2.1 Controller extraction (unchanged from 002-plan)

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/controller/MapController.ts` | move from `src/api/` | keep JSON-RPC façade; `_sceneRef` becomes `_sceneApi` |
| `packages/gui/src/controller/lod.ts` | **new** | `lodFromZoom(distance, viewport) → 0|1|2|3` (pure; extracted from Labels.tsx + Canvas.tsx) |
| `packages/gui/src/controller/focus.ts` | **new** | pure selection/focus transitions |
| `packages/gui/src/controller/tooltip.ts` | **new** | tooltip routing |
| `packages/gui/src/controller/SceneApi.ts` | **new** | interface + React context |
| `packages/gui/src/api/MapController.ts` | **delete outright** (no shim); migrate the 3 call sites: `Canvas.tsx`, `App.tsx`, `mapController`-using panels | decision locked — no compat shim |

### 2.2 Layout data contract

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/layout/layoutClient.ts` | **new** | `fetchLayout(opts: LayoutOptions, signal?: AbortSignal) → Promise<LayoutResult>` |
| `packages/gui/src/layout/types.ts` | **new** | `LayoutOptions`, `LayoutResult` (= exact shape of `DataState.setGraphData` input) |
| `packages/gui/src/store/loadStream.ts` | refactor | becomes the transport implementation behind `layoutClient`; exposes `parseStream(response, signal): AsyncGenerator<...>`; does NOT call `setState` directly |
| `packages/gui/src/store/loadFixture.ts` | refactor | exposes `parseFixture(data)` and a fixture-fetching helper |
| `packages/gui/src/store/loadLiveLayout.ts` | refactor | WS logic stays; `setHexLayerRef` replaced with `sceneApi.setTargetPositions(x, z)` |
| **Bootstrap start-point** (host entry) | — | Host does: `const data = await fetchLayout(opts); useDataStore.getState().setGraphData(data);` Then scene useEffect reacts via existing Zustand subscription. |

### 2.3 Geometry

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/geom/hex.ts` | **new** | `cubeToWorld(q, r, size)`, `HEX_DIRS`, `hexKey`, `axialToPixel` — single source of truth |
| `packages/gui/src/geom/hull.ts` | **new** | `computeHullPolygons(tiles, size): LoopXY[]` — TypeScript port of sandbox `hull.js` |
| `packages/gui/server.js` | **edit** | Import `cubeToWorld`/`HEX_DIRS` from shared `packages/gui/src/geom/hex.mjs` (the TS source also re-exports through the same file for clients). **Single source of truth, no drift.** Alternative (parity test) rejected. |
| `packages/gui/src/store/loadFixture.ts` — `cubeToWorld` export | deprecate | re-export from `geom/hex` |

### 2.4 Mode + camera switch (NEW — replaces Canvas2D chunks)

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/three/SceneManager.ts` | **edit** | `setMode(mode: SceneMode)`: swap camera (`PerspectiveCamera` ↔ `OrthographicCamera`), reconfigure OrbitControls for top-down, update projection in next RAF |
| `packages/gui/src/three/HexLayer.ts` | **edit** | Honor `tileElevation` flag from SceneMode; `setElevation(idx, h)` becomes no-op when flat |
| `packages/gui/src/three/FlowLayer.ts` | **edit** | Honor `flowStyle`: `tube` (current) or `line` (thin Line2 in 2D) |
| `packages/gui/src/three/HullLayer.ts` | **edit** | Re-enable; uses new `geom/hull.ts`; rendered in both modes. **Batched compute**: per-region trace runs inside an `async *computeHulls()` generator yielding after each region (1 frame ≈ 16ms budget via `requestIdleCallback` wrapper); caller awaits until done. 500 regions × 5 levels = 2500 iters; at ~0.1ms per iter → ~250ms total spread over 15 idle frames. Telemetry: log if total > 500ms. |
| `packages/gui/src/three/RegionLayer.ts` | edit (minor) | region borders align with hull overlay |

### 2.5 Single HexAtlas component

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/HexAtlas.tsx` | **new** | `<HexAtlas mode source />` — mounts `<Canvas>`, pipes `mode` into `sceneApi.setMode()`, provides `<SceneApiProvider>` |
| `packages/gui/src/components/Canvas.tsx` | **refactor** | Remove module-mutable `flowLayerRef`/`setShowCoordsRef`; expose `sceneApi` via ref; pick up `mode` prop via `SceneApiContext` or direct prop; call `sm.setMode(...)` on change |
| `packages/gui/src/components/ModeToggle.tsx` | **new** | Button/switch 2D⇄3D; calls `useViewStore.setMode(...)` |
| `packages/gui/src/store/viewStore.ts` | edit | add `mode: SceneMode` + `setMode` |
| `packages/gui/src/components/Sidebar.tsx` | edit | import `useSceneApi()` hook instead of `flowLayerRef` |
| `packages/gui/src/App.tsx` | refactor | mount `<HexAtlas>` and the panels that use sceneApi |

### 2.6 Vite multi-entry + hosts

| File | Op | Purpose |
|---|---|---|
| `packages/gui/vite.config.ts` | edit | build entries: `index.html` (dev), `web.html` (rfdb-served), `vscode.html` (webview) |
| `packages/gui/index.html` | edit | dev default |
| `packages/gui/web.html` | **new** | production SPA for `/ui/` — reads `/ui/{db}` from URL, passes into `fetchLayout` |
| `packages/gui/vscode.html` | **new** | entry for VS Code webview — additionally wires postMessage bridge |
| `packages/gui/src/hosts/web.tsx` | **new** | React root; reads location; mounts `<HexAtlas>` |
| `packages/gui/src/hosts/vscode.tsx` | **new** | React root; wires `PostMessageAdapter`; reads rfdb port from passed init message |

### 2.7 rfdb-server UI (SPLIT into 3 chunks per Dijkstra)

#### C14a — feature flag + build infrastructure
| File | Op | Purpose |
|---|---|---|
| `packages/rfdb-server/Cargo.toml` | edit | `[features] default = ["ui"]`, `ui = ["dep:rust-embed", "tower-http/fs"]`; optional deps with `dep:` prefix |
| `packages/rfdb-server/build.rs` | **new** | `#[cfg(feature="ui")]`: if `$GRAFEMA_UI_DIST` set, copy tree to `OUT_DIR/../../ui-dist/`; else write a **loud placeholder** `index.html` with a red banner "UI NOT BUILT — run scripts/build-gui-for-rfdb.sh". Emit `cargo:rerun-if-env-changed=GRAFEMA_UI_DIST` AND recursively `cargo:rerun-if-changed=$GRAFEMA_UI_DIST/*` (solves stale-embed trap). Also emit `cargo:warning=` with a banner ASCII box. CI has a check: if release build has placeholder index.html, fail. |
| `packages/rfdb-server/tests/compile_without_ui.rs` | **new** | integration test: `cargo build --no-default-features` runs `cargo test --no-default-features`; asserts `UiAssets` symbol not present |

#### C14b — static_ui module
| File | Op | Purpose |
|---|---|---|
| `packages/rfdb-server/src/static_ui.rs` | **new** | `#[derive(RustEmbed)] struct UiAssets`; `fn serve_asset(path: &str) -> Response` with MIME lookup; SPA fallback logic (any non-asset path returns `index.html`) |
| `packages/rfdb-server/src/lib.rs` | edit | `#[cfg(feature="ui")] pub mod static_ui;` |

#### C14c — route wiring + CLI flags
| File | Op | Purpose |
|---|---|---|
| `packages/rfdb-server/src/http_server.rs` | edit | `#[cfg(feature="ui")]` adds `/ui/{*path}` and `/ui/` and `/ui/{db}` handlers. Precedence: `--static-dir` (if passed) > embedded bundle > placeholder. `--no-ui` overrides all (returns 404). `CorsLayer` already applies. |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | edit | `--static-dir <path>` and `--no-ui` CLI flags |
| `packages/rfdb-server/tests/static_ui.rs` | **new** | 5 assertions from §8.5 + precedence test: `--static-dir` wins over embedded; `--no-ui` returns 404 everywhere under /ui |

### 2.8 VS Code retargeting + CSP

| File | Op | Purpose |
|---|---|---|
| `packages/vscode/src/mapPanel.ts` | **edit (C0 + C16 merged)** | (C0) add explicit `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:* http://127.0.0.1:*; script-src 'unsafe-inline'; style-src 'unsafe-inline';">`; (C16) drop `findGuiBinary`/`downloadGuiBinary`/`spawn(grafema-gui)`; read rfdb port from `grafemaClient`; iframe `http://localhost:{port}/ui/{db}` |
| `packages/vscode/src/grafemaClient.ts` | edit | expose `getRfdbPort(): number` |
| `packages/vscode/package.json` | edit | remove bundled-binary lazy-download setup; keep `Grafema: Open Map` command |

### 2.9 Retirement

| File / dir | Op |
|---|---|
| `packages/gui-server/` | `git mv` → `_archive/packages-gui-server/` (unconditional, Q3 resolved) |
| `packages/gui/server.js` | keep; audit `cubeToWorld` drift (unit test added) |
| References to `hex-topology.html` | audit; fix mapPanel (done via C0) |

### 2.10 Docs + invariant

| File | Op |
|---|---|
| `CLAUDE.md` | edit — add "Serving the Map UI" section |
| `_archive/gui-legacy-civmap/README.md` | **new** |
| `_archive/packages-gui-server/README.md` | **new** — reason + date |
| `packages/gui/README.md` | **new** — `<HexAtlas>` API |
| Datalog guarantee (see §7) | register via `create_guarantee` MCP call during C-docs |

---

## 3. Edge cases (expanded)

Adds to §4 of 002-plan:

| # | Case | Handling |
|---|---|---|
| E14 | Concurrent mode toggle during in-flight layout load | Two separate AbortSignals: `layoutAbort` for `fetchLayout`, `rendererAbort` for scene init. Toggle aborts the one that owns ITS operation; the other keeps running unless the new mode changes its inputs |
| E15 | `--static-dir` + feature `ui` both set | Precedence test: `--static-dir` wins (takes the dir). Documented in rfdb-server `--help` |
| E16 | `--static-dir` points at non-existent dir | Server logs warning on startup; serves 404 under /ui until resolved |
| E17 | `GRAFEMA_UI_DIST` env var set but dir empty | `build.rs` detects empty dir, writes placeholder; cargo warning surfaces |
| E18 | `pnpm build` updates dist but `cargo build` cached | `cargo:rerun-if-changed=$GRAFEMA_UI_DIST/*` forces rebuild |
| E19 | `gui/server.js` and `geom/hex.ts` drift apart | N/A — no drift possible, both import from `geom/hex.mjs`. Extra: `scripts/test-cubeToWorld-parity.mjs` as belt-and-suspenders on (q,r) ∈ [-250..250], including negatives, asserts `geom/hex.ts` ↔ `geom/hex.mjs` produce bit-identical Float32 values |
| E20 | VS Code webview iframe blocked by CSP | C0 explicit meta tag; documented test |
| E21 | HullLayer with 15k+ tiles × 5 levels | Exact-boundary trace O(|boundary|) per region per level ≈ O(√tiles × levels); on 40k tiles distributed across ~500 files, expected total < 300ms |
| E22 | Orthographic camera over 40k tiles, pan/zoom | OrbitControls with `enableRotate: false, enablePan: true, minZoom: X, maxZoom: Y` |
| E23 | Mode toggle mid-`animateColor` tween | Tween framework (AnimateTo) lives inside HexLayer; mode change doesn't interrupt in-flight tweens; they complete against the same mesh |
| E24 | 3D pin elevation when `tileElevation=flat` | Pins in 2D mode render via color ring instead of elevation; spec in HexLayer |

---

## 4. Siblings (expanded per Dijkstra P2)

Adds to §5 of 002-plan:

- **`packages/gui/server.js:73` `cubeToWorld`** — drift risk. Resolved: parity unit test + `@drift-with` comment OR shared `.mjs` module.
- **`packages/gui-server/src/hex_layout.rs`** — Rust grafema-gui's own hex layout. Archived with the rest of gui-server. No feature parity audit needed because rfdb-server's tectonic is the single source of truth for positions (post-merge).
- **`loadStream.ts` setState calls** — moved behind `layoutClient`. Bootstrap start-point now at host entry.
- **`setHexLayerRef` in `loadLiveLayout.ts`** — another module-mutable singleton; replaced with `sceneApi.setTargetPositions(x, z)` (added to SceneApi interface).
- **`activeEdgeLabels` exported `let` in `EdgeLabels.tsx:10`** — also a module-mutable singleton; swap-safe because each mount gets its own. Keep as-is OR fold into Zustand `viewStore.edgeLabels`. **Decision: fold into viewStore** in C-singletons for consistency.

## 5. Exclusions (unchanged)

## 6. Chunking (revised-2 — Canvas.tsx conflicts merged, ortho deps tightened)

### Key resolution of Dijkstra chunking conflicts

**Canvas.tsx is edited in exactly ONE chunk (C-Canvas-refactor).** That chunk absorbs:
- singleton deletions (was C-singletons),
- hull re-enable wiring (was C-hull's Canvas.tsx edit),
- mode-switching (was C-mode's Canvas.tsx edit).

Layer-file edits (HullLayer, HexLayer, FlowLayer, SceneManager) stay in separate chunks because they don't share a file. C-Canvas-refactor lands AFTER all layer changes are in, and wires them through.

**C0** sets CSP only AND points iframe at a known-good loader page (rfdb-server `/ui/` stub route added in C14c — if /ui unavailable, show "Waiting for RFDB server" loader). C16 does the real retarget + removes the binary-spawn path.

**C-archive** depends on **C16**, not C14c — don't archive gui-server while mapPanel still spawns it.

| # | Chunk | Files | Depends on |
|---|---|---|---|
| **C0** | VS Code CSP meta tag + fix broken iframe src (stable placeholder URL: `about:blank` or a new `/ui/_bootstrap.html` served by rfdb when C14c lands) | `packages/vscode/src/mapPanel.ts`, `packages/vscode/test/mapPanel.csp.test.ts` | — |
| **C2** | `controller/lod.ts` with **ortho-aware signature** (`lodFromView(view)` accepts perspective OR orthographic discriminated union); migrate all call sites (Labels.tsx, Canvas.tsx read) | `src/controller/lod.ts`, update `src/components/Labels.tsx` + `src/three/SceneManager.ts` to expose `getView()`, test | — |
| **C3** | `controller/focus.ts` + tests | `src/controller/focus.ts`, test | — |
| **C4** | `controller/tooltip.ts` + tests | `src/controller/tooltip.ts`, test | — |
| **C5** | Move `MapController` → `controller/`, define full `SceneApi` interface (enumerated), **no shim** — migrate 3 call sites | `src/controller/MapController.ts`, `src/controller/SceneApi.ts`, `src/controller/SceneApiContext.tsx`, delete `src/api/MapController.ts`, test | C2–C4 |
| **C6** | `geom/hex.ts` + `geom/hex.mjs` (shared with Node server.js) + `geom/hull.ts` (exact-boundary trace, batched via generator) + parity tests (q,r range **±250, includes negatives**) | `src/geom/hex.ts`, `src/geom/hex.mjs`, `src/geom/hull.ts`, `test/unit/geom/hull.test.ts`, `scripts/test-cubeToWorld-parity.mjs` | — |
| **C7** | `layout/layoutClient.ts` + types + AbortController tests + refactor loadStream/loadFixture to separate parse from setState | `src/layout/layoutClient.ts`, `src/layout/types.ts`, `src/store/loadStream.ts` (refactor), `src/store/loadFixture.ts` (refactor), tests | C6 |
| **C-Layer-Hull** | HullLayer with batched exact-boundary compute; standalone, NOT yet wired into Canvas.tsx | `src/three/HullLayer.ts` (edit), test | C6 |
| **C-Layer-Hex** | HexLayer flat-mode + hoverLift param + pin-ring in flat mode | `src/three/HexLayer.ts` (edit), test | — |
| **C-Layer-Flow** | FlowLayer line-mode in addition to tube | `src/three/FlowLayer.ts` (edit), test | — |
| **C-SceneManager** | `SceneManager.setMode` (idempotent via deepEqual), `flyTo` with ortho branch (pan + zoom), OrbitControls per-mode config, raycaster audit for ortho-safety, `getView()` + `getCameraDistance()` deprecated, `SceneMode` type in a shared type file | `src/three/SceneManager.ts` (edit), `src/three/types.ts` (new), test covering perspective/ortho camera swap + flyTo both branches + raycaster pick both cameras | C-Layer-Hull, C-Layer-Hex, C-Layer-Flow |
| **C-Canvas-refactor** | SOLE chunk editing `Canvas.tsx`: (1) delete `flowLayerRef`/`setShowCoordsRef`/`activeEdgeLabels` module exports, (2) provide `SceneApi` via context, (3) un-disable HullLayer (adopt batched compute from C-Layer-Hull), (4) subscribe to `viewStore.mode` and call `sceneApi.setMode()`, (5) migrate Sidebar/EdgeLabels/loadLiveLayout to sceneApi hook. Single chunk, single PR, single merge-conflict surface. | `src/components/Canvas.tsx`, `src/components/Sidebar.tsx`, `src/components/EdgeLabels.tsx`, `src/store/loadLiveLayout.ts`, integration test | C5, C-SceneManager |
| **C-viewStore-mode** | `viewStore.mode: SceneMode` + `setMode` action + idempotency guard in store (deep-equal short-circuit) + tests | `src/store/viewStore.ts` (edit), test | C5 |
| **C-HexAtlas** | `<HexAtlas mode>` component + `<ModeToggle>` + App refactor | `src/HexAtlas.tsx`, `src/components/ModeToggle.tsx`, `src/App.tsx`, test | C-Canvas-refactor, C-viewStore-mode |
| **C-hosts** | Vite multi-entry + hosts | `vite.config.ts`, `src/hosts/web.tsx`, `src/hosts/vscode.tsx`, `web.html`, `vscode.html` | C-HexAtlas |
| **C14a** | rfdb-server Cargo feature + build.rs (loud placeholder) + feature-off compile test + CI check | `packages/rfdb-server/Cargo.toml`, `build.rs`, `tests/compile_without_ui.rs`, CI config hint | C-hosts |
| **C14b** | `static_ui.rs` + RustEmbed + SPA fallback helper + `/ui/_bootstrap.html` stub route (used by C0's fallback) | `packages/rfdb-server/src/static_ui.rs`, `src/lib.rs` | C14a |
| **C14c** | routes + CLI flags (`--static-dir`, `--no-ui`) + integration tests (precedence, `--no-ui`, SPA fallback) | `packages/rfdb-server/src/http_server.rs`, `src/bin/rfdb_server.rs`, `tests/static_ui.rs` | C14b |
| **C16** | VS Code mapPanel: drop `findGuiBinary`/`downloadGuiBinary`/`spawn(grafema-gui)`; query `rfdbPort` from `grafemaClient`; iframe `http://localhost:{port}/ui/{db}` | `packages/vscode/src/mapPanel.ts`, `grafemaClient.ts`, test | C14c, C0 |
| **C-archive** | `git mv packages/gui-server/ → _archive/packages-gui-server/` + README note | git mv + README | **C16** (NOT C14c — must land after VS Code retarget so nothing still spawns the binary) |
| **C-docs** | CLAUDE.md "Serving the Map UI" section + `packages/gui/README.md` + Datalog guarantee registration via MCP `create_guarantee` | docs, MCP call | all |

**Total: 19 chunks.** Parallelizable: C2/C3/C4/C6 (independent modules); C-Layer-Hull/C-Layer-Hex/C-Layer-Flow (different layer files); C14a/C14b/C14c sequential. Canvas.tsx is touched by ONLY C-Canvas-refactor.

---

## 7. Invariants → Live Guarantees (revised per Dijkstra P2)

**Add one load-bearing guarantee:**

```datalog
# Panels (components/) must not import renderer internals (three/) directly.
# All renderer access goes through SceneApi + Zustand.
violation_panel_imports_three(P) :-
  node(P, "MODULE"), attr(P, "file", F1),
  starts_with(F1, "packages/gui/src/components/"),
  edge(P, R, "IMPORTS_FROM"), attr(R, "file", F2),
  starts_with(F2, "packages/gui/src/three/").
```

**Severity:** error (blocks CI if panels regain direct three imports).
**Registered in C-docs** via `mcp__grafema__create_guarantee`.

Defer the second guarantee (renderer-interface implementation check) — no `Renderer` interface now, obsolete.

---

## 8. Tests (revised deltas from 002-plan §8)

Add/modify:

- `test/unit/geom/hull.test.ts` — exact-boundary trace on known tile sets (single island, concave, multi-island, hole); matches sandbox expected output.
- `test/unit/layout/layoutClient.test.ts` — parse/fetch/abort; **fixture ↔ stream parity** on identical input.
- `test/unit/three/SceneManager.setMode.test.ts` — camera swap preserves orbital target; orthographic frustum fits scene.
- `test/unit/sceneApi.test.tsx` — panels using `useSceneApi()` hook still work after mode toggle; no stale ref errors.
- `packages/rfdb-server/tests/compile_without_ui.rs` — new (feature-off compile gate).
- `packages/rfdb-server/tests/static_ui.rs` — precedence: `--static-dir` > embedded > placeholder; `--no-ui` kills route.
- `scripts/test-cubeToWorld-parity.mjs` — gui/server.js vs geom/hex.ts numeric parity.
- `packages/gui/test/mode-switch.test.tsx` — integration: toggle mode with selected node + pinned node + active flow + diff mode active — all preserved.
- `packages/vscode/test/mapPanel.csp.test.ts` — CSP meta tag present; `frame-src http://localhost:*` allowed.

---

## 9. Risks (revised)

Add/modify from §10 of 002-plan:

| Risk | Likelihood | Mitigation |
|---|---|---|
| Orthographic camera perf at 40k tiles | Low | Same WebGL pipeline as 3D; no Canvas2D concerns |
| OrbitControls behavior changes with ortho camera | Medium | Dedicated tests; cursor-to-world math needs projection-aware unprojection (existing code uses perspective assumptions) |
| `cubeToWorld` drift between TS and JS | Low | E19 parity test |
| `rust-embed` MSRV | Low | Verified rust-embed 8.x supports Rust 1.78+; project uses 1.80+ |
| Ortho camera doesn't produce the "flat 2D feel" user expects | Medium | Fall back to (a) Canvas2D if rejected at 3-review or user-demo; design doc for ortho frustum in `SceneManager.setMode` |

---

## 10. Decisions (final)

**Autonomous (no user input needed):**
- Three.js ortho camera architecture (confirmed by user Q2=b, but implementation details are mine: OrbitControls config, frustum math, tile flat-mode encoding)
- Exact-boundary hull algorithm (user Q1=C, implementation details: port verbatim from sandbox)
- All Dijkstra P2 gaps (sibling dedupe, loadStream bootstrap, coord system = `(x, z)`, dual-abort for concurrent toggle, `activeEdgeLabels` → Zustand)
- Chunk re-splits (C14 into a/b/c; C-singletons before C-HexAtlas; C0 for CSP; C-hull separated)
- Datalog guarantee (panels → three import ban)

**User-facing decisions already locked:**
- Q1/Q2/Q3 resolved.
- Plan ready for re-run of Dijkstra verification.

---

## Open questions → NONE. Plan is ready for Dijkstra re-run.

---

## Deferred action items (discovered during Phase 1 implementation)

These surfaced in coding-subagent reports and MUST be addressed in the chunks indicated (not silently dropped). Each has a TaskCreate task tracked in the session task list.

| # | Finding | Owning chunk | Behavioral impact? |
|---|---|---|---|
| DAI-1 | `viewStore.selection: Set<number>` was dead code; Canvas.tsx uses local `selectedIdx: number`. Double representation. C3 introduced Set as source of truth but kept selectedIdx parallel. Also: no shift/ctrl/drag producers exist in Canvas.tsx despite focus.ts handling them. | **C-Canvas-refactor** | Internal; adds new capability |
| DAI-2 | Vite build warning: `dataStore.ts` dynamically imported by App.tsx but statically imported by 7 other modules → "dynamic import will not move module into another chunk". Harmless today; matters for multi-entry bundle. | **C-hosts** | No |
| DAI-3 | In ortho mode, `mapStore.cameraDistance=0` is set because "distance" has no meaning. Sidebar.tsx displays "Distance: N" — will literally show 0. Fix: hide Distance row in 2D OR rename to "Zoom" + show zoom. | **C-viewStore-mode** | UX readout |
| DAI-4 | **Behavioral change from C3**: clicking a selected tile previously toggled it off; now it's idempotent replace. Flag for 3-Review to confirm desired. | 3-Review | **YES — user-visible** |
| DAI-5 | **Behavioral change from C4**: tooltip now shows `file:line` row (previously not rendered). Flag for 3-Review to confirm desired. | 3-Review | **YES — user-visible** |
| DAI-6 | C5 (Phase 2) kept a thin `api/MapController.ts` re-export shim with deprecation warning to avoid editing Canvas.tsx outside its chunk. Final deletion + caller migration moves to C-Canvas-refactor. | **C-Canvas-refactor** | No |
| DAI-7 | `mapStore.ts` hardcodes `window.innerWidth/innerHeight` at module eval — not SSR/Node safe. Guard with `typeof window === 'undefined' ? ...`. Audit other `window.*`/`document.*` leaks in stores. | **C-viewStore-mode** | No |
| DAI-8 | ESLint glob excludes `.tsx` in packages/gui/. New .tsx files go unchecked by pre-commit. Extend glob to `**/*.{ts,tsx}`. | **C-hosts** | No |
| DAI-9 | C-SceneManager must map `dataStore.Region` → `HullRegion = {path, tiles: HexCoord[]}`. `Region.border` is always `[]`; tiles come from `nodes` + `__grafemaTileCoords` globals (pattern used by RegionLayer.build). | **C-SceneManager** | No |
| DAI-10 | Canvas.tsx now touched by 5+ chunks (C2, C3, C4, C7, C-Layer-Hull 1-line fix). C-Canvas-refactor must audit ALL prior edits for consistency, not just the planned responsibilities. | **C-Canvas-refactor** | No |
| DAI-11 | FlowLayer line-style `highlightEdges` is a no-op (thick-line vertex-color rewrites thrash GPU on hover). If 2D needs edge highlight, add overlay layer or per-edge instanceColor diffs. | **Future (post-3-Review)** | Possibly |
| DAI-12 | C-Canvas-refactor MUST: (a) call `sm.attachLayers({...})` BEFORE first `setMode`; (b) convert cached `const camera = sceneManager.camera` in Labels/EdgeLabels/RouteLabels/CoordGrid to lazy getters (refs go stale on camera swap); (c) verify autofit `camera.position.set(cx, dist, cz + dist)` works in both ortho + perspective. | **C-Canvas-refactor** | No |
| DAI-13 | `sceneModesEqual` duplicated in `SceneManager.ts` and `viewStore.ts`. Consolidate into `three/types.ts`. | **C-Canvas-refactor** or standalone | No |
| DAI-14 | Wire SceneManager ortho zoom changes → `mapStore.setZoom(camera.zoom)` on OrbitControls 'change' event. Sidebar Zoom readout stays at default 1.0 until this lands. | **C-Canvas-refactor** | UX readout |
| DAI-15 | rfdb-server HTTP port hardcoded to 3335. Port conflicts silent. Future: --http-port 0 + read from lockfile. | Post-REG-1100 | No |
| DAI-16 | mapPanel hardcodes db='default'. Need `grafema.databaseName` workspace config once multi-db lands. | Post-REG-1100 | No |
| DAI-17 | `grafema.openMap` should auto-start rfdb-server if not running; today shows 60s timeout error if user opens Map before Analyze. | Post-REG-1100 UX | UX |
| DAI-18 | `packages/gui/vscode.html` + `hosts/vscode.tsx` are dead entry points (Phase 8 took simpler iframe of /ui/{db}=web.html). Decide: delete them, OR repurpose for webview-postMessage init protocol. | **Phase 9 decision** | No |

**Rule:** any finding noted in a future coding-subagent report gets appended here with an owning chunk + TaskCreate, NOT verbally reported and forgotten.
