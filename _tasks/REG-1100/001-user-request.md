# REG-1100 — User Request

**Date:** 2026-04-17
**Branch target:** `main` (gui merged into main via commit `f80b3ede`)
**Linear:** https://linear.app/grafemadev/issue/REG-1100

## User's words (verbatim, condensed)

1. Merge `gui` into `main`, continue development on `main`.
2. Archive stale artifacts (do not delete).
3. Produce a single map component with a runtime **2D ↔ 3D switch** and shared view controls (flows/links, routes, etc.).
4. Integrate into **VS Code extension** (already has `mapPanel.ts`, currently points to a legacy HTML that was just moved to `_archive/`).
5. Ship as a **visualization feature served by `rfdb-server` itself** — HTTP UI for a specific database, served directly by the Rust binary (no separate gui-server process).

## Derived acceptance criteria (updated in Linear)

- One `layout()` client call (wraps server) yields identical coordinates consumed by both 2D and 3D modes.
- `<HexAtlas mode="2d">` and `<HexAtlas mode="3d">` share every control (flows/routes/lenses/diff/pins/search). Toggling mode preserves selection/hover/zoom.
- No duplicated LOD/zoom or selection/hover logic between renderers.
- `rfdb-server --http-port N` serves the UI at `http://localhost:N/ui/{db}`.
- VS Code command `Grafema: Open Map` opens the webview pointed at the active workspace's `rfdb-server`.

## Out of scope (tracked separately)

- SA/layout tuning — REG-1102
- Publishing as `@grafema/hex-atlas` npm package — REG-1101

## Pre-task housekeeping already done in this session

- `gui` merged into `main` (merge commit `f80b3ede`), preceded by committing WIP on both branches (4 commits total).
- `packages/gui/legacy/` → `_archive/gui-legacy-civmap/` via `git mv`.
- **Collateral damage noted:** `packages/vscode/src/mapPanel.ts:321` references `${GUI_HOST}/hex-topology.html`, which was just archived. VS Code map panel is currently broken. Fix is part of this plan.
