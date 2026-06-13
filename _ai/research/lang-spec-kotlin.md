# Migration spec: kotlin-resolve → derive packs (.dl)

Authored 2026-06-12 against worktree HEAD `9ac0681c` (chore: release v0.4.0), branch feat/datalog lineage.
Discipline per `_ai/research/resolve-datalog2-migration-specs.json` (js/rust precedent) and the synthesis
ledger `_ai/research/resolve-datalog2-migration-synthesis.md` §3 (differential harness) / §5 (per-resolver verdicts).
All file:line references verified by Read/grep in this worktree at this HEAD.

---

## spec.target

`kotlin-resolve` (binary `kotlin-resolve`, packages/kotlin-resolve/src/ — 4 resolver modules + Main.hs
dispatch `kotlin-imports` / `kotlin-types` / `kotlin-calls` / `kotlin-annotations` / `kotlin-all`,
Main.hs:60-70). Driven by the orchestrator at main.rs:1601-1633: single-worker daemon pool, one
`kotlin-all` command via `plugin::stream_and_resolve_single_worker(&[Language::Kotlin], ...)`
(plugin.rs:1226-1253) — streams ALL nodes of `RESOLVE_NODE_TYPES` (analyzer.rs:3145-3202) whose `file`
detects as Kotlin (i.e. `.kt`/`.kts` files only; cross-language nodes are NOT visible to this resolver —
Java↔Kotlin is the separate `jvm-cross-resolve` at main.rs:1792+, OUT OF SCOPE here and untouched by
this migration). IMPORTS_FROM edges from the output are additionally collected into
`all_imports_from_edges` (main.rs:1620-1627) for the orchestrator's MODULE-DEPENDS_ON derivation —
a pack replacement must keep feeding that seam (the `depends.dl` pack consumes IMPORTS_FROM as EDB,
so pack ordering kotlin-packs → depends.dl replaces the in-memory collection).

## spec.purpose

Kotlin same-language cross-file resolution, 4 phases (Main.hs:64-70 `kotlin-all` runs all in one pass):
- **kotlin-imports** (ImportResolution.hs): IMPORTS_FROM edges, IMPORT→class and IMPORT_BINDING→class.
- **kotlin-types** (TypeResolution.hs): RETURNS, TYPE_OF, EXTENDS, IMPLEMENTS, THROWS_TYPE edges from
  node metadata type names against a project-wide simple-name class index.
- **kotlin-calls** (CallResolution.hs): CALLS + INSTANTIATES edges, 5 arms (constructor / same-class /
  static-companion / super-this / extension).
- **kotlin-annotations** (AnnotationResolution.hs): ANNOTATION_RESOLVES_TO edges ATTRIBUTE→annotation type.

All emitted edges carry EMPTY metadata (every `mkEdge`/EmitEdge in all 4 modules: geMetadata = Map.empty)
— no resolvedVia stamps, so parity diffing is by (src_sid, dst_sid, type) triples only.

---

## ANALYZER VOCABULARY (the EDB the packs will see)

What `kotlin-analyzer` (packages/kotlin-analyzer/src/) actually commits. This section is load-bearing:
several resolver arms read metadata the analyzer NEVER stamps — those arms are dead in production and
the spec's parity baseline is "zero edges", verified per-arm below.

### Node types emitted (complete list, grep `gnType =` over Rules/ + Analysis/)
MODULE (Walker.hs:35, metadata `package` when present :44), CLASS (Declarations.hs:95 classes incl.
interfaces/enums/annotation-classes — `kind` ∈ class|interface|enum|data|sealed|value|annotation|inner;
:154 object decls `kind=object, singleton=true`; :609 companion `kind=companion`), FUNCTION
(:207 top-level fn `kind=function`, :366 method `kind=method`, :504 secondary ctor `kind=secondary_constructor`
name=`<constructor>`, :565 init block `kind=init_block` name=`init`, :730 primary ctor
`kind=primary_constructor` name=ClassName), VARIABLE (:272/:444 properties `kind=property` (+`type` when
declared :290/:463), :684 enum entry `kind=enum_entry`, :776/:839 params `kind=parameter`, :804 ctor-val-param
property, Expressions.hs:659-:766 locals/catch/destructured), TYPE_ALIAS (:319), IMPORT (Imports.hs:58,
metadata `path`=full dotted name, `glob` Bool, `alias` opt :67-71), IMPORT_BINDING (Imports.hs:92, metadata
`imported_name`=leaf, `local_name`, `alias` opt :100-104; NO `source` key — the dotted source lives in the
sid hash bracket and on the containing IMPORT's name), CALL (Expressions.hs:84 `method=true, argCount`,
`receiver` only when non-empty :96; :137 safe-call adds `safe_call=true`; :192 ObjectCreation
`kind=constructor_call`, name=ClassName, NO receiver), PROPERTY_ACCESS (:243), REFERENCE (:278), CLOSURE
(:328), LITERAL (:372), BRANCH, SCOPE, PARAMETER (:798), TYPE_PARAMETER (Types.hs:224), ATTRIBUTE
(Annotations.hs:122/:177/:214, name=annotation simple name, `kind` classification).

**NEVER emitted by kotlin-analyzer**: INTERFACE, ENUM, OBJECT, ANNOTATION_TYPE node types (everything is
CLASS + `kind`). The resolver's index arms over those types (ImportResolution.hs:60, CallResolution.hs:55,
TypeResolution.hs:60, AnnotationResolution.hs:33) are vacuous for the Kotlin-only node stream.

### Edges emitted by the analyzer (already in EDB before resolve)
CONTAINS (scope→node everywhere; **IMPORT→IMPORT_BINDING** Imports.hs:107-112 — the graph-reachable
source-path seam, rust_imports.dl precedent), HAS_METHOD (CLASS→method FUNCTION Declarations.hs:401-409,
CLASS→primary-ctor :752-757, CLASS→secondary-ctor :526-534), HAS_PROPERTY, HAS_ATTRIBUTE
(decl→ATTRIBUTE Annotations.hs:142-147), COMPANION_OF (:636), DERIVES (enum entry :709), CATCHES,
THROWS (ErrorFlow.hs:119 — emitted directly in analysis, NOT by the resolver), ITERATES_OVER.
CALL CONTAINS-source = the enclosing FUNCTION node (method/fn body walks `withScope fnScope` with
scopeId=fn nodeId, Declarations.hs:417-428; ctor :540-549; init :585-592) or CLOSURE (lambda re-scope,
Expressions.hs:354 — the ONLY other re-scope; ControlFlow never re-scopes) or module scope (top level).

### Semantic-id shape (SemanticId.hs:21-29)
`file->TYPE->name[in:Parent,h:Hash]`. Methods: parent = enclosing CLASS name (Declarations.hs:356
parent=askNamedParent). CALL: parent = enclosing FUNCTION **name** (Expressions.hs:75 `encFn >>= extractName`)
— NOT the class. Primary ctor: parent=Nothing, h:primary_ctor (:723). This asymmetry kills two resolver
arms (steps 5, 7 below).

### THE DEFERRED-REF DROP (production-truth keystone)
The analyzer routes every cross-file intention through `emitDeferred` DeferredRef (Context.hs:84-85):
EXTENDS/IMPLEMENTS supertypes (Types.hs:166-180), RETURNS/TYPE_OF type refs (:183-201), CALLS
(Expressions.hs:104-117), IMPORTS_FROM (Imports.hs:117-130), serialized as `unresolvedRefs` in
FileAnalysis JSON (Types.hs:160-166). **The orchestrator's FileAnalysis struct has NO `unresolvedRefs`
field (analyzer.rs:41-48) — serde silently drops them.** Consequence: supertype names exist NOWHERE in
the committed graph (not as metadata, not as edges). Verified by the resolver-side greps below and live
probe (kt EXTENDS edges = 0; though dogfood has 0 kt nodes at all — see HONESTY).

---

## spec.sub_steps

Format per step: reads / writes / production-truth / expressible / blockers / delta classes / draft rules.
File gate `kt(F) :- ends_with(F, ".kt"). kt(F) :- ends_with(F, ".kts").` is the cross-language leakage
guard on every base relation (rust_imports.dl DELTA-5 precedent; CLASS/IMPORT/CALL are shared vocabulary).
Shared prelude used by several steps:

```prolog
kt(F) :- ends_with(F, ".kt").
kt(F) :- ends_with(F, ".kts").
% class index, simple name (CallResolution.hs:50-58 / TypeResolution.hs:57-65 — CLASS only is live):
kt_class(N, F, C) :- node(C, "CLASS"), attr(C, "file", F), kt(F), attr(C, "name", N).
% qualified-name class index (ImportResolution.hs:53-71): package from the file's MODULE node
kt_module(F, M) :- node(M, "MODULE"), attr(M, "file", F), kt(F).
kt_pkg(F, P) :- kt_module(F, M), node_attr(M, "package", P).
has_pkg(F) :- kt_pkg(F, _).
kt_qclass(Q, F, C) :- kt_class(N, F, C), kt_pkg(F, P), concat(P, ".", PD), concat(PD, N, Q).
kt_qclass(N, F, C) :- kt_class(N, F, C), \+ has_pkg(F).
```

### Step 1 — kotlin-imports: IMPORT → class (`resolveImport`, ImportResolution.hs:86-109)
- **reads**: IMPORT nodes (name = full dotted path, first-class), metadata `asterisk` (Bool) — **analyzer
  stamps `glob`, not `asterisk` (Imports.hs:69) → isAsterisk is ALWAYS False in production**; glob imports
  fall through to the qualified lookup and miss (name "com.example.*" is no class key) — accidentally the
  same skip, so behavior is unchanged. Qualified class index (package + "." + simple name).
- **writes**: IMPORTS_FROM edge IMPORT→CLASS-node (NB: doc comment says "to MODULE nodes" :17 — the code
  targets the class node :99-104), empty metadata.
- **production-truth**: LIVE arm. External imports (stdlib/3rd-party) silently skipped (:109).
- **expressible**: **fully, today** (node/attr/node_attr/concat/negation).
- **blockers**: none.
- **deltas**: D1 SUPERSET — duplicate qualified names across files: Haskell `Map.insert` last-wins
  (ImportResolution.hs:70) keeps ONE arbitrary winner; set semantics derives all (bound = count of
  duplicate (package,className) pairs, measurable). D2 EXACT — glob imports: no edge both sides.
- **draft_rules**:
```prolog
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
kt_import_class(I, C) :-
    node(I, "IMPORT"), attr(I, "file", IF), kt(IF), attr(I, "name", Q),
    kt_qclass(Q, _, C).
```

### Step 2 — kotlin-imports: IMPORT_BINDING → class (`resolveBinding`, ImportResolution.hs:111-167)
- **reads**: IMPORT_BINDING (name=localName), metadata `source` — **analyzer never stamps `source`
  (Imports.hs:100-104 stamps imported_name/local_name/alias only) → the source arm is dead; falls to
  the importedName-only arm (:124-135)**: leaf name ("Foo") looked up against QUALIFIED keys
  ("com.example.Foo") → matches only classes in package-less files.
- **writes**: IMPORTS_FROM edge IMPORT_BINDING→CLASS, empty metadata.
- **production-truth**: NEAR-DEAD — resolves only into files without a `package` declaration (rare in
  real Kotlin). The dotted source IS graph-reachable: IMPORT -CONTAINS-> IMPORT_BINDING + IMPORT.name
  (Imports.hs:107-112), the exact rust_imports.dl Phase-3 pattern.
- **expressible**: **fully, today** — both the exact-parity arm and the corrected arm.
- **blockers**: none.
- **deltas**: D1 (exact-parity arm) EXACT vs legacy. D2 (corrected arm, RECOMMENDED) SUPERSET —
  resolves every binding whose containing IMPORT's full path names a project class; bound = count of
  IMPORT_BINDING with a CONTAINS-parent IMPORT resolving in step 1 minus legacy's package-less matches.
  Aliased imports: localName=alias, but the join is via the IMPORT's path — alias-correct for free
  (legacy's imported_name arm was alias-correct too, when it matched at all).
- **draft_rules**:
```prolog
% exact-parity arm (replicates the importedName-vs-qualified-keys accident):
kt_binding_parity(B, C) :-
    node(B, "IMPORT_BINDING"), attr(B, "file", BF), kt(BF),
    node_attr(B, "imported_name", N), kt_qclass(N, _, C).
% corrected arm (the rust precedent — source via the CONTAINS seam; RECOMMENDED, declared superset):
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
kt_binding_import(B, C) :-
    node(B, "IMPORT_BINDING"), attr(B, "file", BF), kt(BF),
    incoming(B, I, "CONTAINS"), node(I, "IMPORT"), attr(I, "name", Q),
    kt_qclass(Q, _, C).
```
  (Ship ONE of the two arms — both together double-derive the package-less case; additive mode dedups
  identical (src,dst,type) but keep the program honest.)

### Step 3 — kotlin-types: RETURNS (`resolveReturns`, TypeResolution.hs:130-141)
- **reads**: FUNCTION metadata `return_type` — STAMPED (Declarations.hs:229 top-level, :394 methods);
  normalize = strip `[]` (T.replace), strip trailing `?`, skip 30-entry builtin table (:38-55), skip
  `<unknown>` and wildcard-containing; simple-name class index (CROSS-FILE, no package check :57-65).
- **writes**: RETURNS edges FUNCTION→CLASS, empty metadata.
- **production-truth**: LIVE arm. Generic args already dropped at stamp time (typeToName keeps base name,
  Expressions.hs:860-862, nullable suffix `?` kept).
- **expressible**: **fully, today** (node_attr + replace_all + strip_suffix + fact table + negation).
- **blockers**: none.
- **deltas**: D1 SUPERSET — duplicate simple class names across files (Map last-wins :64 vs all
  candidates); bound = count of duplicate kt CLASS simple names. D2 EXACT — builtin/primitive skips
  (the 30 names become ground facts, generated verbatim from TypeResolution.hs:38-55).
- **draft_rules**:
```prolog
kt_builtin_type("Int"). kt_builtin_type("Long"). % ... ×30, generated from TypeResolution.hs:38-55
% normalize: strip [] then trailing ? ; two-clause ladder (strip_suffix is a miss when absent)
ty_norm0(T, R) :- bound_in_context, replace_all(T, "[]", "", R).   % see NOTE below
ty_base(T, B) :- ty_norm0(T, S), strip_suffix(S, "?", B).
ty_base(T, S) :- ty_norm0(T, S), \+ ends_with(S, "?").
ty_ok(B) :- \+ kt_builtin_type(B), \+ string_contains(B, "?"), neq(B, "<unknown>").
@materialize(edge_type = "RETURNS", mode = "additive")
kt_returns(Fn, C) :-
    node(Fn, "FUNCTION"), attr(Fn, "file", F), kt(F),
    node_attr(Fn, "return_type", T), ty_base(T, B), ty_ok(B),
    kt_class(B, _, C).
```
  NOTE: write `ty_base` inline in each consumer (the helper as shown is unsafe-headed); the inline
  spelling is the established pack idiom — pseudo-helper shown for readability only.
- **NOT carried over (recorded, deliberate)**: TypeResolution.hs builds a `_methodIdx` it never uses
  (:139, leading underscore) — dead code, nothing to migrate.

### Step 4 — kotlin-types: TYPE_OF (`resolveTypeOf`, TypeResolution.hs:143-154)
- **reads**: VARIABLE metadata `type` — stamped ONLY on properties with declared types
  (Declarations.hs:290 top-level, :463 member; NOT on parameters/locals/ctor-val-params).
- **writes**: TYPE_OF edges VARIABLE→CLASS.
- **production-truth**: LIVE, properties only.
- **expressible**: **fully, today** — same shape as step 3 with `node_attr(V, "type", T)`.
- **deltas**: same SUPERSET class as step 3 (duplicate simple names).
- **draft_rules**: as step 3 with `node(V, "VARIABLE")` + `node_attr(V, "type", T)`,
  `@materialize(edge_type = "TYPE_OF", mode = "additive")`.

### Step 5 — kotlin-types: EXTENDS + IMPLEMENTS (`resolveExtends`/`resolveImplements`, TypeResolution.hs:156-183)
- **reads**: CLASS/&c metadata `extends` (single) and `implements` (comma-separated, splitTypes :118).
- **production-truth**: **DEAD — ZERO edges.** The analyzer NEVER stamps `extends`/`implements` metadata
  (grep over Rules/*.hs: no such keys; supertypes go ONLY into deferred InheritanceResolve refs,
  Types.hs:163-180, which the orchestrator drops — analyzer.rs:41-48). Kotlin classes have NO
  inheritance edges in the production graph at all. This is the kotlin analog of the js superClass
  story (js_class_inheritance.dl header), except the data is missing entirely rather than metadata-only.
- **expressible**: rules trivially expressible TODAY (same shape as js_class_inheritance.dl A1), but
  the EDB lacks the input — **blocked on analyzer-side data, not on the engine**.
- **blockers**: ANALYZER CHANGE — stamp `extends` / `implements` (comma-joined) metadata on CLASS at
  emission (Declarations.hs:89-118 has the supertype list in scope at walkDeclaration ClassDecl;
  Types.hs:40-60 already classifies first-super-vs-interfaces). One-line-class change + version bump.
- **deltas**: until the stamp lands: pack emits 0, legacy emits 0 — EXACT-zero parity, SHIP THE PACK
  EMPTY-SAFE. After the stamp: declared SUPERSET vs legacy-zero (entirely new edges; bound = count of
  kt classes with supertypes).
- **draft_rules** (active the day the analyzer stamps):
```prolog
@materialize(edge_type = "EXTENDS", mode = "additive")
kt_extends(C, T) :-
    node(C, "CLASS"), attr(C, "file", F), kt(F),
    node_attr(C, "extends", SN), ty_base(SN, B), ty_ok(B),
    kt_class(B, _, T), neq(C, T).
% implements: comma-split has no builtin — REQUIRES either analyzer stamping ONE name per key
% (implements_0, implements_1, …) or a split-style builtin; see missing_capabilities #2.
```

### Step 6 — kotlin-types: THROWS_TYPE (`resolveThrows`, TypeResolution.hs:185-196)
- **reads**: FUNCTION metadata `throws` (comma-separated).
- **production-truth**: **DEAD — ZERO edges.** Analyzer never stamps `throws` (Kotlin has no checked
  exceptions; only `error_exit_count` MetaInt is stamped, Declarations.hs:226). Throw-site edges are the
  analyzer's own THROWS (ErrorFlow.hs:119), unrelated to this arm.
- **expressible**: n/a — no input data, and none is coming (language semantics). **DROP, do not port.**
- **deltas**: EXACT-zero by omission.

### Step 7 — kotlin-calls: constructor calls (`resolveConstructorCalls`, CallResolution.hs:199-238)
- **reads**: CALL with `kind=constructor_call` metadata (stamped, Expressions.hs:201) or name prefixed
  `"new "` (never produced by the kotlin analyzer — Java-compat arm, vacuous on the .kt stream);
  simple-name class index; constructor index.
- **writes**: INSTANTIATES CALL→CLASS (live) + CALLS CALL→ctor-FUNCTION (see production-truth).
- **production-truth**: INSTANTIATES arm LIVE. **The CALLS→constructor arm is provably DEAD: the
  constructor index is ALWAYS EMPTY** (CallResolution.hs:75-95): primary ctors have kind
  `primary_constructor` ✓ but sid `file->FUNCTION->Foo[h:primary_ctor]` with NO `[in:]` (parent=Nothing,
  Declarations.hs:723) → extractParentClass=Nothing → skipped; secondary ctors have `[in:Foo]` ✓ but
  kind `secondary_constructor` (:513) ∉ {"constructor","primary_constructor"} (:91-94) → skipped.
- **expressible**: **fully, today.** INSTANTIATES = node_attr + name join. The ctor-CALLS arm has a
  graph-native CORRECTED form (CLASS -HAS_METHOD-> primary-ctor FUNCTION, Declarations.hs:752-757) —
  exact-parity (zero) needs nothing.
- **deltas**: D1 SUPERSET — duplicate class simple names (set vs Map last-wins). D2 (only if the
  corrected ctor arm ships) SUPERSET vs legacy-zero: CALLS to primary+secondary ctors; bound = count of
  constructor_call CALLs whose class resolves. Recommendation: ship INSTANTIATES at parity in wave 1;
  ship the ctor-CALLS correction behind the same pack with the delta declared.
- **draft_rules**:
```prolog
ctor_call(C, N, F) :-
    node(C, "CALL"), attr(C, "file", F), kt(F), attr(C, "name", N),
    node_attr(C, "kind", "constructor_call").
@materialize(edge_type = "INSTANTIATES", mode = "additive")
kt_instantiates(C, Cls) :- ctor_call(C, N, _), kt_class(N, _, Cls).
% corrected ctor-CALLS arm (declared superset vs legacy-zero):
@materialize(edge_type = "CALLS", mode = "additive")
kt_ctor_call(C, Ctor) :-
    ctor_call(C, N, _), kt_class(N, _, Cls),
    edge(Cls, Ctor, "HAS_METHOD"), node_attr(Ctor, "kind", "primary_constructor").
```

### Step 8 — kotlin-calls: same-class method calls (`resolveSameClassCalls`, CallResolution.hs:240-262)
- **reads**: CALL with no receiver / receiver="this" (`receiver` metadata, stamped only when non-empty,
  Expressions.hs:96); methodIdx keyed by the FUNCTION sid's `[in:Class]`; the CALL's own `[in:…]`.
- **production-truth**: **EFFECTIVELY DEAD (coincidence-only).** The CALL sid's `[in:]` is the enclosing
  FUNCTION's name (Expressions.hs:75), the methodIdx key is the enclosing CLASS name
  (Declarations.hs:356) — the join `(extractParentClass call, callName)` vs `(className, methodName)`
  matches only when a class happens to share the enclosing function's name. Cannot be replicated
  byte-for-byte in a pack anyway: the semantic-id STRING is not on the attr row surface (attr "id"
  returns the u128, builtin.rs:548-551) — and replicating a name-collision accident has negative value.
- **expressible**: the CORRECTED semantics is **fully expressible today**, graph-natively: enclosing
  function via incoming CONTAINS from FUNCTION (Declarations.hs:417-428 — scope source IS the fn node;
  one recursive hop through CLOSURE for lambda bodies, Expressions.hs:354), enclosing class via
  HAS_METHOD, member lookup via HAS_METHOD+name. Same substitution the js spec used for `[in:]` parsing.
- **deltas**: declared SUPERSET vs legacy ~zero (bound: count of receiverless/this CALLs inside methods
  whose class has a matching member; legacy baseline measurable as the count of (fn-name==class-name)
  collisions — expected 0 on real code). Overloads: all candidates derived vs legacy head-of-list.
- **draft_rules**:
```prolog
encl_fn(X, Fn) :- incoming(X, Fn, "CONTAINS"), node(Fn, "FUNCTION").
encl_fn(X, Fn) :- incoming(X, L, "CONTAINS"), node(L, "CLOSURE"), encl_fn(L, Fn).
encl_class(X, Cls) :- encl_fn(X, Fn), incoming(Fn, Cls, "HAS_METHOD").
has_recv(C) :- node_attr(C, "receiver", _).
self_recv(C) :- \+ has_recv(C).
self_recv(C) :- node_attr(C, "receiver", "this").
plain_call(C, N, F) :-
    node(C, "CALL"), attr(C, "file", F), kt(F), attr(C, "name", N),
    \+ node_attr(C, "kind", "constructor_call"), self_recv(C).
@materialize(edge_type = "CALLS", mode = "additive")
kt_same_class_call(C, M) :-
    plain_call(C, N, _), encl_class(C, Cls),
    edge(Cls, M, "HAS_METHOD"), attr(M, "name", N).
```

### Step 9 — kotlin-calls: static/companion calls (`resolveStaticCalls`, CallResolution.hs:264-285)
- **reads**: CALL `receiver` metadata = a class simple name; classIdx membership gate; methodIdx
  (receiver, callName).
- **production-truth**: **LIVE** — the one CALLS arm that actually works: `Foo.create()` with `create`
  a direct member of class/object/companion `Foo` (receiver name must equal the indexed class's gnName;
  companion members resolve only under receiver `Companion`, the companion CLASS's own name,
  Declarations.hs:600-609 — `Foo.create()` for a companion member does NOT match legacy either, since
  methodIdx keys companion members under "Companion").
- **expressible**: **fully, today** — methodIdx ≡ HAS_METHOD join (both derive from the same
  NamedParent context; HAS_METHOD emitted for methods :401-409, primary :752, secondary :526).
  Divergence: methodIdx also contains FUNCTIONs nested inside method bodies (withNamedParent=method
  name, Declarations.hs:425) under the method-name key — those fire only if a CLASS shares the method's
  name AND has no real member of that call name; HAS_METHOD doesn't contain them. SUBSET delta, bound =
  count of (class-name==method-name) collisions, expected 0.
- **deltas**: D1 SUBSET as above (≈0). D2 SUPERSET — overloads: all candidates vs head-of-list (:280).
- **draft_rules**:
```prolog
@materialize(edge_type = "CALLS", mode = "additive")
kt_static_call(C, M) :-
    node(C, "CALL"), attr(C, "file", F), kt(F), attr(C, "name", N),
    \+ node_attr(C, "kind", "constructor_call"),
    node_attr(C, "receiver", R), neq(R, "this"), neq(R, "super"),
    kt_class(R, _, Cls), edge(Cls, M, "HAS_METHOD"), attr(M, "name", N).
```
  (Legacy gate `isSuperOrThisCall` :268 excludes name super/this — see step 10: those nodes don't exist,
  the receiver-neq guards are belt-and-braces.)

### Step 10 — kotlin-calls: super()/this() delegation (`resolveSuperThisCalls`, CallResolution.hs:287-318)
- **reads**: CALL named "super"/"this" or `isThis` metadata; ctorIdx; extendsIdx (CLASS `extends` metadata :97-104).
- **production-truth**: **DEAD, three independent ways**: (a) the parser/analyzer IGNORES constructor
  delegation (`SecondaryConstructor mods params _delegation _delegArgs`, Declarations.hs:490 — wildcards)
  → no CALL nodes named super/this exist; (b) `isThis` is never stamped; (c) both ctorIdx (step 7 proof)
  and extendsIdx (step 5 proof — no `extends` metadata) are always empty.
- **expressible**: n/a today — no input data. **DROP from wave 1; revisit only after the analyzer emits
  delegation CALLs + extends metadata** (then it's an easy HAS_METHOD/primary_constructor + extends join).
- **deltas**: EXACT-zero by omission.

### Step 11 — kotlin-calls: extension function calls (`resolveExtensionCalls`, CallResolution.hs:320-339)
- **reads**: CALL with `extension=true` + `receiverType` metadata; extension index (FUNCTION
  extension=true + receiverType, stamped ✓ Declarations.hs:224/228, :385+).
- **production-truth**: **DEAD** — the analyzer stamps extension/receiverType on FUNCTIONs only, NEVER
  on CALL nodes (Expressions.hs CALL metadata = method/argCount/receiver/safe_call/kind only). The
  filter `getMetaBool "extension" node == Just True` on CALLs never passes.
- **expressible**: rules expressible today, input data missing — **blocked on analyzer stamping CALL-side
  receiver-type inference** (a static-typing judgment; substantial analyzer work, NOT a quick stamp).
- **deltas**: EXACT-zero by omission. (The resolver's own unit test :267-295 feeds synthetic CALL
  metadata the analyzer never produces — tests assert capability, not production behavior.)

### Step 12 — kotlin-annotations (`resolveAnnotations`, AnnotationResolution.hs:28-55)
- **reads**: ATTRIBUTE nodes (name = annotation simple name, Annotations.hs:112-133); index of
  ANNOTATION_TYPE nodes (never emitted by kotlin-analyzer → vacuous on the .kt stream) ∪ CLASS with
  `kind=annotation` (live — Kotlin `annotation class`, Declarations.hs kind taxonomy).
- **writes**: ANNOTATION_RESOLVES_TO edges ATTRIBUTE→CLASS.
- **production-truth**: LIVE for project-internal Kotlin annotation classes; external annotations skipped.
- **expressible**: **fully, today**.
- **deltas**: D1 SUPERSET — duplicate annotation-class simple names (set vs Map last-wins :36).
- **draft_rules**:
```prolog
@materialize(edge_type = "ANNOTATION_RESOLVES_TO", mode = "additive")
kt_annotation(A, T) :-
    node(A, "ATTRIBUTE"), attr(A, "file", F), kt(F), attr(A, "name", N),
    node(T, "CLASS"), attr(T, "name", N), attr(T, "file", TF), kt(TF),
    node_attr(T, "kind", "annotation").
```

### Step 13 — wire/seam obligations (not a resolver step, but part of the migration surface)
- The orchestrator currently collects kotlin IMPORTS_FROM into `all_imports_from_edges`
  (main.rs:1620-1627). Pack ordering: kotlin import packs MUST be declared BEFORE `depends.dl` (its
  IMPORTS_FROM-consuming clauses) — the shape_verifier.dl/rust_imports.dl ordering-contract pattern.
- `jvm-cross-resolve` (main.rs:1792+) consumes the same node vocabulary natively and stays; the kt()
  file gate guarantees the packs never collide with its Java-side outputs.
- Removal of the kotlin resolve invocation = deleting main.rs:1601-1633 + the `kotlin-resolve` binary
  from the binaries_to_check (main.rs:841-843) once packs are gated in.

---

## spec.missing_capabilities

Ranked. THE HEADLINE: **the v0.4.0 builtin kit (builtin.rs:1188-1373 — node_attr, strip_prefix/suffix,
path_resolve, replace_all, last_segment, concat, method_suffix, …) is SUFFICIENT for every arm of
kotlin-resolve that is alive in production.** Every remaining blocker is DATA-side (analyzer emission)
or a wire convention — none is an engine builtin gap, in sharp contrast to the js spec's era.

1. **ANALYZER: stamp `extends`/`implements` on CLASS nodes** (Declarations.hs walkDeclaration ClassDecl —
   the supertype list is in scope; Types.hs:40-60 already separates first-super from interfaces).
   Unblocks step 5 (kotlin inheritance — currently ZERO edges in the entire production graph). The
   root cause is structural: the orchestrator drops `unresolvedRefs` (analyzer.rs:41-48) and nobody
   noticed because the resolver's metadata arms silently no-op. Highest value per line of change.
2. **List-valued metadata convention** for `implements` (and any future comma-joined stamp): either
   indexed keys (`implements_0…n`, ugly but works with node_attr today) or a `split(S, Sep, Elem)`
   generator builtin (engine change, mode [B,B,F] multi-row — the only genuinely new engine capability
   this spec would request, and only for the implements arm).
3. **ANALYZER: emit delegation CALLs** (`this(...)`/`super(...)` — currently discarded wildcards,
   Declarations.hs:490) — unblocks step 10.
4. **ANALYZER: CALL-side receiver-type inference** (`extension`/`receiverType` on CALL) — unblocks
   step 11 (extension calls). Substantial analysis work; lowest priority.
5. (Hygiene, not a blocker) the resolver's `asterisk`/`source` reads vs the analyzer's `glob`/`path`
   stamps — vocabulary drift that the packs simply do not inherit; record in the analyzer's vocabulary
   doc so future arms don't re-diverge.
6. NO new string/path builtins, NO node-minting, NO same-run-edge needs: kotlin packs emit edges between
   existing nodes only, all modes "additive", no @materialize_node anywhere.

## spec.differential_acceptance

SETUP — **the dogfood graph CANNOT gate this migration**: live probe on a /tmp copy of
`.grafema/graph.rfdb` (491,535 nodes / 1,037,299 edges loaded) returned **0 nodes and 0 edges for every
kt-file-gated query** (MODULE/CLASS/CALL/IMPORT/IMPORT_BINDING/FUNCTION/ATTRIBUTE/VARIABLE; CALLS/
IMPORTS_FROM/INSTANTIATES/EXTENDS/RETURNS/TYPE_OF/ANNOTATION_RESOLVES_TO) — the orchestrator config's
include globs are ts/hs/rs only (`.grafema/orchestrator.config.yaml:2-14`), so the repo's 3 .kt files
(packages/kotlin-parser/src/main/kotlin/com/grafema/parser/*.kt) were never analyzed.

Gate instead on a FIXTURE PROJECT: (a) minimum viable = the repo's own kotlin-parser .kt sources +
a synthetic package exercising each live arm (imports w/ and w/o package, aliased import, glob import,
properties with declared types, constructor calls, companion-receiver calls, annotation classes,
duplicate simple names for the superset bounds); (b) analyze twice from the same checkout — DB_legacy
(kotlin resolve ON, packs OFF) vs DB_pack (skip_resolver("kotlin"), packs ON in declared order) — and
diff per step by (src_sid, dst_sid, type) triples (legacy edges carry empty metadata, so no metadata
column in the diff key; pack provenance _source/_generation excluded as always).

DECLARED DELTA CLASSES (predictions-first; any delta outside these = stop, witness, classify):
- EXACT: step 1 (modulo D1), step 2 parity-arm, glob-import skips, builtin-type skips,
  steps 6/10/11 (zero-by-omission vs zero-by-deadness — assert BOTH sides are literally zero on the
  fixture: `edge(_,_,"THROWS_TYPE")` count 0 in DB_legacy is itself a required check).
- SUPERSET, bounded: duplicate-name set-semantics (steps 1/3/4/12 — bound = measured duplicate-key
  counts on the fixture), overload all-candidates (step 9), corrected arms IF shipped (step 2 corrected,
  step 7 ctor-CALLS, step 8 same-class — bound each by the candidate-join count, and verify every extra
  edge with a why()/explain_datalog_fact witness + manual source read).
- SUBSET, bounded ≈0: step 9 nested-fn methodIdx accident (bound = class-name==method-name collisions).
ACCEPTANCE per pack: zero unexpected deltas + per-class counted bounds + a stdlib.rs fixture test per
pack (established pattern) + the step-5/6/10/11 zero-assertions on DB_legacy (they document the dead
arms as executable evidence).

## spec.expected_speedup_rationale

Honest framing: kotlin volume in known target graphs is currently ZERO (dogfood) to small — this
migration's value is NOT wall-clock, it is (a) retiring a whole Haskell daemon binary + process pool +
full-node-set msgpack stream from the per-run path (plugin.rs:1226-1253 collects and ships every
RESOLVE_NODE_TYPES node of the language per command), (b) making 6 of 12 resolver arms' production
deadness EXPLICIT and inspectable (why()-able) instead of silently vacuous, and (c) the step-5 analyzer
stamp turning kotlin inheritance from non-existent to derived. The packs are small pure joins over
name/file/node_attr probes (the build-once hash-join class — method_calls.dl precedent: 4-20s on a 415k
graph, and the kt-gated base relations will be orders smaller). Maintain envelope: every pack uses
node_attr and/or negation ⇒ scratch floor on maintain (same accepted stance as every import pack —
rust_imports.dl MAINTAIN ENVELOPE note).

## spec.honesty — what is NOT expressible / not known

1. **Byte-exact replication of the `[in:]` sid-parse arms is NOT expressible** (steps 5/7/8: the
   semantic-id string is not on the attr surface — attr "id" yields the u128, builtin.rs:548-551).
   Irrelevant for parity (those arms are dead or coincidence-only) but it means the packs CANNOT
   reproduce the legacy name-collision false positives — pack-vs-legacy diffs on a fixture engineered
   with such collisions will show legacy-only edges that are BUGS, not coverage.
2. **`implements` comma-split** is inexpressible today (no split builtin; fact-enumeration impossible
   for open-ended names) — moot until the analyzer stamps the key at all; the indexed-keys convention
   (missing_capabilities #2) avoids the engine change entirely.
3. **Wildcard (glob) import binding-level resolution** ("handled at binding level" per the comment,
   ImportResolution.hs:14) is handled NOWHERE — glob imports produce an IMPORT node and nothing else
   in both legacy and pack. Not a regression; recorded as a (pre-existing) coverage gap.
4. **Ground truth for production behavior is code-derived, not graph-derived**: zero kotlin nodes exist
   in the dogfood graph (live-probe evidence above), so every dead-arm claim rests on cross-module
   source analysis (analyzer stamp inventory vs resolver read inventory, file:line cited per step) plus
   the package's unit suites (kotlin-resolve/test/Spec.hs:59-378 — NB its fixtures hand-feed metadata
   the analyzer never emits: `source` on bindings :76-89, `extends`/`implements` :134-170, `kind=
   "constructor"` ctors :232-244, CALL-side `extension`/`receiverType` :267-295 — the tests assert the
   resolver's CAPABILITY, and are exactly how the vocabulary drift went unnoticed). A fixture-project
   analyze run (differential SETUP above) is REQUIRED before gating; if it contradicts any dead-arm
   claim here, the spec must be corrected first (verify-before-recording).
5. **kotlin-parser is a JVM binary** (packages/kotlin-parser, Kotlin sources) — the analyze phase
   itself stays untouched by this migration; only the resolve daemon is replaced.
6. `.kts` script files: detect_language mapping for Kotlin includes them or not — NOT verified in this
   pass (config.rs detect_language test :1252 checks .kt only). The kt() gate above includes .kts
   defensively; align it with detect_language before shipping (one-line check).

## appendix: per-arm production-liveness verdict table

| # | arm | legacy production output | pack wave |
|---|-----|--------------------------|-----------|
| 1 | IMPORT→class | LIVE | wave 1, EXACT+D1 |
| 2 | IMPORT_BINDING→class | near-dead (package-less only) | wave 1, corrected (declared superset) |
| 3 | RETURNS | LIVE | wave 1, EXACT+superset(dup names) |
| 4 | TYPE_OF | LIVE (properties only) | wave 1, EXACT+superset(dup names) |
| 5 | EXTENDS/IMPLEMENTS | DEAD (no metadata; deferred refs dropped) | pack ready; blocked on analyzer stamp |
| 6 | THROWS_TYPE | DEAD (no such Kotlin data) | drop forever |
| 7 | INSTANTIATES / ctor-CALLS | LIVE / DEAD (ctorIdx provably empty) | wave 1 / corrected optional |
| 8 | same-class CALLS | dead-coincidence ([in:] fn-vs-class mismatch) | wave 1 corrected (declared superset) |
| 9 | static/companion CALLS | LIVE | wave 1, EXACT+overload superset |
| 10 | super()/this() | DEAD (delegation discarded by analyzer) | drop until analyzer emits |
| 11 | extension CALLS | DEAD (no CALL-side metadata) | drop until analyzer infers |
| 12 | ANNOTATION_RESOLVES_TO | LIVE (kotlin annotation classes) | wave 1, EXACT+superset(dup names) |

---

# VERDICT (adversarial review, 2026-06-12, worktree HEAD 9ac0681c)

**VERDICT: APPROVE WITH CORRECTIONS (draft-rule respellings required).** Every dead-arm finding re-verified
in source: ctorIdx provably empty (CallResolution.hs:74-95 re-read — isConstructor accepts only
"constructor"/"primary_constructor", secondary ctors are kind=secondary_constructor Declarations.hs:513,
primary ctors have parent=Nothing in the sid Declarations.hs:723 → extractParentClass=Nothing); analyzer
stamps NO extends/implements metadata (grep over kotlin-analyzer Rules/: zero hits outside a Types.hs:50
comment); FileAnalysis drops unresolvedRefs (analyzer.rs:41-49 re-read); constructor delegation discarded
(`_delegation _delegArgs` wildcards, Declarations.hs:490); CALL metadata = method/argCount/receiver/
safe_call/kind only (Expressions.hs:93-203 re-read — no extension/receiverType); IMPORT→IMPORT_BINDING
CONTAINS seam exists (Imports.hs re-read); resolveBinding's importedName fallback confirmed (the
"package-less only" near-dead reading is correct); annotation index = ANNOTATION_TYPE ∪ CLASS kind=annotation
(AnnotationResolution.hs:25-36). Emit-site inventory complete (re-grepped all mkEdge/EmitEdge: 4 import
sites, 5 type sites, 7 call sites incl. extension :283, 1 annotation site — all mapped to steps).
Orchestrator/seam cites verified (main.rs:1602-1633, skip_resolver, plugin streaming). Corrections:

**C1 (draft-rule BUG — the shared prelude is planner-illegal).** `kt(F) :- ends_with(F, ".kt").` is an
unsafe rule: `ends_with` is a FILTER with the single mode [B,B] (builtin.rs FILTER2_MODES) — it cannot
generate F, so the rule fails E-PLAN-001/002 and the whole program is rejected. No stdlib pack defines a
filter-helper relation; the established spelling inlines the gate (`attr(C,"file",F), ends_with(F,".kt")`)
per base relation — exactly what the java/go sibling specs draft. Every rule using `kt(F)` must be
respelled (mechanical; the kt()/kts() disjunction becomes two clauses per base relation or one derived
base relation per node type carrying the file gate inside).

**C2 (draft-rule BUG — step 8).** `has_recv(C) :- node_attr(C, "receiver", _).` is illegal: node_attr has
NO generator mode — the node id must be bound (builtin.rs NODE_ATTR_MODES [B,B,F]/[B,B,B] only,
"deliberately NO generator mode"). And `self_recv(C) :- \+ has_recv(C).` is unsafe-headed (C unbound).
Respell as `has_recv(C) :- node(C,"CALL"), node_attr(C,"receiver",R), neq(R,"this").` and use
`\+ has_recv(C)` inline in plain_call (the java spec's S11 shape). Same class of fix: step 3's `ty_ok(B)`
is unsafe-headed too — the NOTE flags only ty_base; flag both, inline all filters in consumers.

**C3 (engine claim wrong — missing_capabilities #2 and honesty #2).** "implements comma-split is
inexpressible today (no split builtin)" is FALSE as an engine claim: the recursive right-peel over a
shrinking string (`last_segment` + `concat` + `strip_suffix`) is a shipped stdlib idiom —
js_module_imports.dl:172-179 `spec_pfx`, with the termination argument in-file. When the analyzer stamps
comma-joined `implements`, the pack can split it with TODAY'S kit; the indexed-keys convention and the
split/3 builtin are both unnecessary. (Bonus: negated builtin filters are legal too — exec.rs:1912+ per-row
anti-join fallback; stratify.rs adds no edge for builtins — so the builtin-table skip can be spelled
`\+ kt_builtin_type(B), \+ string_contains(B,"?")` without extra strata. No stdlib precedent for the
negated-filter form yet; add a fixture test first.)

**C4 (honesty #6 resolved).** `.kts` IS mapped to Kotlin: config.rs:749 `"kt" | "kts" => Some(Language::Kotlin)`.
The kt()+kts() gate is confirmed correct, not "defensive".

**C5 (step 13 mechanism stale, conclusion right).** At v0.4.0 `all_imports_from_edges` is consumed ONLY as
a count hint to run_stdlib_rule_packs (main.rs:2853 → :573-577 `imports_from_hint`); MODULE→MODULE
DEPENDS_ON is derived by `@stdlib/depends`, which consumes EVERY IMPORTS_FROM edge node-type-agnostically
(derive/stdlib/depends.dl:1-6). The ordering obligation is therefore exactly as stated (kotlin import pack
before `depends` in STDLIB_PACKS/STDLIB_RULE_PACKS), plus one the spec missed: kotlin_calls is a CALLS
producer and must precede the CALLS negators `method_calls`/`shape_verifier` (shape_verifier.dl:30 negates
CALLS with no file gate). Also exclude `__grafema_virtual/unresolved-diagnostics` from the differential —
ISSUE nodes are generated from post-resolve graph queries (main.rs:2060-2085), so corrected-arm coverage
changes that population.

Ready for packs: YES after the C1/C2 mechanical respellings — the semantics, liveness table, and delta
classes all survived adversarial re-reading unchanged.
