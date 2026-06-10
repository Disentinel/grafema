I have enough grounding (verified the stdlib packs exist, the prior synthesis doc's format, the orchestrator's per-language resolve sections at main.rs:1236-1283 including the rust-globals dispatch, and the rust-resolve/grafema-resolve source layouts). Producing the synthesis now.

# Resolver → datalog2 migration — synthesis (resolve round, 2026-06-10)

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