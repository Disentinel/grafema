# Migration Spec: go-resolve → derive packs (Datalog v2)

Follows the discipline of `_ai/research/resolve-datalog2-migration-specs.json` (js/rust precedent)
and the synthesis ledger. All evidence from feat/datalog worktree HEAD `9ac0681c` (v0.4.0).
Self-contained; sections are JSON-able in the precedent's `{spec: {target, purpose, sub_steps[],
missing_capabilities[], differential_acceptance, expected_speedup_rationale, notes}}` shape.

---

## target

`go-resolve` (binary `go-resolve --daemon`, packages/go-resolve/src/: Main.hs dispatching 5 modules
via the single orchestrator command `go-all` — Main.hs:72-80 runs imports → calls → interfaces →
types → context, feeding the CALLS EmitEdge output of step 2 into step 5 via extractCallEdges
Main.hs:84-87). Driven by orchestrator main.rs:1673-1714 (analyze path) and main.rs:2573-2607
(re-resolve path): streams ONLY `Language::Go` nodes (`&[config::Language::Go]` filter) to the
daemon plus a `workspace_packages` wire carrying the go.mod module path
(config::discover_go_module_path, config.rs:846-865; main.rs:1677-1686 wraps it as a single
WorkspacePackageWire whose `name` IS the module path — Main.hs:61-63 extractModulePath takes
`wpName` of the first entry).

## purpose

Go cross-file resolution: materializes
- **IMPORTS_FROM** (IMPORT → MODULE, same-module only; GoImportResolution.hs)
- **CALLS** (CALL → FUNCTION, 3 strategies; GoCallResolution.hs)
- **IMPLEMENTS** (CLASS → INTERFACE, structural duck-typing by method-set subset; GoInterfaceSatisfaction.hs)
- **TYPE_OF** (VARIABLE → CLASS/INTERFACE; GoTypeResolution.hs:73-88)
- **RETURNS** (FUNCTION → CLASS/INTERFACE per comma-separated return type; GoTypeResolution.hs:95-111)
- **PROPAGATES_CONTEXT** (FUNCTION → FUNCTION), **SPAWNS_WITH_CONTEXT** / **DEFERS_WITH_CONTEXT**
  (CALL → FUNCTION) — context.Context flow; GoContextPropagation.hs.

All legacy edges carry EMPTY metadata (every emitCallsEdge/EmitEdge site: ImportResolution:138-144,
CallResolution:241-248, InterfaceSatisfaction:137-142, TypeResolution:75-79/97-101) — EXCEPT
context edges for "possible" targets which carry `unresolved=true` (MetaBool, ContextPropagation:149-152).
No `resolvedVia` stamps anywhere (unlike js/rust legacy).

Inputs split — GRAPH data: MODULE/IMPORT/CALL/FUNCTION/CLASS/INTERFACE/VARIABLE nodes + their
metadata. EXTERNAL data: the go.mod module path (wire-only today — never committed to the graph;
precondition P1 below).

## analyzer vocabulary (what go-analyzer emits that the resolver consumes — verified in source)

Node types (packages/go-analyzer/src/):
- `MODULE` — one per .go file; name = module-ish name, metadata `package` (Walker.hs:32-44).
- `IMPORT` — name = import path; metadata `path` (=name), `blank`, `dot` (MetaBool),
  optional `alias`, and `local_name` (the effective local identifier) (Imports.hs:63-80).
- `CALL` — name = `recv.Sel` or bare ident (`exprToName`, Calls.hs:74-77); metadata `argCount`,
  optional `receiver` (= exprToName of selector base — an EXPRESSION name, not a type),
  `goroutine`/`deferred` (MetaBool, only when true) (Calls.hs:96-129).
- `FUNCTION` — metadata `kind` ∈ {`function`, `method`, `interface_method`, `closure`},
  `paramCount`, `returnCount`; functions/methods: optional `return_type` =
  `T.intercalate "," (map goTypeToName results)` — **comma-joined, NO spaces**
  (Declarations.hs:126-128 / :197-199; goTypeToName :639-650 never emits a comma);
  methods additionally `receiver` = bare receiver TYPE name (`grTypeName`, :162,192 —
  pointer-ness is the separate `pointer_receiver` bool), and
  `accepts_context`/`possible_context` + `context_param_index`, `returns_error` (:95-109,:166-178).
- `CLASS` (struct/named type, Declarations.hs:235-252,:318-339), `INTERFACE` (:266-283),
  `VARIABLE` (metadata `type` = goTypeToName, walkVarSpec :491+).

Edges:
- `CONTAINS` everywhere (23 sites): MODULE→IMPORT (Imports.hs:83-88), scope→FUNCTION/CLASS/INTERFACE/
  VARIABLE, **INTERFACE→FUNCTION(kind=interface_method)** (Declarations.hs:466-472), and
  **scope→CALL** (Calls.hs:132-138). Critically: `Rules/ControlFlow.hs` creates NO scopes
  (`grep -c withScope ControlFlow.hs` = 0) — only function/method/closure bodies push a scope
  (Declarations.hs:145-152, Calls.hs FuncLitNode), so a CALL's CONTAINS source is exactly its
  enclosing FUNCTION (or closure FUNCTION, or the MODULE for top-level initializers).
  This is the structural substitute for every `[in:Parent]` semantic-id parse in the resolver
  (same move as js_same_file_calls.dl DELTA 3: "class membership is structural truth").
- Analyzer also emits CALLS/IMPORTS_FROM **DeferredRef**s (faUnresolvedRefs) — the orchestrator
  turns unresolved ones into ISSUE diagnostics only (analyzer.rs:580-602), NEVER into CALLS edges.
  So graph CALLS edges on .go files come exclusively from go-resolve → a pack consuming
  materialized CALLS (step 9/10) sees exactly the go_calls pack output.

## preconditions (orchestrator, not engine)

- **P1 — GO module-path fact.** The go.mod module path must become a graph fact. Exact precedent
  exists: WORKSPACE_PACKAGE facts committed at main.rs:2017-2032 for js packs
  (js_module_imports.dl:157-158 joins `node(W,"WORKSPACE_PACKAGE"), attr(W,"name",N)`).
  Commit the Go module path the same way (suggest type `WORKSPACE_PACKAGE` with
  `node_attr(W,"language","go")`, name = module path) from the already-computed
  `discover_go_module_path` value (main.rs:1677). Zero engine work.
- **P2 — pack ordering (producer-before-consumer).** `go_calls` produces CALLS that `go_context`
  consumes via `edge(C,T,"CALLS")` — declared pack order, same as rust_imports.dl's ORDERING
  note (IMPORTS_FROM before js_cross_file_calls). Legacy did this in-process
  (Main.hs:78-79 extractCallEdges).
- **P3 — no-go.mod fallback selection.** Legacy branches globally on empty module path
  (ImportResolution.hs:131-135 findBySuffix). A pack cannot test "the GO_MODULE fact does not
  exist" without a zero-arity/global predicate (a `has_go_mod()` literal shares no variable with
  the body — the §3 cross-join the planner refuses, cf. js_this_method_calls.dl:38-41).
  Faithful translation: the ORCHESTRATOR (which knows whether go.mod resolved) loads either the
  main pack or the suffix-fallback variant. Listed under missing capabilities as the engine
  alternative.

## sub_steps

### 1. package-index kernel (shared; no edges)

- **reads**: MODULE nodes (first-class `file`), GO module-path fact (P1).
- **writes**: derived relations `mod_dir(M, D)` / `module_in_dir(D, M)` / `pkg_dir(ImportPath, D)`
  consumed by steps 2-3. Legacy: buildPackageIndex (ImportResolution.hs:57-64 — dir → [moduleIds];
  CallResolution.hs:118-128 — importPath → dir, with modPath-prefixed, root, and bare-dir keys).
- **expressible**: yes (fully).
- **idioms**:
  - *dirname* (no dirname builtin): `basename` + `concat("/",B,SB)` + `strip_suffix(F,SB,D)`;
    root-level files ("main.go") yield NO row from strip_suffix → complement clause via
    derived-negation (`\+` on a derived has-subdir predicate), since there is no
    `not_string_contains` builtin (only `not_starts_with`, builtin.rs:1268-1273).
  - *file gate* (DELTA-5 of rust_imports.dl): `ends_with(F, ".go")` on every base relation —
    MODULE/IMPORT/CALL/FUNCTION/CLASS/INTERFACE/VARIABLE are shared vocabulary across analyzers;
    the legacy input gate was the orchestrator's Language::Go stream filter (config.rs:751,796).
- **draft_rules**:
```datalog
go_mod(MP)        :- node(W, "WORKSPACE_PACKAGE"), node_attr(W, "language", "go"), attr(W, "name", MP).
go_module(M, F)   :- node(M, "MODULE"), attr(M, "file", F), ends_with(F, ".go").
mod_dir(M, D)     :- go_module(M, F), basename(F, B), concat("/", B, SB), strip_suffix(F, SB, D).
mod_subdir(M)     :- mod_dir(M, _).
module_in_dir(D, M)  :- mod_dir(M, D).
module_in_dir("", M) :- go_module(M, _), \+ mod_subdir(M).
% import-path -> package-dir map (all three legacy key families, CallResolution.hs:118-128)
pkg_dir(P, D)     :- mod_dir(_, D), go_mod(MP), concat(MP, "/", MPS), concat(MPS, D, P).
pkg_dir(MP, "")   :- go_mod(MP), module_in_dir("", _).
pkg_dir(D, D)     :- mod_dir(_, D).
```
- **delta**: EXACT (a pure index reformulation).

### 2. go-imports → IMPORTS_FROM (pack `go_imports.dl`)

- **reads**: IMPORT nodes (`node_attr path`), kernel relations, go_mod fact.
  Legacy: GoImportResolution.resolveOneImport (:116-145) — skip stdlib (isStdLib :87, "no dot in
  first path segment"), strip module prefix + dropWhile '/' (:123-126), look up dir, emit edge to
  **first** MODULE in dir (:129); empty-modPath fallback = first dir that is a suffix of the
  import path, Map order (findBySuffix :152-163). Blank/dot imports resolve normally (:34-35).
- **writes**: IMPORTS_FROM (IMPORT → MODULE), empty metadata. SHARED vocabulary (js/rust packs
  also emit it) ⇒ `mode = "additive"`.
- **expressible**: yes (main arms); fallback arm needs P3.
- **draft_rules**:
```datalog
go_import(I, F, P) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".go"),
                      node_attr(I, "path", P).

@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
go_import_from(I, M) :- go_import(I, _, P), go_mod(MP), concat(MP, "/", MPS),
                        strip_prefix(P, MPS, Rel), module_in_dir(Rel, M).
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
go_import_from_root(I, M) :- go_import(I, _, P), go_mod(P), module_in_dir("", M).

% fallback VARIANT pack (loaded by orchestrator only when go.mod is absent, P3):
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
go_import_suffix(I, M) :- go_import(I, _, P), string_contains(P, "."),
                          module_in_dir(D, M), neq(D, ""), ends_with(P, D).
```
- **deltas**:
  - DELTA G2-1 (REFINED — the isStdLib guard is dropped from the same-module arm): redundant
    there — a stdlib path ("fmt", "net/http") cannot start with `<modPath>/`. Diverges only if
    the module path itself collides with a stdlib name (pathological). The legacy
    plain-stripPrefix boundary bug (modPath "…/p" string-prefix-matches "…/project2" then fails
    the dir lookup, :123-126) is removed by requiring the "/" boundary; net effect on emitted
    edges: none (legacy resolved those to a miss anyway).
  - DELTA G2-2 (SUPERSET, bounded by files-per-package): legacy takes the FIRST MODULE id in the
    target directory (`tid : _`, :129 — fold/insertion order, nondeterministic across runs);
    set semantics derives one edge per MODULE node (= per .go file) in the package directory.
    Arguably truer (a Go package IS the directory). Bound: #files in the imported package.
  - DELTA G2-3 (fallback arm, MIXED): legacy fallback picks the alphabetically-first suffix-matching
    dir (Map.toList order, :152-163) — the pack derives ALL suffix matches (SUPERSET, bound:
    #dirs sharing the suffix). The `string_contains(P,".")` stdlib approximation replaces
    "first segment has a dot": SUBSET for dotless module paths (`module myapp` imports
    "myapp/util" — no dot anywhere → skipped where legacy's isStdLib ALSO skips it ("myapp" has
    no dot) — actually EXACT for that case); residual divergence only for paths whose first
    segment is dotless but a later segment has one ("foo/bar.v2" — legacy skips, pack keeps):
    SUPERSET gated on a local dir literally suffix-matching such a path, ~0 in practice.
    Exact fix = `first_segment` builtin (missing capability M1).

### 3. go-calls strategy 1 — package-qualified CALLS (pack `go_calls.dl`)

- **reads**: CALL nodes (`receiver` metadata, dotted `name`), IMPORT nodes in the SAME file
  (`local_name`+`path`), kernel pkg_dir, FUNCTION nodes kind=function.
  Legacy: resolveCall :157-174 dispatch (receiver matches an import alias in the caller's file →
  strategy 1 ONLY, no fallback) + resolvePackageCall :188-210 (isStdLib skip; importPath → dir
  via pkgIdx with modPath-strip fallback; (dir, callName) lookup; callName = after last ".",
  extractCallName :54-57).
- **writes**: CALLS (CALL → FUNCTION), empty metadata, additive (shared vocabulary).
- **expressible**: yes.
- **draft_rules**:
```datalog
go_call(C, F, N)   :- node(C, "CALL"), attr(C, "file", F), ends_with(F, ".go"), attr(C, "name", N).
call_recv(C, R)    :- go_call(C, _, _), node_attr(C, "receiver", R).
import_alias(F, L, P) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".go"),
                         node_attr(I, "local_name", L), node_attr(I, "path", P).
fn_dir(T, D)       :- go_fn(T, TF), basename(TF, B), concat("/", B, SB), strip_suffix(TF, SB, D).
go_fn(T, TF)       :- node(T, "FUNCTION"), attr(T, "file", TF), ends_with(TF, ".go"),
                      node_attr(T, "kind", "function").
fn_subdir(T)       :- fn_dir(T, _).
func_in_dir(D, N, T)  :- go_fn(T, _), fn_dir(T, D), attr(T, "name", N).
func_in_dir("", N, T) :- go_fn(T, _), \+ fn_subdir(T), attr(T, "name", N).
% non-stdlib gate (approximation, see DELTA G3-2):
ok_path(P) :- import_alias(_, _, P), string_contains(P, ".").
ok_path(P) :- import_alias(_, _, P), go_mod(MP), concat(MP, "/", MPS), strip_prefix(P, MPS, _).

@materialize(edge_type = "CALLS", mode = "additive")
go_call_s1(C, T) :- call_recv(C, R), go_call(C, F, N), import_alias(F, R, P), ok_path(P),
                    pkg_dir(P, D), method_suffix(N, MN), func_in_dir(D, MN, T).
```
- **deltas**:
  - DELTA G3-1 (SUPERSET, bounded): FunctionIndex was `Map.fromList` = LAST-wins on duplicate
    (dir, name) keys (CallResolution.hs:91-100) — duplicates arise from build-tag twins or
    `_test.go` siblings defining the same name in one directory. Set semantics derives all
    candidates. Bound: #same-name functions per directory (≈1-2; measure on fixture).
  - DELTA G3-2 (the isStdLib approximation): exactly DELTA G2-3's classes; additionally the
    bare-dir pkg_dir keys can let a stdlib-named LOCAL directory ("errors/", "log/") capture a
    qualified call when no dot guard fires — the `ok_path` guard closes that (a dotless,
    non-module-prefixed path never passes). Residual: same "foo/bar.v2"-shape SUPERSET as G2-3.

### 4. go-calls strategy 2 — same-package function CALLS

- **reads**: CALL nodes with NO `receiver` metadata; FUNCTION kind=function in the caller's dir.
  Legacy: resolveSamePackageCall :213-222 — (callerDir, callName) lookup.
- **expressible**: yes — "no receiver" via stratified negation over a derived predicate
  (node_attr modes [B,B,F]/[B,B,B], builtin.rs:1176-1180, allow the free-value probe).
- **draft_rules**:
```datalog
has_recv(C)   :- node(C, "CALL"), node_attr(C, "receiver", _).
call_dir(C, D)   :- go_call(C, F, _), basename(F, B), concat("/", B, SB), strip_suffix(F, SB, D).
call_subdir(C)   :- call_dir(C, _).

@materialize(edge_type = "CALLS", mode = "additive")
go_call_s2(C, T) :- go_call(C, F, N), \+ has_recv(C), call_dir(C, D), func_in_dir(D, N, T).
@materialize(edge_type = "CALLS", mode = "additive")
go_call_s2r(C, T) :- go_call(C, F, N), \+ has_recv(C), \+ call_subdir(C), func_in_dir("", N, T).
```
  (receiver-less names are never dotted — exprToName of a non-selector is the bare ident,
  Calls.hs:74-77 — so N needs no extractCallName treatment; closures excluded from func_in_dir
  by the kind="function" gate, matching Spec.hs:141-148.)
- **deltas**: DELTA G3-1 (last-wins) applies identically. Otherwise EXACT.

### 5. go-calls strategy 3 — same-package method CALLS

- **reads**: CALL nodes whose `receiver` does NOT match any import alias in the same file;
  FUNCTION kind=method nodes (`receiver` = bare TYPE name, Declarations.hs:162,192).
  Legacy: resolveMethodCall :227-236 — global (receiverTYPE, method) MethodIndex; the call's
  receiver is an EXPRESSION name, so this only hits when a variable shares the type's name
  (the known weakness; fixture Spec.hs:120-127 encodes exactly that shape).
- **expressible**: yes.
- **draft_rules**:
```datalog
alias_recv(C) :- call_recv(C, R), go_call(C, F, _), import_alias(F, R, _).
method_in(RT, MN, T) :- node(T, "FUNCTION"), attr(T, "file", TF), ends_with(TF, ".go"),
                        node_attr(T, "kind", "method"), node_attr(T, "receiver", RT),
                        attr(T, "name", MN).

@materialize(edge_type = "CALLS", mode = "additive")
go_call_s3(C, T) :- call_recv(C, R), \+ alias_recv(C), go_call(C, _, N),
                    method_suffix(N, MN), method_in(R, MN, T).
```
- **deltas**:
  - DELTA G5-1 (SUPERSET, bounded): MethodIndex is GLOBAL last-wins across packages
    (CallResolution.hs:103-112) — same-named type with same-named method in two packages: legacy
    picks one arbitrary winner, the pack derives all. A dir-scoped variant (join receiver-type's
    dir to the call's dir) would REFINE instead — defer to the differential to choose
    (rust_imports DELTA-1 governed-arm precedent).
  - NOT attempted (parity): real receiver typing (variable name → VARIABLE → TYPE_OF → methods).
    That is a Wave-2 REFINEMENT with the rust_receiver_typing.dl precedent, not a parity rule.

### 6. go-interfaces → IMPLEMENTS (pack `go_interfaces.dl`)

- **reads**: INTERFACE nodes + their method FUNCTIONs (kind=interface_method; parent interface
  extracted by legacy from the `[in:Iface]` semantic-id suffix, GoInterfaceSatisfaction.hs:64-101 —
  pack substitutes the structural INTERFACE -CONTAINS-> FUNCTION edge, Declarations.hs:466-472);
  FUNCTION kind=method (`receiver` type name); CLASS nodes by name.
  Legacy algorithm :132-148: non-empty interface method set ⊆ struct method set → IMPLEMENTS
  (name-only matching; pointer/value both match — receiver metadata is the bare name).
- **writes**: IMPLEMENTS (CLASS → INTERFACE), empty metadata. Go-only producer today, but keep
  additive (vocabulary may be shared later).
- **expressible**: yes — the ∀-subset via TWO strata of negation; the CLASS×INTERFACE candidate
  cross-product is planner-illegal (§3 cross-join), so candidates are seeded through a shared
  method NAME — sound because implementing a non-empty interface requires sharing ≥1 method name
  (filter-before-generator).
- **draft_rules**:
```datalog
iface_m(I, MN) :- node(I, "INTERFACE"), attr(I, "file", IF), ends_with(IF, ".go"),
                  edge(I, MF, "CONTAINS"), node(MF, "FUNCTION"),
                  node_attr(MF, "kind", "interface_method"), attr(MF, "name", MN).
recv_m(SN, MN) :- node(MF, "FUNCTION"), attr(MF, "file", MFF), ends_with(MFF, ".go"),
                  node_attr(MF, "kind", "method"), node_attr(MF, "receiver", SN),
                  attr(MF, "name", MN).
struct_m(S, MN) :- node(S, "CLASS"), attr(S, "file", SF), ends_with(SF, ".go"),
                   attr(S, "name", SN), recv_m(SN, MN).
cand(S, I)  :- struct_m(S, MN), iface_m(I, MN).
lacks(S, I) :- cand(S, I), iface_m(I, MN2), \+ struct_m(S, MN2).

@materialize(edge_type = "IMPLEMENTS", mode = "additive")
go_implements(S, I) :- cand(S, I), \+ lacks(S, I).
```
- **deltas**:
  - DELTA G6-1 (structural substitute, EXACT in practice): CONTAINS instead of `[in:Iface]`
    parsing — the analyzer always emits both for the same construct (Declarations.hs:445-472),
    so coverage is identical (js_same_file_calls DELTA-3 precedent).
  - DELTA G6-2 (SUPERSET, bounded): legacy StructIndex AND StructMethodSet are global,
    name-keyed (:108-126) — two same-named structs in different packages MERGE method sets
    (a legacy false-positive generator) and only the last-wins CLASS id gets the edge. The pack
    reproduces the name-keyed merge (parity) but emits the edge for EVERY same-named CLASS.
    Bound: #duplicate struct names. A dir-scoped struct_m join (methods live in the type's
    package — a Go language guarantee) is the REFINED variant; recommend measuring both in the
    differential, expecting refined ⊆ parity with the difference = legacy's own false merges.
  - Interface EXTENDS embedding stays un-expanded (legacy Phase-2 limitation :25-30) — parity.

### 7. go-types → TYPE_OF (pack `go_types.dl`)

- **reads**: VARIABLE nodes (`type` metadata = goTypeToName), CLASS+INTERFACE nodes by name.
  Legacy: GoTypeResolution.hs:73-88 — recursive `*`/`[]` prefix strip (:47-51), 22-primitive skip
  (:27-34), global name → id TypeIndex (last-wins, :60-66).
- **expressible**: yes — the recursive strip is a recursive derived predicate over shrinking
  strings (terminates); primitives are 22 ground facts (`ground facts parse`,
  datalog/parser.rs:265-267 per the js spec's evidence note).
- **draft_rules**:
```datalog
go_primitive("int"). go_primitive("int8"). go_primitive("int16"). go_primitive("int32").
go_primitive("int64"). go_primitive("uint"). go_primitive("uint8"). go_primitive("uint16").
go_primitive("uint32"). go_primitive("uint64"). go_primitive("uintptr"). go_primitive("float32").
go_primitive("float64"). go_primitive("complex64"). go_primitive("complex128").
go_primitive("string"). go_primitive("bool"). go_primitive("byte"). go_primitive("rune").
go_primitive("error"). go_primitive("any").

vt(V, T)  :- node(V, "VARIABLE"), attr(V, "file", F), ends_with(F, ".go"),
             node_attr(V, "type", T).
vt(V, T2) :- vt(V, T), strip_prefix(T, "*", T2).
vt(V, T2) :- vt(V, T), strip_prefix(T, "[]", T2).
vt_clean(V, T) :- vt(V, T), not_starts_with(T, "*"), not_starts_with(T, "["), neq(T, "").
type_node(N, Ty) :- node(Ty, "CLASS"), attr(Ty, "file", TF), ends_with(TF, ".go"), attr(Ty, "name", N).
type_node(N, Ty) :- node(Ty, "INTERFACE"), attr(Ty, "file", TF), ends_with(TF, ".go"), attr(Ty, "name", N).

@materialize(edge_type = "TYPE_OF", mode = "additive")
go_type_of(V, Ty) :- vt_clean(V, T), \+ go_primitive(T), type_node(T, Ty).
```
  (`not_starts_with(T,"[")` over-approximates `"[]"` only for map types "map[…" — those never
  match type_node anyway; spelled `"["` because not_starts_with is FILTER2 and "[]"-exactness
  needs two literals — use `not_starts_with(T, "[]")` directly; both are [B,B] legal.)
- **deltas**: DELTA G7-1 (SUPERSET, bounded by duplicate type names): TypeIndex last-wins global —
  same class as G5-1/G6-2. Qualified types ("pkg.User"), map/chan/func types never resolved in
  legacy and never resolve here (no type_node key) — parity for free.

### 8. go-types → RETURNS

- **reads**: FUNCTION nodes' `return_type` metadata — comma-joined, NO spaces
  (Declarations.hs:126-128; goTypeToName emits no commas, so the join is unambiguous).
  Legacy: :95-111 — splitOn "," + T.strip + same strip/primitive/index pipeline.
- **expressible**: yes — comma-SPLIT via right-peeling recursion with `last_segment`
  (identity-when-no-separator semantics, builtin.rs:945-953) + `concat` + `strip_suffix`;
  no `split` builtin needed:
- **draft_rules**:
```datalog
rt(Fn, R)  :- node(Fn, "FUNCTION"), attr(Fn, "file", F), ends_with(F, ".go"),
              node_attr(Fn, "return_type", R).
rt(Fn, R2) :- rt(Fn, R), last_segment(R, ",", L), concat(",", L, CL), strip_suffix(R, CL, R2).
ret0(Fn, T)  :- rt(Fn, R), last_segment(R, ",", T).
ret0(Fn, T2) :- ret0(Fn, T), strip_prefix(T, "*", T2).
ret0(Fn, T2) :- ret0(Fn, T), strip_prefix(T, "[]", T2).
ret_clean(Fn, T) :- ret0(Fn, T), not_starts_with(T, "*"), not_starts_with(T, "[]"), neq(T, "").

@materialize(edge_type = "RETURNS", mode = "additive")
go_returns(Fn, Ty) :- ret_clean(Fn, T), \+ go_primitive(T), type_node(T, Ty).
```
- **deltas**: G7-1 applies. The legacy `T.strip` is a no-op on this metadata (no spaces emitted) —
  EXACT. Legacy emits one edge PER comma part including duplicates of the same type
  (e.g. "(*User, *User)") — list-comprehension duplicates collapse in the graph's edge-set
  semantics for legacy too, so set semantics is EXACT.

### 9. go-context → PROPAGATES_CONTEXT (pack `go_context.dl`, AFTER go_calls — P2)

- **reads**: materialized CALLS edges (go files only — see analyzer-vocabulary note: Go CALLS come
  exclusively from the go packs); FUNCTION `accepts_context`/`possible_context` (MetaBool —
  surfaces as the string "true" via node_attr, the `__exported`/Wave-M contract documented in
  rust_imports.dl:26-28); the CALL's enclosing FUNCTION.
  Legacy: GoContextPropagation.hs — contextFns/possibleFns (:79-94), enclosing fn via
  `[in:parent]` + (dir, bare-name) lookup EXCLUDING interface_method and closure kinds
  (:101-112, :154-161); emit PROPAGATES_CONTEXT(encFn → target) when target accepts (certainly
  or possibly) AND caller accepts; `unresolved=true` metadata iff the TARGET is only "possible"
  (:141-176 — the caller's certainty does not affect metadata, fixture Spec.hs:288-301).
- **expressible**: yes.
- **draft_rules**:
```datalog
ctx_fn(T)  :- node(T, "FUNCTION"), node_attr(T, "accepts_context", "true").
poss_fn(T) :- node(T, "FUNCTION"), node_attr(T, "possible_context", "true").
go_calls_e(C, T) :- node(C, "CALL"), attr(C, "file", F), ends_with(F, ".go"),
                    edge(C, T, "CALLS"), node(T, "FUNCTION").
closure_fn(EF) :- node(EF, "FUNCTION"), node_attr(EF, "kind", "closure").
iface_fn(EF)   :- node(EF, "FUNCTION"), node_attr(EF, "kind", "interface_method").
enc_fn(C, EF)  :- go_calls_e(C, _), edge(EF, C, "CONTAINS"), node(EF, "FUNCTION"),
                  \+ closure_fn(EF), \+ iface_fn(EF).
caller_ok(C)   :- enc_fn(C, EF), ctx_fn(EF).
caller_ok(C)   :- enc_fn(C, EF), poss_fn(EF).

@materialize(edge_type = "PROPAGATES_CONTEXT", mode = "additive")
go_prop(EF, T) :- go_calls_e(C, T), ctx_fn(T), caller_ok(C), enc_fn(C, EF).
@materialize(edge_type = "PROPAGATES_CONTEXT", mode = "additive", meta(unresolved))
go_prop_u(EF, T, "true") :- go_calls_e(C, T), poss_fn(T), caller_ok(C), enc_fn(C, EF).
```
  (accepts/possible are mutually exclusive per function — the analyzer's contextMeta picks one,
  Declarations.hs:99-105 — so no `\+ ctx_fn(T)` guard is needed on the possible arm.)
- **deltas**:
  - DELTA G9-1 (structural substitute, REFINED): enclosing fn = the literal CONTAINS parent
    instead of the legacy (dir, parsed-bare-name) lookup, which could hit a DIFFERENT same-named
    function/method in the directory (its Map is also last-wins, :104-112). Refinement removes
    a legacy false-positive/false-negative class; bound = #same-bare-name functions per dir.
    Calls inside closures: legacy finds no enclosing fn (closures excluded from the index AND the
    `[in:]` name is "<closure>") → caller_ok false; the pack's CONTAINS parent IS the closure
    node, excluded by `\+ closure_fn` → caller_ok false. EXACT match on that class.
  - DELTA G9-2 (metadata representation): `unresolved` = string "true" (meta projection) vs
    legacy MetaBool true — same class as the js packs' resolvedVia-projection delta; consumers
    reading via node_attr/edge_attr string surface see the identical "true".

### 10. go-context → SPAWNS_WITH_CONTEXT / DEFERS_WITH_CONTEXT

- **reads**: as step 9 + CALL `goroutine`/`deferred` MetaBool flags (Calls.hs:127-128;
  only stamped when true).
  Legacy: :177-194 — CALL → target FUNCTION when target accepts (or possibly accepts) context,
  independent of the caller's own context status.
- **expressible**: yes.
- **draft_rules**:
```datalog
@materialize(edge_type = "SPAWNS_WITH_CONTEXT", mode = "additive")
go_spawn(C, T)  :- go_calls_e(C, T), ctx_fn(T), node_attr(C, "goroutine", "true").
@materialize(edge_type = "SPAWNS_WITH_CONTEXT", mode = "additive", meta(unresolved))
go_spawn_u(C, T, "true") :- go_calls_e(C, T), poss_fn(T), node_attr(C, "goroutine", "true").
@materialize(edge_type = "DEFERS_WITH_CONTEXT", mode = "additive")
go_defer(C, T)  :- go_calls_e(C, T), ctx_fn(T), node_attr(C, "deferred", "true").
@materialize(edge_type = "DEFERS_WITH_CONTEXT", mode = "additive", meta(unresolved))
go_defer_u(C, T, "true") :- go_calls_e(C, T), poss_fn(T), node_attr(C, "deferred", "true").
```
- **deltas**: G9-2 only. EXACT otherwise (the per-CALL edge has a unique (C,T) key; legacy
  duplicates collapse identically under edge-set semantics).

## missing_capabilities

1. **`first_segment(S, Sep, Out)`** — the dual of `last_segment` (builtin.rs:945-967), identity
   when no separator. The ONLY exact spelling of Go's isStdLib test ("first path segment
   contains a dot", GoImportResolution.hs:87 / GoCallResolution.hs:47-50). Without it the
   `string_contains(P,".")`-OR-module-prefix approximation leaves the bounded G2-3/G3-2 residue.
   Low priority: residue ≈ 0 on real repos; becomes a real gap only for dot-less vanity import
   paths colliding with local directory names.
2. **Zero-arity (or global-constant) predicates** for "the EXTERNAL fact is absent" tests —
   the no-go.mod fallback branch (P3). A `has_go_mod()` literal is currently a §3 cross-join
   the planner refuses. Engine alternative to the recommended orchestrator-side pack selection.
3. **`not_string_contains(S, Sub)`** — ergonomics only. The root-directory ("file has no '/'")
   complement is expressible today via derived-negation (`\+ mod_subdir(M)`), which costs one
   helper predicate per consumer; a negative filter twin of `string_contains` (like
   `not_starts_with`, builtin.rs:1268-1273) collapses the idiom.
4. *(precondition, not engine)* **P1 GO module-path fact** — orchestrator commit, precedent
   main.rs:2017-2032 (WORKSPACE_PACKAGE). Today the module path is wire-only
   (main.rs:1677-1686), invisible to any pack.

NOT needed (verified against today's kit): `split/3` (the last_segment right-peel recursion covers
comma-joined return_type exactly, step 8); `dirname` (basename+concat+strip_suffix idiom, step 1);
`node_attr` (exists since Wave 2, modes builtin.rs:1176-1180 — every metadata read above is legal);
semantic-id `[in:Parent]` parsing (structural CONTAINS substitutes everywhere — G6-1, G9-1).

## differential_acceptance

**The dogfood graph contains ZERO Go nodes** — probed on a /tmp copy of the 618MB
`.grafema/graph.rfdb`: `grep -rc '\.go->'` across all segments = 0 matches (semantic ids embed the
file path, and `.grafema/orchestrator.config.yaml` includes no `*.go` pattern). So the
differential CANNOT run on dogfood; ground truth is fixture-based:

1. **Unit stratum** — port the 23 Spec.hs cases (packages/go-resolve/test/Spec.hs:50-301) to
   FixtureStorageView engine tests (the 0.04s discipline): per-strategy call shapes, stdlib/
   third-party skips, first-MODULE multiplicity, empty-modPath fallback, subset-satisfaction
   corner cases (missing method, empty interface, pointer receiver), context
   certain/possible/goroutine/deferred matrix incl. the possible-caller/certain-target metadata
   case (Spec.hs:288-301).
2. **Repo stratum** — `packages/go-parser/` is a real 4-file Go module
   (`module github.com/grafema/go-parser`, package main): analyze it into a /tmp DB twice —
   legacy go-resolve ON / packs ON with the go resolution phase skipped (skip_resolver("go"),
   main.rs:1674) — and diff `(src_semantic_id, dst_semantic_id, edge_type)` triples per edge
   type. Note: single-package module → exercises strategies 2/3, types, context; NOT cross-package
   imports.
3. **Corpus stratum** — one small multi-package OSS Go repo (needs go.mod + internal packages +
   interfaces; e.g. a CLI like spf13/cobra) for the cross-package arms (IMPORTS_FROM, S1 calls,
   IMPLEMENTS at scale). Partition: edge type IS the sub-step partition for Go (the legacy stamps
   no resolvedVia) — IMPORTS_FROM↔step2, CALLS↔steps3-5 (sub-partition by pack-rule `_source`
   hash on the pack side; on the legacy side by receiver/alias shape recomputed offline),
   IMPLEMENTS↔6, TYPE_OF↔7, RETURNS↔8, PROPAGATES/SPAWNS/DEFERS↔9-10.

Acceptance: per-step EXACT except the enumerated bounded deltas (G2-2/G2-3/G3-1/G5-1/G6-2/G7-1
SUPERSET classes must each be ≤ the stated bound and every extra edge must trace to a documented
last-wins/first-match legacy tie-break; G9-1 differences must trace to same-name-in-dir
ambiguity). Freshness gate before any diff (graph mtime vs HEAD).

## expected_speedup_rationale

Honest: NO measurable wall-clock claim — the dogfood graph has no Go nodes (probe above), and the
go phase costs ~0 there today. The win is structural: retires the 4th `--daemon` Haskell resolver
(its msgpack full-node-set streaming round-trip, plugin.rs:679-944) and 886 lines of Haskell
(go-resolve/src = 5 modules + Main), moving Go to the same pack-runner as js/rust — one engine,
one differential discipline, one less binary in scripts/build-native.sh and the Hello capability
matrix. On Go-heavy target repos the js/rust precedent applies (in-engine joins over LSM segments
vs per-phase IPC; the packs here are negation+node_attr ⇒ scratch floor, maintain-incremental
refuses them — same accepted stance as every import pack, rust_imports.dl MAINTAIN ENVELOPE note).

## honesty — what is NOT expressible / NOT attempted

- **isStdLib exactly** (first-segment-dot): approximated; residue bounded and enumerated (M1).
- **The no-go.mod global branch** as in-pack logic: needs orchestrator pack-selection or M2.
- **Legacy tie-breaks** (first-MODULE-in-dir, Map last-wins in 4 indexes, alphabetical
  findBySuffix winner): deliberately NOT reproduced — set semantics derives all candidates;
  every such site is flagged SUPERSET with a bound. Reproducing them would need an ordering
  primitive the engine doesn't have (and shouldn't — rust_imports DELTA-1 precedent refused it).
- **MetaBool edge metadata**: `unresolved` rides the meta() projection as string "true" (G9-2).
- **Module-path discovery, go.mod I/O, binary checks**: stays in the orchestrator (EXTERNAL).
- **stderr edge-count diagnostics**: no pack analog (rust DELTA-4 class).
- **Receiver typing for S3 / embedded-interface expansion / signature-aware satisfaction**:
  legacy doesn't do them; the pack stays at parity. Each is a named Wave-2 refinement
  (rust_receiver_typing.dl precedent; EXTENDS-closure over the analyzer's embedded-interface
  edges; paramCount/returnCount as a cheap signature proxy already in metadata).
- **The analyzer's EXTENDS-by-NAME bug**: walkEmbed emits EXTENDS with geTarget = the embedded
  interface's NAME, not a node id (Declarations.hs:476-485) — an analyzer defect outside this
  migration's scope; noted so the differential doesn't misattribute it to the packs.

## notes — evidence base

Resolver semantics: packages/go-resolve/src/{Main.hs:61-87, GoImportResolution.hs:57-163,
GoCallResolution.hs:47-248, GoInterfaceSatisfaction.hs:64-148, GoTypeResolution.hs:27-122,
GoContextPropagation.hs:79-194}; tests test/Spec.hs:50-301. Analyzer vocabulary:
packages/go-analyzer/src/{Rules/Imports.hs:63-88, Rules/Calls.hs:74-138, Rules/Declarations.hs:
95-199,235-283,318-339,445-485,491+,639-650, Analysis/Walker.hs:32-44, Analysis/Context.hs:81-82};
ControlFlow.hs has zero withScope sites (no block scopes). Orchestrator: main.rs:1673-1714,
2573-2607 (go-all dispatch + ws wire), config.rs:846-865 (go.mod discovery), 751/796 (language
partition), main.rs:2017-2032 (WORKSPACE_PACKAGE commit precedent), analyzer.rs:580-602
(unresolved→ISSUE only). Engine kit: derive/builtin.rs registry :1188-1374 — node/type/edge/
incoming/attr/neq/gt/lt/gte/lte/starts_with/not_starts_with/string_contains/method_suffix/
ends_with/concat/str_lower/basename/strip_quotes/strip_prefix/strip_suffix/last_segment/
replace_all/path_resolve/edge_attr/node_attr; last_segment identity-no-separator :945-953;
node_attr modes :1176-1180; attr first-class set {name,file,type,id} :546-554. Pack idioms:
derive/stdlib/rust_imports.dl (DELTA discipline, bool→"true" surface, additive mode, ORDERING),
js_module_imports.dl:157-158 (WORKSPACE_PACKAGE join), rust_calls.dl:86-89 (meta() projection),
js_this_method_calls.dl:38-41 (§3 cross-join refusal). Dogfood probe: cp -R
.grafema/graph.rfdb /tmp/go-spec-probe.rfdb; grep -rc '\.go->' = 0 (no Go nodes; config includes
no *.go). Per the Evidence Rule, graph-shape claims here rest on analyzer source + Spec.hs
fixtures because no live Go graph exists; the differential's repo stratum (packages/go-parser
analyze) is the mandatory live confirmation before pack implementation.

---

# VERDICT (adversarial review, 2026-06-12, worktree HEAD 9ac0681c)

**VERDICT: REVISE BEFORE IMPLEMENTATION — semantics inventory is accurate and complete, but the headline
import/call draft rules are planner-illegal as written.** Re-verified in source: dispatch order (alias→S1
only / receiver-no-alias→S3 / no-receiver→S2, GoCallResolution.hs:157-174), isStdLib first-segment-dot
(:86-89), plain-stripPrefix + dropWhile '/' + first-MODULE pick + findBySuffix alphabetical-first
(GoImportResolution.hs:116-163), interface subset algorithm with the non-empty gate
(GoInterfaceSatisfaction.hs:130-148), context arms incl. SPAWNS/DEFERS sharing edgeMeta and the
caller-independence of steps 10 (GoContextPropagation.hs:140-194 — `unresolved=true` iff target possible,
on ALL three edge types, matching the drafted meta rules), return_type `T.intercalate ","`
(Declarations.hs:126-128), accepts/possible mutual exclusivity (:98-105), goroutine/deferred only-when-true
(Calls.hs:127-128), INTERFACE→FUNCTION(interface_method) CONTAINS (:466-472), EXTENDS-by-NAME analyzer
defect (:476-485). Emit-site inventory complete (re-grepped: 3 call sites, 2 type sites, 1 import,
1 interface, 3 context). The step-8 comma-peel and step-7 prefix-strip recursions are LEGAL — the same
shipped idiom as js_module_imports.dl:172-179 `spec_pfx`. Corrections:

**C1 (BLOCKING — E-PLAN-003 cross-joins in steps 1, 2, 3).** The §3 cross-join guard polices DERIVED legs
too (plan.rs:308-318; introduces_tuples = anything that's not a filter/function, :714-717), and the
ground-atom exemption requires ALL-constant args (plan.rs:1004-1007). Therefore, as drafted:
- `pkg_dir(P,D) :- mod_dir(_,D), go_mod(MP), …` — go_mod(MP) shares no variable with {D} in any leg order → REJECTED;
- `pkg_dir(MP,"") :- go_mod(MP), module_in_dir("",_)` — second leg disconnected → REJECTED;
- `go_import_from(I,M) :- go_import(I,_,P), go_mod(MP), …` — go_mod(MP) disconnected from {I,P} → REJECTED;
- `go_import_from_root(I,M) :- …, go_mod(P), module_in_dir("",M)` — module_in_dir("",M) has var M, shares
  nothing → REJECTED (this arm is semantically a cross product: import × root modules);
- `ok_path(P) :- import_alias(_,_,P), go_mod(MP), …` — same → REJECTED.
The spec flagged this guard only for the zero-arity `has_go_mod()` (P3) while drafting the identical
illegal shape in its main arms. LEGAL respelling exists and is the established one: derive the
'/'-boundary PREFIXES of the import path by right-peel (the spec_pfx idiom), EQUALITY-join `go_mod` on
the peeled prefix variable, then `strip_prefix(P, MP_slash, RelDir)` and join `module_in_dir(RelDir, M)`
on the BOUND RelDir — which also covers the root case (RelDir="" is a bound value, not a constant leg).
Consequence: the step-1 kernel's `pkg_dir` cannot exist as a standalone derived relation (the
modPath×dirs product is inherently disconnected); consumers (S1 calls, imports) must inline the
peel-join. This is a kernel redesign, not a tweak.

**C2 (fallback arm harder-blocked than stated).** The no-go.mod fallback rule
`go_import_suffix(I,M) :- go_import(I,_,P), …, module_in_dir(D,M), …, ends_with(P,D)` is the
filter-connected spelling the guard exists to reject (the in-file "rust_imports f_anc lesson",
js_module_imports.dl:168-170) — module_in_dir(D,M) is a disconnected positive leg regardless of which
pack loads it, so P3's orchestrator-side variant selection does NOT rescue the rule body. An equality-join
spelling needs the '/'-boundary SUFFIXES of P, which is a left-peel — it requires `first_segment`
(missing capability M1). So M1 is the blocker for the fallback ARM itself, not merely for isStdLib
exactness; either build M1 or declare the no-go.mod fallback dropped (bound: only projects without
go.mod, where legacy's own behavior was the alphabetical-first heuristic).

**C3 (missed delta class — interface-side name merge, step 6).** Legacy
`collectIfaceMethods` UNIONS method sets across SAME-NAMED interfaces project-wide
(GoInterfaceSatisfaction.hs:96-102, `Map.insertWith Set.union` keyed by interface NAME) and
`Map.intersectionWith` pairs that union with ONE last-wins interface node id (:84-88). The pack's
`iface_m(I, MN)` is per-NODE: for duplicate interface names the pack's requirement set is SMALLER
(per-node, not the union) ⇒ structs can satisfy an interface the legacy merged-set rejected, AND the
pack emits an edge per actual interface node vs legacy's single arbitrary winner. This is a separate
SUPERSET class from G6-2's struct-side merge — declare it (bound = duplicate interface simple names,
countable) or the differential will misclassify those rows.

**C4 (missed seam — pack ordering beyond P2).** `go_imports` must be registered BEFORE `@stdlib/depends`:
depends.dl consumes EVERY IMPORTS_FROM edge node-type-agnostically (derive/stdlib/depends.dl:1-6), and the
go branch feeds `all_imports_from_edges` today (main.rs:1701). `go_calls` (CALLS producer) must precede the
CALLS negators `method_calls`/`shape_verifier` (shape_verifier.dl:30 negates `edge(C,_,"CALLS")`, no file
gate). The ordering const is orchestrator main.rs:59-104 STDLIB_RULE_PACKS + rfdb-server stdlib.rs
STDLIB_PACKS — P2 covers only go_calls→go_context.

**C5 (mechanism misattribution, conclusion stands).** "the orchestrator turns unresolved [DeferredRefs]
into ISSUE diagnostics only (analyzer.rs:580-602)" — wrong mechanism: FileAnalysis has NO unresolvedRefs
field (analyzer.rs:41-49; serde drops faUnresolvedRefs exactly as for java/kotlin). The ISSUE nodes are
generated from POST-RESOLVE graph queries (main.rs:2060-2085: CALLs with no CALLS edge, IMPORT_BINDINGs
with no IMPORTS_FROM) onto `__grafema_virtual/unresolved-diagnostics`. The load-bearing conclusion ("graph
CALLS on .go files come exclusively from go-resolve") survives, but the differential must exclude the
synthetic diagnostics file — pack-coverage deltas change the ISSUE population.

**C6 (minor).** Step 7: rule text uses `not_starts_with(T,"[")` while the note recommends `"[]"` — pick
one (both parity-safe: neither residue matches a type_node key). The dogfood probe (`grep -rc '\.go->'`
over binary segments) is weaker evidence than the java/kotlin live-Datalog probes — rerun as a Datalog
count on the /tmp copy before gating. Negated builtin filters are in fact legal (exec.rs:1912+ per-row
anti-join; stratify adds no edge for builtins), so M3 `not_string_contains` is even less needed than
stated — `\+ string_contains(F,"/")` works today (no stdlib precedent; fixture-test first).

Ready for packs: NOT YET — C1/C2 require redrafting the import/call kernels (legal shapes exist and are
specified above); steps 4-10 are implementable as drafted once the shared func_in_dir/pkg join is respelled.
