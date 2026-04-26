# REG-1100 — Implementation Summary

**Date:** 2026-04-17
**Status:** Implementation complete, ready for 3-Review.

## Overview

Unified 2D/3D hex-atlas component (`<HexAtlas>`) in `@grafema/gui`,
served by `rfdb-server` at `/ui/{db}` via a default-on `ui` Cargo
feature, iframed by the VS Code extension. Legacy `grafema-gui`
binary retired.

## Scope delivered

- 9 phases, ~30 coding chunks.
- Tests green: **235** GUI unit tests, **171** VS Code unit tests, rfdb-server integration tests (`static_ui.rs`, `ui_routes.rs`, `compile_without_ui.rs`).
- `pnpm --filter @grafema/gui build` emits `dist/index.html` + `dist/web.html`.

## Key files created

- `packages/gui/src/HexAtlas.tsx` — unified 2D/3D component.
- `packages/gui/src/components/ModeToggle.tsx` — 2D⇄3D switch.
- `packages/gui/src/controller/SceneApi.ts` + `SceneApiContext.tsx` — imperative handle for panels.
- `packages/gui/src/controller/{lod,focus,tooltip}.ts` — pure controllers extracted.
- `packages/gui/src/geom/hex.{ts,mjs}` — shared hex geometry (single source of truth).
- `packages/gui/src/geom/hull.ts` — exact-boundary hull trace (port of `sandbox/hex-sandbox/src/hull.js`).
- `packages/gui/src/layout/layoutClient.ts` + `layout/types.ts` — `fetchLayout(opts)` contract.
- `packages/gui/src/hosts/web.tsx` + `web.html` — rfdb-served SPA entry.
- `packages/gui/src/three/types.ts` — `SceneMode`, `sceneModesEqual`.
- `packages/rfdb-server/src/static_ui.rs` — `rust-embed` UI assets + SPA fallback.
- `packages/rfdb-server/build.rs` — copies `$GRAFEMA_UI_DIST` into `OUT_DIR` or writes placeholder.
- `packages/rfdb-server/tests/{compile_without_ui,static_ui,ui_routes}.rs` — feature + route tests.
- `scripts/build-gui-for-rfdb.sh` — `pnpm build gui → cargo build rfdb` one-liner.
- `packages/gui/README.md` — new, documents component + build.

## Key files deleted / archived

- `packages/gui-server/` → `_archive/packages-gui-server/` (ARCHIVED.md written; DAI-18 below supersedes the VS Code-specific bundle).
- `packages/gui/vscode.html`, `packages/gui/src/hosts/vscode.tsx`, `packages/gui/test/unit/hosts/vscode.test.tsx` — DAI-18: simpler path chose iframe of `web.html`.
- `packages/gui/src/api/MapController.ts` — re-exports moved to `src/controller/`.

## DAI status (all 18 deferred items)

| # | Finding | Status |
|---|---|---|
| DAI-1 | viewStore.selection vs selectedIdx parallel representation | Completed (C-Canvas-refactor) |
| DAI-2 | `dataStore.ts` dynamic+static import warning | Completed (C-hosts) |
| DAI-3 | `cameraDistance=0` in 2D Sidebar readout | Completed (C-viewStore-mode) |
| DAI-4 | Click-selected-tile idempotent replace (behavior change) | Completed — flagged for 3-Review confirmation |
| DAI-5 | Tooltip shows `file:line` row (behavior change) | Completed — flagged for 3-Review confirmation |
| DAI-6 | Thin MapController re-export shim deletion | Completed (C-Canvas-refactor) |
| DAI-7 | `window.*` module-eval leak in mapStore | Completed (C-viewStore-mode) |
| DAI-8 | ESLint glob excludes `.tsx` in packages/gui/ | Completed (C-hosts) |
| DAI-9 | `Region.tiles` mapping for HullLayer | Completed (C-SceneManager) |
| DAI-10 | Canvas.tsx audited across all prior chunk edits | Completed (C-Canvas-refactor) |
| DAI-11 | FlowLayer line-style highlightEdges no-op | **Deferred — post-REG-1100** (tracked here) |
| DAI-12 | attachLayers before first setMode; lazy camera getters | Completed (C-Canvas-refactor) |
| DAI-13 | `sceneModesEqual` consolidated into `three/types.ts` | Completed |
| DAI-14 | ortho zoom → `mapStore.setZoom` OrbitControls change wiring | Completed (C-Canvas-refactor) |
| DAI-15 | rfdb-server HTTP port hardcoded (3335) — port conflict silent | **Deferred — post-REG-1100** |
| DAI-16 | mapPanel hardcodes db='default' | **Deferred — post-REG-1100** |
| DAI-17 | `grafema.openMap` auto-start rfdb-server | **Deferred — post-REG-1100 UX** |
| DAI-18 | `vscode.html` + `hosts/vscode.tsx` dead entry points | **Completed — Phase 9: deleted** |

## Skills extracted

- **`tsx-jsx-runtime-mismatch-vite-build-vs-test`** — captures the `void React;` workaround for React classic-runtime JSX under the `tsx` Node loader when Vite's automatic runtime handles it fine. Guards C-hosts and host-related tests.

## Open follow-up tasks (post-REG-1100)

- **DAI-15** — `--http-port 0` + lockfile discovery instead of hardcoded 3335.
- **DAI-16** — `grafema.databaseName` workspace config for multi-db.
- **DAI-17** — Auto-start rfdb-server when `grafema.openMap` runs but server is not up.
- **DAI-11** — FlowLayer 2D edge highlight (overlay layer or per-edge instanceColor diffs).

## Readiness

- [x] GUI tests green (235)
- [x] VS Code tests green (171)
- [x] rfdb-server tests green (static_ui, ui_routes, compile_without_ui)
- [x] `pnpm --filter @grafema/gui build` → `index.html` + `web.html` (no `vscode.html`)
- [x] Docs updated: CLAUDE.md "Serving the Map UI", packages/gui/README.md
- [x] gui-server archived; no functional references in packages/ scripts or CI
- [x] CI workflow updated (build-binaries.yml drops grafema-gui targets)

Ready for 3-Review (Steve ∥ Вадим auto ∥ Uncle Bob).
