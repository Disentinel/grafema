# Streaming-overhaul plan — rfdb HTTP graph stream

**Goal:** make `/api/graph-stream` deliver a usable map within ~1 s on the
grafema repo (27149 placed nodes / 329k total stream messages / 105 MB raw),
keep the browser interactive throughout, and not melt the parser. Five phases
landing as separate atomic commits, each gated by regression tests
(unit + integration) and Playwright (visual + responsiveness).

Branch: `task/dai-22-per-symbol-layout`. Each phase rebases on the previous.

## Status

| # | Phase | Status |
|---|---|---|
| 0 | gzip/brotli `CompressionLayer` on outer router | ✅ commit `489a3dee` — wire 105 MB→14.3 MB (7.3×) |
| 1 | Server-side hull precompute + early-frame emit | pending |
| 2 | Drop excluded-node frames, batch as one tail | pending |
| 3 | LOD-bucketed streaming (depth-prioritised) | pending |
| 4 | String-table interning (file/region/reason) | pending |
| 5 | Binary stream for hot frames (MessagePack / typed arrays) | pending |
| 8 | Playwright harness — verifies all of the above | pending (foundation) |

---

## Conventions

- Every phase = ONE commit with header `perf(rfdb|gui): phase N — <slug>`
- Every commit must:
  1. Build green (`pnpm build`, `cargo build --release`)
  2. Pass new tests AND existing tests on touched crates
  3. Bake bundle into rfdb-server, restart, smoke-test the stream
- Use `apply_compression` test harness pattern from Phase 0 for new HTTP-level tests
- Don't break the no-precompute / no-batched / no-bucketed back-compat paths in
  the GUI — older server builds should still work for at least one phase
- Update this file at the end of each phase (Status column + lessons learnt)

---

## Phase 1 — server-side hull precompute + early-frame emit

**Scope.** Compute per-region hull polygons in Rust during warmup, emit them
as a `hulls` frame right after `header` in `/api/graph-stream`. GUI consumes
the frame, hydrates `hullCache` from it instead of re-computing client-side,
unlocks hull/toponym render the moment the frame arrives — well before the
node/edge tail.

**Server.**
- New module `packages/rfdb-server/src/hulls.rs` — port of:
  - `packages/gui/src/geom/hull.ts` (boundary trace) → `compute_hull_polygons(tiles, hex_size)`
  - `packages/gui/src/hulls/computeHulls.ts` (morph-close + flood-fill + descendant aggregation) → `compute_hulls_for_regions(layout, tree)`
- Cache as new `HttpState.hull_cache: Arc<RwLock<Option<HashMap<u128, Vec<HullLoop>>>>>`
- Populate during `warmup` after `cached_layout` is loaded
- New emitter `emit_hulls_frame(&mut lines, &hulls, &cached_layout)` — one frame, regions inlined as `{rid, polys: [[[x,y],[x,y],...], ...]}`
- Wire into `build_graph_stream_body` between header and node loop
- Skip frame entirely when hull cache is empty / layout missing (back-compat)

**GUI.**
- `packages/gui/src/store/loadStream.ts`: new `HullsMsg` type; collect
  `precomputedHulls: Map<regionId, Polygon[]>` on the `LayoutResult`
- `hydrateLayoutStoreFromLayout`: prefer `precomputedHulls` if present;
  fall back to client-side `computeHullsForRegions` when absent
- **Incremental render path:** `parseStream` exposes a `onHulls` callback that
  fires immediately when the hulls frame arrives. Caller (web bootstrap) hydrates
  `layoutStore.regionTree` + `layoutStore.hullCache` early, lets React
  re-render hulls + toponyms before the rest of the stream completes
- This requires splitting `loadStream` into "header+hulls bootstrap" and
  "node/edge tail" phases — a meaningful refactor

**Tests.**
- Rust unit: `compute_hull_polygons` — single hex, two adjacent, ring with hole
  (matches sandbox / gui test cases from `packages/gui/test/unit/geom/hull.test.ts`)
- Rust unit: `compute_hulls_for_regions` — morph-close fills 1-cell gaps,
  disjoint islands emit multiple loops, root region aggregates descendants
- Rust integration: `/api/graph-stream` emits a `hulls` frame whose region
  count == `cached_layout.regions.len()` (minus zero-symbol regions)
- TS unit: `parseStream` consumes hulls frame → `precomputedHulls` populated
- TS unit: `hydrateLayoutStoreFromLayout` uses `precomputedHulls` when present,
  computes when absent (regression for back-compat)

**Playwright.**
- Time-to-first-hull: from `fetch('/api/graph-stream')` start to `<canvas>`
  showing > 100 hull polygons → assert < 1500 ms
- Toponyms visible at the same checkpoint
- After hulls visible, pan + zoom in input → no missed frames > 50 ms over 2 s
  window (CDP `Performance.metrics`)
- All 27149 nodes eventually present (assert via debug global)

**Success criteria.**
- Live curl confirms `hulls` frame in first ~1 KB of `/api/graph-stream`
- Browser shows hulls + toponyms in < 1 s after navigation start
- Pan / zoom / hover all work BEFORE node tail finishes streaming
- Existing tests still green; no back-compat regression

---

## Phase 2 — drop per-frame excluded-node messages

**Scope.** Server stops emitting one `node` frame per excluded symbol; instead
batches them as one `excluded_nodes` frame at the tail with array of
`{id, type, name, file, region, degree, reason}`. GUI parser routes the
batch into `unplacedNodes`. Wire size ÷5 on this corpus.

**Server.**
- `build_graph_stream_body`: split `candidates.node_refs` into placed +
  excluded-by-server passes; loop only over placed for individual frames
- New emitter `emit_excluded_nodes_frame(&mut lines, excluded)` after
  `nodes_done`
- Wire format: `{type:"excluded_nodes", nodes:[{id,t,n,f,r,d,reason}]}` —
  short field names because this batch is the heaviest single message

**GUI.**
- `loadStream.ts`: new `ExcludedNodesMsg` type, drop the per-message
  `unplaced_reason` branch in the loop (or keep it as legacy back-compat)
- `parseStream` populates `unplacedNodes` from the batch
- Verify search / tooltip on excluded nodes still works (they're surfaced via
  the same `unplacedNodes` shape — only the wire path changed)

**Tests.**
- Rust integration: stream contains at most ONE `excluded_nodes` frame, and
  zero `node` frames with `unplaced_reason != null`
- Rust integration: excluded count in batch == server-side excluded count
- TS unit: parser legacy path (no batch frame, per-node `unplaced_reason`)
  still works for older-server back-compat
- TS unit: parser new path populates `unplacedNodes` identically

**Playwright.**
- Same time-to-first-hull as Phase 1 (excluded batch shouldn't slow it)
- Stream-byte-count assertion: gzipped stream < 5 MB after Phase 2 (was 14 MB
  after Phase 0)
- Excluded-node search still finds expected node by id

**Success criteria.**
- Wire size further ÷4-5 (gzipped stream ≤ 5 MB)
- Parser visibly faster (fewer JSON.parse calls — measure in Playwright)
- No regression in unplaced-node search / overflow badge

---

## Phase 3 — LOD-bucketed streaming (depth-prioritised)

**Scope.** Server emits nodes in depth-bucketed frames so the GUI renders
shallow regions first (visible at fit-all zoom), deep regions later. User
pan/zoom can interrupt deep buckets via AbortController. Edges follow the
same bucketing — emitted only when both endpoints are in already-streamed
buckets (deferred otherwise).

**Server.**
- Map each placed node to its region's depth (from `cached_layout`)
- Group into buckets: 0-1 (shallow), 2, 3, 4, 5+ (deepest)
- Emit `nodes_bucket` frames in depth order with metadata
  `{type:"nodes_bucket", depth, count, nodes:[...]}`
- Edges similarly: `edges_bucket` frames with `min_depth` / `max_depth`,
  emitted after both endpoints' depth buckets have been emitted
- Server respects abort: if client closes the connection mid-stream, stop

**GUI.**
- `parseStream`: replace single-pass collection with per-bucket dispatch.
  Each `nodes_bucket` arriving triggers `onBucket(depth, nodes)` callback
- `HexLayer.appendNodes(nodes)` — new API to grow the instanced mesh in place
  (currently it's allocated to fixed `count` at construction)
- `FlowLayer.appendEdges(edges)` — same for tubes
- Web bootstrap wires `onBucket` to incremental hydration

**Tests.**
- Rust integration: stream contains buckets ordered by depth ASC
- Rust integration: aborting the connection mid-bucket triggers clean
  shutdown (no panic, no leaked task)
- TS unit: `HexLayer.appendNodes` grows instance buffer correctly
- TS unit: `FlowLayer.appendEdges` adds tubes to existing slot
- TS integration: simulated stream with three buckets — final node count ==
  sum of bucket counts

**Playwright.**
- Progressive node fill-in observable: at t=1s see N0 nodes, at t=3s see N1 >
  N0, at t=5s see all nodes — assert monotonic growth
- During streaming: pan camera 200 px → < 50 ms frame budget
- Aborted scroll mid-stream: server log shows clean disconnect

**Success criteria.**
- Map functional from t≈1 s with shallow nodes; deep nodes fill in over the
  next few seconds
- User pan/zoom never blocked by node ingest
- No memory leak in HexLayer/FlowLayer when streaming is aborted

---

## Phase 4 — string-table interning

**Scope.** Header gains `fileTable[]`, `regionTable[]`, `reasonTable[]`.
Per-node messages reference indices instead of full strings. Reduces
uncompressed wire size another 2-3×; even after gzip, less string copying
on the parser side.

**Server.**
- `emit_header_frames`: populate the three tables from `candidates.node_refs`
  / `cached_layout.regions` / a fixed reason set
- `emit_node_line`: use `f`, `r`, `rs` short names referencing indices
  (e.g. `"f": 17` instead of `"file": "packages/.../foo.ts"`)
- Bump a stream-version field in header so the parser can negotiate

**GUI.**
- `loadStream.ts`: read tables from header, resolve `file`/`region`/`reason`
  on the fly when building `GraphNode`. Type `NodeMsg` gains optional `f`,
  `r` (indices) alongside existing `file`, `region` (strings, legacy fallback)

**Tests.**
- Rust integration: header carries non-empty `fileTable` / `regionTable`,
  per-node `f` index resolves to the same string through `fileTable[f]`
- TS unit: parser resolves indices when present, falls back to legacy strings
  when absent

**Playwright.**
- Same suite as Phase 0-3, no regression
- Stream-byte assertion: gzipped < 3 MB

**Success criteria.**
- Wire ÷2 vs Phase 2; parser CPU drop measurable in Playwright timing

---

## Phase 5 — binary stream for hot frames

**Scope.** Convert per-node + per-edge frames to MessagePack for parse-CPU
gains. Header stays JSON (hand-readable, tooling-friendly). Nodes + edges go
binary. Hulls stay JSON for now (low frequency, complex nested shape).

Decision: full MessagePack vs hybrid (binary edges, JSON nodes)? Default to
full MessagePack; benchmark before committing.

**Server.**
- New emitter that writes a length-prefixed MessagePack message per node /
  edge. Need a way to mix text (header, hulls, layout_meta) and binary in
  one HTTP body — use a magic-byte prefix per frame, or switch to binary
  framing throughout (Content-Type changes)

**GUI.**
- `parseStream` switches to binary chunk reader; uses `@msgpack/msgpack` (or
  hand-rolled minimal decoder for the small shape we need)

**Tests.**
- Rust unit: round-trip MessagePack encode/decode of a representative node
  matches JSON shape
- TS unit: decoder produces same `GraphNode` as the JSON path

**Playwright.**
- Parser CPU time < half of Phase 4
- Total time-to-all-nodes-rendered metric improves visibly

**Success criteria.**
- Stream size further down (MessagePack overhead ≪ JSON repeated keys)
- Parser CPU cut ~½, freeing the main thread during ingest

---

## Phase 8 (parallel) — Playwright harness

**Scope.** Reusable harness for verifying every phase visually + perf-wise.
Lives at `packages/gui/test/playwright/streaming-phases.spec.ts`.

**Suite.**
- `t≤1500ms hulls visible` — render-time gate for Phase 1+
- `t≤1500ms toponyms visible` — same
- `pan responsiveness during streaming` — 60 fps (or > 30 fps with > 95th)
- `zoom responsiveness during streaming` — same
- `progressive node growth` — Phase 3+
- `total nodes eventually loaded` — invariant for all phases
- `unplaced nodes searchable` — Phase 2+
- `gzipped stream size budget` — declarative byte budget per phase

**Infra.**
- Playwright config uses CDP profiling for accurate fps
- Each phase update can tighten the budget assertions
- Run as `pnpm --filter @grafema/gui playwright test streaming-phases`

---

## Working notes (append per phase)

### Phase 0 — done
- gzip ratio on grafema corpus: 7.3× (raw 105 MB → 14.3 MB)
- tower-http compression layer chosen over manual `flate2` plumbing — it
  handles content-type allowlisting + size threshold automatically
- `derive_workspace_name` got a current_dir fallback for relative-path
  edge cases — kept guarded so bare filenames still return None
- Test harness pattern: `spawn_server_compressed` wraps the regular UI
  router with `apply_compression`; future phases can extend this for
  scenario-specific tests

### Phase 1 — TBD

### Phase 2 — TBD

### Phase 3 — TBD

### Phase 4 — TBD

### Phase 5 — TBD

### Phase 8 — TBD
