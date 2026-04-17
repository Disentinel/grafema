# @grafema/gui

React + Three.js unified hex-map visualizer.

## Usage

### As a React component

```tsx
import HexAtlas from '@grafema/gui/HexAtlas';

<HexAtlas
  mode={DEFAULT_3D_MODE}     // optional; defaults to viewStore.mode
  source={{ kind: 'stream', url: '/api/graph-stream' }}
  className="my-map"         // optional
/>
```

### Hosts

- `src/hosts/web.tsx` — served by `rfdb-server` at `/ui/{db}`. Reads `db` from URL path.
- `src/main.tsx` — dev / standalone browser (default `pnpm dev` target).

## Build

```bash
pnpm --filter @grafema/gui build
# Outputs: dist/index.html (dev), dist/web.html (rfdb-served)
```

For the rfdb-server embedded bundle:

```bash
scripts/build-gui-for-rfdb.sh
```

## Architecture

- `HexAtlas.tsx` — top-level component. Provides `SceneApiProvider`, subscribes to `viewStore.mode`.
- `components/Canvas.tsx` — Three.js scene manager, layers, interaction events.
- `three/SceneManager.ts` + `HexLayer.ts` + `FlowLayer.ts` + `HullLayer.ts` + `RegionLayer.ts` + `RouteLayer.ts` — render layers.
- `store/` — Zustand stores: data, view (includes mode), map (includes zoom), route, diff.
- `controller/MapController.ts` — JSON-RPC facade for external automation.
- `controller/SceneApi.ts` + `SceneApiContext.tsx` — imperative handle for panels.
- `geom/hex.{ts,mjs}` + `geom/hull.ts` — shared hex geometry + exact-boundary hull trace.
- `layout/layoutClient.ts` — `fetchLayout(opts)` wraps fixture + stream sources.

## Mode switch

Runtime 2D ⇄ 3D via `viewStore.setMode(DEFAULT_2D_MODE)`. Camera, tile elevation, flow style, lighting, background all adjust. Selection/hover/pins preserved across toggles.

## Tests

```bash
node --import tsx --test 'packages/gui/test/unit/**/*.test.{ts,tsx}'
```
