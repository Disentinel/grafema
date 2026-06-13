# lang-spec: haskell resolver → derive packs

Migration spec for `packages/haskell-resolve/` (binary `haskell-resolve`, daemon + 5 CLI
subcommands) → in-engine `derive` (Datalog v2) packs. Same format as
`_ai/research/resolve-datalog2-migration-specs.json` (js/rust precedent).

Grounded on: resolver source (READ fully), analyzer emission source
(`packages/haskell-analyzer/src/Rules/{Imports,Exports,Expressions}.hs`,
`Grafema/SemanticId.hs`), and LIVE probes on the dogfood graph
(`.grafema/graph.rfdb`, 491,535 nodes, Jun-11 snapshot, HEAD Jun-13 — 2 days stale but
adequate for SHAPE/presence verification; flagged where freshness matters).

Builtin registry verified at `packages/rfdb-server/src/derive/builtin.rs` HEAD: `node`,
`edge`, `incoming`, `attr` ([B,B,F]/[B,B,B]/[F,B,B]), `neq`, `gt/lt/gte/lte`,
`starts_with`, `not_starts_with`, `string_contains`, `ends_with`, `method_suffix`,
`concat`, `str_lower`, `basename`, `strip_quotes`, `strip_prefix`, `strip_suffix`,
`last_segment`, `replace_all`, `path_resolve`, `edge_attr`, **`node_attr` (B,B,F / B,B,B —
NO generator mode)**. The dominant unblock that the js spec lacked (`node_attr`) EXISTS now.

---

## HEADLINE

The Haskell resolver is **structurally simpler than JS** and **almost fully expressible
TODAY**, because:

1. **Module resolution is by NAME, not path.** Haskell `import Data.Map.Strict` resolves to
   the MODULE node whose `name == "Data.Map.Strict"` — a plain attr join. NO `path_resolve`
   kernel, NO extension-swap ladder, NO workspace-package facts. (The js spec's #2 missing
   capability is irrelevant here.)
2. **No metadata-only blockers on the hot paths.** The module name a binding came from is
   **graph-reachable** via `IMPORT -CONTAINS-> IMPORT_BINDING` + `IMPORT.name` (verified
   100% coverage: all 2498 .hs IMPORT_BINDINGs have the CONTAINS parent). NO sid `[in:...]`
   parsing needed, NO `node_attr` needed for the import/call chain.
3. **No aliasing on the export side.** Haskell `EXPORT_BINDING.name` IS the exported name
   first-class; there is no `import {x as y}` / `export {x as y}` alias surface and no
   re-export-source metadata on EXPORT_BINDING (verified: 0 EXPORTS edges in .hs, 0 EXPORT
   nodes in .hs). Resolution is pure name-matching against the target file's decl index.

The only genuine SUBSET debt is the `haskell-globals` (effects-db SymbolDB) step, which is
EXTERNAL YAML data and is kept out of the wave-1 packs (same recommendation the js spec made
for runtime-globals). `haskell-local-refs`' Prelude-name table is finite and ships as ground
facts (the `js_local_refs` rt_global precedent).

---

## INVENTORY — the 5 resolver commands (Main.hs:83-87)

| cmd | module | reads | writes | expressible |
|---|---|---|---|---|
| `haskell-imports` | HaskellImportResolution | IMPORT, IMPORT_BINDING, MODULE, EXPORT_BINDING + decls | IMPORTS_FROM (IMPORT→MODULE, IMPORT_BINDING→decl) | **fully** |
| `haskell-local-refs` | HaskellLocalRefs | REFERENCE, 8 decl types, IMPORT_BINDING skip-set, Prelude table | READS_FROM (+virtual EXTERNAL_FUNCTION for Prelude) | **fully** (2-pack split for the virtual node) |
| `haskell-local-calls` | HaskellLocalCalls | CALL, 6 callable types, IMPORT_BINDING skip-set | CALLS (same-file) | **fully** |
| `haskell-cross-module-calls` | HaskellCrossModuleCalls | CALL, IMPORT_BINDING(+module via CONTAINS), MODULE, decls | CALLS (cross-module) | **fully** |
| `haskell-globals` | Grafema.RuntimeGlobals | CALL unresolved, effects-db SymbolDB (EXTERNAL YAML) | CALLS→GLOBAL_DEFINITION | **no** (external data; wave-2, kept out) |

---

## ANALYZER EMISSION — verified shapes (spot-verified, the round's lesson)

| shape | claim | evidence |
|---|---|---|
| IMPORT.name | full dotted module name `"Data.Map.Strict"` | Imports.hs:53 `modName`; live: IMPORT name="Data.Map.Strict" in HaskellLocalRefs.hs |
| IMPORT meta | `alias`, `qualified`, `hiding` (node_attr-readable) | Imports.hs:71-74; live: `"alias":"T","qualified":true` |
| IMPORT_BINDING sid | `file->IMPORT_BINDING->name[in:ModuleName]` (parent=module) | Imports.hs:144 `semanticId file "IMPORT_BINDING" name (Just importName)`; SemanticId.hs:26 `[in:p]` |
| IMPORT→IMPORT_BINDING | CONTAINS edge, 100% | Imports.hs:160-165; **live probe: 2498/2498 have CONTAINS parent IMPORT** |
| IMPORT_BINDING.name | local name, no metadata | Imports.hs:145-156 `gnMetadata = Map.empty` |
| MODULE.name | dotted module name, MODULE#file id | SemanticId.hs:42 + Walker; **live: MODULE name="Grafema.Types"** |
| EXPORT_BINDING | name=exported name, gnExported=True, **NO metadata, NO source** | Exports.hs:71-90 `gnMetadata = Map.empty` |
| EXPORT nodes in .hs | **ZERO** (Haskell has no EXPORT node, only EXPORT_BINDING) | **live probe: 0 EXPORT in .hs** |
| EXPORTS edges in .hs | **ZERO** (export = name-match, not an edge) | **live probe: 0 EXPORTS from EXPORT_BINDING or MODULE in .hs** |
| `module Foo (module Bar)` | ExportInfo only (orchestrator-side), **NO EXPORT_BINDING node** | Exports.hs:93-99 `eiNodeId = ""` |
| CALL.name for `Map.lookup` | **bare `"lookup"`** — analyzer strips the qualifier | Expressions.hs:489 `occNameString (rdrNameOcc name)`; **live: CALL "lookup"=3, "Map.lookup"=0** |
| dotted CALL names in .hs | 112 total, **almost all OPERATORS** (`.&.`,`.`,`.!=`,`.:`) NOT qualified calls | **live probe + samples** |

### ⚠ THE ONE REALITY THE RESOLVER (and a naive port) WOULD MISS

`HaskellLocalCalls`/`HaskellCrossModuleCalls`/`resolveOne` strip a qualified prefix with
`T.breakOnEnd "."` (LocalCalls.hs:64-66). **The analyzer already strips qualification**
(`rdrNameOcc` → occurrence name), so for real qualified calls (`Map.lookup`→`"lookup"`) the
strip is a **no-op** — and the only dotted CALL names that survive are **operators**
(`.&.`, `.`, `.:`). Applying `last_segment(N, ".", Bare)` to those mangles them
(`.&.` → `&.` or empty). **Therefore the pack must NOT blindly port the breakOnEnd strip.**
The faithful port joins on the bare `CALL.name` directly (the common path), and a dotted
operator like `.` simply won't match a same-file FUNCTION named `.` unless one exists — which
is the resolver's behavior too (it would strip `.&.`→`&.`, also a miss). Net: **omitting
last_segment is MORE faithful, not less**, and avoids a class of operator false-positives.
Flagged as DELTA in each call pack.

---

## DRAFT RULES (today's builtins)

### Pack 1 — `@stdlib/haskell_imports` (haskell-imports, both arms)

```prolog
% Haskell file gate (the orchestrator's detect_language Haskell stream = .hs only;
% one constant-pattern clause per the js_local_refs ENCODING NOTE — a derived gate
% cannot bind a head var, and an ext-facts join is a cross-join).
% Haskell has ONE extension, so the gate is a single ends_with filter inline.

% --- Arm A: IMPORT -> MODULE (resolveImport, ImportResolution.hs:119-130) ---
% Module resolution is by NAME (not path): IMPORT.name == MODULE.name.
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
hs_import_module(I, M) :-
    node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".hs"), attr(I, "name", Mod),
    node(M, "MODULE"), attr(M, "name", Mod).

% --- Export side: a file's exported names (buildExportIndex, ImportResolution.hs:60-93) ---
% Files WITH explicit exports: only the EXPORT_BINDING names are exported.
file_has_explicit_exports(TF) :- node(EB, "EXPORT_BINDING"), attr(EB, "file", TF).
% Explicit export entry -> the same-file declaration with that name (8 decl types).
% (The resolver's ExportEntry pairs name+nodeId; the EXPORT_BINDING node is just the
%  name marker, the target is the same-file decl — Haskell has no EXPORTS edge.)
hs_decl(TF, N, D) :- node(D, "FUNCTION"),       attr(D, "file", TF), attr(D, "name", N), neq(N, "").
hs_decl(TF, N, D) :- node(D, "VARIABLE"),       attr(D, "file", TF), attr(D, "name", N), neq(N, "").
hs_decl(TF, N, D) :- node(D, "DATA_TYPE"),      attr(D, "file", TF), attr(D, "name", N), neq(N, "").
hs_decl(TF, N, D) :- node(D, "TYPE_CLASS"),     attr(D, "file", TF), attr(D, "name", N), neq(N, "").
hs_decl(TF, N, D) :- node(D, "TYPE_SYNONYM"),   attr(D, "file", TF), attr(D, "name", N), neq(N, "").
hs_decl(TF, N, D) :- node(D, "TYPE_FAMILY"),    attr(D, "file", TF), attr(D, "name", N), neq(N, "").
hs_decl(TF, N, D) :- node(D, "CONSTRUCTOR"),    attr(D, "file", TF), attr(D, "name", N), neq(N, "").
hs_decl(TF, N, D) :- node(D, "TYPE_SIGNATURE"), attr(D, "file", TF), attr(D, "name", N), neq(N, "").

% Exported decl = name appears in EXPORT_BINDING list AND a decl of that name exists.
exported_in(TF, N, D) :-
    node(EB, "EXPORT_BINDING"), attr(EB, "file", TF), attr(EB, "name", N), neq(N, ""),
    hs_decl(TF, N, D).
% Implicit export-all: file with NO EXPORT_BINDING -> every top-level decl is exported.
exported_in(TF, N, D) :-
    hs_decl(TF, N, D), \+ file_has_explicit_exports(TF).

% --- Arm B: IMPORT_BINDING -> exported decl (resolveBinding, ImportResolution.hs:138-169) ---
% The binding's source module is GRAPH-REACHABLE via the parent IMPORT (CONTAINS),
% NO sid [in:..] parsing, NO node_attr. Module -> file via the MODULE node.
binding_src(B, LocalN, Mod) :-
    node(B, "IMPORT_BINDING"), attr(B, "file", F), ends_with(F, ".hs"), attr(B, "name", LocalN),
    edge(I, B, "CONTAINS"), node(I, "IMPORT"), attr(I, "name", Mod).
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
hs_binding_import(B, D) :-
    binding_src(B, N, Mod), node(M, "MODULE"), attr(M, "name", Mod), attr(M, "file", TF),
    exported_in(TF, N, D).
```

### Pack 2 — `@stdlib/haskell_local_refs` (haskell-local-refs, decl arm)

```prolog
% READS_FROM is SHARED vocabulary => additive. 8 decl types (HaskellLocalRefs.hs:40-45)
% NOTE: declTypes here include PARAMETER (refs to lambda/fn params) but NOT
% TYPE_SIGNATURE (refs target the value, sig is separate). Matches the resolver list.
ld(F, N, D) :- node(D, "FUNCTION"),     attr(D, "file", F), attr(D, "name", N), neq(N, "").
ld(F, N, D) :- node(D, "VARIABLE"),     attr(D, "file", F), attr(D, "name", N), neq(N, "").
ld(F, N, D) :- node(D, "CONSTANT"),     attr(D, "file", F), attr(D, "name", N), neq(N, "").
ld(F, N, D) :- node(D, "DATA_TYPE"),    attr(D, "file", F), attr(D, "name", N), neq(N, "").
ld(F, N, D) :- node(D, "TYPE_SYNONYM"), attr(D, "file", F), attr(D, "name", N), neq(N, "").
ld(F, N, D) :- node(D, "CONSTRUCTOR"),  attr(D, "file", F), attr(D, "name", N), neq(N, "").
ld(F, N, D) :- node(D, "RECORD_FIELD"), attr(D, "file", F), attr(D, "name", N), neq(N, "").
ld(F, N, D) :- node(D, "PARAMETER"),    attr(D, "file", F), attr(D, "name", N), neq(N, "").

imported(F, N) :- node(B, "IMPORT_BINDING"), attr(B, "file", F), attr(B, "name", N).

@materialize(edge_type = "READS_FROM", mode = "additive", meta(resolvedVia))
hs_local_ref(R, D, "haskell-local-refs") :-
    node(R, "REFERENCE"), attr(R, "file", F), ends_with(F, ".hs"), attr(R, "name", N),
    \+ imported(F, N),
    ld(F, N, D).
```

### Pack 2b/2c — Prelude virtual-node + READS_FROM (the `haskellPreludeNames` arm)

The resolver, on a REFERENCE that is NOT a same-file decl, checks a ~140-name compiled-in
Prelude table (HaskellLocalRefs.hs:69-99) and, if matched, mints a virtual
`EXTERNAL_FUNCTION` node `HASKELL_GLOBAL::<name>` + READS_FROM edge. Ground-facts +
two-pack node-then-edge split (the `js_runtime_globals_{facts,nodes,edges}` precedent):

```prolog
% --- haskell_prelude_facts (ground facts, the EXACT HaskellLocalRefs.hs:69-99 list) ---
hs_prelude("Just"). hs_prelude("Nothing"). hs_prelude("pure"). hs_prelude("return").
hs_prelude("show"). hs_prelude("map"). hs_prelude("filter"). hs_prelude("foldr"). % ...~140

% --- haskell_prelude_nodes (@materialize_node, exclusive) ---
@materialize_node(node_type = "EXTERNAL_FUNCTION", mode = "exclusive", meta(category, source))
hs_prelude_node(Sid, N, "", "haskell-prelude", "haskell-local-refs") :-
    node(R, "REFERENCE"), attr(R, "file", F), ends_with(F, ".hs"), attr(R, "name", N),
    \+ imported(F, N), \+ ld(F, N, _), hs_prelude(N),
    concat("HASKELL_GLOBAL::", N, Sid).

% --- haskell_prelude_edges (declared AFTER nodes; cross-pack EDB visibility) ---
@materialize(edge_type = "READS_FROM", mode = "additive", meta(resolvedVia, globalCategory))
hs_prelude_ref(R, X, "haskell-local-refs", "haskell-prelude") :-
    node(R, "REFERENCE"), attr(R, "file", F), ends_with(F, ".hs"), attr(R, "name", N),
    \+ imported(F, N), \+ ld(F, N, _), hs_prelude(N),
    node(X, "EXTERNAL_FUNCTION"), attr(X, "name", N), attr(X, "file", "").
```

(The `seen`-set dedup in the resolver, HaskellLocalRefs.hs:149-167, is subsumed by
`@materialize_node mode="exclusive"` set semantics + the `attr(X,"file","")` disambiguator so
prelude EXTERNAL_FUNCTIONs don't collide with JS/runtime ones. ⚠ verify the `file==""`
disambiguator is enough vs the js EXTERNAL_FUNCTION namespace on a mixed graph — see
honesty §.)

### Pack 3 — `@stdlib/haskell_local_calls` (haskell-local-calls)

```prolog
% 6 callable types (HaskellLocalCalls.hs:35-38). NO breakOnEnd strip (see ⚠ reality).
cd(F, N, D) :- node(D, "FUNCTION"),       attr(D, "file", F), attr(D, "name", N), neq(N, "").
cd(F, N, D) :- node(D, "VARIABLE"),       attr(D, "file", F), attr(D, "name", N), neq(N, "").
cd(F, N, D) :- node(D, "CONSTANT"),       attr(D, "file", F), attr(D, "name", N), neq(N, "").
cd(F, N, D) :- node(D, "CONSTRUCTOR"),    attr(D, "file", F), attr(D, "name", N), neq(N, "").
cd(F, N, D) :- node(D, "RECORD_FIELD"),   attr(D, "file", F), attr(D, "name", N), neq(N, "").
cd(F, N, D) :- node(D, "TYPE_SIGNATURE"), attr(D, "file", F), attr(D, "name", N), neq(N, "").

imp(F, N) :- node(B, "IMPORT_BINDING"), attr(B, "file", F), attr(B, "name", N).

@materialize(edge_type = "CALLS", mode = "additive", meta(resolvedVia))
hs_local_call(C, D, "haskell-local-calls") :-
    node(C, "CALL"), attr(C, "file", F), ends_with(F, ".hs"), attr(C, "name", N),
    \+ imp(F, N),
    cd(F, N, D).
```

### Pack 4 — `@stdlib/haskell_cross_module_calls` (haskell-cross-module-calls)

Reuses `exported_in` + `binding_src` from pack 1 conceptually (re-declared in-pack, or
piggyback on pack-1's committed IMPORTS_FROM — see ordering note). Faithful join: a CALL
whose bare name has an IMPORT_BINDING in the same file → that binding's module → exported
decl. NO breakOnEnd strip.

```prolog
% binding's source module (graph-native, as pack 1)
xb(F, N, Mod) :-
    node(B, "IMPORT_BINDING"), attr(B, "file", F), attr(B, "name", N),
    edge(I, B, "CONTAINS"), node(I, "IMPORT"), attr(I, "name", Mod).

@materialize(edge_type = "CALLS", mode = "additive", meta(resolvedVia))
hs_xmod_call(C, D, "haskell-cross-module") :-
    node(C, "CALL"), attr(C, "file", F), ends_with(F, ".hs"), attr(C, "name", N),
    xb(F, N, Mod),
    node(M, "MODULE"), attr(M, "name", Mod), attr(M, "file", TF),
    exported_in(TF, N, D).
```

(`exported_in` must be the SAME relation as pack 1 — either re-declared identically in this
pack, or pack 4 declared AFTER pack 1 and reading nothing cross-pack since `exported_in` is
an intra-pack derived; simplest is to re-declare the export-side block in each pack that
needs it, as the js packs do.)

---

## PREDICTED DELTAS (declared before diffing — predictions-first)

Partition: legacy stamps `meta.resolvedVia` per module
(`haskell-local-refs`/`haskell-local-calls`/`haskell-cross-module`); `haskell-imports`
emits unstamped IMPORTS_FROM. Pack edges carry `_source` = rule hash. Per-step slicing
is exact.

### EXACT (modulo set-semantics)
- **haskell-imports Arm A** (IMPORT→MODULE): exact. Both sides do name-equality lookup;
  resolver `Map.lookup` keeps one MODULE per name, set semantics derives all — but module
  names are unique per project in practice (one MODULE per file, name=module). Bound: extras
  ≤ count of duplicate MODULE.name (expected 0; live: MODULE "Grafema.Types" = 1).
- **haskell-imports Arm B** (IMPORT_BINDING→decl): exact for un-ambiguous names.
- **haskell-local-refs** decl arm, **haskell-local-calls**, **haskell-cross-module-calls**:
  exact for the common bare-name case.

### EXPECTED-SUPERSET (pack ⊇ legacy — enumerate-and-bound)
- **DELTA-S1 duplicate (file,name) decls**: resolver's `Map.fromList`/`Map.fromListWith`
  keeps ONE winner (Import: `filter ... (entry:_)` first; Local: `Map.fromList` last-wins);
  set semantics derives an edge to EVERY candidate. Bound: count of (file,name) decl
  collisions per type. Order-independent, strict superset.
- **DELTA-S2 implicit-export-all granularity**: `exported_in` implicit arm derives an edge
  for every decl-name in a no-export-list file; if two same-name decls exist (e.g. a
  `TYPE_SIGNATURE` and a `FUNCTION` both named `foo` — Haskell norm!), the binding resolves
  to BOTH. The resolver's ExportEntry list also held both (`++`), but `filter ... (entry:_)`
  took the first → SUBSET on the resolver side here. **Net: pack is superset.** This is
  REAL and frequent in Haskell (every function has a sibling TYPE_SIGNATURE node). Bound:
  per imported name, ≤ (# decl types sharing that name in the target file). LARGEST expected
  delta — must be counted carefully.

### EXPECTED-SUBSET (pack ⊆ legacy — must be explained, not silently dropped)
- **DELTA-B1 haskell-globals NOT ported** (wave-1): all CALLS→GLOBAL_DEFINITION from the
  effects-db SymbolDB are absent. Bound: exactly the legacy `haskell-globals` edge slice.
  Closes when the effects-db→facts pack ships (wave-2, the lang-spec corpus→generated-pack
  pattern). DECISION: keep out of wave-1, like js runtime-globals.
- **DELTA-B2 operator dotted-name calls**: the resolver's `breakOnEnd "."` would resolve a
  call named `&.` after stripping `.&.` IF a same-file decl `&.` existed (rare). The pack
  omits the strip → won't match. Bound: ≤ 112 dotted .hs CALL names project-wide, almost all
  operators with no matching local decl; expected real difference ≈ 0. (Verified: dotted
  .hs CALLs are operators, not qualified names.)

### Any delta OUTSIDE these classes = pack bug or new resolver knowledge → stop, witness
(`explain_fact`/`why()` on extras; replay resolver stderr for misses), classify, then proceed.

---

## MISSING CAPABILITIES

None are blocking for wave-1 (unlike the js spec). Enumerated for completeness:

1. **External-data-as-facts for `haskell-globals`** (NOT an engine change): the effects-db
   YAML SymbolDB → generated `hs_global(Name, ...)` facts pack + preloaded GLOBAL_DEFINITION
   nodes (the lang-spec corpus→generated-pack pattern). Wave-2. This is the ONLY resolver
   step not expressible today, and it is data-plumbing, not a builtin gap.
2. **(nice-to-have) prelude-name disambiguation** for the EXTERNAL_FUNCTION virtual node on a
   MIXED-language graph: `HASKELL_GLOBAL::map` vs a JS `map` global. The `attr(X,"file","")`
   join + the distinct semantic-id prefix should separate them, but this needs a live diff to
   confirm no collision on the real graph (the EXTERNAL_FUNCTION namespace is shared). ⚠
3. **(not needed) `node_attr`, `path_resolve`, `strip_*`**: all EXIST; Haskell uses none of
   them on the hot paths (module-by-name + graph-native CONTAINS seam). `node_attr` would
   only be touched for IMPORT `alias`/`qualified` metadata — and the resolver IGNORES those
   (it resolves by occurrence name regardless of qualification), so the pack should too.

---

## HONESTY SECTION

- **Graph freshness**: dogfood snapshot is Jun-11, HEAD Jun-13 (2 days). All probes were
  SHAPE/presence checks (node-type counts, edge existence, sid format), which are stable
  across a 2-day window; no edge-count differential was claimed from this snapshot. A real
  differential-acceptance run MUST re-analyze at HEAD first (the stale-graph lesson).
- **Spot-verified vs assumed**: IMPORT→CONTAINS→IMPORT_BINDING (100%, probed), MODULE.name
  (probed), 0 EXPORT/EXPORTS in .hs (probed), bare CALL name for qualified calls (probed +
  source-confirmed at Expressions.hs:489), IMPORT_BINDING sid `[in:Module]` (source-confirmed,
  SemanticId.hs:26 — NOT probed live, but the pack does not depend on it: it uses the
  graph-native CONTAINS seam instead). The dotted-name=operators reality is the one a naive
  port would miss (the round's lesson) — verified by sampling 5 dotted .hs CALL names.
- **`exported_in` implicit arm is the riskiest rule**: in Haskell every top-level binding
  typically has BOTH a `TYPE_SIGNATURE` node and a `FUNCTION` node with the same name, so an
  imported name will resolve to 2+ targets where the resolver took 1. This is a CORRECT
  superset (both are legitimately "the exported foo") but the differential WILL show a large
  count delta here — it must be classified as DELTA-S2, not a bug. Recommend measuring
  `hs_decl` (file,name) multiplicity on the live graph before the diff to pre-bound it.
- **Not ported, by design**: `haskell-globals` (external YAML). The daemon's msgpack/IPC
  framing, the CLI subcommand surface, and stderr diagnostics have no pack analog (the js
  precedent excludes these too).
- **Maintain envelope**: every pack uses negation (`\+ imported`/`\+ imp`/`\+ ld`) ⇒
  maintain-incremental refuses them; scratch floor applies (accepted, per the js precedent —
  these share the dominant CALL/REFERENCE/IMPORT_BINDING base scans served by build-once
  hash-join; estimate well under the ≤60s pack budget given Haskell is a fraction of the
  491k-node graph).
- **Pack ordering**: haskell_imports (produces IMPORTS_FROM) → haskell_prelude_nodes →
  haskell_prelude_edges; the call packs are independent (they re-derive their own
  export/binding seams intra-pack, the js convention). No cross-language ordering coupling.

---

## EXPRESSIBLE-NOW SUMMARY

4 of 5 resolver commands (haskell-imports, haskell-local-refs incl. prelude virtual node,
haskell-local-calls, haskell-cross-module-calls) are **fully expressible with TODAY's
builtins** — 6 packs total (imports, local_refs, prelude_facts, prelude_nodes,
prelude_edges, local_calls, cross_module_calls = 7 if counting prelude split as 3). The 5th
(haskell-globals) needs an external-data-as-facts pack (wave-2, data plumbing, not a builtin
gap). No `node_attr`/`path_resolve` dependency on any hot path — Haskell's by-name module
resolution + the graph-native IMPORT→CONTAINS→IMPORT_BINDING seam make this the SIMPLEST of
the resolver migrations.

---

## ADVERSARIAL VERDICT (independent review, 2026-06-13)

Reviewer re-read the resolver modules (`HaskellImportResolution.hs`, `HaskellLocalCalls.hs`,
`HaskellCrossModuleCalls.hs`, `HaskellLocalRefs.hs`), the analyzer emission
(`Imports.hs`, `Expressions.hs:485-495`), the live `derive/builtin.rs` registry + mode tables,
and ran LIVE probes on a `/tmp` copy of the dogfood graph (491,535 nodes; own server, cleaned up).

### CONFIRMED by independent evidence
- Builtin set + modes verified at `builtin.rs:1119-1188`: `node_attr` is `[B,B,F]`/`[B,B,B]` (NO
  generator). `strip_prefix`/`strip_suffix` produce NO row on non-match; `last_segment` is
  identity-on-no-sep. No `first_segment`. The spec uses only existing builtins correctly.
- CALL "lookup"=304, "Map.lookup"=0 in .hs (LIVE) — the qualifier-strip "round's lesson" catch
  (Expressions.hs:489 `occNameString (rdrNameOcc name)`) is REAL and correct.
- IMPORT_BINDING→CONTAINS→IMPORT = 2498/2498 (LIVE) — graph-native seam claim holds.
- 835 EXPORT_BINDING, 0 EXPORT nodes in .hs (LIVE) — export-as-name-match model holds.
- 814 module-level IMPORTS_FROM edges exist (LIVE) — `resolveImport` (IMPORT→MODULE by name) ran.

### ⚠ THE ONE REALITY THIS SPEC MISSED (the round's lesson, and it is load-bearing)
**The cross-module CALLS / import-binding IMPORTS_FROM edges target the EXPORT_BINDING node, NOT
the declaration node, for explicitly-exported modules.** Evidence:
- SOURCE: `HaskellImportResolution.resolveBinding` and `HaskellCrossModuleCalls` both build
  `buildExportIndex` where `explicitExports = ExportEntry (gnName n) (gnId n)` over EXPORT_BINDING
  nodes (ImportResolution.hs:62-67, CrossModuleCalls.hs:62-66). The emitted edge is
  `geTarget = exNodeId entry` — i.e. the **EXPORT_BINDING's own id** when the target file has any
  explicit exports. Only the IMPLICIT-export-all branch targets a real decl.
- LIVE: in the dogfood graph, **CALLS target=EXPORT_BINDING = 1618** vs CALLS target=FUNCTION = 2310,
  CONSTRUCTOR = 152, EXTERNAL_FUNCTION = 3615. EXPORT_BINDING is a *plurality* of cross-module
  resolved CALLS targets — it is NOT a corner case.

The spec's Pack 1 Arm B (`hs_binding_import(B, D) :- ... exported_in(TF, N, D)`) and Pack 4
(`hs_xmod_call(C, D, ...) :- ... exported_in(TF, N, D)`) resolve to the **decl `D`** (FUNCTION /
DATA_TYPE / etc.). For explicitly-exported names the legacy resolves to the **EXPORT_BINDING**.
=> the pack's edge TARGET differs from legacy on every explicit-export edge. This is NOT an
EXACT delta; it is a **target-identity SUPERSET/MISMATCH** that the spec's PREDICTED DELTAS,
HEADLINE point 3, and HONESTY section all get wrong (they all treat the target as the decl).
**FIX:** `exported_in` must split: for a file WITH explicit exports, the target is the
EXPORT_BINDING node itself (`exported_in(TF, N, EB) :- node(EB,"EXPORT_BINDING"), attr(EB,"file",TF),
attr(EB,"name",N)`); only for files with NO EXPORT_BINDING does it target a decl. This is two
arms, both expressible today (the `file_has_explicit_exports` gate already exists in the draft —
it just routes to the wrong target).

### ⚠ SECOND MISS — decl-type lists over-include vs the resolver's last-wins Map
- LIVE: CALLS target=TYPE_SIGNATURE = 0, VARIABLE = 0, DATA_TYPE = 0. READS_FROM target
  TYPE_SIGNATURE = 0, VARIABLE = 0, DATA_TYPE = 0 (PARAMETER = 11324, FUNCTION = 5103,
  EXTERNAL_FUNCTION = 4986, CONSTRUCTOR/RECORD_FIELD small).
- The resolver builds `declIdx = Map.fromList [((file,name), id)]` (LocalCalls.hs:40-46) — LAST-WINS,
  ONE id per (file,name). The spec's `cd`/`ld` derive an edge to EVERY callable/decl sharing
  (file,name) under set-semantics. Since the live graph shows ZERO edges ever landing on
  TYPE_SIGNATURE/VARIABLE/DATA_TYPE, including those types in `cd`/`ld` would emit edges the legacy
  never produced => SUPERSET, not "faithful". The spec's DELTA-S2 ("TYPE_SIGNATURE+FUNCTION pairing
  → 2+ targets") is real in DIRECTION but the spec mis-frames it as a property of the *legacy* taking
  one — the live data shows the legacy targets the FUNCTION and NEVER the TYPE_SIGNATURE, so the
  superset is entirely pack-introduced. **FIX/BOUND:** either drop TYPE_SIGNATURE/VARIABLE/DATA_TYPE
  from the call/ref decl sets (they contribute 0 legacy edges), or accept and explicitly bound the
  superset by the (file,name) collision count — but do NOT call it EXACT.

### ⚠ THIRD MISS — Prelude EXTERNAL_FUNCTION disambiguator is empirically wrong
- LIVE: `EXTERNAL_FUNCTION` with `attr(X,"file","") = 0` rows; 99 EXTERNAL_FUNCTION nodes total.
  The spec's Pack 2b/2c uses `node(X,"EXTERNAL_FUNCTION"), attr(X,"name",N), attr(X,"file","")` as
  the join/disambiguator — that join matches ZERO existing nodes, so the proposed edge rule would
  derive nothing against the current namespace, and the mint's collision-avoidance premise is
  untested (no file="" EXTERNAL_FUNCTION exists). The spec already flagged this ⚠ as needing a live
  diff; the live diff says the `file==""` assumption does not hold on this graph. **Re-derive the
  disambiguator** (e.g. by the `HASKELL_GLOBAL::` sid prefix the mint itself uses) before relying on it.

### NON-BLOCKING / accepted
- haskell-globals correctly deferred (external YAML, wave-2). Maintain-envelope (negation→scratch)
  correctly noted. Module-by-name Arm A is genuinely EXACT and the simplest arm.

### COULD-NOT-VERIFY (honest gap)
- IMPORT_BINDING→IMPORTS_FROM = **0** in the dogfood snapshot (the binding-level import arm produced
  NO edges, while the module-level arm produced 814). So the explicit-export-target finding for the
  IMPORTS_FROM Arm B is SOURCE-grounded only; it is LIVE-confirmed for the structurally-identical
  CALLS cross-module arm (CALLS→EXPORT_BINDING=1618). The differential-acceptance run must re-analyze
  at HEAD (the binding arm may be a separate orchestrator gap worth recording independently).

### READY FOR PACKS: **NO** — fix the EXPORT_BINDING-vs-decl target split (blocking) and the
decl-type over-inclusion (correctness/superset) first. After those two fixes the 4 commands are
expressible today; the spec's "simplest migration" thesis survives, but its delta classes do not.
