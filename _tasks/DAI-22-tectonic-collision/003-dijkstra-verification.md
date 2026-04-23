# DAI-22 — Dijkstra Plan Verification

**Verdict: REJECT**

Plan `002-plan.md` is close, but four completeness tables have NO / UNCLEAR rows, plus three precondition issues that would silently corrupt data. Fix the rows marked NO/UNCLEAR and re-submit. Specific line numbers of amendments required listed after every table.

---

## Table 1 — Symbol-type selection (§A.1, leaf inclusion list)

Plan's include list: `MODULE, FUNCTION, METHOD, CLASS, VARIABLE, INTERFACE, TYPE, ENUM, STRUCT, TRAIT`.

Enumerated node types actually emitted by analyzers (grepped from `packages/*/src`, union across JS/TS, Haskell, Rust, Python, BEAM): see list. Columns: should this get an individual tile? handled?

| Node type | Should be placed? | Handled? |
|-----------|-------------------|----------|
| MODULE | YES — file container | YES (A.1) |
| FUNCTION | YES | YES |
| METHOD | YES | YES |
| CLASS | YES | YES |
| VARIABLE | YES (top-level only — see gap) | UNCLEAR — plan doesn't restrict to module-scope |
| CONSTANT | YES — same as VARIABLE for Haskell/Rust | **NO** — missing from list |
| INTERFACE | YES (TS) | YES |
| TYPE_ALIAS | YES | UNCLEAR — plan says "TYPE"; real emitted type is `TYPE_ALIAS` |
| TYPE_SYNONYM | YES (Haskell) | **NO** — missing |
| TYPE_CLASS | YES (Haskell) | **NO** — missing |
| DATA_TYPE | YES (Haskell) | **NO** — missing |
| ENUM | YES | YES |
| ENUM_MEMBER / VARIANT | UNCLEAR — probably co-placed with ENUM | **NO** — not addressed |
| STRUCT | YES | YES |
| TRAIT | YES | YES |
| IMPL_BLOCK | YES (Rust) — host for methods | **NO** — missing, would cause methods to float without parent |
| RECORD / RECORD_FIELD | UNCLEAR | **NO** — not addressed |
| MACRO | YES (Rust, Elixir) — first-class symbol | **NO** — missing |
| NAMESPACE | YES (TS) | **NO** — missing |
| DECORATOR | NO — annotation, co-place with host | YES by exclusion (not listed) |
| LAMBDA | UNCLEAR — probably co-place with enclosing FUNCTION | **NO** — not addressed |
| CLOSURE | same as LAMBDA | **NO** — not addressed |
| GENERATOR | same | **NO** — not addressed |
| EXTENSION | YES (Swift / Kotlin) | **NO** — missing |
| PROCESS | YES (BEAM, first-class) | **NO** — missing |
| MESSAGE_TYPE | YES (BEAM) | **NO** — missing |
| CONSTRUCTOR | UNCLEAR | Plan §A.1 excludes explicitly, but constructors in some dialects ARE discrete symbols |
| HANDLER | UNCLEAR (BEAM, Erlang gen_server) | **NO** — not addressed |
| CALL / REFERENCE / PARAMETER / LITERAL / BRANCH / PATTERN / SCOPE / PROPERTY_ACCESS / IMPORT / CASE / EXPRESSION / DO_BLOCK | NO | YES (excluded in A.1) |
| METRIC / EFFECT / ISSUE | NO (diagnostic, not code) | YES (excluded) |
| HEX | NO (synthetic from old layout) | **UNCLEAR** — plan doesn't explicitly exclude; a prior HEX:: dst node might leak |
| REGION | NO (synthetic from NEW layout) | **UNCLEAR** — plan creates REGION but A.1 loader runs on the *post-layout* graph on re-commit, could feed its own REGION nodes back in |
| HASKELL_GLOBAL / GLOBAL:: (virtual globals) | NO | **NO** — plan doesn't exclude; these have no real file, would be filtered by "skip file ending in /" only partially |
| OBJECT_LITERAL / ARRAY_LITERAL | NO | YES (excluded) |
| ASYNC_FUNCTION | YES (treat like FUNCTION) | **NO** — missing; will be silently dropped |
| EXPORT / EXPORT_BINDING | NO (re-export anchor) | **UNCLEAR** — not addressed |

**Gap:** at minimum, **CONSTANT, TYPE_ALIAS, TYPE_SYNONYM, TYPE_CLASS, DATA_TYPE, IMPL_BLOCK, MACRO, NAMESPACE, PROCESS, MESSAGE_TYPE, ASYNC_FUNCTION** should be placed. **HEX, REGION, HASKELL_GLOBAL, GLOBAL::*** must be explicitly *excluded* (otherwise self-loop on re-commit will add virtual nodes to the pack input). "TYPE" is not a real emitted type — it's `TYPE_ALIAS`. Fix §A.1 list with a defensive include-list and an explicit exclude-list.

---

## Table 2 — Liftable edge types (§A.1)

Plan's list: `CALLS, READS_FROM, WRITES_TO, IMPORTS_FROM, DEPENDS_ON, PASSES_ARGUMENT, AWAITS, RETURNS, ITERATES_OVER, HAS_METHOD` (matches current tectonic liftable).

Enumerated edge types actually present in graph (from `rfdb-server/src` + orchestrator):

| Edge type | Use for placement? | Handled? |
|-----------|--------------------|----------|
| CALLS | YES | YES |
| READS_FROM | YES | YES |
| WRITES_TO | YES | YES |
| IMPORTS_FROM | YES | YES |
| DEPENDS_ON | YES | YES |
| PASSES_ARGUMENT | YES | YES |
| AWAITS | YES | YES |
| RETURNS | YES | YES |
| ITERATES_OVER | YES | YES |
| HAS_METHOD | YES | YES |
| ASSIGNED_FROM | YES (dataflow) | **NO** — missing |
| FLOWS_INTO / DATA_FLOW_REVERSE | YES (dataflow) | **NO** — missing |
| IMPLEMENTS / EXTENDS | YES (cohesion — interface implementers should cluster) | **NO** — missing |
| INHERITS_FROM | YES | **NO** — missing |
| EXPORTS / EXPORT_BINDING | borderline — barrel chains | **NO** — not discussed |
| BROADCASTS_TO / DISPATCHES_TO / DISPATCHES_VIA / HANDLES_VARIANT | YES (BEAM process-graph cohesion) | **NO** — missing |
| DERIVES / DERIVED_FROM | YES (Rust) | **NO** — missing |
| QUERIES_DB | YES (cohesion) | **NO** — missing |
| THROWS / CATCHES / ERROR_PROPAGATES | YES | **NO** — missing |
| CONTAINS | NO (structural — already encoded in folder tree) | YES implicitly |
| DECLARES | NO (structural) | **UNCLEAR** |
| HAS_* (HAS_PARAMETER, HAS_FIELD, …) | NO | **UNCLEAR** |
| LAYOUT_POSITION | NO (must be excluded or the next commit uses stale positions as cohesion signal) | **NO** — not excluded; catastrophic feedback loop |
| RESOLVES_TO | NO | **UNCLEAR** |
| REFERENCES | YES weak | **UNCLEAR** |

**Gap:** §A.1 liftable list **must explicitly exclude LAYOUT_POSITION** (else second `layout --commit` run treats the first run's output as a structural signal and diverges). Should also explicitly exclude CONTAINS/DECLARES/HAS_*. Should consider adding ASSIGNED_FROM, FLOWS_INTO, IMPLEMENTS, EXTENDS, INHERITS_FROM for better cohesion on OO and dataflow codebases.

---

## Table 3 — Path-collision safety (§A.2, option ii: semantic id as leaf segment)

Claim: "semantic id is guaranteed unique".

| Case | Unique? | Handled? |
|------|---------|----------|
| Two functions same name different file | YES (file prefix disambiguates) | YES |
| Two functions same name same file (overloads, shadowed let) | YES in Haskell (different semantic ids per arity), UNCLEAR in JS/TS (anonymous expressions) | **UNCLEAR** |
| Anonymous arrow functions / lambdas | Semantic id appends `:line:col` → unique. But §A.1 doesn't include LAMBDA so moot unless extended | **UNCLEAR** — see Table 1 |
| Symbol whose semantic id itself contains `/` (e.g. TypeScript qualified names `Foo/Bar`) | **NO** — FolderTree will split on `/` and treat the name as another directory | **NO — real bug** |
| Symbol with empty semantic id (defensive) | — | **NO** — not addressed |
| Symbol with no `file` field | — | Existing guard: "silently skipped with warn" (loader.rs:80). OK but lose that symbol entirely. UNCLEAR |
| Nodes where `file` ends with `/` (DIRECTORY sentinel) | — | Was handled in http_server.rs:466. Not mirrored in new loader code path. **NO** — must be carried over |
| Two nodes with identical semantic id from merge-on-commit | Grafema does dedup by semantic id at commit; so identical id = same node | YES |

**Gap 3a:** §A.2 chose option (ii) — "semantic id as extra path segment". If a semantic id contains `/` (Grafema V2 uses URI-form `grafema://...` for some node types, and arrow form has `->` but **some paths are embedded inside the id**), FolderTree will silently shatter it into spurious directories. Either escape the `/` in the synthetic segment or use option (i). Plan needs an explicit escape/quote policy — amendment at §A.2 line 83.

**Gap 3b:** `file.ends_with('/')` DIRECTORY sentinel filter (current http_server.rs:466-468) is NOT replicated in the new loader. Plan §A.1 must carry this forward.

---

## Table 4 — LAYOUT_POSITION storage lifecycle (§A.4 / §B.2)

Plan: inline `(q, r)` in edge metadata, dst still `HEX::<q>,<r>`, edge type `LAYOUT_POSITION`, `_source: "layout-pack"`.

| Scenario | Expected | Handled? |
|----------|----------|----------|
| First `layout --commit` on empty DB | Produces N edges | YES |
| Second `layout --commit` — positions change | Old edges deleted, new written | **NO** — current commit uses `commit_batch(&[], &[], &edges, true)` (rfdb.rs:116 of commit.rs) — empty `changed_files`, so stale edges are NEVER cleaned up. After N runs, database has N×symbols LAYOUT_POSITION edges, all for the same src. Warmup reads will see multiple positions per node and pick one nondeterministically. **Real data-corruption bug the plan inherits and doesn't address.** |
| Symbol renamed between analyze + layout | Stale edge survives pointing at old semantic id | **NO** — not addressed |
| Symbol deleted between analyze + layout (source removed) | Stale edge survives | **NO** — not addressed |
| Re-commit of same layout bytewise | Idempotent (no duplicate edges from dedup at commit_batch) | UNCLEAR — depends on RFDB edge dedup semantics; must be verified |
| Edge metadata missing q/r (old format) | Warmup must tolerate | Plan says "prefer metadata"; doesn't specify fallback behavior — UNCLEAR |
| Edge q/r values out of i32 range or NaN | — | **NO** — not addressed; plan assumes well-formed |
| Two LAYOUT_POSITION edges same src, different dst | — | **NO** — not addressed; consequence of the stale-edge bug |

**Gap 4a (CRITICAL):** §A.4 must specify a **delete-before-commit** story. Either (a) pass the symbol-set-derived `changed_files` list to `commit_batch` (file-scoped deletion), OR (b) emit a pre-pass that reads all `LAYOUT_POSITION` edges and deletes them, OR (c) use RFDB's `delete_edges_by_type` if it exists. Current commit.rs:116 is broken for re-commit; the plan replicates that bug at scale (328k × re-runs).

**Gap 4b:** §B.2 must specify behavior when LAYOUT_POSITION edge exists without `q`/`r` metadata (fallback to `HEX::q,r` dst parse, or treat as corrupt/skip).

---

## Table 5 — REGION node lifecycle (§A.4)

REGION is a NEW node type being introduced.

| Scenario | Expected | Handled? |
|----------|----------|----------|
| Any existing code emits `type: "REGION"` | — | **Grep confirms no prior emitter.** YES |
| Any analyzer emits CONTAINS edges whose src is a REGION | — | No (REGION is new). YES |
| `layout --commit` re-run — old REGION nodes must be deleted | Orphan REGION + orphan CONTAINS (REGION→*) from prior run | **NO** — same bug as Gap 4a, extended to nodes. Plan §A.4 says "ensure we write/delete only layout-source ones (`_source: "layout-pack"` metadata tag)" but doesn't say *how*. `commit_batch(&[], &[], &edges, ...)` with empty changed_files cannot delete nodes. |
| CONTAINS edge type collision: analyzer CONTAINS (MODULE→FUNCTION) vs layout CONTAINS (REGION→SYMBOL) — both same `edge_type` | Warmup must not lift analyzer CONTAINS edges when reading REGION tree | **NO** — plan §B.2 loads "CONTAINS edges rooted at REGION nodes" — requires filtering by src node type. Fine in principle, but the plan doesn't mention that the *existing* http_server stream-emit code (line 708) treats CONTAINS as a liftable type. Removing tectonic doesn't automatically fix that. |
| REGION semantic id `REGION::<depth>::<path>` — path can contain `:` if folders are `a:b` (rare but possible) | — | **UNCLEAR** |
| REGION for root folder `.` → `REGION::0::.` | — | OK |
| Zero-leaf folder (synthetic intermediate) | — | **NO** — is an empty region rendered? plan doesn't say |

**Gap 5 (CRITICAL):** §A.4 must specify how to clean up prior REGION nodes. Without node deletion path, the second `layout --commit` doubles REGION count; third triples it; hull computation on client scales linearly with region count.

---

## Table 6 — Warmup failure modes (§B.2)

| Scenario | Expected | Handled? |
|----------|----------|----------|
| LAYOUT_POSITION edge without metadata | fallback or fail loudly | **NO** — §B.2 doesn't specify |
| Metadata present but missing `q` key | — | **NO** |
| Metadata q/r not integers (string, null, float, NaN, Infinity) | skip with warn | **NO** |
| q/r overflow i32 | — | **NO** — `HexCoord { q: i32, r: i32 }` from layout/hex.rs, no bounds validation |
| Two LAYOUT_POSITION edges same src | — | **NO** — consequence of Gap 4a |
| No LAYOUT_POSITION edges at all | warn + stream pos:null | YES (§B.4) |
| REGION node with missing `depth`/`path`/`kind` field | — | **NO** |
| CONTAINS edge from REGION to non-existent node | — | **NO** |
| Cycle in REGION containment (bug) | — | **NO** |

**Gap 6:** §B.2 line 160-164 must enumerate error-recovery behavior for each of the above. Minimum: document "fail loudly on any parse error" or "skip with counter".

---

## Table 7 — `pos: null` taxonomy (§B.3)

User asked: enumerate causes.

| Cause | GUI treatment? |
|-------|----------------|
| (a) Node type intentionally excluded (CALL, REFERENCE, …) | Hide from atlas, still searchable — **UNCLEAR in plan** |
| (b) Layout hasn't run yet | Show "Run `grafema layout --commit`" overlay | YES (§B.4, §C.1) |
| (c) Layout ran but this symbol was skipped (no file, file ending in `/`, unknown type) | Log + unplaced badge | **NO** — plan doesn't distinguish this from (d) |
| (d) Symbol added post-layout (analyze after layout) | Suggest re-run layout | **NO** — same as (c) |
| (e) Corrupt metadata per Table 6 | — | **NO** |

Plan §C.1 says "`pos: null` → skip from tile rendering; include in search/tooltip datasets but mark as unplaced". That conflates (a)–(d). Stream `layout_meta.source` distinguishes (b) from (a/c/d) but not finer.

**Gap 7:** plan should include a `unplaced_reason` field per node (or per type-class) so GUI can act differently: excluded → silent; layout-missing → overlay; symbol-missing → hint to re-run. Minor severity but UX-relevant.

---

## Table 8 — LOD depth mapping (§C.3)

Plan: `min (fit-all) | depth 0..2 only`, …

| Case | Handled? |
|------|----------|
| Codebase with max folder depth = 1 (all files at root) | **NO** — plan §C.3 assumes ≥ 9 levels; fallback undefined |
| Codebase with max depth = 3 | **NO** — less than 9, plan's "min zoom → depth 0..2 only" is fine but "−N" rows collapse |
| Codebase with max depth = 15 | **UNCLEAR** — "log-linear in zoom, tunable" is hand-wave |
| Folder depth varies per file (src/a.ts vs src/a/b/c/d.ts) | **NO** — plan assumes uniform depth when writing the table |
| Single huge file (depth 1, 10k symbols) | **NO** — LOD model is purely depth-based; can't hide 10k symbols behind a hull |
| Region with 1 leaf | **NO** — is it hidden? rendered as single tile? |

**Gap 8:** §C.3 must specify: (1) fallback when maxDepth < 9 ("scale min-zoom cutoff linearly to actual maxDepth" — plan needs to say it), (2) size-based hiding policy — since depth alone doesn't handle the heavy-file case (one single file with 10k functions fills one hull but LOD can't thin it). Plan's "Smallest hulls (below K cells at current zoom) hidden regardless of depth" is mentioned in §C.3 but not made concrete — give K in terms of pixel area or screen-budget.

---

## Table 9 — Hull computation on disconnected cells (§C.2 + §10)

Plan cites skill `hex-grid-morphological-close-hull`. **That skill file does not exist on disk** (`~/.claude/skills/` has only `hex-grid-sa-o1-connectivity`). Plan references a skill name from the session's available-skills list, but the name alone doesn't give an algorithm. Reviewable as: is the skill content actually loaded/used?

| Case | Handled? |
|------|----------|
| Hull of 1 cell | **NO** — degenerate, not addressed |
| Hull of 2 cells on opposite sides of map | **UNCLEAR** — morphological close has a radius; beyond it, two disjoint polygons. Plan says the skill "explicitly handles this" — unverifiable without the skill content |
| Hull of a ring of cells (hole in middle) | **UNCLEAR** — do we render the hole? |
| Hull interleaved with sibling's cells | **UNCLEAR** — overlapping hulls, z-order? |
| Hull containing an entire child region's hull | nesting by construction | YES |
| Hull for folder with 0 direct leaves but many descendants | **UNCLEAR** — hull built from transitive leaves? |

**Gap 9:** §C.2 must inline the morphological-close algorithm (radius parameter, fallback when cells are more than radius apart), not just cite a skill name. State the policy for rings (are holes preserved?) and for overlapping hulls of siblings.

---

## Table 10 — Performance gates (§5.5 + §10)

Plan target: `layout --commit ≤ 30s` on 328k symbols. Phases:

| Phase | Estimated cost on 328k | Identified bottleneck? | Mitigation in plan? |
|-------|------------------------|-------------------------|---------------------|
| Loader: query N node types × `query_nodes_by_type` | Each call ≈ O(type-count); 10 calls | UNCLEAR — `query_nodes_by_type` is RPC-framed; 10× cost vs current 1× | **NO** — plan doesn't estimate |
| Loader: `datalog_query("DEPENDS_ON")` extended to N edge types | Currently 1 query; plan needs 10 | **NO** — not addressed |
| Folder tree build | O(N) — cheap, linear on leaves | YES trivial |
| Pack recursion | Empirical: sandbox benchmark shows `pack` ~ O(N log N), but iswap intra-folder O(K²) | YES — §A.3 addresses iswap cap per-file, xswap skip |
| Commit emission: 328k WireEdge allocations | O(N) cheap | — |
| RFDB batch write: 328k edges / 10k chunk = 33 chunks | Known slow path (tested at ≈ 1-2s per chunk) — so ~33-60s alone | **NO** — plan says "Expected ~seconds; acceptable". Likely violates the 30s budget on its own |
| Delete-before-write (Gap 4a) | Must read 328k edges, delete them, THEN write — 2× the cost | **NO** — plan doesn't budget this |
| REGION nodes commit: ≈ N_folders ≈ 10³ | cheap | YES |
| Server warmup: iterate LAYOUT_POSITION edges, parse metadata | O(N), ≈ 1-3s | YES (§10 note) |

**Gap 10:** §5.5 budget is probably unachievable without: (a) batched `query_nodes_by_type` or a combined type-set query, (b) delete-by-type RFDB op (if it exists) instead of per-edge deletion, (c) parallel pack per folder subtree. The plan does not benchmark or even estimate. Mitigation list (§10) is too vague — "benchmark before Phase B/C" leaves the possibility that Phase A is rewritten mid-implementation. Pre-verify with a throwaway dry-run before committing to the plan.

---

## Table 11 — Playwright verification (§D)

User enumerated 10 interaction categories. Check §D coverage:

| Interaction | Covered? |
|-------------|----------|
| Hover → tooltip | YES (D.3) |
| Click → select | YES |
| Pin | YES |
| Zoom in/out | YES |
| Route draw (2 pinned → path) | YES |
| Selection ancestor-chain highlight | YES |
| 2D/3D toggle | **NO** — §C.5 mentions "no layout recompute"; §D does not assert |
| Reload (page reload while pinned / selected) | **NO** — not in §D |
| Keyboard shortcuts | **NO** |
| Context menu (right-click) | **NO** — plan doesn't even state whether context menu exists |
| Empty-layout overlay UX (§B.4) | **NO** — tested? |
| Graceful degradation when some symbols have pos:null | **NO** |
| Performance: frame time during route animation | YES (D.2 — pan/zoom ≥ 30fps) but not during route draw |

**Gap 11:** §D must explicitly cover 2D⇄3D toggle (no layout recompute + same selection/pins survive), reload persistence, keyboard shortcuts, empty-layout overlay behavior.

---

## Table 12 — Scope of deletion (§B.1, §B.5, §7)

Tectonic references grepped across repo:

Files touching `tectonic|ATOM_TYPES|atom_positions|file_fallback|tectonic_meta|CachedLayout`:

| File | Plan covers deletion? |
|------|------------------------|
| `packages/rfdb-server/src/http_server.rs` | YES (§B.1) |
| `packages/rfdb-server/src/tectonic_layout.rs` | YES (§B.1) |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | **UNCLEAR** — not listed, must check for tectonic imports |
| `packages/rfdb-server/src/lib.rs` | **UNCLEAR** — not listed; likely `pub mod tectonic_layout` line |
| `packages/gui/src/store/loadStream.ts` | **UNCLEAR** — handles `tectonic_meta` message; plan §B.3 replaces with `layout_meta` but doesn't explicitly say "drop `tectonic_meta` consumer from loadStream.ts" |
| `packages/vscode/src/mapPanel.ts` | **UNCLEAR** — references `tectonic_meta`; plan §7 doesn't mention |
| `packages/rfdb-server/tests/*` | PARTIAL — §B.1 says "Delete tectonic tests" but doesn't enumerate; tests list: `compile_without_ui.rs, crash_recovery.rs, load_test.rs, port_zero.rs, static_ui.rs, stress.rs, ui_routes.rs` — which of these assert on tectonic internals? Plan must name files, not wave |

**Gap 12:** §B.1/§B.5/§7 must enumerate every file (lib.rs, bin/rfdb_server.rs, loadStream.ts, vscode/mapPanel.ts) that references tectonic and specify the exact edit. "Delete related tests" without naming them is a completeness failure.

---

## Preconditions

1. **Skill file missing.** Plan cites `hex-grid-morphological-close-hull` as a skill that "explicitly handles disconnected cells". The skill is listed in the session's available-skills (so it exists as a prompt fragment) but there is no on-disk file at `~/.claude/skills/hex-grid-morphological-close-hull/`. The algorithm must be pasted into the plan or the skill file must be written.

2. **30s budget unverified.** No prior measurement of `pack` + `commit_batch` at 328k. The `project_tectonic_demo` memory says "40k primitive atoms, 13.8s cold" — naively 328k is 8× larger, 110s cold — inside the range of "mitigations might or might not get us to 30s". Plan §A.3 says "Validate before commit. Benchmark current pack on 328k leaves. Acceptance: ≤ 30s wallclock. If blown: …" but then A.3 lists mitigations that may themselves take implementation effort. This is a **Ready-Fire-Aim** anti-pattern (FPF B.5) — the plan can't be verified before work begins. Either do the benchmark during plan phase, or split plan into "A.3a: benchmark" → "A.3b: fix if needed".

3. **Re-commit lifecycle is broken upstream.** `commit.rs:116` writes with empty `changed_files` — existing DEPENDS_ON commit (main.rs:1747) has the same pattern. Before extending to 328k symbols, the orchestrator layout commit must gain a delete-then-write path. This is pre-existing tech debt that the plan inherits and amplifies (614 → 328k stale edges per run).

---

## Summary of blocking gaps

1. **Gap 4a / Gap 5 — delete-before-write.** The plan writes LAYOUT_POSITION edges and REGION nodes but provides no mechanism to delete the previous run's output. On re-commit, the database accumulates stale data. This is a data-correctness bug, not a performance concern. §A.4 must specify the deletion strategy.

2. **Gap 1 — symbol-type completeness and exclusion of layout-synthetic types.** List misses CONSTANT, TYPE_ALIAS, TYPE_SYNONYM, TYPE_CLASS, DATA_TYPE, IMPL_BLOCK, MACRO, NAMESPACE, PROCESS, MESSAGE_TYPE, ASYNC_FUNCTION. And — critically — does not explicitly **exclude** HEX, REGION, HASKELL_GLOBAL, GLOBAL::* (virtual nodes emitted by earlier passes). Second run will feed its own output back into the layout.

3. **Gap 2 — LAYOUT_POSITION must be in the exclude-list for liftable edges.** Otherwise the packer treats prior placements as cohesion signal — feedback loop.

4. **Gap 3 — semantic-id-as-path-segment will shatter on `/` embedded in ids.** Either escape or pick option (i). `file.ends_with('/')` DIRECTORY filter must be carried over.

5. **Gap 12 — file-deletion list is incomplete.** `lib.rs`, `bin/rfdb_server.rs`, `loadStream.ts`, `vscode/mapPanel.ts`, and the specific tests under `packages/rfdb-server/tests/` are not named.

6. **Preconditions 1, 2, 3.** Skill content missing; 30s budget unvalidated; pre-existing commit-lifecycle bug needs fixing first.

---

## Completeness tables built: 12

**Verdict: REJECT.** Revise §A.1 (Table 1, 2), §A.2 (Table 3), §A.4 (Tables 4, 5), §B.1/§B.3 (Table 12), §B.2 (Table 6), §C.2 (Table 9), §C.3 (Table 8), §D (Table 11). Address preconditions 1–3. Re-submit for second-pass verification.
