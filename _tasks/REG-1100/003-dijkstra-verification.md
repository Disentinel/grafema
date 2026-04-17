# Dijkstra Verification — REG-1100

**Date:** 2026-04-17
**Reviewer:** Dijkstra (Opus 4.7, via general-purpose subagent)
**Verdict:** **REJECT** (3× P1 gaps + 5× P2 gaps)

---

## Strengths

- Correctly identifies MapController as already-renderer-agnostic; extraction is minimal.
- C1 (fix broken iframe) as standalone commit unblocks VS Code regression.
- Cargo `ui` feature + `--static-dir` override is a sound separation of concerns.
- Chunking is generally atomic (2–3 files per chunk).

## Gaps requiring revision before implementation

### P1-a: Hull strategy is factually wrong

Plan §3.4 + §5 says `geom/hull.ts` will be "morphological close, shared by both renderers". But:
- `packages/gui/src/components/Canvas.tsx:95-114` explicitly **disables** HullLayer: "O(tiles² × levels) on real-project graphs. At 15k+ tiles × 5 levels it hangs the main thread for tens of seconds."
- Sandbox `hull.js:1-50` is NOT morphological close — it's **exact-boundary trace**.
- Canvas2D at 40k tiles will hit the same O(tiles²) wall.
- The skill `hex-grid-morphological-close-hull` cited is for a different use case.

**Required:** plan must decide — port GPU fragment-shader path for 3D (commented as "future work"), OR adopt sandbox's exact-boundary trace for both renderers (which is NOT morph close). Re-specify.

### P1-b: Module-mutable singletons break renderer swap

`packages/gui/src/components/Canvas.tsx:26-28` and `Sidebar.tsx:10,23` couple UI panels to THREE layer singletons via exported `let flowLayerRef`, `setShowCoordsRef`. When `<HexAtlas mode>` unmounts THREE renderer and mounts Canvas2D, `flowLayerRef` is stale — Sidebar's `toggleFlow` calls `flowLayerRef?.setFlowVisible()` against a disposed object.

**Required:** add new chunk before C12 — route flow visibility through Zustand + `Renderer.setFlowVisible(name, visible)`, delete `flowLayerRef` export.

### P1-c: Scale mismatch — "30fps at 10k tiles" is below real scale

Tectonic pipeline operates on **40k atoms** (per `tectonic_layout.rs` + user context). Sandbox `render.js` (568 lines) was never benchmarked at 40k; Canvas2D per-tile stroke+fill at 40k is typically 200–400ms/frame. §10 mitigation ("fall back to three.js ortho") isn't in the chunk plan — there is no fallback renderer implemented.

**Required:** either (a) benchmark before committing to Canvas2D in C9 (autonomous decision in §2 row 1 is premature), or (b) scope C9 as "prove 10k/40k perf first, rewrite interface if ortho wins".

### P1-d: VS Code webview CSP not handled

`mapPanel.ts:191` sets only `enableScripts: true, retainContextWhenHidden: true` — no `localResourceRoots`, no explicit CSP. Webviews get an auto-generated CSP by VS Code that blocks `http:` by default on recent VS Code versions. Plan E4 says "on reload, re-query rfdb port" but doesn't set `<meta http-equiv="Content-Security-Policy">` allowing `frame-src http://localhost:*`.

**Required:** add CSP meta tag handling to C16 or new C0.

## P2 gaps (non-blocking but should be fixed)

### C14 is three chunks in a trenchcoat
`rust-embed` dep + `build.rs` + route handler + SPA fallback + CorsLayer interaction + Cargo feature toggle = at least 4 atomic commits. Test list §8.5 has 5 assertions; **none verify `cargo build --no-default-features` compiles**.

**Split:**
- C14a: Cargo feature + `build.rs` + placeholder
- C14b: `static_ui.rs` + `RustEmbed`
- C14c: routes + SPA fallback + CorsLayer

### Sibling search incomplete
Missing from §5:
- `packages/gui/server.js:73` has its own `cubeToWorld` (Node.js) — plan says "keep" but doesn't deduplicate or mark it as drifting.
- `packages/gui-server/src/hex_layout.rs` exists — this was the Rust `grafema-gui`'s own layout; plan archives the binary but never audits whether VS Code retargeting (C16) covers feature parity with what gui-server was serving.
- `loadStream.ts` (267 lines) mutates `dataStore` directly. §3.2 says "minor refactor" but doesn't specify: who calls `setState({nodes, edges, regions, loaded})` after layoutClient extracts? **Bootstrap start-point is undefined.**

### Invariant §7 understated
There IS one load-bearing Datalog-worthy invariant:

```datalog
violation_panel_imports_renderer(P) :-
  node(P, "MODULE"), attr(P, "file", F),
  starts_with(F, "packages/gui/src/components/"),
  edge(P, R, "IMPORTS_FROM"),
  attr(R, "file", RF),
  starts_with(RF, "packages/gui/src/three/").
```

Without this guarantee, the renderer abstraction rots the moment someone adds a `<NewPanel>` that imports `THREE`.

### Missing edge cases
- `--static-dir` + feature `ui` enabled: precedence undefined (plan §3.7 says "overrides embedded" but no test in §8.5).
- `GRAFEMA_UI_DIST` path race: `cargo:rerun-if-env-changed` fires only on env var change, not on dist contents change. Two `cargo build` without `pnpm build` in between gets stale embed.
- MapController `flyTo` reads `target.x, target.z` (MapController.ts:39). Canvas2D world coordinates are 2D — plan never specifies whether 2D renderer uses `(x, z)` or `(x, y)`. If `z → y`, all shared pure-logic tests break.
- Concurrent mode toggle during layout-loading: AbortController in E2 only covers fetchLayout; doesn't cover the renderer init race (E6 mentions `currentRendererToken` for renderer, but not for layout promise interleaving). Two aborts needed, plan has one.

## Nice-to-have (not blocking)

- Visual regression test via Playwright screenshot per mode.
- Cargo test `tests/feature_off.rs` with `#[cfg(not(feature = "ui"))]` asserting the binary compiles and `/ui/*` returns 404.
- `rust-embed` MSRV check.

## Recommended chunk re-splits

- **C9 → C9a/C9b:** C9a = perf baseline + decision commit; C9b = hex+hull minimal viable.
- **C14 → C14a/C14b/C14c** as above.
- **New C-singletons** (before C12): remove module-mutable layer refs, route through Zustand + Renderer interface.
- **New C0** (before C1): CSP audit/fix for VS Code webview.
- **Move C18** (archive gui-server) to after user signoff on parity — not bundled with C16.

---

**Three P1 gaps (hull strategy, module singletons, scale mismatch) are load-bearing. REJECT.**
