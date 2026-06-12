I have enough grounding (verified the stdlib packs exist, the prior synthesis doc's format, the orchestrator's per-language resolve sections at main.rs:1236-1283 including the rust-globals dispatch, and the rust-resolve/grafema-resolve source layouts). Producing the synthesis now.

# Resolver → datalog2 migration — synthesis (resolve round, 2026-06-10)

## W6-R WAVE LEDGER (updated 2026-06-10 night)

| Wave | Status | Notes |
|---|---|---|
| 0 preconditions | ✅ ddd8e6d3 | facts e2e, live shapes (2 producer bugs found), stratifier self-read, GRAFEMA_SKIP_RESOLVERS |
| 1 | ✅ + differential PASS | READS_FROM 98.5%, in-scope CALLS 99.4%; 612/616 misses = later-wave classes |
| 1b + node_attr | ✅ | + attr-generator maintain-envelope fix (4th invariant catch by review) |
| 2 + strip_prefix | ✅ b89c3c90 | 5 packs incl. WHOLE ClassInheritance + RustTraitResolution resolvers; cross-language index-leakage fix (5th catch) |
| 2b (re-export chains, builtins pack) | next | |
| 3 (path kit → module kernels → GATE legacy js/rust + re-differential) | | |
| 4 (runtime-globals facts) | | haskell/beam/type-inference/shape-tracker unscheduled |

15 packs in the runner, all shadow-mode alongside legacy. **Shadow cost MEASURED (2026-06-11
night): ~223s of pack eval per analyze (528s total)** — js_property_access_full 44.6s,
axum_routes 31.0s, js_local_refs 24.0s, rust_calls 23.9s, js_same_file_calls 23.7s, rest ≤14s.
Most packs wrote 0 edges (additive dedup vs legacy — shadow working as designed); supersets:
method_calls +3175, rust_calls +798, shape_verifier +613, js_property_access_full +559.
DECISION: pivot to W6 (build-once index cache on (leg, view-generation) + rayon row-parallel
joins) BEFORE Wave 2b — every further wave compounds the shadow cost; target pack-phase ≤60s
again at 15+ packs.

## POST-MERGE BASELINE (2026-06-11, after merging main fa76f1d1 + native rebuilds)

Fresh gated analyze on the merged tree: **491 535 nodes / 1 037 299 edges** (was 425k/904k —
main's rust-analyzer enrichment: macros-as-CALLs, unions, FFI, assoc consts = +15% graph).
Total 962s; phases: analysis 86s, commit 84s, resolve 492s, diagnostics 21s, depends-window
345s (≈15s depends + **330s packs**). Pack regressions vs the 85s post-W6 number, driven by
the macro-CALL explosion: rust_calls 16→68s (+3 013 edges incl. macro-name resolution),
js_builtins_nodes+edges 71s (new packs), js_property_access_full 47s. Packs remain correct
(js_local_refs 37 751, all firing) — the COST model changed under us.

NEXT LEVERS for the pack phase on the new baseline: (1) macro-CALL filtering in name-resolution
packs (analyzer tags macro=true — decide whether println!-class macro invocations belong in
CALLS resolution at all); (2) W9 stats + the BindRow/Vec<Value> representation (the measured
join_derived hot spot); (3) Wave 3 gating retires more legacy offsetting the cost.

## ✅ WAVE 2B DONE (2026-06-11) — EXTENDS gap closed 14/14; my chain hypothesis REFUTED

The "EXTENDS 14→10 = re-export-chain inheritance" claim below is WRONG (live-probed): the 4
edges are BUILTIN superclasses (Error ×2 via globals, EventEmitter ×2 via bare 'events'
imports), legacy-sourced from shape-tracker's builtin-class index which deterministically
misses them in gated runs (pre-existing bug, now moot). Closed by mechanism: A3/A4 arms in
js_class_inheritance. Zero re-export-chain inheritance exists in this corpus — the chain
machinery (visible() fixpoint) was still built and feeds bindings/cross-file/inheritance.
Also: js_builtins_nodes+edges packs (163 facts, byte-identical EXTERNAL sids), and a 5th
planner layer (intra-stratum estimate publishing) that UN-BROKE two silently-failing packs
(rust_cross_methods_ctor, rust_receiver_typing → now 3 + 201 edges live) + a regression gate
planning every pack under dogfood-scale Stats. Gated fresh-DB: EXTENDS 14, READS_FROM 192 194,
CALLS 66 029, 16 packs, 506s. Recommended skip set can now INCLUDE class-inheritance (4 steps).
Next: Wave 3 (path kit → import-resolution + builtins step gating → full js/rust gate +
re-differential), Wave 4 (globals), then haskell/beam/plugins.

## ✅ W6 + PER-STEP GATE VERIFIED (2026-06-10 late night, clean fresh-DB run)

W6 (executor index caches + rayon): **pack phase 223s → 85.4s (2.6×)** at 15 packs.
Per-step gate (GRAFEMA_SKIP_RESOLVE_STEPS) verified load-bearing on a fresh DB with
js-local-refs, same-file-calls, class-inheritance, property-access OFF: js_local_refs wrote
its full 37 595 READS_FROM; final counts vs legacy baseline — READS_FROM 191 853 vs 161 803,
CALLS 65 630 vs 61 665, IMPORTS_FROM parity. ONE regression: EXTENDS 10 vs 14 (re-export-chain
inheritance = the pinned Wave-2b subset delta) → **class-inheritance stays legacy until Wave
2b**; recommended skip set today = js-local-refs, same-file-calls, property-access.
Full analyze with the gate + W6: **497s**. Commits: W6 + 94c44a42.

## ✅ WAVE 1 DIFFERENTIAL — PASS (2026-06-10 evening, run B vs legacy baseline)

Run B = full analyze with GRAFEMA_SKIP_RESOLVERS=js,rust + the 8-pack runner: **446s wall**
(vs 576s with legacy js/rust on), packs: js_local_refs 21.0s/37 595 READS_FROM,
js_same_file_calls 23.7s/715, js_this_method_calls 8.3s/1, rust_calls 17.9s/7 995,
method_calls 5.6s/2 660, shape_verifier 7.5s/14, axum_routes 28.3s/18.

Sampled per-node differential (1 200 REFERENCE + 1 200 CALL nodes, keyed queryEdges probes —
bulk getAllEdges is NOT viable: v3 sid-resolution AND client-side parse both blow 900s):
- **REFERENCE→READS_FROM recall 98.5%** (931/945; +169 pack-only = documented set-semantics
  superset deltas; 14 legacy-only ≈ delta classes).
- CALL→CALLS overall recall 42.3% — **fully classified**: of 616 legacy-only edges, 430
  cross-file(rs) (≈all → <runtime/rust> globals = Wave 4 + cross-crate = Wave 1b), 150
  cross-file(ts) (runtime/js globals + Wave-1b cross-file), 20 builtins (Wave 2), 12
  cross-file(hs) = the haskell resolver's OWN run-to-run nondeterminism (ambiguous emitEdge
  across 16 packages; it ran in BOTH runs), and **only 4 SAME-FILE misses = the true Wave-1
  scope gap (0.6%)** (3 rs same-name fn-call corners + 1 call-through-variable).
- **In-scope verdict: Wave 1 ≈ 99.4% same-file CALLS recall, 98.5% READS_FROM — PASS.**

Production stance: legacy resolvers stay ON alongside the packs (additive dedup makes the
overlap free) until Waves 1b–3 cover cross-file + builtins + globals; GRAFEMA_SKIP_RESOLVERS
remains the harness/feature flag. js_this_method_calls produced 1 edge in shadow — expected:
the B1 arm of js_same_file_calls covers the bulk and the file-flat exactly-one rule is strict;
revisit when legacy is gated. Side-findings: getAllEdges wire API unusable at 860k edges (v3
sid-resolution per edge; W9 note), abandoned bulk dumps grind servers for 15+ min after client
death (the W8 disconnect-cancel bug, observed 3× today).


Source: verified specs + adversarial verdicts for **js-resolve** (8 resolvers, `packages/grafema-resolve/src/`) and **rust-resolve** (5 commands, `packages/rust-resolve/src/`), this round. Prior round (plugins): `plugin-datalog2-migration-specs.json` / `plugin-datalog2-migration-synthesis.md`. Reference pattern: `packages/rfdb-server/src/datalog2/stdlib/{depends,method_calls,shape_verifier,axum_routes}.dl` + their `stdlib.rs` fixture tests. All js-resolve verdict corrections are folded in below (notably: the builtins delta was **backwards**, `binding_import` emits **wrong** edges without `node_attr`, the module-existence check is ExportIndex not MODULE-presence, the workspace sub-path arm and the builtins direct-call arm were dropped, ground-facts support is parse-only evidence).

Branch: `feat/datalog`. Orchestrator drive points: JS `main.rs:1108-1186` (+ second full-graph pass `:1151-1168`), Rust `main.rs:1236-1283` (`stream_and_resolve_single_worker`, commands `rust-imports / rust-calls / rust-cross-methods / rust-trait-resolve / rust-globals`). Each language's resolve phase is independently skippable for the differential harness.

---

## 1. Shared sub-relations (the common prelude)

**Runtime reality first:** datalog2 packs share state ONLY through materialized edges/nodes (cross-pack EDB visibility under the declared-order pack-runner contract). Derived relations are per-program. So the "prelude" is a **source-level include expanded by a pack generator** (the lang-spec corpus→generated-pack pattern), NOT a runtime shared pack — except where we deliberately materialize a helper relation as edges.

### 1a. Pure-join prelude (expressible today, textual include)

| Relation | Definition | Used by | Evidence base |
|---|---|---|---|
| `decl_in(F, N, D)` per-type name index | `node(D, T), attr(D,"file",F), attr(D,"name",N)` × decl-type clause set (JS: 8 types; Rust: 9 types incl. STRUCT/TRAIT/IMPL_BLOCK) | js-local-refs, same-file-calls, cross-file-calls, rust-calls, binding resolution | attr surface {name,file,type,id} `builtin.rs:547-553` |
| `binding_src(B, LocalN, F, Spec)` — import-binding source WITHOUT metadata | `IMPORT -CONTAINS-> IMPORT_BINDING` joined to the IMPORT's first-class name | JS builtins, cross-file-calls, import-binding resolution; Rust binding resolution (same edge: `rust_analyzer.rs:1003-1008`, JS `Declarations.hs:514`) | both analyzers emit the CONTAINS edge |
| `imported(F, N)` skip-set | IMPORT_BINDING by (file,name) | same-file-calls, js-local-refs (negated) | SameFileCalls.hs:119, JsLocalRefs.hs |
| `in_scope(S, X)` scope-chain closure | recursive `CONTAINS` through SCOPE nodes (depends.dl-style fixpoint) | enclosing-class for this-calls, property-access this-arm, Rust containing-impl | **needs live-graph coverage check** (Wave 0) — replaces line-containment `ResolveUtil.hs:82-89` |
| `member_of(Owner, MName, M)` | JS: `CLASS -HAS_METHOD-> METHOD`; Rust: `IMPL_BLOCK -HAS_METHOD-> FUNCTION` (IMPL_BLOCK.name = self_ty, `rust_analyzer.rs:792-797,859-864`) | this-method-calls, cross-methods, dyn dispatch | replaces `[in:Class]` SID parsing |
| `receiver(C, R)` | `edge(C, R, "READS_FROM")` — also the method-call discriminator | rust-cross-methods substrate; JS property-access | `rust_analyzer.rs:1358-1370` |
| `exported_in(TF, N, T)` | `EXPORT -EXPORTS-> decl` + name | JS binding/cross-file/property-access | **needs live-graph check**: multi-declarator `export const a=1,b=2` suspected gap (one edge `Declarations.hs:617-621` vs per-declarator gnExported `:137`) |
| `ambig(F, N)` uniqueness idiom | two candidates + `neq` | js-this-method-calls (exactly-one rule), any first-match emulation | documented neq idiom |
| preference-ladder idiom | `\+ better_candidate(...)` negation chain | module-path ladder, FUNCTION-over-VARIABLE precedence, 3-arm fall-throughs | set-semantics standard |
| file gates | `jsts(F)` = 6 `ends_with` clauses; `rs(F)` = `ends_with(F, ".rs")` | all packs | |
| `upper(L)` ×26, `rt_global(N)` ×~90-100, `builtin_spec/2`, `builtin_func/3` | generated ground facts | ctor heuristic, local-refs skip, builtins | **gated on the facts e2e smoke (Wave 0)** — `Rule::fact` at `datalog/parser.rs:269` is parser-only evidence |

### 1b. The shared BLOCKED kernel: specifier → file

Both languages have the same-shaped module-path kernel, blocked on the same builtin family:
- **JS**: dirname + `../` normalize + candidate ladder (exact > swap > +ext > /index > .d.ts) + workspace longest-prefix sub-path arm (`ImportResolution.hs:189-271`, `:70-81`). Existence check is **ExportIndex membership**, not MODULE presence (verdict fix — `module_file(R)` shifts ladder winners; derive `exporting_file(F)` from EXPORTS/EXPORT instead, record the delta).
- **Rust**: file-path → `crate::…` transform (strip `src/`, drop `.rs`, `mod.rs`→parent, `lib.rs|main.rs`→crate, `RustImportResolution.hs:109-135`) + `::`-path decomposition.

One builtin kit (`path_resolve`, `strip_prefix`, `strip_suffix`, `replace_all`/separator-parameterized `last_segment`) unblocks **both** kernels — this is why it's capability rank #2, not two language-specific asks.

### 1c. Cross-pack EDB seams (materialized, ordering-contract)

- `IMPORTS_FROM` edges = the EDB seam between import resolution and {cross-file-calls, class-inheritance, builtins-edges}. In the hybrid waves the packs consume the **legacy resolver's** IMPORTS_FROM edges — migration of consumers doesn't wait for the producer.
- `CALLS` self-seam (Rust resolved-constructor arm reads CALLS while materializing CALLS): positive, non-negated storage self-read — **needs a stratifier acceptance check** (Wave 0); if rejected, split into a 2-pass pack. Ordering: after `rust_calls`, same MUST-run-AFTER pattern as `shape_verifier.dl`.
- Downstream unchanged: `depends.dl` (already migrated) consumes IMPORTS_FROM wherever it comes from.

---

## 2. Wave order (value = seconds saved × expressibility × confidence)

All resolver packs use negation (and some mint nodes) → **maintain-incremental refuses them; scratch floor 4-20s applies** (proven on the 415k-node dogfood graph). The win is eliminating the IPC walls: JS ≈76s, Rust ≈76s, both dominated by full-graph streaming + per-file round-trips + a second full-graph pass (JS), not by resolution math.

### Wave 0 — preconditions (hours, no engine change)
1. **Facts e2e smoke**: ground facts through datalog2 stratify→plan→exec→`@materialize`. Load-bearing for every generated-facts pack. 5-minute test, currently unproven.
2. **Live-graph shape verifications** (Evidence Rule — analyzer-source inference is not enough): `HAS_SCOPE`/`CONTAINS` scope-chain coverage; `IMPORT -CONTAINS-> IMPORT_BINDING` universality (both languages); `EXPORTS` multi-declarator gap; `IMPL_BLOCK -HAS_METHOD->` coverage; `CALL -READS_FROM-> receiver` coverage. Fresh dogfood graph first (mtime-vs-HEAD gate).
3. **Stratifier check**: positive same-type storage self-read (CALLS-reads-while-CALLS-materializing).
4. **Orchestrator skip-flags** per-language resolve phase (harness requirement).

### Wave 1 — fully expressible today (highest confidence, no engine change)
| Pack | Replaces | Why first |
|---|---|---|
| `js_local_refs.dl` | JsLocalRefs.hs (READS_FROM) | **#1 edge producer** per perf memory; zero structural blockers; ~90-name skip list as facts |
| `js_this_method_calls.dl` | JsThisMethodCalls.hs | kills the entire **second full-graph streaming pass** (`main.rs:1151-1168`) — pure IPC; exactly-one rule = neq idiom |
| `js_same_file_calls.dl` | SameFileCalls.hs direct + ctor + ClassName.static arms | no blockers; **this/obj arm contingent on Wave-0 scope-coverage result** (line-containment is NOT on the attr surface — if scope edges are spotty, that arm stays native residue) |
| `rust_calls.dl` | RustCallResolution.hs | fully expressible (exact + `::`-suffix fallback via ends_with + negation); additive mandatory (CALLS is shared vocabulary) |

Deliberately **excluded from Wave 1** (verdict corrections): `binding_import` un-aliased rule — it emits **wrong edges** (not just misses) for aliased/default bindings whose localName matches a target export, incl. the common `import Foo from './Foo'`/`export default class Foo` endpoint flip; held to Wave 2. Builtins — registry does NOT gate plugin emission (`Builtins.hs:317-339`; `lookupBuiltinFunc` only enriches metadata), the gated draft silently drops every non-registry method, the direct-call arm (`:353-357`) was missing, and the edges-pack `(module, name)` disambiguation is itself node_attr-blocked (bare-name collisions: http.get/https.get, path.parse/url.parse…); held to Wave 2 unless we accept minting with **qualified** gnName (`fs.readFile`) and record the naming + first-dot-vs-last-dot deltas.

### Wave 1b — ordering-dependent, still no engine change
- `rust_cross_methods_ctor.dl`: resolved-constructor receiver typing (ASSIGNED_FROM → resolved init CALL → impl_method + `TName::` containment). Runs AFTER rust_calls; gated on the Wave-0 stratifier check. Coverage subset of the plugin (requires the init call to resolve) — classifiable delta.
- `js_cross_file_calls.dl` (direct + namespace arms) consuming **legacy** IMPORTS_FROM as EDB — hybrid producer/consumer split. Inherits the aliasing caveat only where the legacy producer already disambiguated (it did), so the false-positive surface from the verdict does NOT apply here; record the multi-dot `method_suffix` delta.
- `js_property_access_ns.dl`: the namespace-import arm only.

### Wave 2 — after `node_attr` (the big unblock)
JS: import-binding aliased/default/namespace exact (`importedName`), class-inheritance (entire resolver: `superClass` is metadata-only), property-access full 3-arm (`base`/`className`), re-export chains (also needs `strip_prefix` for `*:src`), builtins done right. Rust: trait-resolve IMPLEMENTS (3-line rule on `node_attr(IB,"trait",…)`), dyn dispatch, typeAnnotation/returnType receiver typing, self-field (RECORD_FIELD typeAnnotation). Roughly **10 sub-steps across both languages** flip from blocked to trivial.

### Wave 3 — after the path/string kit (+ WORKSPACE_PACKAGE nodes incl. `package_dir`)
Module-path kernels both languages → IMPORT→MODULE, RE_EXPORTS, full import parity (incl. the workspace sub-path arm), Rust module tree (5 clauses). **Retires the native import-resolution residue** → js-resolve and rust-resolve binaries leave the analyze path entirely except globals.

### Wave 4 / stays external — runtime-globals (both languages)
effects-db YAML → generated facts-pack when the generator exists; until then keep native (it's also conceptually owned by the libraryCallbackEnricher/effects pipeline). `resolved=False` filter additionally needs node_attr.

**Expected wall**: Wave 1+1b ≈ replaces the bulk of both 76s walls' edge volume with an estimated 15-40s of scratch pack time (shared dominant base scans: CALL/REFERENCE/IMPORT_BINDING + name/file probes over the build-once hash-join) → **2-5×, not 10×** (scratch floor; honest). Structural wins: Haskell daemons leave the path, logic becomes `why()`-able, packs that later shed negation drop to O(delta).

---

## 3. Differential acceptance harness (one procedure, reused per pack)

1. **Freshness gate**: graph mtime vs HEAD before anything (stale-graph lesson).
2. **Two DBs, same checkout**: `DB_legacy` = full `analyze --clear`, resolvers ON, packs OFF. `DB_pack` = identical analyze with the target language's resolve phase disabled (Wave-0 skip-flag), then packs via the prod `@materialize` pack-runner in declared order. Node ids are BLAKE3 of semantic ids → directly comparable; still export `(src_sid, dst_sid, edge_type)` triples for robustness.
3. **Partition exactly**: legacy stamps `meta.resolvedVia` per module (rust-calls / rust-cross-method / rust-dyn-dispatch / same-file-calls / cross-file-calls / js-this-method-calls / js-local-refs / property-access / class-inheritance / runtime-globals; ImportResolution = unstamped IMPORTS_FROM/RE_EXPORTS remainder). Packs carry `_source` rule-hash. One pack ↔ one legacy slice, no cross-contamination.
4. **Predictions FIRST** — declare per pack, before diffing, three delta classes with concrete bounds: **EXACT** (e.g. local-refs modulo multi-decl), **SUPERSET** (set semantics vs Map last-wins; multi-dot method_suffix; star re-export all-matches; direct-export-beats-star-probe; first-of-duplicate exports — the two verdict additions), **SUBSET** (node_attr debt — bound it by a measurable count, e.g. bindings where importedName ≠ name; must shrink to zero in Wave 2). Any delta outside the declared classes = pack bug or new resolver knowledge → stop, witness, classify.
5. **Per slice**: counts smoke → sorted set-diff (`comm -3`) → witness EVERY diff row (pack-extra: `explain_datalog_fact`/why(); pack-missing: legacy stderr + manual binding trace). Verify before recording (both-sides evidence).
6. **Metadata parity is a separate column-wise report**, excluded from the diff key: `resolvedVia`/`receiverType`/`traitName`/`importedFrom`/`globalCategory`/`pure` — project as meta cols where possible, otherwise record the loss explicitly (verdict item 7).
7. **Nodes** (EXTERNAL_MODULE/EXTERNAL_FUNCTION/GLOBAL_DEFINITION) diffed by sid+name+file; node-minting packs are scratch-only under maintain — the harness times them as scratch.
8. **Gate per pack**: zero unexpected deltas on dogfood + bounded known-delta counts + a `stdlib.rs` fixture test (established pattern) + wall-clock recorded.

---

## 4. Missing capabilities, ranked by waves unblocked

1. **`node_attr(Id, Key, Value)`** [B,B,F]+[B,B,B], metadata twin of `edge_attr` (`builtin.rs:905-930`), §5 coercion, missing key = counted miss. Unblocks ALL of Wave 2 (~10 sub-steps, two whole resolvers — class-inheritance and rust-trait-resolve — plus correctness of everything import-aliasing-shaped). Already anticipated in-engine (`builtin.rs:36-37`). **Build first.**
2. **Path/string kit**: `path_resolve/3`, `strip_prefix/3`, `strip_suffix/3`, `replace_all/4` (or separator-parameterized `last_segment/3`). Unblocks Wave 3 — both languages' module kernels, star re-exports (no fact-enumeration workaround exists), dyn-trait strip; subsumes the bound-prefix concat+starts_with trick. Same eval discipline as `method_suffix`.
3. **External-data-as-facts conventions** (no engine change, but gated on the Wave-0 facts smoke): WORKSPACE_PACKAGE nodes **with `package_dir`** (orchestrator already discovers them, `config.rs:42-57`); builtin-registry / rt-global / upper-26 generated facts; effects-db YAML facts-pack generator. Gates Wave 1 skip-lists + builtins + Wave 4.
4. **`line`/`endLine` (+`exported`) on the attr row surface** — parity fallback where scope edges are missing (enclosing-class), and the Rust pub-export gate (NodeRow surfaces only id/type/name/file, `storage_glue.rs:45-54`). ⚠ interacts with the open numeric-literals Value decision.
5. **Stratifier confirmation for positive same-type storage self-reads** — cheap check, gates the Wave-1b Rust constructor arm; if rejected, the 2-pass split works.
6. **Same-run edges to `@materialize_node`-minted nodes** — removes the two-pack node-then-edge splits (builtins, globals). Low rank: the ordering workaround is engine-sanctioned (`axum_routes.dl` header).
7. (cosmetic) `upper_first/1` char-class test — 26 facts work.

---

## 5. Per-resolver verdicts

| Resolver | Verdict | Today (Waves 0-1b) | After node_attr (W2) | After string kit (W3) | Permanent native residue |
|---|---|---|---|---|---|
| **js-resolve** | **HYBRID → near-full** | local-refs, this-method-calls, same-file-calls (direct/ctor/static; this-arm pending scope coverage), cross-file-calls + property-access namespace arms over legacy IMPORTS_FROM | + import aliasing exact, class-inheritance, property-access full, re-exports, builtins | + module-path kernel, IMPORT→MODULE, RE_EXPORTS → binary leaves analyze path | runtime-globals (effects-db) until facts-pack generator; possibly line-containment fallback |
| **rust-resolve** | **HYBRID → near-full** | rust-calls (full), cross-methods substrate + resolved-constructor arm (pending stratifier check) | + trait-resolve (entire), dyn dispatch, typeAnnotation/returnType typing, self-field | + module tree, rust-imports both phases | rust-globals (effects-db); exported-gate until attr-surface or node_attr exposes it |
| haskell/java/kotlin/go/cpp/swift/beam/python/php-resolve, ruby (in-process), apple-cross, jvm-cross | **KEEP NATIVE this round** | not specced — no migration without a verified spec + verdict per the established two-agent procedure. The prelude (1a), the IMPORTS_FROM EDB seam, and the harness (§3) transfer directly; java/kotlin/go are the natural next spec round (same orchestrator streaming shape, `main.rs` 8c+) | | | |

**Honesty notes carried from the verdicts**: (a) no pack ships claiming "the ~90% case" when the missing guard produces wrong edges — subset-by-omission is acceptable, false positives are not; (b) the builtins "plugin resolved nothing" delta was factually backwards — the plugin emits for ANY builtin-receiver dotted call; every recorded delta in §3's prediction lists must cite both-sides evidence; (c) every graph-shape substitution (scope chains, EXPORTS, HAS_METHOD, READS_FROM receivers, IMPORT-CONTAINS) is **provisional until the Wave-0 live-graph checks pass** — analyzer source is not evidence of graph shape.
---

## Wave M + Wave 3a (2026-06-11, post-merge conveyor, parallel implementers)

**Wave M — macro-CALL filtering (the 330s lever, part 1).** Engine: `node_attr`/`edge_attr`
surface JSON bools as `"true"/"false"` (was: non-scalar ⇒ no row, bool-invisible — builtin.rs
eval arms + doc contracts + 2 new bind/check tests each). Packs: `rs_macro(C)` (.rs-gated
node_attr probe) + `\+ rs_macro(C)` guards in rust_calls (rs_call ⇒ both R1/R2 arms),
rust_cross_methods_ctor (rs_call + init-CALL leg), rust_receiver_typing (rs_call + arm-B init);
method_calls verified immune (method_suffix requires '.', macro names are '::'-paths) —
documented in header, no redundant filter. New DELTAs 5/7/9: macros EXCLUDED from resolution
per the analyzer's own contract (rust_analyzer.rs:1423-1424 "foo! is not the function foo");
legacy on a post-merge graph WOULD have matched them — deliberate divergence. 3 stdlib.rs
fixture tests pin the deltas (macro≡fn name no edge, plain call resolves, R2 suffix blocked).
**Perf (production wire, release server on a copy of the 491k/1.04M post-merge graph):
rust_calls 68s → 35.57s (~1.9×); 10,297 macro CALL nodes confirmed filtered. rs_macro itself
costs ~6s (per-row metadata JSON parse) — recomputed per pack (×3 aggregate), flagged for the
W9 shared-relation/planner-stats roadmap.**

**Wave 3a — path/string builtin kit (Wave 3b foundation).** 4 pure string builtins (no fs),
function placement, total (non-match = no row, never error): `path_resolve/3` (lexical
./ ../ resolution vs importer dir, ImportResolution.hs:189-235 parity incl. silent past-root
drop), `strip_suffix/3` (twin of strip_prefix; TS-ESM .js→.ts swap + .rs drop),
`last_segment/3` (separator-parameterized — the '::' blocker method_suffix couldn't cover),
`replace_all/4` (the '/'→'::' rewrite, specs.json:208). All four registered in
builtin.rs+stratify+plan; 8 unit tests. Implemented in a parallel worktree off a0f859a3;
patch landed on the M diff **100% clean, zero manual edits**.

**Verification:** both waves adversarially reviewed — approve, 0 must_fix (M: 2 advisory —
rs_macro ×3 recompute → W9, pre-existing rs_fn comment misattribution; 3a: 3 advisory —
unicode probe verified externally 15×15 zero panics, workspace-arm normalization drift noted
for the future pack, replace_all attribution). Independent test-runner: datalog2 248/0
(M alone) → combined 256/0 debug+release, plan gate green, **Gate A 51/51 twice**,
release bin builds. Conveyor wall: ~41 min for both waves (parallel implement).

---

## Wave 3b (2026-06-11, conveyor #2, parallel implementers): module/import-resolution packs, SHADOW

**3b-js — `js_module_imports.dl`** (NEW): IMPORT→MODULE + star RE_EXPORTS kernel — 15-rank
first-match candidate ladder (exact-if-known-ext → swap .js/.ts/.tsx/.jsx → +ext ×4 →
/index ×4 → .d.ts, /index.d.ts; ImportResolution.hs:544-552 parity) over
path_resolve/strip_suffix/strip_prefix; probe = ExportIndex presence (EXPORT∪EXPORT_BINDING),
NOT MODULE presence. Placed before js_import_bindings in both registries.
**Differential (on /tmp copy, predictions first): legacy 679 IMPORT→MODULE / 9 RE_EXPORTS;
pack 514/7; both 514/7; pack-only 0; meta-mismatch 0 (resolvedPath ≡ MODULE.file проверен
neq-пробами); legacy-only 165/2 = 100% declared SUBSET DELTA 1 (bare/workspace —
WORKSPACE_PACKAGE-узлов в графе 0). In-scope match 100% exact.** Pack wall on copy: 3.1s.
Независимый тест-раннер ПЕРЕВЫВЕЛ все live-числа на собственной копии — всё воспроизвелось.

**3b-rust — `rust_imports.dl`** (NEW): ВЕСЬ RustImportResolution.hs — module tree
(src/-strip, .rs-drop via strip_suffix, mod.rs→parent, lib.rs/main.rs→crate-root,
Hs:109-135 step-for-step) + phase 2 (IMPORT→MODULE) + phase 3 (IMPORT_BINDING→pub decl,
9 decl-типов, pub-гейт = node_attr __exported — Wave M bool-фикс это и разблокировал).
Worktree-патч лёг с 2 предсказанными конфликтами (оба registry-списка) — слиты вручную,
порядок producer-before-consumer: … rust_receiver_typing → rust_imports →
js_module_imports → js_import_bindings → …

**Verification:** оба ревью approve, 0 must_fix. Advisory carry-forward (Wave 3c): (a) js
exporting_file — недекларированный SUPERSET (EXPORT-marker-only файлы; нужен DELTA 7 или
ужесточение до гейтинга), (b) fixture-маркеры "named" пинят пак, не legacy-parity —
переименовать в default/EXPORT_BINDING, (c) числа дифференциалов инлайнить с текстами
запросов (Evidence Rule), (d) rust .rs-гейты пронумеровать как DELTA, (e) shadow-diff в
differential.rs фильтровать legacy-срез по отсутствию _source (re-run-safety).
**Suites:** datalog2 259/0 debug+release, plan gate ok, Gate A 51/51 (10.8s), orchestrator
466/0. Pack-runner visibility verified in source: последовательные materialize, каждый
коммитит атомарный manifest-flip → следующий пак видит рёбра предыдущего как EDB.
**Residue до гейтинга legacy import-resolution:** WORKSPACE_PACKAGE-факты от оркестратора
(+3 workspace-арма в паке) + перенос depends после js_module_imports в runner-порядке.

---

## Wave 3c (2026-06-11, conveyor #3): import-resolution ЗАКРЫТ — facts, arms, gate, measure

**Факты:** orchestrator эмитит WORKSPACE_PACKAGE-узлы (8 на dogfood: @grafema/* + grafema-explore;
analyzer.rs workspace_packages_to_wire, sid = {entry}->WORKSPACE_PACKAGE->{name}, metadata.package_dir;
коммит секцией 8n ДО pack-фазы). **Армы:** js_module_imports DELTA 1 CLOSED — ws-exact, ws-sub-path
(longest-prefix fixpoint, RAW concat = точная legacy-parity, path_resolve сознательно НЕ исполь-
зован), star ws fallback. **Все 5 advisory 3b закрыты** (exporting_file УЖЕСТОЧЁН до точной
buildExportIndex-семантики — гейт теперь load-bearing; фикстуры = legacy-parity оракул; rust .rs
гейты = DELTA 5; provenance-фильтр диффа исправлен на stamp-VALUE дискриминацию — legacy
ШТАМПУЕТСЯ gc-стампом, «unstamped» из advisory был неверен). **BONUS:** B3 namespace-арм в
js_import_bindings (import * as X — без него гейт терял арм).

**Гейт:** js `import-resolution` (Main.hs гейтинг существовал); rust-resolve гейтинга НЕ имел —
добавлен (rust-resolve/src/Main.hs getSkipSteps + daemon dispatch). Runner-order: depends
перенесён ПОСЛЕ всех IMPORTS_FROM-продьюсеров; unresolved-диагностика — ПОСЛЕ pack-фазы.
Must-fix ревью: порядок STDLIB_RULE_PACKS не был запинен на стороне оркестратора (продакшен
итерирует ЕГО список!) — добавлен кросс-реестровый тест (include_str! rfdb stdlib.rs, парс
STDLIB_PACKS, exact-sequence assert; mutation-проверка: swap depends/method_calls → FAIL).

**Acceptance (fresh gated worktree analyze, 666 файлов, 494,355/1,042,917):** js IMPORT→MODULE
**679 = 679 EXACT** (армы вернули все 165 bare/workspace); RE_EXPORTS 9; EXTENDS 14;
WORKSPACE_PACKAGE 8; `_source="js-resolution"` = **0** (legacy доказанно OFF, пак владеет
срезом); DEPENDS_ON 1,562 (−164 vs baseline = задекларированный js_import_bindings DELTA-1
subset: named-re-export hop, 1,050 vs 1,313 binding-рёбер). Re-differential на старой копии:
in-scope 514/7 exact, армы инертны без фактов (asserted) — checked-in harness
wave3c_js_module_imports_re_differential + wave3c_acceptance_counts.

**HEADLINE: pack-фаза 176.6s (20 паков) vs 330s = 1.87×; полный analyze 634s vs 962s.
До цели 60s: −116.6s.** Топ-рычаги: rust_calls 28.2s, js_builtins 27.5s (nodes+edges),
js_property_access_full 24.5s, axum_routes 16.6s, rust_receiver_typing 10.4s → W9.

**Carry-forward:** (1) workspace-имена не дедупятся (legacy Map last-wins) — DELTA 8 или дедуп;
(2) WORKSPACE_PACKAGE staleness при смене конфига (нет cleanup-пути; связано с clear-плацебо);
(3) втор-проходные legacy-шаги НЕ гейтились: js-this-method-calls дал 432 ребра при паке=0 —
аномалия пака РЕАЛЬНА, разобрать; js-call-globals 7,800 (Wave 4 runtime-globals);
(4) binding-hop subset −263 (re-export hop для биндингов); (5) grafema-resolve .build-hash
отсутствует — freshness-warning в логе.

---

## W9 (2026-06-11, conveyor #4): profile-first перф — pack-фаза 186.8s → 81.3s на копии (~76-82s продакшен-оценка)

**Профиль (инструментированный, 20 паков):** exec 138.8s (внутри — пересборка build-once
индексов 31.3s/call), stats full-scan 491k узлов на КАЖДЫЙ вызов 26.9s, derive 6.5s, write-back
2.0s, plan ~0. Фикс-оверхед на пак ≈1.5s floor. Подозреваемые (a)-(f) все получили вердикты
с числами (rs_macro ×3 = 11.3s подтверждён; BindRow ~10µs/pair косвенно; q-error на derived
legs структурно подтверждён — Stats без edges_by_type/селективности).

**4 фикса + бонус:** (1a) version-keyed planner-stats кэш + колоночный count_nodes_by_type_at;
(1b) SharedIndexCaches — межвызовные build-once индексы c edge-type-aware retain_for_commit
(@materialize декларирует touched types); (2) edge_attr build-once metadata-индекс (240µs/probe
→ O(1); axum_routes 16.9s→1.3s); (3) `string_contains("::")` гейт suffix_call (rust_calls
29.9→6.6s, result set unchanged); (бонус) short-circuit на неизменной (version, tombstone-Arc)
— idle-повтор 20 паков 188.9s→2.3s.

**Must-fix ревью (ПОДТВЕРЖДЁН и закрыт):** «same version ⇒ same data» ЛОЖЕН на delete→re-add
(remove_tombstone_* мутирует текущую версию без бампа; SharedIndexCaches/stats/short-circuit
могли отдать stale через публичный API на долгоживущем сервере). Фикс: Arc-идентичность
tombstone-сета как часть ключа/гарда + engine-side инвалидация на un-tombstone; 2 regression-
теста с neutered-guard доказательством. Полный lib **1341/0**, Gate A 51/51, ре-проба фикса
≤ verify-прогона на каждом паке (ноль перф-цены).

**this-calls «аномалия» ОПРОВЕРГНУТА (carry-forward (3) Wave 3c):** пак set-идентичен legacy
(432≡432, only-diff 0 в обе стороны), write-path доказан (после удаления legacy-рёбер пак
пере-вывел все 432 с метаданными). «0 рёбер» = additive-дедуп против негейтнутого
второпроходного шага. Фикс = гейт-строка `js-this-method-calls` (orchestrator second_pass
фильтр, main.rs:1294-1312). Для call-globals гейт-строка `runtime-call-globals` — НЕ гейтить
до Wave-4 пака.

**Остаток до 60s (продакшен-оценка ~76-82s):** оси №3 (bi_method_call дедуп между
js_builtins_nodes/edges + (file,prefix)-индекс, −16-18s), №5 (this_member derived×derived
full-key join, −13s), №6 (rs_macro share, частично поглощён 1b). Бонус-находка профайлера:
D2 maintain МЕДЛЕННЕЕ scratch на неизменном графе (diff_base full-scan) — закрыт short-circuit'ом
для idle, но для малых дельт вопрос открыт.

---

## Wave 4 (2026-06-11): runtime-globals закрыт + default-гейтинг втор-прохода + binding-hop (js/rust resolve-миграция ЗАКРЫТА)

**Part 1 — default-retired второпроходные шаги:** `RETIRED_SECOND_PASS_STEPS`
(orchestrator main.rs, у `derive_depends_on_legacy`) — built-in сет, мержится с
GRAFEMA_SKIP_RESOLVE_STEPS через `effective_second_pass_skips()` (pure, тест
`retired_second_pass_steps_skip_by_default_and_env_is_additive`); env-var аддитивна и
НЕ может un-retire. Retired: `js-this-method-calls` (W9 432≡432) +
`runtime-call-globals` (差 ниже).

**Part 2 — runtime-globals facts + паки (срез 7,800):** legacy producer =
`runtime-call-globals` (Main.hs dispatch :261 → RuntimeGlobals.resolveAll с
jsCallStrategy: CALL-ноды, CALLS-рёбра, GLOBAL::<seName>, resolvedVia="runtime-globals",
globalCategory="ecmascript"; commit-имя js-call-globals). SymbolDB = ВСЕ yaml из
effects-db/{runtimes,packages} (python/rust/haskell-ключи легально матчат JS-коллы —
"lines.push"→GLOBAL::push, "GuaranteeNode.validate"→GLOBAL::validate).
**Генератор** `scripts/generate-runtime-globals-facts.mjs` (js-yaml из pnpm store) →
`js_runtime_globals_facts.dl` (5,722 rtg_key + 2,6xx rtg_eff; зеркалит flatten
RuntimeGlobals.hs:80-167). 16 seName-КОНФЛИКТОВ (bare-dotted-fn vs qualified mod.fn,
legacy = load-order-dependent Map.unions) — policy bare-wins, ПРИШПИЛЕНА live-ораклом:
прод минтил GLOBAL::process.exit (41 CALLS), не GLOBAL::exit. **Паки**
`js_runtime_globals_nodes`/`_edges` (двух-паковый сплит js_builtins; facts prepended
через stdlib.rs concat!): allSuffixes = dot-prefix shrink-идиома (spec_pfx) + suffix
через strip_prefix; firstMatch = longest-suffix via shadowed-негация (любые два
матчащихся суффикса одного имени сравнимы); isLocallyResolved оба арма
(method_suffix = точный last-segment-гейт). DELTAS 1-6 (effects comma-string,
exported-флаг, effects-winner, consecutive-dots, colonVariant vacuous — 0 "::"-ключей,
8-ext gate). **差 `wave4_runtime_globals_differential`: 7,800 ≡ 7,800, only-diff 0/0,
seNames 183 ≡ 183 — С ПЕРВОГО ЗАПУСКА.** runtime-call-globals → retired.

**ENGINE MUST-FIX (wildcard demotes hash-join):** `rtg_key(S, _)` — planner помечает
Wildcard как Bound → `derived_probe_key` возвращает None на КАЖДОЙ строке →
join_derived молча падает в defensive per-row FULL SCAN: 22k×5.7k = ~20s на ОДНО
нерекурсивное правило (нашёл event-sink с wall-clock: stratum msfx seed 20.7s).
Фикс exec.rs: Wildcard-позиции исключены из probe key (unify_atom всё равно их
матчит); тест `derived_join_wildcard_positions_stay_indexed_and_correct`.
Паки 23s → **2.9s/3.4s**.

**Part 3 — binding-hop subset (DELTA 1 js_import_bindings ЗАКРЫТА):** legacy
handleExportEntry (Hs:368-386) резолвит source named-re-export'а ПОЛНЫМ
resolveModulePath (ладдер + ws-армы, БЕЗ ModuleIndex-fallback) — материализован как
seam-ребро `eb_reexport_hop`: EXPORT_BINDING → MODULE RE_EXPORTS (js_module_imports,
eb_src арм в src/rel; DELTA 8 = MODULE-нода на winner). reexp получил второй арм
(committed hop edge) в js_import_bindings + оба textual-duplicates
(js_class_inheritance, js_cross_file_calls). + exported_in clause 4 = gnExported
declarations (buildExportIndex class 3, Hs:137; `__exported` node_attr) — single-scan
`exp_decl` ⋈ hash target_file (НЕ target_file-led: малый ведущий генератор = 211×8
re-scans, ~8.5s; single-scan = ~1s — урок planner-filter-before-generator, exec-twin).
**差 `wave4_binding_hop_differential`** (двухстадийный: js_module_imports →
OverlayStorageView с hop-рёбрами → js_import_bindings — un-committed эквивалент
прод-порядка паков): **legacy-only 263 → 0** (residue witnessed: 1 STALE-DST —
висячее legacy-ребро на удалённую ноду; 5 WS-FACTS-ABSENT — ws-bare hop source
'@grafema/rfdb-client' при 0 WORKSPACE_PACKAGE-фактов на старой копии, армы есть,
live-proof = свежий analyze); pack-only 49 (43 hop-introduced) = задекларированные
superset-классы (DELTA 1b/2/class-3), все witnessed.

**Per-pack времена (probe `wave4_touched_pack_probe_times`, копия 491k):**
js_module_imports 3.3s, js_import_bindings **5.0s** (W9-бэнд 3-5s держится),
js_class_inheritance 4.3s, js_cross_file_calls 3.8s, js_runtime_globals_nodes 2.9s,
js_runtime_globals_edges 3.4s.

**Suites:** datalog2 267/0 debug+release, полный rfdb lib 1345/0, plan gate ok,
orchestrator 443+13+14+1 / 0, **Gate A 51/51**. Реестры: оба (stdlib.rs STDLIB_PACKS +
orchestrator STDLIB_RULE_PACKS) — пара runtime_globals после js_builtins_edges,
кросс-реестровый пин зелёный.

**Carry-forward Wave 4:** (1) hop seam = НОВАЯ лексика (EXPORT_BINDING→MODULE
RE_EXPORTS) — потребители star_src гейтятся node(E,"EXPORT"), не задеты; (2) effects
в pack-минченных нодах = comma-string (DELTA 1) — виден только на fresh gated
графах; (3) ws-facts-absent класс закрывается сам на любом пост-3c analyze (факты
эмитятся оркестратором); (4) `exp_decl` материализует ~160k строк на полном графе —
дешёво сейчас, кандидат на shared-relation при W6 parallel eval.

---

## Wave 4 fix-round + W9-iter2 landing (2026-06-11, conveyor #5 финал): **20 паков = 56.2s — ЦЕЛЬ ≤60s ДОСТИГНУТА**

**Wave 4 must-fixes (оба подтверждены и закрыты с фальсификационными прогонами):**
(1) YAML bool-key дрифт — js-yaml резолвил ключи `True:/False:` в булевы (legacy Data.Yaml
держит verbatim) → фантомные rtg_key("true") факты; фикс = FAILSAFE_SCHEMA в генераторе +
regen (диф = ровно 8 строк), values проверены грепом на schema-чувствительность.
(2) trace_effects регрессия — пак писал effects строкой "IO,THROW", traceEffects.ts требовал
Array.isArray; фикс на консьюмере (нормализация обеих форм) + 2 теста (без фикса падают
ровно они). DELTA 1 хедер обновлён известным консьюмером.

**W9-iter2 (полностью в exec.rs, 152-строчный патч):** derived×derived full-key build-once
join + empty-leg short-circuit; Wave-4 имплементер независимо нашёл смежный движковый баг
(Wildcard в derived_probe_key → тихая демоция в per-row scan, 23s→3s у runtime_globals).
Лендинг: hand-merge двух конфликтов, ревью iter2 approve (3 стилевых нита — merge-scar
doc-строка, устаревший комментарий derived_probe_key, неверная ссылка на E-PLAN-003 гард
в тест-комменте).

**ФИНАЛЬНАЯ ПРОБА (объединённое дерево, свежий release-бинарь, копия 491,535/1,037,299):**
20 паков production-порядка = **56,207 ms**. Хронология одной метрики:
900s timeout → 330s (post-merge) → 176.6s (Wave M+3a-c) → 81.3s (W9) → **56.2s (W9-iter2+W4)**.
+2 новых runtime_globals пака ≈ +6.3s (замерены отдельно в Wave-4 acceptance).

**Wave 4 = миграция js/rust ЗАВЕРШЕНА содержательно:** runtime-globals 7,800≡7,800 exact,
binding-hop 263→0 (witnessed residue), js-this-method-calls + runtime-call-globals retired
BY DEFAULT (RETIRED_SECOND_PASS_STEPS, env остаётся аддитивным). Остался финальный
сквозной дифференциал + флип RFDB_DATALOG_V2 (#12) и cleanup (#13).

---

## W8 (2026-06-11/12, conveyor #6): живучесть долгоживущего сервера — все 3 блокера закрыты

**Сон ноута прервал двух агентов; ретрай №3 ВЕРИФИЦИРОВАЛ работу предшественника и нашёл
CRITICAL data-loss**: отменённый @materialize убегал «пустым результатом» (cancel в финальном
леге → empty delta → fixpoint счёл конвергенцией → write-back занадгробил все 1,726 DEPENDS_ON;
живой repro 2/2). Фикс: post-fixpoint FINAL GUARD (re-check raise-only флага до Ok) в evaluate
+ maintain_incremental; фальсифицированный тест; live re-proof: CPU гаснет ≤1s, no commit.

**Part 1 — disconnect-cancel**: per-connection watcher (poll+MSG_PEEK, 200ms), wired через
EvalLimits.cancelled в v2 exec (per-row/per-iteration), v1 и cypher. До: v1 жёг +17 CPU-s на
мертвеца, v2 коммитил write-back мёртвого клиента. После: стоп ≤1s, no commit. 3-pack
re-probe: оверхед в шуме (±0.5s).

**Part 2 — persistent clear**: clear_durable() = manifest authority delete + segments/gc/pins
truncate + reset_datalog2_caches. До: рестарт воскрешал 491k узлов (плацебо как в gaps.md).
После: **618M → 16K, рестарт грузит 0 узлов**. gaps.md RESOLVED, скилл clear-trap обновлён.

**Part 3 — durable D2-pin**: sidecar (BLAKE3, ключ = manifest version + tombstone-CONTENT-hash
— W9-урок), read/write-disjoint gate. Live: scratch 6.62s → рестарт → **0.04s pin HIT (165×)**;
мутация → чистый scratch. Ревью нашло riders-unsoundness (буферизованные чужие записи едут на
write-back флаше → пин узаконил бы их невидимость) — закрыто гейтом has_buffered_writes +
falsified тест.

**Ревью также вскрыло PRE-EXISTING потерянную скобку в engine_v2.rs tests**: 4 новых W8-теста
+ старый zero_seed были МЁРТВЫМ КОДОМ (вложены в незакрытый fn; 62 из 67 #[test] регистрировались).
Скобка восстановлена, zero_seed сгнил по MVCC-flush паттерну — починен.

**Сьюты**: полный lib **1359/0**, datalog2 275/0, Gate A 51/51, bin 61/18 — фейлы байт-идентичны
известному pre-existing набору. Idle-exit (опционал) НЕ реализован — бюджет ушёл на data-loss.

---

## Final #12 (2026-06-12, conveyer #7 + ручная доводка): МИГРАЦИЯ = ДЕФОЛТ

**Имплементация**: RETIRED_FIRST_PASS_STEPS (js-local-refs, same-file-calls, property-access,
class-inheritance, import-resolution, rust-imports) — capability-conditional (не-v2 сервер =
legacy fallback жив); RFDB_DATALOG_V2 default ON (off-switch =off; роутер-тесты incl.
off→v1 на реальном storage_v2 + Hello capability). Env остаётся аддитивным.

**Ревью/тест-раннер поймали 3 must_fix до флипа**: компайл-ошибка probe; неполная
zero-stamp enumeration (builtin-class/instance-of/instance-of-builtin добавлены);
**class-inheritance INSTANCE_OF-гэп** — legacy-шаг производит ещё INSTANCE_OF +
BUILTIN_CLASS-минтинг без пака и без дифференциала, а method_calls/shape_verifier их
ЧИТАЮТ. Решено ИЗМЕРЕНИЕМ (probe на dogfood): INSTANCE_OF = 97, ВСЕ resolvedVia=
"type-inference" (плагин владеет срезом), legacy-армы = 0, BUILTIN_CLASS = 0 → retired
с задокументированным dogfood-bound основанием в doc-комменте.

**Ночная ловушка процессов**: имплементер и fix-агент дважды завершали ход на ожидании
fat-LTO линка (13+ мин) — их «результат» = промежуточный статус. Доводка выполнена
детерминированной цепочкой (bash под caffeinate): сборки → полный lib 1359/0 + datalog2
275/0 + Gate A 51/51 ×2 + orchestrator 472/0 → worktree analyze на ЧИСТЫХ дефолтах →
acceptance probe PASS.

**Чистый прогон (PURE defaults, без единого env-гейта): 502,509 / 1,062,679; полный
analyze 505.3s (962→634→505); pack-фаза ~74s на 22 паках с реальными записями** (warm-probe
56.2s остаётся честным числом для повторных прогонов). Гейты: js-resolution=0,
rust-import-resolution=0, js-call-globals=0, instance-of*/builtin-class=0; EXTENDS
10(analyzer)+4(pack)=14; runtime_globals 7,805; depends 1,728; js_this_method_calls=1 —
срез поглощён same_file_calls B1 (additive union, владелец сменился — рёбра на месте).

**Advisory carry-forward**: (a) second-pass retirement → capability-conditional;
(b) pack-failure coupling (log-and-continue прячет потерю retired-среза); (c) 18 bin
pre-existing; (d) property-access evidence-class. → RESUME.md «ОСТАВШИЕСЯ ЗАДАЧИ».

---

## Wave 5 (2026-06-12): cleanup of FULLY replaced code + честный LOC-учёт

**Удалено сейчас** (live-consumer-проверка: grep по configs/docs/tests/package.json/CI —
ноль импортов и регистраций; у всех четырёх НЕ существовало тестов; из `.grafema/config.yaml`
они были убраны ещё в W3/W5-волнах, остались только поясняющие комментарии):

| Файл | LOC |
|---|---:|
| `plugins/method-call-resolver.mjs` | 517 |
| `plugins/shape-verifier.mjs` | 348 |
| `plugins/axum-route-detector.mjs` | 127 |
| `plugins/semantic-bridge-detector.mjs` | 818 |
| **Итого удалено** | **1,810** |

Сопутствующая правка висячих ссылок (3 файла, ~6 строк): комментарии в
`plugins/field-instance-resolver.mjs` и `plugins/type-inference.mjs` теперь ссылаются на
`method_calls.dl`/живые плагины, `docs/ROADMAP.md` — на `shape_verifier.dl`.
Упоминания в `CHANGELOG.md`, `_ai/research/*`, `_archive/` — исторические записи, оставлены.
Ссылки внутри `packages/rfdb-server/src/datalog2/` (заголовки паков «replacement for
plugins/X.mjs») — provenance-комментарии, оставлены намеренно.

**НЕ удалено — SCOPE CONSTRAINT (решено, не пересматривать):** Haskell resolve-шаги
(`packages/grafema-resolve`, `packages/rust-resolve`) ОСТАЮТСЯ — это живой non-v2 fallback
(final-#12 сделал retirement capability-conditional именно для того, чтобы не-v2 серверы
продолжали работать). Их выпил = отдельное продуктовое решение об отказе от fallback — НЕ
эта волна. Также остаётся legacy DEPENDS_ON-деривация в оркестраторе: это явный P3-fallback
(`main.rs::derive_depends_on_legacy`, охраняется `legacy-retirement.lock` со status=retained
+ тестом `legacy_retirement_lock_guards_deletion`).

### LOC-учёт, два честных фрейма (числа — `wc -l` на HEAD fd855311)

**Frame A — предметный код** (что ушло/уйдёт vs декларативная замена):

| Удалённая/отложенная сторона | LOC | | Добавленная сторона | LOC |
|---|---:|---|---|---:|
| 4 .mjs-плагина (удалены СЕЙЧАС) | 1,810 | | stdlib/*.dl паки, рукописные (22 шт.) | 3,514 |
| их тесты (не существовало) | 0 | | js_runtime_globals_facts.dl (сгенерированный) | 8,362 |
| wiring (config-записи убраны в W3/W5) | 0 | | scripts/generate-runtime-globals-facts.mjs | 196 |
| **deferred deletion** — Haskell-модули retired-by-default шагов (умрут с fallback'ом): JsLocalRefs 127 + SameFileCalls 172 + PropertyAccess 213 + ClassInheritance 268 + ImportResolution 618 + JsThisMethodCalls 82 + RustImportResolution 236 | **1,716** | | stdlib.rs wiring (src) | 422 |
| потенциал при полном выпиле обоих resolve-пакетов (вкл. ещё-живые шаги 951 + Main/ResolveUtil 563) | 3,230 | | stdlib.rs fixture-тесты паков | 3,903 |

Сейчас: −1,810 удалено, +3,514 рукописных правил (+8,362 генерата + 196 генератор).
С отложенным выпилом fallback'а: −1,810 −1,716…−3,230 Haskell vs та же добавленная сторона.
(`Grafema.RuntimeGlobals` 304 LOC в grafema-common НЕ в deferred-счёте — shared с
beam-/haskell-/rust-resolve.)

**Frame B — всё, включая движок** (та же удалённая сторона vs полный datalog2):

| Компонент | src LOC | test LOC | total |
|---|---:|---:|---:|
| `datalog2/` движок, 16 .rs-файлов (без stdlib.rs) | 12,305 | 9,200 | 21,505 |
| stdlib.rs (wiring + fixture-тесты паков) | 422 | 3,903 | 4,325 |
| stdlib/*.dl рукописные | 3,514 | — | 3,514 |
| js_runtime_globals_facts.dl (генерат) + генератор | 8,558 | — | 8,558 |
| **Добавлено всего** | **24,799** | **13,103** | **37,902** |
| Удалено сейчас / deferred | 1,810 / 1,716–3,230 | 0 | |

(split src/test — по позиции `#[cfg(test)]` в каждом файле; точные пофайловые числа:
exec 3,698/2,361, builtin 1,381/1,659, differential 1,069/1,846, storage_glue 1,113/494,
plan 1,052/376, parser_ext 927/358, stratify 673/260, materialize 554/319, events 440/91,
pin_sidecar 331/99, binding 322/165, tag 299/197, increment 293/164, value 103/65, mod 50/746.)

**Амортизация**: по голым LOC Frame B «в минус» — но движок одноразовая инфраструктура:
один и тот же evaluator/инкрементальный maintain обслуживает ВСЕ языки (js_*, rust_*,
depends, axum, shape) и любые будущие user rule-packs; предельная цена нового резолвера
упала с «сотни строк императивного Haskell/JS + N+1 IPC» до «десятки строк .dl»
(rust_trait_resolve = 126 строк, js_this_method_calls = 60). Прямой продуктовый выигрыш
уже зафиксирован выше по леджеру: datalog-фаза 38.6s→…→pack-фаза ~74s на 22 паках vs
60s-таймауты отдельных плагинов и 900s-таймаут legacy-пути.

**Сьюты после удаления (acceptance)**: полный rfdb-server lib **1359/0** (66.0s),
datalog2 debug 278/0 + release 278/0, plan-модуль 10/0, **Gate A 51/51** (TALLY match=51
mismatch=0, 65.9s), orchestrator build OK + **472/0** (443+14+14+1). JS: pnpm build OK
(кроме `@grafema/gui` — pre-existing ENOENT на локальном untracked-симлинке
`public/assets→dist/assets`, к волне отношения не имеет); unit-сьют 622 pass / 95 fail —
**фейл-сет байт-идентичен чистому HEAD fd855311** (git stash → прогон → diff фейл-имён =
IDENTICAL): все 95 pre-existing (enricher/MCP-кластер), Wave 5 не добавила ни одного.
Зелёная сборка без единого импорта удалённых плагинов = доказательство отсутствия живых
потребителей.
