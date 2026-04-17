# Dijkstra Verification #2 — REG-1100

**Date:** 2026-04-17
**Reviewer:** Dijkstra (Opus 4.7)
**Target:** `004-plan-revised.md`
**Verdict:** **REJECT** (3 new P1 from ortho-camera switch + chunking conflicts + P2)

## Prior gaps — all resolved

1. Hull strategy: **RESOLVED** — exact-boundary trace, HullLayer re-enabled.
2. Singletons: **RESOLVED** — C-singletons deletes all 4.
3. Scale mismatch: **RESOLVED** — Three.js ortho reuses proven pipeline.
4. CSP: **RESOLVED** — explicit meta tag in C0.
5. C14 split: **RESOLVED** — C14a/b/c with feature-off compile test.
6. Sibling search: **PARTIAL** — `.mjs` export vs parity test still "either/or" (§2.3). Decide one.
7. Datalog invariant: **RESOLVED** — panels→three ban, error severity.
8. Edge cases: **RESOLVED** — dual-abort, precedence, env-change, coord lock.

## NEW P1 gaps introduced by Q2=b switch

### P1-new-1: Ortho LOD math broken
`controller/lod.ts` (C2) specified as `lodFromZoom(distance, viewport)`. OrthographicCamera has no meaningful `.position.distanceTo(target)` — it has `zoom` and frustum size. `Canvas.tsx:58` currently reads `scene.getCameraDistance()`. Plan §2.1 extracts lod "as is" without redefining for ortho.

**Fix:** C2 signature becomes `lodFromView(view: { kind: 'perspective', distance: number } | { kind: 'orthographic', zoom: number, frustumHeight: number }) → level`. Labels.tsx and SceneManager.getCameraDistance call sites listed in C2.

### P1-new-2: `flyTo` semantics undefined for ortho
`SceneApi.flyTo(x, z, ms?)` is the only camera API. Current `SceneManager.flyTo` uses `camera.position.set(x, y=distance, z)` — ortho ignores y for projection. Ortho flyTo must animate `camera.position` (pan) AND `camera.zoom` independently.

**Fix:** `packages/gui/src/three/SceneManager.ts` `flyTo` enumerated in C-mode file list. C-mode test covers both camera branches.

### P1-new-3: Mouse-picking raycaster + OrbitControls target axis
Current picker/raycaster + OrbitControls `target` assume perspective. `enableRotate: false` (E22) doesn't fix cursor-to-world unprojection.

**Fix:** C-mode explicitly edits raycaster setup + OrbitControls config for ortho.

## P2 gaps (non-blocking but required)

- **viewStore.mode idempotency**: fast toggles re-trigger setMode. Fix: setMode bails if incoming === current; OR store `kind: '2d'|'3d'` and derive config.
- **HullLayer batching**: 2500 region-level computations (~500 files × 5 levels). Fix: batched compute via idle callback / Web Worker / yieldy generator.
- **cubeToWorld parity range**: E19 = q,r ∈ [0..10], 121 points. Real data has q/r hundreds/thousands, negative values. Fix: sweep ±200, include negatives.
- **SceneMode non-exhaustive**: missing fog/background, cameraUp axis, label-tier toggles, flow density. Fix: enumerate OR version discriminator.
- **build-gui-for-rfdb.sh silent failure**: `cargo:warning=` easy to miss. Fix: placeholder index.html with visible "UI NOT BUILT" banner + CI check.
- **Re-export shim undefined (§2.1)**: "delete (after re-export shim if needed)". Fix: commit to no shim, list call-site migrations.
- **SceneApi surface "extended as needed"**: scope creep. Fix: enumerate now from actual panel needs.

## Chunking conflicts

- **C-hull + C-singletons + C-mode all edit `Canvas.tsx`.** Three chunks, same file = merge hell. Fix: strict sequence C-singletons → C-hull → C-mode with explicit partial-diff boundaries, OR merge into one C-Canvas-refactor chunk.
- **C0/C16 CSP-vs-retarget split ambiguous** (§2.8 says "C0 + C16 merged" but chunking table lists them separately). Fix: pick one.
- **C-archive depends on C14c, not C16.** Archiving gui-server before VS Code retarget breaks running code path in mapPanel. Fix: C-archive depends on C16.

## Verdict

3 new P1 gaps + chunking contradictions require another revision. REJECT.
