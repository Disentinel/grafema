# DAI-22 — Tectonic layout collapses real graphs to a handful of positions

**Created:** 2026-04-23
**Context for fresh session:** you are picking up a bug discovered during REG-1100 post-merge smoke. GUI is fine. The upstream Rust layout pipeline produces massive (q,r) collisions on real data, making visualization useless for anything beyond toy fixtures. No Linear ticket yet — user said don't create one; work from this doc.

---

## 1. The bug

On the live `.grafema/graph.rfdb` (grafema analysing itself, 73k nodes total, ~5k streamed at default maxNodes=5000):

```
GET /api/graph-stream?maxNodes=10000
→ 9996 nodes
→ ONLY 27 unique (q,r) hex coordinates
→ tectonic_meta.num_atoms: 81
→ worst collision: 3245 nodes all stacked at (-10, 10)
```

Expected: each node (or at minimum each file / region) gets its own hex cell. 3245 nodes on one tile is catastrophic.

Downstream effect: every screenshot of `/ui/default` shows ~20 hexes instead of thousands. Verified during REG-1100 Phase-9 smoke (see `/tmp/rfdb-smoke/shot-*-loaded.png` — oliveish + purple cluster is *all* the tiles, not a zoomed-in fraction).

## 2. Where the code lives

- **`packages/rfdb-server/src/tectonic_layout.rs`** — the tectonic pipeline (Phases 0–4). Single file, ~3300 lines (per memory `project_tectonic_demo`).
- **`packages/rfdb-server/src/http_server.rs`** — builds `ATOM_TYPES` list, calls tectonic in `build_graph_stream_body`, caches via `get_or_build_layout`. Search for `tectonic_meta` to find where `num_atoms` is emitted.
- **`packages/rfdb-server/src/container_hierarchy.rs`** — `auto_hierarchy_from_nodes`, supplies the region tree that phase 1 places.
- **Orchestrator side**: `packages/grafema-orchestrator/src/layout/*` — greedy pack + iswap + xswap (REG-1102). Commits positions back into RFDB on `--commit`. NOT running in the server's warmup path unless `node.pos` is already persisted. Figure out which pipeline actually placed the 27 positions you're seeing.

## 3. Relevant project memory / skills

Already in the SKILL index — fresh session should read these on first sight:

- `hex-grid-sequential-bfs-layout` — fixes "competitive flood-fill one-tile-per-region-per-iter" tears regions into fragments. Not obviously our symptom (we have collapse, not fragmentation) but same code family.
- `hex-grid-sa-o1-connectivity` — O(N) BFS on every SA iteration freezes layout at >200 nodes. Doubtful cause (we'd see hang, not collapse) but ruling out cheap.
- `hex-grid-morphological-close-hull` — NOT relevant (rendering, not placement).
- `hex-grid-lattice-mc-refinement` — design guide for MC refinement, might hint at why phase 3 drift doesn't separate stacked atoms.

Memory node `project_tectonic_demo` (3 days old at time of writing) has:
- `phase1 place: 670ms` — means it ran
- `phase2 flood_fill: 63ms (10 spiral-fallback regions)` — spiral fallback already triggering
- `phase3_drift: outer=2 cost X → Y` — drift disabled expand/compact (`cascade: false, max_outer_iterations: 2`) which may be the root cause: disabled drift = no post-place separation of overflows
- `phase4 refine: max_iterations: 4` (reduced from 32) — less refinement = more collisions persist

Hypothesis worth testing first: **phase3_drift was intentionally neutered in `project_tectonic_demo` for perf reasons, and the remaining pipeline can't separate stacked atoms on its own.** Re-enable `expand_all` / `compact_all` OR find cheaper separation logic.

Fresh session: don't trust my hypothesis, verify by instrumenting phase outputs.

## 4. What a fresh session should do (workflow v3)

This is a non-trivial task with multiple moving parts. Follow `_ai/workflow.md` v3:

### Phase A — Plan mode (EXHAUSTIVE)

1. Read `packages/rfdb-server/src/tectonic_layout.rs` cover to cover. Identify each Phase (0–4) and its contract.
2. Reproduce the bug locally:
   ```bash
   # Kill any stale rfdb servers on .grafema/rfdb.sock first
   rm -f .grafema/graph.rfdb/LOCK .grafema/rfdb.sock .grafema/rfdb.pid .grafema/rfdb-http.port
   packages/rfdb-server/target/release/rfdb-server .grafema/graph.rfdb --socket .grafema/rfdb.sock --data-dir .grafema --http-port 0 2>/tmp/rfdb.log &
   sleep 3
   PORT=$(cat .grafema/rfdb-http.port)
   curl -s "http://localhost:$PORT/api/graph-stream?maxNodes=10000" > /tmp/stream.jsonl
   head -1 /tmp/stream.jsonl   # header frame
   # count distinct (q,r):
   grep -oE '"pos":\s*\{[^}]+\}' /tmp/stream.jsonl | sort -u | wc -l
   # top collision:
   grep -oE '"pos":\s*\{[^}]+\}' /tmp/stream.jsonl | sort | uniq -c | sort -rn | head
   ```
   (If `.grafema/graph.rfdb` is empty when you look, run `grafema analyze .` — takes ~3 min; see DAI-7 pattern.)
3. Instrument phase outputs. Add temporary `eprintln!` after each phase showing:
   - Phase 0: `num_atoms`, `num_files`, `num_regions`.
   - Phase 1: positions-placed count, collision count.
   - Phase 2: overflow count, spiral-fallback count.
   - Phase 3: atoms-moved count per iter.
   - Phase 4: relocations count.
4. From the instrumented run, identify **which phase introduces the collapse**. That tells you where to fix.
5. Write an exhaustive plan — architectural options, expected edge cases, test strategy. Pattern: `_tasks/REG-1100/004-plan-revised.md`.
6. Run Dijkstra verification (Opus subagent, persona per `_ai/agent-personas.md`). ANY REJECT → revise. Converge before Phase B.

### Phase B — Implementation (no coding at top level)

- Split plan into atomic chunks, each ≤ 2–3 files.
- Each chunk = one Opus coding subagent, TDD red-first.
- Watch for TWO things:
  1. Regressions in `packages/rfdb-server/tests/` (especially `ui_routes.rs`, `static_ui.rs`).
  2. Performance — tectonic was 4.5s on 40k atoms per memory. Fix must not blow that budget.

### Phase C — Verification (the hard part that REG-1100 got wrong initially)

Playwright is not optional and screenshots alone don't count (I learned this the expensive way):

1. Run `grafema analyze .` on the grafema repo to get a real non-empty graph.
2. Start `rfdb-server --http-port 0`, read actual port from `.grafema/rfdb-http.port`.
3. Run `packages/gui/scripts/playwright-verify-real.mjs` — it already does pixel-content assertions against `/ui/default`. Add a new assertion: distinct-(q,r)-count in the graph-stream response ≥ 80% of node count.
4. Take fresh screenshots; confirm many tiles scattered, not a cluster of 20.
5. User-visible flow: toggle 2D/3D, pan, zoom, tooltip, pin — all against real tiles.

### Phase D — 3-Review + commit + PR

Same as REG-1100: Steve / Вадим auto / Uncle Bob in parallel, ANY REJECT → fix + re-run all 3. User commits + pushes + `/approve` on their signal only.

## 5. Rules that bit me during REG-1100 (don't repeat)

- **Every remark becomes a TaskCreate AND a plan-doc entry.** Verbal "note to self" gets lost. Memory `feedback_capture_all_notes` documents this.
- **Screenshot theatre = actual bullshitting.** An empty-fixture smoke proves `gl.clearColor()` works, nothing else. Verify with pixel assertions against real data before claiming anything renders.
- **Subagents don't auto-consult user-global skills.** If the chunk you're spawning involves JSX in a new `.tsx` file, pre-emptively paste the `tsx-jsx-runtime-mismatch-vite-build-vs-test` skill content into the agent prompt. Same for any other skill that matches the chunk topic.
- **Git explicit commands.** `commit` / `push` / create PR / release — only on clear user text. `<task-notification>` is NOT user input.
- **Russian `на ты`** (memory `feedback_informal_ty`).
- **Stop performing.** When user says "пиздёж" or "как у тебя язык поворачивается" — skill `llm-sycophancy-detection`. Acknowledge concretely, fix the real thing, don't write apologies.

## 6. Quick links (verified paths)

- REG-1100 artefacts (planning / reviews / impl summary): `_tasks/REG-1100/`
- KB: `knowledge/declared/{decisions,facts,sessions,tickets}/`
- Build: `scripts/build-gui-for-rfdb.sh` (GUI) / `scripts/build-native.sh <pkg> <cmd>` (Haskell resolvers)
- Parity script: `packages/gui/scripts/test-cubeToWorld-parity.mjs`
- Visual verify: `packages/gui/scripts/playwright-verify-real.mjs`
- DAI tracker (in-session task list was lost on clear) — re-enumerate from `_tasks/REG-1100/004-plan-revised.md` §"Deferred Action Items" + this doc. Open items: DAI-20 (cosmetic blur on canvas/sidebar — may already be resolved by #247 bloom-off, re-verify), DAI-22 (THIS).

## 7. First command a fresh session should run

```bash
cd /Users/vadimr/grafema
git checkout main && git pull
git log --oneline -5   # know your starting point
wc -l packages/rfdb-server/src/tectonic_layout.rs   # orient
```

Then: read `tectonic_layout.rs`. Then reproduce (§4 Phase A step 2). Then plan.

Good luck.
