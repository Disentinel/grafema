# Migration spec: java-resolve → derive packs (Datalog v2)

Date: 2026-06-12. Branch context: worktree at `9ac0681c` (v0.4.0, origin/main-era; `derive/` module layout).
Discipline: the js/rust precedent in `_ai/research/resolve-datalog2-migration-specs.json` + synthesis-ledger §3/§5.
All file:line references verified by Read/Grep in this worktree at HEAD.

## 0. Target & purpose

**Target:** `java-resolve` binary (`packages/java-resolve/src/`, 4 modules + Main, 869 LOC total), dispatched
by the orchestrator as a one-shot full-graph daemon command `("java-all", &[])` over `Language::Java` nodes
(`packages/grafema-orchestrator/src/main.rs:1566-1595` analyze path, `:2481-2501` reanalyze path; binary
checked at `:838-839`). `java-all` runs all 4 phases in one pass (`java-resolve/src/Main.hs:64-70`).

**Purpose:** Java cross-file resolution, materializing:
- `IMPORTS_FROM` (IMPORT→class decl; IMPORT_BINDING→class decl) — `ImportResolution.hs`
- `RETURNS`, `TYPE_OF`, `EXTENDS`, `IMPLEMENTS`, `THROWS_TYPE` — `TypeResolution.hs`
- `CALLS`, `INSTANTIATES` — `CallResolution.hs`
- `ANNOTATION_RESOLVES_TO` — `AnnotationResolution.hs`

All emitted edges carry **EMPTY metadata** (every `mkEdge`/`EmitEdge` site: ImportResolution.hs:85-91,113-130;
TypeResolution.hs:188-195; CallResolution.hs:132-139; AnnotationResolution.hs:46-53). No virtual nodes are
minted anywhere in java-resolve — **no `@materialize_node`, no two-pack split needed** (unlike js builtins).
No external data inputs (no effects-db, no workspace map): graph-in, edges-out. This is the *easiest*
resolver family migrated so far.

**Out of scope (adjacent):** `jvm-cross-resolve` (`packages/jvm-cross-resolve/src/`, 3 modules) — Java↔Kotlin
cross-language `IMPORTS_FROM`/`CALLS`/type edges, emitted only when source and target file *languages differ*
(CrossImportResolution.hs:5,17-18); run separately at main.rs:1793/2680. `kotlin-resolve` is a near-clone of
java-resolve (own spec). Both deserve their own pack specs; the kernels below (qualified-class index,
HAS_METHOD membership) are directly reusable.

## 1. Analyzer vocabulary the resolver consumes (java-analyzer, verified)

Node types emitted (`packages/java-analyzer/src/Rules/`):
`MODULE` (Walker.hs:37-51, metadata `package` when the file has a package decl, else NO key),
`IMPORT` (Imports.hs:65-81, name = full import path `com.example.Foo`, metadata `path`/`glob`(bool)/`static`(bool)),
`IMPORT_BINDING` (Imports.hs:96-112, name = leaf `Foo`, metadata `imported_name`/`local_name`/`static` —
**no `source` key**), `CLASS`/`INTERFACE`/`ENUM`/`RECORD`/`ANNOTATION_TYPE` (Declarations.hs; CLASS metadata
`extends` single name :114, `implements` comma-joined :118; INTERFACE `extends` comma-joined :169; ENUM/RECORD
`implements` comma-joined :219,:272), `FUNCTION` (methods :376-391 metadata `kind`="method"/`return_type`/
`throws` comma-joined; constructors :459-467 `kind`="constructor"; compact ctors :529 `kind`="compact_constructor"),
`VARIABLE` (fields :740-747 metadata `kind`="field"/`type`; locals/params/catch in Expressions.hs),
`CALL` (Expressions.hs:103-123 method calls, metadata `method`/`argCount`/`receiver` only-when-nonempty;
:777-795 `this()`/`super()` with `kind`="constructor_call"/`isThis`(bool); ctor calls named `"new " <> ClassName`
:1086), `ATTRIBUTE` (Annotations.hs, annotation usages).

Edge types emitted by the analyzer (counted): `CONTAINS` ×43 sites, `HAS_METHOD` (Declarations.hs:402-410
methods, :477-483 constructors — **NOT compact constructors**: the :534-539 emission for compact ctors is
CONTAINS-only), `HAS_PROPERTY`, `INNER_CLASS_OF`, plus expression-level edges (CALLS×2 analyzer-side,
REFERENCES, ASSIGNED_FROM, THROWS, CATCHES, …).

Semantic-id format (`grafema-common/src/Grafema/SemanticId.hs:2`): `file->TYPE->name[in:parent,h:xxx]`.
- FUNCTION (method/ctor): `parent` = enclosing **class** name (`askNamedParent`, set by `withNamedParent name`
  at the class walk, Declarations.hs:332-343).
- CALL: `parent` = enclosing **method** name (`parent = encFn >>= extractName`, Expressions.hs:101,163,226,777;
  `extractName` takes the *name segment* of the enclosing FUNCTION sid, :1098-1105).

Scope mechanics: members get `CONTAINS` from `scopeId`; class scopes carry the class node id
(Declarations.hs:332-338), method/ctor scopes carry the FUNCTION node id (:419-428, :542-548 ccScope), lambdas
carry the lambda FUNCTION id (Expressions.hs:377,424). Blocks do NOT push scopes (no BlockScope construction
in Rules/). So a CALL's `CONTAINS` source is the enclosing FUNCTION (or class for field initializers, or MODULE
at top level) — the graph-native parent chain the packs use instead of sid parsing.

**Streaming scope:** the daemon receives ONLY Java-language nodes (`run_resolve(..., &[config::Language::Java], ...)`,
main.rs:1578). Every pack rule below therefore gates BOTH sides on `ends_with(F, ".java")` — this *is* legacy
parity, and mandatory because the vocabulary is shared polyglot-wide (ATTRIBUTE also emitted by cpp/kotlin/
python/swift analyzers; ANNOTATION_TYPE by kotlin; INSTANTIATES by cpp/kotlin/php resolvers — verified by grep).

## 2. Production-dead legacy paths (load-bearing findings)

These three findings change what "parity" means. Each is code-evidence (file:line both sides); the
differential run must confirm them live (no java graph exists today to live-verify — §8).

**(D1) `resolveBinding` is dead.** ImportResolution.hs:104-107 reads node metadata `source` and returns `[]`
when absent. The analyzer stamps IMPORT_BINDING with `imported_name`/`local_name`/`static` only
(Imports.hs:107-111); the intended `source` travels in `DeferredRef.drSource` (Imports.hs:122-135), but the
orchestrator's `FileAnalysis` struct has **no `unresolvedRefs` field** (analyzer.rs:41-49) — serde drops it.
⇒ Phase 3 (IMPORT_BINDING→decl) emits ZERO edges in production. The package unit test passes only because it
fabricates the `source` key (test/Spec.hs:79-91).

**(D2) `asterisk` vs `glob`.** ImportResolution.hs:78 reads metadata `asterisk`; the analyzer stamps `glob`
(Imports.hs:78). `isAsterisk` is always False — benign: a glob IMPORT is named `com.example.*`, which can never
match a qualified class name, so the net effect (no edge) is identical. The pack inherits this for free.

**(D3) `resolveSameClassCalls` fires only inside constructors.** It keys the method index by
`(className, methodName)` where className comes from the FUNCTION sid `[in:Class]` (CallResolution.hs:56-66),
but looks it up with `extractParentClass(CALL sid)` (:191-194) — which is the enclosing **method** name (§1).
The lookup matches only when enclosing-method-name == class-name, i.e. inside constructors. Calls in ordinary
method bodies derive nothing. The unit test masks this by fabricating `[in:Service]` on the CALL sid
(test/Spec.hs:214-221). Corollary: `resolveSuperThisCalls` (:232-257) **works correctly by the same accident** —
`super()`/`this()` occur only inside constructors, where `[in:ctorName]` == class name.

## 3. Per-step inventory + draft rules

Builtin kit verified at `packages/rfdb-server/src/derive/builtin.rs` registry (:1188-1372): `node/type/edge/
incoming/attr` (attr exposes ONLY name/file/type/id — :548-551; "id" is the u128 decimal, NOT the semantic id),
`neq,gt,lt,gte,lte`, `starts_with,not_starts_with,string_contains,ends_with` [B,B], `method_suffix,str_lower,
basename,strip_quotes` [B,F|B,B], `concat,strip_prefix,strip_suffix,last_segment,path_resolve` [B,B,F|B,B,B],
`replace_all` [B,B,B,F|B,B,B,B], `edge_attr/5`, **`node_attr/3`** [B,B,F|B,B,B] point-probe (:1084-1115,
:1176-1182; JSON string verbatim, number by JSON text, bool as "true"/"false"; missing key = tuple non-match).
`node_attr` — the js-spec's #1 missing capability — EXISTS; it unblocks every metadata read below.
Negated builtins are not a thing (`not_starts_with` exists precisely because `\+` applies to derived relations) —
all "skip" filters below go through derived aux relations.

```json
[
  {
    "step": "S1 qualified-class kernel (buildModuleIndex+buildClassIndex, ImportResolution.hs:41-68)",
    "reads": "MODULE.metadata.package (node_attr), CLASS/INTERFACE/ENUM/RECORD by (file,name), java gate",
    "writes": "derived qual_class(QualifiedName, T) — consumed by S2/S3",
    "expressible": "fully",
    "deltas": ["last-write-wins Map on duplicate qualified names → set semantics derives ALL candidates (superset, same class as rust DELTA 4)"]
  },
  {
    "step": "S2 IMPORT → class decl IMPORTS_FROM (resolveImport, ImportResolution.hs:75-92)",
    "reads": "IMPORT.name = full path (first-class), glob exclusion (production-dead D2 — free parity)",
    "writes": "IMPORTS_FROM IMPORT→{CLASS,INTERFACE,ENUM,RECORD}, empty meta",
    "expressible": "fully",
    "deltas": ["S1 superset inherits", "static imports `com.example.Foo.bar` resolve nothing on BOTH sides (full-path lookup fails) — exact parity; an opt-in improvement arm via last_segment exists but is NOT drafted (honesty: superset must be deliberate)"]
  },
  {
    "step": "S3 IMPORT_BINDING → class decl IMPORTS_FROM (resolveBinding, ImportResolution.hs:99-131)",
    "reads": "legacy: metadata source (NEVER present — D1). pack: IMPORT -CONTAINS-> IMPORT_BINDING + IMPORT.name (Imports.hs:114-120 emits exactly this edge)",
    "writes": "IMPORTS_FROM IMPORT_BINDING→class decl",
    "expressible": "fully (graph-native route)",
    "deltas": ["DECLARED SUPERSET vs production (legacy derives 0); bound = count of java IMPORT_BINDING whose parent IMPORT name ∈ qual_class — measurable pre-flight. This restores the resolver's documented intent (module header :20, unit test :79). Ship decision: include (it is the feature), with the bound recorded"]
  },
  {
    "step": "S4 simple-class kernel (TypeResolution.hs:41-50 / CallResolution.hs:44-52 buildClassIndex by simple name)",
    "reads": "CLASS/INTERFACE/ENUM/RECORD (file,name), java gate",
    "writes": "derived jclass_named(N, T) — consumed by S5-S9, S10, S12, S13",
    "expressible": "fully",
    "deltas": ["Map last-write-wins on duplicate simple names ACROSS THE PROJECT (e.g. two `Foo` in different packages) → set semantics derives an edge per candidate (superset; bound = names with >1 decl, measurable)"]
  },
  {
    "step": "S5 RETURNS (resolveReturns, TypeResolution.hs:115-126; normalizeType :81-94)",
    "reads": "FUNCTION.metadata.return_type (node_attr); normalize = strip-all-[] (replace_all), skip 10 primitives (ground facts), skip '?'-wildcards + '<unknown>' (derived-negation aux)",
    "writes": "RETURNS FUNCTION→class decl",
    "expressible": "fully",
    "deltas": ["T.strip trim is not replicated (no trim builtin) — NO-OP: typeToName (Expressions.hs:1108-1114) never emits padded names", "S4 superset inherits"]
  },
  {
    "step": "S6 TYPE_OF (resolveTypeOf, TypeResolution.hs:129-140)",
    "reads": "VARIABLE.metadata.type (node_attr), same normalize",
    "writes": "TYPE_OF VARIABLE→class decl",
    "expressible": "fully",
    "deltas": ["same as S5"]
  },
  {
    "step": "S7 EXTENDS (resolveExtends, TypeResolution.hs:143-156)",
    "reads": "CLASS/INTERFACE/ENUM/RECORD metadata.extends — NOTE legacy does NOT split: an interface with `extends A,B` (comma-joined, Declarations.hs:169) is looked up as the literal string 'A,B' and fails",
    "writes": "EXTENDS decl→class decl",
    "expressible": "fully (exact parity INCLUDING the no-split miss: a comma-bearing string matches no class name automatically)",
    "deltas": ["S4 superset inherits", "interface multi-extends: 0 edges on both sides (exact); the FIX needs split/3 (missing capability #1)"]
  },
  {
    "step": "S8 IMPLEMENTS (resolveImplements, TypeResolution.hs:159-171, splitTypes :97-98)",
    "reads": "CLASS/ENUM metadata.implements, comma-SPLIT then per-element lookup",
    "writes": "IMPLEMENTS decl→interface decl (one per resolved element)",
    "expressible": "partially",
    "deltas": ["single-element values: EXACT", "multi-element values: SUBSET — pack derives 0 of them (no split/3 builtin); bound = java CLASS/ENUM nodes whose implements metadata contains ',' (directly countable via string_contains)"]
  },
  {
    "step": "S9 THROWS_TYPE (resolveThrows, TypeResolution.hs:174-186)",
    "reads": "FUNCTION.metadata.throws, comma-split per element",
    "writes": "THROWS_TYPE FUNCTION→class decl",
    "expressible": "partially",
    "deltas": ["same split SUBSET as S8 (multi-exception throws clauses); single-exception exact"]
  },
  {
    "step": "S10 constructor calls (resolveConstructorCalls, CallResolution.hs:146-176)",
    "reads": "CALL name 'new X' (strip_prefix), jclass_named, ctor membership: legacy ctorIdx = FUNCTION kind∈{constructor,compact_constructor} keyed by sid [in:Class] (:70-85) — pack: HAS_METHOD for ctors + RECORD-CONTAINS for compact ctors (HAS_METHOD gap, §1)",
    "writes": "INSTANTIATES CALL→class decl + CALLS CALL→ctor FUNCTION",
    "expressible": "fully",
    "deltas": ["overload pick: legacy takes head of the ctor list (:174-175, arbitrary Map-fold order; the argCount comment is NOT implemented) → pack derives ALL ctors of the class (superset, bound = classes with >1 ctor)", "S4 superset inherits", "local-class ctors: legacy keyed them under the WRONG name when nested in a method (sid parent = method name); pack's edge-based membership is correct (superset/fix, rare)"]
  },
  {
    "step": "S11 same-class method calls (resolveSameClassCalls, CallResolution.hs:182-205) — PRODUCTION-LATENT-BUGGED (D3)",
    "reads": "CALL with receiver absent/''/'this' (node_attr + derived-negation), NOT ctor-call, NOT super/this; enclosing class: pack = CONTAINS-parent FUNCTION (+ nested-FUNCTION recursion for lambdas) + HAS_METHOD owner; method index = HAS_METHOD + name",
    "writes": "CALLS CALL→FUNCTION (same class)",
    "expressible": "fully",
    "deltas": ["DECLARED SUPERSET: legacy derives only ctor-body calls (D3); pack derives all same-class no-receiver calls — the resolver's documented intent (:12-13) and its unit test (:214). Bound = plain calls in non-ctor methods with a same-class name match; semantically sound (no false-positive vector: the join requires an actual same-class method of that name)", "overload pick head → all-overloads superset", "field-initializer calls (CONTAINS from class node, no FUNCTION parent): legacy no-edge ([in:] absent → extractParentClass Nothing), pack no-edge through encl_fn (FUNCTION-typed parent leg) — parity"]
  },
  {
    "step": "S12 static-style calls (resolveStaticCalls, CallResolution.hs:208-226)",
    "reads": "CALL.metadata.receiver = a class simple name (node_attr), method via HAS_METHOD+name",
    "writes": "CALLS CALL→FUNCTION",
    "expressible": "fully",
    "deltas": ["all-overloads superset; S4 dup-name superset; otherwise EXACT (receiver matching a non-class identifier derives nothing on both sides — unit test :243-249)"]
  },
  {
    "step": "S13 super()/this() delegating ctor calls (resolveSuperThisCalls, CallResolution.hs:232-257)",
    "reads": "CALL named 'super'/'this' or isThis=true (node_attr bool surface 'true'); this(): enclosing class ctor; super(): enclosing CLASS metadata.extends → superclass ctor",
    "writes": "CALLS CALL→ctor FUNCTION",
    "expressible": "fully",
    "deltas": ["all-ctors superset vs head-pick; otherwise EXACT (legacy works here — D3 corollary)"]
  },
  {
    "step": "S14 annotation resolution (AnnotationResolution.hs:26-44)",
    "reads": "ATTRIBUTE.name ↔ ANNOTATION_TYPE.name (both first-class)",
    "writes": "ANNOTATION_RESOLVES_TO ATTRIBUTE→ANNOTATION_TYPE",
    "expressible": "fully",
    "deltas": ["dup-name set-semantics superset; .java gate on BOTH legs is load-bearing (kotlin emits both node types — without the gate the pack would invent java→kotlin edges legacy never saw)"]
  }
]
```

## 4. Draft packs (4 files, canonical order: java_imports → java_types → java_calls → java_annotations)

No inter-pack EDB dependencies (none consumes another's materialized edges), so the order is convention,
not contract — record it in the STDLIB_PACKS comment anyway (stdlib.rs:303-358 discipline). All `mode =
"additive"`: every edge type is shared vocabulary and the legacy resolver stays ON during hybrid rollout
(the rust_trait_resolve.dl precedent). Legacy metadata is empty ⇒ no `meta(...)` columns anywhere; engine
provenance `_source`/`_generation` is the standing metadata delta (rust DELTA 6).

### 4.1 `java_imports.dl`

```prolog
% Self-contained name-keyed relations joined on strings (§3 connectivity discipline,
% rust_trait_resolve.dl ENCODING NOTE — never inline node/attr legs next to a foreign leg).
jmodule(M, F) :- node(M, "MODULE"), attr(M, "file", F), ends_with(F, ".java").
jdecl(T, F, N) :- node(T, "CLASS"),     attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "INTERFACE"), attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "ENUM"),      attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "RECORD"),    attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
pkg_of(F, P)  :- jmodule(M, F), node_attr(M, "package", P), neq(P, "").
has_pkg(F)    :- pkg_of(F, P).
% qualified name = package "." simple name; default-package files contribute the bare name
% (ImportResolution.hs:63-66 pkg-or-empty discipline).
qual_class(Q, T) :- jdecl(T, F, N), pkg_of(F, P), concat(P, ".", P1), concat(P1, N, Q).
qual_class(N, T) :- jdecl(T, F, N), \+ has_pkg(F).

jimport(I, Q, F) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".java"), attr(I, "name", Q).

% S2 — IMPORT -> declaration (glob imports fall out naturally: '*'-suffixed names match nothing).
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
import_target(I, T) :- jimport(I, Q, F), qual_class(Q, T).

% S3 — IMPORT_BINDING -> declaration via the parent IMPORT (graph-native source; DECLARED
% SUPERSET vs the production-dead metadata-source path, §2 D1).
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
binding_target(B, T) :- node(B, "IMPORT_BINDING"), attr(B, "file", F), ends_with(F, ".java"),
    edge(I, B, "CONTAINS"), jimport(I, Q, F), qual_class(Q, T).
```

### 4.2 `java_types.dl`

```prolog
prim("boolean"). prim("byte"). prim("char"). prim("short"). prim("int").
prim("long"). prim("float"). prim("double"). prim("void"). prim("var").

jdecl(T, F, N) :- node(T, "CLASS"),     attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "INTERFACE"), attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "ENUM"),      attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "RECORD"),    attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jclass_named(N, T) :- jdecl(T, F, N).

% normalizeType (TypeResolution.hs:81-94): strip ALL "[]", reject primitives / '?' / '<unknown>' / "".
% One raw value per (node,key) ⇒ the per-node bad-flag is a faithful negation surface.
ret_strip(Fn, N) :- node(Fn, "FUNCTION"), attr(Fn, "file", F), ends_with(F, ".java"),
    node_attr(Fn, "return_type", Raw), neq(Raw, ""), replace_all(Raw, "[]", "", N), neq(N, "").
ret_bad(Fn) :- ret_strip(Fn, N), prim(N).
ret_bad(Fn) :- ret_strip(Fn, N), string_contains(N, "?").
ret_bad(Fn) :- ret_strip(Fn, "<unknown>").
@materialize(edge_type = "RETURNS", mode = "additive")
returns(Fn, T) :- ret_strip(Fn, N), \+ ret_bad(Fn), jclass_named(N, T).

vty_strip(V, N) :- node(V, "VARIABLE"), attr(V, "file", F), ends_with(F, ".java"),
    node_attr(V, "type", Raw), neq(Raw, ""), replace_all(Raw, "[]", "", N), neq(N, "").
vty_bad(V) :- vty_strip(V, N), prim(N).
vty_bad(V) :- vty_strip(V, N), string_contains(N, "?").
vty_bad(V) :- vty_strip(V, "<unknown>").
@materialize(edge_type = "TYPE_OF", mode = "additive")
type_of(V, T) :- vty_strip(V, N), \+ vty_bad(V), jclass_named(N, T).

% EXTENDS — all 4 decl types carry it (TypeResolution.hs:146); comma-joined interface
% multi-extends matches no class name = the legacy no-split miss, reproduced exactly.
ext_strip(C, N) :- jdecl(C, F, CN), node_attr(C, "extends", Raw), neq(Raw, ""),
    replace_all(Raw, "[]", "", N), neq(N, "").
ext_bad(C) :- ext_strip(C, N), prim(N).
ext_bad(C) :- ext_strip(C, N), string_contains(N, "?").
ext_bad(C) :- ext_strip(C, "<unknown>").
@materialize(edge_type = "EXTENDS", mode = "additive")
extends(C, T) :- ext_strip(C, N), \+ ext_bad(C), jclass_named(N, T), neq(C, T).

% IMPLEMENTS (CLASS+ENUM only, :163) / THROWS_TYPE — SINGLE-element arm only (split/3 gap):
% comma-bearing values are excluded explicitly so the subset is the DECLARED one, not an accident.
impl_one(C, N) :- node(C, "CLASS"), attr(C, "file", F), ends_with(F, ".java"),
    node_attr(C, "implements", N), neq(N, "").
impl_one(C, N) :- node(C, "ENUM"),  attr(C, "file", F), ends_with(F, ".java"),
    node_attr(C, "implements", N), neq(N, "").
impl_multi(C) :- impl_one(C, N), string_contains(N, ",").
@materialize(edge_type = "IMPLEMENTS", mode = "additive")
implements(C, T) :- impl_one(C, N), \+ impl_multi(C), jclass_named(N, T).

throws_one(Fn, N) :- node(Fn, "FUNCTION"), attr(Fn, "file", F), ends_with(F, ".java"),
    node_attr(Fn, "throws", N), neq(N, "").
throws_multi(Fn) :- throws_one(Fn, N), string_contains(N, ",").
@materialize(edge_type = "THROWS_TYPE", mode = "additive")
throws_type(Fn, T) :- throws_one(Fn, N), \+ throws_multi(Fn), jclass_named(N, T).
```

### 4.3 `java_calls.dl`

```prolog
jdecl(T, F, N) :- node(T, "CLASS"),     attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "INTERFACE"), attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "ENUM"),      attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jdecl(T, F, N) :- node(T, "RECORD"),    attr(T, "file", F), ends_with(F, ".java"), attr(T, "name", N), neq(N, "").
jclass_named(N, T) :- jdecl(T, F, N).

jcall(C, N) :- node(C, "CALL"), attr(C, "file", F), ends_with(F, ".java"), attr(C, "name", N).

% — classification (CallResolution.hs:260-270) —
ctor_call(C, CN) :- jcall(C, N), strip_prefix(N, "new ", CN), neq(CN, "").
is_ctor_call(C)  :- ctor_call(C, CN).
is_ctor_call(C)  :- jcall(C, N), node_attr(C, "kind", "constructor_call").
this_call(C)  :- jcall(C, "this").
this_call(C)  :- jcall(C, N), node_attr(C, "isThis", "true").
super_call(C) :- jcall(C, "super").
super_this(C) :- this_call(C).
super_this(C) :- super_call(C).
has_recv(C) :- jcall(C, N), node_attr(C, "receiver", R), neq(R, ""), neq(R, "this").

% — membership (graph-native replacement of the sid [in:Class] parse) —
% ctor_of: HAS_METHOD covers methods+constructors (Declarations.hs:402,477); compact
% constructors get only CONTAINS from the record scope (:534-539) — the second arm.
ctor_of(Cls, Fn) :- edge(Cls, Fn, "HAS_METHOD"), node_attr(Fn, "kind", "constructor").
ctor_of(Cls, Fn) :- node(Cls, "RECORD"), edge(Cls, Fn, "CONTAINS"),
    node_attr(Fn, "kind", "compact_constructor").
% enclosing class of a CALL: nearest FUNCTION ancestor via CONTAINS, then its HAS_METHOD
% owner; the recursion lifts lambda/local-fn nesting (lambda FUNCTIONs have no HAS_METHOD).
encl_fn(C, Fn) :- jcall(C, N), edge(Fn, C, "CONTAINS"), node(Fn, "FUNCTION").
fn_owner(Fn, Cls) :- edge(Cls, Fn, "HAS_METHOD").
fn_owner(Fn, Cls) :- edge(Outer, Fn, "CONTAINS"), node(Outer, "FUNCTION"), fn_owner(Outer, Cls).
encl_class(C, Cls) :- encl_fn(C, Fn), fn_owner(Fn, Cls).

% S10 — constructor calls.
@materialize(edge_type = "INSTANTIATES", mode = "additive")
instantiates(C, Cls) :- ctor_call(C, CN), jclass_named(CN, Cls).
@materialize(edge_type = "CALLS", mode = "additive")
ctor_calls(C, Fn) :- ctor_call(C, CN), jclass_named(CN, Cls), ctor_of(Cls, Fn).

% S11 — same-class no-receiver calls (DECLARED SUPERSET — fixes §2 D3).
plain_call(C, N) :- jcall(C, N), \+ is_ctor_call(C), \+ super_this(C), \+ has_recv(C).
@materialize(edge_type = "CALLS", mode = "additive")
same_class_calls(C, M) :- plain_call(C, N), encl_class(C, Cls),
    edge(Cls, M, "HAS_METHOD"), attr(M, "name", N).

% S12 — static-style calls (receiver names a class).
recv_class(C, N, Cls) :- jcall(C, N), \+ is_ctor_call(C), \+ super_this(C),
    node_attr(C, "receiver", R), neq(R, ""), neq(R, "this"), jclass_named(R, Cls).
@materialize(edge_type = "CALLS", mode = "additive")
static_calls(C, M) :- recv_class(C, N, Cls), edge(Cls, M, "HAS_METHOD"), attr(M, "name", N).

% S13 — this()/super() delegation.
@materialize(edge_type = "CALLS", mode = "additive")
this_ctor_calls(C, Fn) :- this_call(C), encl_class(C, Cls), ctor_of(Cls, Fn).
@materialize(edge_type = "CALLS", mode = "additive")
super_ctor_calls(C, Fn) :- super_call(C), encl_class(C, Cls),
    node_attr(Cls, "extends", SN), neq(SN, ""), jclass_named(SN, SCls), ctor_of(SCls, Fn).
```

### 4.4 `java_annotations.dl`

```prolog
% .java gates on BOTH legs are load-bearing: kotlin-analyzer emits ATTRIBUTE and
% ANNOTATION_TYPE too (Rules/Annotations.hs); legacy only ever saw Java-streamed nodes.
jattr(A, N) :- node(A, "ATTRIBUTE"), attr(A, "file", F), ends_with(F, ".java"),
    attr(A, "name", N), neq(N, "").
jann(N, T)  :- node(T, "ANNOTATION_TYPE"), attr(T, "file", F), ends_with(F, ".java"),
    attr(T, "name", N), neq(N, "").
@materialize(edge_type = "ANNOTATION_RESOLVES_TO", mode = "additive")
ann_resolves(A, T) :- jattr(A, N), jann(N, T).
```

**Maintain envelope (all 4 packs):** `node_attr` legs + stratified negation ⇒ maintain-incremental refuses;
the scratch floor applies (the standing Wave-2 expectation, rust_trait_resolve.dl MAINTAIN ENVELOPE note).
`java_annotations` and `java_imports`' S2 arm are negation-light enough to shed it later.

## 5. Predicted delta classes (declared BEFORE diffing, with bounds)

EXACT-MATCH expected: S2 (modulo S1 dup-qual-name extras), S5/S6/S7 single-name types, S8/S9 single-element
values, S12, S13, S14 (modulo dup-name extras everywhere — bound below).

EXPECTED-SUPERSET (pack ⊇ legacy, each bounded & countable pre-flight):
1. Set semantics vs Map last-write-wins — bound = decl names (simple or qualified) with >1 decl node;
   count with `dup(N) :- jclass_named(N,T1), jclass_named(N,T2), neq(T1,T2)`.
2. All-overloads vs head-pick (S10/S11/S12/S13 CALLS) — bound = (class, name) pairs with >1 FUNCTION.
3. S3 binding edges — bound = java IMPORT_BINDING count whose parent IMPORT resolves (legacy = 0, §2 D1).
4. S11 same-class calls outside ctor bodies (legacy = ctor-bodies only, §2 D3) — bound = plain_call rows
   whose encl_fn is not kind=constructor.
5. S10 local-class ctor membership fix (rare; classifiable by INNER_CLASS_OF/nesting).

EXPECTED-SUBSET (pack ⊆ legacy, the split/3 debt — must go to zero when split lands):
6. S8/S9 multi-element implements/throws — bound = nodes whose metadata value `string_contains ","`;
   single Datalog count each.

Any delta outside classes 1-6 = pack bug or new resolver knowledge → stop, witness (`explain_datalog_fact`
on pack-extra; legacy stderr counters `java-resolve:`/`java-call-resolve:`… on pack-missing), classify,
only then proceed.

## 6. Missing capabilities (today's kit, ranked)

1. **`split(S, Sep, Elem)` — multi-row string generator** [B,B,F]: binds Elem once per separator-delimited
   element. THE only hard blocker in the whole java surface (S8 IMPLEMENTS / S9 THROWS_TYPE multi-element;
   would also fix S7's interface multi-extends beyond parity). Same need will recur for kotlin-resolve
   (same comma-joined metadata convention) — worth building once. A peel-from-the-right recursion using
   `concat(",", Last, Suf), strip_suffix(S, Suf, Rest)` + `last_segment` is technically constructible
   today but generates fresh string terms in a recursive rule (function-symbol territory the engine's
   safety discipline does not sanction) — NOT proposed.
2. (nice-to-have) negated string filters `not_contains`/`not_ends_with` — the derived-negation aux-relation
   workaround (ret_bad/impl_multi above) is legal but verbose, and every aux relation deepens the negation
   stratification that blocks maintain-incremental.
3. (recorded, not needed here) semantic-id surface access from Datalog — `attr(X,"id",V)` yields the u128
   decimal (builtin.rs:551), not the sid; the `[in:Class]` parses were replaced by HAS_METHOD/CONTAINS
   edges instead, which is the better design anyway. Languages without membership edges would hit this.
4. (not engine) **a Java differential corpus**: the dogfood graph has zero java nodes (§7) and
   `.grafema/config.yaml` include has no `*.java` pattern. Options: (a) add
   `packages/java-parser/src/main/**/*.java` (3 real files in-repo) to a worktree config — smoke-scale;
   (b) an external OSS Java repo (e.g. a small Maven project) for real-scale. Either way the acceptance
   run needs `grafema analyze` with the java analyzer+resolver toolchain built (cabal + the
   `~/.grafema/bin` staleness trap from the skills list applies).

## 7. Dogfood-graph probe (evidence)

Probe: copied `/Users/vadimr/grafema/.grafema/graph.rfdb` (mtime Jun 11, 618MB) → `/tmp/java-spec-probe.rfdb`,
own rfdb-server v0.4.0 on `/tmp/java-spec-probe.sock`; loaded 491,535 nodes / 1,037,299 edges. Datalog counts:

```
q(M,F) :- node(M,"MODULE"), attr(M,"file",F), ends_with(F,".java").   → 0 rows
… same for IMPORT / CLASS / CALL / FUNCTION java-gated                 → 0 rows each
string_contains(F,"java-parser")                                       → 0 rows
ends_with(F,".kt")                                                     → 0 rows
```

**The dogfood graph contains NO java (or kotlin) nodes.** Root cause is config, not analyzers:
`.grafema/config.yaml` includes only `*.ts/*.rs/*.hs/*.ex/*.erl`. The repo itself has 3 real .java files
(`packages/java-parser/src/main/java/com/grafema/parser/{Main,DaemonProtocol,AstSerializer}.java`).
Consequence: this spec's behavioral claims rest on (a) resolver+analyzer source (file:line cited throughout)
and (b) the package unit fixtures (`java-resolve/test/Spec.hs`, 323 lines, 18 cases — caveat: two fixtures
fabricate metadata/sids production never produces, §2 D1/D3). Graph-shape claims (HAS_METHOD coverage,
CONTAINS chains, metadata keys as stored) MUST be re-verified by live query on the differential corpus DB
before the acceptance diff is trusted (Evidence Rule: analyzer-source grepping is not graph evidence).

## 8. Differential acceptance

SETUP — two DBs from one checkout containing the chosen java corpus (§6.4): DB_legacy = `analyze` with
java-resolve ON, java packs OFF; DB_pack = `analyze` with `--skip-resolver java` (the existing
`skip_resolver("java")` gate, main.rs:1566/2481) + the 4 packs run via the prod pack-runner in §4 order.
u128 ids are BLAKE3 of sids — comparable across DBs; export `(src_sid, dst_sid, edge_type)` triples regardless.

PARTITION — cleaner than js: legacy stamps NO resolvedVia metadata, but **every edge type except CALLS has
exactly one producer step**, so slicing is by edge type: IMPORTS_FROM (S2+S3, sub-split by source node type
IMPORT vs IMPORT_BINDING — S3 expects legacy=∅), RETURNS(S5), TYPE_OF(S6), EXTENDS(S7), IMPLEMENTS(S8),
THROWS_TYPE(S9), INSTANTIATES(S10), ANNOTATION_RESOLVES_TO(S14). CALLS partitions structurally by source
CALL node: name starts "new "(S10) / name∈{super,this}∨isThis(S13) / has receiver∉{"",this}(S12) / rest(S11).
NOTE: the java analyzer itself also emits 2 CALLS edge sites — exclude analyzer-generation edges from both
sides by diffing only edges absent from a resolver-OFF/pack-OFF baseline DB (3-way diff), or by `_source`
provenance on the pack side.

PROCEDURE per slice: counts smoke-check → sorted set-diff → witness every diff row (pack-extra:
`explain_datalog_fact`; pack-missing: legacy stderr totals ImportResolution.hs:148-150 /
CallResolution.hs:290-293 / TypeResolution.hs:212-218 / AnnotationResolution.hs:63-64 + manual trace).
Verify both sides before recording (the verify-before-recording lesson). ACCEPTANCE GATE per pack: zero
deltas outside declared classes 1-6 (§5), each declared class counted against its pre-flight bound,
a stdlib.rs fixture test per pack (FixtureStorageView units, 0.04s-class), wall-clock recorded.

PREDICTIONS-FIRST headline checks: (P1) legacy IMPORT_BINDING IMPORTS_FROM slice = EXACTLY 0 rows (D1);
(P2) legacy plain-call CALLS slice contains ONLY calls whose enclosing function is a constructor (D3);
(P3) glob IMPORTs have no IMPORTS_FROM on either side (D2). If any prediction fails → my §2 reading is
wrong → STOP and re-derive before shipping packs.

## 9. Expected speedup & why migrate

The java daemon path is the identical IPC shape the js migration killed (full node-set msgpack streaming
into a Haskell daemon, one-shot `java-all`, per-command commit via `commit_resolve_output`,
main.rs:1566-1595): the cost is serialization + process lifetime, not resolution math — all 14 steps are
hash-map lookups. On java corpora of realistic size the packs are small-join workloads far below the
proven 415k-node baselines (4-20s scratch for the method_calls class). The structural wins dominate:
one fewer Haskell binary in the toolchain (java-resolve drops out of binaries_to_check :838-839),
why()-able logic, and the two latent production bugs (D1, D3) become impossible-by-construction instead
of silently shipping an unresolved java graph. Honesty: per-run wall win is minutes-of-build-and-spawn
plus the streaming cost, not a 900s→56s headline — the corpus measurement in §8 records the real number.

## 10. Honesty section — NOT expressible / NOT replicated

1. **Multi-element implements/throws** (S8/S9): not expressible without `split/3`. Declared subset, counted.
2. **Overload selection by argCount**: legacy doesn't implement it either (the CallResolution.hs:172 comment
   lies; :174-175 takes head). The pack derives all overloads. NEITHER implements real Java overload
   resolution; if exactly-one-edge semantics is ever required, the binding-table/semiring layer (Gate C §9.3)
   is the mechanism, not a rule hack.
3. **Static-import member resolution** (`import static com.example.Foo.bar`): unimplemented in legacy
   (header comment ImportResolution.hs:17 vs code), unimplemented in the pack. Expressible today via
   last_segment/strip_suffix if ever wanted — deliberate non-goal to keep parity honest.
4. **JDK/third-party types**: silently skipped on both sides (no EXTERNAL_MODULE minting for Java).
   A future java_builtins facts-pack (the js builtins two-pack pattern) is the natural follow-up; the JDK
   surface is enormous — needs the lang-spec generated-facts route, not hand enumeration.
5. **Wildcard-import bindings** (`import com.example.*` then bare `Foo` use): glob imports produce no
   IMPORT_BINDING (Imports.hs:91-93) and no resolution on either side. A real gap in java *analysis*,
   not a resolver-parity question.
6. **Generic types**: `typeToName` flattens `List<Foo>` → `List` analyzer-side; type-argument edges don't
   exist in either world.
7. **encl_class via CONTAINS recursion** assumes member/expression CONTAINS chains are complete. Code-verified
   (43 CONTAINS sites + scope discipline §1) but graph-unverified (no java graph) — P-check in §8 before trust.
8. **kotlin-resolve / jvm-cross-resolve**: out of scope; java packs' .java gates keep them non-interfering.
   jvm-cross's cross-language edges remain native until its own spec.

---

# VERDICT (adversarial review, 2026-06-12, worktree HEAD 9ac0681c)

**VERDICT: APPROVE WITH CORRECTIONS.** Inventory is complete (all mkEdge/EmitEdge sites in the 4 modules
covered: ImportResolution.hs:85/113/124, TypeResolution.hs:126/140/156/168/183, CallResolution.hs:157/174-175/
196/224/246/255, AnnotationResolution.hs:44 — re-grepped). D1/D2/D3 all re-verified against both sides:
D1 — `FileAnalysis` has no `unresolvedRefs` field (analyzer.rs:41-49 re-read: file/moduleId/nodes/edges/exports
only) and `resolveBinding`'s ENTIRE body, including the inner bindingName fallback arm at ImportResolution.hs:124
(which the spec didn't mention — it's inside the `T.null source` gate, so equally dead), emits nothing without
`source`; analyzer stamps imported_name/local_name/static only (Imports.hs re-read). D2 — analyzer stamps `glob`
(Imports.hs), resolver reads `asterisk` (ImportResolution.hs:78). D3 — methodIdx keyed by FUNCTION-sid [in:]
(CallResolution.hs:56-66), probed with CALL-sid [in:] = enclosing-method name (java CALL sid parent =
`encFn >>= extractName`, Expressions.hs:101-103 re-read). All draft rules re-checked against the registry and
the planner: every leg's binding pattern has a registered mode (edge [F,B,B] exists for the `edge(I,B,"CONTAINS")`
/ `edge(Fn,C,"CONTAINS")` spellings — builtin.rs EDGE_MODES), every positive leg is variable-connected
(E-PLAN-003 clean), constants in derived legs are legal (exec.rs unify_atom handles Term::Const), head-pick
:174-175 confirmed. Corrections:

**C1 (load-bearing — kills missing-capability #1).** "split/3 is THE only hard blocker" is WRONG. The
right-peel recursion over shrinking strings is a SANCTIONED, SHIPPED stdlib idiom: `spec_pfx` in
js_module_imports.dl:172-179 uses exactly `last_segment` + `concat` + `strip_suffix` in a recursive rule, with
an in-file comment that the fixpoint terminates at segment depth. Comma-split of `implements`/`throws` is the
same shape (separator "," — analyzer joins with `T.intercalate ","`, Declarations.hs:118/169/219/272/391/467
re-verified, no spaces; legacy splitTypes' T.strip is a no-op). Therefore **S8 IMPLEMENTS and S9 THROWS_TYPE
multi-element are fully expressible TODAY**; delta class 6 (SUBSET) is closable in wave 1, and S7's interface
multi-extends fix is available as a deliberate-superset arm. §6.1's "function-symbol territory the engine's
safety discipline does not sanction" is contradicted by shipped stdlib. Demote split/3 to ergonomics.

**C2 (engine claim wrong, minor).** "Negated builtins are not a thing" — false. The executor evaluates a
negated builtin literal as a per-row anti-join (exec.rs:1912-1920 negated path; non-special-cased shapes
"(attr, filters, …) keep the exact per-row fallback"), and the stratifier creates NO dependency edge for
base/builtin literals (stratify.rs:215-217, :456 "base relation or builtin — no dependency edge"). So
`\+ string_contains(N, ",")` / `\+ ends_with(...)` are legal AND stratification-free — the §6.2 rationale
("every aux relation deepens the negation strata") is inverted: direct negated filters are LIGHTER than the
ret_bad/impl_multi aux relations drafted. Caveat: zero stdlib packs use the form today (grep: only
node/edge/derived are negated) — add one FixtureStorageView test before relying on it.

**C3 (missed step — wire/seam).** The java resolve branch ALSO pushes IMPORTS_FROM into
`all_imports_from_edges` (main.rs:1582-1586; at v0.4.0 consumed only as a count hint to
run_stdlib_rule_packs :2853), and — the real seam — `@stdlib/depends` consumes EVERY IMPORTS_FROM edge,
node-type-agnostically via file join (derive/stdlib/depends.dl:1-6). So java IMPORTS_FROM already feed
MODULE→MODULE DEPENDS_ON today, and §4's "the order is convention, not contract" is wrong at the stdlib
level: `java_imports` MUST be registered before `depends` in BOTH ordering consts (rfdb-server
derive/stdlib.rs `STDLIB_PACKS` and orchestrator main.rs:59-104 `STDLIB_RULE_PACKS` — the latter is the
ordering contract, not "stdlib.rs:303-358"); `java_calls` (a CALLS producer) must precede the CALLS
negators `method_calls`/`shape_verifier` (shape_verifier.dl:30 negates `edge(C,_,"CALLS")` with NO file
gate). Also: the unresolved-diagnostics ISSUE generation queries the graph post-resolve for CALLs without
CALLS / IMPORT_BINDINGs without IMPORTS_FROM (main.rs:2060-2085) — pack-coverage changes (S3, S11) will
change the ISSUE population on `__grafema_virtual/unresolved-diagnostics`; exclude it from the diff.

**C4 (minor, differential hygiene).** The `<unknown>` skip is dead-letter on BOTH sides: java `typeToName`
emits `"<type>"` for unhandled types (Expressions.hs:1114), never `"<unknown>"` (that's the resolver's own
vocabulary, TypeResolution.hs:92). Parity unaffected ("<type>" matches no class name), but the differential
should not expect the ret_bad("<unknown>") arm to ever fire.

Ready for packs: YES once C1/C3 are folded in (S8/S9 upgraded to full split parity; pack registration order
pinned). The drafted rules are planner-legal as written.
