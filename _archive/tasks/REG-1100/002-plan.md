# REG-1100 — Exhaustive Plan

**Workflow:** v3.0
**Planner:** top-level Claude (Opus 4.7)
**Date:** 2026-04-17

---

## 1. Problem Analysis

### What exists (post-merge)

- **3D view** (`packages/gui/`): React + Three.js + Zustand. Already consumes server-produced tectonic positions (`af557eb4` ripped client SA). State is already in Zustand stores that are 95% renderer-agnostic. `MapController.ts` (179 lines) is a JSON-RPC façade — **it is already the controller the task wants**, just with one 3D-specific hook (`_sceneRef.flyTo`).
- **2D sandbox** (`sandbox/hex-sandbox/`): plain JS + Canvas. Layout-algorithm **research playground** (greedy pack + iswap + xswap + Monte-Carlo + tectonic). User explicitly keeps this as a sandbox. Its `HexMap` class is a mutation-oriented spatial index — **not** what production 2D needs.
- **VS Code extension** (`packages/vscode/`): already has `mapPanel.ts` (350 lines) that spawns `grafema-gui` (Rust) and iframes the rendered page. Broken today because the iframe src `/hex-topology.html` was archived.
- **Rust HTTP** (`packages/rfdb-server/src/http_server.rs`): Axum. Routes `/api/graph-stream`, `/api/layout-live` (WS), `/api/stats`, `/api/node/{id}`. No static UI yet. `tower-http` is already a dep (CorsLayer imported).
- **Redundant HTTP servers:** `packages/gui-server/` (Rust binary, legacy), `packages/gui/server.js` (Node dev), `packages/rfdb-server/` (target). Task pushes toward **rfdb-server as single host**.

### What the task actually requires

The ticket framing ("extract layout from view") is partly stale — layout is already server-side. The real remaining work:

1. **Renderer abstraction:** today's `packages/gui/src/three/*` renders directly from Zustand state. A `Renderer` interface decouples state updates from pixels; Three.js renderer keeps its logic, new Canvas2D renderer is a parallel implementation.
2. **One mode-switching `<HexAtlas>` component** that swaps the renderer without unmounting the controller/state tree.
3. **`layout()` data contract** (client side) — wrapper over `loadStream`/`loadLiveLayout` that exposes `(tree, links, opts) → { nodeCoords, hullPaths }` so fixture mode, server mode, and future offline mode are interchangeable.
4. **`rfdb-server` serves the UI bundle** — Axum `ServeDir` at `/ui/` plus a `/ui/{db}` shim that selects the active database before serving the SPA.
5. **VS Code webview uses `rfdb-server`'s UI** — retire the `grafema-gui` spawn path. Webview loads the same `/ui/{db}` URL served by the workspace's `rfdb-server`.
6. **Feature-gap audit** — enumerate features in both codebases, implement gaps in the 2D renderer so the modes are parity.

---

## 2. Architecture Decisions (made autonomously; flag for user review)

| Decision | Chosen | Alternative rejected | Why |
|---|---|---|---|
| 2D renderer tech | **HTML5 Canvas 2D** | Three.js orthographic camera; SVG | Matches user's intent ("2d canvas"); no WebGL dep; aligns with hex-sandbox's render.js proven for this geometry |
| Code location | **Additive in `packages/gui/src/`** (new `renderers/canvas/`, `HexAtlas.tsx`, `controller/`) | Split into new `packages/hex-atlas` | Keeps diff minimal, preserves git history; extraction to standalone package is REG-1101's job |
| Renderer swap | **Unmount/remount renderer, keep controller + stores mounted** | In-place renderer mutation | React-idiomatic; no shared mutable DOM; controller state survives trivially |
| Sandbox 2D code | **Do not port, reference only** | Extract HexMap + render.js into production | User kept sandbox "explicitly as a sandbox"; sandbox HexMap is layout-algorithm-oriented, not render-oriented |
| RFDB UI serving | **Cargo feature `ui` (default = on) with `rust-embed` behind it**; Axum `ServeDir` route at `/ui/*`. `cargo build -p rfdb-server --no-default-features` produces a UI-less binary. | Always-on embed; filesystem-only `--static-dir` | User confirmed: default-on feature gate. Smaller headless binary still possible for servers that don't need UI. |
| Per-db routing | **`/ui/{db}` rewrites to SPA root; db becomes URL param client reads** | Separate port per db | `rfdb-server` already supports multi-db; URL param is the standard SPA pattern |
| VS Code webview | **Iframe the `/ui/{db}` URL + postMessage bridge** (similar to current, new target) | Bundle the SPA inside the extension | Single bundle to maintain, no version-skew risk between extension and rfdb-server |
| Retire `grafema-gui`? | **Yes, unconditionally archive `packages/gui-server/` in this task** (user confirmed) | Keep both | rfdb-server subsumes its purpose; gui-server becomes pure duplicate |
| Retire `packages/gui/server.js`? | **Keep as Vite dev helper** | Archive | Still useful during local dev without running rfdb-server |
| Code placement | **Stay in `packages/gui/`** (user confirmed); npm extraction to `packages/hex-atlas` is REG-1101's scope | New `packages/hex-atlas` now | Minimum structural diff; REG-1101 handles opensource packaging later |

---

## 3. File-by-File Changes

### 3.1 Controller + pure logic (extracted from scattered locations)

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/controller/MapController.ts` | **move** from `src/api/` | Keep JSON-RPC façade; abstract `_sceneRef.flyTo` → `_viewport.flyTo(x,z)` (renderer-agnostic) |
| `packages/gui/src/controller/lod.ts` | **new** | Pure function `lodFromZoom(distance, viewport) → 0|1|2|3`; current math lives in `Labels.tsx`+`Canvas.tsx`; extract and share |
| `packages/gui/src/controller/focus.ts` | **new** | Pure selection/focus state transitions; unit-testable without DOM |
| `packages/gui/src/controller/tooltip.ts` | **new** | Tooltip routing (which panel shows which info for which hover target) |
| `packages/gui/src/controller/viewport.ts` | **new** | `Viewport` interface: `flyTo(x,z,durationMs)`, `zoomTo(level)`, `getVisibleBounds()` — implemented per renderer |
| `packages/gui/src/api/MapController.ts` | **delete** (after re-export shim if needed for backwards compat) | Moved |
| `packages/gui/src/api/PostMessageAdapter.ts` | keep | Still needed |
| `packages/gui/src/api/WebSocketAdapter.ts` | keep | Still needed |

### 3.2 Layout data contract

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/layout/layoutClient.ts` | **new** | `async function fetchLayout(opts): Promise<{nodeCoords, hullPaths}>`; wraps `loadStream` + fixture path behind one signature |
| `packages/gui/src/layout/types.ts` | **new** | `LayoutInput`, `LayoutOutput`, `HullPathLayer` types |
| `packages/gui/src/store/loadStream.ts` | keep, minor refactor | Make it a transport layer, not a state loader; `layoutClient.ts` is the new public entry |
| `packages/gui/src/store/loadFixture.ts` | keep, minor refactor | Same |
| `packages/gui/src/store/loadLiveLayout.ts` | keep | Phase-2 WS still disabled per current code |

### 3.3 Renderer abstraction

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/renderers/Renderer.ts` | **new** | Interface: `init(canvas)`, `setPositions(x, z)`, `setColors(rgba)`, `setHover(idx)`, `setSelection(indices)`, `setPins(idxMap)`, `setRegions(paths)`, `setFlows(edges)`, `setRoutes(routes)`, `setLOD(level)`, `dispose()`, `flyTo(x,z,ms)` |
| `packages/gui/src/renderers/three/index.ts` | **new** | Adapter that instantiates `SceneManager` + layers and implements `Renderer` interface |
| `packages/gui/src/renderers/canvas/index.ts` | **new** | Canvas2D `Renderer` implementation — delegates to layer classes below |
| `packages/gui/src/renderers/canvas/HexCanvasLayer.ts` | **new** | Draw hex tiles (fill, outline, scale) |
| `packages/gui/src/renderers/canvas/HullCanvasLayer.ts` | **new** | Draw N-level hulls (morphological close from sandbox; shared utility) |
| `packages/gui/src/renderers/canvas/FlowCanvasLayer.ts` | **new** | Draw flow/link curves — Bezier for 2D |
| `packages/gui/src/renderers/canvas/RouteCanvasLayer.ts` | **new** | CatmullRom routes in 2D (port sandbox/route.js math) |
| `packages/gui/src/renderers/canvas/RegionCanvasLayer.ts` | **new** | Region borders/labels |
| `packages/gui/src/renderers/canvas/CanvasViewport.ts` | **new** | Pan/zoom camera for 2D; implements `Viewport` |
| `packages/gui/src/three/*` | keep | Unchanged; `renderers/three/index.ts` wraps them |

### 3.4 Shared geometry helpers (sharing with sandbox is explicit)

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/geom/hex.ts` | **new** | `cubeToWorld`, `hexKey`, `HEX_DIRS`, `hexNeighbors` — one source of truth shared by both renderers |
| `packages/gui/src/geom/hull.ts` | **new** | Morphological close hull (ported from `sandbox/hex-sandbox/src/hull.js` + skill `hex-grid-morphological-close-hull`) — used by HullCanvasLayer AND HullLayer (three.js) |
| `packages/gui/src/store/loadFixture.ts` — `cubeToWorld` export | **deprecate** | Re-export from `geom/hex` to avoid duplication |

### 3.5 Top-level component

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/HexAtlas.tsx` | **new** | `<HexAtlas mode="2d" \| "3d" source={LayoutSource} />`; picks a renderer, mounts it, wires controller, leaves existing panels |
| `packages/gui/src/components/Canvas.tsx` | **refactor** | Becomes thin container for 3D renderer; logic moves to `renderers/three/index.ts`; Canvas.tsx then either deletes or stays as 3D-only adapter used by HexAtlas |
| `packages/gui/src/App.tsx` | **refactor** | Mount `<HexAtlas>` with mode from URL query or toggle button |
| `packages/gui/src/components/ModeToggle.tsx` | **new** | Small UI button 2D/3D |

### 3.6 Hosts

| File | Op | Purpose |
|---|---|---|
| `packages/gui/src/hosts/web.tsx` | **new** | Entry for rfdb-server-served SPA; reads `/ui/{db}` param, points `layoutClient` at the serving rfdb-server |
| `packages/gui/src/hosts/vscode.tsx` | **new** | Entry for VS Code webview; uses `PostMessageAdapter` + `rfdb-server` URL passed in from extension |
| `packages/gui/main.tsx` | keep | Default dev entry (points at `/` served by Vite) |
| `packages/gui/vite.config.ts` | **edit** | Multiple entry builds: `index.html` (dev), `web.html` (rfdb-served), `vscode.html` (vscode-embedded) |
| `packages/gui/index.html` | **edit** | Minimal dev page |
| `packages/gui/web.html` | **new** | Production entry for `/ui/` path |

### 3.7 RFDB server static UI

| File | Op | Purpose |
|---|---|---|
| `packages/rfdb-server/Cargo.toml` | **edit** | Add Cargo feature `ui` in `[features] default = ["ui"]`; `ui = ["dep:rust-embed", "tower-http/fs"]`. Optional deps declared with `dep:` prefix. |
| `packages/rfdb-server/src/http_server.rs` | **edit** | Gate `/ui/*` route with `#[cfg(feature = "ui")]`. Route delivers SPA: `GET /ui/` → embedded `index.html`; `GET /ui/{db}` → same (SPA fallback); `GET /ui/{db}/assets/*path` → embedded static asset; unknown path under `/ui/{db}/*` → 200 + index.html (client-side routing). |
| `packages/rfdb-server/src/static_ui.rs` | **new (feature-gated)** | `#[derive(RustEmbed)] #[folder = "$CARGO_MANIFEST_DIR/ui-dist/"] struct UiAssets;` + helper `serve_asset(path) -> Response`. Only compiled when `ui` feature enabled. |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | **edit** | `--static-dir <path>` CLI flag: if set and `ui` feature compiled, overrides embedded assets (dev mode). `--no-ui` flag: runtime kill switch even when feature compiled. |
| `packages/rfdb-server/build.rs` | **new (feature-gated)** | Under `cfg(feature = "ui")`: if `$GRAFEMA_UI_DIST` is set, copy the dist tree into `OUT_DIR/../../ui-dist/` for `rust-embed`. If not set, emit a placeholder `index.html` saying "UI bundle not built — run scripts/build-gui-for-rfdb.sh". Emit `cargo:rerun-if-env-changed=GRAFEMA_UI_DIST`. |
| `scripts/build-gui-for-rfdb.sh` | **new** | `pnpm --filter @grafema/gui build && GRAFEMA_UI_DIST=$(pwd)/packages/gui/dist cargo build -p rfdb-server --release`. Default build path. |
| `scripts/build-native.sh` | **edit** | Call the above when building rfdb-server in CI/release. Add `--no-ui-feature` optional flag for headless server builds (passes `--no-default-features`). |

### 3.8 VS Code extension retargeting

| File | Op | Purpose |
|---|---|---|
| `packages/vscode/src/mapPanel.ts` | **edit** | Remove `grafema-gui` spawn path; talk to workspace's `rfdb-server` (already spawned by other parts of the extension); iframe `http://localhost:{rfdbPort}/ui/{db}` |
| `packages/vscode/src/grafemaClient.ts` | **edit (if needed)** | Expose the `rfdb-server` port to `mapPanel.ts` |
| `packages/vscode/package.json` | **edit** | Drop `bundled grafema-gui binary` logic; command `Grafema: Open Map` stays |

### 3.9 Retirement

| File / dir | Op | Purpose |
|---|---|---|
| `packages/gui-server/` | **move to `_archive/packages-gui-server/`** (user confirmed) | Duplicate after rfdb-server serves UI |
| `packages/gui/server.js` | keep | Dev-only helper |
| References to `hex-topology.html` | **audit** | Any lingering reference from legacy archive; fix or remove |

### 3.10 Documentation / cleanup

| File | Op | Purpose |
|---|---|---|
| `CLAUDE.md` | **edit** | Add "Serving the Map UI" section under architecture |
| `_archive/gui-legacy-civmap/README.md` | **new** | One-line note explaining archive origin + date |
| `packages/gui/README.md` | **new** | Document `<HexAtlas>` API, mode switching, host entries |

---

## 4. Edge Cases & Their Handling

| # | Case | Handling |
|---|---|---|
| E1 | Renderer swap mid-interaction (user clicks toggle while hovering) | Controller emits `pointerLeave` before renderer dispose; new renderer starts with cleared hover |
| E2 | Layout arrives after component unmount | Abort via `AbortController` passed into `layoutClient.fetchLayout(opts)` |
| E3 | rfdb-server serves UI but client points at stale port | Health check in `hosts/web.tsx`; show "RFDB not reachable" fallback |
| E4 | VS Code webview reloads (extension Host restart) | `retainContextWhenHidden: true` already set; on reload, re-query rfdb port |
| E5 | 3D → 2D for 40k atoms (perf) | Canvas2D path uses dirty-region repaint + requestAnimationFrame throttle; baseline test at 10k tiles must stay > 30fps on MBP M1 |
| E6 | 2D → 3D twice quickly | Guard renderer init with `currentRendererToken` counter; stale init results tossed |
| E7 | `/ui/{db}` with unknown db | rfdb-server returns 404; SPA shows "Unknown database" + list of known dbs from `/api/databases` (new endpoint) |
| E8 | Color-blindness / contrast on 2D | Honor the same lens config as 3D; both feed colors through `config/lenses.ts` |
| E9 | Diff mode visual fidelity in 2D | Ghost+red (removed), yellow+elevated (changed) — elevation maps to tile-scale in 2D |
| E10 | Route labels in 2D | Port sandbox `toponym` logic from `sandbox/hex-sandbox/src/render.js` |
| E11 | Shader-only effects in 3D (fog, bloom) | 2D either skips or uses canvas-filter fallback; documented in `components/ModeToggle.tsx` |
| E12 | Pre-commit hook will lint the new TS files | All new files obey ESLint; no `any`; no unused vars |
| E13 | `mapPanel.ts` broken today (archived html) | Fix first, as standalone commit, before anything else — unblocks VS Code regression |

---

## 5. Sibling Occurrences (searched, included in plan)

- **"HexMap/hex layout rendering" in 3 codebases** — hex-sandbox (kept as research), `packages/gui/src/three/` (kept, wrapped), new `renderers/canvas/` (added). Hull math unified into `geom/hull.ts` (shared by both production renderers; sandbox keeps its local copy intentionally).
- **LOD math** currently lives in `Canvas.tsx` + `Labels.tsx` — extracted into `controller/lod.ts`.
- **`cubeToWorld`** lives in `loadFixture.ts` (imported by `loadLiveLayout.ts`) — moved to `geom/hex.ts`, re-exported from old site.
- **Three HTTP servers** — only rfdb-server retained for production serving; gui-server archived; gui/server.js kept for dev.
- **Archived legacy references** — `hex-topology.html` referenced in `mapPanel.ts:321`; fix is item E13.

## 6. Explicit Exclusions

| What | Why excluded |
|---|---|
| Porting sandbox layout algorithms to production | User kept sandbox as a sandbox; algorithms ported to Rust via REG-1102 |
| Standalone npm package `@grafema/hex-atlas` | REG-1101 tracks it; this task keeps code in `packages/gui/` to minimize structural change |
| SA convergence tuning | REG-1102 |
| Mobile / touch input UX polish | Non-goal; basic pointer events only |
| Server-side layout improvements | Server already delivers positions; unchanged |
| Changing `/api/graph-stream` wire format | Stable; any new metadata for 2D rendering can ride in existing `node.metadata` |

---

## 7. Grafema Invariants → Live Guarantees

**Honest answer: this task has few Datalog-worthy invariants.** Guarantees are for graph-structural properties of analyzed code. REG-1100 is frontend behaviour. The testable invariants here are runtime/unit, not graph.

Two *possible* Datalog guarantees worth noting for later enforcement (they apply to whatever code ships in packages/gui):

| Invariant | Datalog sketch | Severity | Replaces |
|---|---|---|---|
| Every exported `<HexAtlas>` entry MUST import from `controller/` and `renderers/` (no direct `three/` or `canvas/` imports from panels) | `violation(X) :- node(X,"MODULE"), attr(X,"file","packages/gui/src/components/"), edge(X,Y,"IMPORTS_FROM"), attr(Y,"file","packages/gui/src/three/").` | warning | Nothing (new) |
| Renderer modules MUST implement the `Renderer` interface (tested by structural check) | `violation(X) :- node(X,"MODULE"), attr(X,"file","packages/gui/src/renderers/"), not edge(X,_,"IMPLEMENTS_INTERFACE").` | info | Nothing |

Both are deferred — declaring them useful requires Grafema to already have reliable `IMPORTS_FROM` and `IMPLEMENTS_INTERFACE` data for this package. Listed for completeness; NOT included in task DoD.

---

## 8. Test Strategy — Specific Scenarios

### 8.1 Controller tests (`test/unit/controller/`)

- `lod.test.ts`:
  - `lodFromZoom(1, viewport)` → 3 (finest)
  - `lodFromZoom(10000, viewport)` → 0 (coarsest)
  - Monotonic: any two distances d1 < d2 ⇒ lod(d1) ≥ lod(d2)
- `focus.test.ts`:
  - Select → selected set grows by 1
  - Click outside → selected cleared
  - Shift+click → additive selection
- `tooltip.test.ts`:
  - Hover node → tooltip routes to node panel
  - Hover edge → tooltip routes to edge panel
  - Hover nothing → tooltip null

### 8.2 Layout client tests (`test/unit/layout/`)

- `layoutClient.test.ts`:
  - Fixture source → returns deterministic `nodeCoords`
  - Server source (mocked `/api/graph-stream` NDJSON) → parsed coords match fixture
  - Abort signal → rejects with `DOMException('Abort', 'AbortError')`
  - Identical server + fixture input ⇒ byte-identical `nodeCoords`

### 8.3 Renderer parity tests (`test/unit/renderers/`)

- `parity.test.ts`: given the same state, both renderers call their internal tile-draw operation for the same indices in the same order. Uses a stub DOM/Three.
- `renderer-interface.test.ts`: each renderer module exports the full `Renderer` surface; missing methods fail at type level AND at runtime.

### 8.4 HexAtlas integration tests (`test/integration/`)

- `hex-atlas.mode-switch.test.tsx`:
  - Mount `<HexAtlas mode="3d">`, select node, switch to mode="2d" → selection preserved
  - Pin node in 2D, switch to 3D → pin visible in 3D
  - Toggle flow in 3D, switch to 2D → flow visible in 2D

### 8.5 rfdb-server static UI tests (`packages/rfdb-server/tests/`)

- `static_ui.rs`:
  - `GET /ui/` → 200, HTML, contains `<div id="root">`
  - `GET /ui/mydb/assets/main.js` → 200, JS
  - `GET /ui/mydb` → 200, serves index.html (SPA fallback)
  - `GET /ui/mydb/nonexistent.xyz` → SPA fallback (index.html), NOT 404
  - `--no-ui` flag → `GET /ui/` → 404

### 8.6 VS Code mapPanel tests (`packages/vscode/test/`)

- `mapPanel.test.ts`:
  - `createOrShow()` with running rfdb-server → iframe points at `http://localhost:{rfdb}/ui/{db}`
  - Rfdb port unavailable → loader message "Waiting for RFDB server"

### 8.7 Regression

- `grafemaClient.ts` test asserts the new `getRfdbPort()` matches what `analyze` starts

---

## 9. Implementation Chunking (for coding subagents)

Each coding subagent gets one row. Max 2–3 files. Tests + code together.

| # | Chunk | Files | Depends on |
|---|---|---|---|
| C1 | Fix broken iframe reference in mapPanel.ts (E13) — point to workspace rfdb-server's `/api/graph-stream` OR fallback loader until rest lands | `packages/vscode/src/mapPanel.ts`, test | — |
| C2 | Extract `controller/lod.ts` + tests | `src/controller/lod.ts`, `test/unit/controller/lod.test.ts` | — |
| C3 | Extract `controller/focus.ts` + tests | `src/controller/focus.ts`, `test/unit/controller/focus.test.ts` | — |
| C4 | Extract `controller/tooltip.ts` + tests | `src/controller/tooltip.ts`, `test/unit/controller/tooltip.test.ts` | — |
| C5 | Move MapController → controller/ + add Viewport interface | `src/controller/MapController.ts`, `src/controller/viewport.ts`, `src/api/MapController.ts` (shim re-export), test | C2, C3, C4 |
| C6 | Add `geom/hex.ts` + `geom/hull.ts` | `src/geom/hex.ts`, `src/geom/hull.ts`, test | — |
| C7 | Layout client | `src/layout/layoutClient.ts`, `src/layout/types.ts`, test | C6 |
| C8 | Renderer interface + three adapter | `src/renderers/Renderer.ts`, `src/renderers/three/index.ts`, test | C5, C7 |
| C9 | Canvas2D renderer — hex + hull only (minimal viable) | `src/renderers/canvas/index.ts`, `HexCanvasLayer.ts`, `HullCanvasLayer.ts`, `CanvasViewport.ts`, test | C6, C8 |
| C10 | Canvas2D flows + regions | `FlowCanvasLayer.ts`, `RegionCanvasLayer.ts`, test | C9 |
| C11 | Canvas2D routes + pins + diff | `RouteCanvasLayer.ts`, diff/pin handling, test | C9 |
| C12 | `<HexAtlas>` component + `<ModeToggle>` + App refactor | `HexAtlas.tsx`, `components/ModeToggle.tsx`, `App.tsx`, test | C8, C9 |
| C13 | Vite multi-entry config + hosts | `vite.config.ts`, `src/hosts/web.tsx`, `src/hosts/vscode.tsx`, `web.html` | C12 |
| C14 | rfdb-server UI bundling (rust-embed + build.rs) | `packages/rfdb-server/Cargo.toml`, `build.rs`, `src/static_ui.rs`, `src/http_server.rs` route additions, test | C13 |
| C15 | rfdb-server CLI flags (--static-dir, --no-ui) | `src/bin/rfdb_server.rs`, test | C14 |
| C16 | VS Code mapPanel retarget to rfdb-server /ui | `packages/vscode/src/mapPanel.ts`, `grafemaClient.ts`, test | C14 |
| C17 | scripts/build-gui-for-rfdb.sh + build-native.sh hook | scripts + docs | C14 |
| C18 | Archive packages/gui-server/ (after E1 confirmation) | git mv | C16 + user confirm |
| C19 | CLAUDE.md doc section + packages/gui/README.md | docs | all |

Total: **19 coding-agent chunks**, each scoped to 2–3 files. Parallelisable where dependencies allow (C2/C3/C4/C6 can run in parallel; C9/C10/C11 sequential because they share canvas state).

---

## 10. Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Canvas2D perf lags on large graphs | Medium | Baseline perf test in C9; fall back to three.js orthographic if 10k tiles < 30fps |
| rfdb-server binary size balloons with embedded UI | Medium | `rust-embed` compresses; measure before/after; if > +5MB, consider optional `--bundle-ui` feature flag |
| VS Code webview CSP blocks iframe to localhost | Low | Already in current code; preserve `Content-Security-Policy` headers; test `http://localhost:*` allowed |
| Ongoing REG-1102 work on `main` collides | Medium | Coordinate via short-lived task branches; rebase often; keep C1–C19 chunks small |
| `tower-http` feature bloat | Low | Only add `fs` feature; already a dep |
| Users relying on `grafema-gui` binary | Medium | E1 user escalation before C18; keep binary in `_archive/` recoverable for two minor versions |

---

## 11. Decision Authority Summary

**Autonomous:** Canvas2D over Three.js-ortho, additive code layout, rust-embed bundling, SPA fallback pattern, keep sandbox untouched, retire gui-server conditionally, test strategy above.

**User decisions resolved (2026-04-17):**
- **E1 (retire gui-server):** Confirmed. Archive to `_archive/packages-gui-server/` as part of this task.
- **Placement:** Stay in `packages/gui/`. REG-1101 handles standalone `packages/hex-atlas` for opensource packaging.
- **UI feature gate:** Cargo feature `ui` (default = on); headless builds use `cargo build --no-default-features`.
- **Workflow:** User authorized move to Dijkstra verification.
