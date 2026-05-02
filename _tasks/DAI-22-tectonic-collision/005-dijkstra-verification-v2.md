# DAI-22 — Dijkstra Plan Verification v2 (second pass)

**Verdict: REJECT** — four NEW gaps in the revision block acceptance. One is CRITICAL (leaf-id decoupling in `FolderTree` breaks `pack_folder` semantics). Fix these and resubmit for v3; on v3 I will approve if the Critical gap is closed.

v1 had 12 completeness tables, 6 blocking gaps, 3 preconditions. Revision addresses most of them. Remaining gaps are narrower and fixable with small plan edits — not a restructuring.

---

## Status of v1 tables

| # | Topic | v1 verdict | v2 status | Evidence in v2 |
|---|-------|-----------|-----------|----------------|
| 1 | Symbol-type include/exclude | REJECT | **CLOSED** | §3 A.1 `PLACEABLE_TYPES` adds CONSTANT/TYPE_ALIAS/TYPE_SYNONYM/DATA_TYPE/IMPL_BLOCK/MACRO/NAMESPACE/PROCESS/MESSAGE_TYPE/ASYNC_FUNCTION; `EXCLUDED_TYPES` explicitly lists HEX/REGION/HASKELL_GLOBAL/GLOBAL; defensive `semantic_id` virtual-prefix skip. VARIANT exclusion rationale spelled out. TYPE_CLASS now included. |
| 2 | Liftable edge list — exclude LAYOUT_POSITION | REJECT | **CLOSED** | §3 A.1 explicit exclude list names `LAYOUT_POSITION, CONTAINS, DECLARES, HAS_*, RESOLVES_TO, REFERENCES`. ASSIGNED_FROM / IMPLEMENTS / EXTENDS / INHERITS_FROM / BROADCASTS_TO / HANDLES_VARIANT / THROWS / CATCHES added. |
| 3 | Path-collision safety — `/` in semantic id | REJECT | **CLOSED** | §3 A.2 switches to option (i) — new `build_from_paths_with_leaves(NodeIdx, folder_path, leaf_id)`. Leaf id is opaque, not split. §3 A.1 defensive filter carries `file.ends_with('/')` DIRECTORY sentinel. |
| 4 | LAYOUT_POSITION re-commit lifecycle | REJECT | **PARTIAL** | §3 A.4 adds delete-pre-pass via new RPC `delete_edges_by_type_and_source`. q/r fallback on missing metadata handled in §4 B.2 table. Idempotency test required. See Table 13 below for concerns with the RPC shape. |
| 5 | REGION node lifecycle | REJECT | **CLOSED** | §3 A.4 `delete_nodes_by_type_and_source` plus `_source: "layout-pack"` filter. URL-encoded path in `REGION::<depth>::<path>` closes `:`/`/` collision subgap. |
| 6 | Warmup failure modes | REJECT | **CLOSED** | §4 B.2 adds full error-recovery table (9 rows). Explicit fail-loud for cycles; skip-with-warn for parse errors; dup edges → "take first, warn; fail above threshold". |
| 7 | `pos: null` taxonomy | REJECT | **CLOSED** | §4 B.3 adds `unplaced_reason` discriminator: `"excluded" / "missing_layout" / "skipped_overflow" / null`. |
| 8 | LOD depth mapping | REJECT | **CLOSED** | §5 C.3 formula `depthNorm = region.depth / max(1, D_max)`; `D_max<9` fallback (≥3 bands); `D_max≥15` clamp (12 bands); size-based hiding via `pixelThreshold`. |
| 9 | Hull computation algorithm | REJECT | **PARTIAL** | §5 C.2 inlines dilate/erode/boundary-walk. Disjoint cells → multiple polygons. Rings → holes dropped (stated). **Still implicit:** tooltip/selection behavior across multi-polygon hull ("tooltip/selection hits any of them" — does hover on gap area hit nothing or the parent hull?). Minor. |
| 10 | Performance gates | REJECT | **PARTIAL** | §0 recomputes target: **35k leaves, not 328k**. §3 A.3 splits into A.3a (measured) + A.3b (mitigations). A.3a reports synthetic-30k benchmark (159s — blows budget) with reasoning that real hierarchy is deeper (K≈28 not 275) → ≈4-5s projected. **Still unproven on real loader output.** §3 A.3 correctly flags "must be validated against real loader output in Chunk-3". Acceptable as an early bench + gate; see Table 18 for precise wording concerns. |
| 11 | Playwright coverage | REJECT | **CLOSED** | §6 D.3 adds: 2D⇄3D toggle, page reload persistence, keyboard (`Space`/`Esc`/`+`/`-`), context menu, red-badge assertions, empty-layout overlay, missing-layout graceful mode, idempotency rerun. |
| 12 | File deletion scope | REJECT | **CLOSED** | §4 B.1 names every file: `http_server.rs`, `tectonic_layout.rs`, `lib.rs`, `bin/rfdb_server.rs`, `gui/src/store/loadStream.ts`, `vscode/src/mapPanel.ts`, and a grep-confirmation gate in Chunk-5 with exact commands in §10 Appendix. |

**Tally: CLOSED 9, PARTIAL 3, STILL OPEN 0.**

Preconditions:
1. Skill content missing — **not addressed explicitly** but §5 C.2 inlines the algorithm, so skill reference is no longer load-bearing. Effectively CLOSED.
2. 30s budget unverified — **PARTIAL** (A.3a ran on synthetic; real still pending in Chunk-3).
3. Re-commit lifecycle broken upstream — **CLOSED** (Chunk-0 RPC additions).

---

## NEW gaps introduced by the revision

### Table 13 — Chunk-0 RPC design (`delete_{edges,nodes}_by_type_and_source`)

| Question | Addressed in v2? | Risk |
|----------|------------------|------|
| `_source` match semantics: exact-string, substring, JSON-key-equality? | **NO** — plan says `metadata._source == Y` but current metadata is a string blob (`_source: "layout-pack"` appears in §A.4 as flat JSON). `handle_commit_batch` uses `find_by_attr` on `file` — no `metadata_key/value` query path exists today. | The new RPC must add a metadata-key predicate into the attr index or do an O(N_type) scan. Plan doesn't state the index story. |
| Multiple passes with same (type, source) but different semantics in future | **NO** — one `source_tag` is too coarse if, e.g., an iswap-only re-run wants to preserve xswap positions. | Acceptable now (single layout source), but plan should reserve a path (e.g. `source_tag + sub_tag`) or state "single-source only, fail if two sources". |
| Transaction boundary: delete succeeds → crash → no write | **PARTIAL** — §8 Risks mentions "Acceptable (rerun fixes it), but document". That wording is fine but belongs in A.4, not a risk footnote. | Minor. |
| Index / perf — O(N_type) via `get_edges_by_type` vs O(N_all_edges) scan | **NO** — `get_edges_by_type` exists (confirmed at `engine_v2.rs:648`, used heavily in datalog eval). Plan should require the new delete path to reuse that index. 35k LAYOUT_POSITION edges × O(1) index lookup = fine; 632k-edge full scan = ~seconds. Plan must pin the fast path. | Moderate. Without pinning, first impl could use slow scan. |
| Partial delete on crash mid-iteration | **NO** — not addressed. | For 35k edges probably fine; document recovery (subsequent commit re-runs pre-pass, clears orphans). |

**Required edit:** A.4 must state (a) the RPC uses `get_edges_by_type(edge_type)` → filter by `metadata` substring match on `_source`, (b) atomicity is delete-then-write in a single RFDB request (or explicitly "two-request, recovery by rerun"), (c) fail-loudly if `source_tag` collision is ever detected with a different writer.

### Table 14 — VARIANT exclusion impact

| Question | Addressed? |
|----------|-----------|
| Can users still navigate to a specific variant? | **NO** — plan excludes VARIANT from placement; §5 C.5 says search exists, but the stream treats VARIANT as `unplaced_reason: "excluded"` → "GUI silently hides from atlas". Click-to-navigate path from external link / search is undefined. |
| Orphaned inbound edges? | **NO** — any CALLS/READS_FROM with `dst ∈ VARIANT` is dropped by the liftable-skip-if-endpoint-not-placeable rule (A.1 end). That's fine for cohesion signal, but the layout layer loses information. Plan should note it and quantify ("Haskell has 228 VARIANTs — N edges inbound, dropped from cohesion signal"). |
| Haskell `Just`/`Nothing` cross-analyzer consistency | **NO** — plan doesn't check whether TS/Rust/Python emit VARIANT for enum members. Quick check: Rust has `VARIANT 228`; if the TS analyzer never emits VARIANT, the exclusion is de facto Rust-only and "visual noise" rationale doesn't generalize. |

**Required edit:** A.1 VARIANT-exclusion paragraph must (a) name expected consequence for inbound edges (drop count estimated), (b) confirm all language analyzers emit the same type name. If not uniform, exclusion is language-specific bias.

### Table 15 — Hard-cap degree ordering

| Question | Addressed? |
|----------|-----------|
| Which edge types count toward "degree"? All edges, or the liftable subset? | **NO** — §3 A.6 says "count of liftable in+out edges". Which liftable set — the include list in A.1, or the full set before exclusion? Must reuse the same filtered set (exclude LAYOUT_POSITION, CONTAINS, DECLARES) for consistency. |
| Tiebreak beyond name-lex for identical (degree, name) pair | **NO** — name collisions in same file with same edge count are rare but possible (auto-generated code). Add semantic-id as final tiebreak. |
| Perf of per-file degree computation at commit time | **NO** — not addressed. On 35k symbols × avg 5 edges each = 175k pairs; if computed by a separate pass it's cheap (~50ms). If done by reusing loader's already-collected liftable edge set, free. Plan should say "reused from loader output, no extra pass". |

**Required edit:** A.6 must (a) pin the degree definition to "liftable-include-list edges after exclude filter", (b) add semantic-id as final tiebreak, (c) note "degree computed in loader, no extra RFDB round-trip".

### Table 16 — `build_from_paths_with_leaves` feasibility (CRITICAL)

I read `tree.rs` cover to cover and `pack.rs`:84-120. Here's what the revision implies and what it misses.

| Question | Finding |
|----------|---------|
| Can the existing builder be extended without breaking consumers? | **YES** — `build_from_paths` can remain; adding a parallel constructor is a non-breaking change. |
| Does `pack_folder` assume `direct_leaves` == file-granularity leaves? | **The pack recursion at `pack.rs:84-120` branches on `folder.child_folders.is_empty()`** — if empty, treats folder as "leaf" and calls `reserve_cluster(seed, folder.direct_leaves.len(), state)`, placing all direct leaves into one cluster. With the new API, each **file** becomes a folder with `child_folders = []` and `direct_leaves = [symbol, symbol, symbol…]`. Pack will `reserve_cluster(K)` per file — **this is exactly what we want** and matches §A.3's "split intra-file packing" intent. ✅ |
| Does `iswap` / `xswap` assume leaves are file-granularity? | **iswap** operates per-folder on `direct_leaves` (iswap.rs:23 comment "`Folder.direct_leaves`"). It swaps within a folder. With the new API, the "folder" is now a file, and swap-targets are symbols — semantics preserved. **xswap** swaps across sibling-folder boundaries; sibling folders are now either (a) two files in same directory, or (b) two directories. Semantics preserved. ✅ |
| Does `validate.rs` (which iterates `direct_leaves`) still work? | Almost certainly yes — it iterates folders reading positions. But plan does not explicitly validate. |
| Does `dump_to_writer` / synthetic mode break? | **UNCLEAR — not addressed in v2 plan.** `synthetic.rs` uses `FolderTree::build_from_paths` (saw at line 276: `fa.direct_leaves`). If synthetic mode keeps calling the old constructor (files-as-leaves), it still works. But the plan doesn't state that synthetic mode is left alone. If Chunk-3's benchmark uses synthetic, its "leaf" == file, not symbol — then Chunk-3 measurements aren't representative of real (file-as-folder, symbol-as-leaf) topology. |
| **`node_to_folder(n_nodes)`** — returns `Vec<FolderId>` of length `n_nodes`. This maps every **leaf NodeIdx** to its folder. With symbols as leaves: `n_nodes` = 35k symbol-NodeIdx-count, not 35k full-graph-node-count. Who defines the NodeIdx space? | **THIS IS THE CRITICAL GAP.** Plan §A.2 proposes signature `build_from_paths_with_leaves(&[(NodeIdx, folder_path, leaf_id)])` but NodeIdx is today a dense `u32` index into a position array of size `n_nodes` (= number of leaves fed in). Placement state (pack.rs) builds `positions: Vec<HexCoord>` indexed by NodeIdx. **If we pack 35k symbols, NodeIdx 0..35k-1 is the symbol space — not the full-graph node id space.** The LAYOUT_POSITION commit at A.4 needs to emit `src = symbol RFDB node id (u128)` not `NodeIdx (u32)`. The plan does not specify the NodeIdx↔RFDB-id mapping kept alongside the tree. Current loader.rs already has this mapping for MODULE-only (614 MODULEs → NodeIdx 0..613); scaling that from 614 to 35k is fine, but it must be explicit. Without it, the new constructor signature is ambiguous. |

**Required edit (CRITICAL):** A.2 must specify:
(a) NodeIdx is a dense `u32` index over the **placeable-symbol set only**, not the full RFDB graph. Loader builds a parallel `Vec<u128>` of RFDB ids keyed by NodeIdx.
(b) `build_from_paths_with_leaves` signature clarifies: the `NodeIdx` is the leaf's position in the placeable-set-dense-space; `leaf_id` is the opaque string used only to keep per-folder order deterministic and to debug-log (it is NOT the RFDB id — that comes from the NodeIdx→u128 side-map).
(c) `synthetic.rs` stays on `build_from_paths`; Chunk-3 must benchmark on **real loader output**, not synthetic, for the 30s gate (the synthetic benchmark in A.3a can remain informational only).

Without these three edits, Chunk-2 ambiguity will surface at code-review time and cost a round-trip.

### Table 17 — Route rendering when endpoint collapsed

| Question | Addressed? |
|----------|-----------|
| Route hidden entirely if either endpoint collapsed? | **YES** — §5 C.5 "hide entirely at zoom levels where endpoints are inside collapsed hulls". Explicit. |
| One endpoint visible, one not | **Implicitly hide** (§C.5 says "both endpoints… otherwise hide"). Good. |
| Intermediate symbol collapsed mid-route | **NO** — if A and B are visible but path passes through symbol C (in a collapsed region), does the route draw A→B as a straight line (losing path fidelity) or hide? Not addressed. |
| Multiple shortest paths — deterministic pick | **NO** — not addressed. |

**Required edit:** C.5 must state: (a) route draws the full polyline through all intermediate tile centers — intermediates in collapsed regions are auto-visible as waypoints or the route is drawn against the hull centroid for collapsed segments. Simpler: hide the route entirely if any symbol on the path is collapsed. Pick one and state it. (b) Use lexicographic edge-id ordering as the tiebreak for ties in shortest path.

### Table 18 — A.3b mitigation wording

| Claim | Precise? |
|-------|----------|
| "Cap iswap per-folder at `max_swaps = min(K², 4K)`" | **Ambiguous** — per-iteration or total-lifetime? iswap.rs:41 does multiple passes per-folder (outer loop). Plan must pin "total swaps issued inside one `iswap` invocation for this folder, across all passes". Otherwise a "passes × max_swaps" cap lets 154s leak back in. |
| "Parallel iswap across sibling folders (rayon)" | **Unsafe as stated** — iswap takes `&mut placement_state` (positions vec). Sibling folders operate on disjoint `direct_leaves` (disjoint NodeIdx ranges), so the mutation is disjoint in practice, but borrow-checker won't know. Requires either: (i) split positions `Vec` into per-folder mutable slices via `split_at_mut`, or (ii) per-folder scratch buffer merged after. Plan doesn't name the mechanism. |
| 30s gate on real graph — Chunk-3 is "pre-PR check" or "merge gate"? | **Ambiguous** — §6 Chunk-3 says "drop or pin mitigations from A.3b"; §6 D.5 says `≤ 30s` is a Playwright perf gate. Conflate: if Chunk-3 benchmark shows 45s on real data, does Chunk-2/Chunk-3 MERGE anyway pending mitigation, or block? State the policy. |

**Required edit:** A.3b must (a) fix "total swaps per folder per iswap invocation" cap definition, (b) name the rayon-safe mutation pattern (split_at_mut on positions vec, per-folder-disjoint guarantee derived from `node_to_folder`), (c) state Chunk-3 benchmark outcome is a MERGE gate not a post-merge check.

---

## Summary of new blocking gaps

1. **Table 16 (CRITICAL):** `build_from_paths_with_leaves` signature must pin NodeIdx as dense index into placeable-symbol space (not RFDB id space); loader owns the NodeIdx↔u128 side-map; synthetic mode stays on old constructor; Chunk-3 benchmarks real loader output.
2. **Table 13 (moderate):** Chunk-0 RPC must reuse `get_edges_by_type` for O(N_type) delete path and state atomicity policy explicitly in A.4 body (not as a §8 footnote).
3. **Table 18 (moderate):** A.3b must clarify "total swaps" cap semantics, name the rayon split_at_mut pattern, and make the 30s real-graph benchmark a merge gate.
4. **Table 15 (minor):** A.6 must pin degree definition to liftable-include-list, add semantic-id tiebreak.
5. **Table 14 (minor):** A.1 VARIANT exclusion paragraph must quantify dropped inbound-edge count and confirm cross-analyzer type uniformity.
6. **Table 17 (minor):** C.5 must state intermediate-collapsed route behavior and tiebreak for equal-length paths.

None of these require architectural restructuring. All are local edits to §A.1, §A.2, §A.3b, §A.4, §A.6, §C.5.

---

## Verdict

**REJECT** — minimal-impact revision. Close Table 16 (CRITICAL) and Tables 13/18 (moderate). Minor tables 14/15/17 can be closed in the same pass. Resubmit for v3 pass.

Expected v3 turnaround: one editing round, ~45 minutes. On v3 I will approve if CRITICAL is closed and moderates are addressed; minor tables won't block.

---

## v3 re-verification

Re-read `004-plan-revised.md` against the six gaps from v2.

### Table 16 — NodeIdx contract (CRITICAL) — **CLOSED**
§A.2 lines 123–129 pin all three required clarifications:
- (a) NodeIdx is dense `u32` over **placeable-symbol set only** (~35k, not 328k); loader owns `Vec<u128>` RFDB-id side-map plus inverse `FxHashMap<u128, NodeIdx>` (line 125).
- (b) `leaf_id: &str` explicitly opaque — intra-folder deterministic ordering + debug only, NOT the RFDB id (line 126).
- (c) Synthetic mode stays on old `build_from_paths`; Chunk-3 merge-gate runs on real loader output; A.3a synthetic number marked "informational only" (line 129).

### Table 13 — Chunk-0 RPC design (moderate) — **CLOSED**
§A.4 lines 176–182 pin all four required clarifications:
- Fast-path: `engine.get_edges_by_type(edge_type)` → metadata substring filter (line 177). O(N_type), not full scan.
- Substring match on serialized JSON explicitly stated (line 179).
- Fail-loudly on `_source` collision with different writer (line 180).
- Atomicity hoisted from §8 into body (line 182): two-RPC delete-then-write, rerun-safe, single-observable-consequence (missing layout until rerun).

### Table 18 — A.3b wording (moderate) — **CLOSED**
§A.3b lines 149, 152, 155:
- Cap is "total swaps across all passes in one invocation, per folder" with single counter semantics (line 149). K² × pass-count leak explicitly refuted.
- Rayon pattern names `split_at_mut` on positions vec; disjoint-by-construction derived from `node_to_folder`; siblings only, nested not parallelized (line 152).
- Chunk-3 explicitly declared MERGE GATE (line 155), escalation path to user if ladder exhausted.

### Table 15 — Hard-cap degree (minor) — **CLOSED**
§A.6 lines 217–220: degree = liftable-include-list after exclude filter (enumerated); both in+out; computed in loader from already-collected set (no RFDB round-trip); tiebreak degree DESC → name ASC → semantic_id ASC.

### Table 14 — VARIANT (minor) — **CLOSED**
§A.1 lines 63–66: inbound-edge drop count (≤ few thousand, measured in Chunk-1); Rust/Haskell emit vs TS does not (de facto Rust/Haskell-only bias documented in `--include-variant` help); navigability retained via search + enclosing-ENUM tooltip.

### Table 17 — Route rendering (minor) — **CLOSED**
§C.5 lines 358–362: four enumerated rules; any collapse (endpoint OR intermediate) → hide whole route, no shortcut/stub; tiebreak by lex ordering of edge sequence `(src_semantic_id, dst_semantic_id, edge_type)`.

### Tally
CLOSED 6 / PARTIAL 0 / STILL OPEN 0.

### Verdict

**APPROVE.** All six gaps closed with precise, citable edits. CRITICAL Table 16 fully resolved. Plan is implementation-ready.
