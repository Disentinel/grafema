//! derive engine standard library — bundled, annotation-light `.dl` rule programs that ship
//! with the engine (spec I12: defaults live in stdlib; a typical author rule carries zero
//! annotations). Each rule is embedded at compile time via `include_str!` so the engine
//! has no runtime filesystem dependency on its own rule sources.
//!
//! ## `depends/2` — module→module dependency (`DEPENDS_ON`)
//!
//! Reproduces the orchestrator's in-memory `MODULE→MODULE DEPENDS_ON` derivation
//! (`grafema-orchestrator/src/main.rs:1733-1793`): for each `IMPORTS_FROM` edge, map each
//! endpoint to the `MODULE` node that owns its source file, and emit the (source-module,
//! dest-module) pair. The orchestrator dedups pairs and excludes self-dependencies
//! (`src_mod != dst_mod`, main.rs:1760); the datalog rule reproduces both: set semantics
//! dedup pairs natively, and the trailing `Msrc != Mdst` guard drops self-loops.
//!
//! Endpoint → module mapping is by the shared `file` first-class attribute: the `IMPORTS_FROM`
//! endpoints and the `MODULE` nodes both carry a `file` column, and a module owns a file iff
//! its `file` attr equals the endpoint's `file` attr. (The orchestrator reaches the same
//! mapping by parsing the file segment out of the endpoint's semantic-id string and looking it
//! up in a file→MODULE map built from MODULE nodes' `file` attr, main.rs:290-301 — the join on
//! the `file` value is the relational equivalent.)
//!
//! `@materialize(edge_type="DEPENDS_ON")` writes each derived `depends(Msrc, Mdst)` fact back
//! as a real `DEPENDS_ON` edge through the executor's write-back path, with the provenance
//! stamp the materialize layer attaches.

/// The bundled `depends/2` rule program (module→module `DEPENDS_ON`). See module docs.
///
/// `pub` so the server's `MaterializeDatalog` dispatch can run the CANONICAL depends rule
/// (empty wire `source` ⇒ this bundled rule) — the orchestrator triggers DEPENDS_ON
/// derivation without carrying the rule text, keeping a single source of truth (no drift).
pub const DEPENDS_DL: &str = include_str!("stdlib/depends.dl");

/// The bundled method-call-resolution rule pack — the in-engine replacement for the
/// `plugins/method-call-resolver.mjs` batch plugin (which walked the CALL set over N+1
/// client round-trips and timed out at 60s on real graphs). Two strategies, both
/// `@materialize(edge_type = "CALLS", mode = "additive")` (CALLS is SHARED with the
/// analyzers — additive write-back never tombstones):
/// - `resolved_method_call`: receiver INSTANCE_OF class → HAS_METHOD → name match
///   (the plugin's precision strategy);
/// - `resolved_unique_call`: the method name is unique across all METHOD nodes.
pub const METHOD_CALLS_DL: &str = include_str!("stdlib/method_calls.dl");

/// The bundled shape-verification rule pack — the in-engine replacement for the
/// `plugins/shape-verifier.mjs` batch plugin. Flags dotted CALLs whose receiver's
/// declared type (CLASS/INTERFACE, EXTENDS-closed) lacks the called member, as
/// `@materialize(edge_type = "SHAPE_VIOLATION", mode = "exclusive", meta(method))`
/// edges CALL → type (the type is pack-owned, so fixed violations retract on rerun),
/// PLUS one `@materialize_node(node_type = "ISSUE", mode = "exclusive",
/// meta(method, receiverType))` node per violating call — semantic id
/// `issue::shape-violation::<decimal call id>` (the plugin's id convention), name
/// `Method .<m> not found on <Type>` (the plugin's message). Node exclusive mode is
/// PROVENANCE-SCOPED: the orchestrator diagnostics phase's ISSUE nodes are untouched.
///
/// ORDERING: must run AFTER [`METHOD_CALLS_DL`] — its skip-resolved filter reads
/// CALLS as EDB (legal here: this program does not materialize CALLS).
pub const SHAPE_VERIFIER_DL: &str = include_str!("stdlib/shape_verifier.dl");

/// The bundled Axum route-detection rule pack — `plugins/axum-route-detector.mjs`
/// ported as edges + the `http:route` node. Derives, from `.route("/path",
/// get(handler))` calls in Rust files (argument positions read via `edge_attr` on
/// PASSES_ARGUMENT `index`):
/// - `ROUTES_TO`  (route CALL → handler, `meta(method, path)`),
/// - `HANDLED_BY` (path LITERAL → handler, `meta(method)`),
/// - one `@materialize_node(node_type = "http:route", mode = "exclusive",
///   meta(method, path))` node per route — semantic id `http:route::<METHOD>::<PATH>`,
///   name = the path, handler not required (plugin parity). The plugin's
///   EXPOSES/HANDLES edges to the route node are NOT ported (same-run node→edge
///   endpoints are out of scope — see the `.dl` header).
///
/// Both target edge types are pre-registered SHARED vocabulary
/// (`packages/types/src/edges.ts`) ⇒ `mode = "additive"` on both edge heads; the node
/// head is exclusive (provenance-scoped, safe on the shared `http:route` type).
pub const AXUM_ROUTES_DL: &str = include_str!("stdlib/axum_routes.dl");

/// The bundled Go same-module import-resolution pack — the in-engine
/// replacement for the import slice of the `go-resolve` daemon
/// (`GoImportResolution.hs`): IMPORT → MODULE `IMPORTS_FROM`, driven by the
/// GO module-path WORKSPACE_PACKAGE fact (orchestrator precondition P1).
/// The exact `isStdLib` gate rides the `first_segment` builtin; the
/// module-prefix arm is the C1-legal prefix-peel equality join. `IMPORTS_FROM`
/// is SHARED vocabulary ⇒ additive. Deltas numbered in the `.dl` header
/// (G2-2 first-MODULE multiplicity is the only live one).
pub const GO_IMPORTS_DL: &str = include_str!("stdlib/go_imports.dl");

/// The NO-go.mod VARIANT of [`GO_IMPORTS_DL`] — the legacy empty-module-path
/// suffix fallback (`findBySuffix`), '/'-boundary suffixes by `first_segment`
/// left-peel. A pack cannot test "the go.mod fact is absent" (the §3
/// cross-join), so the ORCHESTRATOR selects the variant: this pack runs ONLY
/// when go.mod did not resolve (run_stdlib_rule_packs' selection condition);
/// both variants stay registered so the cross-registry order pin holds.
pub const GO_IMPORTS_NOMOD_DL: &str = include_str!("stdlib/go_imports_nomod.dl");

/// The bundled Go call-resolution pack — the in-engine replacement for the
/// `GoCallResolution.hs` slice of `go-resolve`: the three legacy strategies
/// (package-qualified via same-file import alias + the C1-legal peel-join
/// package index; same-package receiverless; same-package method by global
/// (receiver, name) index), exclusive dispatch on the CALL's `receiver`
/// metadata. `CALLS` additive, NO meta (legacy stamps none). Bounded
/// last-wins SUPERSET deltas numbered in the `.dl` header.
pub const GO_CALLS_DL: &str = include_str!("stdlib/go_calls.dl");

/// The bundled Go interface-satisfaction pack — the in-engine replacement for
/// the `GoInterfaceSatisfaction.hs` slice of `go-resolve`: structural
/// duck-typing CLASS → INTERFACE `IMPLEMENTS` by method-name subset, the
/// ∀-subset spelled as two strata of negation seeded through a shared method
/// name (the planner-legal substitute for the CLASS×INTERFACE product).
/// Structural INTERFACE-CONTAINS-FUNCTION membership replaces the legacy
/// `[in:Iface]` semantic-id parse — which is DEAD on real (percent-encoded)
/// wire ids, so the pack RESTORES interface satisfaction (`.dl` DELTA G6-1).
/// Additive; G6-2/G6-3 (struct- and interface-side name merges) numbered in
/// the `.dl` header.
pub const GO_INTERFACES_DL: &str = include_str!("stdlib/go_interfaces.dl");

/// The bundled Go type-resolution pack — the in-engine replacement for the
/// `GoTypeResolution.hs` slice of `go-resolve`: VARIABLE → type `TYPE_OF` and
/// FUNCTION → type `RETURNS` (comma-peeled `return_type`, recursive `*`/`[]`
/// strip, 21 primitive ground facts). Both heads additive, no meta.
pub const GO_TYPES_DL: &str = include_str!("stdlib/go_types.dl");

/// The bundled Go context-propagation pack — the in-engine replacement for
/// the `GoContextPropagation.hs` slice of `go-resolve`:
/// `PROPAGATES_CONTEXT` (enclosing fn → target) plus `SPAWNS_WITH_CONTEXT` /
/// `DEFERS_WITH_CONTEXT` (call → target), `unresolved="true"` meta iff the
/// TARGET is only possibly-context. CONSUMES committed CALLS on .go files —
/// MUST run after [`GO_CALLS_DL`] (precondition P2). The CONTAINS-parent
/// enclosing-fn join REFINES a legacy defect (the `[in:parent,h:xxxx]` parse
/// never matched a real function name — `.dl` DELTA G9-3).
pub const GO_CONTEXT_DL: &str = include_str!("stdlib/go_context.dl");

/// The bundled JS/TS local-reference resolution pack — the in-engine replacement
/// for the `JsLocalRefs.hs` resolver (the #1 edge producer per the perf memory:
/// REFERENCE → same-file declaration `READS_FROM` over 8 declaration types,
/// skipping import bindings and a compiled-in 97-name runtime-global list,
/// reproduced verbatim as ground facts). File-flat by design — the resolver
/// matched on (file, name) only (parity over ambition). `READS_FROM` is SHARED
/// vocabulary ⇒ `mode = "additive"`; `resolvedVia = "js-local-refs"` rides as a
/// meta column. Deltas (set-semantics superset on duplicate decls, the 8-extension
/// language gate) are numbered in the `.dl` header.
pub const JS_LOCAL_REFS_DL: &str = include_str!("stdlib/js_local_refs.dl");

/// The bundled JS/TS same-file call-resolution pack — the in-engine replacement
/// for the `SameFileCalls.hs` resolver. Five arms: direct call → FUNCTION,
/// → VARIABLE/CONSTANT (FUNCTION-precedence ladder via negation), uppercase
/// constructor → CLASS (26 `upper/1` ground facts + `starts_with`),
/// this/super/`<obj>` method calls via the Wave-0-verified SCOPE chain
/// (CONTAINS + owner-vs-lexical-filtered HAS_SCOPE parents — replaces the
/// resolver's line-range containment), and `ClassName.staticMethod` via the
/// concat-equality first-dot split. All heads `CALLS` additive with
/// `resolvedVia = "same-file-calls"` meta. Scope-chain vs line-containment
/// deltas are numbered in the `.dl` header.
pub const JS_SAME_FILE_CALLS_DL: &str = include_str!("stdlib/js_same_file_calls.dl");

/// The bundled JS/TS `this.method()` resolution pack — the in-engine replacement
/// for the `JsThisMethodCalls.hs` resolver, which was the sole occupant of the
/// orchestrator's SECOND full-graph streaming pass (pure IPC, now dead).
/// File-flat (file, name) METHOD lookup with the exactly-one neq/ambig idiom,
/// the resolver's own 6-extension gate, and the concat-equality construction
/// that reproduces the resolver's "this." strip exactly (multi-dot names are
/// NOT a delta). `CALLS` additive, `resolvedVia = "js-this-method-calls"` meta.
pub const JS_THIS_METHOD_CALLS_DL: &str = include_str!("stdlib/js_this_method_calls.dl");

/// The bundled Rust same-file call-resolution pack — the in-engine replacement
/// for the `RustCallResolution.hs` resolver: exact (file, name) CALL → FUNCTION
/// match (also covers receiver-shaped method calls and qualified assoc-fn
/// names — the resolver never conditioned on the receiver), then the
/// `'::'`-suffix fallback (concat-built `"::" ++ name` suffix + `ends_with`),
/// gated by the `\+ has_exact` preference negation. The resolved-constructor
/// arm is deliberately NOT here (Wave 1b, `rust_cross_methods_ctor`). `CALLS`
/// additive, `resolvedVia = "rust-calls"` meta.
pub const RUST_CALLS_DL: &str = include_str!("stdlib/rust_calls.dl");

/// The bundled Rust resolved-constructor receiver-typing pack (Wave 1b) — the
/// in-engine replacement for the resolved-constructor ARM of the
/// `RustCrossMethodCalls.hs` resolver: `let w = Widget::new(); w.render()` —
/// the receiver's init CALL resolved (committed CALLS edge) to a method of
/// `impl TName` AND the init name contains `"TName::"` ⇒ method calls through
/// that receiver resolve to `TName`'s IMPL_BLOCK methods (HAS_METHOD prelude
/// shape). Reads CALLS from STORAGE while materializing CALLS (positive
/// self-read, stratifier-accepted) — MUST run AFTER [`RUST_CALLS_DL`], the
/// cross-pack EDB seam. Coverage SUBSET of the resolver arm (requires the init
/// call to have resolved) — deltas numbered in the `.dl` header. `CALLS`
/// additive, `resolvedVia = "rust-cross-method"` + `receiverType` meta.
pub const RUST_CROSS_METHODS_CTOR_DL: &str = include_str!("stdlib/rust_cross_methods_ctor.dl");

// ── Rust Wave-2 packs (node_attr-unblocked) ────────────────────────────────

/// The bundled Rust trait-implementation pack (Wave 2) — the in-engine
/// replacement for the WHOLE `RustTraitResolution.hs` resolver: an
/// `IMPLEMENTS` edge from each `impl Trait for Type` block's self type
/// (STRUCT, plus CLASS as a superset) to the TRAIT node. `node_attr`
/// unblocked it: the trait name lives only in IMPL_BLOCK metadata
/// (`rust_analyzer.rs:802-804`). Qualified refs resolve via allowlisted
/// `strip_prefix` arms (`crate::`/`self::`/`super::` roots only — external
/// roots derive nothing BY POLICY, never a false edge onto a same-named local
/// trait); deltas numbered in the `.dl` header. `IMPLEMENTS` additive (shared
/// with the legacy resolver during the hybrid rollout), no meta columns
/// (legacy metadata was empty).
pub const RUST_TRAIT_RESOLVE_DL: &str = include_str!("stdlib/rust_trait_resolve.dl");

/// The bundled Rust annotation/return-type receiver-typing pack (Wave 2) —
/// the typeAnnotation + returnType arms of `RustCrossMethodCalls.hs` that
/// `node_attr` unblocked: `let w: Widget; w.render()` (arm A) and
/// `let m = make_widget(); m.render()` via the resolved init call's declared
/// returnType (arm B — DEAD in legacy production: the orchestrator shipped
/// the resolver only ASSIGNED_FROM edges, so its CALLS-follow never fired).
/// Arm B reads CALLS from STORAGE while materializing CALLS (positive
/// self-read) — MUST run AFTER [`RUST_CALLS_DL`], the same EDB seam as
/// [`RUST_CROSS_METHODS_CTOR_DL`]. Generic surfaces (`Vec<Foo>`) never reach
/// the pack — the analyzer stores base names ("Vec"); external-rooted
/// qualified surfaces derive nothing by policy. Deltas numbered in the `.dl`
/// header. `CALLS` additive, `resolvedVia = "rust-cross-method"` +
/// `receiverType` (raw surface) meta.
pub const RUST_RECEIVER_TYPING_DL: &str = include_str!("stdlib/rust_receiver_typing.dl");

/// The bundled Rust import-resolution pack (Wave 3b) — the in-engine
/// replacement for the WHOLE `RustImportResolution.hs` resolver: the module
/// tree (file path → `crate::…` module path, the Wave-3a string kit) plus
/// both phases — IMPORT → MODULE (`use crate::foo;`) and IMPORT_BINDING →
/// exported declaration (`use crate::foo::Bar;`, pub gate = the stored
/// `__exported` metadata key, source via the committed IMPORT -CONTAINS->
/// IMPORT_BINDING seam). The legacy Map-last-wins crate-root collision is
/// REFINED to a governed-directory arm (the importer must live under the
/// root's directory — never a cross-crate false edge); deltas numbered in
/// the `.dl` header. PRODUCER of `IMPORTS_FROM` (additive, empty meta =
/// legacy parity); once legacy rust-imports is gated off, `depends` must
/// move after it. node_attr + negation ⇒ scratch-only under maintain.
pub const RUST_IMPORTS_DL: &str = include_str!("stdlib/rust_imports.dl");

/// The bundled JS/TS cross-file call-resolution pack (Wave 1b, HYBRID) — the
/// in-engine replacement for the DIRECT + NAMESPACE arms of `CrossFileCalls.hs`,
/// consuming the LEGACY import resolver's committed `IMPORTS_FROM` edges as EDB
/// (the import-binding producer is not migrated yet; its edges exist at pack
/// time because analysis + legacy resolution run before the pack-runner). The
/// Wave-1 review's localName-aliasing caveat does NOT apply: the legacy producer
/// already disambiguated via importedName when it created the edge. Namespace
/// arm = "binding -IMPORTS_FROM-> MODULE" (the structural `importedName == "*"`
/// substitute) + export lookup; EXPORT_BINDING members excluded (aliased-name
/// false positives — node_attr/Wave 2). `CALLS` additive,
/// `resolvedVia = "cross-file-calls"` meta.
pub const JS_CROSS_FILE_CALLS_DL: &str = include_str!("stdlib/js_cross_file_calls.dl");

/// The bundled JS/TS namespace-import property-access pack (Wave 1b, HYBRID) —
/// the in-engine replacement for the NAMESPACE arm of `PropertyAccess.hs`
/// (`import * as utils; utils.config` → `READS_FROM` the export target,
/// matching what legacy emits: `resolvedVia = "property-access"`). Same EDB
/// seam and exported_in shape as [`JS_CROSS_FILE_CALLS_DL`]; the resolver's
/// other arms (this/static via metadata.base) live in
/// [`JS_PROPERTY_ACCESS_FULL_DL`] (Wave 2).
/// `READS_FROM` additive.
pub const JS_PROPERTY_ACCESS_NS_DL: &str = include_str!("stdlib/js_property_access_ns.dl");

// ── JS Wave-2 packs (node_attr-unblocked) ──────────────────────────────────

/// The bundled JS/TS import-binding resolution pack (Wave 2) — the in-engine
/// replacement for the named/aliased/default IMPORT_BINDING arms of
/// `ImportResolution.hs` that Wave 1 deliberately HELD BACK (the binding_import
/// false-positive trap: matching by localName alone emits WRONG edges for
/// `import {foo as bar}` / `import Foo from './Foo'`).
/// `node_attr(B, "importedName", IN)` now disambiguates them. Module-path
/// resolution is HYBRID — no path kernel: the binding's parent IMPORT's legacy
/// `IMPORTS_FROM → MODULE` edge gives the resolved target file. Namespace
/// (`IN == "*"`) is excluded (stays the legacy producer's arm, ridden by the
/// Wave-1b consumers — no duplication); re-export chain following and star
/// probing are the pinned Wave-2b SUBSET delta (legacy still emits those, so
/// the hybrid graph loses nothing). PRODUCER of `IMPORTS_FROM` — must precede
/// the IMPORTS_FROM consumers (`js_class_inheritance`, `js_cross_file_calls`,
/// `js_property_access_ns`). `IMPORTS_FROM` additive, empty meta (legacy
/// parity). node_attr ⇒ scratch-only under maintain.
pub const JS_IMPORT_BINDINGS_DL: &str = include_str!("stdlib/js_import_bindings.dl");

/// The bundled JS/TS class-inheritance pack (Wave 2) — the in-engine
/// replacement for the ENTIRE `ClassInheritance.hs` resolver: the superclass
/// name lives ONLY in CLASS metadata (`superClass`, Declarations.hs:320-337),
/// so the whole resolver was node_attr-blocked until now. Same-file arm first;
/// the cross-file arm (gated by the resolver's fall-through negation) follows
/// the import-binding's committed `IMPORTS_FROM` edge — the same HYBRID seam
/// as [`JS_CROSS_FILE_CALLS_DL`], so aliased/default superclass imports
/// resolve correctly. `EXTENDS` is SHARED vocabulary (the shape-tracker plugin
/// also emits it) ⇒ additive on both heads; `resolvedVia = "class-inheritance"`
/// meta (the legacy importedFrom meta is a recorded loss). PRODUCER of
/// `EXTENDS` for `shape_verifier`'s inheritance closure — must precede it.
/// node_attr ⇒ scratch-only under maintain.
pub const JS_CLASS_INHERITANCE_DL: &str = include_str!("stdlib/js_class_inheritance.dl");

/// The bundled JS/TS same-file property-access pack (Wave 2) — the remaining
/// arms of `PropertyAccess.hs` that the ns pack held: `this/super/<obj>.prop`
/// via the Wave-0-verified SCOPE chain (replacing the resolver's line-range
/// containment) and `ClassName.staticProp` via the 26-clause uppercase test,
/// both reading the receiver from `node_attr(PA, "base", …)` (metadata-only;
/// gnName is the BARE member name). Members via `CLASS -HAS_METHOD->` (the
/// `[in:Class]` sid substitute) plus a PROPERTY_ASSIGNMENT/className clause
/// kept for spec parity (zero rows on current graphs — the analyzer emits
/// PROPERTY nodes, which the resolver never indexed either). Together with
/// [`JS_PROPERTY_ACCESS_NS_DL`] this covers the entire resolver. `READS_FROM`
/// additive, `resolvedVia = "property-access"` meta. node_attr ⇒ scratch-only
/// under maintain.
pub const JS_PROPERTY_ACCESS_FULL_DL: &str = include_str!("stdlib/js_property_access_full.dl");

/// Node half of the Builtins.hs replacement (Wave 2b): EXTERNAL_MODULE +
/// EXTERNAL_FUNCTION minting via `@materialize_node`, byte-identical legacy
/// semantic ids (`EXTERNAL_MODULE:<m>` / `EXTERNAL_FUNCTION:<m>.<fn>`),
/// registry as generated ground facts, NOT registry-gated (the Wave-1 verdict
/// fix), `module` projected into metadata for the edges pack's node_attr
/// join. node_attr + negation + minting ⇒ scratch-only under maintain.
pub const JS_BUILTINS_NODES_DL: &str = include_str!("stdlib/js_builtins_nodes.dl");

/// Edge half of the Builtins.hs replacement (Wave 2b): IMPORTS_FROM
/// IMPORT→EXTERNAL_MODULE + CALLS CALL→EXTERNAL_FUNCTION (method arm
/// first-dot split + the direct-call arm), endpoints pinned by
/// (name, node_attr module, file "<builtin>"). MUST run after
/// `js_builtins_nodes` (committed-EDB endpoint join — the two-pack split for
/// same-run-minted endpoints). Both heads additive (shared vocabulary).
pub const JS_BUILTINS_EDGES_DL: &str = include_str!("stdlib/js_builtins_edges.dl");

/// Node half of the `runtime-call-globals` replacement (Wave 4):
/// GLOBAL_DEFINITION minting (legacy sid `GLOBAL::<seName>`) for JS CALL
/// nodes matching the effects-db SymbolDB — the generated `rtg_key`/`rtg_eff`
/// ground facts (js_runtime_globals_facts.dl, prepended at compile time;
/// regenerate via scripts/generate-runtime-globals-facts.mjs) joined through
/// the allSuffixes/firstMatch encoding (longest matching dot-suffix wins) with
/// the isLocallyResolved skip. Negation + minting ⇒ scratch-only under
/// maintain.
pub const JS_RUNTIME_GLOBALS_NODES_DL: &str = concat!(
    include_str!("stdlib/js_runtime_globals_facts.dl"),
    "\n",
    include_str!("stdlib/js_runtime_globals_nodes.dl"),
);

/// Edge half of the `runtime-call-globals` replacement (Wave 4): CALLS
/// CALL→GLOBAL_DEFINITION, endpoints pinned by (name, file "<runtime/js>"),
/// meta resolvedVia="runtime-globals" globalCategory="ecmascript" (legacy
/// mkEdge payload). MUST run after `js_runtime_globals_nodes` (committed-EDB
/// endpoint join — the js_builtins two-pack split). Additive (CALLS is shared
/// vocabulary).
pub const JS_RUNTIME_GLOBALS_EDGES_DL: &str = concat!(
    include_str!("stdlib/js_runtime_globals_facts.dl"),
    "\n",
    include_str!("stdlib/js_runtime_globals_edges.dl"),
);

/// The Kotlin inheritance pack — EXTENDS (class supertype) + IMPLEMENTS
/// (interface supertypes) from the kotlin-analyzer's CLASS metadata stamps
/// (`extends` single key + `implements_0..n` indexed keys — the list-valued
/// metadata convention). Closes the lang-spec-kotlin step-5 gap: kotlin
/// classes had ZERO inheritance edges in production (the analyzer's deferred
/// InheritanceResolve refs are dropped by the orchestrator, and the legacy
/// kotlin-resolve metadata arms read keys the analyzer never stamped) — every
/// edge is a declared superset vs legacy-zero. Resolution scope: same-file +
/// same-package-by-directory arms only (cross-file via imports = next wave,
/// SUBSET delta). Bare class supertypes of no-primary-constructor classes
/// (the Kotlin syntactic ambiguity) are re-classified by the resolved
/// declaration's `kind` (interface → IMPLEMENTS, else EXTENDS recovery arms).
/// Both edge types are pre-registered SHARED vocabulary
/// (`packages/types/src/edges.ts`) ⇒ `mode = "additive"` on all heads,
/// `resolvedVia = "kotlin-inheritance"` meta. PRODUCER of EXTENDS — must run
/// before shape_verifier (its EXTENDS-closed member lookup); consumes
/// analyzer EDB only. node_attr ⇒ scratch floor under maintain.
pub const KOTLIN_INHERITANCE_DL: &str = include_str!("stdlib/kotlin_inheritance.dl");

/// The bundled Haskell local-call-resolution pack — the in-engine replacement for
/// the `HaskellLocalCalls.hs` resolver: a `CALLS` edge from each same-file `.hs`
/// CALL of a value-name to its same-file VALUE binding, as the SINGLE callable
/// target. Haskell CALLs carry NO scope container and NO receiver metadata (both
/// live-queried = 0), so resolution is the flat (file, name) join — the only
/// mechanism available, exactly as the resolver did. Callable namespaces (KEEP):
/// FUNCTION, VARIABLE, CONSTANT, CONSTRUCTOR, RECORD_FIELD; TYPE_SIGNATURE is
/// DROPPED (Q-fix — a call does not call a signature, the x4.8 differential
/// source). Single-target via NAMESPACE-PRIORITY (FUNCTION > VARIABLE > CONSTANT >
/// CONSTRUCTOR > RECORD_FIELD) through stratified negation (`\+ has_<higher>`, the
/// js_same_file_calls placement — has_* derive only from positive cand_*, no
/// negation cycle); NO aggregate (E-AGG-001). Q1 (in-scope local SHADOWS import):
/// emit CALLS whenever a same-file callable binding exists, regardless of import —
/// the legacy blanket himp skip-set gate is DROPPED. Q3 (qualified = non-local):
/// no `.`-split bare-name strip — the analyzer stores bare names and dotted CALL
/// names are operators that match local operator defs by their literal name.
/// `CALLS` additive (SHARED with the analyzers), `resolvedVia = "haskell-local-calls"`
/// meta (identical to legacy provenance). PRODUCER of `CALLS` — must run BEFORE the
/// CALLS negators `method_calls`/`shape_verifier` (shape_verifier negates
/// `edge(C,_,"CALLS")` with NO file gate); consumes analyzer EDB only. Deltas
/// numbered in the `.dl` header.
pub const HASKELL_LOCAL_CALLS_DL: &str = include_str!("stdlib/haskell_local_calls.dl");

/// Haskell same-file refs (haskell-resolve migration). NODE half: mints the
/// virtual `HASKELL_GLOBAL::<name>` EXTERNAL_FUNCTION prelude endpoints
/// (category="haskell-prelude") that `haskell_local_refs` joins as committed
/// EDB for its prelude fall-through (the js_runtime_globals two-pack split —
/// a @materialize edge endpoint must be a committed node-ID column). Byte-
/// identical sids to HaskellLocalRefs.hs:139,152-157 (dedup against the legacy
/// step + hybrid graphs). `mode = "exclusive"` is PROVENANCE-SCOPED. Negation +
/// node minting ⇒ scratch floor under maintain.
pub const HASKELL_LOCAL_REFS_NODES_DL: &str = include_str!("stdlib/haskell_local_refs_nodes.dl");

/// Haskell same-file refs (haskell-resolve migration). EDGE half: REFERENCE →
/// READS_FROM, `resolvedVia = "haskell-local-refs"` meta — replaces
/// HaskellLocalRefs.resolveAll. Fixes the legacy flat last-write-wins
/// (file,name) Map (Hs:48-55) cross-scope collapse: a same-scope PARAMETER/
/// VARIABLE local hit (the analyzer CONTAINS-parents these at the ref's own
/// scope id — the dominant bug) suppresses the single-target flat (file,name)
/// fallback over the value decl types (FUNCTION > VARIABLE > CONSTANT >
/// CONSTRUCTOR > RECORD_FIELD) then the TYPE namespace last (DATA_TYPE >
/// TYPE_SYNONYM); PARAMETER is INTENTIONALLY ABSENT from the flat arm (a flat
/// PARAMETER target is a foreign scope's param — the misroute bug as fan-out).
/// The flat arm in turn suppresses the prelude global fall-through. Local
/// FUNCTIONs are MODULE-flattened by the analyzer (Declarations.hs:48-49 etc.)
/// so the flat arm is the only recoverable resolution for them — no-worse than
/// legacy. CONSUMER of the nodes pack's minted endpoints (must run strictly
/// after). `READS_FROM` additive. Negation ⇒ scratch floor.
pub const HASKELL_LOCAL_REFS_DL: &str = include_str!("stdlib/haskell_local_refs.dl");

/// The JS module-path kernel pack (Wave 3b, path/string-kit-unblocked): the
/// in-engine replacement for the module-level arms of `ImportResolution.hs` —
/// IMPORT → MODULE `IMPORTS_FROM` (`resolveModuleImports`) and star re-export
/// EXPORT → MODULE `RE_EXPORTS` (`resolveStarReExports`, incl. the ModuleIndex
/// fallback). Relative specifiers via `path_resolve` + the 15-rank
/// first-match candidate ladder (exact > extension swap > +ext > /index >
/// .d.ts) probed against ExportIndex membership (EXPORT/EXPORT_BINDING
/// presence — live-verified exact), NOT bare MODULE presence (the verdict
/// fix). Workspace/bare specifiers are a documented SUBSET delta (no
/// WORKSPACE_PACKAGE facts in the graph yet). SHADOW alongside legacy; both
/// heads additive, meta `resolvedPath` (legacy parity). PRODUCER of the
/// IMPORT→MODULE `IMPORTS_FROM` seam and of `RE_EXPORTS` — must precede
/// `js_import_bindings` (whose `b_mod`/`resolved_at`/`star_src` joins read
/// them as committed EDB) and the other IMPORTS_FROM consumers. Negation
/// (the rank ladder) ⇒ scratch-only under maintain.
pub const JS_MODULE_IMPORTS_DL: &str = include_str!("stdlib/js_module_imports.dl");

/// Node half of the JS HTTP-route feature vertical (Wave 14, REG-1115 slice):
/// `http:route` minting (sid `<file>::http:route::<name>::<callIdDecimal>`)
/// + ROUTES_TO for Express/Fastify/Koa(+routers)/Hono registrations — the
/// derive-pack REPLACEMENT for libraryCallbackEnricher.ts's HTTP slice (the
/// 6 framework entries were retired from its LIBRARY_NODE_TYPE map in this
/// wave; the enricher keeps only cli:command/mcp:tool/vscode:command —
/// running both would mint duplicate http:route nodes with byte-different
/// ids), driven by the effects-db callable registry as generated
/// ground facts (effects_callable_facts.dl, prepended at compile time;
/// regenerate via scripts/generate-effects-callable-facts.mjs). Receiver
/// resolution = RECEIVER_CALL chain origin + IMPORT_BINDING `source` +
/// CONSTANT/VARIABLE initializer hops (incl. factory calls — delta 2).
/// Negation + minting ⇒ scratch-only under maintain.
pub const JS_HTTP_ROUTES_NODES_DL: &str = concat!(
    include_str!("stdlib/effects_callable_facts.dl"),
    "\n",
    include_str!("stdlib/js_http_routes_nodes.dl"),
);

/// Edge half of the JS HTTP-route vertical (Wave 14): EXPOSES
/// (CALL → http:route) + HANDLES (http:route → callback), endpoints pinned by
/// the exact `node_attr(R,"anchorCall") ⋈ attr(C,"id")` join — other
/// producers' http:route nodes (axum_routes, the legacy enricher) are never
/// joined. MUST run after `js_http_routes_nodes` (committed-EDB endpoint
/// join — the js_builtins two-pack split). Both heads additive (EXPOSES /
/// HANDLES are shared enricher vocabulary).
pub const JS_HTTP_ROUTES_EDGES_DL: &str = concat!(
    include_str!("stdlib/effects_callable_facts.dl"),
    "\n",
    include_str!("stdlib/js_http_routes_edges.dl"),
);

/// Node half of the JS ENTRY-POINT-FEATURE vertical (Loop-2, continues the
/// Wave-14 js_http_routes prototype): the three remaining domain slices the
/// libraryCallbackEnricher still mints — commander → `cli:command`,
/// `@modelcontextprotocol/sdk` → `mcp:tool`, vscode → `vscode:command` — minted
/// as @materialize_node FEATURE nodes (sid
/// `<file>::<nodeType>::<name>::<callIdDecimal>`). The derive-pack REPLACEMENT
/// for those three LIBRARY_NODE_TYPE entries (retired this wave, like the 6 HTTP
/// frameworks in Wave 14); running both would mint duplicate FEATURE nodes with
/// byte-different ids. ONE combined pack: the three slices share the entire
/// receiver-resolution prelude, differing only in the registry lib set, the
/// per-lib node_type (three @materialize_node heads, node_type is a string
/// literal), and the name-source role (COMMAND_NAME vs TOOL_SCHEMA). Receiver
/// resolution covers BOTH the RECEIVER_CALL chain (the js_http_routes prelude)
/// AND the DERIVES_FROM[callee]/READS_FROM[receiver] PROPERTY_ACCESS walk for
/// `<obj>.`-rooted chained receivers (NEW — js_http_routes delta 3 omitted it;
/// REQUIRED for vscode and commander). Driven by the effects-db callable
/// registry as generated ground facts (effects_callable_facts.dl, prepended at
/// compile time). The MCP ~30-tool detail is the SEPARATE mcpToolDefinitionEnricher
/// (this pack matches the enricher's ~4 setRequestHandler calls — documented
/// SUBSET delta). Negation + minting ⇒ scratch-only under maintain.
pub const JS_ENTRYPOINT_FEATURES_NODES_DL: &str = concat!(
    include_str!("stdlib/effects_callable_facts.dl"),
    "\n",
    include_str!("stdlib/js_entrypoint_features_nodes.dl"),
);

/// Edge half of the JS ENTRY-POINT-FEATURE vertical (Loop-2): EXPOSES
/// (CALL → FEATURE) + HANDLES (FEATURE → callback) over the cli:command /
/// mcp:tool / vscode:command nodes minted by `js_entrypoint_features_nodes`,
/// endpoints pinned by the exact `node_attr(R,"anchorCall") ⋈ attr(C,"id")` join
/// (per-node-type, so each head binds only its FEATURE type) — the
/// mcpToolDefinitionEnricher's def-anchored mcp:tool nodes and any legacy
/// enricher nodes are never joined. MUST run after `js_entrypoint_features_nodes`
/// (committed-EDB endpoint join — the js_builtins two-pack split). Both heads
/// additive (EXPOSES / HANDLES are shared enricher vocabulary).
pub const JS_ENTRYPOINT_FEATURES_EDGES_DL: &str = concat!(
    include_str!("stdlib/effects_callable_facts.dl"),
    "\n",
    include_str!("stdlib/js_entrypoint_features_edges.dl"),
);

// ── RFD-75 connascence-of-value vertical (version:ref → version:coord) ──────

/// Node half of the RFD-75 version-consistency vertical: mints one
/// `version:coord` node per DISTINCT `coord` carried by the `version:ref` nodes
/// the versionRefEnricher committed (package.json version + @grafema/* dep pins
/// + git tag + CHANGELOG top). sid = `version:coord::<coord>`; coord rides the
/// node's own metadata (meta(coord)) so the edge pack reads it back via
/// node_attr for the ref→coord join. Pure positive joins, no negation ⇒
/// incrementally maintainable. PRODUCER of the version:coord nodes the edge
/// pack joins — strictly before `version_refs_edges`.
pub const VERSION_COORDS_NODES_DL: &str = include_str!("stdlib/version_coords_nodes.dl");

/// Edge half of the RFD-75 vertical: REFERS_TO (version:ref → version:coord),
/// joining the committed version:ref nodes against the committed version:coord
/// nodes BY COORD NAME (node_attr equality on both sides). MUST run after
/// `version_coords_nodes` (committed-EDB endpoint join). REFERS_TO is shared
/// vocabulary (packages/types RefersToEdge) ⇒ mode = "additive". Pure positive
/// joins, no negation ⇒ incrementally maintainable.
pub const VERSION_REFS_EDGES_DL: &str = include_str!("stdlib/version_refs_edges.dl");

// ── Java packs (the java-resolve migration, lang-spec-java.md) ─────────────

/// Java import resolution — replaces `ImportResolution.hs` of `java-resolve`:
/// IMPORT → declaration `IMPORTS_FROM` (qualified-name kernel) plus the
/// IMPORT_BINDING arm via the graph-native IMPORT-CONTAINS-binding edge (a
/// DECLARED SUPERSET: the legacy metadata-`source` path was production-dead,
/// spec §2 D1). PRODUCER of java `IMPORTS_FROM` — must precede `depends`
/// (verdict C3: depends consumes EVERY IMPORTS_FROM edge node-type-
/// agnostically). node_attr + negation ⇒ scratch-only under maintain.
pub const JAVA_IMPORTS_DL: &str = include_str!("stdlib/java_imports.dl");

/// Java type-position resolution — replaces `TypeResolution.hs`: RETURNS /
/// TYPE_OF / EXTENDS / IMPLEMENTS / THROWS_TYPE against the simple-name class
/// kernel. Multi-element `implements`/`throws` are comma-split via the
/// right-peel recursion (verdict C1 — full parity, delta class 6 closed);
/// EXTENDS keeps the legacy no-split miss exactly. node_attr + negation ⇒
/// scratch-only under maintain.
pub const JAVA_TYPES_DL: &str = include_str!("stdlib/java_types.dl");

/// Java call resolution — replaces `CallResolution.hs`: INSTANTIATES + ctor
/// CALLS, same-class no-receiver CALLS (a DECLARED SUPERSET — the legacy sid
/// probe fired only inside constructors, spec §2 D3), static-style CALLS and
/// super()/this() delegation, all on graph-native HAS_METHOD/CONTAINS
/// membership instead of sid parses. PRODUCER of `CALLS` — must precede the
/// CALLS negators `method_calls`/`shape_verifier` (verdict C3). node_attr +
/// negation ⇒ scratch-only under maintain.
pub const JAVA_CALLS_DL: &str = include_str!("stdlib/java_calls.dl");

/// Java annotation resolution — replaces `AnnotationResolution.hs`:
/// ANNOTATION_RESOLVES_TO from ATTRIBUTE usages to same-named
/// ANNOTATION_TYPE declarations, .java-gated on BOTH legs (kotlin emits both
/// node types). No node_attr, no negation — maintain-eligible.
pub const JAVA_ANNOTATIONS_DL: &str = include_str!("stdlib/java_annotations.dl");

/// The named stdlib rule packs, addressable on the wire as `"@stdlib/<name>"`
/// (`MaterializeDatalog` and the other empty-source-defaulting dispatchers), listed
/// in CANONICAL RUN ORDER. The order is a CONTRACT, not cosmetics — producers run
/// strictly before consumers:
/// - the four Wave-1 resolver packs (`js_local_refs`, `js_same_file_calls`,
///   `js_this_method_calls`, `rust_calls`) produce the `READS_FROM`/`CALLS` state
///   that the downstream packs consume;
/// - `rust_cross_methods_ctor` (Wave 1b) reads the CALLS edges `rust_calls`
///   committed as storage EDB (the resolved-constructor seam), so it runs
///   strictly after `rust_calls`;
/// - `js_cross_file_calls` and `js_property_access_ns` (Wave 1b, hybrid) consume
///   committed IMPORTS_FROM edges as EDB — present since analysis time (legacy)
///   and topped up by `js_import_bindings` — and, as CALLS/READS_FROM producers,
///   must precede the fuzzy fallback and the negators below;
/// - `method_calls` (the fuzzy fallback) reads `READS_FROM` receiver chains as
///   EDB, so it runs after every READS_FROM producer above;
/// - `shape_verifier` NEGATES `CALLS` (skip-resolved) and `READS_FROM` (the
///   PA-fallback guard) as EDB, so it MUST run after every CALLS/READS_FROM
///   producer above — running earlier would flag calls a later pack resolves.
/// - the Rust Wave-2 packs follow `rust_cross_methods_ctor`:
///   `rust_receiver_typing` reads the CALLS edges `rust_calls` committed
///   (the same storage-EDB seam) and, as a CALLS producer, must precede the
///   fuzzy fallback and the negators; `rust_trait_resolve` consumes analyzer
///   EDB only (IMPL_BLOCK metadata + TRAIT/STRUCT/CLASS nodes).
/// - the JS Wave-2 packs: `js_import_bindings` PRODUCES `IMPORTS_FROM` (the EDB
///   seam) and runs before every IMPORTS_FROM consumer —
///   `js_class_inheritance` (cross-file arm), `js_cross_file_calls`,
///   `js_property_access_ns` (legacy import-resolution is gated since Wave 3c,
///   so this ordering IS load-bearing; `depends` — which also consumes
///   IMPORTS_FROM — moved after the producers); `js_class_inheritance` PRODUCES
///   `EXTENDS` for `shape_verifier`'s inheritance closure;
///   `js_property_access_full` produces `READS_FROM`, so it precedes
///   `method_calls`/`shape_verifier`.
/// - the Wave-2b builtins split: `js_builtins_nodes` MINTS the EXTERNAL_MODULE
///   / EXTERNAL_FUNCTION endpoints that `js_builtins_edges` joins as COMMITTED
///   EDB (the engine-sanctioned two-pack answer to same-run-minted edge
///   endpoints), so nodes run strictly before edges; the edges pack produces
///   CALLS + IMPORTS_FROM, so both precede `method_calls` / `shape_verifier`.
/// - the JS Wave-3b kernel pack: `js_module_imports` PRODUCES the
///   IMPORT→MODULE `IMPORTS_FROM` seam and `RE_EXPORTS` (the star seam) that
///   `js_import_bindings` (`b_mod`/`resolved_at`/`star_src`) and the Wave-1b
///   hybrid packs read as committed EDB, so it runs strictly before them.
/// - the Java packs (the java-resolve migration, canonical intra-family
///   order java_imports → java_types → java_calls → java_annotations):
///   `java_imports` PRODUCES java `IMPORTS_FROM`, so it precedes `depends`
///   (verdict C3 — depends consumes EVERY IMPORTS_FROM edge node-type-
///   agnostically via the file join); `java_calls` PRODUCES `CALLS`, so it
///   precedes the CALLS negators `method_calls`/`shape_verifier`
///   (shape_verifier negates `edge(C,_,"CALLS")` with NO file gate). The
///   packs have no inter-pack EDB seams among themselves.
/// - `depends` (Wave 3c position) CONSUMES IMPORTS_FROM — every edge of the
///   shared vocabulary, module- and binding-level — so with legacy
///   import-resolution GATED (GRAFEMA_SKIP_RESOLVE_STEPS) it runs after ALL
///   in-engine IMPORTS_FROM producers: `rust_imports`, `js_module_imports`,
///   `js_import_bindings`, `js_builtins_edges`, `java_imports`,
///   `go_imports`/`go_imports_nomod`. (It ran first while the legacy resolver
///   pre-committed those edges at analysis time.)
/// - the Go wave packs: `go_imports` / `go_imports_nomod` PRODUCE
///   IMPORTS_FROM (before `depends`, verdict C4); `go_calls` PRODUCES CALLS
///   for `go_context` (the P2 producer-before-consumer seam) and precedes the
///   CALLS negators (`method_calls` / `shape_verifier`); the nomod VARIANT is
///   selected by the orchestrator at runtime (P3 — only when go.mod is
///   absent), but stays in BOTH registries so the order pin holds.
/// An orchestrator running the packs sequentially must preserve this order:
/// js_local_refs → js_same_file_calls → js_this_method_calls →
/// rust_calls → rust_cross_methods_ctor → rust_trait_resolve →
/// rust_receiver_typing → rust_imports → js_module_imports →
/// js_import_bindings → js_class_inheritance →
/// js_cross_file_calls → js_property_access_ns → js_property_access_full →
/// js_builtins_nodes → js_builtins_edges → js_runtime_globals_nodes →
/// js_runtime_globals_edges → java_imports → java_types → java_calls →
/// java_annotations → kotlin_inheritance → haskell_local_calls → go_imports →
/// go_imports_nomod →
/// go_calls → go_interfaces → go_types → go_context → depends → method_calls →
/// shape_verifier → axum_routes → js_http_routes_nodes → js_http_routes_edges →
/// js_entrypoint_features_nodes → js_entrypoint_features_edges.
/// - the Wave-14 feature-detection pair: `js_http_routes_nodes` MINTS the
///   anchorCall-pinned http:route endpoints that `js_http_routes_edges` joins
///   as committed EDB (strict nodes→edges order, the js_builtins split);
///   both consume analyzer EDB only.
/// - the Loop-2 feature-detection pair: `js_entrypoint_features_nodes` MINTS
///   the anchorCall-pinned cli:command / mcp:tool / vscode:command FEATURE
///   endpoints that `js_entrypoint_features_edges` joins as committed EDB
///   (strict nodes→edges order, the js_builtins split); both consume analyzer
///   EDB only and replace the libraryCallbackEnricher's three remaining slices.
/// - the Kotlin wave: `kotlin_inheritance` PRODUCES EXTENDS/IMPLEMENTS for
///   shape_verifier's inheritance closure (analyzer EDB only), so it precedes
///   the negators.
/// - the Haskell wave: `haskell_local_calls` PRODUCES `CALLS` (same-file
///   flat (file, name) value-binding resolution, single-target via the
///   FUNCTION > VARIABLE > CONSTANT > CONSTRUCTOR > RECORD_FIELD namespace-
///   priority ladder), so it precedes the CALLS negators
///   `method_calls`/`shape_verifier`; consumes analyzer EDB only (no inter-pack
///   seam — any position before the negators is legal).
pub const STDLIB_PACKS: &[(&str, &str)] = &[
    ("js_local_refs", JS_LOCAL_REFS_DL),
    ("js_same_file_calls", JS_SAME_FILE_CALLS_DL),
    ("js_this_method_calls", JS_THIS_METHOD_CALLS_DL),
    ("rust_calls", RUST_CALLS_DL),
    ("rust_cross_methods_ctor", RUST_CROSS_METHODS_CTOR_DL),
    // Rust Wave-2 packs: rust_receiver_typing reads rust_calls' CALLS as EDB
    // (the same MUST-run-AFTER seam as rust_cross_methods_ctor);
    // rust_trait_resolve consumes analyzer EDB only.
    ("rust_trait_resolve", RUST_TRAIT_RESOLVE_DL),
    ("rust_receiver_typing", RUST_RECEIVER_TYPING_DL),
    // Rust Wave-3b pack: rust_imports PRODUCES IMPORTS_FROM (module tree +
    // both rust-imports phases) — strictly before the IMPORTS_FROM consumers
    // (js_cross_file_calls / js_property_access_ns; and depends, once legacy
    // rust-imports is gated off).
    ("rust_imports", RUST_IMPORTS_DL),
    // JS Wave-3b: js_module_imports PRODUCES the IMPORT→MODULE IMPORTS_FROM
    // seam (and RE_EXPORTS) that js_import_bindings' b_mod/resolved_at/
    // star_src joins and the Wave-1b hybrid packs consume as committed EDB —
    // strictly before all of them.
    ("js_module_imports", JS_MODULE_IMPORTS_DL),
    // JS Wave-2 packs: js_import_bindings PRODUCES IMPORTS_FROM — strictly
    // before its consumers (js_class_inheritance's cross-file arm and the two
    // Wave-1b hybrid packs); js_class_inheritance PRODUCES EXTENDS for
    // shape_verifier's closure.
    ("js_import_bindings", JS_IMPORT_BINDINGS_DL),
    ("js_class_inheritance", JS_CLASS_INHERITANCE_DL),
    ("js_cross_file_calls", JS_CROSS_FILE_CALLS_DL),
    ("js_property_access_ns", JS_PROPERTY_ACCESS_NS_DL),
    ("js_property_access_full", JS_PROPERTY_ACCESS_FULL_DL),
    // Wave 2b: js_builtins_nodes mints the EXTERNAL_* endpoints that
    // js_builtins_edges joins as committed EDB (strict nodes→edges order);
    // both are CALLS/IMPORTS_FROM producers, so they precede the fuzzy
    // fallback (method_calls) and the negator (shape_verifier).
    ("js_builtins_nodes", JS_BUILTINS_NODES_DL),
    ("js_builtins_edges", JS_BUILTINS_EDGES_DL),
    // Wave 4: js_runtime_globals_nodes mints the GLOBAL_DEFINITION endpoints
    // that js_runtime_globals_edges joins as committed EDB (strict
    // nodes→edges order); the edges pack is a CALLS producer, so the pair
    // precedes the fuzzy fallback (method_calls) and the negator
    // (shape_verifier).
    ("js_runtime_globals_nodes", JS_RUNTIME_GLOBALS_NODES_DL),
    ("js_runtime_globals_edges", JS_RUNTIME_GLOBALS_EDGES_DL),
    // Java packs (java-resolve migration): java_imports PRODUCES java
    // IMPORTS_FROM — strictly before depends (verdict C3); java_calls
    // PRODUCES CALLS — strictly before the negators method_calls /
    // shape_verifier. No inter-pack seams among the four.
    ("java_imports", JAVA_IMPORTS_DL),
    ("java_types", JAVA_TYPES_DL),
    ("java_calls", JAVA_CALLS_DL),
    ("java_annotations", JAVA_ANNOTATIONS_DL),
    // Kotlin wave: kotlin_inheritance PRODUCES EXTENDS for shape_verifier's
    // EXTENDS-closed member lookup — strictly before the negators; consumes
    // analyzer EDB only (CLASS metadata stamps), so no run-after seam.
    ("kotlin_inheritance", KOTLIN_INHERITANCE_DL),
    // Haskell same-file refs wave (haskell-resolve migration): haskell_local_refs_nodes
    // MINTS the HASKELL_GLOBAL::<name> EXTERNAL_FUNCTION prelude endpoints that
    // haskell_local_refs joins as committed EDB (strict nodes→edges order — the
    // js_runtime_globals two-pack split). haskell_local_refs PRODUCES READS_FROM
    // (REFERENCE→binder, nearest-binder scope-walk + single-target flat fallback).
    ("haskell_local_refs_nodes", HASKELL_LOCAL_REFS_NODES_DL),
    ("haskell_local_refs", HASKELL_LOCAL_REFS_DL),
    // haskell_local_calls PRODUCES CALLS (same-file flat (file,name)
    // value-binding resolution, single-target via namespace priority) — strictly
    // before the CALLS negators method_calls / shape_verifier (shape_verifier
    // negates edge(C,_,"CALLS") with NO file gate). Consumes analyzer EDB only
    // (CALL/FUNCTION/VARIABLE/CONSTANT/CONSTRUCTOR/RECORD_FIELD nodes), so it has
    // no inter-pack EDB seam — any position before the negators is legal.
    ("haskell_local_calls", HASKELL_LOCAL_CALLS_DL),
    // Go wave: go_imports / go_imports_nomod PRODUCE IMPORTS_FROM — strictly
    // before depends (verdict C4); the nomod VARIANT is orchestrator-selected
    // (P3: runs only when go.mod is absent — both registered, runtime skip).
    // go_calls PRODUCES CALLS — strictly before its consumer go_context (P2)
    // and before the CALLS negators method_calls / shape_verifier (C4).
    // go_interfaces / go_types consume analyzer EDB only.
    ("go_imports", GO_IMPORTS_DL),
    ("go_imports_nomod", GO_IMPORTS_NOMOD_DL),
    ("go_calls", GO_CALLS_DL),
    ("go_interfaces", GO_INTERFACES_DL),
    ("go_types", GO_TYPES_DL),
    ("go_context", GO_CONTEXT_DL),
    // Wave 3c: depends CONSUMES IMPORTS_FROM (every edge, module- and
    // binding-level) — with legacy import-resolution gated it must run after
    // ALL in-engine IMPORTS_FROM producers (rust_imports, js_module_imports,
    // js_import_bindings, js_builtins_edges). It was first while the legacy
    // resolver pre-committed those edges.
    ("depends", DEPENDS_DL),
    ("method_calls", METHOD_CALLS_DL),
    ("shape_verifier", SHAPE_VERIFIER_DL),
    ("axum_routes", AXUM_ROUTES_DL),
    // Wave 14 feature-detection vertical: js_http_routes_nodes MINTS the
    // http:route endpoints (anchorCall-pinned) that js_http_routes_edges
    // joins as committed EDB (strict nodes→edges order — the js_builtins
    // two-pack split). Both consume analyzer EDB only and produce nothing any
    // earlier pack reads, so they sit at the registry tail with axum_routes.
    ("js_http_routes_nodes", JS_HTTP_ROUTES_NODES_DL),
    ("js_http_routes_edges", JS_HTTP_ROUTES_EDGES_DL),
    // Loop-2 feature-detection vertical (the cli:command / mcp:tool /
    // vscode:command slices the libraryCallbackEnricher minted): the nodes pack
    // MINTS the anchorCall-pinned FEATURE endpoints that the edges pack joins as
    // committed EDB (strict nodes→edges order — the js_builtins two-pack split).
    // Both consume analyzer EDB only and produce nothing any earlier pack reads,
    // so they sit at the registry tail with js_http_routes.
    ("js_entrypoint_features_nodes", JS_ENTRYPOINT_FEATURES_NODES_DL),
    ("js_entrypoint_features_edges", JS_ENTRYPOINT_FEATURES_EDGES_DL),
    // RFD-75 connascence-of-value vertical: version_coords_nodes MINTS the
    // version:coord nodes (one per distinct coord) that version_refs_edges joins
    // as committed EDB to derive REFERS_TO (strict nodes→edges order — the
    // js_builtins two-pack split). Consume the enricher-minted version:ref EDB
    // only and produce nothing any earlier pack reads, so they sit at the
    // registry tail.
    ("version_coords_nodes", VERSION_COORDS_NODES_DL),
    ("version_refs_edges", VERSION_REFS_EDGES_DL),
];

/// Look up a bundled pack by its wire name (the `<name>` in `"@stdlib/<name>"`).
/// `None` for an unknown name — the caller owns the coded error (E-MAT-007).
pub fn stdlib_pack(name: &str) -> Option<&'static str> {
    STDLIB_PACKS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, src)| *src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datalog::EvalLimits;
    use crate::derive::builtin::Stats;
    use crate::derive::events::EventLog;
    use crate::derive::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
    use crate::derive::{evaluate, evaluate_with_materialize};
    use std::collections::BTreeSet;

    /// Canonical u128 id derivation (identical to the writer / fixture, mirrors the smoke test).
    fn id_of(semantic_id: &str) -> u128 {
        u128::from_le_bytes(
            blake3::hash(semantic_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        )
    }

    fn node(v: &mut FixtureStorageView, sid: &str, ty: &str, file: &str) {
        v.put_node(NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: sid.to_string(),
            file: file.to_string(),
        });
    }

    fn edge(v: &mut FixtureStorageView, src: &str, dst: &str, ty: &str) {
        v.put_edge(EdgeRow {
            src: id_of(src),
            dst: id_of(dst),
            edge_type: ty.to_string(),
        });
    }

    /// The bundled rule parses, stratifies, plans and evaluates without error, and produces
    /// the expected module→module pairs on a small in-memory fixture — exercising the exact
    /// shape the orchestrator derives (endpoint→file→MODULE join, self-loop exclusion, dedup).
    ///
    /// Fixture topology (one cross-module import, one duplicate, one same-module import):
    ///   MODULE m_a  (file "a.ts"),  MODULE m_b (file "b.ts")
    ///   i_a1 (a.ts) --IMPORTS_FROM--> i_b1 (b.ts)   ⇒ depends(m_a, m_b)
    ///   i_a2 (a.ts) --IMPORTS_FROM--> i_b2 (b.ts)   ⇒ depends(m_a, m_b)  (deduped)
    ///   i_a3 (a.ts) --IMPORTS_FROM--> i_a4 (a.ts)   ⇒ self-loop (m_a,m_a), dropped by neq
    #[test]
    fn depends_rule_shape_on_fixture() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "m_a", "MODULE", "a.ts");
        node(&mut v, "m_b", "MODULE", "b.ts");
        node(&mut v, "i_a1", "IMPORT_BINDING", "a.ts");
        node(&mut v, "i_a2", "IMPORT_BINDING", "a.ts");
        node(&mut v, "i_a3", "IMPORT_BINDING", "a.ts");
        node(&mut v, "i_b1", "FUNCTION", "b.ts");
        node(&mut v, "i_b2", "FUNCTION", "b.ts");
        node(&mut v, "i_a4", "FUNCTION", "a.ts");
        edge(&mut v, "i_a1", "i_b1", "IMPORTS_FROM");
        edge(&mut v, "i_a2", "i_b2", "IMPORTS_FROM");
        edge(&mut v, "i_a3", "i_a4", "IMPORTS_FROM");

        let eval = evaluate(
            &v,
            DEPENDS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("depends.dl evaluates");

        // Collect (src,dst) module-id pairs.
        let mut pairs: BTreeSet<(u128, u128)> = BTreeSet::new();
        for row in eval.facts("depends") {
            let a = row[0].as_id().expect("depends arg0 is an id");
            let b = row[1].as_id().expect("depends arg1 is an id");
            pairs.insert((a, b));
        }

        // Exactly one deduped, non-self module pair: m_a -> m_b.
        assert_eq!(
            pairs,
            BTreeSet::from([(id_of("m_a"), id_of("m_b"))]),
            "depends must derive exactly the deduped, self-loop-free module pair m_a->m_b"
        );
    }

    /// The `@materialize(edge_type="DEPENDS_ON")` directive is parsed off the bundled rule and
    /// surfaced as a write-back spec (so the engine adapter projects derived `depends` facts to
    /// `DEPENDS_ON` edges). Guards that the stdlib rule keeps its materialization annotation.
    #[test]
    fn depends_rule_declares_depends_on_materialization() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "m_a", "MODULE", "a.ts");

        let (_eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            DEPENDS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("depends.dl evaluates with materialize");
        assert!(
            specs.iter().any(|s| s.edge_type == "DEPENDS_ON"),
            "depends.dl must declare @materialize(edge_type=\"DEPENDS_ON\"); got {:?}",
            specs.iter().map(|s| &s.edge_type).collect::<Vec<_>>()
        );
    }

    /// A node whose `name` differs from its semantic id (the shared helper conflates them).
    fn named_node(v: &mut FixtureStorageView, sid: &str, name: &str, ty: &str, file: &str) {
        v.put_node(NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: name.to_string(),
            file: file.to_string(),
        });
    }

    /// RFD-75 — a `version:ref` node (as the versionRefEnricher commits it):
    /// value/locus/coord ride the metadata JSON (read via node_attr), `name` is
    /// the value label. `sid` is the test handle (the enricher's real id scheme
    /// is `<file>::version:ref::<locus>`; the helper id is arbitrary-but-stable).
    fn ref_node(
        v: &mut FixtureStorageView,
        sid: &str,
        value: &str,
        locus: &str,
        coord: &str,
        file: &str,
    ) {
        named_node(v, sid, value, "version:ref", file);
        v.put_node_metadata(
            id_of(sid),
            &serde_json::json!({ "value": value, "locus": locus, "coord": coord }).to_string(),
        );
    }

    /// RFD-75 — a `version:coord` node (as version_coords_nodes commits it):
    /// sid = `version:coord::<coord>`, `coord` rides the metadata JSON so the
    /// edge pack reads it back via node_attr.
    fn coord_node(v: &mut FixtureStorageView, coord: &str) {
        let sid = format!("version:coord::{coord}");
        named_node(v, &sid, coord, "version:coord", coord);
        v.put_node_metadata(
            id_of(&sid),
            &serde_json::json!({ "coord": coord }).to_string(),
        );
    }

    /// The bundled method-call rule pack reproduces the plugin's two resolution strategies
    /// on a fixture, and ONLY those:
    /// - instance_of: c1 ("kb.queryNodes") → PA → REF → VAR —INSTANCE_OF→ KB —HAS_METHOD→ m1,
    ///   with "queryNodes" AMBIGUOUS graph-wide (m1 + m2) — precision beats ambiguity;
    /// - unique_name: c2 ("x.soleMethod") resolves to the single METHOD of that name;
    /// - an already-resolved call (c3, has CALLS) and a dotless call (c4) derive NOTHING.
    #[test]
    fn method_calls_rule_resolves_instance_of_and_unique_name() {
        let mut v = FixtureStorageView::new(1);
        // Methods: "queryNodes" exists twice (ambiguous), "soleMethod" once.
        named_node(&mut v, "m1", "queryNodes", "METHOD", "kb.ts");
        named_node(&mut v, "m2", "queryNodes", "METHOD", "other.ts");
        named_node(&mut v, "m3", "soleMethod", "METHOD", "tool.ts");
        named_node(&mut v, "kb_class", "KB", "CLASS", "kb.ts");
        edge(&mut v, "kb_class", "m1", "HAS_METHOD");

        // c1: dotted call with a full receiver chain to the class.
        named_node(&mut v, "c1", "kb.queryNodes", "CALL", "app.ts");
        named_node(&mut v, "pa", "kb", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "ref", "kb", "REFERENCE", "app.ts");
        named_node(&mut v, "var", "kb", "VARIABLE", "app.ts");
        edge(&mut v, "c1", "pa", "DERIVES_FROM");
        edge(&mut v, "pa", "ref", "READS_FROM");
        edge(&mut v, "ref", "var", "READS_FROM");
        edge(&mut v, "var", "kb_class", "INSTANCE_OF");

        // c2: dotted call, no receiver info, but the name is unique graph-wide.
        named_node(&mut v, "c2", "x.soleMethod", "CALL", "app.ts");

        // c3: already resolved (CALLS → m3 present). The pack derives the fact anyway
        // (the plugin's skip-resolved filter is a negation on the materialized type —
        // rejected by the stratifier); the ADDITIVE write-back dedups it to a no-op.
        named_node(&mut v, "c3", "y.soleMethod", "CALL", "app.ts");
        edge(&mut v, "c3", "m3", "CALLS");

        // c4: not a method call (no dot) — must derive nothing.
        named_node(&mut v, "c4", "plainCall", "CALL", "app.ts");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            METHOD_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("method_calls.dl evaluates");

        let pairs = |pred: &str| -> BTreeSet<(u128, u128)> {
            eval.facts(pred)
                .into_iter()
                .map(|row| {
                    (
                        row[0].as_id().expect("arg0 id"),
                        row[1].as_id().expect("arg1 id"),
                    )
                })
                .collect()
        };

        assert_eq!(
            pairs("resolved_method_call"),
            BTreeSet::from([(id_of("c1"), id_of("m1"))]),
            "instance_of strategy resolves exactly c1→m1 (ambiguity beaten by the receiver type)"
        );
        assert_eq!(
            pairs("resolved_unique_call"),
            BTreeSet::from([(id_of("c2"), id_of("m3")), (id_of("c3"), id_of("m3"))]),
            "unique_name resolves c2→m3 and re-derives the existing c3→m3 (write-back dedups); c4 is dotless"
        );

        // Both heads materialize into the SHARED type CALLS and MUST be additive.
        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 2, "both strategies materialize CALLS");
        assert!(
            calls_specs.iter().all(|s| s.additive),
            "CALLS is shared with the analyzers — the pack must declare mode = \"additive\""
        );
    }

    /// Scaling probe for the method-call pack: a synthetic graph with `n` dotted CALLs
    /// (10% carrying a full receiver chain), 1000 METHODs across 600 names (400 unique,
    /// 200 duplicated). Evaluates the WHOLE pack at n and 4n and asserts near-linear
    /// growth — a super-linear exec (per-row re-probe instead of build-once join, the
    /// planner-filter-before-generator class) fails the ratio gate long before the real
    /// graph's 900s timeout would surface it.
    #[test]
    fn method_calls_pack_scales_near_linearly() {
        fn build(n: usize) -> FixtureStorageView {
            let mut v = FixtureStorageView::new(1);
            // 1000 methods over 600 names: m{0..400} unique, m{400..600} duplicated 3x.
            let mut mi = 0;
            for name_idx in 0..600 {
                let copies = if name_idx < 400 { 1 } else { 3 };
                for c in 0..copies {
                    let sid = format!("M{mi}_{c}");
                    v.put_node(NodeRow {
                        id: id_of(&sid),
                        node_type: "METHOD".to_string(),
                        name: format!("m{name_idx}"),
                        file: format!("f{name_idx}.ts"),
                    });
                    mi += 1;
                }
            }
            // One class owning the duplicated-name methods' first copies.
            v.put_node(NodeRow {
                id: id_of("CLS"),
                node_type: "CLASS".to_string(),
                name: "Cls".to_string(),
                file: "cls.ts".to_string(),
            });
            for name_idx in 400..600 {
                let first_copy_sid = format!("M{}_0", 400 + (name_idx - 400) * 3);
                v.put_edge(EdgeRow {
                    src: id_of("CLS"),
                    dst: id_of(&first_copy_sid),
                    edge_type: "HAS_METHOD".to_string(),
                });
            }
            // n dotted calls cycling over the 600 names; every 10th gets a receiver chain.
            for i in 0..n {
                let csid = format!("C{i}");
                v.put_node(NodeRow {
                    id: id_of(&csid),
                    node_type: "CALL".to_string(),
                    name: format!("recv.m{}", i % 600),
                    file: format!("app{}.ts", i % 50),
                });
                if i % 10 == 0 {
                    let (pa, rf, var) =
                        (format!("PA{i}"), format!("RF{i}"), format!("V{i}"));
                    v.put_node(NodeRow {
                        id: id_of(&pa),
                        node_type: "PROPERTY_ACCESS".to_string(),
                        name: "recv".to_string(),
                        file: "app.ts".to_string(),
                    });
                    v.put_node(NodeRow {
                        id: id_of(&rf),
                        node_type: "REFERENCE".to_string(),
                        name: "recv".to_string(),
                        file: "app.ts".to_string(),
                    });
                    v.put_node(NodeRow {
                        id: id_of(&var),
                        node_type: "VARIABLE".to_string(),
                        name: "recv".to_string(),
                        file: "app.ts".to_string(),
                    });
                    v.put_edge(EdgeRow { src: id_of(&csid), dst: id_of(&pa), edge_type: "DERIVES_FROM".to_string() });
                    v.put_edge(EdgeRow { src: id_of(&pa), dst: id_of(&rf), edge_type: "READS_FROM".to_string() });
                    v.put_edge(EdgeRow { src: id_of(&rf), dst: id_of(&var), edge_type: "READS_FROM".to_string() });
                    v.put_edge(EdgeRow { src: id_of(&var), dst: id_of("CLS"), edge_type: "INSTANCE_OF".to_string() });
                }
            }
            v
        }

        let mut timings = Vec::new();
        for n in [5_000usize, 20_000] {
            let v = build(n);
            let t0 = std::time::Instant::now();
            let eval = evaluate(
                &v,
                METHOD_CALLS_DL,
                Stats::default(),
                EvalLimits::none(),
                EventLog::discard(),
            )
            .expect("pack evaluates at scale");
            let dt = t0.elapsed();
            let unique = eval.facts("resolved_unique_call").len();
            let inst = eval.facts("resolved_method_call").len();
            eprintln!(
                "method_calls pack @ n={n}: {:?} (resolved_unique={unique}, instance_of={inst})",
                dt
            );
            assert!(unique > 0, "unique-name strategy must fire at n={n}");
            assert!(inst > 0, "instance_of strategy must fire at n={n}");
            timings.push(dt.as_secs_f64());
        }
        // 4x the input may cost at most ~8x (linear with constant-factor slack); a
        // quadratic exec costs ~16x and must fail here instead of timing out on the
        // real graph.
        let ratio = timings[1] / timings[0].max(1e-9);
        eprintln!("scaling ratio 5k→20k: {ratio:.1}x");
        assert!(
            ratio < 10.0,
            "method_calls pack scales super-linearly: 4x input cost {ratio:.1}x"
        );
    }

    /// The Haskell local-call pack (`haskell_local_calls.dl`) on a `.hs` fixture
    /// exercising the four INTENT rulings:
    ///   1. A same-file value call resolves SINGLE-TARGET to its FUNCTION binding.
    ///   2. A name with BOTH a TYPE_SIGNATURE and a FUNCTION resolves ONLY to the
    ///      FUNCTION (TYPE_SIGNATURE is dropped from the callable namespace — the
    ///      Q-fix / x4.8 differential source).
    ///   3. A qualified `Map.lookup` call (the analyzer would store it bare, but we
    ///      pin a literal dotted CALL name here) does NOT resolve to a local
    ///      same-bare-name `lookup` FUNCTION — no `.`-split strip (Q3).
    ///   4. An in-scope local binding SHADOWS an import of the same name: a CALL with
    ///      BOTH a same-file FUNCTION and an IMPORT_BINDING of the name resolves
    ///      LOCALLY (Q1 — the legacy himp skip is dropped).
    /// Also asserts the namespace-priority ladder (FUNCTION beats a same-name
    /// VARIABLE) and that the materialize spec is CALLS / additive / resolvedVia.
    #[test]
    fn haskell_local_calls_resolves_single_target_minus_type_signature() {
        let mut v = FixtureStorageView::new(1);

        // (1) Plain local call → FUNCTION, single target. Also a same-name VARIABLE
        //     in the same file: FUNCTION must win the tier ladder (no VARIABLE edge).
        named_node(&mut v, "fn_foo", "foo", "FUNCTION", "src/A.hs");
        named_node(&mut v, "var_foo", "foo", "VARIABLE", "src/A.hs");
        named_node(&mut v, "call_foo", "foo", "CALL", "src/A.hs");

        // (2) name "bar" has BOTH a TYPE_SIGNATURE and a FUNCTION → only FUNCTION.
        named_node(&mut v, "sig_bar", "bar", "TYPE_SIGNATURE", "src/A.hs");
        named_node(&mut v, "fn_bar", "bar", "FUNCTION", "src/A.hs");
        named_node(&mut v, "call_bar", "bar", "CALL", "src/A.hs");

        // (3) qualified call "Map.lookup" + a local FUNCTION literally named
        //     "lookup" → NO edge (no bare-name strip; the dotted name only matches a
        //     local binding literally named "Map.lookup", which does not exist).
        named_node(&mut v, "fn_lookup", "lookup", "FUNCTION", "src/A.hs");
        named_node(&mut v, "call_qual", "Map.lookup", "CALL", "src/A.hs");

        // (4) in-scope local SHADOWS import: "baz" has a same-file FUNCTION AND an
        //     IMPORT_BINDING of the same name → resolves LOCALLY to the FUNCTION.
        named_node(&mut v, "fn_baz", "baz", "FUNCTION", "src/A.hs");
        named_node(&mut v, "imp_baz", "baz", "IMPORT_BINDING", "src/A.hs");
        named_node(&mut v, "call_baz", "baz", "CALL", "src/A.hs");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            HASKELL_LOCAL_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("haskell_local_calls.dl evaluates");

        // The (call, target) pairs of the materialized CALLS head.
        let edges: BTreeSet<(u128, u128)> = triples(&eval, "hcalls")
            .into_iter()
            .map(|(c, t, via)| {
                assert_eq!(via, "haskell-local-calls", "resolvedVia meta must be the legacy provenance string");
                (c, t)
            })
            .collect();

        assert_eq!(
            edges,
            BTreeSet::from([
                (id_of("call_foo"), id_of("fn_foo")),   // (1) FUNCTION, not VARIABLE
                (id_of("call_bar"), id_of("fn_bar")),   // (2) FUNCTION, not TYPE_SIGNATURE
                (id_of("call_baz"), id_of("fn_baz")),   // (4) local shadows import
                // (3) call_qual derives NOTHING — no dotted-name strip
            ]),
            "exactly the FUNCTION targets: foo (not its same-name VARIABLE), bar (not \
             its TYPE_SIGNATURE), baz (local shadows import); the qualified Map.lookup \
             resolves to nothing"
        );

        // TYPE_SIGNATURE is not a candidate at all — sig_bar never appears as a target.
        assert!(
            !edges.iter().any(|(_, t)| *t == id_of("sig_bar")),
            "a TYPE_SIGNATURE must never be a CALLS target (dropped from the callable namespace)"
        );

        // The materialize spec: CALLS, additive, exactly the five tier heads.
        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(
            calls_specs.len(),
            5,
            "five @materialize CALLS heads (FUNCTION/VARIABLE/CONSTANT/CONSTRUCTOR/RECORD_FIELD tiers)"
        );
        assert!(
            calls_specs.iter().all(|s| s.additive),
            "CALLS is shared with the analyzers — every head must be mode = \"additive\""
        );
    }

    // ── Haskell same-file wave (haskell-resolve migration) ─────────────────

    /// haskell_local_refs.dl — the scope-walk READS_FROM resolver, on the
    /// CONTAINS-only Haskell shape (REFERENCE / PARAMETER / VARIABLE all
    /// CONTAINS'd by the same enclosing-FUNCTION scope id; FUNCTION binders
    /// CONTAINS'd by MODULE). Pins all four required behaviours:
    ///  (a) NEAREST-binder shadowing: a ref in fnA whose name is a PARAMETER of
    ///      fnA resolves to THAT param, not to a same-named module-level decl;
    ///  (b) THE CROSS-SCOPE-COLLAPSE BUG, FIXED: two functions each with a local
    ///      VARIABLE `tmp` — the ref in each resolves to its OWN local, NOT the
    ///      last-emitted one (the legacy flat last-write-wins Map collapsed
    ///      these);
    ///  (c) top-level / forward / mutually-recursive ref resolves via the flat
    ///      fallback over the decl types (FUNCTION), no regression;
    ///  (d) an imported name (IMPORT_BINDING in the same file) is NOT
    ///      mis-resolved to a same-named local — local emission suppressed.
    /// Plus: the local-hit suppresses the flat fallback (mutual exclusion); a
    /// FUNCTION-only name with no local binder still resolves flat; the .hs gate.
    #[test]
    fn haskell_local_refs_scope_walk_fixes_cross_scope_collapse() {
        let mut v = FixtureStorageView::new(1);

        // ── Two enclosing FUNCTION scopes in app.hs, both MODULE-contained ──
        named_node(&mut v, "m_app", "App", "MODULE", "app.hs");
        named_node(&mut v, "fnA", "fnA", "FUNCTION", "app.hs");
        named_node(&mut v, "fnB", "fnB", "FUNCTION", "app.hs");
        edge(&mut v, "m_app", "fnA", "CONTAINS"); // FUNCTION binders are MODULE-contained
        edge(&mut v, "m_app", "fnB", "CONTAINS");

        // (b) THE BUG: each fn has its OWN local VARIABLE `tmp`; a ref to `tmp`
        //     in each fn must resolve to its own — NOT a single flat winner.
        named_node(&mut v, "tmpA", "tmp", "VARIABLE", "app.hs");
        edge(&mut v, "fnA", "tmpA", "CONTAINS"); // binder at fnA's scope id
        named_node(&mut v, "r_tmpA", "tmp", "REFERENCE", "app.hs");
        edge(&mut v, "fnA", "r_tmpA", "CONTAINS"); // ref at the SAME scope id
        named_node(&mut v, "tmpB", "tmp", "VARIABLE", "app.hs");
        edge(&mut v, "fnB", "tmpB", "CONTAINS");
        named_node(&mut v, "r_tmpB", "tmp", "REFERENCE", "app.hs");
        edge(&mut v, "fnB", "r_tmpB", "CONTAINS");

        // (a) NEAREST: `cap` is a PARAMETER of fnA AND a module-level CONSTANT;
        //     a ref in fnA resolves to the PARAMETER (the same-scope local hit
        //     suppresses the flat module-level fallback).
        named_node(&mut v, "p_cap", "cap", "PARAMETER", "app.hs");
        edge(&mut v, "fnA", "p_cap", "CONTAINS");
        named_node(&mut v, "c_cap_mod", "cap", "CONSTANT", "app.hs"); // module-level decl
        named_node(&mut v, "r_cap", "cap", "REFERENCE", "app.hs");
        edge(&mut v, "fnA", "r_cap", "CONTAINS");

        // (c) FLAT FALLBACK: mutual recursion / forward ref — `helper` is a
        //     top-level FUNCTION (MODULE-flattened), no same-scope binder, so a
        //     ref inside fnB resolves to it via the flat decl fallback.
        named_node(&mut v, "helper", "helper", "FUNCTION", "app.hs");
        edge(&mut v, "m_app", "helper", "CONTAINS");
        named_node(&mut v, "r_helper", "helper", "REFERENCE", "app.hs");
        edge(&mut v, "fnB", "r_helper", "CONTAINS");

        // (d) IMPORT SKIP: `fromList` has an IMPORT_BINDING in this file AND a
        //     same-named local VARIABLE; the ref must NOT resolve locally.
        named_node(&mut v, "b_fromList", "fromList", "IMPORT_BINDING", "app.hs");
        named_node(&mut v, "v_fromList", "fromList", "VARIABLE", "app.hs");
        edge(&mut v, "fnA", "v_fromList", "CONTAINS");
        named_node(&mut v, "r_fromList", "fromList", "REFERENCE", "app.hs");
        edge(&mut v, "fnA", "r_fromList", "CONTAINS");

        // Negative: a non-.hs ref (gate) with a same-scope binder.
        named_node(&mut v, "m_rs", "Rs", "MODULE", "main.rs");
        named_node(&mut v, "v_rs", "rv", "VARIABLE", "main.rs");
        edge(&mut v, "m_rs", "v_rs", "CONTAINS");
        named_node(&mut v, "r_rs", "rv", "REFERENCE", "main.rs");
        edge(&mut v, "m_rs", "r_rs", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            HASKELL_LOCAL_REFS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("haskell_local_refs.dl evaluates");

        let edge = |r: &str, d: &str| (id_of(r), id_of(d), "haskell-local-refs".to_string());
        let mut expected: BTreeSet<(u128, u128, String)> = BTreeSet::new();
        // (b) each `tmp` ref → its OWN local (the cross-scope-collapse fix).
        expected.insert(edge("r_tmpA", "tmpA"));
        expected.insert(edge("r_tmpB", "tmpB"));
        // (a) `cap` ref in fnA → the PARAMETER (nearest), NOT the module CONSTANT.
        expected.insert(edge("r_cap", "p_cap"));
        // (c) `helper` ref → the top-level FUNCTION via flat fallback.
        expected.insert(edge("r_helper", "helper"));

        assert_eq!(
            triples(&eval, "hs_reads_from"),
            expected,
            "scope-walk: each local `tmp` to its own binder (collapse FIXED); \
             same-scope PARAMETER `cap` shadows the module CONSTANT; top-level \
             `helper` via flat fallback; imported `fromList` + .rs derive nothing"
        );

        // (a) explicit: the module-level CONSTANT `cap` is NOT derived.
        assert!(
            !triples(&eval, "hs_reads_from").contains(&edge("r_cap", "c_cap_mod")),
            "same-scope PARAMETER must shadow the module-level CONSTANT"
        );
        // (b) explicit: NO cross-scope edge (the bug).
        assert!(
            !triples(&eval, "hs_reads_from").contains(&edge("r_tmpA", "tmpB"))
                && !triples(&eval, "hs_reads_from").contains(&edge("r_tmpB", "tmpA")),
            "cross-scope collapse must be gone: fnA's tmp ref never reaches fnB's tmp"
        );
        // (d) explicit: the imported name resolves to NEITHER local.
        assert!(
            !triples(&eval, "hs_reads_from").contains(&edge("r_fromList", "v_fromList")),
            "an IMPORT_BINDING name must not resolve to a same-named local"
        );

        // READS_FROM shared vocabulary — additive, resolvedVia projected.
        let rf: Vec<_> = specs.iter().filter(|s| s.edge_type == "READS_FROM").collect();
        assert!(!rf.is_empty(), "at least one READS_FROM head");
        assert!(rf.iter().all(|s| s.additive), "READS_FROM is shared — additive");
    }

    /// haskell_local_refs SINGLE-TARGET DISCIPLINE — the v1 ×4.8 fan-out guard.
    /// The retired flat native resolver was a Map.fromList LAST-WRITE-WINS: ONE
    /// target per source. The flat fallback must match that cardinality
    /// (RETARGET, not ADD). This pins the two precision corrections:
    ///  (1) NO PARAMETER in the flat fallback — a same-name PARAMETER in a
    ///      FOREIGN scope must NOT be a flat target (that is the misroute bug as
    ///      fan-out); the only sound PARAMETER hit is the same-scope local_hit;
    ///  (2) a name with binders in MANY namespaces (FUNCTION + CONSTANT +
    ///      CONSTRUCTOR + DATA_TYPE) emits exactly ONE edge, to the highest
    ///      priority (FUNCTION) — the namespace-priority ladder;
    ///  (3) TYPE namespace kept at LOWEST priority (lost_real≈0): a value ref to
    ///      a name whose ONLY binder is a DATA_TYPE still resolves to it.
    #[test]
    fn haskell_local_refs_flat_fallback_is_single_target() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "m_app", "App", "MODULE", "app.hs");
        named_node(&mut v, "fnA", "fnA", "FUNCTION", "app.hs");
        edge(&mut v, "m_app", "fnA", "CONTAINS");

        // `node` has FOUR same-file binders across namespaces + a FOREIGN-scope
        // PARAMETER. A top-level ref (MODULE scope, no same-scope binder) must
        // emit EXACTLY ONE flat edge — to the FUNCTION (highest priority) — and
        // NEVER to the CONSTANT / CONSTRUCTOR / DATA_TYPE / foreign PARAMETER.
        named_node(&mut v, "f_node", "node", "FUNCTION", "app.hs");
        edge(&mut v, "m_app", "f_node", "CONTAINS");
        named_node(&mut v, "c_node", "node", "CONSTANT", "app.hs");
        named_node(&mut v, "ctr_node", "node", "CONSTRUCTOR", "app.hs");
        named_node(&mut v, "dt_node", "node", "DATA_TYPE", "app.hs");
        // A foreign-scope PARAMETER `node` (bound inside fnA) — the misroute trap.
        named_node(&mut v, "p_node", "node", "PARAMETER", "app.hs");
        edge(&mut v, "fnA", "p_node", "CONTAINS");
        // The ref is at MODULE scope (top-level), NOT fnA — so NO same-scope hit.
        named_node(&mut v, "r_node", "node", "REFERENCE", "app.hs");
        edge(&mut v, "m_app", "r_node", "CONTAINS");

        // `onlyType` has a single binder, a DATA_TYPE — the TYPE-namespace
        // lowest-priority arm must still resolve it (lost_real≈0).
        named_node(&mut v, "dt_only", "onlyType", "DATA_TYPE", "app.hs");
        named_node(&mut v, "r_only", "onlyType", "REFERENCE", "app.hs");
        edge(&mut v, "m_app", "r_only", "CONTAINS");

        let (eval, _specs, _ns) = evaluate_with_materialize(
            &v,
            HASKELL_LOCAL_REFS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("haskell_local_refs.dl evaluates (single-target)");

        let got = triples(&eval, "hs_reads_from");
        let edge = |r: &str, d: &str| (id_of(r), id_of(d), "haskell-local-refs".to_string());

        // Exactly one edge for `node`, to the FUNCTION — and the ONLY `node`
        // edge in the whole result (no fan-out to the other 4 same-name binders).
        let node_edges: Vec<_> = got.iter().filter(|(s, _, _)| *s == id_of("r_node")).collect();
        assert_eq!(
            node_edges.len(),
            1,
            "single-target: a ref to a 5-binder name emits ONE flat edge, not a fan-out"
        );
        assert!(got.contains(&edge("r_node", "f_node")), "the one edge targets the FUNCTION");
        assert!(!got.contains(&edge("r_node", "c_node")), "no edge to the CONSTANT");
        assert!(!got.contains(&edge("r_node", "ctr_node")), "no edge to the CONSTRUCTOR");
        assert!(!got.contains(&edge("r_node", "dt_node")), "no edge to the DATA_TYPE");
        assert!(
            !got.contains(&edge("r_node", "p_node")),
            "NO flat edge to a foreign-scope PARAMETER (the misroute bug)"
        );
        // The pure-type ref still resolves (TYPE namespace, lowest priority).
        assert!(
            got.contains(&edge("r_only", "dt_only")),
            "a value ref whose only binder is a DATA_TYPE still resolves (lost_real≈0)"
        );
    }

    /// haskell_local_refs prelude fall-through: a REFERENCE with NO same-file
    /// binder and NO import binding, whose name is a Prelude name, resolves to
    /// the virtual HASKELL_GLOBAL endpoint (minted by haskell_local_refs_nodes,
    /// committed as EDB here) with meta globalCategory="haskell-prelude". A
    /// Prelude-named ref that HAS a local binder takes the local edge instead
    /// (mutual exclusion). Also pins the nodes-pack minting + sids.
    #[test]
    fn haskell_local_refs_prelude_fall_through() {
        // ── EDGES PACK: the prelude endpoint committed as EDB (file="") ──
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "m_app", "App", "MODULE", "app.hs");
        // `mapM_` is a Prelude name with no same-file binder → prelude global.
        named_node(&mut v, "HASKELL_GLOBAL::mapM_", "mapM_", "EXTERNAL_FUNCTION", "");
        named_node(&mut v, "r_mapM", "mapM_", "REFERENCE", "app.hs");
        edge(&mut v, "m_app", "r_mapM", "CONTAINS");
        // `show` is a Prelude name BUT has a local FUNCTION binder → local wins.
        named_node(&mut v, "HASKELL_GLOBAL::show", "show", "EXTERNAL_FUNCTION", "");
        named_node(&mut v, "f_show", "show", "FUNCTION", "app.hs");
        edge(&mut v, "m_app", "f_show", "CONTAINS");
        named_node(&mut v, "r_show", "show", "REFERENCE", "app.hs");
        edge(&mut v, "m_app", "r_show", "CONTAINS");

        let (eval, specs, _ns) = evaluate_with_materialize(
            &v,
            HASKELL_LOCAL_REFS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("haskell_local_refs.dl evaluates (prelude)");

        let glob: BTreeSet<(u128, u128, String, String)> = eval
            .facts("hs_reads_global")
            .into_iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap(), r[2].as_str(), r[3].as_str()))
            .collect();
        assert_eq!(
            glob,
            BTreeSet::from([(
                id_of("r_mapM"),
                id_of("HASKELL_GLOBAL::mapM_"),
                "haskell-local-refs".to_string(),
                "haskell-prelude".to_string(),
            )]),
            "only the binder-less Prelude ref `mapM_` falls through; `show` \
             has a local FUNCTION binder so it resolves locally, not as global"
        );
        // `show` resolved locally (flat fallback), NOT as a prelude global.
        assert!(
            triples(&eval, "hs_reads_from")
                .contains(&(id_of("r_show"), id_of("f_show"), "haskell-local-refs".to_string())),
            "a Prelude-named ref with a local FUNCTION binder resolves locally"
        );
        // The prelude head carries resolvedVia + globalCategory.
        let g: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "READS_FROM" && s.meta.len() == 2)
            .collect();
        assert_eq!(g.len(), 1, "one prelude READS_FROM head with two meta cols");
        assert_eq!(
            g[0].meta,
            vec!["resolvedVia".to_string(), "globalCategory".to_string()]
        );

        // ── NODES PACK: mint the HASKELL_GLOBAL endpoint for the binder-less
        //    Prelude ref, byte-identical sid; the local-bound + imported names
        //    mint nothing. ──
        let mut vn = FixtureStorageView::new(1);
        named_node(&mut vn, "m_app", "App", "MODULE", "app.hs");
        named_node(&mut vn, "r_mapM", "mapM_", "REFERENCE", "app.hs");
        edge(&mut vn, "m_app", "r_mapM", "CONTAINS");
        // local-bound Prelude name → no mint.
        named_node(&mut vn, "f_show", "show", "FUNCTION", "app.hs");
        named_node(&mut vn, "r_show", "show", "REFERENCE", "app.hs");
        edge(&mut vn, "m_app", "r_show", "CONTAINS");
        // imported Prelude name → no mint.
        named_node(&mut vn, "b_when", "when", "IMPORT_BINDING", "app.hs");
        named_node(&mut vn, "r_when", "when", "REFERENCE", "app.hs");
        edge(&mut vn, "m_app", "r_when", "CONTAINS");
        // non-Prelude unresolved name → no mint.
        named_node(&mut vn, "r_widget", "renderWidget", "REFERENCE", "app.hs");
        edge(&mut vn, "m_app", "r_widget", "CONTAINS");

        let (evn, _s, node_specs) = evaluate_with_materialize(
            &vn,
            HASKELL_LOCAL_REFS_NODES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("haskell_local_refs_nodes.dl evaluates");

        let minted: BTreeSet<(String, String)> = evn
            .facts("hs_global_node")
            .into_iter()
            .map(|r| (r[0].as_str(), r[1].as_str()))
            .collect();
        assert_eq!(
            minted,
            BTreeSet::from([("HASKELL_GLOBAL::mapM_".to_string(), "mapM_".to_string())]),
            "only the binder-less, non-imported Prelude name is minted; \
             byte-identical sid HASKELL_GLOBAL::<name>"
        );
        assert_eq!(node_specs.len(), 1, "one @materialize_node head");
        assert_eq!(node_specs[0].node_type, "EXTERNAL_FUNCTION");
        assert!(!node_specs[0].additive, "prelude mint is exclusive (provenance-scoped)");
    }

    /// An edge plus a metadata blob attached to it (for `edge_attr` probes —
    /// PASSES_ARGUMENT `index` etc.).
    fn edge_meta(v: &mut FixtureStorageView, src: &str, dst: &str, ty: &str, meta: &str) {
        edge(v, src, dst, ty);
        v.put_edge_metadata(id_of(src), id_of(dst), ty, meta);
    }

    /// The (src, dst, meta-columns) triples of a 3-ary materialized predicate.
    fn triples(
        eval: &crate::derive::exec::Evaluation,
        pred: &str,
    ) -> BTreeSet<(u128, u128, String)> {
        eval.facts(pred)
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("arg0 id"),
                    row[1].as_id().expect("arg1 id"),
                    row[2].as_str(),
                )
            })
            .collect()
    }

    /// The bundled shape-verifier pack reproduces the plugin's violation semantics on a
    /// fixture covering every receiver path and every documented parity point:
    /// - own member (c1), EXTENDS-inherited member (c2) → no violation;
    /// - missing member via the PA-fallback chain (c3) → violation (c3, Foo, "qux");
    /// - already-resolved calls (c4 CALLS, c12 CALLS_REMOTE) → skipped;
    /// - dotless call (c5) → nothing;
    /// - INTERFACE with HAS_PROPERTY member (c6 ok, c7 violation);
    /// - receiver typed by a non-shape (FUNCTION) → nothing (c8, shape_known);
    /// - multi-receiver shape_ok suppression (c9: Foo has bar, Base does not — the
    ///   set-semantics delta vs the plugin's first-INSTANCE_OF pick);
    /// - PLUGIN-PARITY GUARD: a direct READS_FROM (even typeless) SUPPRESSES the
    ///   DERIVES_FROM→PROPERTY_ACCESS fallback (c10 → nothing);
    /// - rf2-undefined fallback: a REFERENCE with no READS_FROM is itself the
    ///   declaration (c11 → violation via r2's own INSTANCE_OF).
    #[test]
    fn shape_verifier_flags_missing_members_with_plugin_parity() {
        let mut v = FixtureStorageView::new(1);

        // Shapes: Foo EXTENDS Base; interface IShape with a property member.
        named_node(&mut v, "base", "Base", "CLASS", "base.ts");
        named_node(&mut v, "mbaz", "baz", "METHOD", "base.ts");
        edge(&mut v, "base", "mbaz", "HAS_METHOD");
        named_node(&mut v, "foo", "Foo", "CLASS", "foo.ts");
        named_node(&mut v, "mbar", "bar", "METHOD", "foo.ts");
        edge(&mut v, "foo", "mbar", "HAS_METHOD");
        edge(&mut v, "foo", "base", "EXTENDS");
        named_node(&mut v, "ishape", "IShape", "INTERFACE", "shape.ts");
        named_node(&mut v, "parea", "area", "PROPERTY", "shape.ts");
        edge(&mut v, "ishape", "parea", "HAS_PROPERTY");

        // Receiver chain A (PA fallback): CALL -DERIVES_FROM-> pa1 -READS_FROM-> r1
        // (REFERENCE) -READS_FROM-> v1 (VARIABLE) -INSTANCE_OF-> Foo.
        named_node(&mut v, "v1", "x", "VARIABLE", "app.ts");
        edge(&mut v, "v1", "foo", "INSTANCE_OF");
        named_node(&mut v, "r1", "x", "REFERENCE", "app.ts");
        edge(&mut v, "r1", "v1", "READS_FROM");
        named_node(&mut v, "pa1", "x", "PROPERTY_ACCESS", "app.ts");
        edge(&mut v, "pa1", "r1", "READS_FROM");

        named_node(&mut v, "c1", "x.bar", "CALL", "app.ts"); // own method — ok
        edge(&mut v, "c1", "pa1", "DERIVES_FROM");
        named_node(&mut v, "c2", "x.baz", "CALL", "app.ts"); // inherited via EXTENDS — ok
        edge(&mut v, "c2", "pa1", "DERIVES_FROM");
        named_node(&mut v, "c3", "x.qux", "CALL", "app.ts"); // VIOLATION (c3, Foo)
        edge(&mut v, "c3", "pa1", "DERIVES_FROM");
        named_node(&mut v, "c4", "x.qux", "CALL", "app.ts"); // resolved (CALLS) — skipped
        edge(&mut v, "c4", "pa1", "DERIVES_FROM");
        edge(&mut v, "c4", "mbar", "CALLS");
        named_node(&mut v, "c12", "x.qux", "CALL", "app.ts"); // resolved (CALLS_REMOTE) — skipped
        edge(&mut v, "c12", "pa1", "DERIVES_FROM");
        edge(&mut v, "c12", "mbar", "CALLS_REMOTE");
        named_node(&mut v, "c5", "plain", "CALL", "app.ts"); // dotless — nothing

        // Receiver chain B (direct READS_FROM, no REFERENCE hop) onto the interface.
        named_node(&mut v, "v2", "s", "VARIABLE", "app.ts");
        edge(&mut v, "v2", "ishape", "INSTANCE_OF");
        named_node(&mut v, "c6", "s.area", "CALL", "app.ts"); // HAS_PROPERTY member — ok
        edge(&mut v, "c6", "v2", "READS_FROM");
        named_node(&mut v, "c7", "s.missing", "CALL", "app.ts"); // VIOLATION (c7, IShape)
        edge(&mut v, "c7", "v2", "READS_FROM");

        // Unknown shape: receiver typed by a FUNCTION node — not CLASS/INTERFACE.
        named_node(&mut v, "v3", "z", "VARIABLE", "app.ts");
        named_node(&mut v, "fn1", "factory", "FUNCTION", "app.ts");
        edge(&mut v, "v3", "fn1", "INSTANCE_OF");
        named_node(&mut v, "c8", "z.qux", "CALL", "app.ts"); // shape_known fails — nothing
        edge(&mut v, "c8", "v3", "READS_FROM");

        // Multi-receiver shape_ok suppression: v1→Foo carries bar, v4→Base does not.
        named_node(&mut v, "v4", "m", "VARIABLE", "app.ts");
        edge(&mut v, "v4", "base", "INSTANCE_OF");
        named_node(&mut v, "c9", "m.bar", "CALL", "app.ts"); // suppressed — NO violation
        edge(&mut v, "c9", "v1", "READS_FROM");
        edge(&mut v, "c9", "v4", "READS_FROM");

        // Direct-READS_FROM precedence: a typeless direct receiver BLOCKS the PA path
        // (plugin consults the PA fallback only when readsFrom.length === 0).
        named_node(&mut v, "u1", "w", "VARIABLE", "app.ts"); // no INSTANCE_OF
        named_node(&mut v, "c10", "w.qux", "CALL", "app.ts"); // NO violation
        edge(&mut v, "c10", "u1", "READS_FROM");
        edge(&mut v, "c10", "pa1", "DERIVES_FROM"); // would reach Foo (lacks qux) if unguarded

        // rf2-undefined fallback: a REFERENCE with no outgoing READS_FROM is itself
        // checked for INSTANCE_OF (shape-verifier.mjs:191-196).
        named_node(&mut v, "r2", "q", "REFERENCE", "app.ts");
        edge(&mut v, "r2", "foo", "INSTANCE_OF");
        named_node(&mut v, "c11", "q.qux", "CALL", "app.ts"); // VIOLATION (c11, Foo)
        edge(&mut v, "c11", "r2", "READS_FROM");

        let (eval, specs, node_specs) = evaluate_with_materialize(
            &v,
            SHAPE_VERIFIER_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("shape_verifier.dl evaluates");

        assert_eq!(
            triples(&eval, "shape_violation"),
            BTreeSet::from([
                (id_of("c3"), id_of("foo"), "qux".to_string()),
                (id_of("c7"), id_of("ishape"), "missing".to_string()),
                (id_of("c11"), id_of("foo"), "qux".to_string()),
            ]),
            "exactly c3/c7/c11 violate; resolved, shape_ok, typeless-direct and \
             unknown-shape calls derive nothing"
        );

        // One SHAPE_VIOLATION spec: pack-owned type ⇒ exclusive; method name in meta.
        let sv_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "SHAPE_VIOLATION")
            .collect();
        assert_eq!(sv_specs.len(), 1, "exactly one SHAPE_VIOLATION head");
        assert!(
            !sv_specs[0].additive,
            "SHAPE_VIOLATION is pack-owned — exclusive mode (violations retract when fixed)"
        );
        assert_eq!(
            sv_specs[0].meta,
            vec!["method".to_string()],
            "the violated method name is projected into edge metadata"
        );

        // The ISSUE node per violation (the plugin's node half): semantic id keyed on
        // the call's decimal id, the plugin's message as the name, the call's file.
        let issues: BTreeSet<(String, String, String, String, String)> = eval
            .facts("shape_issue")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_str(),
                    row[1].as_str(),
                    row[2].as_str(),
                    row[3].as_str(),
                    row[4].as_str(),
                )
            })
            .collect();
        let issue = |call: &str, m: &str, t: &str| {
            (
                format!("issue::shape-violation::{}", id_of(call)),
                format!("Method .{m} not found on {t}"),
                "app.ts".to_string(),
                m.to_string(),
                t.to_string(),
            )
        };
        assert_eq!(
            issues,
            BTreeSet::from([
                issue("c3", "qux", "Foo"),
                issue("c7", "missing", "IShape"),
                issue("c11", "qux", "Foo"),
            ]),
            "one ISSUE per violating call, plugin id convention + message format"
        );

        // The node spec: ISSUE, provenance-scoped exclusive, meta(method, receiverType).
        assert_eq!(node_specs.len(), 1, "exactly one node-materialized head");
        let ns = &node_specs[0];
        assert_eq!(ns.predicate, "shape_issue");
        assert_eq!(ns.node_type, "ISSUE");
        assert!(
            !ns.additive,
            "exclusive (provenance-scoped): fixed violations retract their ISSUE node \
             without touching the orchestrator diagnostics phase's ISSUE nodes"
        );
        assert_eq!(ns.meta, vec!["method".to_string(), "receiverType".to_string()]);
    }

    /// The bundled axum-routes pack derives ROUTES_TO/HANDLED_BY from
    /// `.route("/path", wrapper(handler))` calls using PASSES_ARGUMENT `index` edge
    /// metadata, with the plugin's gates:
    /// - happy path with a recognized lowercase wrapper (r1 → GET) and an UPPERCASE
    ///   wrapper name (r2 → POST, the str_lower/.toLowerCase() parity);
    /// - plugin parity: a NON-wrapper CALL second argument still yields its first
    ///   argument as the handler, method defaults to GET (r5 → state);
    /// - negatives: non-.rs file (r3), path without leading "/" (r4), fewer than two
    ///   arguments (r6), a CALL not named "route" (r7), and a non-CALL second
    ///   argument (r8 — no handler endpoint, hence no edges).
    #[test]
    fn axum_routes_derives_routes_to_and_handled_by() {
        let mut v = FixtureStorageView::new(1);
        let idx0 = r#"{"index":0}"#;
        let idx1 = r#"{"index":1}"#;

        // r1: .route("/users", get(list_users)) in a Rust file.
        named_node(&mut v, "r1", "route", "CALL", "src/main.rs");
        named_node(&mut v, "p1", "/users", "LITERAL", "src/main.rs");
        named_node(&mut v, "g1", "get", "CALL", "src/main.rs");
        named_node(&mut v, "h1", "list_users", "FUNCTION", "src/handlers.rs");
        edge_meta(&mut v, "r1", "p1", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r1", "g1", "PASSES_ARGUMENT", idx1);
        edge_meta(&mut v, "g1", "h1", "PASSES_ARGUMENT", idx0);

        // r2: uppercase wrapper name — str_lower matches the plugin's toLowerCase().
        named_node(&mut v, "r2", "route", "CALL", "src/api.rs");
        named_node(&mut v, "p2", "/items", "LITERAL", "src/api.rs");
        named_node(&mut v, "w2", "POST", "CALL", "src/api.rs");
        named_node(&mut v, "h2", "create_item", "FUNCTION", "src/api.rs");
        edge_meta(&mut v, "r2", "p2", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r2", "w2", "PASSES_ARGUMENT", idx1);
        edge_meta(&mut v, "w2", "h2", "PASSES_ARGUMENT", idx0);

        // r3 NEGATIVE: identical shape but a .js file — the language gate drops it.
        named_node(&mut v, "r3", "route", "CALL", "src/app.js");
        named_node(&mut v, "p3", "/js", "LITERAL", "src/app.js");
        named_node(&mut v, "g3", "get", "CALL", "src/app.js");
        named_node(&mut v, "h3", "js_handler", "FUNCTION", "src/app.js");
        edge_meta(&mut v, "r3", "p3", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r3", "g3", "PASSES_ARGUMENT", idx1);
        edge_meta(&mut v, "g3", "h3", "PASSES_ARGUMENT", idx0);

        // r4 NEGATIVE: path literal without the leading "/" — plugin `continue`s.
        named_node(&mut v, "r4", "route", "CALL", "src/lib.rs");
        named_node(&mut v, "p4", "users", "LITERAL", "src/lib.rs");
        named_node(&mut v, "w4", "post", "CALL", "src/lib.rs");
        edge_meta(&mut v, "r4", "p4", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r4", "w4", "PASSES_ARGUMENT", idx1);
        edge_meta(&mut v, "w4", "h2", "PASSES_ARGUMENT", idx0);

        // r5 PLUGIN PARITY: .route("/raw", my_service(state)) — handler from ANY CALL
        // second argument (the HTTP_METHODS check never gated the handler), GET default.
        named_node(&mut v, "r5", "route", "CALL", "src/raw.rs");
        named_node(&mut v, "p5", "/raw", "LITERAL", "src/raw.rs");
        named_node(&mut v, "w5", "my_service", "CALL", "src/raw.rs");
        named_node(&mut v, "st5", "state", "VARIABLE", "src/raw.rs");
        edge_meta(&mut v, "r5", "p5", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r5", "w5", "PASSES_ARGUMENT", idx1);
        edge_meta(&mut v, "w5", "st5", "PASSES_ARGUMENT", idx0);

        // r6 NEGATIVE: only ONE argument — the plugin's `args.length < 2` skip.
        named_node(&mut v, "r6", "route", "CALL", "src/one.rs");
        named_node(&mut v, "p6", "/solo", "LITERAL", "src/one.rs");
        edge_meta(&mut v, "r6", "p6", "PASSES_ARGUMENT", idx0);

        // r7 NEGATIVE: a non-route CALL with the full argument shape — name gate.
        named_node(&mut v, "r7", "mount", "CALL", "src/main.rs");
        edge_meta(&mut v, "r7", "p1", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r7", "g1", "PASSES_ARGUMENT", idx1);

        // r8: second argument is not a CALL — no handler endpoint, hence no EDGES, but
        // the http_route_node rule still mints the handler-less GET route node
        // (plugin parity, delta 4).
        named_node(&mut v, "r8", "route", "CALL", "src/ref.rs");
        named_node(&mut v, "p8", "/ref", "LITERAL", "src/ref.rs");
        named_node(&mut v, "ref8", "make_router", "REFERENCE", "src/ref.rs");
        edge_meta(&mut v, "r8", "p8", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r8", "ref8", "PASSES_ARGUMENT", idx1);

        let (eval, specs, node_specs) = evaluate_with_materialize(
            &v,
            AXUM_ROUTES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("axum_routes.dl evaluates");

        // routes_to(C, H, Method, Path): route CALL → handler.
        let routes: BTreeSet<(u128, u128, String, String)> = eval
            .facts("routes_to")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("src id"),
                    row[1].as_id().expect("dst id"),
                    row[2].as_str(),
                    row[3].as_str(),
                )
            })
            .collect();
        assert_eq!(
            routes,
            BTreeSet::from([
                (id_of("r1"), id_of("h1"), "GET".to_string(), "/users".to_string()),
                (id_of("r2"), id_of("h2"), "POST".to_string(), "/items".to_string()),
                (id_of("r5"), id_of("st5"), "GET".to_string(), "/raw".to_string()),
            ]),
            "exactly r1/r2/r5 route; r3 (.js), r4 (no slash), r6 (<2 args), r7 (name), \
             r8 (non-CALL arg) derive nothing"
        );

        // handled_by(P, H, Method): path LITERAL → handler.
        assert_eq!(
            triples(&eval, "handled_by"),
            BTreeSet::from([
                (id_of("p1"), id_of("h1"), "GET".to_string()),
                (id_of("p2"), id_of("h2"), "POST".to_string()),
                (id_of("p5"), id_of("st5"), "GET".to_string()),
            ]),
            "path literals of the routed calls map to their handlers"
        );

        // Both heads target SHARED vocabulary ⇒ additive is MANDATORY; meta carries
        // method (+ path on ROUTES_TO).
        let spec_of = |ty: &str| {
            let matched: Vec<_> = specs.iter().filter(|s| s.edge_type == ty).collect();
            assert_eq!(matched.len(), 1, "exactly one {ty} head");
            matched[0].clone()
        };
        let routes_spec = spec_of("ROUTES_TO");
        assert!(routes_spec.additive, "ROUTES_TO is shared vocabulary — additive");
        assert_eq!(routes_spec.meta, vec!["method".to_string(), "path".to_string()]);
        let handled_spec = spec_of("HANDLED_BY");
        assert!(handled_spec.additive, "HANDLED_BY is shared vocabulary — additive");
        assert_eq!(handled_spec.meta, vec!["method".to_string()]);

        // The http:route NODE per route (the plugin's node half): semantic id
        // "http:route::<METHOD>::<PATH>", name = path, file = the route call's file.
        // r8 (non-CALL second argument) gets its handler-LESS node — plugin parity,
        // delta 4 — even though it derives no edges.
        let route_nodes: BTreeSet<(String, String, String, String, String)> = eval
            .facts("http_route_node")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_str(),
                    row[1].as_str(),
                    row[2].as_str(),
                    row[3].as_str(),
                    row[4].as_str(),
                )
            })
            .collect();
        let rn = |m: &str, p: &str, f: &str| {
            (
                format!("http:route::{m}::{p}"),
                p.to_string(),
                f.to_string(),
                m.to_string(),
                p.to_string(),
            )
        };
        assert_eq!(
            route_nodes,
            BTreeSet::from([
                rn("GET", "/users", "src/main.rs"),
                rn("POST", "/items", "src/api.rs"),
                rn("GET", "/raw", "src/raw.rs"),
                rn("GET", "/ref", "src/ref.rs"),
            ]),
            "r1/r2/r5 + the handler-less r8 mint route nodes; r3/r4/r6/r7 do not"
        );

        // The node spec: http:route, provenance-scoped exclusive, meta(method, path).
        assert_eq!(node_specs.len(), 1, "exactly one node-materialized head");
        let ns = &node_specs[0];
        assert_eq!(ns.predicate, "http_route_node");
        assert_eq!(ns.node_type, "http:route");
        assert!(
            !ns.additive,
            "exclusive (provenance-scoped): removed routes retract their node; other \
             producers' http:route nodes are never touched"
        );
        assert_eq!(ns.meta, vec!["method".to_string(), "path".to_string()]);
    }

    /// PROBE (resolve→derive migration, Wave 0) — ground-facts e2e smoke.
    ///
    /// Proves `Rule::fact` heads (parser-level evidence: `datalog/parser.rs:269`)
    /// survive the FULL derive pipeline — parse → binding gate → stratify → plan → exec →
    /// `@materialize` spec collection — not just the parser. Load-bearing for every
    /// generated-facts pack (`upper/26`, `rt_global` skip-lists, `builtin_spec`,
    /// effects-db facts). Covers, in ONE program:
    /// - 1-ary (`rt_global/1` ×4) AND 2-ary (`builtin_spec/2` ×2) ground facts;
    /// - a rule JOINING base relations (`node`/`attr`) against a fact relation;
    /// - a 2-ary fact relation probed with one bound / one free column;
    /// - an `@materialize` head consuming the base⋈fact join.
    #[test]
    fn ground_facts_survive_full_pipeline_join_and_materialize() {
        let mut v = FixtureStorageView::new(1);
        // Base graph: REFERENCEs (two naming runtime globals, one local) and the
        // GLOBAL_DEFINITION nodes the materialized head links them to.
        named_node(&mut v, "ref_st", "setTimeout", "REFERENCE", "app.ts");
        named_node(&mut v, "ref_cons", "console", "REFERENCE", "app.ts");
        named_node(&mut v, "ref_loc", "myHelper", "REFERENCE", "app.ts");
        named_node(&mut v, "g_st", "setTimeout", "GLOBAL_DEFINITION", "__runtime__");
        named_node(&mut v, "g_cons", "console", "GLOBAL_DEFINITION", "__runtime__");
        named_node(&mut v, "g_fetch", "fetch", "GLOBAL_DEFINITION", "__runtime__");

        const PROGRAM: &str = r#"
            rt_global("setTimeout").
            rt_global("setInterval").
            rt_global("console").
            rt_global("fetch").
            builtin_spec("timers", "setTimeout").
            builtin_spec("console", "console").

            @materialize(edge_type = "RESOLVES_GLOBAL", mode = "additive")
            resolves_global(R, G) :-
                node(R, "REFERENCE"), attr(R, "name", N), rt_global(N),
                node(G, "GLOBAL_DEFINITION"), attr(G, "name", N).

            global_module(R, M) :-
                node(R, "REFERENCE"), attr(R, "name", N), builtin_spec(M, N).
        "#;

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            PROGRAM,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("ground facts + base⋈fact join + @materialize evaluate end-to-end");

        // (1) The fact relations themselves survive to the committed result, value-exact.
        let unary: BTreeSet<String> = eval
            .facts("rt_global")
            .into_iter()
            .map(|r| r[0].as_str())
            .collect();
        assert_eq!(
            unary,
            BTreeSet::from([
                "setTimeout".to_string(),
                "setInterval".to_string(),
                "console".to_string(),
                "fetch".to_string(),
            ]),
            "all four 1-ary ground facts survive stratify/plan/exec"
        );
        let binary: BTreeSet<(String, String)> = eval
            .facts("builtin_spec")
            .into_iter()
            .map(|r| (r[0].as_str(), r[1].as_str()))
            .collect();
        assert_eq!(
            binary,
            BTreeSet::from([
                ("timers".to_string(), "setTimeout".to_string()),
                ("console".to_string(), "console".to_string()),
            ]),
            "both 2-ary ground facts survive"
        );

        // (2) The base⋈fact join under @materialize: exactly the references whose
        // name is a runtime global, linked to the same-named GLOBAL_DEFINITION.
        // ref_loc (not a global), setInterval (no reference) and g_fetch (no
        // reference) must contribute nothing.
        let resolved: BTreeSet<(u128, u128)> = eval
            .facts("resolves_global")
            .into_iter()
            .map(|r| (r[0].as_id().expect("ref id"), r[1].as_id().expect("def id")))
            .collect();
        assert_eq!(
            resolved,
            BTreeSet::from([
                (id_of("ref_st"), id_of("g_st")),
                (id_of("ref_cons"), id_of("g_cons")),
            ]),
            "base node/attr relations join against the 1-ary fact relation"
        );

        // (3) The 2-ary fact relation probed with the value column bound and the
        // module column free — the generated-facts lookup-table access pattern.
        let modules: BTreeSet<(u128, String)> = eval
            .facts("global_module")
            .into_iter()
            .map(|r| (r[0].as_id().expect("ref id"), r[1].as_str()))
            .collect();
        assert_eq!(
            modules,
            BTreeSet::from([
                (id_of("ref_st"), "timers".to_string()),
                (id_of("ref_cons"), "console".to_string()),
            ]),
            "2-ary fact relation joins with one bound, one free column"
        );

        // (4) The @materialize directive on the fact-consuming head is surfaced.
        let rg_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "RESOLVES_GLOBAL")
            .collect();
        assert_eq!(rg_specs.len(), 1, "exactly one RESOLVES_GLOBAL head");
        assert!(
            rg_specs[0].additive,
            "mode = \"additive\" is parsed off the fact-consuming head"
        );
    }

    /// The wire-addressable pack registry: canonical order (an ordering CONTRACT —
    /// the resolver packs produce the READS_FROM/CALLS state that method_calls
    /// reads positively and shape_verifier negates, so producers come strictly
    /// before consumers), name → source lookup, and None for unknown names (the
    /// dispatcher owns the E-MAT-007 error).
    #[test]
    fn stdlib_pack_registry_resolves_names_in_canonical_order() {
        let names: Vec<&str> = STDLIB_PACKS.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names,
            vec![
                "js_local_refs",
                "js_same_file_calls",
                "js_this_method_calls",
                "rust_calls",
                "rust_cross_methods_ctor",
                "rust_trait_resolve",
                "rust_receiver_typing",
                "rust_imports",
                "js_module_imports",
                "js_import_bindings",
                "js_class_inheritance",
                "js_cross_file_calls",
                "js_property_access_ns",
                "js_property_access_full",
                "js_builtins_nodes",
                "js_builtins_edges",
                "js_runtime_globals_nodes",
                "js_runtime_globals_edges",
                "java_imports",
                "java_types",
                "java_calls",
                "java_annotations",
                "kotlin_inheritance",
                "haskell_local_refs_nodes",
                "haskell_local_refs",
                "haskell_local_calls",
                "go_imports",
                "go_imports_nomod",
                "go_calls",
                "go_interfaces",
                "go_types",
                "go_context",
                "depends",
                "method_calls",
                "shape_verifier",
                "axum_routes",
                "js_http_routes_nodes",
                "js_http_routes_edges",
                "js_entrypoint_features_nodes",
                "js_entrypoint_features_edges",
                "version_coords_nodes",
                "version_refs_edges",
            ],
            "canonical run order: Wave-1 resolver packs → Wave-1b packs \
             (rust_cross_methods_ctor after rust_calls — the CALLS EDB seam; the \
             js hybrid packs before the fuzzy fallback) → Rust Wave-2 packs \
             (rust_receiver_typing shares the rust_calls CALLS seam; rust_imports \
             PRODUCES IMPORTS_FROM — before its consumers) → \
             js_module_imports (Wave 3b, PRODUCES the IMPORT→MODULE \
             IMPORTS_FROM seam + RE_EXPORTS that js_import_bindings consumes) \
             → JS Wave-2 \
             packs (js_import_bindings PRODUCES the IMPORTS_FROM seam, so it \
             precedes js_class_inheritance and the js hybrid consumers; \
             js_class_inheritance produces EXTENDS for shape_verifier) → \
             java packs (java_imports PRODUCES java IMPORTS_FROM — before \
             depends; java_calls PRODUCES CALLS — before the negators) → \
             depends (Wave 3c: AFTER every IMPORTS_FROM producer — legacy \
             import-resolution is gated, so the in-engine producers feed it) → \
             method_calls → shape_verifier → axum_routes → \
             js_http_routes_nodes → js_http_routes_edges (Wave 14: the nodes \
             pack mints the anchorCall-pinned http:route endpoints the edges \
             pack joins as committed EDB) (producers strictly before consumers)"
        );
        assert_eq!(stdlib_pack("depends"), Some(DEPENDS_DL));
        assert_eq!(stdlib_pack("js_local_refs"), Some(JS_LOCAL_REFS_DL));
        assert_eq!(stdlib_pack("js_same_file_calls"), Some(JS_SAME_FILE_CALLS_DL));
        assert_eq!(
            stdlib_pack("js_this_method_calls"),
            Some(JS_THIS_METHOD_CALLS_DL)
        );
        assert_eq!(stdlib_pack("rust_calls"), Some(RUST_CALLS_DL));
        assert_eq!(
            stdlib_pack("rust_cross_methods_ctor"),
            Some(RUST_CROSS_METHODS_CTOR_DL)
        );
        assert_eq!(stdlib_pack("rust_trait_resolve"), Some(RUST_TRAIT_RESOLVE_DL));
        assert_eq!(
            stdlib_pack("rust_receiver_typing"),
            Some(RUST_RECEIVER_TYPING_DL)
        );
        assert_eq!(stdlib_pack("rust_imports"), Some(RUST_IMPORTS_DL));
        assert_eq!(stdlib_pack("js_module_imports"), Some(JS_MODULE_IMPORTS_DL));
        assert_eq!(stdlib_pack("js_import_bindings"), Some(JS_IMPORT_BINDINGS_DL));
        assert_eq!(
            stdlib_pack("js_class_inheritance"),
            Some(JS_CLASS_INHERITANCE_DL)
        );
        assert_eq!(stdlib_pack("js_cross_file_calls"), Some(JS_CROSS_FILE_CALLS_DL));
        assert_eq!(
            stdlib_pack("js_property_access_ns"),
            Some(JS_PROPERTY_ACCESS_NS_DL)
        );
        assert_eq!(
            stdlib_pack("js_property_access_full"),
            Some(JS_PROPERTY_ACCESS_FULL_DL)
        );
        assert_eq!(
            stdlib_pack("haskell_local_calls"),
            Some(HASKELL_LOCAL_CALLS_DL)
        );
        assert_eq!(stdlib_pack("method_calls"), Some(METHOD_CALLS_DL));
        assert_eq!(stdlib_pack("shape_verifier"), Some(SHAPE_VERIFIER_DL));
        assert_eq!(stdlib_pack("axum_routes"), Some(AXUM_ROUTES_DL));
        assert_eq!(
            stdlib_pack("js_http_routes_nodes"),
            Some(JS_HTTP_ROUTES_NODES_DL)
        );
        assert_eq!(
            stdlib_pack("js_http_routes_edges"),
            Some(JS_HTTP_ROUTES_EDGES_DL)
        );
        assert_eq!(
            stdlib_pack("js_entrypoint_features_nodes"),
            Some(JS_ENTRYPOINT_FEATURES_NODES_DL)
        );
        assert_eq!(
            stdlib_pack("js_entrypoint_features_edges"),
            Some(JS_ENTRYPOINT_FEATURES_EDGES_DL)
        );
        assert_eq!(
            stdlib_pack("version_coords_nodes"),
            Some(VERSION_COORDS_NODES_DL)
        );
        assert_eq!(stdlib_pack("version_refs_edges"), Some(VERSION_REFS_EDGES_DL));
        assert_eq!(stdlib_pack("nope"), None, "unknown pack name resolves to None");
    }

    /// PROBE 3 (resolve→derive migration, Wave 0) — stratifier acceptance of a
    /// POSITIVE same-type storage self-read: the rust_calls resolved-constructor shape,
    /// where one rule reads `edge(Init, Ctor, "CALLS")` positively (NOT negated) while
    /// another rule in the same program (and itself) materializes edge_type = "CALLS".
    ///
    /// What this pins down, in order:
    /// 1. The stratifier ACCEPTS — the storage-level @materialize dependency for a
    ///    positive base read is `DepKind::Positive` (stratify.rs `add_body_deps`), and
    ///    E-STRAT-001 fires only on NEGATIVE edges inside an SCC. The reader lands in a
    ///    stratum STRICTLY ABOVE the materializer, with no W-STRAT-001 (constant type).
    /// 2. The full pipeline (parse → binding gate → stratify → plan → exec →
    ///    @materialize spec collection) evaluates the program on a fixture.
    /// 3. SEMANTICS of the base read: `edge()` legs scan the pinned StorageView
    ///    (exec.rs build-once typed scans) with NO overlay of same-run derived rows —
    ///    the reader sees only PRE-RUN storage CALLS edges. The stratum ordering is a
    ///    cross-RUN convergence contract (write-back happens after evaluation), not
    ///    within-run visibility.
    /// 4. The one-pack pattern that DOES see same-run resolutions: reference the
    ///    materializer's IDB predicate (`rust_calls(Init, Ctor)`) directly instead of
    ///    re-reading storage.
    #[test]
    fn positive_same_type_storage_self_read_stratifies_and_reads_pre_run_state() {
        use crate::derive::parser_ext::parse_ext_program;
        use crate::derive::stratify::stratify;

        const PROGRAM: &str = r#"
            @materialize(edge_type = "CALLS", mode = "additive")
            rust_calls(C, F) :-
                node(C, "CALL"), attr(C, "name", N),
                node(F, "FUNCTION"), attr(F, "name", N).

            @materialize(edge_type = "CALLS", mode = "additive")
            ctor_method_call(MC, M) :-
                node(MC, "CALL"), edge(MC, V, "READS_FROM"),
                node(V, "VARIABLE"), edge(V, Init, "ASSIGNED_FROM"),
                edge(Init, Ctor, "CALLS"),
                node(Ctor, "FUNCTION"), edge(Ctor, M, "HAS_METHOD").

            ctor_method_call_idb(MC, M) :-
                node(MC, "CALL"), edge(MC, V, "READS_FROM"),
                node(V, "VARIABLE"), edge(V, Init, "ASSIGNED_FROM"),
                rust_calls(Init, Ctor),
                edge(Ctor, M, "HAS_METHOD").
        "#;

        // (1) Stratifier verdict: accepted; reader strictly above the materializer;
        // no conservative-dep warning (the edge type is a CONSTANT).
        let prog = parse_ext_program(PROGRAM).expect("parses");
        let strat = stratify(&prog).expect(
            "POSITIVE same-type storage self-read must stratify — E-STRAT-001 is negation-only",
        );
        let producer = strat.stratum_of("rust_calls").expect("rust_calls is derived");
        let reader = strat
            .stratum_of("ctor_method_call")
            .expect("ctor_method_call is derived");
        assert!(
            producer < reader,
            "reader (stratum {reader}) must sit strictly above the CALLS materializer \
             (stratum {producer}) — evaluated after it"
        );
        assert!(
            strat.warnings.is_empty(),
            "constant edge type takes the exact-producer dep, not W-STRAT-001"
        );

        // Fixture: Widget::new HAS_METHOD render; TWO constructor-init chains.
        //  - mc_old: its init call's CALLS edge is ALREADY IN STORAGE (previous run /
        //    other producer) — the cross-run case.
        //  - mc_new: its init call resolves via rust_calls IN THIS RUN ONLY (exact name
        //    match, no stored CALLS edge) — the same-run case.
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "f_new", "Widget::new", "FUNCTION", "lib.rs");
        named_node(&mut v, "m_render", "render", "METHOD", "lib.rs");
        edge(&mut v, "f_new", "m_render", "HAS_METHOD");

        named_node(&mut v, "init_old", "already_resolved", "CALL", "a.rs");
        edge(&mut v, "init_old", "f_new", "CALLS"); // pre-run storage CALLS edge
        named_node(&mut v, "v_old", "w1", "VARIABLE", "a.rs");
        edge(&mut v, "v_old", "init_old", "ASSIGNED_FROM");
        named_node(&mut v, "mc_old", "w1.render", "CALL", "a.rs");
        edge(&mut v, "mc_old", "v_old", "READS_FROM");

        named_node(&mut v, "init_new", "Widget::new", "CALL", "b.rs"); // resolves THIS run
        named_node(&mut v, "v_new", "w2", "VARIABLE", "b.rs");
        edge(&mut v, "v_new", "init_new", "ASSIGNED_FROM");
        named_node(&mut v, "mc_new", "w2.render", "CALL", "b.rs");
        edge(&mut v, "mc_new", "v_new", "READS_FROM");

        // (2) Full pipeline passes.
        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            PROGRAM,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("same-type storage self-read evaluates end-to-end");

        // Sanity: this run derived exactly the one new resolution.
        let derived_calls: BTreeSet<(u128, u128)> = eval
            .facts("rust_calls")
            .into_iter()
            .map(|r| (r[0].as_id().expect("call id"), r[1].as_id().expect("fn id")))
            .collect();
        assert_eq!(
            derived_calls,
            BTreeSet::from([(id_of("init_new"), id_of("f_new"))]),
            "rust_calls resolves the same-run init call"
        );

        // (3) The storage self-read sees ONLY the pre-run CALLS edge: mc_old resolves,
        // mc_new does NOT — same-run derived CALLS rows are invisible to base edge().
        let via_edge: BTreeSet<(u128, u128)> = eval
            .facts("ctor_method_call")
            .into_iter()
            .map(|r| (r[0].as_id().expect("mc id"), r[1].as_id().expect("m id")))
            .collect();
        assert_eq!(
            via_edge,
            BTreeSet::from([(id_of("mc_old"), id_of("m_render"))]),
            "base edge() read = pre-run storage snapshot only; the stratum ordering \
             does NOT make same-run materialized CALLS visible within the run"
        );

        // (4) The direct IDB reference DOES see the same-run resolution (and only it:
        // init_old's name matches no FUNCTION, so rust_calls never re-derives it).
        let via_idb: BTreeSet<(u128, u128)> = eval
            .facts("ctor_method_call_idb")
            .into_iter()
            .map(|r| (r[0].as_id().expect("mc id"), r[1].as_id().expect("m id")))
            .collect();
        assert_eq!(
            via_idb,
            BTreeSet::from([(id_of("mc_new"), id_of("m_render"))]),
            "referencing the materializer's IDB predicate sees same-run derivations"
        );

        // Both CALLS @materialize heads survive spec collection (multi-producer type).
        let calls_specs: BTreeSet<&str> = specs
            .iter()
            .filter(|s| s.edge_type == "CALLS")
            .map(|s| s.predicate.as_str())
            .collect();
        assert_eq!(
            calls_specs,
            BTreeSet::from(["ctor_method_call", "rust_calls"]),
            "two rules may materialize the same edge type"
        );
    }

    /// The reworked SCOPE-WALK js_local_refs pack on a fixture covering both arms,
    /// the nearest-binder/shadowing property (the soundness GOAL), every skip-set,
    /// the negatives, and the accepted same-scope superset:
    ///
    /// ARM A (SCOPE-WALK: VARIABLE/CONSTANT/FUNCTION/PARAMETER via SCOPE-DECLARES):
    /// - a ref in a scope that declares the name resolves to that binder
    ///   (helper/state/LIMIT/input, all DECLARES'd by the outer scope);
    /// - SHADOWING: `shadow` is declared in BOTH an outer and an inner scope; a ref
    ///   inside the inner scope resolves to the INNER binder ONLY (nearest wins) —
    ///   the flat port would have emitted BOTH; this is DELTA 1, the soundness core;
    /// - OUTER reach: a ref of `state` inside the inner scope (which does not
    ///   declare it) climbs HAS_SCOPE to the outer scope's binder;
    /// - IMPORT_BINDING is DECLARES-attached but EXCLUDED by the ARM A type filter
    ///   (it is the import skip-set);
    /// - same-scope duplicate binders derive BOTH (DELTA 2, accepted superset).
    ///
    /// ARM B (FILE-FLAT: CLASS/INTERFACE/ENUM/TYPE_SYNONYM — not SCOPE-attached):
    /// - each resolves its same-file REFERENCE by (file, name), no scope needed.
    ///
    /// SKIP-SETS / NEGATIVES (each ref is given a declaring scope so it WOULD
    /// resolve but for the skip): imported name; rt_global ("console"); cross-file
    /// decl; non-JS (.rs) file; empty name.
    #[test]
    fn js_local_refs_scope_walk_nearest_binder() {
        let mut v = FixtureStorageView::new(1);

        // ── Scope tree in app.ts: MODULE top-scope (NO module SCOPE node — the JS/TS
        //    analyzer makes the MODULE itself the module scope, Context.hs:59-64),
        //    outer SCOPE, inner SCOPE child via HAS_SCOPE ──
        named_node(&mut v, "m_app", "app.ts", "MODULE", "app.ts");
        named_node(&mut v, "s_outer", "", "SCOPE", "app.ts");
        named_node(&mut v, "s_inner", "", "SCOPE", "app.ts");
        edge(&mut v, "m_app", "s_outer", "HAS_SCOPE"); // MODULE is lexical parent of outer
        edge(&mut v, "s_outer", "s_inner", "HAS_SCOPE"); // outer is lexical parent

        // ── ARM A: scoped binders DECLARES'd by the outer scope, refs CONTAINS'd ──
        let scoped = [
            ("d_fn", "helper", "FUNCTION"),
            ("d_var", "state", "VARIABLE"),
            ("d_const", "LIMIT", "CONSTANT"),
            ("d_param", "input", "PARAMETER"),
        ];
        for (sid, name, ty) in scoped {
            named_node(&mut v, sid, name, ty, "app.ts");
            edge(&mut v, "s_outer", sid, "DECLARES");
            named_node(&mut v, &format!("r_{sid}"), name, "REFERENCE", "app.ts");
            edge(&mut v, "s_outer", &format!("r_{sid}"), "CONTAINS");
        }

        // ── SHADOWING: `shadow` declared in BOTH scopes; ref in INNER → inner only ──
        named_node(&mut v, "d_shadow_out", "shadow", "VARIABLE", "app.ts");
        edge(&mut v, "s_outer", "d_shadow_out", "DECLARES");
        named_node(&mut v, "d_shadow_in", "shadow", "VARIABLE", "app.ts");
        edge(&mut v, "s_inner", "d_shadow_in", "DECLARES");
        named_node(&mut v, "r_shadow", "shadow", "REFERENCE", "app.ts");
        edge(&mut v, "s_inner", "r_shadow", "CONTAINS");

        // ── OUTER reach: ref of `state` in the inner scope climbs to outer binder ──
        named_node(&mut v, "r_state_inner", "state", "REFERENCE", "app.ts");
        edge(&mut v, "s_inner", "r_state_inner", "CONTAINS");

        // ── DELTA 2: same-scope duplicate binders of `dup` — derive BOTH ──
        named_node(&mut v, "d_dup_v", "dup", "VARIABLE", "app.ts");
        edge(&mut v, "s_outer", "d_dup_v", "DECLARES");
        named_node(&mut v, "d_dup_p", "dup", "PARAMETER", "app.ts");
        edge(&mut v, "s_outer", "d_dup_p", "DECLARES");
        named_node(&mut v, "r_dup", "dup", "REFERENCE", "app.ts");
        edge(&mut v, "s_outer", "r_dup", "CONTAINS");

        // ── MODULE TOP-SCOPE (regression guard): top-level binder DECLARES'd by the
        //    MODULE, top-level ref CONTAINS'd by the MODULE — must resolve. The JS/TS
        //    analyzer emits NO module SCOPE node, so this is the very common top-level
        //    helper/const case that a SCOPE-only walk silently dropped. ──
        named_node(&mut v, "d_modfn", "boot", "FUNCTION", "app.ts");
        edge(&mut v, "m_app", "d_modfn", "DECLARES");
        named_node(&mut v, "r_modfn", "boot", "REFERENCE", "app.ts");
        edge(&mut v, "m_app", "r_modfn", "CONTAINS"); // ref is module-contained

        // ── MODULE reach from an inner SCOPE: a ref of a module-level const inside the
        //    inner function scope climbs SCOPE -> SCOPE -> MODULE via HAS_SCOPE. ──
        named_node(&mut v, "d_modconst", "GLOBAL_CAP", "CONSTANT", "app.ts");
        edge(&mut v, "m_app", "d_modconst", "DECLARES");
        named_node(&mut v, "r_modconst_inner", "GLOBAL_CAP", "REFERENCE", "app.ts");
        edge(&mut v, "s_inner", "r_modconst_inner", "CONTAINS");

        // ── NEAREST over MODULE: `cfg` declared at module level AND in s_outer; a ref
        //    in s_inner resolves to the s_outer binder (nearest), NOT the MODULE one. ──
        named_node(&mut v, "d_cfg_mod", "cfg", "CONSTANT", "app.ts");
        edge(&mut v, "m_app", "d_cfg_mod", "DECLARES");
        named_node(&mut v, "d_cfg_outer", "cfg", "VARIABLE", "app.ts");
        edge(&mut v, "s_outer", "d_cfg_outer", "DECLARES");
        named_node(&mut v, "r_cfg", "cfg", "REFERENCE", "app.ts");
        edge(&mut v, "s_inner", "r_cfg", "CONTAINS");

        // ── ARM A skip-set: IMPORT_BINDING is DECLARES-attached but EXCLUDED ──
        named_node(&mut v, "b_ext", "ext", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "s_outer", "b_ext", "DECLARES");
        named_node(&mut v, "r_ext", "ext", "REFERENCE", "app.ts");
        edge(&mut v, "s_outer", "r_ext", "CONTAINS");

        // ── ARM B: flat type/class decls (NOT scope-attached); flat (file,name) ──
        let flat = [
            ("d_class", "Engine", "CLASS"),
            ("d_iface", "Shape", "INTERFACE"),
            ("d_enum", "Color", "ENUM"),
            ("d_syn", "Alias", "TYPE_SYNONYM"),
        ];
        for (sid, name, ty) in flat {
            named_node(&mut v, sid, name, ty, "app.ts");
            named_node(&mut v, &format!("r_{sid}"), name, "REFERENCE", "app.ts");
            edge(&mut v, "s_outer", &format!("r_{sid}"), "CONTAINS");
        }

        // ── Skip-set: runtime global ("console" is on the 97-name facts list) ──
        named_node(&mut v, "d_console", "console", "VARIABLE", "app.ts");
        edge(&mut v, "s_outer", "d_console", "DECLARES");
        named_node(&mut v, "r_console", "console", "REFERENCE", "app.ts");
        edge(&mut v, "s_outer", "r_console", "CONTAINS");

        // ── Negative: declaration only in ANOTHER file (cross-file) ──
        named_node(&mut v, "d_far", "far", "FUNCTION", "b.ts");
        named_node(&mut v, "r_far", "far", "REFERENCE", "app.ts");
        edge(&mut v, "s_outer", "r_far", "CONTAINS");

        // ── Negative: non-JS file (gate) — scoped, but .rs is gated out ──
        named_node(&mut v, "s_rs", "", "SCOPE", "main.rs");
        named_node(&mut v, "d_rfn", "rfn", "FUNCTION", "main.rs");
        edge(&mut v, "s_rs", "d_rfn", "DECLARES");
        named_node(&mut v, "r_rfn", "rfn", "REFERENCE", "main.rs");
        edge(&mut v, "s_rs", "r_rfn", "CONTAINS");

        // ── Negative: empty names never match ──
        named_node(&mut v, "d_empty", "", "FUNCTION", "app.ts");
        edge(&mut v, "s_outer", "d_empty", "DECLARES");
        named_node(&mut v, "r_empty", "", "REFERENCE", "app.ts");
        edge(&mut v, "s_outer", "r_empty", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_LOCAL_REFS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_local_refs.dl evaluates");

        let mut expected: BTreeSet<(u128, u128, String)> = BTreeSet::new();
        let edge = |r: &str, d: &str| (id_of(r), id_of(d), "js-local-refs".to_string());
        // ARM A: each scoped binder, resolved in its own scope.
        expected.insert(edge("r_d_fn", "d_fn"));
        expected.insert(edge("r_d_var", "d_var"));
        expected.insert(edge("r_d_const", "d_const"));
        expected.insert(edge("r_d_param", "d_param"));
        // SHADOWING: inner ref resolves to the INNER binder ONLY (nearest wins).
        expected.insert(edge("r_shadow", "d_shadow_in"));
        // OUTER reach: inner ref of `state` climbs to the outer binder.
        expected.insert(edge("r_state_inner", "d_var"));
        // DELTA 2: same-scope dup — BOTH candidates.
        expected.insert(edge("r_dup", "d_dup_v"));
        expected.insert(edge("r_dup", "d_dup_p"));
        // MODULE top-scope: top-level ref → MODULE-DECLARES'd binder (regression guard).
        expected.insert(edge("r_modfn", "d_modfn"));
        // MODULE reach: inner ref climbs SCOPE->SCOPE->MODULE to the module-level const.
        expected.insert(edge("r_modconst_inner", "d_modconst"));
        // NEAREST over MODULE: inner ref of `cfg` resolves to s_outer binder (nearest),
        // NOT the module-level one (the MODULE binder is shadowed by s_outer).
        expected.insert(edge("r_cfg", "d_cfg_outer"));
        // ARM B: flat type/class decls.
        expected.insert(edge("r_d_class", "d_class"));
        expected.insert(edge("r_d_iface", "d_iface"));
        expected.insert(edge("r_d_enum", "d_enum"));
        expected.insert(edge("r_d_syn", "d_syn"));

        assert_eq!(
            triples(&eval, "js_local_ref"),
            expected,
            "ARM A scope-walk (nearest binder; inner shadows outer; outer reach via \
             HAS_SCOPE; same-scope dup superset; IMPORT_BINDING excluded) + ARM B flat \
             (CLASS/INTERFACE/ENUM/TYPE_SYNONYM); rt_global/cross-file/.rs/empty derive nothing"
        );

        // SHADOWING (explicit): the OUTER `shadow` binder must NOT be derived.
        assert!(
            !triples(&eval, "js_local_ref")
                .contains(&edge("r_shadow", "d_shadow_out")),
            "nearest-binder: the inner-scope `shadow` shadows the outer — outer must be dropped"
        );

        // NEAREST over MODULE (explicit): the module-level `cfg` binder must NOT be
        // derived for r_cfg — the strictly-closer s_outer binder shadows it.
        assert!(
            !triples(&eval, "js_local_ref").contains(&edge("r_cfg", "d_cfg_mod")),
            "nearest-binder over MODULE: s_outer `cfg` shadows the module-level `cfg`"
        );

        // READS_FROM is shared vocabulary — additive, with resolvedVia projected.
        let rf_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "READS_FROM")
            .collect();
        assert_eq!(rf_specs.len(), 1, "exactly one READS_FROM head");
        assert!(rf_specs[0].additive, "READS_FROM is shared — additive");
        assert_eq!(rf_specs[0].meta, vec!["resolvedVia".to_string()]);
    }

    /// The bundled js_same_file_calls pack reproduces SameFileCalls.hs arm by arm:
    /// - A1 direct → FUNCTION; the FUNCTION-over-VARIABLE preference ladder
    ///   (a name that is both resolves ONLY to the FUNCTION);
    /// - A2 direct → VARIABLE/CONSTANT, with DELTA 1 PINNED (both var+const derive);
    /// - A3 uppercase ctor → CLASS, with a lowercase negative AND the ladder
    ///   suppression (a VARIABLE of the same name beats the CLASS);
    /// - DELTA 6 (resolve rework) PINNED: A1/A2/A3 SCOPE-WALK the B1/B2 encl_*
    ///   idiom (SCOPE+HAS_SCOPE+CONTAINS chain, enclosing MODULE for top-level
    ///   binders + classes) instead of a flat (file, name) join; a same-name
    ///   FUNCTION in an UNRELATED scope (`orphan`) does NOT resolve a module-level
    ///   call — the cross-scope false positive the flat match made is dropped;
    /// - the import-binding skip-set on direct calls;
    /// - B1 this./super./<obj>. via the Wave-0 scope chain (block scope →
    ///   lexical parent → METHOD owner → class), with the multi-dot exactness
    ///   pin ("this.a.b" derives NOTHING — concat-equality first-dot parity), a
    ///   not-in-class negative, and DELTA 2a PINNED (nested classes derive an
    ///   edge per enclosing class where the resolver's exactly-one rule skipped);
    /// - B2 ClassName.staticMethod with a lowercase-receiver negative;
    /// - the .rs file-gate negative.
    #[test]
    fn js_same_file_calls_resolves_all_arms_with_preference_ladder() {
        let mut v = FixtureStorageView::new(1);

        // ── A-arm scope shape (Wave-0 verified on the real graph) ─────────────
        // The direct-call arms now SCOPE-WALK (DELTA 6): a call resolves only to a
        // binder declared in a LEXICALLY ENCLOSING container, not any same-(file,
        // name) binder. The file MODULE owns the top scope (MODULE -HAS_SCOPE->
        // s_mod) and CONTAINS the top-level binders + classes; s_mod CONTAINS the
        // direct-call CALLs. Top-level FUNCTION/VARIABLE/CONSTANT are reached via
        // the enclosing-MODULE leg; CLASS is ONLY ever MODULE-contained.
        named_node(&mut v, "mod_app", "app.ts", "MODULE", "app.ts");
        named_node(&mut v, "s_mod", "module", "SCOPE", "app.ts");
        edge(&mut v, "mod_app", "s_mod", "HAS_SCOPE");

        // A1: direct call → FUNCTION (declared at module top level).
        named_node(&mut v, "f_run", "run", "FUNCTION", "app.ts");
        edge(&mut v, "mod_app", "f_run", "CONTAINS");
        named_node(&mut v, "c_fn", "run", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_fn", "CONTAINS");

        // Ladder: FUNCTION beats VARIABLE (both module-level, same chain).
        named_node(&mut v, "f_make", "make", "FUNCTION", "app.ts");
        named_node(&mut v, "v_make", "make", "VARIABLE", "app.ts");
        edge(&mut v, "mod_app", "f_make", "CONTAINS");
        edge(&mut v, "mod_app", "v_make", "CONTAINS");
        named_node(&mut v, "c_pref", "make", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_pref", "CONTAINS");

        // A2 + DELTA 1: VARIABLE and CONSTANT both derive (no FUNCTION).
        named_node(&mut v, "v_cb", "cb", "VARIABLE", "app.ts");
        named_node(&mut v, "k_cb", "cb", "CONSTANT", "app.ts");
        edge(&mut v, "mod_app", "v_cb", "CONTAINS");
        edge(&mut v, "mod_app", "k_cb", "CONTAINS");
        named_node(&mut v, "c_var", "cb", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_var", "CONTAINS");

        // A3: uppercase ctor → CLASS; lowercase negative; ladder suppression.
        named_node(&mut v, "cls_widget", "Widget", "CLASS", "app.ts");
        edge(&mut v, "mod_app", "cls_widget", "CONTAINS");
        named_node(&mut v, "c_ctor", "Widget", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_ctor", "CONTAINS");
        named_node(&mut v, "cls_low", "widget2", "CLASS", "app.ts");
        edge(&mut v, "mod_app", "cls_low", "CONTAINS");
        named_node(&mut v, "c_low", "widget2", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_low", "CONTAINS");
        named_node(&mut v, "v_box", "Box", "VARIABLE", "app.ts");
        named_node(&mut v, "cls_box", "Box", "CLASS", "app.ts");
        edge(&mut v, "mod_app", "v_box", "CONTAINS");
        edge(&mut v, "mod_app", "cls_box", "CONTAINS");
        named_node(&mut v, "c_box", "Box", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_box", "CONTAINS");

        // Import-binding skip on direct calls.
        named_node(&mut v, "b_ext", "ext", "IMPORT_BINDING", "app.ts");
        named_node(&mut v, "f_ext", "ext", "FUNCTION", "app.ts");
        edge(&mut v, "mod_app", "f_ext", "CONTAINS");
        named_node(&mut v, "c_ext", "ext", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_ext", "CONTAINS");

        // DELTA 6 precision lock: a same-name FUNCTION declared in an UNRELATED
        // scope (a different function body) must NOT resolve a module-level call.
        // 'orphan' is declared ONLY inside f_other's body scope; the call c_orph
        // sits at module top level → no enclosing container holds the binder, so
        // the flat (file, name) match's cross-scope false positive is dropped.
        named_node(&mut v, "f_other", "other", "FUNCTION", "app.ts");
        edge(&mut v, "mod_app", "f_other", "CONTAINS");
        named_node(&mut v, "s_other", "function", "SCOPE", "app.ts");
        edge(&mut v, "f_other", "s_other", "HAS_SCOPE");
        named_node(&mut v, "f_orphan", "orphan", "FUNCTION", "app.ts");
        edge(&mut v, "s_other", "f_orphan", "CONTAINS");
        named_node(&mut v, "c_orph", "orphan", "CALL", "app.ts");
        edge(&mut v, "s_mod", "c_orph", "CONTAINS");

        // B1 scope-chain fixture: class App { init() { { this.render() } } }.
        // Owner-vs-lexical shape: METHOD m_init -HAS_SCOPE-> s_fn (function scope);
        // s_fn -HAS_SCOPE-> s_blk (lexical child block); s_blk -CONTAINS-> calls.
        named_node(&mut v, "cls_app", "App", "CLASS", "app.ts");
        named_node(&mut v, "m_init", "init", "METHOD", "app.ts");
        named_node(&mut v, "m_render", "render", "METHOD", "app.ts");
        named_node(&mut v, "m_b", "b", "METHOD", "app.ts");
        edge(&mut v, "cls_app", "m_init", "HAS_METHOD");
        edge(&mut v, "cls_app", "m_render", "HAS_METHOD");
        edge(&mut v, "cls_app", "m_b", "HAS_METHOD");
        named_node(&mut v, "s_fn", "function", "SCOPE", "app.ts");
        named_node(&mut v, "s_blk", "block", "SCOPE", "app.ts");
        edge(&mut v, "m_init", "s_fn", "HAS_SCOPE");
        edge(&mut v, "s_fn", "s_blk", "HAS_SCOPE");
        named_node(&mut v, "c_this", "this.render", "CALL", "app.ts");
        named_node(&mut v, "c_super", "super.render", "CALL", "app.ts");
        named_node(&mut v, "c_obj", "<obj>.render", "CALL", "app.ts");
        named_node(&mut v, "c_md", "this.a.b", "CALL", "app.ts"); // multi-dot pin
        edge(&mut v, "s_blk", "c_this", "CONTAINS");
        edge(&mut v, "s_blk", "c_super", "CONTAINS");
        edge(&mut v, "s_blk", "c_obj", "CONTAINS");
        edge(&mut v, "s_blk", "c_md", "CONTAINS");

        // B1 negative: this-call inside a plain function (no class).
        named_node(&mut v, "f_free", "standalone", "FUNCTION", "app.ts");
        named_node(&mut v, "s_free", "function", "SCOPE", "app.ts");
        edge(&mut v, "f_free", "s_free", "HAS_SCOPE");
        named_node(&mut v, "c_free", "this.render", "CALL", "app.ts");
        edge(&mut v, "s_free", "c_free", "CONTAINS");

        // DELTA 2a: class Inner nested inside Outer's method — "this.m" derives
        // an edge for BOTH enclosing classes' "m" (the resolver skipped: its
        // line-containment demanded exactly one containing class range).
        named_node(&mut v, "cls_out", "Outer", "CLASS", "app.ts");
        named_node(&mut v, "m_out", "wrap", "METHOD", "app.ts");
        named_node(&mut v, "mo_m", "m", "METHOD", "app.ts");
        edge(&mut v, "cls_out", "m_out", "HAS_METHOD");
        edge(&mut v, "cls_out", "mo_m", "HAS_METHOD");
        named_node(&mut v, "cls_in", "Inner", "CLASS", "app.ts");
        named_node(&mut v, "m_in", "inner", "METHOD", "app.ts");
        named_node(&mut v, "mi_m", "m", "METHOD", "app.ts");
        edge(&mut v, "cls_in", "m_in", "HAS_METHOD");
        edge(&mut v, "cls_in", "mi_m", "HAS_METHOD");
        named_node(&mut v, "s_out", "function", "SCOPE", "app.ts");
        named_node(&mut v, "s_in", "function", "SCOPE", "app.ts");
        edge(&mut v, "m_out", "s_out", "HAS_SCOPE");
        edge(&mut v, "m_in", "s_in", "HAS_SCOPE");
        edge(&mut v, "s_out", "s_in", "HAS_SCOPE"); // lexical nesting
        named_node(&mut v, "c_nest", "this.m", "CALL", "app.ts");
        edge(&mut v, "s_in", "c_nest", "CONTAINS");

        // B2: static method call; lowercase-receiver negative.
        named_node(&mut v, "m_create", "create", "METHOD", "app.ts");
        edge(&mut v, "cls_app", "m_create", "HAS_METHOD");
        named_node(&mut v, "c_stat", "App.create", "CALL", "app.ts");
        named_node(&mut v, "cls_tools", "tools", "CLASS", "app.ts");
        named_node(&mut v, "m_fmt", "fmt", "METHOD", "app.ts");
        edge(&mut v, "cls_tools", "m_fmt", "HAS_METHOD");
        named_node(&mut v, "c_lstat", "tools.fmt", "CALL", "app.ts");

        // File gate negative: identical direct-call shape in a .rs file.
        named_node(&mut v, "f_rs", "run", "FUNCTION", "main.rs");
        named_node(&mut v, "c_rs", "run", "CALL", "main.rs");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_SAME_FILE_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_same_file_calls.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(c, t)| (id_of(c), id_of(t), "same-file-calls".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "sf_call_fn"),
            via(&[("c_fn", "f_run"), ("c_pref", "f_make")]),
            "A1: direct→FUNCTION; the ladder gives c_pref ONLY the FUNCTION"
        );
        assert_eq!(
            triples(&eval, "sf_call_var"),
            via(&[("c_var", "v_cb"), ("c_var", "k_cb"), ("c_box", "v_box")]),
            "A2: var/const arm — DELTA 1 derives both cb candidates; Box's VARIABLE \
             wins over its CLASS; 'make' is suppressed by its FUNCTION"
        );
        assert_eq!(
            triples(&eval, "sf_call_ctor"),
            via(&[("c_ctor", "cls_widget")]),
            "A3: uppercase ctor only — lowercase 'widget2' and var-shadowed 'Box' derive nothing"
        );
        assert_eq!(
            triples(&eval, "sf_call_this"),
            via(&[
                ("c_this", "m_render"),
                ("c_super", "m_render"),
                ("c_obj", "m_render"),
                ("c_nest", "mi_m"),
                ("c_nest", "mo_m"),
            ]),
            "B1: this/super/<obj> resolve through the scope chain; 'this.a.b' and the \
             class-less c_free derive NOTHING; c_nest derives BOTH enclosing classes' \
             member (DELTA 2a pinned)"
        );
        assert_eq!(
            triples(&eval, "sf_call_static"),
            via(&[("c_stat", "m_create")]),
            "B2: ClassName.staticMethod; lowercase receiver 'tools.fmt' derives nothing"
        );

        // Every head is CALLS + additive (shared vocabulary) with resolvedVia meta.
        // A3 (sf_call_ctor) is one logical arm expanded into 26 clauses (one per
        // uppercase letter, the inline ctor-name check — see ENCODING NOTES), so the
        // CALLS materialize-spec count is A1(1)+A2(1)+A3(26)+B1(1)+B2(1) = 30.
        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(
            calls_specs.len(),
            30,
            "CALLS heads: A1, A2, B1, B2 + A3 expanded into 26 uppercase-letter clauses"
        );
        assert!(
            calls_specs.iter().all(|s| s.additive),
            "CALLS is shared with the analyzers — every head must be additive"
        );
        assert!(
            calls_specs
                .iter()
                .all(|s| s.meta == vec!["resolvedVia".to_string()]),
            "resolvedVia is projected on every head"
        );
    }

    /// The bundled js_this_method_calls pack resolves this.-method calls SOUNDLY
    /// via the live SCOPE chain (resolve-pack #23 rework — the flat (file,name)
    /// arm was both imprecise and ambiguity-blind):
    /// - a this.-call inside a METHOD body resolves to its enclosing class's member
    ///   (the HAS_METHOD-owner path, shared with js_same_file_calls.dl B1);
    /// - DELTA 2b PINNED: a this.-call inside an ARROW-FUNCTION CLASS PROPERTY (no
    ///   METHOD/FUNCTION HAS_METHOD owner — the `<arrow>` FUNCTION owner is NOT a
    ///   class member) resolves via the CLASS -HAS_SCOPE-> enclosing-scope path —
    ///   the exact SceneManager.ts `_animate`/`_tickFly` case B1 alone MISSES;
    /// - DELTA 2 PRECISION: two same-named members in distinct classes in one file
    ///   each bind their OWN enclosing class (the old flat `ambig` guard refused
    ///   BOTH — a false negative; the scope chain resolves each correctly);
    /// - "this.a.b" derives NOTHING even with a member named "b" — concat-equality
    ///   first-dot parity (the migration spec's method_suffix superset delta is
    ///   eliminated by construction);
    /// - a this.-call not lexically inside any class derives nothing;
    /// - cross-file / .rs negatives;
    /// - DELTA 4 PINNED: .mts is rejected (the resolver's OWN 6-extension gate,
    ///   narrower than the orchestrator's 8-extension stream filter).
    #[test]
    fn js_this_method_calls_scope_walk_with_arrow_property_and_precision() {
        let mut v = FixtureStorageView::new(1);

        // ── Method-body path: class App { init() { { this.render() } } } ──────────
        // m_init -HAS_SCOPE-> s_fn (function scope) -HAS_SCOPE-> s_blk (lexical
        // child block) -CONTAINS-> the call.
        named_node(&mut v, "cls_app", "App", "CLASS", "app.ts");
        named_node(&mut v, "m_init", "init", "METHOD", "app.ts");
        named_node(&mut v, "m_render", "render", "METHOD", "app.ts");
        edge(&mut v, "cls_app", "m_init", "HAS_METHOD");
        edge(&mut v, "cls_app", "m_render", "HAS_METHOD");
        named_node(&mut v, "s_app_cls", "class", "SCOPE", "app.ts");
        named_node(&mut v, "s_fn", "function", "SCOPE", "app.ts");
        named_node(&mut v, "s_blk", "block", "SCOPE", "app.ts");
        edge(&mut v, "cls_app", "s_app_cls", "HAS_SCOPE");
        edge(&mut v, "m_init", "s_fn", "HAS_SCOPE");
        edge(&mut v, "s_app_cls", "s_fn", "HAS_SCOPE"); // lexical: class body owns the method scope
        edge(&mut v, "s_fn", "s_blk", "HAS_SCOPE");
        named_node(&mut v, "c_method", "this.render", "CALL", "app.ts");
        edge(&mut v, "s_blk", "c_method", "CONTAINS");

        // Multi-dot pin inside the same class — METHOD-less, must derive nothing.
        named_node(&mut v, "c_md", "this.a.b", "CALL", "app.ts");
        edge(&mut v, "s_blk", "c_md", "CONTAINS");

        // ── DELTA 2b: arrow-function CLASS PROPERTY. Owner of the arrow scope is a
        // FUNCTION (NOT a HAS_METHOD member); the class reaches the arrow scope only
        // through CLASS -HAS_SCOPE-> arrow-fn-scope. Mirrors SceneManager._tickFly.
        named_node(&mut v, "cls_scene", "Scene", "CLASS", "scene.ts");
        named_node(&mut v, "m_tick", "_tickFly", "METHOD", "scene.ts");
        edge(&mut v, "cls_scene", "m_tick", "HAS_METHOD");
        named_node(&mut v, "s_scene_cls", "class", "SCOPE", "scene.ts");
        named_node(&mut v, "f_arrow", "<arrow>", "FUNCTION", "scene.ts");
        named_node(&mut v, "s_arrow_fn", "function", "SCOPE", "scene.ts");
        named_node(&mut v, "s_arrow_blk", "block", "SCOPE", "scene.ts");
        edge(&mut v, "cls_scene", "s_scene_cls", "HAS_SCOPE");
        edge(&mut v, "f_arrow", "s_arrow_fn", "HAS_SCOPE"); // owner FUNCTION, NOT a class member
        edge(&mut v, "s_scene_cls", "s_arrow_fn", "HAS_SCOPE"); // class body owns the arrow scope
        edge(&mut v, "s_arrow_fn", "s_arrow_blk", "HAS_SCOPE");
        named_node(&mut v, "c_arrow", "this._tickFly", "CALL", "scene.ts");
        edge(&mut v, "s_arrow_blk", "c_arrow", "CONTAINS");

        // ── DELTA 2 precision: two classes in one file, each a private "shouldLog".
        // The old flat `ambig` guard refused BOTH; the scope chain resolves each
        // call to its OWN class's member. (Mirrors util/.../Logger.ts.)
        named_node(&mut v, "cls_cons", "ConsoleLogger", "CLASS", "log.ts");
        named_node(&mut v, "m_cons_sl", "shouldLog", "METHOD", "log.ts");
        named_node(&mut v, "m_cons_w", "write", "METHOD", "log.ts");
        edge(&mut v, "cls_cons", "m_cons_sl", "HAS_METHOD");
        edge(&mut v, "cls_cons", "m_cons_w", "HAS_METHOD");
        named_node(&mut v, "s_cons_cls", "class", "SCOPE", "log.ts");
        named_node(&mut v, "s_cons_fn", "function", "SCOPE", "log.ts");
        edge(&mut v, "cls_cons", "s_cons_cls", "HAS_SCOPE");
        edge(&mut v, "m_cons_w", "s_cons_fn", "HAS_SCOPE");
        edge(&mut v, "s_cons_cls", "s_cons_fn", "HAS_SCOPE");
        named_node(&mut v, "c_cons_sl", "this.shouldLog", "CALL", "log.ts");
        edge(&mut v, "s_cons_fn", "c_cons_sl", "CONTAINS");

        named_node(&mut v, "cls_file", "FileLogger", "CLASS", "log.ts");
        named_node(&mut v, "m_file_sl", "shouldLog", "METHOD", "log.ts");
        named_node(&mut v, "m_file_w", "writeLine", "METHOD", "log.ts");
        edge(&mut v, "cls_file", "m_file_sl", "HAS_METHOD");
        edge(&mut v, "cls_file", "m_file_w", "HAS_METHOD");
        named_node(&mut v, "s_file_cls", "class", "SCOPE", "log.ts");
        named_node(&mut v, "s_file_fn", "function", "SCOPE", "log.ts");
        edge(&mut v, "cls_file", "s_file_cls", "HAS_SCOPE");
        edge(&mut v, "m_file_w", "s_file_fn", "HAS_SCOPE");
        edge(&mut v, "s_file_cls", "s_file_fn", "HAS_SCOPE");
        named_node(&mut v, "c_file_sl", "this.shouldLog", "CALL", "log.ts");
        edge(&mut v, "s_file_fn", "c_file_sl", "CONTAINS");

        // ── Negative: this.-call inside a plain top-level function (no class).
        named_node(&mut v, "f_free", "standalone", "FUNCTION", "free.ts");
        named_node(&mut v, "m_orphan", "render", "METHOD", "free.ts"); // same-file METHOD, no class
        named_node(&mut v, "s_free", "function", "SCOPE", "free.ts");
        edge(&mut v, "f_free", "s_free", "HAS_SCOPE");
        named_node(&mut v, "c_free", "this.render", "CALL", "free.ts");
        edge(&mut v, "s_free", "c_free", "CONTAINS");

        // ── File gate: .rs is not JS (a fully-wired class+scope, still rejected).
        named_node(&mut v, "cls_rs", "Rs", "CLASS", "main.rs");
        named_node(&mut v, "m_go", "go", "METHOD", "main.rs");
        edge(&mut v, "cls_rs", "m_go", "HAS_METHOD");
        named_node(&mut v, "s_rs_cls", "class", "SCOPE", "main.rs");
        named_node(&mut v, "s_rs_fn", "function", "SCOPE", "main.rs");
        edge(&mut v, "cls_rs", "s_rs_cls", "HAS_SCOPE");
        edge(&mut v, "m_go", "s_rs_fn", "HAS_SCOPE");
        edge(&mut v, "s_rs_cls", "s_rs_fn", "HAS_SCOPE");
        named_node(&mut v, "c_rs", "this.go", "CALL", "main.rs");
        edge(&mut v, "s_rs_fn", "c_rs", "CONTAINS");

        // ── DELTA 4: .mts rejected by the resolver's own 6-extension gate.
        named_node(&mut v, "cls_mts", "Mts", "CLASS", "app.mts");
        named_node(&mut v, "m_mts", "save", "METHOD", "app.mts");
        edge(&mut v, "cls_mts", "m_mts", "HAS_METHOD");
        named_node(&mut v, "s_mts_cls", "class", "SCOPE", "app.mts");
        named_node(&mut v, "s_mts_fn", "function", "SCOPE", "app.mts");
        edge(&mut v, "cls_mts", "s_mts_cls", "HAS_SCOPE");
        edge(&mut v, "m_mts", "s_mts_fn", "HAS_SCOPE");
        edge(&mut v, "s_mts_cls", "s_mts_fn", "HAS_SCOPE");
        named_node(&mut v, "c_mts", "this.save", "CALL", "app.mts");
        edge(&mut v, "s_mts_fn", "c_mts", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_THIS_METHOD_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_this_method_calls.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(c, t)| (id_of(c), id_of(t), "js-this-method-calls".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "js_this_method_call"),
            via(&[
                ("c_method", "m_render"),
                ("c_arrow", "m_tick"),
                ("c_cons_sl", "m_cons_sl"),
                ("c_file_sl", "m_file_sl"),
            ]),
            "scope-walk: method-body c_method→m_render; arrow-property c_arrow→m_tick \
             (DELTA 2b, the class-scope path B1 misses); the two same-named shouldLog \
             calls each bind their OWN class (DELTA 2 precision — no flat ambig skip); \
             'this.a.b' multi-dot, the class-less c_free, cross-file, .rs and .mts \
             (DELTA 4) all derive nothing"
        );

        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 1, "exactly one CALLS head");
        assert!(calls_specs[0].additive, "CALLS is shared — additive");
        assert_eq!(calls_specs[0].meta, vec!["resolvedVia".to_string()]);
    }

    /// The bundled rust_calls pack resolves same-file CALLs by SCOPE-WALK to the
    /// nearest enclosing FUNCTION binder (not flat (file,name)):
    /// - R1 scope-walk exact: a bare-name call resolves to the same-name FUNCTION
    ///   lexically visible from the call's enclosing FUNCTION — sibling in the same
    ///   IMPL_BLOCK/MODULE owner, or a file-level free function. Covers the call
    ///   directly under a FUNCTION, a call nested in a block SCOPE (HAS_SCOPE walk),
    ///   and a MODULE-level call (no enclosing fn → free-fn arm);
    /// - R1 PRECISION (the rework, ex-DELTA-1): two `fn process` in two different
    ///   impl blocks — a call inside `impl A` resolves to ONLY `A::process`, NOT the
    ///   same-named `B::process` (flat resolution emitted BOTH; the scope-walk drops
    ///   the out-of-scope twin);
    /// - R2 '::'-suffix fallback (FLAT by design — a qualified path names its type)
    ///   with the segment boundary ("do_y" must NOT match FUNCTION "y") and the
    ///   exact-beats-suffix preference negation;
    /// - cross-file and non-.rs negatives;
    /// - DELTA 2 PINNED (R2): a multi-segment FUNCTION name ("b::c") matches via the
    ///   suffix arm (the resolver's lastSegment comparison never could).
    ///
    /// Scope shape mirrors rust_analyzer.rs: the file is one MODULE; free fns and
    /// IMPL_BLOCKs are MODULE-CONTAINS children; an IMPL_BLOCK CONTAINS its methods;
    /// a FUNCTION directly CONTAINS its top-level CALLs (the fn IS its own scope, no
    /// separate body SCOPE); block bodies are SCOPE nodes the fn HAS_SCOPEs.
    #[test]
    fn rust_calls_scope_walk_exact_then_suffix_fallback() {
        let mut v = FixtureStorageView::new(1);

        // The file MODULE (one per file; inline `mod` is walked inline).
        named_node(&mut v, "m_lib", "lib", "MODULE", "lib.rs");

        // R1: free fn `helper`, called from a sibling free fn `caller_a`.
        named_node(&mut v, "f_helper", "helper", "FUNCTION", "lib.rs");
        named_node(&mut v, "f_caller_a", "caller_a", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_helper", "CONTAINS");
        edge(&mut v, "m_lib", "f_caller_a", "CONTAINS");
        named_node(&mut v, "c1", "helper", "CALL", "lib.rs");
        edge(&mut v, "f_caller_a", "c1", "CONTAINS"); // call directly under the fn

        // R1 nested-block: a call to `helper` inside an if-block SCOPE of caller_a
        // resolves through the HAS_SCOPE walk up to caller_a → m_lib → free fn.
        named_node(&mut v, "s_blk", "block", "SCOPE", "lib.rs");
        edge(&mut v, "f_caller_a", "s_blk", "HAS_SCOPE");
        named_node(&mut v, "c1b", "helper", "CALL", "lib.rs");
        edge(&mut v, "s_blk", "c1b", "CONTAINS");

        // R1 PRECISION: `process` exists in BOTH impl A and impl B. A call inside
        // a method of impl A must resolve to A's process only.
        named_node(&mut v, "ib_a", "A", "IMPL_BLOCK", "lib.rs");
        named_node(&mut v, "ib_b", "B", "IMPL_BLOCK", "lib.rs");
        edge(&mut v, "m_lib", "ib_a", "CONTAINS");
        edge(&mut v, "m_lib", "ib_b", "CONTAINS");
        named_node(&mut v, "f_process_a", "process", "FUNCTION", "lib.rs");
        named_node(&mut v, "f_process_b", "process", "FUNCTION", "lib.rs");
        edge(&mut v, "ib_a", "f_process_a", "CONTAINS");
        edge(&mut v, "ib_b", "f_process_b", "CONTAINS");
        // method `run` in impl A that calls `process()` (bare name / self.process).
        named_node(&mut v, "f_run_a", "run", "FUNCTION", "lib.rs");
        edge(&mut v, "ib_a", "f_run_a", "CONTAINS");
        named_node(&mut v, "c4", "process", "CALL", "lib.rs");
        edge(&mut v, "f_run_a", "c4", "CONTAINS");

        // R1 MODULE-level call to a free fn (no enclosing FUNCTION → free-fn arm).
        named_node(&mut v, "f_init", "init", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_init", "CONTAINS");
        named_node(&mut v, "c_mod", "init", "CALL", "lib.rs");
        edge(&mut v, "m_lib", "c_mod", "CONTAINS"); // top-level const-initializer call

        // R2 suffix.
        named_node(&mut v, "f_helper2", "helper2", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_helper2", "CONTAINS");
        named_node(&mut v, "c2", "utils::helper2", "CALL", "lib.rs");
        edge(&mut v, "f_caller_a", "c2", "CONTAINS");

        // Exact beats suffix: both "m::foo" and "foo" exist; only the scoped exact
        // fires for the bare call "m::foo"? No — the call name IS "m::foo" (qualified
        // path). The bare-name exact arm requires FUNCTION.name == call name, so a
        // FUNCTION literally named "m::foo" matches R1 (scoped); the "::"-suffix R2
        // is then suppressed by the has_scoped preference negation.
        named_node(&mut v, "f_qual", "m::foo", "FUNCTION", "lib.rs");
        named_node(&mut v, "f_foo", "foo", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_qual", "CONTAINS");
        edge(&mut v, "m_lib", "f_foo", "CONTAINS");
        named_node(&mut v, "c3", "m::foo", "CALL", "lib.rs");
        edge(&mut v, "f_caller_a", "c3", "CONTAINS");

        // Cross-file negative: `far` is in other.rs; the call is in lib.rs.
        named_node(&mut v, "f_far", "far", "FUNCTION", "other.rs");
        named_node(&mut v, "c5", "far", "CALL", "lib.rs");
        edge(&mut v, "f_caller_a", "c5", "CONTAINS");

        // File gate negative: same shape in a .ts file.
        named_node(&mut v, "m_app", "app", "MODULE", "app.ts");
        named_node(&mut v, "f_js", "jsfn", "FUNCTION", "app.ts");
        edge(&mut v, "m_app", "f_js", "CONTAINS");
        named_node(&mut v, "c6", "jsfn", "CALL", "app.ts");
        edge(&mut v, "f_js", "c6", "CONTAINS");

        // Suffix boundary negative: "do_y" must not match FUNCTION "y".
        named_node(&mut v, "f_y", "y", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_y", "CONTAINS");
        named_node(&mut v, "c7", "do_y", "CALL", "lib.rs");
        edge(&mut v, "f_caller_a", "c7", "CONTAINS");

        // R2 DELTA 2: multi-segment FUNCTION name matches as a suffix.
        named_node(&mut v, "f_bc", "b::c", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_bc", "CONTAINS");
        named_node(&mut v, "c9", "a::b::c", "CALL", "lib.rs");
        edge(&mut v, "f_caller_a", "c9", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_calls.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(c, t)| (id_of(c), id_of(t), "rust-calls".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "rust_call"),
            via(&[
                ("c1", "f_helper"),     // free fn, sibling-of-caller via m_lib
                ("c1b", "f_helper"),    // nested block SCOPE → HAS_SCOPE walk → free fn
                ("c4", "f_process_a"),  // PRECISION: impl-A method calling process →
                                        // ONLY A::process (B::process out of scope)
                ("c_mod", "f_init"),    // MODULE-level call → free fn
                ("c3", "f_qual"),       // qualified-name FUNCTION matched bare-exact
            ]),
            "R1 scope-walk: free fns resolve via the file MODULE, the nested-block \
             call walks HAS_SCOPE to its fn, the impl-A `process` call resolves to \
             A::process ONLY (not B::process — the precision fix), the MODULE-level \
             call resolves the free fn, and the qualified-name FUNCTION matches the \
             bare exact arm. Cross-file/.ts negatives derive nothing"
        );
        assert_eq!(
            triples(&eval, "rust_suffix_call"),
            via(&[
                ("c2", "f_helper2"),
                ("c9", "f_bc"),
            ]),
            "R2: suffix fallback — c3 is suppressed by its scoped exact match \
             (preference negation), 'do_y' misses the '::y' boundary, c9 matches the \
             multi-segment name (DELTA 2)"
        );

        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 2, "two CALLS heads (exact + suffix)");
        assert!(
            calls_specs.iter().all(|s| s.additive),
            "CALLS is shared with the analyzers — additive is mandatory"
        );
        assert!(
            calls_specs
                .iter()
                .all(|s| s.meta == vec!["resolvedVia".to_string()]),
            "resolvedVia is projected on both heads"
        );
    }

    /// #23 / RFD — R2 type-discrimination (the dominant resolution-is-a-function
    /// violation fix). The old flat last-segment fallback resolved `Foo::new` to
    /// EVERY same-file `fn new` and bound std `HashSet::new` to a LOCAL `new`.
    /// The reworked R2a matches `Type::assoc` to the IMPL_BLOCK-of-that-type's
    /// method only; R2b keeps free-fn path calls flat. Pinned:
    ///  - `Foo::new` resolves to Foo::new ONLY (not Bar::new) — discrimination;
    ///  - `crate::a::Foo::new` resolves Foo::new via the interior-segment arm;
    ///  - `HashSet::new` (no local impl) resolves to NOTHING (was unsound);
    ///  - `MyFoo::new` does NOT match `impl Foo` (left boundary anchored);
    ///  - `utils::helper` still resolves the free fn `helper` (R2b preserved).
    #[test]
    fn rust_calls_r2_type_discriminated_assoc_fn() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "m_x", "x", "MODULE", "x.rs");

        // Two impls in one file, each with `fn new` (HAS_METHOD + CONTAINS, the
        // real analyzer shape: rust_analyzer.rs:985 / fn-owner CONTAINS).
        named_node(&mut v, "ib_foo", "Foo", "IMPL_BLOCK", "x.rs");
        named_node(&mut v, "ib_bar", "Bar", "IMPL_BLOCK", "x.rs");
        edge(&mut v, "m_x", "ib_foo", "CONTAINS");
        edge(&mut v, "m_x", "ib_bar", "CONTAINS");
        named_node(&mut v, "f_foo_new", "new", "FUNCTION", "x.rs");
        named_node(&mut v, "f_bar_new", "new", "FUNCTION", "x.rs");
        edge(&mut v, "ib_foo", "f_foo_new", "HAS_METHOD");
        edge(&mut v, "ib_foo", "f_foo_new", "CONTAINS");
        edge(&mut v, "ib_bar", "f_bar_new", "HAS_METHOD");
        edge(&mut v, "ib_bar", "f_bar_new", "CONTAINS");

        // A free fn for the R2b arm.
        named_node(&mut v, "f_helper", "helper", "FUNCTION", "x.rs");
        edge(&mut v, "m_x", "f_helper", "CONTAINS");

        // Calls (MODULE-level so R1 cannot fire — no FUNCTION named the call path).
        named_node(&mut v, "c_foo", "Foo::new", "CALL", "x.rs");
        named_node(&mut v, "c_interior", "crate::a::Foo::new", "CALL", "x.rs");
        named_node(&mut v, "c_hash", "HashSet::new", "CALL", "x.rs");
        named_node(&mut v, "c_myfoo", "MyFoo::new", "CALL", "x.rs");
        named_node(&mut v, "c_util", "utils::helper", "CALL", "x.rs");
        for c in ["c_foo", "c_interior", "c_hash", "c_myfoo", "c_util"] {
            edge(&mut v, "m_x", c, "CONTAINS");
        }

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_calls.dl evaluates");

        let edges: BTreeSet<(u128, u128, String)> = triples(&eval, "rust_suffix_call");
        let expect: BTreeSet<(u128, u128, String)> = [
            ("c_foo", "f_foo_new"),         // R2a: ONLY Foo::new, not Bar::new
            ("c_interior", "f_foo_new"),    // R2a interior segment
            ("c_util", "f_helper"),         // R2b: free fn preserved
        ]
        .iter()
        .map(|(c, t)| (id_of(c), id_of(t), "rust-calls".to_string()))
        .collect();
        assert_eq!(
            edges, expect,
            "R2a binds Type::assoc to that type's impl method only (Foo::new → \
             Foo::new, NOT Bar::new); the interior path resolves Foo::new; \
             HashSet::new (no local impl) and MyFoo::new (boundary) resolve to \
             NOTHING; utils::helper still resolves the free fn via R2b"
        );
        // Explicit: the over-resolution to Bar::new is gone.
        assert!(
            !edges.contains(&(id_of("c_foo"), id_of("f_bar_new"), "rust-calls".to_string())),
            "Foo::new must NOT resolve to Bar::new (the violation this fix removes)"
        );
    }

    /// R1 method/free-fn name collision (the parser.rs residual). A file with both
    /// a method `impl Parser { fn parse }` and a free `fn parse`: a `self.parse()`
    /// method call (CALL with a READS_FROM receiver) must resolve to the METHOD
    /// ONLY (owner arm), NOT also to the free fn (file-MODULE arm gated by
    /// \+ has_receiver). A bare free call `parse()` (no receiver) still resolves
    /// the free fn.
    #[test]
    fn rust_calls_r1_method_call_excludes_free_fn_of_same_name() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "m_p", "p", "MODULE", "p.rs");

        // impl Parser { fn parse(&self); fn run(&self) }  +  free fn parse()
        named_node(&mut v, "ib_parser", "Parser", "IMPL_BLOCK", "p.rs");
        edge(&mut v, "m_p", "ib_parser", "CONTAINS");
        named_node(&mut v, "f_method_parse", "parse", "FUNCTION", "p.rs");
        named_node(&mut v, "f_run", "run", "FUNCTION", "p.rs");
        named_node(&mut v, "f_free_parse", "parse", "FUNCTION", "p.rs");
        for (ib, f) in [("ib_parser", "f_method_parse"), ("ib_parser", "f_run")] {
            edge(&mut v, ib, f, "HAS_METHOD");
            edge(&mut v, ib, f, "CONTAINS");
        }
        edge(&mut v, "m_p", "f_free_parse", "CONTAINS");

        // `self.parse()` inside run: CALL "parse" with a READS_FROM receiver.
        named_node(&mut v, "c_self", "parse", "CALL", "p.rs");
        named_node(&mut v, "ref_self", "self", "REFERENCE", "p.rs");
        edge(&mut v, "f_run", "c_self", "CONTAINS");
        edge(&mut v, "c_self", "ref_self", "READS_FROM"); // method-call discriminator

        // A bare free call `parse()` at module level (no receiver).
        named_node(&mut v, "c_free", "parse", "CALL", "p.rs");
        edge(&mut v, "m_p", "c_free", "CONTAINS");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_calls.dl evaluates");

        let edges: BTreeSet<(u128, u128, String)> = triples(&eval, "rust_call");
        let expect: BTreeSet<(u128, u128, String)> = [
            ("c_self", "f_method_parse"), // method call → impl method ONLY
            ("c_free", "f_free_parse"),   // free call → free fn
        ]
        .iter()
        .map(|(c, t)| (id_of(c), id_of(t), "rust-calls".to_string()))
        .collect();
        assert_eq!(
            edges, expect,
            "self.parse() (has receiver) resolves to Parser::parse ONLY; a bare \
             parse() (no receiver) resolves the free fn"
        );
        assert!(
            !edges.contains(&(id_of("c_self"), id_of("f_free_parse"), "rust-calls".to_string())),
            "the method call self.parse() must NOT also resolve to the free fn parse \
             (the parser.rs residual this fix removes)"
        );
    }

    /// Wave M (rust_calls DELTA 5): macro invocations — CALL nodes the analyzer
    /// stamps with metadata macro=true (rust_analyzer.rs:1433-1457, walk_macro;
    /// the name is the macro path WITHOUT '!') — are EXCLUDED from name
    /// resolution: "foo! is not the function foo" (:1423-1424). Pinned:
    /// (a) a macro CALL named identically to a same-file FUNCTION derives NO
    ///     CALLS edge;
    /// (b) a plain CALL with the same name still resolves through R1;
    /// (c) a macro whose path suffix-matches a FUNCTION via "::" derives
    ///     nothing through R2 (the arm where macro floods hurt most: every
    ///     unmatched macro otherwise scans rs_fn).
    #[test]
    fn rust_calls_macro_invocations_are_excluded() {
        let mut v = FixtureStorageView::new(1);

        // The file MODULE + a calling fn (scope-walk needs an enclosing binder /
        // file MODULE for R1 to resolve the plain call).
        named_node(&mut v, "m_lib", "lib", "MODULE", "lib.rs");
        named_node(&mut v, "f_caller", "caller", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_caller", "CONTAINS");

        named_node(&mut v, "f_helper", "helper", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_helper", "CONTAINS");
        // (a) macro invocation `helper!()` — same name, same file.
        named_node(&mut v, "c_mac", "helper", "CALL", "lib.rs");
        edge(&mut v, "f_caller", "c_mac", "CONTAINS");
        v.put_node_metadata(id_of("c_mac"), r#"{"macro":true,"method":false}"#);
        // (b) plain call `helper()`.
        named_node(&mut v, "c_plain", "helper", "CALL", "lib.rs");
        edge(&mut v, "f_caller", "c_plain", "CONTAINS");

        // (c) macro `paths::mk!()` — would suffix-match fn mk across R2's
        // "::" boundary if not filtered.
        named_node(&mut v, "f_mk", "mk", "FUNCTION", "lib.rs");
        edge(&mut v, "m_lib", "f_mk", "CONTAINS");
        named_node(&mut v, "c_macq", "paths::mk", "CALL", "lib.rs");
        edge(&mut v, "f_caller", "c_macq", "CONTAINS");
        v.put_node_metadata(id_of("c_macq"), r#"{"macro":true,"method":false}"#);

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_calls.dl evaluates");

        assert_eq!(
            triples(&eval, "rust_call"),
            BTreeSet::from([(id_of("c_plain"), id_of("f_helper"), "rust-calls".to_string())]),
            "only the plain call resolves; the same-named macro derives nothing"
        );
        assert_eq!(
            triples(&eval, "rust_suffix_call"),
            BTreeSet::new(),
            "the macro's '::'-suffix candidate is blocked from R2"
        );
    }

    /// The (src, dst, meta1, meta2) quads of a 4-ary materialized predicate.
    fn quads(
        eval: &crate::derive::exec::Evaluation,
        pred: &str,
    ) -> BTreeSet<(u128, u128, String, String)> {
        eval.facts(pred)
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("arg0 id"),
                    row[1].as_id().expect("arg1 id"),
                    row[2].as_str(),
                    row[3].as_str(),
                )
            })
            .collect()
    }

    /// The bundled rust_cross_methods_ctor pack (Wave 1b) reproduces the
    /// resolved-constructor arm of RustCrossMethodCalls.hs with every gate pinned:
    /// - happy path: `let w = Widget::new(); w.render()` — receiver REFERENCE deref,
    ///   ASSIGNED_FROM → init CALL with a COMMITTED CALLS edge to a method of
    ///   `impl Widget`, init name contains "Widget::" → CALLS (c_m → render);
    /// - direct (non-REFERENCE) receiver declaration — the identity deref clause;
    /// - DELTA 1 PINNED (the coverage-subset delta): an UNRESOLVED init call
    ///   (no CALLS edge) derives nothing, even though the resolver's textual
    ///   heuristic would have fired on "Widget::new";
    /// - constructor gate: an init resolved to an impl method whose own call name
    ///   lacks "TName::" ("make") derives nothing;
    /// - init resolved to a FREE function (no impl) derives nothing;
    /// - method name not on the impl derives nothing;
    /// - chained receiver (READS_FROM → PROPERTY_ACCESS, no ASSIGNED_FROM) derives
    ///   nothing (DELTA 6's harmless side);
    /// - non-.rs file gate;
    /// - DELTA 3 PINNED: two same-named IMPL_BLOCKs — an edge per candidate's member.
    #[test]
    fn rust_cross_methods_ctor_resolves_constructor_typed_receivers() {
        let mut v = FixtureStorageView::new(1);

        // impl Widget { fn new(); fn render() } — the graph-native ImplMethodIndex.
        named_node(&mut v, "ib_w", "Widget", "IMPL_BLOCK", "widget.rs");
        named_node(&mut v, "f_new", "new", "FUNCTION", "widget.rs");
        named_node(&mut v, "f_render", "render", "FUNCTION", "widget.rs");
        edge(&mut v, "ib_w", "f_new", "HAS_METHOD");
        edge(&mut v, "ib_w", "f_render", "HAS_METHOD");

        // Happy path: w = Widget::new() (init RESOLVED — committed CALLS edge);
        // w.render() through the REFERENCE deref hop.
        named_node(&mut v, "init1", "Widget::new", "CALL", "a.rs");
        edge(&mut v, "init1", "f_new", "CALLS"); // the rust_calls EDB seam
        named_node(&mut v, "v_w", "w", "VARIABLE", "a.rs");
        edge(&mut v, "v_w", "init1", "ASSIGNED_FROM");
        named_node(&mut v, "ref_w", "w", "REFERENCE", "a.rs");
        edge(&mut v, "ref_w", "v_w", "READS_FROM");
        named_node(&mut v, "c_m", "render", "CALL", "a.rs");
        edge(&mut v, "c_m", "ref_w", "READS_FROM");

        // Direct receiver-declaration shape (no REFERENCE hop) — identity clause.
        named_node(&mut v, "init2", "Widget::new", "CALL", "b.rs");
        edge(&mut v, "init2", "f_new", "CALLS");
        named_node(&mut v, "v_d", "d", "VARIABLE", "b.rs");
        edge(&mut v, "v_d", "init2", "ASSIGNED_FROM");
        named_node(&mut v, "c_direct", "render", "CALL", "b.rs");
        edge(&mut v, "c_direct", "v_d", "READS_FROM");

        // DELTA 1 (subset pin): init NOT resolved — no CALLS edge — derives nothing
        // (the resolver's textual heuristic would have typed this receiver).
        named_node(&mut v, "init3", "Widget::new", "CALL", "c.rs");
        named_node(&mut v, "v_u", "u", "VARIABLE", "c.rs");
        edge(&mut v, "v_u", "init3", "ASSIGNED_FROM");
        named_node(&mut v, "c_unres", "render", "CALL", "c.rs");
        edge(&mut v, "c_unres", "v_u", "READS_FROM");

        // Constructor gate: init resolved to impl-method "new" but the call is
        // named "make" — no "Widget::" containment — derives nothing.
        named_node(&mut v, "init4", "make", "CALL", "d.rs");
        edge(&mut v, "init4", "f_new", "CALLS");
        named_node(&mut v, "v_g", "g", "VARIABLE", "d.rs");
        edge(&mut v, "v_g", "init4", "ASSIGNED_FROM");
        named_node(&mut v, "c_gate", "render", "CALL", "d.rs");
        edge(&mut v, "c_gate", "v_g", "READS_FROM");

        // Free-function init: resolved, but the target is in no IMPL_BLOCK.
        named_node(&mut v, "f_free", "make_widget", "FUNCTION", "free.rs");
        named_node(&mut v, "init5", "make_widget", "CALL", "e.rs");
        edge(&mut v, "init5", "f_free", "CALLS");
        named_node(&mut v, "v_f", "f", "VARIABLE", "e.rs");
        edge(&mut v, "v_f", "init5", "ASSIGNED_FROM");
        named_node(&mut v, "c_freefn", "render", "CALL", "e.rs");
        edge(&mut v, "c_freefn", "v_f", "READS_FROM");

        // Method not on the impl: typed receiver, but "missing" has no member.
        named_node(&mut v, "c_miss", "missing", "CALL", "a.rs");
        edge(&mut v, "c_miss", "ref_w", "READS_FROM");

        // Chained receiver: READS_FROM target is a PROPERTY_ACCESS (no
        // ASSIGNED_FROM) — identity deref, then nothing.
        named_node(&mut v, "pa_x", "x.y", "PROPERTY_ACCESS", "a.rs");
        named_node(&mut v, "c_chain", "render", "CALL", "a.rs");
        edge(&mut v, "c_chain", "pa_x", "READS_FROM");

        // File gate: the identical happy shape in a .ts file derives nothing.
        named_node(&mut v, "init6", "Widget::new", "CALL", "app.ts");
        edge(&mut v, "init6", "f_new", "CALLS");
        named_node(&mut v, "v_ts", "t", "VARIABLE", "app.ts");
        edge(&mut v, "v_ts", "init6", "ASSIGNED_FROM");
        named_node(&mut v, "c_ts", "render", "CALL", "app.ts");
        edge(&mut v, "c_ts", "v_ts", "READS_FROM");

        // DELTA 3 (superset pin): a SECOND impl Widget in another file also
        // carrying "render" — the happy-path call derives an edge per candidate.
        named_node(&mut v, "ib_w2", "Widget", "IMPL_BLOCK", "widget2.rs");
        named_node(&mut v, "f_render2", "render", "FUNCTION", "widget2.rs");
        edge(&mut v, "ib_w2", "f_render2", "HAS_METHOD");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_CROSS_METHODS_CTOR_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_cross_methods_ctor.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String, String)> {
            pairs
                .iter()
                .map(|(c, t)| {
                    (
                        id_of(c),
                        id_of(t),
                        "rust-cross-method".to_string(),
                        "Widget".to_string(),
                    )
                })
                .collect()
        };
        assert_eq!(
            quads(&eval, "rust_ctor_method_call"),
            via(&[
                ("c_m", "f_render"),
                ("c_m", "f_render2"),
                ("c_direct", "f_render"),
                ("c_direct", "f_render2"),
            ]),
            "happy + direct-decl resolve (each to BOTH same-named impls' member — \
             DELTA 3); unresolved init (DELTA 1), gate-less 'make', free-fn init, \
             missing member, chained PA receiver and .ts file derive nothing"
        );

        // CALLS is shared vocabulary — additive, with both meta columns projected.
        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 1, "exactly one CALLS head");
        assert!(calls_specs[0].additive, "CALLS is shared — additive");
        assert_eq!(
            calls_specs[0].meta,
            vec!["resolvedVia".to_string(), "receiverType".to_string()],
            "resolvedVia + receiverType ride as meta columns"
        );
    }

    /// Wave M (rust_cross_methods_ctor DELTA 7): macros are excluded from BOTH
    /// CALL legs of the ctor arm — a macro DISPATCHED call derives nothing even
    /// through a properly ctor-typed receiver, and a macro INIT call (even one
    /// carrying a stale CALLS edge from a pre-Wave-M graph) types no receiver.
    #[test]
    fn rust_cross_methods_ctor_excludes_macro_calls() {
        let mut v = FixtureStorageView::new(1);

        // impl Widget { fn new(); fn render() }.
        named_node(&mut v, "ib_w", "Widget", "IMPL_BLOCK", "widget.rs");
        named_node(&mut v, "f_new", "new", "FUNCTION", "widget.rs");
        named_node(&mut v, "f_render", "render", "FUNCTION", "widget.rs");
        edge(&mut v, "ib_w", "f_new", "HAS_METHOD");
        edge(&mut v, "ib_w", "f_render", "HAS_METHOD");

        // Leg 1: real ctor-typed receiver, but the dispatched call is a MACRO
        // named like the impl method (`render!(w)`).
        named_node(&mut v, "init1", "Widget::new", "CALL", "a.rs");
        edge(&mut v, "init1", "f_new", "CALLS");
        named_node(&mut v, "v_w", "w", "VARIABLE", "a.rs");
        edge(&mut v, "v_w", "init1", "ASSIGNED_FROM");
        named_node(&mut v, "ref_w", "w", "REFERENCE", "a.rs");
        edge(&mut v, "ref_w", "v_w", "READS_FROM");
        named_node(&mut v, "c_mac", "render", "CALL", "a.rs");
        v.put_node_metadata(id_of("c_mac"), r#"{"macro":true,"method":false}"#);
        edge(&mut v, "c_mac", "ref_w", "READS_FROM");

        // Leg 2: the INIT is a macro (stale CALLS edge from an old graph);
        // the dispatched call is plain — the receiver must stay untyped.
        named_node(&mut v, "init2", "Widget::new", "CALL", "b.rs");
        v.put_node_metadata(id_of("init2"), r#"{"macro":true,"method":false}"#);
        edge(&mut v, "init2", "f_new", "CALLS");
        named_node(&mut v, "v_d", "d", "VARIABLE", "b.rs");
        edge(&mut v, "v_d", "init2", "ASSIGNED_FROM");
        named_node(&mut v, "ref_d", "d", "REFERENCE", "b.rs");
        edge(&mut v, "ref_d", "v_d", "READS_FROM");
        named_node(&mut v, "c_plain", "render", "CALL", "b.rs");
        edge(&mut v, "c_plain", "ref_d", "READS_FROM");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_CROSS_METHODS_CTOR_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_cross_methods_ctor.dl evaluates");

        assert_eq!(
            quads(&eval, "rust_ctor_method_call"),
            BTreeSet::new(),
            "macro dispatch (a.rs) and macro-typed init (b.rs) both derive nothing"
        );
    }

    /// The bundled js_cross_file_calls pack (Wave 1b, hybrid) resolves both arms
    /// over the LEGACY producer's IMPORTS_FROM edges:
    /// - A1 direct: dotless call through a binding's edge — plain, ALIASED
    ///   (`import {x as y}` — the caveat-does-not-apply pin: the legacy edge
    ///   already disambiguated) and DEFAULT (endpoint = the EXPORT "default"
    ///   node, legacy-parity);
    /// - A1 negatives: a dotless call on a NAMESPACE binding (MODULE target,
    ///   DELTA 3 guard), a call that is no binding, the .rs file gate;
    /// - A2 namespace: member via EXPORT -EXPORTS-> decl; ns.default via the
    ///   EXPORT node; multi-dot "utils.a.b" derives NOTHING (concat-equality
    ///   first-dot parity); EXPORT_BINDING members EXCLUDED (DELTA 4 pin);
    ///   unknown member and non-binding receiver derive nothing;
    /// - DELTA 5 PINNED: duplicate same-name exports derive an edge each.
    #[test]
    fn js_cross_file_calls_direct_and_namespace_arms() {
        let mut v = FixtureStorageView::new(1);

        // Target module utils.ts with its exports.
        named_node(&mut v, "m_utils", "utils", "MODULE", "utils.ts");
        named_node(&mut v, "e_named", "named", "EXPORT", "utils.ts");
        named_node(&mut v, "f_helper", "helper", "FUNCTION", "utils.ts");
        edge(&mut v, "e_named", "f_helper", "EXPORTS");
        named_node(&mut v, "e_def_u", "default", "EXPORT", "utils.ts");
        // An export-binding member (`export { fromBarrel }`) — DELTA 4: excluded.
        named_node(&mut v, "eb_barrel", "fromBarrel", "EXPORT_BINDING", "utils.ts");
        edge(&mut v, "e_named", "eb_barrel", "EXPORTS");
        // DELTA 5: two same-named exported declarations.
        named_node(&mut v, "f_dup1", "dup", "FUNCTION", "utils.ts");
        named_node(&mut v, "f_dup2", "dup", "FUNCTION", "utils.ts");
        edge(&mut v, "e_named", "f_dup1", "EXPORTS");
        edge(&mut v, "e_named", "f_dup2", "EXPORTS");
        // A multi-dot trap: an export literally named "b" must NOT match "utils.a.b".
        named_node(&mut v, "f_b", "b", "FUNCTION", "utils.ts");
        edge(&mut v, "e_named", "f_b", "EXPORTS");

        // A1 plain: import { greet } — binding edge to the target FUNCTION.
        named_node(&mut v, "f_greet", "greet", "FUNCTION", "greet.ts");
        named_node(&mut v, "b_greet", "greet", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "b_greet", "f_greet", "IMPORTS_FROM");
        named_node(&mut v, "c_direct", "greet", "CALL", "app.ts");

        // A1 aliased: import { orig as renamed } — legacy already disambiguated.
        named_node(&mut v, "f_orig", "orig", "FUNCTION", "greet.ts");
        named_node(&mut v, "b_renamed", "renamed", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "b_renamed", "f_orig", "IMPORTS_FROM");
        named_node(&mut v, "c_aliased", "renamed", "CALL", "app.ts");

        // A1 default: import Foo from './foo' — endpoint is the EXPORT "default"
        // node (the legacy resolver's own endpoint, parity).
        named_node(&mut v, "e_def_foo", "default", "EXPORT", "foo.ts");
        named_node(&mut v, "b_foo", "Foo", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "b_foo", "e_def_foo", "IMPORTS_FROM");
        named_node(&mut v, "c_default", "Foo", "CALL", "app.ts");

        // Namespace binding: import * as utils — edge to the MODULE node.
        named_node(&mut v, "b_ns", "utils", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "b_ns", "m_utils", "IMPORTS_FROM");
        // A1 negative (DELTA 3 guard): dotless call on the namespace binding.
        named_node(&mut v, "c_nsdirect", "utils", "CALL", "app.ts");

        // A2: namespace member calls.
        named_node(&mut v, "c_ns", "utils.helper", "CALL", "app.ts");
        named_node(&mut v, "c_nsdef", "utils.default", "CALL", "app.ts");
        named_node(&mut v, "c_nsdup", "utils.dup", "CALL", "app.ts");
        named_node(&mut v, "c_md", "utils.a.b", "CALL", "app.ts"); // multi-dot pin
        named_node(&mut v, "c_barrel", "utils.fromBarrel", "CALL", "app.ts"); // DELTA 4
        named_node(&mut v, "c_nsmiss", "utils.missing", "CALL", "app.ts");
        named_node(&mut v, "c_nobind", "other.helper", "CALL", "app.ts");

        // Negatives: not a binding; the file gate (.rs shape).
        named_node(&mut v, "c_local", "localFn", "CALL", "app.ts");
        named_node(&mut v, "b_rs", "rsfn", "IMPORT_BINDING", "main.rs");
        named_node(&mut v, "f_rs", "rsfn", "FUNCTION", "lib.rs");
        edge(&mut v, "b_rs", "f_rs", "IMPORTS_FROM");
        named_node(&mut v, "c_rs", "rsfn", "CALL", "main.rs");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_CROSS_FILE_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_cross_file_calls.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(c, t)| (id_of(c), id_of(t), "cross-file-calls".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "xf_direct_call"),
            via(&[
                ("c_direct", "f_greet"),
                ("c_aliased", "f_orig"),
                ("c_default", "e_def_foo"),
            ]),
            "A1: plain + aliased + default bindings resolve through the legacy \
             edge; the namespace binding's MODULE target (DELTA 3), non-bindings \
             and the .rs file derive nothing"
        );
        assert_eq!(
            triples(&eval, "xf_ns_call"),
            via(&[
                ("c_ns", "f_helper"),
                ("c_nsdef", "e_def_u"),
                ("c_nsdup", "f_dup1"),
                ("c_nsdup", "f_dup2"),
            ]),
            "A2: exported member, ns.default (the EXPORT node) and BOTH dup \
             exports (DELTA 5); multi-dot 'utils.a.b', the EXPORT_BINDING member \
             (DELTA 4), unknown member and non-binding receiver derive nothing"
        );

        // Both heads are CALLS + additive (shared vocabulary) with resolvedVia.
        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 2, "two CALLS heads (direct + namespace)");
        assert!(
            calls_specs.iter().all(|s| s.additive),
            "CALLS is shared with the analyzers — additive is mandatory"
        );
        assert!(
            calls_specs
                .iter()
                .all(|s| s.meta == vec!["resolvedVia".to_string()]),
            "resolvedVia is projected on both heads"
        );
    }

    /// The bundled js_property_access_ns pack (Wave 1b, hybrid) resolves the
    /// namespace arm of PropertyAccess.hs over the legacy IMPORTS_FROM edges:
    /// - member read via EXPORT -EXPORTS-> decl → READS_FROM (the legacy edge
    ///   type + resolvedVia="property-access");
    /// - ns.default resolves to the EXPORT "default" node;
    /// - DELTA 3 PINNED: duplicate same-name exports derive an edge each;
    /// - negatives: multi-dot "utils.a.b" (concat-equality first-dot parity),
    ///   EXPORT_BINDING member (DELTA 2), unknown member, non-binding receiver,
    ///   dotless PA name, the .rs file gate.
    #[test]
    fn js_property_access_ns_resolves_namespace_members() {
        let mut v = FixtureStorageView::new(1);

        // Target module + exports.
        named_node(&mut v, "m_utils", "utils", "MODULE", "utils.ts");
        named_node(&mut v, "e_named", "named", "EXPORT", "utils.ts");
        named_node(&mut v, "v_config", "config", "VARIABLE", "utils.ts");
        edge(&mut v, "e_named", "v_config", "EXPORTS");
        named_node(&mut v, "e_def", "default", "EXPORT", "utils.ts");
        named_node(&mut v, "eb_x", "x", "EXPORT_BINDING", "utils.ts");
        edge(&mut v, "e_named", "eb_x", "EXPORTS");
        named_node(&mut v, "v_dup1", "dup", "VARIABLE", "utils.ts");
        named_node(&mut v, "v_dup2", "dup", "CONSTANT", "utils.ts");
        edge(&mut v, "e_named", "v_dup1", "EXPORTS");
        edge(&mut v, "e_named", "v_dup2", "EXPORTS");
        named_node(&mut v, "v_b", "b", "VARIABLE", "utils.ts");
        edge(&mut v, "e_named", "v_b", "EXPORTS");

        // Namespace binding in app.ts.
        named_node(&mut v, "b_ns", "utils", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "b_ns", "m_utils", "IMPORTS_FROM");

        // Property accesses.
        named_node(&mut v, "pa_ok", "utils.config", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "pa_def", "utils.default", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "pa_dup", "utils.dup", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "pa_md", "utils.a.b", "PROPERTY_ACCESS", "app.ts"); // multi-dot
        named_node(&mut v, "pa_eb", "utils.x", "PROPERTY_ACCESS", "app.ts"); // DELTA 2
        named_node(&mut v, "pa_miss", "utils.missing", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "pa_nobind", "other.config", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "pa_dotless", "utils", "PROPERTY_ACCESS", "app.ts");

        // File gate: same shape via a .rs file derives nothing.
        named_node(&mut v, "b_rs", "utils", "IMPORT_BINDING", "main.rs");
        edge(&mut v, "b_rs", "m_utils", "IMPORTS_FROM");
        named_node(&mut v, "pa_rs", "utils.config", "PROPERTY_ACCESS", "main.rs");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_PROPERTY_ACCESS_NS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_property_access_ns.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(pa, t)| (id_of(pa), id_of(t), "property-access".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "pa_ns_read"),
            via(&[
                ("pa_ok", "v_config"),
                ("pa_def", "e_def"),
                ("pa_dup", "v_dup1"),
                ("pa_dup", "v_dup2"),
            ]),
            "namespace member, ns.default and BOTH dup exports (DELTA 3) resolve; \
             multi-dot, EXPORT_BINDING member (DELTA 2), unknown member, \
             non-binding receiver, dotless name and .rs file derive nothing"
        );

        // READS_FROM is shared vocabulary — additive, resolvedVia projected.
        let rf_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "READS_FROM")
            .collect();
        assert_eq!(rf_specs.len(), 1, "exactly one READS_FROM head");
        assert!(rf_specs[0].additive, "READS_FROM is shared — additive");
        assert_eq!(rf_specs[0].meta, vec!["resolvedVia".to_string()]);
    }

    /// The bundled js_class_inheritance pack (Wave 2, node_attr) resolves both
    /// arms of ClassInheritance.hs:
    /// - A1 same-file: `class Dog extends Animal`, plus the DELTA-1 superset pin
    ///   (duplicate same-name classes derive an edge each);
    /// - the fall-through gate: a same-file candidate SUPPRESSES the cross-file
    ///   arm even when an import binding of that name exists (resolver parity);
    /// - A2 cross-file: superclass through the binding's committed IMPORTS_FROM
    ///   edge — plain CLASS endpoint and the default-import endpoint (the EXPORT
    ///   "default" node);
    /// - negatives: namespace binding (MODULE target, DELTA 5 guard), a class
    ///   with no superClass metadata, the self-name class (DELTA 2: neq refuses
    ///   the self-edge AND has_local suppresses the cross-file arm), the .rs
    ///   file gate.
    #[test]
    fn js_class_inheritance_same_file_and_cross_file_arms() {
        let mut v = FixtureStorageView::new(1);

        // A1 now scope-walks CONTAINS to the enclosing MODULE binder (gold idiom),
        // not a flat (file,name) match — every file-resident CLASS is contained by
        // its file's MODULE on a real graph, so the fixture wires MODULE -CONTAINS->
        // CLASS for the A1 classes (a.ts, b.ts, g.ts). has_local still uses the flat
        // class_in, so the A2-A4 gates are unchanged.
        named_node(&mut v, "m_a", "a", "MODULE", "a.ts");
        named_node(&mut v, "m_b", "b", "MODULE", "b.ts");
        named_node(&mut v, "m_g", "g", "MODULE", "g.ts");

        // A1 same-file: Dog extends Animal in a.ts; Plain has no superClass.
        named_node(&mut v, "cls_animal", "Animal", "CLASS", "a.ts");
        named_node(&mut v, "cls_dog", "Dog", "CLASS", "a.ts");
        v.put_node_metadata(id_of("cls_dog"), r#"{"superClass":"Animal"}"#);
        named_node(&mut v, "cls_plain", "Plain", "CLASS", "a.ts");
        edge(&mut v, "m_a", "cls_animal", "CONTAINS");
        edge(&mut v, "m_a", "cls_dog", "CONTAINS");
        edge(&mut v, "m_a", "cls_plain", "CONTAINS");

        // Fall-through gate: Cat extends Base — Base exists BOTH same-file and
        // as an import binding; only the same-file edge may derive.
        named_node(&mut v, "cls_base_local", "Base", "CLASS", "b.ts");
        named_node(&mut v, "cls_cat", "Cat", "CLASS", "b.ts");
        v.put_node_metadata(id_of("cls_cat"), r#"{"superClass":"Base"}"#);
        edge(&mut v, "m_b", "cls_base_local", "CONTAINS");
        edge(&mut v, "m_b", "cls_cat", "CONTAINS");
        named_node(&mut v, "b_base", "Base", "IMPORT_BINDING", "b.ts");
        named_node(&mut v, "cls_base_remote", "Base", "CLASS", "base.ts");
        edge(&mut v, "b_base", "cls_base_remote", "IMPORTS_FROM");

        // A2 cross-file: Pup extends RemoteAnimal (imported, no local candidate).
        named_node(&mut v, "cls_pup", "Pup", "CLASS", "c.ts");
        v.put_node_metadata(id_of("cls_pup"), r#"{"superClass":"RemoteAnimal"}"#);
        named_node(&mut v, "b_remote", "RemoteAnimal", "IMPORT_BINDING", "c.ts");
        named_node(&mut v, "cls_remote", "RemoteAnimal", "CLASS", "base.ts");
        edge(&mut v, "b_remote", "cls_remote", "IMPORTS_FROM");

        // A2 default-import endpoint: Kid extends Foo, `import Foo from './foo'`
        // — the legacy edge points at the EXPORT "default" node.
        named_node(&mut v, "cls_kid", "Kid", "CLASS", "d.ts");
        v.put_node_metadata(id_of("cls_kid"), r#"{"superClass":"Foo"}"#);
        named_node(&mut v, "b_foo", "Foo", "IMPORT_BINDING", "d.ts");
        named_node(&mut v, "e_def_foo", "default", "EXPORT", "foo.ts");
        edge(&mut v, "b_foo", "e_def_foo", "IMPORTS_FROM");

        // DELTA 5 guard: NsKid extends NS where NS is a namespace binding
        // (MODULE target) — derives nothing.
        named_node(&mut v, "cls_nskid", "NsKid", "CLASS", "e.ts");
        v.put_node_metadata(id_of("cls_nskid"), r#"{"superClass":"NS"}"#);
        named_node(&mut v, "b_ns", "NS", "IMPORT_BINDING", "e.ts");
        named_node(&mut v, "m_x", "x", "MODULE", "x.ts");
        edge(&mut v, "b_ns", "m_x", "IMPORTS_FROM");

        // DELTA 2: a class whose only same-file name-match is ITSELF — the neq
        // refuses the self-edge and has_local still suppresses the cross-file
        // arm (a binding of the same name exists and must NOT fire).
        named_node(&mut v, "cls_selfish", "Selfish", "CLASS", "f.ts");
        v.put_node_metadata(id_of("cls_selfish"), r#"{"superClass":"Selfish"}"#);
        named_node(&mut v, "b_selfish", "Selfish", "IMPORT_BINDING", "f.ts");
        edge(&mut v, "b_selfish", "cls_remote", "IMPORTS_FROM");

        // DELTA 1: Twin extends Dup with TWO same-file "Dup" classes — both derive.
        named_node(&mut v, "cls_twin", "Twin", "CLASS", "g.ts");
        v.put_node_metadata(id_of("cls_twin"), r#"{"superClass":"Dup"}"#);
        named_node(&mut v, "cls_dup1", "Dup", "CLASS", "g.ts");
        named_node(&mut v, "cls_dup2", "Dup", "CLASS", "g.ts");
        edge(&mut v, "m_g", "cls_twin", "CONTAINS");
        edge(&mut v, "m_g", "cls_dup1", "CONTAINS");
        edge(&mut v, "m_g", "cls_dup2", "CONTAINS");

        // PRECISION (the rework's only semantic gain): a nested class shadowing a
        // top-level same-name superclass. In h.ts, Panel extends Widget: there is a
        // top-level `Widget` (MODULE-contained) AND a nested `Widget` declared
        // inside a function (CONTAINS parent = a SCOPE, NOT the MODULE). The flat
        // (file,name) lookup over-resolved to BOTH Widgets; the MODULE scope-walk
        // binds ONLY the top-level Widget — the nested class is not in the MODULE's
        // CONTAINS set, so it cannot bind a sibling-module reference.
        named_node(&mut v, "m_h", "h", "MODULE", "h.ts");
        named_node(&mut v, "cls_widget_top", "Widget", "CLASS", "h.ts");
        named_node(&mut v, "cls_panel", "Panel", "CLASS", "h.ts");
        v.put_node_metadata(id_of("cls_panel"), r#"{"superClass":"Widget"}"#);
        edge(&mut v, "m_h", "cls_widget_top", "CONTAINS");
        edge(&mut v, "m_h", "cls_panel", "CONTAINS");
        // The shadowing nested Widget — contained by a function SCOPE, not the MODULE.
        named_node(&mut v, "h_fn_scope", "scope", "SCOPE", "h.ts");
        named_node(&mut v, "cls_widget_nested", "Widget", "CLASS", "h.ts");
        edge(&mut v, "h_fn_scope", "cls_widget_nested", "CONTAINS");

        // File gate: the same shape in a .rs file derives nothing.
        named_node(&mut v, "cls_rs_animal", "RsAnimal", "CLASS", "main.rs");
        named_node(&mut v, "cls_rs_dog", "RsDog", "CLASS", "main.rs");
        v.put_node_metadata(id_of("cls_rs_dog"), r#"{"superClass":"RsAnimal"}"#);

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_CLASS_INHERITANCE_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_class_inheritance.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(c, t)| (id_of(c), id_of(t), "class-inheritance".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "ext_same_file"),
            via(&[
                ("cls_dog", "cls_animal"),
                ("cls_cat", "cls_base_local"),
                ("cls_twin", "cls_dup1"),
                ("cls_twin", "cls_dup2"),
                // PRECISION: Panel binds ONLY the MODULE-contained top-level Widget,
                // NOT the function-nested Widget (the scope-walk's semantic gain).
                ("cls_panel", "cls_widget_top"),
            ]),
            "A1: same-file superclass resolved by MODULE scope-walk (+ DELTA 1 both \
             duplicates); the self-name class (neq), the no-superClass class and the \
             .rs file derive nothing; a function-nested same-name class does NOT bind"
        );
        assert_eq!(
            triples(&eval, "ext_cross_file"),
            via(&[("cls_pup", "cls_remote"), ("cls_kid", "e_def_foo")]),
            "A2: imported superclass via the binding's IMPORTS_FROM edge (CLASS \
             and EXPORT-default endpoints); the same-file candidate suppresses \
             the arm (Cat, Selfish) and the namespace binding's MODULE target \
             (DELTA 5) derives nothing"
        );

        // All five heads materialize the SHARED type EXTENDS — additive + resolvedVia.
        let ext_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "EXTENDS").collect();
        assert_eq!(
            ext_specs.len(),
            5,
            "five EXTENDS heads (same-file + cross-file + chain + builtin-import + builtin-global)"
        );
        assert!(
            ext_specs.iter().all(|s| s.additive),
            "EXTENDS is shared (shape-tracker also emits it) — additive is mandatory"
        );
        assert!(
            ext_specs
                .iter()
                .all(|s| s.meta == vec!["resolvedVia".to_string()]),
            "resolvedVia is projected on all heads"
        );
        // The Wave-2b arms stay silent on this fixture: no <builtin> classes, no
        // binding metadata, no CONTAINS/RE_EXPORTS seams.
        assert!(triples(&eval, "ext_chain").is_empty());
        assert!(triples(&eval, "ext_builtin_import").is_empty());
        assert!(triples(&eval, "ext_builtin_global").is_empty());
    }

    /// The bundled kotlin_inheritance pack derives EXTENDS/IMPLEMENTS from the
    /// kotlin-analyzer's CLASS metadata stamps (`extends` + `implements_0..n`,
    /// the EXACT shapes the analyzer emits — verified e2e against the live
    /// kotlin-parser → analyzer pipeline, see the `.dl` header):
    /// - same-file extends / implements (`kt_ext_file` / `kt_impl_file`);
    /// - same-directory fall-through arms (`kt_ext_dir` / `kt_impl_dir`) —
    ///   fire only with NO same-file candidate;
    /// - the DELTA-2 recovery arms (`kt_ext_rec_*`): an implements_N stamp
    ///   resolving to a NON-interface (the bare no-primary-ctor class
    ///   supertype) derives EXTENDS;
    /// - the DELTA-8 sealed refusal: `sealed interface` serializes
    ///   kind="sealed" (parser cascade checks isSealed before isInterface),
    ///   so a bare entry naming a sealed declaration derives NOTHING from the
    ///   recovery arms (was: silent wrong EXTENDS toward an interface), while
    ///   a ctor-call `: SealedClass()` (the `extends` stamp) still derives
    ///   EXTENDS — kt_ext_file/dir carry no kind guard;
    /// - the \+ ambig discipline (same-file and same-dir duplicate names skip);
    /// - negatives: self-edge refusal, out-of-directory scope (SUBSET DELTA 1),
    ///   the .kt/.kts file gate.
    #[test]
    fn kotlin_inheritance_arms_on_analyzer_stamp_shapes() {
        let mut v = FixtureStorageView::new(1);
        let dir_a = "src/main/kotlin/com/ex"; // shared directory ("package")

        // a.kt: Greeter (interface), Base, Simple : Base(),
        //       Multi : Base(), Greeter, Closer (Closer lives in b.kt),
        //       object Singleton : Base(), Greeter
        let a = format!("{dir_a}/a.kt");
        named_node(&mut v, "kt_greeter", "Greeter", "CLASS", &a);
        v.put_node_metadata(id_of("kt_greeter"), r#"{"kind":"interface"}"#);
        named_node(&mut v, "kt_base", "Base", "CLASS", &a);
        v.put_node_metadata(id_of("kt_base"), r#"{"kind":"class"}"#);
        named_node(&mut v, "kt_simple", "Simple", "CLASS", &a);
        v.put_node_metadata(id_of("kt_simple"), r#"{"kind":"class","extends":"Base"}"#);
        named_node(&mut v, "kt_multi", "Multi", "CLASS", &a);
        v.put_node_metadata(
            id_of("kt_multi"),
            r#"{"kind":"class","extends":"Base","implements_0":"Greeter","implements_1":"Closer"}"#,
        );
        named_node(&mut v, "kt_singleton", "Singleton", "CLASS", &a);
        v.put_node_metadata(
            id_of("kt_singleton"),
            r#"{"kind":"object","singleton":true,"extends":"Base","implements_0":"Greeter"}"#,
        );

        // b.kt (same directory): Closer (interface), Helper,
        //       NoCtorDerived : Base   (bare entry → implements_0, Base is a
        //                               CLASS in a.kt → EXTENDS recovery, dir arm)
        //       NoCtor2 : Helper       (bare entry, same-file non-interface →
        //                               EXTENDS recovery, file arm)
        //       DirExt : Simple()      (extends, candidate only in a.kt → dir arm)
        let b = format!("{dir_a}/b.kt");
        named_node(&mut v, "kt_closer", "Closer", "CLASS", &b);
        v.put_node_metadata(id_of("kt_closer"), r#"{"kind":"interface"}"#);
        named_node(&mut v, "kt_helper", "Helper", "CLASS", &b);
        v.put_node_metadata(id_of("kt_helper"), r#"{"kind":"class"}"#);
        named_node(&mut v, "kt_noctor", "NoCtorDerived", "CLASS", &b);
        v.put_node_metadata(id_of("kt_noctor"), r#"{"kind":"class","implements_0":"Base"}"#);
        named_node(&mut v, "kt_noctor2", "NoCtor2", "CLASS", &b);
        v.put_node_metadata(id_of("kt_noctor2"), r#"{"kind":"class","implements_0":"Helper"}"#);
        named_node(&mut v, "kt_dirext", "DirExt", "CLASS", &b);
        v.put_node_metadata(id_of("kt_dirext"), r#"{"kind":"class","extends":"Simple"}"#);

        // Ambiguity (DELTA 3): c.kt has TWO classes "Dup" — Twin : Dup() skips
        // (same-file ambig; the dir arm is suppressed by the same-file
        // candidates). "DD" exists once in a.kt and once in b.kt — DDX : DD()
        // in c.kt has no same-file candidate and the DIR index is ambiguous.
        let c = format!("{dir_a}/c.kt");
        named_node(&mut v, "kt_dup1", "Dup", "CLASS", &c);
        named_node(&mut v, "kt_dup2", "Dup", "CLASS", &c);
        named_node(&mut v, "kt_twin", "Twin", "CLASS", &c);
        v.put_node_metadata(id_of("kt_twin"), r#"{"kind":"class","extends":"Dup"}"#);
        named_node(&mut v, "kt_dd_a", "DD", "CLASS", &a);
        named_node(&mut v, "kt_dd_b", "DD", "CLASS", &b);
        named_node(&mut v, "kt_ddx", "DDX", "CLASS", &c);
        v.put_node_metadata(id_of("kt_ddx"), r#"{"kind":"class","extends":"DD"}"#);

        // Self-edge refusal: Selfy : Selfy — the only candidate is itself.
        named_node(&mut v, "kt_selfy", "Selfy", "CLASS", &c);
        v.put_node_metadata(id_of("kt_selfy"), r#"{"kind":"class","extends":"Selfy"}"#);

        // DELTA 8 — sealed targets. `sealed interface Event` and
        // `sealed class State` BOTH serialize kind="sealed" (the parser's
        // isSealed-before-isInterface cascade): bare entries naming them are
        // unclassifiable and the recovery arms refuse them.
        // a.kt: Event (sealed interface), State (sealed class),
        //       Click : Event   (bare → implements_0, sealed target, SAME
        //                        file → kt_ext_rec_file must NOT fire)
        named_node(&mut v, "kt_event", "Event", "CLASS", &a);
        v.put_node_metadata(id_of("kt_event"), r#"{"kind":"sealed","sealed":true}"#);
        named_node(&mut v, "kt_state", "State", "CLASS", &a);
        v.put_node_metadata(id_of("kt_state"), r#"{"kind":"sealed","sealed":true}"#);
        named_node(&mut v, "kt_click", "Click", "CLASS", &a);
        v.put_node_metadata(id_of("kt_click"), r#"{"kind":"class","implements_0":"Event"}"#);
        // b.kt: Render : Event   (bare, sealed target in a.kt → the DIR
        //                         recovery arm must NOT fire either)
        //       Loading : State() (ctor-call → `extends` stamp; sealed CLASS
        //                          target still derives EXTENDS via the dir
        //                          arm — DELTA 8 does not touch kt_ext_*)
        named_node(&mut v, "kt_render", "Render", "CLASS", &b);
        v.put_node_metadata(id_of("kt_render"), r#"{"kind":"class","implements_0":"Event"}"#);
        named_node(&mut v, "kt_loading", "Loading", "CLASS", &b);
        v.put_node_metadata(id_of("kt_loading"), r#"{"kind":"class","extends":"State"}"#);

        // Scope bound (SUBSET DELTA 1): Far : Base() in another directory —
        // Base is out of scope, no edge.
        named_node(&mut v, "kt_far", "Far", "CLASS", "other/pkg/far.kt");
        v.put_node_metadata(id_of("kt_far"), r#"{"kind":"class","extends":"Base"}"#);

        // File gate: the same stamp shape in a .rs file derives nothing.
        named_node(&mut v, "rs_base", "RsBase", "CLASS", "src/x.rs");
        named_node(&mut v, "rs_child", "RsChild", "CLASS", "src/x.rs");
        v.put_node_metadata(id_of("rs_child"), r#"{"kind":"class","extends":"RsBase"}"#);

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            KOTLIN_INHERITANCE_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("kotlin_inheritance.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(s, t)| (id_of(s), id_of(t), "kotlin-inheritance".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "kt_ext_file"),
            via(&[
                ("kt_simple", "kt_base"),
                ("kt_multi", "kt_base"),
                ("kt_singleton", "kt_base"),
            ]),
            "same-file extends; Twin (ambig Dup), Selfy (self-edge), Far \
             (out of scope) and the .rs shape derive nothing"
        );
        assert_eq!(
            triples(&eval, "kt_ext_dir"),
            via(&[("kt_dirext", "kt_simple"), ("kt_loading", "kt_state")]),
            "directory fall-through extends; the ctor-call `extends` stamp \
             reaches a SEALED CLASS target (DELTA 8 guards only the recovery \
             arms); DDX skips (dir-ambiguous DD), same-file candidates \
             suppress the arm everywhere else"
        );
        assert_eq!(
            triples(&eval, "kt_impl_file"),
            via(&[("kt_multi", "kt_greeter"), ("kt_singleton", "kt_greeter")]),
            "same-file implements_N resolving to kind=interface"
        );
        assert_eq!(
            triples(&eval, "kt_impl_dir"),
            via(&[("kt_multi", "kt_closer")]),
            "directory fall-through implements (Closer lives in b.kt)"
        );
        assert_eq!(
            triples(&eval, "kt_ext_rec_file"),
            via(&[("kt_noctor2", "kt_helper")]),
            "DELTA 2 recovery, same file: bare class supertype stamped as \
             implements_0 re-classified to EXTENDS by the target's kind; \
             Click : Event (sealed target, same file) derives NOTHING — \
             DELTA 8 refuses kind=sealed in the recovery arms"
        );
        assert_eq!(
            triples(&eval, "kt_ext_rec_dir"),
            via(&[("kt_noctor", "kt_base")]),
            "DELTA 2 recovery, directory fall-through; Render : Event \
             (sealed target in a.kt) derives NOTHING — DELTA 8 dir arm"
        );
        // DELTA 8 cross-check: the sealed-interface bare entries derive no
        // IMPLEMENTS either (kind=sealed ≠ kind=interface), so Click/Render
        // carry ZERO inheritance edges — a documented gap, not a wrong edge.
        for rel in ["kt_impl_file", "kt_impl_dir", "kt_ext_file"] {
            assert!(
                !triples(&eval, rel)
                    .iter()
                    .any(|(s, _, _)| *s == id_of("kt_click") || *s == id_of("kt_render")),
                "{rel} must not derive for the sealed-interface implementors"
            );
        }

        // Heads: 4 EXTENDS + 2 IMPLEMENTS, all additive (shared vocabulary),
        // resolvedVia projected on all.
        let ext: Vec<_> = specs.iter().filter(|s| s.edge_type == "EXTENDS").collect();
        assert_eq!(ext.len(), 4, "EXTENDS heads: file + dir + 2 recovery arms");
        let imp: Vec<_> = specs.iter().filter(|s| s.edge_type == "IMPLEMENTS").collect();
        assert_eq!(imp.len(), 2, "IMPLEMENTS heads: file + dir arms");
        assert!(
            specs.iter().all(|s| s.additive),
            "EXTENDS/IMPLEMENTS are shared vocabulary — additive is mandatory"
        );
        assert!(
            specs
                .iter()
                .all(|s| s.meta == vec!["resolvedVia".to_string()]),
            "resolvedVia is projected on all heads"
        );
    }

    /// The bundled js_import_bindings pack (Wave 2, node_attr) resolves the
    /// named/aliased/default binding arms that Wave 1 held back, through the
    /// parent IMPORT's legacy IMPORTS_FROM → MODULE seam:
    /// - named `import {helper}` and aliased `import {helper as h2}` both match
    ///   the target's exports by importedName;
    /// - THE WAVE-1 TRAP PINNED: a binding whose LOCAL name matches an export
    ///   but whose importedName does not (aliased trap) derives NOTHING — no
    ///   false positive;
    /// - default `import Foo` → the EXPORT "default" node (resolver endpoint);
    /// - EXPORT_BINDING targets by exportedName: `export { foo }` (plain) and
    ///   `export { orig as renamed }` matched by "renamed" NOT "orig";
    /// - B3 namespace (Wave 3c): `import * as utils` (IN="*") resolves to the
    ///   parent IMPORT's MODULE through the b_mod seam (the legacy arm,
    ///   ImportResolution.hs:316-319 — owned by the pack now that legacy
    ///   import-resolution is gated);
    /// - negatives: re-export EXPORT_BINDING (DELTA 1 subset — Wave 2b), an
    ///   IMPORT with no resolved MODULE edge, the .rs file gate.
    #[test]
    fn js_import_bindings_named_aliased_default_arms() {
        let mut v = FixtureStorageView::new(1);

        // Target module utils.ts and its exports.
        named_node(&mut v, "m_utils", "utils", "MODULE", "utils.ts");
        named_node(&mut v, "e_named", "named", "EXPORT", "utils.ts");
        named_node(&mut v, "f_helper", "helper", "FUNCTION", "utils.ts");
        edge(&mut v, "e_named", "f_helper", "EXPORTS");
        named_node(&mut v, "e_def", "default", "EXPORT", "utils.ts");
        // Local export binding `export { foo }` (exportedName == name).
        named_node(&mut v, "eb_local", "foo", "EXPORT_BINDING", "utils.ts");
        v.put_node_metadata(id_of("eb_local"), r#"{"exportedName":"foo"}"#);
        edge(&mut v, "e_named", "eb_local", "EXPORTS");
        // Aliased export binding `export { orig as renamed }`.
        named_node(&mut v, "eb_alias", "orig", "EXPORT_BINDING", "utils.ts");
        v.put_node_metadata(id_of("eb_alias"), r#"{"exportedName":"renamed"}"#);
        edge(&mut v, "e_named", "eb_alias", "EXPORTS");
        // Re-export binding `export { x } from './other'` — DELTA 1: excluded.
        named_node(&mut v, "eb_re", "x", "EXPORT_BINDING", "utils.ts");
        v.put_node_metadata(id_of("eb_re"), r#"{"exportedName":"x","source":"./other"}"#);
        edge(&mut v, "e_named", "eb_re", "EXPORTS");

        // The importer: IMPORT './utils' resolved by legacy to m_utils.
        named_node(&mut v, "i_app", "./utils", "IMPORT", "app.ts");
        edge(&mut v, "i_app", "m_utils", "IMPORTS_FROM");
        let bind = |v: &mut FixtureStorageView, sid: &str, local: &str, imported: &str| {
            named_node(v, sid, local, "IMPORT_BINDING", "app.ts");
            v.put_node_metadata(
                id_of(sid),
                &format!(r#"{{"importedName":"{imported}"}}"#),
            );
            edge(v, "i_app", sid, "CONTAINS");
        };
        bind(&mut v, "b_named", "helper", "helper"); // import { helper }
        bind(&mut v, "b_aliased", "h2", "helper"); // import { helper as h2 }
        bind(&mut v, "b_trap", "helper", "nothere"); // localName matches, IN doesn't
        bind(&mut v, "b_default", "Foo", "default"); // import Foo
        bind(&mut v, "b_ns", "utils", "*"); // import * as utils — B3 → MODULE
        bind(&mut v, "b_eb", "fooLocal", "foo"); // → EXPORT_BINDING by exportedName
        bind(&mut v, "b_eb_alias", "r", "renamed"); // → aliased EXPORT_BINDING
        bind(&mut v, "b_orig", "o", "orig"); // exported name is "renamed" — miss
        bind(&mut v, "b_re", "x", "x"); // re-export binding — DELTA 1, miss

        // An unresolved import (no IMPORTS_FROM → MODULE edge): no rows.
        named_node(&mut v, "i_miss", "./missing", "IMPORT", "app.ts");
        named_node(&mut v, "b_unres", "gone", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(id_of("b_unres"), r#"{"importedName":"gone"}"#);
        edge(&mut v, "i_miss", "b_unres", "CONTAINS");

        // File gate: the full shape in a .rs file derives nothing.
        named_node(&mut v, "i_rs", "crate::u", "IMPORT", "main.rs");
        edge(&mut v, "i_rs", "m_utils", "IMPORTS_FROM");
        named_node(&mut v, "b_rs", "helper", "IMPORT_BINDING", "main.rs");
        v.put_node_metadata(id_of("b_rs"), r#"{"importedName":"helper"}"#);
        edge(&mut v, "i_rs", "b_rs", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_IMPORT_BINDINGS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_import_bindings.dl evaluates");

        let pairs: BTreeSet<(u128, u128)> = eval
            .facts("binding_import")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("arg0 id"),
                    row[1].as_id().expect("arg1 id"),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            BTreeSet::from([
                (id_of("b_named"), id_of("f_helper")),
                (id_of("b_aliased"), id_of("f_helper")),
                (id_of("b_default"), id_of("e_def")),
                (id_of("b_eb"), id_of("eb_local")),
                (id_of("b_eb_alias"), id_of("eb_alias")),
            ]),
            "named + aliased by importedName, default → the EXPORT node, \
             EXPORT_BINDINGs by exportedName; the localName trap, the namespace \
             binding (B3's head, not this one), importing the pre-alias name, \
             the re-export binding (DELTA 1), the unresolved import and the \
             .rs file derive NOTHING"
        );

        // B3 namespace: the `import * as utils` binding → the parent IMPORT's
        // MODULE (Wave 3c); the .rs namespace shape and unresolved imports stay out.
        let ns_pairs: BTreeSet<(u128, u128)> = eval
            .facts("binding_ns")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("arg0 id"),
                    row[1].as_id().expect("arg1 id"),
                )
            })
            .collect();
        assert_eq!(
            ns_pairs,
            BTreeSet::from([(id_of("b_ns"), id_of("m_utils"))]),
            "B3: exactly the namespace binding resolves to its parent's MODULE"
        );

        // IMPORTS_FROM is shared vocabulary — additive; legacy edges carry
        // empty metadata, so no meta columns (exact parity). Two heads since
        // Wave 3c: binding_import (B1/B2) + binding_ns (B3).
        let if_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "IMPORTS_FROM")
            .collect();
        assert_eq!(if_specs.len(), 2, "two IMPORTS_FROM heads (B1/B2 + B3)");
        assert!(
            if_specs.iter().all(|s| s.additive),
            "IMPORTS_FROM is shared — additive"
        );
        assert!(
            if_specs.iter().all(|s| s.meta.is_empty()),
            "legacy binding edges carry empty metadata — no meta columns"
        );
    }

    /// The bundled js_property_access_full pack (Wave 2, node_attr) resolves the
    /// remaining PropertyAccess.hs arms (the ns arm lives in its own pack):
    /// - C1 this/super/<obj>: enclosing class via the SCOPE chain (direct and
    ///   nested scopes), member via HAS_METHOD;
    /// - C1 PROPERTY_ASSIGNMENT members via node_attr className (spec parity);
    /// - C2 ClassName.staticProp: uppercase receiver, same-file class;
    /// - negatives: member not on the class, a read outside any method scope
    ///   (DELTA 2b), lowercase receiver, receiver class in another file, a read
    ///   with NO base metadata, the .rs file gate.
    #[test]
    fn js_property_access_full_this_and_static_arms() {
        let mut v = FixtureStorageView::new(1);

        // class Widget { render(); helper(); create(); } in app.ts.
        named_node(&mut v, "cls_w", "Widget", "CLASS", "app.ts");
        named_node(&mut v, "m_render", "render", "METHOD", "app.ts");
        named_node(&mut v, "m_helper", "helper", "METHOD", "app.ts");
        named_node(&mut v, "m_create", "create", "METHOD", "app.ts");
        edge(&mut v, "cls_w", "m_render", "HAS_METHOD");
        edge(&mut v, "cls_w", "m_helper", "HAS_METHOD");
        edge(&mut v, "cls_w", "m_create", "HAS_METHOD");
        // render's body scope + a nested (block) scope inside it.
        named_node(&mut v, "s_m", "s_m", "SCOPE", "app.ts");
        edge(&mut v, "m_render", "s_m", "HAS_SCOPE");
        named_node(&mut v, "s_inner", "s_inner", "SCOPE", "app.ts");
        edge(&mut v, "s_m", "s_inner", "HAS_SCOPE");
        // A PROPERTY_ASSIGNMENT member keyed by className metadata (spec parity).
        named_node(&mut v, "p_cfg", "config", "PROPERTY_ASSIGNMENT", "app.ts");
        v.put_node_metadata(id_of("p_cfg"), r#"{"className":"Widget"}"#);

        let pa = |v: &mut FixtureStorageView, sid: &str, name: &str, file: &str, base: &str| {
            named_node(v, sid, name, "PROPERTY_ACCESS", file);
            v.put_node_metadata(id_of(sid), &format!(r#"{{"base":"{base}"}}"#));
        };
        // C1: this/super/<obj> reads inside render's scope (+ one nested).
        pa(&mut v, "pa_this", "helper", "app.ts", "this");
        edge(&mut v, "s_m", "pa_this", "CONTAINS");
        pa(&mut v, "pa_super", "render", "app.ts", "super");
        edge(&mut v, "s_m", "pa_super", "CONTAINS");
        pa(&mut v, "pa_obj", "helper", "app.ts", "<obj>");
        edge(&mut v, "s_m", "pa_obj", "CONTAINS");
        pa(&mut v, "pa_nested", "helper", "app.ts", "this");
        edge(&mut v, "s_inner", "pa_nested", "CONTAINS");
        pa(&mut v, "pa_this_cfg", "config", "app.ts", "this");
        edge(&mut v, "s_m", "pa_this_cfg", "CONTAINS");
        // C1 negatives: unknown member; a read in a scope with no method owner.
        pa(&mut v, "pa_miss", "nope", "app.ts", "this");
        edge(&mut v, "s_m", "pa_miss", "CONTAINS");
        named_node(&mut v, "s_top", "s_top", "SCOPE", "app.ts");
        pa(&mut v, "pa_orphan", "helper", "app.ts", "this");
        edge(&mut v, "s_top", "pa_orphan", "CONTAINS");

        // C2: static reads via the uppercase receiver.
        pa(&mut v, "pa_static", "create", "app.ts", "Widget");
        pa(&mut v, "pa_cfg", "config", "app.ts", "Widget");
        // C2 negatives: lowercase receiver; receiver class lives in another file.
        pa(&mut v, "pa_lower", "create", "app.ts", "widget");
        pa(&mut v, "pa_otherfile", "create", "b.ts", "Widget");
        // No base metadata at all → not a receiver read.
        named_node(&mut v, "pa_nobase", "helper", "PROPERTY_ACCESS", "app.ts");

        // File gate: the full static shape in a .rs file derives nothing.
        named_node(&mut v, "cls_rs", "Widget", "CLASS", "main.rs");
        named_node(&mut v, "m_rs", "create", "METHOD", "main.rs");
        edge(&mut v, "cls_rs", "m_rs", "HAS_METHOD");
        pa(&mut v, "pa_rs", "create", "main.rs", "Widget");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_PROPERTY_ACCESS_FULL_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_property_access_full.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(pa, t)| (id_of(pa), id_of(t), "property-access".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "pa_this_read"),
            via(&[
                ("pa_this", "m_helper"),
                ("pa_super", "m_render"),
                ("pa_obj", "m_helper"),
                ("pa_nested", "m_helper"),
                ("pa_this_cfg", "p_cfg"),
            ]),
            "C1: this/super/<obj> members via the scope chain (direct + nested) \
             and the PROPERTY_ASSIGNMENT/className member; the unknown member \
             and the ownerless scope (DELTA 2b) derive nothing"
        );
        assert_eq!(
            triples(&eval, "pa_static_read"),
            via(&[("pa_static", "m_create"), ("pa_cfg", "p_cfg")]),
            "C2: uppercase same-file receiver via HAS_METHOD and via the \
             className-metadata index; lowercase receiver, cross-file receiver, \
             baseless read and the .rs file derive nothing"
        );

        // Both heads materialize the SHARED type READS_FROM — additive + resolvedVia.
        let rf_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "READS_FROM")
            .collect();
        assert_eq!(rf_specs.len(), 2, "two READS_FROM heads (this + static)");
        assert!(
            rf_specs.iter().all(|s| s.additive),
            "READS_FROM is shared — additive is mandatory"
        );
        assert!(
            rf_specs
                .iter()
                .all(|s| s.meta == vec!["resolvedVia".to_string()]),
            "resolvedVia is projected on both heads"
        );
    }

    // ── Rust Wave-2 pack tests (rust_trait_resolve / rust_receiver_typing) ──

    /// The bundled rust_trait_resolve pack (Wave 2) reproduces the WHOLE
    /// RustTraitResolution.hs resolver with every gate and policy pinned:
    /// - happy path: `impl Tag for Widget` — IMPL_BLOCK metadata["trait"]
    ///   (node_attr) + STRUCT by name → IMPLEMENTS;
    /// - DELTA 3 REMOVED (review): rust_analyzer.rs emits no CLASS (grep
    ///   '"CLASS"' = 0) — the CLASS arm could only match foreign classes, so
    ///   it is gone and the name indexes are .rs-gated: a JS CLASS, a C++
    ///   STRUCT and a PHP TRAIT shaped exactly like the happy path derive
    ///   nothing;
    /// - DELTA 1: single-hop crate-local qualified ref ("crate::Tag") resolves
    ///   via the strip_prefix arm;
    /// - DELTA 2 PINNED (subset): multi-segment local ref ("crate::tags::Tag")
    ///   derives nothing;
    /// - POLICY PINNED (zero false positives): "std::error::Error" and
    ///   "fmt::Display" derive nothing even though same-named LOCAL traits
    ///   exist — external/unproven roots never match bare segments;
    /// - inherent impl (no trait metadata), unknown trait name, self type with
    ///   no STRUCT/CLASS node, and the non-.rs file gate derive nothing;
    /// - DELTA 4 PINNED (superset): duplicate same-named STRUCTs — an edge per
    ///   candidate.
    #[test]
    fn rust_trait_resolve_emits_implements_for_trait_impls() {
        let mut v = FixtureStorageView::new(1);

        // The trait + the self types.
        named_node(&mut v, "t_tag", "Tag", "TRAIT", "tags.rs");
        named_node(&mut v, "s_w", "Widget", "STRUCT", "widget.rs");

        // Happy path: impl Tag for Widget.
        named_node(&mut v, "ib_w", "Widget", "IMPL_BLOCK", "widget.rs");
        v.put_node_metadata(id_of("ib_w"), r#"{"trait":"Tag"}"#);

        // Polyglot false-positive pins (review fix): same-named declarations
        // from OTHER languages must never satisfy a Rust impl. A JS class
        // Widget (rust_analyzer.rs emits no CLASS — only foreign analyzers
        // do), a C++ STRUCT Widget (cpp-analyzer DataTypes.hs:109-115) and a
        // PHP trait Tag all match ib_w by name; the .rs gates reject them.
        named_node(&mut v, "c_js", "Widget", "CLASS", "widget.js");
        named_node(&mut v, "s_cpp", "Widget", "STRUCT", "widget.cpp");
        named_node(&mut v, "t_php", "Tag", "TRAIT", "tag.php");

        // DELTA 1: crate-local single-hop qualified ref.
        named_node(&mut v, "s_d", "Doohickey", "STRUCT", "d.rs");
        named_node(&mut v, "ib_d", "Doohickey", "IMPL_BLOCK", "d.rs");
        v.put_node_metadata(id_of("ib_d"), r#"{"trait":"crate::Tag"}"#);

        // DELTA 2 (subset pin): multi-segment local ref strips to "tags::Tag",
        // which names no TRAIT — nothing, never a bare-segment match.
        named_node(&mut v, "s_m", "Multi", "STRUCT", "m.rs");
        named_node(&mut v, "ib_m", "Multi", "IMPL_BLOCK", "m.rs");
        v.put_node_metadata(id_of("ib_m"), r#"{"trait":"crate::tags::Tag"}"#);

        // POLICY pins: same-named LOCAL traits exist, but external/unproven
        // roots must not match them.
        named_node(&mut v, "t_err", "Error", "TRAIT", "errors.rs");
        named_node(&mut v, "s_e", "MyErr", "STRUCT", "e.rs");
        named_node(&mut v, "ib_e", "MyErr", "IMPL_BLOCK", "e.rs");
        v.put_node_metadata(id_of("ib_e"), r#"{"trait":"std::error::Error"}"#);
        named_node(&mut v, "t_disp", "Display", "TRAIT", "disp.rs");
        named_node(&mut v, "s_p", "Pretty", "STRUCT", "p.rs");
        named_node(&mut v, "ib_p", "Pretty", "IMPL_BLOCK", "p.rs");
        v.put_node_metadata(id_of("ib_p"), r#"{"trait":"fmt::Display"}"#);

        // Inherent impl: no trait metadata — nothing.
        named_node(&mut v, "ib_inh", "Widget", "IMPL_BLOCK", "widget.rs");

        // Unknown trait name — nothing.
        named_node(&mut v, "s_u", "Unmatched", "STRUCT", "u.rs");
        named_node(&mut v, "ib_u", "Unmatched", "IMPL_BLOCK", "u.rs");
        v.put_node_metadata(id_of("ib_u"), r#"{"trait":"Nope"}"#);

        // Self type with no STRUCT/CLASS node (impl for an external type).
        named_node(&mut v, "ib_x", "String", "IMPL_BLOCK", "x.rs");
        v.put_node_metadata(id_of("ib_x"), r#"{"trait":"Tag"}"#);

        // File gate: identical shape in a .ts file — nothing.
        named_node(&mut v, "s_ts", "TsThing", "STRUCT", "app.ts");
        named_node(&mut v, "ib_ts", "TsThing", "IMPL_BLOCK", "app.ts");
        v.put_node_metadata(id_of("ib_ts"), r#"{"trait":"Tag"}"#);

        // DELTA 4 (superset pin): a second STRUCT named Widget in another file.
        named_node(&mut v, "s_w2", "Widget", "STRUCT", "widget2.rs");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_TRAIT_RESOLVE_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_trait_resolve.dl evaluates");

        let mut pairs: BTreeSet<(u128, u128)> = BTreeSet::new();
        for row in eval.facts("rust_implements") {
            pairs.insert((
                row[0].as_id().expect("arg0 id"),
                row[1].as_id().expect("arg1 id"),
            ));
        }
        assert_eq!(
            pairs,
            BTreeSet::from([
                (id_of("s_w"), id_of("t_tag")),
                (id_of("s_w2"), id_of("t_tag")),
                (id_of("s_d"), id_of("t_tag")),
            ]),
            "STRUCT + dup STRUCT (DELTA 4) + crate-local qualified (DELTA 1) \
             implement Tag; multi-segment local (DELTA 2), std::/module-relative \
             refs (policy), inherent impl, unknown trait, external self type, \
             .ts file, and foreign-language CLASS/STRUCT/TRAIT (.js/.cpp/.php \
             name twins) derive nothing"
        );

        // IMPLEMENTS is shared with the legacy resolver — additive, no meta
        // columns (legacy metadata was empty).
        let impl_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "IMPLEMENTS")
            .collect();
        assert_eq!(impl_specs.len(), 1, "exactly one IMPLEMENTS head");
        assert!(impl_specs[0].additive, "IMPLEMENTS is shared — additive");
        assert!(
            impl_specs[0].meta.is_empty(),
            "no meta columns — legacy metadata was empty"
        );
    }

    /// The bundled rust_receiver_typing pack (Wave 2) reproduces the
    /// typeAnnotation (arm A) + returnType (arm B) receiver-typing arms of
    /// RustCrossMethodCalls.hs with every gate and delta pinned:
    /// - arm A exact via REFERENCE deref and via a direct declaration;
    /// - arm A strip arm: "crate::widget::Widget" (full depth) resolves with
    ///   the RAW surface as receiverType;
    /// - POLICY PINNED: "std::widget::Widget" derives nothing (external root);
    /// - DELTA 6: "dyn Widget" derives nothing (dyn dispatch is not this pack);
    /// - DELTA 5: a "Vec"-annotated receiver (the analyzer's surface for
    ///   Vec<Foo>) resolves to the local impl Vec member;
    /// - arm B: init CALL with a committed CALLS edge (the rust_calls EDB
    ///   seam) to a FUNCTION carrying returnType — resolves; an UNRESOLVED
    ///   init derives nothing; returnType "Self" derives nothing (DELTA 6);
    /// - method name missing on the impl and the non-.rs file gate derive
    ///   nothing.
    #[test]
    fn rust_receiver_typing_resolves_annotation_and_return_types() {
        let mut v = FixtureStorageView::new(1);

        // impl Widget { fn render() } + impl Vec { fn push() }.
        named_node(&mut v, "ib_w", "Widget", "IMPL_BLOCK", "widget.rs");
        named_node(&mut v, "f_render", "render", "FUNCTION", "widget.rs");
        edge(&mut v, "ib_w", "f_render", "HAS_METHOD");
        named_node(&mut v, "ib_v", "Vec", "IMPL_BLOCK", "vec.rs");
        named_node(&mut v, "f_push", "push", "FUNCTION", "vec.rs");
        edge(&mut v, "ib_v", "f_push", "HAS_METHOD");

        // Arm A exact, REFERENCE deref: let w: Widget; w.render().
        named_node(&mut v, "p_w", "w", "PARAMETER", "a.rs");
        v.put_node_metadata(id_of("p_w"), r#"{"typeAnnotation":"Widget"}"#);
        named_node(&mut v, "ref_w", "w", "REFERENCE", "a.rs");
        edge(&mut v, "ref_w", "p_w", "READS_FROM");
        named_node(&mut v, "c_ann", "render", "CALL", "a.rs");
        edge(&mut v, "c_ann", "ref_w", "READS_FROM");

        // Arm A exact, direct declaration (identity deref clause).
        named_node(&mut v, "v_d", "d", "VARIABLE", "b.rs");
        v.put_node_metadata(id_of("v_d"), r#"{"typeAnnotation":"Widget"}"#);
        named_node(&mut v, "c_direct", "render", "CALL", "b.rs");
        edge(&mut v, "c_direct", "v_d", "READS_FROM");

        // Arm A strip arm, full depth: crate::widget::Widget.
        named_node(&mut v, "v_q", "q", "VARIABLE", "c.rs");
        v.put_node_metadata(id_of("v_q"), r#"{"typeAnnotation":"crate::widget::Widget"}"#);
        named_node(&mut v, "ref_q", "q", "REFERENCE", "c.rs");
        edge(&mut v, "ref_q", "v_q", "READS_FROM");
        named_node(&mut v, "c_qual", "render", "CALL", "c.rs");
        edge(&mut v, "c_qual", "ref_q", "READS_FROM");

        // POLICY pin: std-rooted surface must NOT match the local impl.
        named_node(&mut v, "v_s", "s", "VARIABLE", "d.rs");
        v.put_node_metadata(id_of("v_s"), r#"{"typeAnnotation":"std::widget::Widget"}"#);
        named_node(&mut v, "c_std", "render", "CALL", "d.rs");
        edge(&mut v, "c_std", "v_s", "READS_FROM");

        // DELTA 6 pin: dyn surface names no IMPL_BLOCK.
        named_node(&mut v, "v_dy", "dy", "VARIABLE", "dy.rs");
        v.put_node_metadata(id_of("v_dy"), r#"{"typeAnnotation":"dyn Widget"}"#);
        named_node(&mut v, "c_dyn", "render", "CALL", "dy.rs");
        edge(&mut v, "c_dyn", "v_dy", "READS_FROM");

        // DELTA 5 pin: `let vs: Vec<Foo>` arrives as "Vec" (analyzer-stripped)
        // and resolves to the local impl Vec member.
        named_node(&mut v, "v_vec", "vs", "VARIABLE", "g.rs");
        v.put_node_metadata(id_of("v_vec"), r#"{"typeAnnotation":"Vec"}"#);
        named_node(&mut v, "c_vec", "push", "CALL", "g.rs");
        edge(&mut v, "c_vec", "v_vec", "READS_FROM");

        // Arm B: let m = make_widget(); m.render() — the init's CALLS edge is
        // committed storage EDB (the rust_calls seam), returnType "Widget".
        named_node(&mut v, "f_make", "make_widget", "FUNCTION", "factory.rs");
        v.put_node_metadata(id_of("f_make"), r#"{"returnType":"Widget"}"#);
        named_node(&mut v, "init_b", "make_widget", "CALL", "e.rs");
        edge(&mut v, "init_b", "f_make", "CALLS");
        named_node(&mut v, "v_m", "m", "VARIABLE", "e.rs");
        edge(&mut v, "v_m", "init_b", "ASSIGNED_FROM");
        named_node(&mut v, "ref_m", "m", "REFERENCE", "e.rs");
        edge(&mut v, "ref_m", "v_m", "READS_FROM");
        named_node(&mut v, "c_ret", "render", "CALL", "e.rs");
        edge(&mut v, "c_ret", "ref_m", "READS_FROM");

        // Arm B negative: UNRESOLVED init (no CALLS edge) — nothing.
        named_node(&mut v, "init_u", "make_widget", "CALL", "f.rs");
        named_node(&mut v, "v_u", "u", "VARIABLE", "f.rs");
        edge(&mut v, "v_u", "init_u", "ASSIGNED_FROM");
        named_node(&mut v, "c_uret", "render", "CALL", "f.rs");
        edge(&mut v, "c_uret", "v_u", "READS_FROM");

        // Arm B negative: returnType "Self" names no IMPL_BLOCK (DELTA 6).
        named_node(&mut v, "f_self", "new_self", "FUNCTION", "widget.rs");
        v.put_node_metadata(id_of("f_self"), r#"{"returnType":"Self"}"#);
        named_node(&mut v, "init_s", "new_self", "CALL", "h.rs");
        edge(&mut v, "init_s", "f_self", "CALLS");
        named_node(&mut v, "v_h", "h", "VARIABLE", "h.rs");
        edge(&mut v, "v_h", "init_s", "ASSIGNED_FROM");
        named_node(&mut v, "c_self", "render", "CALL", "h.rs");
        edge(&mut v, "c_self", "v_h", "READS_FROM");

        // Method not on the impl — typed receiver, no member "missing".
        named_node(&mut v, "c_miss", "missing", "CALL", "a.rs");
        edge(&mut v, "c_miss", "ref_w", "READS_FROM");

        // File gate: identical annotated shape in a .ts file — nothing.
        named_node(&mut v, "v_ts", "t", "VARIABLE", "app.ts");
        v.put_node_metadata(id_of("v_ts"), r#"{"typeAnnotation":"Widget"}"#);
        named_node(&mut v, "c_ts", "render", "CALL", "app.ts");
        edge(&mut v, "c_ts", "v_ts", "READS_FROM");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_RECEIVER_TYPING_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_receiver_typing.dl evaluates");

        let expected: BTreeSet<(u128, u128, String, String)> = [
            ("c_ann", "f_render", "Widget"),
            ("c_direct", "f_render", "Widget"),
            ("c_qual", "f_render", "crate::widget::Widget"),
            ("c_vec", "f_push", "Vec"),
            ("c_ret", "f_render", "Widget"),
        ]
        .iter()
        .map(|(c, m, t)| {
            (
                id_of(c),
                id_of(m),
                "rust-cross-method".to_string(),
                t.to_string(),
            )
        })
        .collect();
        assert_eq!(
            quads(&eval, "rust_typed_method_call"),
            expected,
            "arm A (exact via REFERENCE + direct decl + full-depth crate strip \
             with the RAW surface as receiverType + analyzer-stripped Vec) and \
             arm B (resolved init → returnType) resolve; std-rooted surface \
             (policy), dyn surface, unresolved init, returnType Self, missing \
             member and the .ts file derive nothing"
        );

        // CALLS is shared vocabulary — additive, with both meta columns.
        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 1, "exactly one CALLS head");
        assert!(calls_specs[0].additive, "CALLS is shared — additive");
        assert_eq!(
            calls_specs[0].meta,
            vec!["resolvedVia".to_string(), "receiverType".to_string()],
            "resolvedVia + receiverType ride as meta columns"
        );
    }

    /// Wave M (rust_receiver_typing DELTA 9): macros are excluded from BOTH
    /// CALL legs — a macro DISPATCHED call derives nothing through an
    /// annotation-typed receiver (arm A), and a macro INIT call with a stale
    /// CALLS edge to a returnType-carrying FUNCTION types no receiver (arm B).
    #[test]
    fn rust_receiver_typing_excludes_macro_calls() {
        let mut v = FixtureStorageView::new(1);

        // impl Widget { fn render() }.
        named_node(&mut v, "ib_w", "Widget", "IMPL_BLOCK", "widget.rs");
        named_node(&mut v, "f_render", "render", "FUNCTION", "widget.rs");
        edge(&mut v, "ib_w", "f_render", "HAS_METHOD");

        // Arm A leg: annotated receiver, MACRO dispatched call (`render!(w)`).
        named_node(&mut v, "v_w", "w", "VARIABLE", "a.rs");
        v.put_node_metadata(id_of("v_w"), r#"{"typeAnnotation":"Widget"}"#);
        named_node(&mut v, "c_mac", "render", "CALL", "a.rs");
        v.put_node_metadata(id_of("c_mac"), r#"{"macro":true,"method":false}"#);
        edge(&mut v, "c_mac", "v_w", "READS_FROM");

        // Arm B leg: the INIT is a macro carrying a stale CALLS edge to a
        // returnType-bearing FUNCTION; the dispatched call is plain.
        named_node(&mut v, "f_make", "make_widget", "FUNCTION", "factory.rs");
        v.put_node_metadata(id_of("f_make"), r#"{"returnType":"Widget"}"#);
        named_node(&mut v, "init_m", "make_widget", "CALL", "b.rs");
        v.put_node_metadata(id_of("init_m"), r#"{"macro":true,"method":false}"#);
        edge(&mut v, "init_m", "f_make", "CALLS");
        named_node(&mut v, "v_m", "m", "VARIABLE", "b.rs");
        edge(&mut v, "v_m", "init_m", "ASSIGNED_FROM");
        named_node(&mut v, "c_plain", "render", "CALL", "b.rs");
        edge(&mut v, "c_plain", "v_m", "READS_FROM");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_RECEIVER_TYPING_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_receiver_typing.dl evaluates");

        assert_eq!(
            quads(&eval, "rust_typed_method_call"),
            BTreeSet::new(),
            "macro dispatch (arm A) and macro init (arm B) both derive nothing"
        );
    }

    /// Wave 3b — rust_imports on a single-crate `src/` layout (the convention
    /// RustImportResolution.hs targets), pinning every module-tree mechanism:
    /// - `src/`-prefix strip + `.rs`-drop (`src/widgets.rs` → `crate::widgets`);
    /// - the mod.rs convention (`src/gfx/mod.rs` → `crate::gfx`);
    /// - a nested `::`-path (`src/gfx/render.rs` → `crate::gfx::render`);
    /// - phase 2 `use crate;` → the crate-root MODULE (governed-dir arm);
    /// - phase 3 crate-prefixed binding → the exported declaration via the
    ///   CONTAINS seam (`use crate::gfx::render::Widget;`), and a crate-root
    ///   export (`use crate::helper;`);
    /// - does-not-resolve cases: an external crate (`std::sync::Arc`) derives
    ///   nothing in either phase; a JS file's IMPORT and MODULE never enter.
    #[test]
    fn rust_imports_module_tree_and_both_phases() {
        let mut v = FixtureStorageView::new(0);

        // The module tree.
        named_node(&mut v, "m_root", "lib", "MODULE", "src/lib.rs"); // crate
        named_node(&mut v, "m_widgets", "widgets", "MODULE", "src/widgets.rs"); // crate::widgets
        named_node(&mut v, "m_gfx", "gfx", "MODULE", "src/gfx/mod.rs"); // crate::gfx
        named_node(&mut v, "m_render", "render", "MODULE", "src/gfx/render.rs"); // crate::gfx::render
        named_node(&mut v, "m_app", "app", "MODULE", "src/app.rs"); // crate::app
        // Cross-language guard: a JS MODULE never enters the tree.
        named_node(&mut v, "m_js", "index", "MODULE", "web/index.js");

        // Phase 2: module-naming use paths (in src/app.rs).
        named_node(&mut v, "i_widgets", "crate::widgets", "IMPORT", "src/app.rs");
        named_node(&mut v, "i_gfx", "crate::gfx", "IMPORT", "src/app.rs");
        named_node(&mut v, "i_render", "crate::gfx::render", "IMPORT", "src/app.rs");
        named_node(&mut v, "i_crate", "crate", "IMPORT", "src/app.rs");
        named_node(&mut v, "i_std", "std::sync::Arc", "IMPORT", "src/app.rs");
        // A JS file's IMPORT with a tree-shaped name: the .rs gate drops it.
        named_node(&mut v, "i_js", "crate::widgets", "IMPORT", "web/index.js");

        // Phase 3: `use crate::gfx::render::Widget;` — binding → pub STRUCT.
        named_node(&mut v, "i_use_w", "crate::gfx::render::Widget", "IMPORT", "src/app.rs");
        named_node(&mut v, "b_widget", "Widget", "IMPORT_BINDING", "src/app.rs");
        edge(&mut v, "i_use_w", "b_widget", "CONTAINS");
        named_node(&mut v, "s_widget", "Widget", "STRUCT", "src/gfx/render.rs");
        v.put_node_metadata(id_of("s_widget"), r#"{"__exported":true}"#);

        // `use crate::helper;` — a crate-root export (module path "crate").
        named_node(&mut v, "i_use_h", "crate::helper", "IMPORT", "src/app.rs");
        named_node(&mut v, "b_helper", "helper", "IMPORT_BINDING", "src/app.rs");
        edge(&mut v, "i_use_h", "b_helper", "CONTAINS");
        named_node(&mut v, "f_helper", "helper", "FUNCTION", "src/lib.rs");
        v.put_node_metadata(id_of("f_helper"), r#"{"__exported":true}"#);

        // `use std::sync::Arc;` — external crate: no module, no export, no edge.
        named_node(&mut v, "b_arc", "Arc", "IMPORT_BINDING", "src/app.rs");
        edge(&mut v, "i_std", "b_arc", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_IMPORTS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_imports.dl evaluates");

        let pairs = |pred: &str| -> BTreeSet<(u128, u128)> {
            eval.facts(pred)
                .into_iter()
                .map(|row| {
                    (
                        row[0].as_id().expect("arg0 id"),
                        row[1].as_id().expect("arg1 id"),
                    )
                })
                .collect()
        };

        assert_eq!(
            pairs("import_module"),
            BTreeSet::from([
                (id_of("i_widgets"), id_of("m_widgets")),
                (id_of("i_gfx"), id_of("m_gfx")),
                (id_of("i_render"), id_of("m_render")),
            ]),
            "src/-strip + .rs-drop, the mod.rs convention and the nested \
             ::-path each resolve; std::, the binding-bearing use paths \
             (not module names) and the JS-file IMPORT derive nothing"
        );
        assert_eq!(
            pairs("import_crate"),
            BTreeSet::from([(id_of("i_crate"), id_of("m_root"))]),
            "`use crate;` resolves to the governing crate root"
        );
        assert_eq!(
            pairs("binding_import"),
            BTreeSet::from([
                (id_of("b_widget"), id_of("s_widget")),
                (id_of("b_helper"), id_of("f_helper")),
            ]),
            "the nested-path binding and the crate-root binding resolve to \
             their pub declarations; the std:: binding derives nothing"
        );

        // IMPORTS_FROM is shared vocabulary — additive; legacy edges carry
        // EMPTY metadata (Hs:156,193), so no meta columns (exact parity).
        assert_eq!(specs.len(), 3, "three IMPORTS_FROM heads");
        assert!(
            specs
                .iter()
                .all(|s| s.edge_type == "IMPORTS_FROM" && s.additive && s.meta.is_empty()),
            "every head is additive IMPORTS_FROM with empty meta; got {:?}",
            specs
        );
    }

    /// Wave 3b — rust_imports negative gates on a MULTI-crate (monorepo)
    /// layout, pinning DELTA 1 (the governed crate-root refinement of the
    /// legacy Map-last-wins collision) and the pub-export gate:
    /// - `use crate::helper;` in crate A resolves ONLY against A's root —
    ///   never against crate B's root exporting the same name (the legacy
    ///   resolver would have picked ONE ARBITRARY winner of the colliding
    ///   "crate" key; the pack refuses the cross-crate false edge);
    /// - a bin+lib crate (src/main.rs + src/lib.rs both present) derives one
    ///   edge per OWN root whose exports match — the declared DELTA 1
    ///   superset (legacy: one arbitrary winner of the two);
    /// - a same-named declaration that is NOT pub derives nothing;
    /// - a single-segment source (`use helper;`) is dropped by the
    ///   ≥2-segment gate (Hs:176-180).
    #[test]
    fn rust_imports_governed_crate_root_and_pub_gate() {
        let mut v = FixtureStorageView::new(0);

        // Crate A and crate B, both rooted at main.rs, both exporting "helper".
        named_node(&mut v, "ra_main", "main", "MODULE", "packages/a/src/main.rs");
        named_node(&mut v, "rb_main", "main", "MODULE", "packages/b/src/main.rs");
        named_node(&mut v, "fa_helper", "helper", "FUNCTION", "packages/a/src/main.rs");
        v.put_node_metadata(id_of("fa_helper"), r#"{"__exported":true}"#);
        named_node(&mut v, "fb_helper", "helper", "FUNCTION", "packages/b/src/main.rs");
        v.put_node_metadata(id_of("fb_helper"), r#"{"__exported":true}"#);

        // Importer inside crate A.
        named_node(&mut v, "ia_helper", "crate::helper", "IMPORT", "packages/a/src/run.rs");
        named_node(&mut v, "ba_helper", "helper", "IMPORT_BINDING", "packages/a/src/run.rs");
        edge(&mut v, "ia_helper", "ba_helper", "CONTAINS");
        named_node(&mut v, "ia_crate", "crate", "IMPORT", "packages/a/src/run.rs");

        // Pub gate: "Hidden" exists in A's root file but is NOT exported.
        named_node(&mut v, "ia_hidden", "crate::Hidden", "IMPORT", "packages/a/src/run.rs");
        named_node(&mut v, "ba_hidden", "Hidden", "IMPORT_BINDING", "packages/a/src/run.rs");
        edge(&mut v, "ia_hidden", "ba_hidden", "CONTAINS");
        named_node(&mut v, "sa_hidden", "Hidden", "STRUCT", "packages/a/src/main.rs");

        // ≥2-segment gate: `use helper;` (single segment) resolves nothing.
        named_node(&mut v, "ia_one", "helper", "IMPORT", "packages/a/src/run.rs");
        named_node(&mut v, "ba_one", "helper", "IMPORT_BINDING", "packages/a/src/run.rs");
        edge(&mut v, "ia_one", "ba_one", "CONTAINS");

        // Crate C is bin+lib: BOTH roots export "dual" — DELTA 1 superset.
        named_node(&mut v, "rc_lib", "lib", "MODULE", "packages/c/src/lib.rs");
        named_node(&mut v, "rc_main", "main", "MODULE", "packages/c/src/main.rs");
        named_node(&mut v, "fc_dual_l", "dual", "FUNCTION", "packages/c/src/lib.rs");
        v.put_node_metadata(id_of("fc_dual_l"), r#"{"__exported":true}"#);
        named_node(&mut v, "fc_dual_m", "dual", "FUNCTION", "packages/c/src/main.rs");
        v.put_node_metadata(id_of("fc_dual_m"), r#"{"__exported":true}"#);
        named_node(&mut v, "ic_dual", "crate::dual", "IMPORT", "packages/c/src/x.rs");
        named_node(&mut v, "bc_dual", "dual", "IMPORT_BINDING", "packages/c/src/x.rs");
        edge(&mut v, "ic_dual", "bc_dual", "CONTAINS");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            RUST_IMPORTS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("rust_imports.dl evaluates");

        let pairs = |pred: &str| -> BTreeSet<(u128, u128)> {
            eval.facts(pred)
                .into_iter()
                .map(|row| {
                    (
                        row[0].as_id().expect("arg0 id"),
                        row[1].as_id().expect("arg1 id"),
                    )
                })
                .collect()
        };

        assert_eq!(
            pairs("import_crate"),
            BTreeSet::from([(id_of("ia_crate"), id_of("ra_main"))]),
            "`use crate;` in crate A resolves only to A's governing root"
        );
        assert_eq!(
            pairs("binding_import"),
            BTreeSet::from([
                (id_of("ba_helper"), id_of("fa_helper")),
                (id_of("bc_dual"), id_of("fc_dual_l")),
                (id_of("bc_dual"), id_of("fc_dual_m")),
            ]),
            "crate A's binding never crosses into crate B (DELTA 1 governed \
             subset); the bin+lib crate derives one edge per own root (DELTA 1 \
             superset); the non-pub declaration and the single-segment source \
             derive nothing"
        );
    }

    /// Wave 2b — the visible() re-export fixpoint in js_import_bindings:
    /// - a NAMED re-export hop with local-name rebinding
    ///   (`export { deep as renamed } from './deep'`, Hs:373-386), its target
    ///   file via the re-exporting file's own IMPORT→MODULE seam;
    /// - a 2-hop STAR chain through committed RE_EXPORTS edges
    ///   (top `export * from './mid'`, mid `export * from './deep2'`);
    /// - the bounded-subset pin: a named re-export whose source has NO IMPORT
    ///   seam in its file derives NOTHING (js_import_bindings DELTA 1);
    /// - re-export EXPORT_BINDINGs are FOLLOWED, never endpoints.
    #[test]
    fn js_import_bindings_reexport_chains() {
        let mut v = FixtureStorageView::new(1);

        // deep.ts: the final declaration, directly exported.
        named_node(&mut v, "m_deep", "deep", "MODULE", "deep.ts");
        named_node(&mut v, "e_deep", "named", "EXPORT", "deep.ts");
        named_node(&mut v, "f_deep", "deep", "FUNCTION", "deep.ts");
        edge(&mut v, "e_deep", "f_deep", "EXPORTS");

        // deep2.ts: the star-chain terminus.
        named_node(&mut v, "m_deep2", "deep2", "MODULE", "deep2.ts");
        named_node(&mut v, "e_deep2", "named", "EXPORT", "deep2.ts");
        named_node(&mut v, "f_star", "starfn", "FUNCTION", "deep2.ts");
        edge(&mut v, "e_deep2", "f_star", "EXPORTS");

        // mid.ts: a NAMED re-export with rebinding (`export { deep as renamed }
        // from './deep'`) — the file also imports './deep' (the resolved_at seam) —
        // plus a star re-export of deep2 (committed RE_EXPORTS edge).
        named_node(&mut v, "m_mid", "mid", "MODULE", "mid.ts");
        named_node(&mut v, "eb_mid", "deep", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(
            id_of("eb_mid"),
            r#"{"exportedName":"renamed","source":"./deep"}"#,
        );
        named_node(&mut v, "i_mid", "./deep", "IMPORT", "mid.ts");
        edge(&mut v, "i_mid", "m_deep", "IMPORTS_FROM");
        named_node(&mut v, "e_star_mid", "*:./deep2", "EXPORT", "mid.ts");
        edge(&mut v, "e_star_mid", "m_deep2", "RE_EXPORTS");
        // The DELTA-1 pin: a named re-export with NO IMPORT seam for its source
        // (and no committed hop edge — the source is genuinely unresolvable).
        named_node(&mut v, "eb_ghost", "g", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(
            id_of("eb_ghost"),
            r#"{"exportedName":"ghost","source":"./nowhere"}"#,
        );

        // Wave 4: a named re-export with NO IMPORT seam but a COMMITTED
        // RE_EXPORTS hop edge (as js_module_imports' eb_reexport_hop seam
        // commits it) — the formerly seam-less subset now resolves.
        named_node(&mut v, "m_side", "side", "MODULE", "side.ts");
        named_node(&mut v, "e_side", "named", "EXPORT", "side.ts");
        named_node(&mut v, "f_side", "sidefn", "FUNCTION", "side.ts");
        edge(&mut v, "e_side", "f_side", "EXPORTS");
        named_node(&mut v, "eb_side", "sidefn", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(
            id_of("eb_side"),
            r#"{"exportedName":"sideRenamed","source":"./side"}"#,
        );
        edge(&mut v, "eb_side", "m_side", "RE_EXPORTS");

        // Wave 4 exported_in clause 4: the hop target's export is a BARE
        // `__exported` declaration (buildExportIndex class 3) — no EXPORT
        // node, no EXPORT_BINDING in side.ts.
        named_node(&mut v, "f_decl", "declLocal", "FUNCTION", "side.ts");
        v.put_node_metadata(id_of("f_decl"), r#"{"__exported":"true"}"#);
        named_node(&mut v, "eb_decl", "declLocal", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(
            id_of("eb_decl"),
            r#"{"exportedName":"sideDecl","source":"./side"}"#,
        );
        edge(&mut v, "eb_decl", "m_side", "RE_EXPORTS");

        // top.ts: a barrel star-re-exporting mid.
        named_node(&mut v, "m_top", "top", "MODULE", "top.ts");
        named_node(&mut v, "e_star_top", "*:./mid", "EXPORT", "top.ts");
        edge(&mut v, "e_star_top", "m_mid", "RE_EXPORTS");

        // app.ts imports from the top barrel.
        named_node(&mut v, "i_app", "./top", "IMPORT", "app.ts");
        edge(&mut v, "i_app", "m_top", "IMPORTS_FROM");
        let bind = |v: &mut FixtureStorageView, sid: &str, local: &str, imported: &str| {
            named_node(v, sid, local, "IMPORT_BINDING", "app.ts");
            v.put_node_metadata(id_of(sid), &format!(r#"{{"importedName":"{imported}"}}"#));
            edge(v, "i_app", sid, "CONTAINS");
        };
        bind(&mut v, "b_renamed", "renamed", "renamed"); // star(top→mid) + named hop → f_deep
        bind(&mut v, "b_star", "starfn", "starfn"); // star(top→mid) + star(mid→deep2) → f_star
        bind(&mut v, "b_ghost", "ghost", "ghost"); // unresolvable named hop — derives nothing
        bind(&mut v, "b_side", "sideRenamed", "sideRenamed"); // Wave-4 committed hop edge → f_side
        bind(&mut v, "b_decl", "sideDecl", "sideDecl"); // Wave-4 hop → __exported declaration (clause 4)

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_IMPORT_BINDINGS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_import_bindings.dl evaluates with chains");

        let pairs: BTreeSet<(u128, u128)> = eval
            .facts("binding_import")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("arg0 id"),
                    row[1].as_id().expect("arg1 id"),
                )
            })
            .collect();
        assert_eq!(
            pairs,
            BTreeSet::from([
                (id_of("b_renamed"), id_of("f_deep")),
                (id_of("b_star"), id_of("f_star")),
                (id_of("b_side"), id_of("f_side")),
                (id_of("b_decl"), id_of("f_decl")),
            ]),
            "chains collapse to the FINAL declaration (named hop with rebinding \
             through the IMPORT seam; 2-hop star chain through RE_EXPORTS; \
             Wave-4 named hop through the binding's own committed RE_EXPORTS \
             seam edge, incl. an __exported bare declaration — exported_in \
             clause 4); the unresolvable named hop derives nothing and no \
             edge ever targets a re-export EXPORT_BINDING"
        );
    }

    /// Wave 4 — js_module_imports' eb_reexport_hop seam: a named re-export's
    /// source (`export { x } from './side'`, EXPORT_BINDING + `source`
    /// metadata, NO IMPORT node) rides the SAME candidate ladder and commits
    /// EXPORT_BINDING → MODULE RE_EXPORTS (the materialized handleExportEntry
    /// resolveModulePath winner). An unresolvable source and a source-less
    /// (local) EXPORT_BINDING derive nothing; the head requires the MODULE at
    /// the winner (DELTA 8).
    #[test]
    fn js_module_imports_eb_reexport_hop_seam() {
        let mut v = FixtureStorageView::new(1);

        // side.ts: an exporting file with its MODULE node.
        named_node(&mut v, "m_side", "side", "MODULE", "side.ts");
        named_node(&mut v, "eb_in_side", "x", "EXPORT_BINDING", "side.ts");
        v.put_node_metadata(id_of("eb_in_side"), r#"{"exportedName":"x"}"#);

        // mid.ts: `export { x } from './side'` — EXPORT_BINDING with source,
        // no IMPORT node anywhere.
        named_node(&mut v, "eb_hop", "x", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(id_of("eb_hop"), r#"{"exportedName":"x","source":"./side"}"#);

        // Negative pins: unresolvable source; local binding without source.
        named_node(&mut v, "eb_bad", "y", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(id_of("eb_bad"), r#"{"exportedName":"y","source":"./nowhere"}"#);
        named_node(&mut v, "eb_local", "z", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(id_of("eb_local"), r#"{"exportedName":"z"}"#);

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_MODULE_IMPORTS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_module_imports.dl evaluates with the eb hop seam");

        let hops: BTreeSet<(u128, u128, String)> = eval
            .facts("eb_reexport_hop")
            .into_iter()
            .map(|r| {
                (
                    r[0].as_id().expect("eb id"),
                    r[1].as_id().expect("module id"),
                    r[2].as_str(),
                )
            })
            .collect();
        assert_eq!(
            hops,
            BTreeSet::from([(id_of("eb_hop"), id_of("m_side"), "side.ts".to_string())]),
            "the resolvable named-hop source commits its RE_EXPORTS seam edge \
             with resolvedPath; unresolvable / source-less bindings derive nothing"
        );
    }

    /// Wave 4 — js_runtime_globals_nodes: the generated effects-db SymbolDB
    /// facts joined through the allSuffixes/firstMatch encoding mint
    /// GLOBAL_DEFINITION nodes with byte-identical legacy sids
    /// (`GLOBAL::<seName>`). Covers, against the REAL generated facts:
    /// - qualified-key match (`fs.readFile` → seName `readFile`);
    /// - dotted BARE-key full-name match (`JSON.stringify`);
    /// - receiver suffix → bare key (`lines.push` → `push`);
    /// - the seName-conflict pin (`process.exit` → `GLOBAL::process.exit`,
    ///   the bare entry — the live-oracle policy, NOT `exit`);
    /// - both isLocallyResolved arms (full name + last dot-segment against a
    ///   same-file JS FUNCTION);
    /// - the 8-extension gate (a `.rs` call must not match);
    /// - a no-match call derives nothing.
    #[test]
    fn js_runtime_globals_nodes_mints_legacy_sids() {
        let mut v = FixtureStorageView::new(1);

        named_node(&mut v, "c_read", "fs.readFile", "CALL", "app.ts");
        named_node(&mut v, "c_json", "JSON.stringify", "CALL", "app.ts");
        named_node(&mut v, "c_push", "lines.push", "CALL", "app.ts");
        named_node(&mut v, "c_exit", "process.exit", "CALL", "app.ts");
        // local-resolution skips: `join` IS a db key, but a same-file FUNCTION
        // named `join` suppresses both the bare call and the method call.
        named_node(&mut v, "c_join", "join", "CALL", "util.ts");
        named_node(&mut v, "c_mjoin", "arr.join", "CALL", "util.ts");
        named_node(&mut v, "f_join", "join", "FUNCTION", "util.ts");
        // cross-language gate + no-match.
        named_node(&mut v, "c_rust", "fs.readFile", "CALL", "main.rs");
        named_node(&mut v, "c_none", "totallyLocalHelper", "CALL", "app.ts");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_RUNTIME_GLOBALS_NODES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_runtime_globals_nodes.dl evaluates");

        let wins: BTreeSet<(u128, String)> = eval
            .facts("win")
            .into_iter()
            .map(|r| (r[0].as_id().expect("call id"), r[1].as_str()))
            .collect();
        assert_eq!(
            wins,
            BTreeSet::from([
                (id_of("c_read"), "readFile".to_string()),
                (id_of("c_json"), "JSON.stringify".to_string()),
                (id_of("c_push"), "push".to_string()),
                (id_of("c_exit"), "process.exit".to_string()),
            ]),
            "qualified/bare/suffix matches win, conflict resolves bare-wins, \
             locally-resolved + non-JS + unknown calls derive nothing"
        );

        // The minted node set: sid GLOBAL::<seName>, one row per seName across
        // the two heads (with/without effects).
        let mut minted: BTreeSet<(String, String)> = BTreeSet::new();
        for r in eval.facts("rtg_node_eff") {
            minted.insert((r[0].as_str(), r[1].as_str()));
        }
        for r in eval.facts("rtg_node_plain") {
            minted.insert((r[0].as_str(), r[1].as_str()));
        }
        assert_eq!(
            minted,
            BTreeSet::from([
                ("GLOBAL::readFile".to_string(), "readFile".to_string()),
                ("GLOBAL::JSON.stringify".to_string(), "JSON.stringify".to_string()),
                ("GLOBAL::push".to_string(), "push".to_string()),
                ("GLOBAL::process.exit".to_string(), "process.exit".to_string()),
            ]),
            "byte-identical legacy sids, one node per matched seName"
        );
    }

    /// Wave 4 — js_runtime_globals_edges joins the COMMITTED GLOBAL_DEFINITION
    /// endpoints (as minted by js_runtime_globals_nodes / the legacy resolver)
    /// and reproduces the legacy CALLS slice:
    /// - firstMatch = LONGEST matching suffix: `process.exit` matches both the
    ///   `process.exit` and `exit` keys — exactly ONE edge, to
    ///   GLOBAL::process.exit (the shadowing negation);
    /// - the endpoint is pinned by (name, "<runtime/js>"): a same-named
    ///   GLOBAL_DEFINITION in another runtime's virtual file is never a target.
    #[test]
    fn js_runtime_globals_edges_first_match_and_endpoint_pin() {
        let mut v = FixtureStorageView::new(1);

        // Committed endpoints (legacy-sid'd) + a cross-runtime decoy.
        named_node(&mut v, "GLOBAL::process.exit", "process.exit", "GLOBAL_DEFINITION", "<runtime/js>");
        named_node(&mut v, "GLOBAL::exit", "exit", "GLOBAL_DEFINITION", "<runtime/js>");
        named_node(&mut v, "GLOBAL::readFile", "readFile", "GLOBAL_DEFINITION", "<runtime/js>");
        named_node(&mut v, "RUST_GLOBAL::readFile", "readFile", "GLOBAL_DEFINITION", "<runtime/rust>");

        named_node(&mut v, "c_exit", "process.exit", "CALL", "app.ts");
        named_node(&mut v, "c_fs", "fs.readFile", "CALL", "app.ts");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_RUNTIME_GLOBALS_EDGES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_runtime_globals_edges.dl evaluates");

        let edges: BTreeSet<(u128, u128)> = eval
            .facts("rtg_call_edge")
            .into_iter()
            .map(|r| (r[0].as_id().expect("src id"), r[1].as_id().expect("dst id")))
            .collect();
        assert_eq!(
            edges,
            BTreeSet::from([
                (id_of("c_exit"), id_of("GLOBAL::process.exit")),
                (id_of("c_fs"), id_of("GLOBAL::readFile")),
            ]),
            "longest-suffix winner only (no edge to GLOBAL::exit), \
             cross-runtime decoy never joined"
        );

        // The @materialize spec carries the legacy mkEdge payload.
        let spec = specs
            .iter()
            .find(|s| s.predicate == "rtg_call_edge")
            .expect("rtg_call_edge has a materialize spec");
        assert_eq!(spec.edge_type, "CALLS");
        assert_eq!(spec.meta, vec!["resolvedVia".to_string(), "globalCategory".to_string()]);
    }

    /// SEP PART B / RFD R6 — the receiver-import guard. A dotted member call on
    /// a default/namespace-IMPORTED receiver (`axios.get`) must NOT resolve to
    /// the bare ecma-global `get`: that strips the receiver and is unsound (the
    /// side-effect-propagation gap). The guard detects the receiver structurally
    /// via the analyzer-committed chain CALL -DERIVES_FROM-> PROPERTY_ACCESS
    /// -READS_FROM-> REFERENCE -READS_FROM-> IMPORT_BINDING and blocks the win on
    /// the STRIPPED suffix. An identical `foo.get` whose receiver is a LOCAL
    /// variable (not an import) is untouched — proving the discriminator is the
    /// import receiver, not the dotted shape.
    #[test]
    fn js_runtime_globals_edges_receiver_import_guard() {
        let mut v = FixtureStorageView::new(1);

        // The bare ecma-global endpoint both calls would otherwise win.
        named_node(&mut v, "GLOBAL::get", "get", "GLOBAL_DEFINITION", "<runtime/js>");

        // DEFECT case: `axios.get`, receiver resolves to an IMPORT_BINDING.
        named_node(&mut v, "c_axios", "axios.get", "CALL", "app.ts");
        named_node(&mut v, "pa_axios", "get", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "ref_axios", "axios", "REFERENCE", "app.ts");
        named_node(&mut v, "ib_axios", "axios", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "c_axios", "pa_axios", "DERIVES_FROM");
        edge(&mut v, "pa_axios", "ref_axios", "READS_FROM");
        edge(&mut v, "ref_axios", "ib_axios", "READS_FROM");

        // KEEP case: `foo.get`, identical suffix, but receiver is a LOCAL var.
        named_node(&mut v, "c_foo", "foo.get", "CALL", "app.ts");
        named_node(&mut v, "pa_foo", "get", "PROPERTY_ACCESS", "app.ts");
        named_node(&mut v, "ref_foo", "foo", "REFERENCE", "app.ts");
        named_node(&mut v, "var_foo", "foo", "VARIABLE", "app.ts");
        edge(&mut v, "c_foo", "pa_foo", "DERIVES_FROM");
        edge(&mut v, "pa_foo", "ref_foo", "READS_FROM");
        edge(&mut v, "ref_foo", "var_foo", "READS_FROM");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_RUNTIME_GLOBALS_EDGES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_runtime_globals_edges.dl evaluates");

        let edges: BTreeSet<(u128, u128)> = eval
            .facts("rtg_call_edge")
            .into_iter()
            .map(|r| (r[0].as_id().expect("src id"), r[1].as_id().expect("dst id")))
            .collect();
        assert_eq!(
            edges,
            BTreeSet::from([(id_of("c_foo"), id_of("GLOBAL::get"))]),
            "the imported-receiver call (axios.get) must be SUPPRESSED; only the \
             local-receiver call (foo.get) keeps its bare-global edge"
        );
    }

    /// Realistic small-corpus stats for the Wave-14 fixture tests: the
    /// empty-graph `Stats::default()` (total_nodes = 0) degenerates every
    /// keyed probe into a DERIVED relation to its FULL cardinality
    /// (`k / total_nodes.max(1)` = k), so the deep ecb-fact join chain
    /// multiplies past the E-PLAN-003 guard on estimates alone. Production
    /// always plans with store-derived stats; the dogfood-scale plan gate
    /// below covers these packs at full scale.
    fn w14_stats() -> Stats {
        let mut nodes_by_type = std::collections::HashMap::new();
        for (ty, n) in [
            ("CALL", 70_000u64),
            ("LITERAL", 40_000),
            ("VARIABLE", 15_500),
            ("FUNCTION", 10_221),
            ("CONSTANT", 6_700),
            ("IMPORT_BINDING", 5_781),
            ("http:route", 50),
        ] {
            nodes_by_type.insert(ty.to_string(), n);
        }
        Stats {
            total_nodes: 500_000,
            total_edges: 1_000_000,
            nodes_by_type,
        }
    }

    /// Loop-2 small-corpus stats for the js_entrypoint_features fixture tests —
    /// same store-derived scale as `w14_stats` (so the deep ecb-fact + PA-walk
    /// join chain plans past the E-PLAN-003 guard on estimates) plus the three
    /// FEATURE node types and PROPERTY_ACCESS (the `<obj>.` chain walk leg).
    fn ef_stats() -> Stats {
        let mut nodes_by_type = std::collections::HashMap::new();
        for (ty, n) in [
            ("CALL", 70_000u64),
            ("LITERAL", 40_000),
            ("PROPERTY_ACCESS", 30_000),
            ("REFERENCE", 140_000),
            ("VARIABLE", 15_500),
            ("FUNCTION", 10_221),
            ("CONSTANT", 6_700),
            ("IMPORT_BINDING", 5_781),
            ("cli:command", 30),
            ("mcp:tool", 40),
            ("vscode:command", 50),
            ("http:route", 50),
        ] {
            nodes_by_type.insert(ty.to_string(), n);
        }
        Stats {
            total_nodes: 500_000,
            total_edges: 1_000_000,
            nodes_by_type,
        }
    }

    /// Wave 14 — js_http_routes_nodes framework arms, each pinned on the
    /// live-verified analyzer shapes (IMPORT_BINDING metadata.source, CALL
    /// metadata.kind="new", RECEIVER_CALL chains, PASSES_ARGUMENT
    /// metadata.index, LITERAL name = raw quoted source text):
    /// - express FACTORY initializer (delta 2): `const app = express();
    ///   app.get('/users', handler)` — single-quote strip;
    /// - hono NEW initializer + chained second registration (deltas 1, 9):
    ///   `const app2 = new Hono(); app2.post("/items", h).put('/things', h2)`
    ///   — double-quote strip (the Wave-14 parser escape) and the chained
    ///   call's OWN path;
    /// - @koa/router SUBPATH import + `del` verb: `import Router from
    ///   '@koa/router/lib/router.js'; const router = new Router();
    ///   router.del('/old', h3)` → DELETE;
    /// - fastify `register` (callback at index 0, NO route path): minted as
    ///   "<unnamed-http-route>", no ROUTES_TO (non-verb method);
    /// - negatives: `.get` with an unresolvable receiver (map.get), a
    ///   receiver imported from a NON-registry lib (lodash), and a verb call
    ///   missing its callback argument (delta 8) all derive nothing.
    #[test]
    fn js_http_routes_nodes_framework_arms() {
        let idx0 = r#"{"index":0}"#;
        let idx1 = r#"{"index":1}"#;
        let mut v = FixtureStorageView::new(1);

        // a. express factory: import + const app = express() + app.get('/users', h).
        named_node(&mut v, "b_express", "express", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(id_of("b_express"), r#"{"source":"express"}"#);
        named_node(&mut v, "k_app", "app", "CONSTANT", "app.ts");
        named_node(&mut v, "c_factory", "express", "CALL", "app.ts");
        edge(&mut v, "k_app", "c_factory", "ASSIGNED_FROM");
        named_node(&mut v, "c_get", "app.get", "CALL", "app.ts");
        named_node(&mut v, "p_users", "'/users'", "LITERAL", "app.ts");
        named_node(&mut v, "h_users", "<arrow>", "FUNCTION", "app.ts");
        edge_meta(&mut v, "c_get", "p_users", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_get", "h_users", "PASSES_ARGUMENT", idx1);

        // b. hono new + chain: const app2 = new Hono();
        //    app2.post("/items", h).put('/things', h2).
        named_node(&mut v, "b_hono", "Hono", "IMPORT_BINDING", "hono.ts");
        v.put_node_metadata(id_of("b_hono"), r#"{"source":"hono"}"#);
        named_node(&mut v, "k_app2", "app2", "CONSTANT", "hono.ts");
        named_node(&mut v, "c_hono_new", "Hono", "CALL", "hono.ts");
        v.put_node_metadata(id_of("c_hono_new"), r#"{"kind":"new"}"#);
        edge(&mut v, "k_app2", "c_hono_new", "ASSIGNED_FROM");
        named_node(&mut v, "c_post", "app2.post", "CALL", "hono.ts");
        named_node(&mut v, "p_items", "\"/items\"", "LITERAL", "hono.ts");
        named_node(&mut v, "h_items", "h", "FUNCTION", "hono.ts");
        edge_meta(&mut v, "c_post", "p_items", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_post", "h_items", "PASSES_ARGUMENT", idx1);
        named_node(&mut v, "c_put", "<obj>.put", "CALL", "hono.ts");
        edge(&mut v, "c_put", "c_post", "RECEIVER_CALL");
        named_node(&mut v, "p_things", "'/things'", "LITERAL", "hono.ts");
        named_node(&mut v, "h_things", "h2", "FUNCTION", "hono.ts");
        edge_meta(&mut v, "c_put", "p_things", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_put", "h_things", "PASSES_ARGUMENT", idx1);

        // b2. hono `on` — data-driven NON-(0,1) indexes: app2.on(['GET'], '/x', h4)
        //     (ROUTE_PATH at index 1, ENTRY_POINT_CALLBACK at index 2; "on" is
        //     not a verb so the node minted carries no ROUTES_TO).
        let idx2 = r#"{"index":2}"#;
        named_node(&mut v, "c_on", "app2.on", "CALL", "hono.ts");
        named_node(&mut v, "p_methods", "<array>", "LITERAL", "hono.ts");
        named_node(&mut v, "p_x", "'/x'", "LITERAL", "hono.ts");
        named_node(&mut v, "h_x", "h4", "FUNCTION", "hono.ts");
        edge_meta(&mut v, "c_on", "p_methods", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_on", "p_x", "PASSES_ARGUMENT", idx1);
        edge_meta(&mut v, "c_on", "h_x", "PASSES_ARGUMENT", idx2);

        // c. @koa/router subpath import + new Router() + router.del('/old', h3).
        named_node(&mut v, "b_router", "Router", "IMPORT_BINDING", "koa.ts");
        v.put_node_metadata(id_of("b_router"), r#"{"source":"@koa/router/lib/router.js"}"#);
        named_node(&mut v, "k_router", "router", "CONSTANT", "koa.ts");
        named_node(&mut v, "c_router_new", "Router", "CALL", "koa.ts");
        v.put_node_metadata(id_of("c_router_new"), r#"{"kind":"new"}"#);
        edge(&mut v, "k_router", "c_router_new", "ASSIGNED_FROM");
        named_node(&mut v, "c_del", "router.del", "CALL", "koa.ts");
        named_node(&mut v, "p_old", "'/old'", "LITERAL", "koa.ts");
        named_node(&mut v, "h_old", "h3", "FUNCTION", "koa.ts");
        edge_meta(&mut v, "c_del", "p_old", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_del", "h_old", "PASSES_ARGUMENT", idx1);

        // d. fastify register: const srv = fastify(); srv.register(plugin) —
        //    callback at index 0, no ROUTE_PATH role.
        named_node(&mut v, "b_fastify", "fastify", "IMPORT_BINDING", "f.ts");
        v.put_node_metadata(id_of("b_fastify"), r#"{"source":"fastify"}"#);
        named_node(&mut v, "k_srv", "srv", "CONSTANT", "f.ts");
        named_node(&mut v, "c_ffactory", "fastify", "CALL", "f.ts");
        edge(&mut v, "k_srv", "c_ffactory", "ASSIGNED_FROM");
        named_node(&mut v, "c_register", "srv.register", "CALL", "f.ts");
        named_node(&mut v, "h_plugin", "plugin", "FUNCTION", "f.ts");
        edge_meta(&mut v, "c_register", "h_plugin", "PASSES_ARGUMENT", idx0);

        // e. negatives.
        named_node(&mut v, "c_map", "map.get", "CALL", "app.ts"); // no binding
        edge_meta(&mut v, "c_map", "p_users", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_map", "h_users", "PASSES_ARGUMENT", idx1);
        named_node(&mut v, "b_other", "other", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(id_of("b_other"), r#"{"source":"lodash"}"#);
        named_node(&mut v, "c_other", "other.get", "CALL", "app.ts"); // non-registry lib
        edge_meta(&mut v, "c_other", "p_users", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_other", "h_users", "PASSES_ARGUMENT", idx1);
        named_node(&mut v, "c_nocb", "app.options", "CALL", "app.ts"); // delta 8: no idx-1 arg
        edge_meta(&mut v, "c_nocb", "p_users", "PASSES_ARGUMENT", idx0);

        let (eval, specs, node_specs) = evaluate_with_materialize(
            &v,
            JS_HTTP_ROUTES_NODES_DL,
            w14_stats(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_http_routes_nodes.dl evaluates");

        // ROUTES_TO: verb methods with a path; register is non-verb ⇒ absent.
        let routes: BTreeSet<(u128, u128, String, String)> = eval
            .facts("http_routes_to")
            .into_iter()
            .map(|r| {
                (
                    r[0].as_id().expect("src id"),
                    r[1].as_id().expect("dst id"),
                    r[2].as_str(),
                    r[3].as_str(),
                )
            })
            .collect();
        assert_eq!(
            routes,
            BTreeSet::from([
                (id_of("c_get"), id_of("h_users"), "GET".to_string(), "/users".to_string()),
                (id_of("c_post"), id_of("h_items"), "POST".to_string(), "/items".to_string()),
                (id_of("c_put"), id_of("h_things"), "PUT".to_string(), "/things".to_string()),
                (id_of("c_del"), id_of("h_old"), "DELETE".to_string(), "/old".to_string()),
            ]),
            "factory/new/chained/subpath arms route with stripped paths and \
             mapped verbs; register (non-verb) and all negatives derive none"
        );

        // The minted nodes: sid <file>::http:route::<name>::<callIdDecimal>.
        let minted: BTreeSet<(String, String, String, String, String)> = eval
            .facts("http_route_js")
            .into_iter()
            .map(|r| (r[0].as_str(), r[1].as_str(), r[2].as_str(), r[3].as_str(), r[4].as_str()))
            .collect();
        let rn = |file: &str, name: &str, lib: &str, m: &str, call: &str| {
            (
                format!("{file}::http:route::{name}::{}", id_of(call)),
                name.to_string(),
                file.to_string(),
                lib.to_string(),
                m.to_string(),
            )
        };
        assert_eq!(
            minted,
            BTreeSet::from([
                rn("app.ts", "/users", "express", "get", "c_get"),
                rn("hono.ts", "/items", "hono", "post", "c_post"),
                rn("hono.ts", "/things", "hono", "put", "c_put"),
                rn("koa.ts", "/old", "@koa/router", "del", "c_del"),
                rn("f.ts", "<unnamed-http-route>", "fastify", "register", "c_register"),
                rn("hono.ts", "/x", "hono", "on", "c_on"),
            ]),
            "one node per resolved registration call (chained .put names its \
             OWN path — delta 9; pathless register is unnamed); negatives mint \
             nothing"
        );

        // Specs: additive ROUTES_TO; provenance-scoped exclusive http:route node.
        let rt = specs
            .iter()
            .find(|s| s.edge_type == "ROUTES_TO")
            .expect("ROUTES_TO spec");
        assert!(rt.additive, "ROUTES_TO is shared vocabulary — additive");
        assert_eq!(rt.meta, vec!["method".to_string(), "path".to_string()]);
        assert_eq!(node_specs.len(), 1, "exactly one node-materialized head");
        let ns = &node_specs[0];
        assert_eq!(ns.predicate, "http_route_js");
        assert_eq!(ns.node_type, "http:route");
        assert!(!ns.additive, "exclusive (provenance-scoped) node ownership");
        assert_eq!(
            ns.meta,
            vec!["library".to_string(), "method".to_string(), "anchorCall".to_string()]
        );
    }

    /// Wave 14 — js_http_routes_edges joins the COMMITTED http:route
    /// endpoints by the exact anchorCall pin and reproduces the enricher's
    /// edge vocabulary: EXPOSES (CALL → http:route) + HANDLES
    /// (http:route → callback). Decoy http:route nodes — axum-style (no
    /// anchorCall), enricher-style (anchorCall = wire semantic-id string),
    /// and an anchorCall pointing at an UNRELATED call — are never joined.
    #[test]
    fn js_http_routes_edges_joins_minted_endpoints() {
        let idx0 = r#"{"index":0}"#;
        let idx1 = r#"{"index":1}"#;
        let mut v = FixtureStorageView::new(1);

        // The resolvable registration: const app = express(); app.get('/users', h).
        named_node(&mut v, "b_express", "express", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(id_of("b_express"), r#"{"source":"express"}"#);
        named_node(&mut v, "k_app", "app", "CONSTANT", "app.ts");
        named_node(&mut v, "c_factory", "express", "CALL", "app.ts");
        edge(&mut v, "k_app", "c_factory", "ASSIGNED_FROM");
        named_node(&mut v, "c_get", "app.get", "CALL", "app.ts");
        named_node(&mut v, "p_users", "'/users'", "LITERAL", "app.ts");
        named_node(&mut v, "h_users", "<arrow>", "FUNCTION", "app.ts");
        edge_meta(&mut v, "c_get", "p_users", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_get", "h_users", "PASSES_ARGUMENT", idx1);

        // The COMMITTED node minted by js_http_routes_nodes (anchorCall pin).
        let route_sid = format!("app.ts::http:route::/users::{}", id_of("c_get"));
        named_node(&mut v, &route_sid, "/users", "http:route", "app.ts");
        v.put_node_metadata(
            id_of(&route_sid),
            &format!(r#"{{"anchorCall":"{}","library":"express","method":"get"}}"#, id_of("c_get")),
        );

        // Decoys: axum-style (no anchorCall), enricher-style (wire-sid
        // anchorCall), and an anchorCall anchored on a DIFFERENT call.
        named_node(&mut v, "http:route::GET::/users", "/users", "http:route", "src/main.rs");
        v.put_node_metadata(
            id_of("http:route::GET::/users"),
            r#"{"method":"GET","path":"/users"}"#,
        );
        named_node(&mut v, "app.ts::http:route::/users::wire", "/users", "http:route", "app.ts");
        v.put_node_metadata(
            id_of("app.ts::http:route::/users::wire"),
            r#"{"anchorCall":"app.ts->CALL->app.get[0]","library":"express"}"#,
        );
        named_node(&mut v, "decoy_other_anchor", "/users", "http:route", "app.ts");
        v.put_node_metadata(
            id_of("decoy_other_anchor"),
            &format!(r#"{{"anchorCall":"{}"}}"#, id_of("c_factory")),
        );

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_HTTP_ROUTES_EDGES_DL,
            w14_stats(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_http_routes_edges.dl evaluates");

        let pairs = |pred: &str| -> BTreeSet<(u128, u128)> {
            eval.facts(pred)
                .into_iter()
                .map(|r| (r[0].as_id().expect("src id"), r[1].as_id().expect("dst id")))
                .collect()
        };
        assert_eq!(
            pairs("http_exposes"),
            BTreeSet::from([(id_of("c_get"), id_of(&route_sid))]),
            "EXPOSES joins exactly the anchorCall-pinned node — no decoy joins"
        );
        assert_eq!(
            pairs("http_handles"),
            BTreeSet::from([(id_of(&route_sid), id_of("h_users"))]),
            "HANDLES: pinned node → the callback-index argument target"
        );

        for ty in ["EXPOSES", "HANDLES"] {
            let s = specs
                .iter()
                .find(|s| s.edge_type == ty)
                .unwrap_or_else(|| panic!("{ty} spec present"));
            assert!(s.additive, "{ty} is shared enricher vocabulary — additive");
            assert!(s.meta.is_empty(), "{ty} carries no meta columns");
        }
    }

    /// Loop-2 — js_entrypoint_features_nodes mints the three FEATURE node types
    /// (cli:command / mcp:tool / vscode:command) on the LIVE-VERIFIED analyzer
    /// shapes (.grafema/graph.rfdb, 491k nodes, 2026-06-13), exercising BOTH
    /// receiver-resolution styles plus name extraction:
    /// - vscode (`<obj>.` PA-walk, delta 3): the DERIVES_FROM[callee] callee PA
    ///   (base "<obj>") → READS_FROM[receiver] → PA(base="vscode") chain, with
    ///   `import * as vscode from 'vscode'`. COMMAND_NAME literal at idx 0
    ///   (single-quote strip), callback at idx 1;
    /// - commander (RECEIVER_CALL chain): `new Command('analyze').action(fn)` —
    ///   the chain origin's constructor name resolves the `commander` import, and
    ///   the FEATURE name comes from the chain ORIGIN's arg-0 LITERAL ('analyze'),
    ///   since the ENTRY_POINT_CALLBACK method `.action` carries no name role
    ///   (the enricher's origin-arg-0 fallback, extractDomainName :453);
    /// - mcp (direct named receiver): `server.setRequestHandler(Schema, h)` where
    ///   `server` is an IMPORT_BINDING from a SUBPATH source — arg 0 (TOOL_SCHEMA)
    ///   is a REFERENCE not a LITERAL ⇒ "<unnamed-mcp-tool>" (the ~4-call subset);
    /// - negatives: a `.action` whose receiver is a non-registry import (lodash),
    ///   and a `.registerCommand` missing its callback arg (delta 8) mint nothing.
    #[test]
    fn js_entrypoint_features_nodes_three_slices() {
        let idx0 = r#"{"index":0}"#;
        let idx1 = r#"{"index":1}"#;
        let callee = r#"{"kind":"callee"}"#;
        let receiver = r#"{"kind":"receiver"}"#;
        let mut v = FixtureStorageView::new(1);

        // a. vscode `<obj>.` PA-walk: import * as vscode from 'vscode';
        //    vscode.commands.registerCommand('grafema.go', handler).
        named_node(&mut v, "b_vscode", "vscode", "IMPORT_BINDING", "ext.ts");
        v.put_node_metadata(id_of("b_vscode"), r#"{"source":"vscode"}"#);
        named_node(&mut v, "c_reg", "<obj>.registerCommand", "CALL", "ext.ts");
        // callee PA of the registerCommand call (base "<obj>").
        named_node(&mut v, "pa_reg", "registerCommand", "PROPERTY_ACCESS", "ext.ts");
        v.put_node_metadata(id_of("pa_reg"), r#"{"base":"<obj>"}"#);
        edge_meta(&mut v, "c_reg", "pa_reg", "DERIVES_FROM", callee);
        // receiver hop → PA(name=commands, base="vscode") — the terminal base.
        named_node(&mut v, "pa_commands", "commands", "PROPERTY_ACCESS", "ext.ts");
        v.put_node_metadata(id_of("pa_commands"), r#"{"base":"vscode"}"#);
        edge_meta(&mut v, "pa_reg", "pa_commands", "READS_FROM", receiver);
        named_node(&mut v, "p_cmd", "'grafema.go'", "LITERAL", "ext.ts");
        named_node(&mut v, "h_cmd", "<arrow>", "FUNCTION", "ext.ts");
        edge_meta(&mut v, "c_reg", "p_cmd", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_reg", "h_cmd", "PASSES_ARGUMENT", idx1);

        // b. commander RECEIVER_CALL chain: new Command('analyze').action(fn).
        named_node(&mut v, "b_Command", "Command", "IMPORT_BINDING", "cli.ts");
        v.put_node_metadata(id_of("b_Command"), r#"{"source":"commander"}"#);
        named_node(&mut v, "c_new", "Command", "CALL", "cli.ts");
        v.put_node_metadata(id_of("c_new"), r#"{"kind":"new"}"#);
        named_node(&mut v, "p_name", "'analyze'", "LITERAL", "cli.ts");
        edge_meta(&mut v, "c_new", "p_name", "PASSES_ARGUMENT", idx0);
        named_node(&mut v, "c_action", "<obj>.action", "CALL", "cli.ts");
        edge(&mut v, "c_action", "c_new", "RECEIVER_CALL");
        named_node(&mut v, "h_action", "analyzeAction", "FUNCTION", "cli.ts");
        edge_meta(&mut v, "c_action", "h_action", "PASSES_ARGUMENT", idx0);

        // c. commander factory + named-receiver arm (delta 2): const program =
        //    createCommand(); program.action(startHandler). The receiver
        //    `program` is a CONSTANT whose ASSIGNED_FROM initializer is the
        //    `createCommand()` factory CALL (NOT a `new`) — delta 2 resolves it.
        //    `.action` has no name arg AND no chain origin with an arg-0 literal
        //    (the factory call takes none) ⇒ "<unnamed-cli-command>".
        named_node(&mut v, "b_cc", "createCommand", "IMPORT_BINDING", "cli2.ts");
        v.put_node_metadata(id_of("b_cc"), r#"{"source":"commander"}"#);
        named_node(&mut v, "k_prog", "program", "CONSTANT", "cli2.ts");
        named_node(&mut v, "c_ccall", "createCommand", "CALL", "cli2.ts");
        edge(&mut v, "k_prog", "c_ccall", "ASSIGNED_FROM");
        named_node(&mut v, "c_pact", "program.action", "CALL", "cli2.ts");
        named_node(&mut v, "h_start", "startHandler", "FUNCTION", "cli2.ts");
        edge_meta(&mut v, "c_pact", "h_start", "PASSES_ARGUMENT", idx0);

        // d. mcp direct named receiver: import { Server } from
        //    '@modelcontextprotocol/sdk/server/index.js'; server is the binding;
        //    server.setRequestHandler(CallToolRequestSchema, handler) — TOOL_SCHEMA
        //    arg 0 is a REFERENCE (not LITERAL) ⇒ unnamed.
        named_node(&mut v, "b_server", "server", "IMPORT_BINDING", "mcp.ts");
        v.put_node_metadata(id_of("b_server"), r#"{"source":"@modelcontextprotocol/sdk/server/index.js"}"#);
        named_node(&mut v, "c_srh", "server.setRequestHandler", "CALL", "mcp.ts");
        named_node(&mut v, "ref_schema", "CallToolRequestSchema", "REFERENCE", "mcp.ts");
        named_node(&mut v, "h_tool", "callTool", "FUNCTION", "mcp.ts");
        edge_meta(&mut v, "c_srh", "ref_schema", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_srh", "h_tool", "PASSES_ARGUMENT", idx1);

        // e. negatives.
        // non-registry import: import _ from 'lodash'; _.action(...) — never matches.
        named_node(&mut v, "b_lodash", "_", "IMPORT_BINDING", "n.ts");
        v.put_node_metadata(id_of("b_lodash"), r#"{"source":"lodash"}"#);
        named_node(&mut v, "c_lo", "_.action", "CALL", "n.ts");
        named_node(&mut v, "h_lo", "x", "FUNCTION", "n.ts");
        edge_meta(&mut v, "c_lo", "h_lo", "PASSES_ARGUMENT", idx0);
        // vscode registerCommand with NO callback arg (delta 8): mints nothing.
        named_node(&mut v, "c_nocb", "<obj>.registerCommand", "CALL", "n.ts");
        named_node(&mut v, "pa_nocb", "registerCommand", "PROPERTY_ACCESS", "n.ts");
        v.put_node_metadata(id_of("pa_nocb"), r#"{"base":"<obj>"}"#);
        edge_meta(&mut v, "c_nocb", "pa_nocb", "DERIVES_FROM", callee);
        named_node(&mut v, "pa_nocb_c", "commands", "PROPERTY_ACCESS", "n.ts");
        v.put_node_metadata(id_of("pa_nocb_c"), r#"{"base":"vscode"}"#);
        edge_meta(&mut v, "pa_nocb", "pa_nocb_c", "READS_FROM", receiver);
        named_node(&mut v, "b_vscode2", "vscode", "IMPORT_BINDING", "n.ts");
        v.put_node_metadata(id_of("b_vscode2"), r#"{"source":"vscode"}"#);
        named_node(&mut v, "p_nocb", "'grafema.x'", "LITERAL", "n.ts");
        edge_meta(&mut v, "c_nocb", "p_nocb", "PASSES_ARGUMENT", idx0);

        let (eval, _specs, node_specs) = evaluate_with_materialize(
            &v,
            JS_ENTRYPOINT_FEATURES_NODES_DL,
            ef_stats(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_entrypoint_features_nodes.dl evaluates");

        let rn = |file: &str, nt: &str, name: &str, lib: &str, m: &str, call: &str| {
            (
                format!("{file}::{nt}::{name}::{}", id_of(call)),
                name.to_string(),
                file.to_string(),
                lib.to_string(),
                m.to_string(),
            )
        };
        let collect = |pred: &str| -> BTreeSet<(String, String, String, String, String)> {
            eval.facts(pred)
                .into_iter()
                .map(|r| (r[0].as_str(), r[1].as_str(), r[2].as_str(), r[3].as_str(), r[4].as_str()))
                .collect()
        };
        assert_eq!(
            collect("cli_command"),
            BTreeSet::from([
                rn("cli.ts", "cli:command", "analyze", "commander", "action", "c_action"),
                rn("cli2.ts", "cli:command", "<unnamed-cli-command>", "commander", "action", "c_pact"),
            ]),
            "RECEIVER_CALL chain `.action` named from the chain-origin arg-0 \
             literal ('analyze'); the factory-init `.action` (delta 2, no \
             origin-arg-0 literal) is unnamed"
        );
        assert_eq!(
            collect("mcp_tool"),
            BTreeSet::from([
                rn("mcp.ts", "mcp:tool", "<unnamed-mcp-tool>", "@modelcontextprotocol/sdk", "setRequestHandler", "c_srh"),
            ]),
            "subpath-imported server.setRequestHandler mints one mcp:tool; \
             TOOL_SCHEMA arg is a REFERENCE ⇒ unnamed (the ~4-call subset)"
        );
        assert_eq!(
            collect("vscode_command"),
            BTreeSet::from([
                rn("ext.ts", "vscode:command", "grafema.go", "vscode", "registerCommand", "c_reg"),
            ]),
            "the `<obj>.` PA-walk resolves vscode.commands.registerCommand to the \
             `vscode` import; COMMAND_NAME literal names it; the callback-less \
             negative (delta 8) and the lodash negative mint nothing"
        );

        // Specs: three exclusive (provenance-scoped) node heads, NO ROUTES_TO.
        assert_eq!(node_specs.len(), 3, "three @materialize_node heads");
        assert!(
            node_specs.iter().all(|s| !s.additive),
            "exclusive (provenance-scoped) node ownership on every head"
        );
        for (pred, nt) in [
            ("cli_command", "cli:command"),
            ("mcp_tool", "mcp:tool"),
            ("vscode_command", "vscode:command"),
        ] {
            let ns = node_specs
                .iter()
                .find(|s| s.predicate == pred)
                .unwrap_or_else(|| panic!("node spec {pred}"));
            assert_eq!(ns.node_type, nt);
            assert_eq!(
                ns.meta,
                vec!["library".to_string(), "method".to_string(), "anchorCall".to_string()]
            );
        }
    }

    /// Loop-2 — js_entrypoint_features_edges joins the COMMITTED FEATURE
    /// endpoints by the exact per-node-type anchorCall pin and reproduces the
    /// enricher's edge vocabulary: EXPOSES (CALL → FEATURE) + HANDLES
    /// (FEATURE → callback). Decoys — a mcpToolDefinitionEnricher-style mcp:tool
    /// (anchorCall = a def-file string, never a decimal id) and a node whose
    /// anchorCall points at an UNRELATED call — are never joined; cross-type
    /// nodes (an http:route with the same anchorCall) are excluded by the
    /// per-head node_type gate.
    #[test]
    fn js_entrypoint_features_edges_joins_minted_endpoints() {
        let idx0 = r#"{"index":0}"#;
        let idx1 = r#"{"index":1}"#;
        let callee = r#"{"kind":"callee"}"#;
        let receiver = r#"{"kind":"receiver"}"#;
        let mut v = FixtureStorageView::new(1);

        // The resolvable vscode registration (the `<obj>.` PA-walk arm).
        named_node(&mut v, "b_vscode", "vscode", "IMPORT_BINDING", "ext.ts");
        v.put_node_metadata(id_of("b_vscode"), r#"{"source":"vscode"}"#);
        named_node(&mut v, "c_reg", "<obj>.registerCommand", "CALL", "ext.ts");
        named_node(&mut v, "pa_reg", "registerCommand", "PROPERTY_ACCESS", "ext.ts");
        v.put_node_metadata(id_of("pa_reg"), r#"{"base":"<obj>"}"#);
        edge_meta(&mut v, "c_reg", "pa_reg", "DERIVES_FROM", callee);
        named_node(&mut v, "pa_commands", "commands", "PROPERTY_ACCESS", "ext.ts");
        v.put_node_metadata(id_of("pa_commands"), r#"{"base":"vscode"}"#);
        edge_meta(&mut v, "pa_reg", "pa_commands", "READS_FROM", receiver);
        named_node(&mut v, "p_cmd", "'grafema.go'", "LITERAL", "ext.ts");
        named_node(&mut v, "h_cmd", "<arrow>", "FUNCTION", "ext.ts");
        edge_meta(&mut v, "c_reg", "p_cmd", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "c_reg", "h_cmd", "PASSES_ARGUMENT", idx1);

        // The COMMITTED vscode:command node the nodes pack would mint.
        let feat_sid = format!("ext.ts::vscode:command::grafema.go::{}", id_of("c_reg"));
        named_node(&mut v, &feat_sid, "grafema.go", "vscode:command", "ext.ts");
        v.put_node_metadata(
            id_of(&feat_sid),
            &format!(r#"{{"anchorCall":"{}","library":"vscode","method":"registerCommand"}}"#, id_of("c_reg")),
        );

        // Decoys.
        // (1) mcpToolDefinitionEnricher-style mcp:tool: anchorCall is a def-file
        //     string AND wrong node_type for the vscode head — never joined.
        named_node(&mut v, "def_tool", "search", "mcp:tool", "packages/mcp/src/definitions/query-tools.ts");
        v.put_node_metadata(
            id_of("def_tool"),
            r#"{"anchorCall":"packages/mcp/src/definitions/query-tools.ts->TOOL->search"}"#,
        );
        // (2) an http:route with the SAME anchorCall — wrong node_type, excluded
        //     by the per-head gate (only node(R,"vscode:command") is probed).
        named_node(&mut v, "decoy_route", "grafema.go", "http:route", "ext.ts");
        v.put_node_metadata(
            id_of("decoy_route"),
            &format!(r#"{{"anchorCall":"{}"}}"#, id_of("c_reg")),
        );
        // (3) a vscode:command whose anchorCall points at an UNRELATED call.
        named_node(&mut v, "decoy_anchor", "grafema.go", "vscode:command", "ext.ts");
        v.put_node_metadata(
            id_of("decoy_anchor"),
            &format!(r#"{{"anchorCall":"{}"}}"#, id_of("pa_commands")),
        );

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_ENTRYPOINT_FEATURES_EDGES_DL,
            ef_stats(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_entrypoint_features_edges.dl evaluates");

        let pairs = |pred: &str| -> BTreeSet<(u128, u128)> {
            eval.facts(pred)
                .into_iter()
                .map(|r| (r[0].as_id().expect("src id"), r[1].as_id().expect("dst id")))
                .collect()
        };
        assert_eq!(
            pairs("ef_exposes_vsc"),
            BTreeSet::from([(id_of("c_reg"), id_of(&feat_sid))]),
            "EXPOSES joins exactly the anchorCall-pinned vscode:command — no \
             decoy joins (def-anchored tool, cross-type route, wrong anchor)"
        );
        assert_eq!(
            pairs("ef_handles_vsc"),
            BTreeSet::from([(id_of(&feat_sid), id_of("h_cmd"))]),
            "HANDLES: pinned node → the callback-index argument target"
        );
        // The cross-type / def-anchored decoys leave the cli + mcp heads empty.
        assert!(pairs("ef_exposes_cli").is_empty() && pairs("ef_exposes_mcp").is_empty(),
            "no cli/mcp endpoints in this fixture");

        for ty in ["EXPOSES", "HANDLES"] {
            let s = specs
                .iter()
                .find(|s| s.edge_type == ty)
                .unwrap_or_else(|| panic!("{ty} spec present"));
            assert!(s.additive, "{ty} is shared enricher vocabulary — additive");
            assert!(s.meta.is_empty(), "{ty} carries no meta columns");
        }
    }

    /// Wave 2b — js_cross_file_calls namespace arm through the visible() chain:
    /// `import * as barrel from './top'; barrel.deepFn()` where top.ts star
    /// re-exports mid.ts which directly exports deepFn — the member resolves to
    /// the chain-collapsed declaration. Pins the duplicated prelude compiles in
    /// THIS pack too (textual-include discipline).
    #[test]
    fn js_cross_file_calls_ns_member_through_star_chain() {
        let mut v = FixtureStorageView::new(1);

        named_node(&mut v, "m_mid", "mid", "MODULE", "mid.ts");
        named_node(&mut v, "e_mid", "named", "EXPORT", "mid.ts");
        named_node(&mut v, "f_deepfn", "deepFn", "FUNCTION", "mid.ts");
        edge(&mut v, "e_mid", "f_deepfn", "EXPORTS");

        named_node(&mut v, "m_top", "top", "MODULE", "top.ts");
        named_node(&mut v, "e_star_top", "*:./mid", "EXPORT", "top.ts");
        edge(&mut v, "e_star_top", "m_mid", "RE_EXPORTS");

        // import * as barrel from './top' — namespace binding → MODULE edge.
        named_node(&mut v, "b_ns", "barrel", "IMPORT_BINDING", "app.ts");
        edge(&mut v, "b_ns", "m_top", "IMPORTS_FROM");
        named_node(&mut v, "c_deep", "barrel.deepFn", "CALL", "app.ts");
        named_node(&mut v, "c_miss", "barrel.nope", "CALL", "app.ts");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_CROSS_FILE_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_cross_file_calls.dl evaluates with chains");

        assert_eq!(
            triples(&eval, "xf_ns_call"),
            BTreeSet::from([(
                id_of("c_deep"),
                id_of("f_deepfn"),
                "cross-file-calls".to_string()
            )]),
            "the ns member resolves through the star chain to the collapsed \
             declaration; an unknown member still derives nothing"
        );
    }

    /// Wave 2b — the js_class_inheritance gap arms, pinned to the LIVE-PROBED
    /// EXTENDS regression (gated run 10 vs legacy 14; see the pack header):
    /// - A4 builtin global: `class MyErr extends Error` with NO import — the
    ///   type-inference CLASS:Error@<builtin> node is the target;
    /// - A3 builtin import: `import { EventEmitter } from 'events'` (incl. the
    ///   aliased form matching by importedName);
    /// - the A3 gate: the same shape from an npm package ('eventemitter3') must
    ///   NOT attach to a same-named builtin class (DELTA 8 narrowness), and the
    ///   binding's presence suppresses A4;
    /// - A1-suppression: a same-file class named Error beats the builtin (A4
    ///   fires only without a local candidate);
    /// - A2c chain: a superclass imported through a star-re-export barrel whose
    ///   binding has NO legacy IMPORTS_FROM edge resolves in-pack via visible().
    #[test]
    fn js_class_inheritance_builtin_and_chain_arms() {
        let mut v = FixtureStorageView::new(1);

        // The type-inference builtin classes (plugins/type-inference.mjs Phase 1).
        named_node(&mut v, "bi_error", "Error", "CLASS", "<builtin>");
        named_node(&mut v, "bi_ee", "EventEmitter", "CLASS", "<builtin>");
        named_node(&mut v, "bi_em3", "Emitter3", "CLASS", "<builtin>");

        // A4: class MyErr extends Error — no binding, no local Error.
        named_node(&mut v, "cls_myerr", "MyErr", "CLASS", "a.ts");
        v.put_node_metadata(id_of("cls_myerr"), r#"{"superClass":"Error"}"#);

        // A3: import { EventEmitter } from 'events'; class Mgr extends EventEmitter.
        named_node(&mut v, "cls_mgr", "Mgr", "CLASS", "b.ts");
        v.put_node_metadata(id_of("cls_mgr"), r#"{"superClass":"EventEmitter"}"#);
        named_node(&mut v, "b_ee", "EventEmitter", "IMPORT_BINDING", "b.ts");
        v.put_node_metadata(
            id_of("b_ee"),
            r#"{"source":"events","importedName":"EventEmitter"}"#,
        );

        // A3 aliased: import { EventEmitter as EE } from 'node:events'.
        named_node(&mut v, "cls_mgr2", "Mgr2", "CLASS", "b2.ts");
        v.put_node_metadata(id_of("cls_mgr2"), r#"{"superClass":"EE"}"#);
        named_node(&mut v, "b_ee_alias", "EE", "IMPORT_BINDING", "b2.ts");
        v.put_node_metadata(
            id_of("b_ee_alias"),
            r#"{"source":"node:events","importedName":"EventEmitter"}"#,
        );

        // A3 gate (npm collision): import { Emitter3 } from 'eventemitter3' —
        // a builtin CLASS named Emitter3 exists but the source is NOT a builtin
        // module → A3 silent; the binding's presence suppresses A4 too.
        named_node(&mut v, "cls_npm", "Npm", "CLASS", "c.ts");
        v.put_node_metadata(id_of("cls_npm"), r#"{"superClass":"Emitter3"}"#);
        named_node(&mut v, "b_em3", "Emitter3", "IMPORT_BINDING", "c.ts");
        v.put_node_metadata(
            id_of("b_em3"),
            r#"{"source":"eventemitter3","importedName":"Emitter3"}"#,
        );

        // A1-suppression: a same-file class named Error wins over the builtin.
        // A1 scope-walks CONTAINS to the enclosing MODULE, so wire d.ts's MODULE.
        named_node(&mut v, "m_d", "d", "MODULE", "d.ts");
        named_node(&mut v, "cls_localerr", "Error", "CLASS", "d.ts");
        named_node(&mut v, "cls_shadow", "Shadow", "CLASS", "d.ts");
        v.put_node_metadata(id_of("cls_shadow"), r#"{"superClass":"Error"}"#);
        edge(&mut v, "m_d", "cls_localerr", "CONTAINS");
        edge(&mut v, "m_d", "cls_shadow", "CONTAINS");

        // A2c chain: import { Base } from './barrel' where barrel.ts star
        // re-exports base.ts; the binding has NO legacy IMPORTS_FROM edge.
        named_node(&mut v, "cls_chained", "Chained", "CLASS", "e.ts");
        v.put_node_metadata(id_of("cls_chained"), r#"{"superClass":"Base"}"#);
        named_node(&mut v, "b_base", "Base", "IMPORT_BINDING", "e.ts");
        v.put_node_metadata(id_of("b_base"), r#"{"importedName":"Base"}"#);
        named_node(&mut v, "i_e", "./barrel", "IMPORT", "e.ts");
        edge(&mut v, "i_e", "b_base", "CONTAINS");
        named_node(&mut v, "m_barrel", "barrel", "MODULE", "barrel.ts");
        edge(&mut v, "i_e", "m_barrel", "IMPORTS_FROM");
        named_node(&mut v, "e_star_barrel", "*:./base", "EXPORT", "barrel.ts");
        named_node(&mut v, "m_base", "base", "MODULE", "base.ts");
        edge(&mut v, "e_star_barrel", "m_base", "RE_EXPORTS");
        named_node(&mut v, "e_base", "named", "EXPORT", "base.ts");
        named_node(&mut v, "cls_basecls", "Base", "CLASS", "base.ts");
        edge(&mut v, "e_base", "cls_basecls", "EXPORTS");

        let (eval, _specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_CLASS_INHERITANCE_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_class_inheritance.dl evaluates with the Wave-2b arms");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(c, t)| (id_of(c), id_of(t), "class-inheritance".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "ext_builtin_global"),
            via(&[("cls_myerr", "bi_error")]),
            "A4: the unimported global superclass attaches to the type-inference \
             builtin class; the local-Error file (A1 wins) and every \
             binding-bearing class stay out"
        );
        assert_eq!(
            triples(&eval, "ext_builtin_import"),
            via(&[("cls_mgr", "bi_ee"), ("cls_mgr2", "bi_ee")]),
            "A3: builtin-module superclass bindings (plain + aliased via \
             importedName); the npm-source binding (DELTA 8 gate) derives nothing"
        );
        assert_eq!(
            triples(&eval, "ext_chain"),
            via(&[("cls_chained", "cls_basecls")]),
            "A2c: the superclass resolves through the star-re-export chain even \
             though the binding has no legacy IMPORTS_FROM edge"
        );
        assert_eq!(
            triples(&eval, "ext_same_file"),
            via(&[("cls_shadow", "cls_localerr")]),
            "A1 still wins where a same-file candidate exists"
        );
    }

    /// Wave 2b — js_builtins_nodes mints EXTERNAL_MODULE / EXTERNAL_FUNCTION
    /// with BYTE-IDENTICAL legacy semantic ids (Builtins.hs:364-395), covering
    /// every verdict fix:
    /// (a) non-registry methods mint (fs.promises.readFile — the first-dot
    ///     split: name "promises.readFile", module "fs");
    /// (b) the direct-call arm mints by importedName (aliased
    ///     `import {join as j} from 'path'; j()` → EXTERNAL_FUNCTION:path.join);
    /// registry hits split into the security head ("fs.readFileSync",
    /// file-io/false) and the pure head ("path.join", pure=true);
    /// negatives: a non-builtin binding's dotted call, a dotted callee never
    /// hits the direct arm, the .rs IMPORT gate.
    #[test]
    fn js_builtins_nodes_mints_legacy_sids() {
        let mut v = FixtureStorageView::new(1);

        // import * as fs from 'node:fs' (namespace) + two calls.
        named_node(&mut v, "i_fs", "node:fs", "IMPORT", "app.ts");
        named_node(&mut v, "b_fs", "fs", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(id_of("b_fs"), r#"{"source":"node:fs","importedName":"*"}"#);
        named_node(&mut v, "c_rfs", "fs.readFileSync", "CALL", "app.ts");
        named_node(&mut v, "c_pro", "fs.promises.readFile", "CALL", "app.ts");

        // import { join as j } from 'path'; j() — the aliased direct arm.
        named_node(&mut v, "i_path", "path", "IMPORT", "app.ts");
        named_node(&mut v, "b_join", "j", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(id_of("b_join"), r#"{"source":"path","importedName":"join"}"#);
        named_node(&mut v, "c_j", "j", "CALL", "app.ts");

        // Negatives: non-builtin binding, dotted call on it; .rs IMPORT.
        named_node(&mut v, "b_lodash", "lodash", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(
            id_of("b_lodash"),
            r#"{"source":"lodash","importedName":"*"}"#,
        );
        named_node(&mut v, "c_lodash", "lodash.map", "CALL", "app.ts");
        named_node(&mut v, "i_rs", "os", "IMPORT", "main.rs");

        let (eval, _specs, node_specs) = evaluate_with_materialize(
            &v,
            JS_BUILTINS_NODES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_builtins_nodes.dl evaluates");

        let sids = |pred: &str| -> BTreeSet<String> {
            eval.facts(pred)
                .into_iter()
                .map(|row| row[0].as_str())
                .collect()
        };
        assert_eq!(
            sids("ext_module_node"),
            BTreeSet::from([
                "EXTERNAL_MODULE:fs".to_string(),
                "EXTERNAL_MODULE:path".to_string(),
            ]),
            "node:fs normalizes to fs; the .rs IMPORT 'os' is gated out"
        );
        assert_eq!(
            sids("ext_func_node_sec"),
            BTreeSet::from(["EXTERNAL_FUNCTION:fs.readFileSync".to_string()]),
            "the registry security head"
        );
        assert_eq!(
            sids("ext_func_node_pure"),
            BTreeSet::from(["EXTERNAL_FUNCTION:path.join".to_string()]),
            "the aliased direct call mints by importedName (verdict fix b)"
        );
        assert_eq!(
            sids("ext_func_node_plain"),
            BTreeSet::from(["EXTERNAL_FUNCTION:fs.promises.readFile".to_string()]),
            "non-registry methods mint too (verdict fix a — registry never gates); \
             the lodash dotted call derives nothing"
        );

        // The full sec row carries name/file/meta columns exactly.
        let sec_rows: Vec<Vec<String>> = eval
            .facts("ext_func_node_sec")
            .into_iter()
            .map(|r| r.iter().map(|v| v.as_str()).collect())
            .collect();
        assert_eq!(
            sec_rows,
            vec![vec![
                "EXTERNAL_FUNCTION:fs.readFileSync".to_string(),
                "readFileSync".to_string(),
                "<builtin>".to_string(),
                "fs".to_string(),
                "file-io".to_string(),
                "false".to_string(),
            ]],
            "sid, name, file '<builtin>', module, security, pure"
        );

        // Node specs: 1 module head + 3 function heads, all exclusive
        // (provenance-scoped), with the documented meta columns.
        let by_pred = |p: &str| {
            node_specs
                .iter()
                .find(|s| s.predicate == p)
                .unwrap_or_else(|| panic!("missing node spec {p}"))
        };
        assert_eq!(
            node_specs.len(),
            5,
            "four builtin @materialize_node heads + the REG-624 external-leaf head"
        );
        assert!(
            node_specs.iter().all(|s| !s.additive),
            "exclusive (provenance-scoped) on every node head"
        );
        assert_eq!(by_pred("ext_module_node").node_type, "EXTERNAL_MODULE");
        assert_eq!(by_pred("ext_module_node").meta, vec!["source".to_string()]);
        assert_eq!(
            by_pred("ext_func_node_sec").meta,
            vec![
                "module".to_string(),
                "security".to_string(),
                "pure".to_string()
            ]
        );
        assert_eq!(
            by_pred("ext_func_node_pure").meta,
            vec!["module".to_string(), "pure".to_string()]
        );
        assert_eq!(
            by_pred("ext_func_node_plain").meta,
            vec!["module".to_string()]
        );
    }

    /// Wave 2b — js_builtins_edges joins the COMMITTED EXTERNAL_* endpoints
    /// (as minted by js_builtins_nodes / the legacy resolver) and reproduces
    /// both Builtins.hs edge emissions:
    /// - IMPORTS_FROM IMPORT → EXTERNAL_MODULE;
    /// - CALLS method arm (first-dot split) and direct arm;
    /// - the bare-name collision pin (verdict fix c): a direct `parse()` from
    ///   'path' hits EXTERNAL_FUNCTION:path.parse, NOT url.parse — the
    ///   node_attr("module") disambiguation.
    #[test]
    fn js_builtins_edges_joins_minted_endpoints() {
        let mut v = FixtureStorageView::new(1);

        // The committed EXTERNAL_* state (legacy ids, module in metadata).
        named_node(&mut v, "EXTERNAL_MODULE:fs", "fs", "EXTERNAL_MODULE", "<builtin>");
        named_node(
            &mut v,
            "EXTERNAL_FUNCTION:fs.readFileSync",
            "readFileSync",
            "EXTERNAL_FUNCTION",
            "<builtin>",
        );
        v.put_node_metadata(id_of("EXTERNAL_FUNCTION:fs.readFileSync"), r#"{"module":"fs"}"#);
        named_node(
            &mut v,
            "EXTERNAL_FUNCTION:path.parse",
            "parse",
            "EXTERNAL_FUNCTION",
            "<builtin>",
        );
        v.put_node_metadata(id_of("EXTERNAL_FUNCTION:path.parse"), r#"{"module":"path"}"#);
        named_node(
            &mut v,
            "EXTERNAL_FUNCTION:url.parse",
            "parse",
            "EXTERNAL_FUNCTION",
            "<builtin>",
        );
        v.put_node_metadata(id_of("EXTERNAL_FUNCTION:url.parse"), r#"{"module":"url"}"#);

        // import * as fs from 'node:fs'; fs.readFileSync().
        named_node(&mut v, "i_fs", "node:fs", "IMPORT", "app.ts");
        named_node(&mut v, "b_fs", "fs", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(id_of("b_fs"), r#"{"source":"node:fs","importedName":"*"}"#);
        named_node(&mut v, "c_rfs", "fs.readFileSync", "CALL", "app.ts");

        // import { parse } from 'path'; parse() — must pin path.parse.
        named_node(&mut v, "b_parse", "parse", "IMPORT_BINDING", "app.ts");
        v.put_node_metadata(
            id_of("b_parse"),
            r#"{"source":"path","importedName":"parse"}"#,
        );
        named_node(&mut v, "c_parse", "parse", "CALL", "app.ts");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_BUILTINS_EDGES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_builtins_edges.dl evaluates");

        let via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(c, t)| (id_of(c), id_of(t), "builtins".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "bi_import_edge"),
            via(&[("i_fs", "EXTERNAL_MODULE:fs")]),
            "IMPORT → EXTERNAL_MODULE"
        );
        assert_eq!(
            triples(&eval, "bi_method_edge"),
            via(&[("c_rfs", "EXTERNAL_FUNCTION:fs.readFileSync")]),
            "the method arm joins the minted endpoint"
        );
        assert_eq!(
            triples(&eval, "bi_direct_edge"),
            via(&[("c_parse", "EXTERNAL_FUNCTION:path.parse")]),
            "the direct arm pins path.parse over url.parse via node_attr module \
             (verdict fix c)"
        );

        // IMPORTS_FROM + CALLS heads — all additive (shared vocabulary).
        assert!(
            specs
                .iter()
                .all(|s| s.additive && s.meta == vec!["resolvedVia".to_string()]),
            "every edge head is additive with resolvedVia"
        );
        assert_eq!(
            specs.iter().filter(|s| s.edge_type == "CALLS").count(),
            2,
            "method + direct CALLS heads"
        );
        assert_eq!(
            specs
                .iter()
                .filter(|s| s.edge_type == "IMPORTS_FROM")
                .count(),
            2,
            "two IMPORTS_FROM heads: builtin (bi_import_edge) + REG-624 external \
             (ext_other_import_edge)"
        );
    }

    /// REG-624 — js_builtins_nodes mints an EXTERNAL_MODULE leaf for every
    /// project-EXTERNAL (non-builtin, non-relative, non-absolute, unresolved)
    /// JS import so no IMPORT is a graph dead-end. Covers:
    /// - a plain npm pkg (axios), a scoped pkg (@grafema/util), a subpath import
    ///   kept verbatim (lodash/merge — package grouping is a follow-up);
    /// - "node:" normalization of an UNREGISTERED builtin (node:zlib → zlib),
    ///   sharing the bare-"zlib" leaf (one deduped sid).
    /// Negatives that mint NOTHING:
    /// - relative ("./local") and absolute ("/abs") specifiers — an unresolved
    ///   relative import must stay a guarantee violation, never a fake leaf;
    /// - a REGISTERED builtin ("fs") — left to the nodejs-builtin head;
    /// - a workspace pkg already resolved to a MODULE ("@scope/internal" with an
    ///   IMPORTS_FROM edge) — internal, not external (the dedup that stops a
    ///   double-emit against js_module_imports);
    /// - a .rs IMPORT (cross-language gate).
    #[test]
    fn js_builtins_nodes_mints_external_leaf_for_npm_imports() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "i_axios", "axios", "IMPORT", "app.ts");
        named_node(&mut v, "i_scoped", "@grafema/util", "IMPORT", "app.ts");
        named_node(&mut v, "i_sub", "lodash/merge", "IMPORT", "app.ts");
        named_node(&mut v, "i_nodezlib", "node:zlib", "IMPORT", "app.ts");
        named_node(&mut v, "i_zlib", "zlib", "IMPORT", "app.ts");

        // Negatives.
        named_node(&mut v, "i_rel", "./local", "IMPORT", "app.ts");
        named_node(&mut v, "i_abs", "/abs", "IMPORT", "app.ts");
        named_node(&mut v, "i_fs", "fs", "IMPORT", "app.ts"); // registered builtin
        // Workspace pkg already resolved to a real MODULE → internal, not external.
        named_node(&mut v, "i_ws", "@scope/internal", "IMPORT", "app.ts");
        named_node(&mut v, "m_ws", "internal.ts", "MODULE", "internal.ts");
        edge(&mut v, "i_ws", "m_ws", "IMPORTS_FROM");
        // Cross-language gate: a Rust `use serde` IMPORT must not mint a JS leaf.
        named_node(&mut v, "i_rs", "serde", "IMPORT", "main.rs");

        let (eval, _specs, node_specs) = evaluate_with_materialize(
            &v,
            JS_BUILTINS_NODES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_builtins_nodes.dl evaluates");

        let sids = |pred: &str| -> BTreeSet<String> {
            eval.facts(pred)
                .into_iter()
                .map(|row| row[0].as_str())
                .collect()
        };
        assert_eq!(
            sids("ext_other_module_node"),
            BTreeSet::from([
                "EXTERNAL_MODULE:axios".to_string(),
                "EXTERNAL_MODULE:@grafema/util".to_string(),
                "EXTERNAL_MODULE:lodash/merge".to_string(),
                "EXTERNAL_MODULE:zlib".to_string(),
            ]),
            "every external import mints a leaf; node:zlib normalizes to zlib and \
             shares the bare-zlib leaf; relative/absolute/builtin/resolved/.rs excluded"
        );
        // The registered builtin keeps its richer nodejs-builtin leaf, NOT a
        // second external mint.
        assert_eq!(
            sids("ext_module_node"),
            BTreeSet::from(["EXTERNAL_MODULE:fs".to_string()]),
            "fs stays on the nodejs-builtin head"
        );

        // Column shape: (sid, name, file "<external>", source "external").
        let rows: BTreeSet<Vec<String>> = eval
            .facts("ext_other_module_node")
            .into_iter()
            .map(|r| r.iter().map(|x| x.as_str()).collect())
            .collect();
        assert!(
            rows.contains(&vec![
                "EXTERNAL_MODULE:axios".to_string(),
                "axios".to_string(),
                "<external>".to_string(),
                "external".to_string(),
            ]),
            "sid, name, file '<external>', source 'external'; got {rows:?}"
        );

        let ext_spec = node_specs
            .iter()
            .find(|s| s.predicate == "ext_other_module_node")
            .expect("ext_other_module_node node spec");
        assert_eq!(ext_spec.node_type, "EXTERNAL_MODULE");
        assert_eq!(ext_spec.meta, vec!["source".to_string()]);
        assert!(!ext_spec.additive, "exclusive (provenance-scoped)");
    }

    /// REG-624 — js_builtins_edges joins each external IMPORT to the committed
    /// EXTERNAL_MODULE leaf (file "<external>"), emitting an additive
    /// IMPORTS_FROM with resolvedVia="external". node:zlib is pinned to the
    /// normalized "zlib" leaf. Negatives: a relative IMPORT and an IMPORT
    /// already resolved to a MODULE emit no external edge.
    #[test]
    fn js_builtins_edges_links_external_imports_to_leaves() {
        let mut v = FixtureStorageView::new(1);

        // Committed external leaves (as js_builtins_nodes minted them).
        named_node(
            &mut v,
            "EXTERNAL_MODULE:axios",
            "axios",
            "EXTERNAL_MODULE",
            "<external>",
        );
        named_node(
            &mut v,
            "EXTERNAL_MODULE:zlib",
            "zlib",
            "EXTERNAL_MODULE",
            "<external>",
        );

        named_node(&mut v, "i_axios", "axios", "IMPORT", "app.ts");
        named_node(&mut v, "i_nodezlib", "node:zlib", "IMPORT", "app.ts");
        // Negatives.
        named_node(&mut v, "i_rel", "./local", "IMPORT", "app.ts");
        named_node(&mut v, "i_ws", "@scope/internal", "IMPORT", "app.ts");
        named_node(&mut v, "m_ws", "internal.ts", "MODULE", "internal.ts");
        edge(&mut v, "i_ws", "m_ws", "IMPORTS_FROM");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_BUILTINS_EDGES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_builtins_edges.dl evaluates");

        let ext_via = |pairs: &[(&str, &str)]| -> BTreeSet<(u128, u128, String)> {
            pairs
                .iter()
                .map(|(i, x)| (id_of(i), id_of(x), "external".to_string()))
                .collect()
        };
        assert_eq!(
            triples(&eval, "ext_other_import_edge"),
            ext_via(&[
                ("i_axios", "EXTERNAL_MODULE:axios"),
                ("i_nodezlib", "EXTERNAL_MODULE:zlib"),
            ]),
            "external IMPORT → its leaf (node:zlib pinned to the normalized zlib \
             leaf); relative and already-resolved imports emit no external edge"
        );

        let ext_spec = specs
            .iter()
            .find(|s| s.predicate == "ext_other_import_edge")
            .expect("ext_other_import_edge edge spec");
        assert_eq!(ext_spec.edge_type, "IMPORTS_FROM");
        assert!(ext_spec.additive, "additive (shared IMPORTS_FROM vocabulary)");
        assert_eq!(ext_spec.meta, vec!["resolvedVia".to_string()]);
    }

    /// The bundled js_module_imports pack (Wave 3b) reproduces the module-level
    /// arms of ImportResolution.hs on a fixture pinning every ladder mechanism
    /// — each line below FAILS on a naive implementation that drops it:
    /// - relative resolve + `../` collapse (path_resolve);
    /// - TS-ESM extension swap `./util.js` → util.ts (strip_suffix, the rank-1..4
    ///   swap arm — util.js does not exist);
    /// - exact-beats-swap: `./e.js` with BOTH e.js and e.ts present → e.js only
    ///   (rank 0 before the swap ranks);
    /// - candidate ORDER under append: `../shared/x` with x.js, x.ts AND
    ///   x/index.ts all present → x.js only (rank 5 < 6 < 10);
    /// - /index fallback: `./widgets` → widgets/index.ts (rank 10 when 5-8 miss);
    /// - THE EXPORTINDEX PROBE (the verdict fix): `./shadow` where shadow.js has
    ///   a MODULE but NO exports and shadow.ts has exports → shadow.ts (a
    ///   MODULE-presence probe would wrongly pick shadow.js); `./side` whose only
    ///   candidate side.ts has a MODULE but no exports → NO edge (unresolvable);
    /// - non-workspace bare specifier `lodash` → NO edge (not a WORKSPACE_PACKAGE);
    /// - the 8-extension importer gate: the same specifier in a .py file → NOTHING;
    /// - star re-exports: `*:./lib/util.js` → RE_EXPORTS via the export ladder,
    ///   and `*:./typesonly` (MODULE, no exports) → RE_EXPORTS via the
    ///   resolveModulePathDirect ModuleIndex FALLBACK (fails without the m-ladder);
    /// - WORKSPACE ARMS (Wave 3c, DELTA 1 closed): exact `@scope/util` → the
    ///   entry-point MODULE (arm 1, no ladder); sub-path `@scope/util/storage/foo`
    ///   → dirname(entry)+"/"+subPath through the ladder (arm 2); longest-prefix
    ///   preference — `@scope/util/esm/x` resolves via the LONGER virtual package
    ///   `@scope/util/esm`, never via `@scope/util` (findWorkspacePrefix :70-81);
    ///   star `*:@scope/util` → RE_EXPORTS via ws-exact, star `*:@scope/types`
    ///   (entry has MODULE, no exports) → RE_EXPORTS via the Direct ws arm
    ///   (:599-600); IMPORT of `@scope/types` (exact key, non-exporting entry)
    ///   → NO edge (no Direct fallback for imports — the DELTA-7 corner);
    /// - EXPORTINDEX TIGHTENING (Wave 3c): `./declonly` whose target has ONLY an
    ///   __exported FUNCTION (no EXPORT node) resolves through the gnExported
    ///   arm (:137); `./contonly` whose target has ONLY a named EXPORT container
    ///   (contributes nothing, :133-134) derives NO edge — the pre-3c superset
    ///   arm would have wrongly resolved it;
    /// - meta resolvedPath projected on both heads, additive (legacy parity).
    ///
    /// Exporting markers are EXPORT nodes named "default" — a legacy-parity
    /// oracle (buildExportIndex counts "default"/"*:…"/EXPORT_BINDING/gnExported,
    /// NOT named containers; the pre-3c fixture's "named" markers pinned
    /// pack-only semantics).
    #[test]
    fn js_module_imports_ladder_star_and_probe_arms() {
        let mut v = FixtureStorageView::new(1);

        // Target files: MODULE per file; a "default" EXPORT marks exporting files
        // (a real buildExportIndex entry class, ImportResolution.hs:125-126).
        let target = |v: &mut FixtureStorageView, m: &str, e: Option<&str>, file: &str| {
            named_node(v, m, "mod", "MODULE", file);
            if let Some(e) = e {
                named_node(v, e, "default", "EXPORT", file);
            }
        };
        target(&mut v, "m_util", Some("e_util"), "src/app/lib/util.ts");
        target(&mut v, "m_xjs", Some("e_xjs"), "src/shared/x.js");
        target(&mut v, "m_xts", Some("e_xts"), "src/shared/x.ts");
        target(&mut v, "m_xidx", Some("e_xidx"), "src/shared/x/index.ts");
        target(&mut v, "m_ejs", Some("e_ejs"), "src/app/lib/e.js");
        target(&mut v, "m_ets", Some("e_ets"), "src/app/lib/e.ts");
        target(&mut v, "m_widx", Some("e_widx"), "src/app/widgets/index.ts");
        target(&mut v, "m_side", None, "src/app/side.ts"); // MODULE, no exports
        target(&mut v, "m_shjs", None, "src/app/shadow.js"); // MODULE, no exports
        target(&mut v, "m_shts", Some("e_shts"), "src/app/shadow.ts");
        target(&mut v, "m_typ", None, "src/app/typesonly.ts"); // star-fallback target

        // Workspace targets (Wave 3c): the exact-arm entry point, a sub-path
        // file under dirname(entry), the longest-prefix virtual package's file,
        // and a non-exporting entry (MODULE only) for the Direct star arm.
        target(&mut v, "m_wsentry", Some("e_wsentry"), "packages/util/src/index.ts");
        target(&mut v, "m_wsfoo", Some("e_wsfoo"), "packages/util/src/storage/foo.ts");
        target(&mut v, "m_wesmx", Some("e_wesmx"), "packages/util/esm-src/x.ts");
        target(&mut v, "m_types", None, "packages/types/src/index.ts");

        // WORKSPACE_PACKAGE facts (name = npm name, file = entry point) — the
        // orchestrator-committed shape the ws arms join on. "@scope/util/esm"
        // models an alias-expanded virtual package whose name extends
        // "@scope/util" at a '/' boundary (the longest-prefix case).
        named_node(&mut v, "w_util", "@scope/util", "WORKSPACE_PACKAGE", "packages/util/src/index.ts");
        named_node(&mut v, "w_esm", "@scope/util/esm", "WORKSPACE_PACKAGE", "packages/util/esm-src/index.ts");
        named_node(&mut v, "w_types", "@scope/types", "WORKSPACE_PACKAGE", "packages/types/src/index.ts");

        // ExportIndex-tightening targets: declonly.ts exports ONLY via an
        // __exported declaration (the gnExported arm); contonly.ts carries ONLY
        // a named EXPORT container (NOT an index entry — must stay unresolvable).
        target(&mut v, "m_declonly", None, "src/app/declonly.ts");
        named_node(&mut v, "f_exp", "helper", "FUNCTION", "src/app/declonly.ts");
        v.put_node_metadata(id_of("f_exp"), r#"{"__exported":true}"#);
        target(&mut v, "m_contonly", None, "src/app/contonly.ts");
        named_node(&mut v, "e_cont", "named", "EXPORT", "src/app/contonly.ts");

        // The importer's IMPORT nodes (name = specifier, first-class).
        let imp = |v: &mut FixtureStorageView, sid: &str, spec: &str, file: &str| {
            named_node(v, sid, spec, "IMPORT", file);
        };
        imp(&mut v, "i_rel", "./lib/util.js", "src/app/main.ts"); // TS-ESM swap
        imp(&mut v, "i_up", "../shared/x", "src/app/main.ts"); // ../ + ext order
        imp(&mut v, "i_exact", "./lib/e.js", "src/app/main.ts"); // exact beats swap
        imp(&mut v, "i_widg", "./widgets", "src/app/main.ts"); // /index fallback
        imp(&mut v, "i_shadow", "./shadow", "src/app/main.ts"); // ExportIndex probe
        imp(&mut v, "i_side", "./side", "src/app/main.ts"); // exports-less: miss
        imp(&mut v, "i_bare", "lodash", "src/app/main.ts"); // non-workspace bare: miss
        imp(&mut v, "i_nope", "./nope", "src/app/main.ts"); // no candidate: miss
        imp(&mut v, "i_py", "./lib/util.js", "tool.py"); // importer gate: miss
        imp(&mut v, "i_ws", "@scope/util", "src/app/main.ts"); // ws arm 1 (exact)
        imp(&mut v, "i_wsub", "@scope/util/storage/foo", "src/app/main.ts"); // ws arm 2 (sub-path ladder)
        imp(&mut v, "i_wesm", "@scope/util/esm/x", "src/app/main.ts"); // longest-prefix wins
        imp(&mut v, "i_wsx", "@scope/types", "src/app/main.ts"); // exact key, non-exporting entry: miss
        imp(&mut v, "i_decl", "./declonly", "src/app/main.ts"); // gnExported arm resolves
        imp(&mut v, "i_cont", "./contonly", "src/app/main.ts"); // named container only: miss

        // Star re-exports (EXPORT "*:<src>") in a barrel file.
        named_node(&mut v, "e_star1", "*:./lib/util.js", "EXPORT", "src/app/barrel.ts");
        named_node(&mut v, "e_star2", "*:./typesonly", "EXPORT", "src/app/barrel.ts");
        named_node(&mut v, "e_star3", "*:@scope/util", "EXPORT", "src/app/barrel.ts");
        named_node(&mut v, "e_star4", "*:@scope/types", "EXPORT", "src/app/barrel.ts");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_MODULE_IMPORTS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_module_imports.dl evaluates");

        // IMPORT → MODULE rows: (import, module, resolvedPath meta column).
        let im: BTreeSet<(u128, u128, String)> = eval
            .facts("import_module")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("arg0 id"),
                    row[1].as_id().expect("arg1 id"),
                    row[2].as_str(),
                )
            })
            .collect();
        assert_eq!(
            im,
            BTreeSet::from([
                (id_of("i_rel"), id_of("m_util"), "src/app/lib/util.ts".to_string()),
                (id_of("i_up"), id_of("m_xjs"), "src/shared/x.js".to_string()),
                (id_of("i_exact"), id_of("m_ejs"), "src/app/lib/e.js".to_string()),
                (id_of("i_widg"), id_of("m_widx"), "src/app/widgets/index.ts".to_string()),
                (id_of("i_shadow"), id_of("m_shts"), "src/app/shadow.ts".to_string()),
                (id_of("i_ws"), id_of("m_wsentry"), "packages/util/src/index.ts".to_string()),
                (id_of("i_wsub"), id_of("m_wsfoo"), "packages/util/src/storage/foo.ts".to_string()),
                (id_of("i_wesm"), id_of("m_wesmx"), "packages/util/esm-src/x.ts".to_string()),
                (id_of("i_decl"), id_of("m_declonly"), "src/app/declonly.ts".to_string()),
            ]),
            "swap / ../-collapse+ext-order / exact / index-fallback / \
             ExportIndex-probe / ws-exact / ws-sub-path-ladder / \
             ws-longest-prefix / gnExported-arm resolve; side (no exports), \
             bare (non-workspace), nope (no candidate), the .py importer, \
             the non-exporting ws entry (i_wsx) and the named-container-only \
             file (i_cont) derive NOTHING"
        );

        // Star RE_EXPORTS rows: export ladder + the ModuleIndex fallback.
        let re: BTreeSet<(u128, u128, String)> = eval
            .facts("star_reexport")
            .into_iter()
            .map(|row| {
                (
                    row[0].as_id().expect("arg0 id"),
                    row[1].as_id().expect("arg1 id"),
                    row[2].as_str(),
                )
            })
            .collect();
        assert_eq!(
            re,
            BTreeSet::from([
                (id_of("e_star1"), id_of("m_util"), "src/app/lib/util.ts".to_string()),
                (id_of("e_star2"), id_of("m_typ"), "src/app/typesonly.ts".to_string()),
                (id_of("e_star3"), id_of("m_wsentry"), "packages/util/src/index.ts".to_string()),
                (id_of("e_star4"), id_of("m_types"), "packages/types/src/index.ts".to_string()),
            ]),
            "star via the export ladder (swap arm), the exports-less target \
             via the resolveModulePathDirect ModuleIndex fallback, the \
             ws-exact arm, and the non-exporting ws entry via the Direct \
             ws arm (:599-600)"
        );

        // Both heads declared additive with meta(resolvedPath) — legacy parity.
        let ifs: Vec<_> = specs.iter().filter(|s| s.edge_type == "IMPORTS_FROM").collect();
        assert_eq!(ifs.len(), 1, "one IMPORTS_FROM head");
        assert!(ifs[0].additive, "IMPORTS_FROM is shared vocabulary — additive");
        assert_eq!(ifs[0].meta, vec!["resolvedPath".to_string()]);
        let res: Vec<_> = specs.iter().filter(|s| s.edge_type == "RE_EXPORTS").collect();
        assert_eq!(
            res.len(),
            2,
            "two RE_EXPORTS specs: star_reexport (one annotation over its \
             clauses) + the Wave-4 eb_reexport_hop seam head"
        );
        assert!(
            res.iter().all(|s| s.additive && s.meta == vec!["resolvedPath".to_string()]),
            "RE_EXPORTS head additive with meta resolvedPath"
        );
    }

    /// Every bundled pack must PLAN under dogfood-scale statistics — the §3
    /// guards (E-PLAN-003 cross-join + the 10M per-rule output-estimate
    /// ceiling) are evaluated against the cardinality oracle, so a pack that
    /// evaluates fine on a 10-node fixture can still be REJECTED at production
    /// scale (observed live, 2026-06-10 gated run: js_import_bindings'
    /// chain-join estimated at 858M and js_class_inheritance's A3 hit the
    /// cross-join check, both skipped by the pack-runner). Stats mirror the
    /// real dogfood graph (426k nodes / 905k edges, per-type counts from a
    /// countNodesByType probe of that run's DB).
    ///
    /// KNOWN EXCLUSIONS (pre-existing, fail on HEAD before Wave 2b):
    /// rust_cross_methods_ctor and rust_receiver_typing trip the 10M estimate
    /// on this oracle (66M; they were already absent from the W6 baseline
    /// run's 13 completed packs) — tracked as their own follow-up, not gated
    /// here.
    #[test]
    fn stdlib_packs_plan_under_dogfood_scale_stats() {
        use crate::derive::parser_ext::parse_ext_program;
        use crate::derive::plan::plan_program;
        use crate::derive::stratify::stratify;

        let mut nodes_by_type = std::collections::HashMap::new();
        for (ty, n) in [
            ("REFERENCE", 140_817u64),
            ("CALL", 69_871),
            ("SCOPE", 19_052),
            ("VARIABLE", 15_500),
            ("FUNCTION", 10_221),
            ("CONSTANT", 6_700),
            ("IMPORT_BINDING", 5_781),
            ("IMPORT", 4_039),
            ("EXPORT_BINDING", 1_556),
            ("METHOD", 718),
            ("INTERFACE", 704),
            ("MODULE", 667),
            ("EXPORT", 303),
            ("CLASS", 93),
            ("EXTERNAL_FUNCTION", 53),
            ("EXTERNAL_MODULE", 10),
            ("PROPERTY_ACCESS", 8_000),
            ("LITERAL", 40_000),
            ("STRUCT", 1_200),
            ("TRAIT", 300),
            ("IMPL_BLOCK", 1_500),
            ("GLOBAL_DEFINITION", 120),
            // Wave 3c: orchestrator-committed workspace facts (one per
            // discovered package + alias virtual packages; dogfood ~30).
            ("WORKSPACE_PACKAGE", 30),
            // Wave 14: axum_routes + js_http_routes minted routes (dogfood 8).
            ("http:route", 8),
            // Loop-2: js_entrypoint_features minted FEATURE nodes (dogfood
            // ~29 vscode:command + ~5 cli:command + ~4 mcp:tool; model
            // generously so the edges pack's node_attr(R,"anchorCall") join leg
            // is planned against a non-vacuous endpoint relation).
            ("cli:command", 30),
            ("mcp:tool", 40),
            ("vscode:command", 50),
            // Java packs: the dogfood graph has ZERO java nodes (config gap,
            // lang-spec-java.md §7), so an unknown type would estimate 0 and
            // make the gate VACUOUS for the java-only vocabulary. Model a
            // mid-size java corpus folded into this graph (the shared types —
            // CALL/FUNCTION/VARIABLE/CLASS/IMPORT/… — already carry
            // dogfood-scale counts above, which is the harsher test).
            ("ENUM", 200),
            ("RECORD", 100),
            ("ANNOTATION_TYPE", 80),
            ("ATTRIBUTE", 15_000),
        ] {
            nodes_by_type.insert(ty.to_string(), n);
        }
        let stats = Stats {
            total_nodes: 426_665,
            total_edges: 905_847,
            nodes_by_type,
        };

        let known_failures = ["rust_cross_methods_ctor", "rust_receiver_typing"];
        let expected_planned = STDLIB_PACKS
            .iter()
            .filter(|(name, _)| !known_failures.contains(name))
            .count();
        let mut failed: Vec<String> = Vec::new();
        let mut planned = 0usize;
        for (name, src) in STDLIB_PACKS {
            if known_failures.contains(name) {
                continue;
            }
            let program = parse_ext_program(src).unwrap_or_else(|e| panic!("{name}: parse: {e}"));
            let strat = stratify(&program).unwrap_or_else(|e| panic!("{name}: stratify: {e}"));
            let rules = program.rules();
            if let Err(e) = plan_program(&rules, &strat, &stats) {
                failed.push(format!("{name}: {e}"));
            } else {
                planned += 1;
            }
        }
        assert!(
            failed.is_empty(),
            "packs must plan under dogfood-scale stats (E-PLAN-003 is a \
             production rejection, not a perf hint):\n{}",
            failed.join("\n")
        );
        // `failed.is_empty()` is also true of a gate that planned NOTHING —
        // empty the pack list or skip the loop and it passes while checking
        // nothing at all (verified: both gates stay green with the iteration
        // emptied, and drop from 24s to 0.00s). Pin the work actually done.
        assert!(
            planned > 0,
            "gate planned no packs at all — STDLIB_PACKS is empty or the loop did not run"
        );
        assert_eq!(
            planned, expected_planned,
            "every bundled pack except the known exclusions must have been planned \
             ({} of {} STDLIB_PACKS entries, {} excluded)",
            planned,
            STDLIB_PACKS.len(),
            known_failures.len()
        );
    }

    /// Spread `total` nodes over the node types the bundled packs read, so the
    /// per-type oracle is CONSISTENT with `total_nodes` the way the engine
    /// builds it (`engine_v2::derive_stats` sums the per-type counts) and no
    /// pack is vacuously cheap because its type is simply absent.
    fn micro_nodes_by_type(total: u64) -> std::collections::HashMap<String, u64> {
        const TYPES: &[&str] = &[
            "MODULE", "FUNCTION", "CALL", "LITERAL", "IMPORT_BINDING", "CONSTANT",
            "VARIABLE", "PROPERTY_ACCESS", "REFERENCE", "CLASS", "METHOD", "SCOPE",
            "http:route", "cli:command", "mcp:tool", "vscode:command",
        ];
        let mut m = std::collections::HashMap::new();
        let mut left = total;
        let mut i = 0;
        while left > 0 {
            *m.entry(TYPES[i % TYPES.len()].to_string()).or_insert(0) += 1;
            left -= 1;
            i += 1;
        }
        m
    }

    /// MICRO-SCALE TWIN of [`stdlib_packs_plan_under_dogfood_scale_stats`]
    /// (REG-1196). The dogfood gate pins ONE point — 426k nodes / 905k edges —
    /// and that is the regime in which the §3 estimate guard cannot fire at
    /// all: every keyed derived leg divides by a `total_nodes` so large that it
    /// floors to 1, the multiplicative chain collapses, and the ceiling is
    /// unreachable by construction. So the gate certified an inert guard.
    ///
    /// The defect it therefore missed is the INVERSE of what the guard is for:
    /// the SMALLER the graph, the LARGER the planner's estimate, because the
    /// graph's node count sat in the DENOMINATOR of every keyed-probe fan-out
    /// (`derived_estimate`). Live on 2026-08-16: `grafema analyze` on a
    /// one-file C++ project (3 nodes / 3 edges) rejected FOUR packs —
    /// js_http_routes_{nodes,edges} and js_entrypoint_features_{nodes,edges} —
    /// with `E-PLAN-003 (res): per-rule output estimate 346862688` and
    /// `414214080`, i.e. hundreds of millions of facts predicted from a graph
    /// of three nodes. `ef_rule`, whose true cardinality is a graph-INDEPENDENT
    /// ≤23 rows (it derives only from the pack's compiled-in ground facts), was
    /// estimated at 180 on the dogfood graph and 27_360 on a 1-node graph.
    ///
    /// Every new or empty project is in this regime, so the guard was strictest
    /// exactly where it was least needed. Both shapes of the oracle are swept:
    /// POPULATED (the engine's real per-type counts) and EMPTY (the documented
    /// fallback in `base_estimate`, where a const node type cannot be narrowed
    /// and the whole relation is assumed).
    #[test]
    fn stdlib_packs_plan_under_micro_scale_stats() {
        use crate::derive::parser_ext::parse_ext_program;
        use crate::derive::plan::plan_program;
        use crate::derive::stratify::stratify;

        let mut failed: Vec<String> = Vec::new();
        let mut planned = 0usize;
        let mut oracles = 0usize;
        for total_nodes in [0u64, 1, 2, 4, 8, 16, 32] {
            for total_edges in [0u64, 3, total_nodes] {
                for populated in [true, false] {
                    oracles += 1;
                    let stats = Stats {
                        total_nodes,
                        total_edges,
                        nodes_by_type: if populated {
                            micro_nodes_by_type(total_nodes)
                        } else {
                            std::collections::HashMap::new()
                        },
                    };
                    for (name, src) in STDLIB_PACKS {
                        let program =
                            parse_ext_program(src).unwrap_or_else(|e| panic!("{name}: parse: {e}"));
                        let strat =
                            stratify(&program).unwrap_or_else(|e| panic!("{name}: stratify: {e}"));
                        if let Err(e) = plan_program(&program.rules(), &strat, &stats) {
                            failed.push(format!(
                                "N={total_nodes} E={total_edges} \
                                 oracle={} {name}: {e}",
                                if populated { "populated" } else { "empty" }
                            ));
                        } else {
                            planned += 1;
                        }
                    }
                }
            }
        }
        // One line per distinct (pack, code, head) — the sweep repeats the same
        // rejection at many points and the raw list buries the signal.
        failed.dedup();
        assert!(
            failed.is_empty(),
            "every bundled pack must PLAN on a micro-scale graph — a new or \
             empty project is the commonest real input, and no rule can \
             materialize 10M facts out of a graph of ≤32 nodes ({} \
             rejections):\n{}",
            failed.len(),
            failed.join("\n")
        );
        // Same vacuity hazard as the dogfood twin: `failed.is_empty()` holds
        // when nothing was planned. Pin both factors of the sweep — the number
        // of oracles and the packs planned against each — so an emptied pack
        // list or a collapsed sweep is a failure, not a fast pass.
        assert!(
            planned > 0,
            "gate planned no packs at all — STDLIB_PACKS is empty or the sweep did not run"
        );
        assert_eq!(oracles, 42, "the oracle sweep must cover 7 sizes x 3 edge counts x 2 shapes");
        assert_eq!(
            planned,
            oracles * STDLIB_PACKS.len(),
            "every one of the {} STDLIB_PACKS entries must be planned against each of \
             the {} oracles",
            STDLIB_PACKS.len(),
            oracles
        );
    }

    // ── Java packs (java-resolve migration, lang-spec-java.md) ─────────────

    /// VERDICT C2 pin (lang-spec-java.md): a NEGATED BUILTIN literal is a
    /// legal per-row anti-join — the executor's negated path keeps the exact
    /// per-row fallback for non-special-cased shapes (exec.rs), and the
    /// stratifier creates NO dependency edge for base/builtin literals
    /// (stratify.rs "base relation or builtin — no dependency edge"), so
    /// `\+ string_contains(...)` is stratification-free. No stdlib pack used
    /// the form before the java packs; this fixture pins the semantics
    /// java_types.dl's normalizeType filters rely on, BEFORE relying on it
    /// (the verdict's explicit precondition).
    #[test]
    fn negated_builtin_literal_is_a_per_row_anti_join() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "c_plain", "Alpha", "CLASS", "a.java");
        named_node(&mut v, "c_comma", "Alpha,Beta", "CLASS", "b.java");

        let eval = evaluate(
            &v,
            r#"cand(X, N) :- node(X, "CLASS"), attr(X, "name", N).
               kept(X) :- cand(X, N), \+ string_contains(N, ",")."#,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("negated-builtin program evaluates");

        let kept: BTreeSet<u128> = eval
            .facts("kept")
            .iter()
            .filter_map(|r| r[0].as_id())
            .collect();
        assert_eq!(
            kept,
            BTreeSet::from([id_of("c_plain")]),
            "\\+ string_contains must drop exactly the comma-bearing row"
        );
    }

    /// Shared collector: the (src, dst) id pairs of one derived predicate.
    fn id_pairs(eval: &crate::derive::exec::Evaluation, pred: &str) -> BTreeSet<(u128, u128)> {
        eval.facts(pred)
            .iter()
            .filter_map(|r| Some((r.first()?.as_id()?, r.get(1)?.as_id()?)))
            .collect()
    }

    /// java_imports.dl — every arm of the S1/S2/S3 surface on one fixture:
    /// - S2 happy path: IMPORT "com.lib.Foo" → the packaged CLASS Foo;
    /// - DELTA 1 pin (spec §5 class 1): a SECOND "com.lib.Foo" declaration —
    ///   set semantics derives an edge per candidate (legacy Map kept one);
    /// - DELTA 2 pin (spec §5 class 3, the D1 fix): the IMPORT_BINDING — with
    ///   NO `source` metadata, exactly as the analyzer stamps it — resolves
    ///   via the parent-IMPORT CONTAINS edge; legacy production derived ZERO
    ///   here (resolveBinding read a key that never exists);
    /// - default-package arm: a declaration in a package-less file is keyed
    ///   by its BARE name;
    /// - P3 parity pin: a glob IMPORT ("com.lib.*") derives nothing;
    /// - static-member parity pin: "com.lib.Foo.bar" derives nothing;
    /// - dead-arm zero: a binding whose parent IMPORT resolves nothing
    ///   derives nothing;
    /// - .java gate: a same-qualified kotlin declaration never matches.
    #[test]
    fn java_imports_pack_resolves_imports_and_bindings() {
        let mut v = FixtureStorageView::new(1);
        // Declaration side: com.lib.Foo (packaged), twice (DELTA 1).
        named_node(&mut v, "m_lib", "lib", "MODULE", "com/lib/Foo.java");
        v.put_node_metadata(id_of("m_lib"), r#"{"package":"com.lib"}"#);
        named_node(&mut v, "c_foo", "Foo", "CLASS", "com/lib/Foo.java");
        named_node(&mut v, "m_lib2", "lib2", "MODULE", "com/lib2/Foo.java");
        v.put_node_metadata(id_of("m_lib2"), r#"{"package":"com.lib"}"#);
        named_node(&mut v, "c_foo2", "Foo", "CLASS", "com/lib2/Foo.java");
        // .java gate: kotlin twin of the same qualified name.
        named_node(&mut v, "m_kt", "ktlib", "MODULE", "com/lib/Foo.kt");
        v.put_node_metadata(id_of("m_kt"), r#"{"package":"com.lib"}"#);
        named_node(&mut v, "c_kt", "Foo", "CLASS", "com/lib/Foo.kt");
        // Default-package declaration (MODULE has NO package key —
        // Walker.hs:37-51 omits it entirely).
        named_node(&mut v, "m_def", "def", "MODULE", "Def.java");
        named_node(&mut v, "c_bare", "Bare", "CLASS", "Def.java");

        // Importing side.
        named_node(&mut v, "i1", "com.lib.Foo", "IMPORT", "app/App.java");
        named_node(&mut v, "b1", "Foo", "IMPORT_BINDING", "app/App.java");
        v.put_node_metadata(
            id_of("b1"),
            r#"{"imported_name":"Foo","local_name":"Foo","static":false}"#,
        );
        edge(&mut v, "i1", "b1", "CONTAINS");
        named_node(&mut v, "i2", "com.lib.*", "IMPORT", "app/App.java");
        named_node(&mut v, "i3", "com.lib.Foo.bar", "IMPORT", "app/App.java");
        named_node(&mut v, "i4", "Bare", "IMPORT", "app/App.java");
        named_node(&mut v, "i5", "com.none.Nope", "IMPORT", "app/App.java");
        named_node(&mut v, "b5", "Nope", "IMPORT_BINDING", "app/App.java");
        edge(&mut v, "i5", "b5", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JAVA_IMPORTS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("java_imports.dl evaluates");

        assert_eq!(
            id_pairs(&eval, "import_target"),
            BTreeSet::from([
                (id_of("i1"), id_of("c_foo")),
                (id_of("i1"), id_of("c_foo2")),
                (id_of("i4"), id_of("c_bare")),
            ]),
            "S2: qualified + default-package imports resolve; glob/static/unknown derive nothing"
        );
        assert_eq!(
            id_pairs(&eval, "binding_target"),
            BTreeSet::from([
                (id_of("b1"), id_of("c_foo")),
                (id_of("b1"), id_of("c_foo2")),
            ]),
            "S3 (DELTA 2): bindings resolve via the parent IMPORT, source-metadata-free; \
             the unresolvable-parent binding derives nothing"
        );
        assert!(
            specs
                .iter()
                .all(|s| s.edge_type == "IMPORTS_FROM" && s.additive && s.meta.is_empty()),
            "both heads are additive empty-meta IMPORTS_FROM; got {:?}",
            specs.iter().map(|s| (&s.predicate, &s.edge_type)).collect::<Vec<_>>()
        );
        assert_eq!(specs.len(), 2, "exactly the S2 + S3 heads materialize");
    }

    /// java_types.dl — every arm of S5-S9 on one fixture:
    /// - RETURNS: plain name resolves; "Alpha[]" strips; "int" (primitive),
    ///   "?" (wildcard) and "<unknown>" (C4 dead-letter vocabulary) derive
    ///   nothing; the .kt twin is gated out;
    /// - TYPE_OF: interface type resolves; "boolean[]" strips to a primitive
    ///   and derives nothing;
    /// - EXTENDS: single name resolves; the interface multi-extends
    ///   "Alpha,Beta" derives NOTHING (the legacy no-split miss, reproduced
    ///   exactly — spec §3 S7); the dup-named self-extend derives only the
    ///   OTHER candidate (DELTA 2's neq(C,T));
    /// - IMPLEMENTS (VERDICT C1, delta class 6 CLOSED): single element,
    ///   3-element right-peel split (recursion depth 2), ENUM arm; the
    ///   RECORD's implements is NOT read (legacy reads CLASS+ENUM only,
    ///   TypeResolution.hs:163 — parity dead-arm zero);
    /// - THROWS_TYPE (C1): single + 2-element split.
    #[test]
    fn java_types_pack_resolves_type_positions_with_split() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "c_a", "Alpha", "CLASS", "a.java");
        named_node(&mut v, "i_b", "Beta", "INTERFACE", "b.java");
        named_node(&mut v, "i_g", "Gamma", "INTERFACE", "g.java");
        named_node(&mut v, "i_z", "Zeta", "INTERFACE", "z.java");
        named_node(&mut v, "c_io", "IOExc", "CLASS", "io.java");
        named_node(&mut v, "c_sql", "SqlExc", "CLASS", "sql.java");

        // S5 RETURNS.
        named_node(&mut v, "f1", "mk", "FUNCTION", "m.java");
        v.put_node_metadata(id_of("f1"), r#"{"kind":"method","return_type":"Alpha"}"#);
        named_node(&mut v, "f2", "count", "FUNCTION", "m.java");
        v.put_node_metadata(id_of("f2"), r#"{"kind":"method","return_type":"int"}"#);
        named_node(&mut v, "f3", "arr", "FUNCTION", "m.java");
        v.put_node_metadata(id_of("f3"), r#"{"kind":"method","return_type":"Alpha[]"}"#);
        named_node(&mut v, "f4", "wild", "FUNCTION", "m.java");
        v.put_node_metadata(id_of("f4"), r#"{"kind":"method","return_type":"?"}"#);
        named_node(&mut v, "f5", "unk", "FUNCTION", "m.java");
        v.put_node_metadata(id_of("f5"), r#"{"kind":"method","return_type":"<unknown>"}"#);
        named_node(&mut v, "f_kt", "mk", "FUNCTION", "m.kt");
        v.put_node_metadata(id_of("f_kt"), r#"{"kind":"method","return_type":"Alpha"}"#);

        // S6 TYPE_OF.
        named_node(&mut v, "v1", "b", "VARIABLE", "m.java");
        v.put_node_metadata(id_of("v1"), r#"{"kind":"field","type":"Beta"}"#);
        named_node(&mut v, "v2", "flags", "VARIABLE", "m.java");
        v.put_node_metadata(id_of("v2"), r#"{"kind":"field","type":"boolean[]"}"#);

        // S7 EXTENDS.
        named_node(&mut v, "c_sub", "Sub", "CLASS", "sub.java");
        v.put_node_metadata(id_of("c_sub"), r#"{"extends":"Alpha"}"#);
        named_node(&mut v, "i_multi", "Both", "INTERFACE", "im.java");
        v.put_node_metadata(id_of("i_multi"), r#"{"extends":"Alpha,Beta"}"#);
        named_node(&mut v, "c_x", "X", "CLASS", "x.java");
        v.put_node_metadata(id_of("c_x"), r#"{"extends":"X"}"#);
        named_node(&mut v, "c_x2", "X", "CLASS", "x2.java");

        // S8 IMPLEMENTS.
        named_node(&mut v, "c_one", "One", "CLASS", "one.java");
        v.put_node_metadata(id_of("c_one"), r#"{"implements":"Beta"}"#);
        named_node(&mut v, "c_multi", "Multi", "CLASS", "multi.java");
        v.put_node_metadata(id_of("c_multi"), r#"{"implements":"Beta,Gamma,Zeta"}"#);
        named_node(&mut v, "e_en", "En", "ENUM", "en.java");
        v.put_node_metadata(id_of("e_en"), r#"{"implements":"Beta"}"#);
        named_node(&mut v, "r_rec", "Rec", "RECORD", "rec.java");
        v.put_node_metadata(id_of("r_rec"), r#"{"implements":"Beta"}"#);

        // S9 THROWS_TYPE.
        named_node(&mut v, "f7", "one", "FUNCTION", "t.java");
        v.put_node_metadata(id_of("f7"), r#"{"kind":"method","throws":"IOExc"}"#);
        named_node(&mut v, "f8", "two", "FUNCTION", "t.java");
        v.put_node_metadata(id_of("f8"), r#"{"kind":"method","throws":"IOExc,SqlExc"}"#);

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JAVA_TYPES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("java_types.dl evaluates");

        assert_eq!(
            id_pairs(&eval, "returns"),
            BTreeSet::from([(id_of("f1"), id_of("c_a")), (id_of("f3"), id_of("c_a"))]),
            "RETURNS: plain + []-stripped resolve; primitive/wildcard/<unknown>/.kt derive nothing"
        );
        assert_eq!(
            id_pairs(&eval, "type_of"),
            BTreeSet::from([(id_of("v1"), id_of("i_b"))]),
            "TYPE_OF: interface type resolves; boolean[] strips to a primitive and is rejected"
        );
        assert_eq!(
            id_pairs(&eval, "extends"),
            BTreeSet::from([(id_of("c_sub"), id_of("c_a")), (id_of("c_x"), id_of("c_x2"))]),
            "EXTENDS: single name resolves; comma-joined multi-extends misses (legacy parity); \
             neq(C,T) keeps the dup-name self-loop out (DELTA 2)"
        );
        assert_eq!(
            id_pairs(&eval, "implements"),
            BTreeSet::from([
                (id_of("c_one"), id_of("i_b")),
                (id_of("c_multi"), id_of("i_b")),
                (id_of("c_multi"), id_of("i_g")),
                (id_of("c_multi"), id_of("i_z")),
                (id_of("e_en"), id_of("i_b")),
            ]),
            "IMPLEMENTS: C1 right-peel splits all 3 elements; ENUM arm works; \
             RECORD implements is not read (legacy parity dead-arm)"
        );
        assert_eq!(
            id_pairs(&eval, "throws_type"),
            BTreeSet::from([
                (id_of("f7"), id_of("c_io")),
                (id_of("f8"), id_of("c_io")),
                (id_of("f8"), id_of("c_sql")),
            ]),
            "THROWS_TYPE: C1 right-peel splits the 2-element throws clause"
        );
        let expect: std::collections::BTreeMap<&str, &str> = [
            ("returns", "RETURNS"),
            ("type_of", "TYPE_OF"),
            ("extends", "EXTENDS"),
            ("implements", "IMPLEMENTS"),
            ("throws_type", "THROWS_TYPE"),
        ]
        .into_iter()
        .collect();
        let got: std::collections::BTreeMap<&str, &str> = specs
            .iter()
            .map(|s| (s.predicate.as_str(), s.edge_type.as_str()))
            .collect();
        assert_eq!(got, expect, "all 5 type heads materialize");
        assert!(
            specs.iter().all(|s| s.additive && s.meta.is_empty()),
            "every head additive with empty meta (legacy metadata was empty)"
        );
    }

    /// java_calls.dl — every arm of S10-S13 on one fixture:
    /// - S10: "new Service" → INSTANTIATES + CALLS to BOTH ctors (DELTA 2,
    ///   all-ctors vs legacy head-pick); a RECORD's compact constructor is
    ///   reached through the CONTAINS arm (it has NO HAS_METHOD —
    ///   Declarations.hs:534-539); "new Missing" derives nothing;
    /// - S11 (DELTA 3, the D3 fix): a receiverless call inside an ORDINARY
    ///   method body resolves to the same-class method — the declared
    ///   superset (legacy fired only where [in:] == class name); receiver
    ///   "this" counts as plain; lambdas are CLOSURE nodes (Expressions.hs:
    ///   352-355, :399-404 — NOT FUNCTION), and the jbody/fn_owner recursion
    ///   lifts a CLOSURE-nested call, a CLOSURE-in-CLOSURE-nested call, and
    ///   the ctor-expression-lambda LEGACY-PARITY arm (LambdaExpr pushes no
    ///   withEnclosingFn, Expressions.hs:343-386, so legacy resolves via the
    ///   leaked [in:ctorName] — the pack must not lose that row); a
    ///   foreign-receiver call, a field-initializer call, and a call in a
    ///   field-initializer LAMBDA (the CLOSURE's CONTAINS parent is the
    ///   CLASS — fn_owner chain stops) derive nothing;
    /// - S12: a class-named receiver resolves to that class's method; the
    ///   non-class receiver derives nothing (Hs test :243-249 parity);
    /// - S13: this() → all same-class ctors; super() → the superclass ctor
    ///   via the extends metadata;
    /// - .java gate: a kotlin "new Service" call derives nothing.
    #[test]
    fn java_calls_pack_resolves_call_families() {
        let mut v = FixtureStorageView::new(1);
        // class Service extends Base, with 2 ctors + 2 methods.
        named_node(&mut v, "c_svc", "Service", "CLASS", "svc.java");
        v.put_node_metadata(id_of("c_svc"), r#"{"extends":"Base"}"#);
        named_node(&mut v, "m_ctor", "Service", "FUNCTION", "svc.java");
        v.put_node_metadata(id_of("m_ctor"), r#"{"kind":"constructor"}"#);
        edge(&mut v, "c_svc", "m_ctor", "HAS_METHOD");
        named_node(&mut v, "m_ctor2", "Service", "FUNCTION", "svc.java");
        v.put_node_metadata(id_of("m_ctor2"), r#"{"kind":"constructor"}"#);
        edge(&mut v, "c_svc", "m_ctor2", "HAS_METHOD");
        named_node(&mut v, "m_helper", "helper", "FUNCTION", "svc.java");
        v.put_node_metadata(id_of("m_helper"), r#"{"kind":"method"}"#);
        edge(&mut v, "c_svc", "m_helper", "HAS_METHOD");
        named_node(&mut v, "m_run", "run", "FUNCTION", "svc.java");
        v.put_node_metadata(id_of("m_run"), r#"{"kind":"method"}"#);
        edge(&mut v, "c_svc", "m_run", "HAS_METHOD");
        // class Base (the super() target).
        named_node(&mut v, "c_base", "Base", "CLASS", "base.java");
        named_node(&mut v, "m_bctor", "Base", "FUNCTION", "base.java");
        v.put_node_metadata(id_of("m_bctor"), r#"{"kind":"constructor"}"#);
        edge(&mut v, "c_base", "m_bctor", "HAS_METHOD");
        // class Util (the static-receiver target).
        named_node(&mut v, "c_util", "Util", "CLASS", "util.java");
        named_node(&mut v, "m_stat", "format", "FUNCTION", "util.java");
        v.put_node_metadata(id_of("m_stat"), r#"{"kind":"method"}"#);
        edge(&mut v, "c_util", "m_stat", "HAS_METHOD");
        // record Pt with a compact constructor (CONTAINS-only, NO HAS_METHOD).
        named_node(&mut v, "r_pt", "Pt", "RECORD", "pt.java");
        named_node(&mut v, "m_cc", "Pt", "FUNCTION", "pt.java");
        v.put_node_metadata(id_of("m_cc"), r#"{"kind":"compact_constructor"}"#);
        edge(&mut v, "r_pt", "m_cc", "CONTAINS");

        // S10: constructor calls.
        named_node(&mut v, "c_new", "new Service", "CALL", "app.java");
        edge(&mut v, "m_run", "c_new", "CONTAINS");
        named_node(&mut v, "c_newpt", "new Pt", "CALL", "app.java");
        edge(&mut v, "m_run", "c_newpt", "CONTAINS");
        named_node(&mut v, "c_newmiss", "new Missing", "CALL", "app.java");
        edge(&mut v, "m_run", "c_newmiss", "CONTAINS");
        named_node(&mut v, "c_kt", "new Service", "CALL", "app.kt");

        // S11: same-class plain calls.
        named_node(&mut v, "c_plain", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_plain"), r#"{"method":true,"argCount":0}"#);
        edge(&mut v, "m_run", "c_plain", "CONTAINS");
        named_node(&mut v, "c_this_recv", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_this_recv"), r#"{"method":true,"argCount":0,"receiver":"this"}"#);
        edge(&mut v, "m_run", "c_this_recv", "CONTAINS");
        named_node(&mut v, "c_recv", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_recv"), r#"{"method":true,"argCount":0,"receiver":"other"}"#);
        edge(&mut v, "m_run", "c_recv", "CONTAINS");
        // Field-initializer call: CONTAINS parent is the CLASS node.
        named_node(&mut v, "c_field", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_field"), r#"{"method":true,"argCount":0}"#);
        edge(&mut v, "c_svc", "c_field", "CONTAINS");
        // Lambda-nested call: lambdas are CLOSURE nodes (no HAS_METHOD);
        // fn_owner lifts through the CLOSURE to the method's class.
        named_node(&mut v, "f_lambda", "<lambda>", "CLOSURE", "svc.java");
        edge(&mut v, "m_run", "f_lambda", "CONTAINS");
        named_node(&mut v, "c_inlam", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_inlam"), r#"{"method":true,"argCount":0}"#);
        edge(&mut v, "f_lambda", "c_inlam", "CONTAINS");
        // Nested lambda (CLOSURE inside CLOSURE): pins the CLOSURE→CLOSURE
        // hop of the fn_owner recursion.
        named_node(&mut v, "f_nested", "<lambda>", "CLOSURE", "svc.java");
        edge(&mut v, "f_lambda", "f_nested", "CONTAINS");
        named_node(&mut v, "c_innested", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_innested"), r#"{"method":true,"argCount":0}"#);
        edge(&mut v, "f_nested", "c_innested", "CONTAINS");
        // Expression-body lambda inside a CONSTRUCTOR — the LEGACY-PARITY
        // arm: LambdaExpr pushes no withEnclosingFn, so legacy emits this
        // edge via the leaked [in:Service] sid; the pack must too.
        named_node(&mut v, "f_lamctor", "<lambda>", "CLOSURE", "svc.java");
        edge(&mut v, "m_ctor", "f_lamctor", "CONTAINS");
        named_node(&mut v, "c_inlamctor", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_inlamctor"), r#"{"method":true,"argCount":0}"#);
        edge(&mut v, "f_lamctor", "c_inlamctor", "CONTAINS");
        // Lambda in a FIELD INITIALIZER: the CLOSURE's CONTAINS parent is
        // the CLASS — the fn_owner chain stops, nothing derives (legacy:
        // nothing on both lambda kinds).
        named_node(&mut v, "f_lamfield", "<lambda>", "CLOSURE", "svc.java");
        edge(&mut v, "c_svc", "f_lamfield", "CONTAINS");
        named_node(&mut v, "c_inlamfield", "helper", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_inlamfield"), r#"{"method":true,"argCount":0}"#);
        edge(&mut v, "f_lamfield", "c_inlamfield", "CONTAINS");

        // S12: static-style call.
        named_node(&mut v, "c_static", "format", "CALL", "svc.java");
        v.put_node_metadata(id_of("c_static"), r#"{"method":true,"argCount":1,"receiver":"Util"}"#);
        edge(&mut v, "m_run", "c_static", "CONTAINS");

        // S13: this() / super() inside the first ctor.
        named_node(&mut v, "c_thisc", "this", "CALL", "svc.java");
        v.put_node_metadata(
            id_of("c_thisc"),
            r#"{"kind":"constructor_call","method":false,"argCount":0,"isThis":true}"#,
        );
        edge(&mut v, "m_ctor", "c_thisc", "CONTAINS");
        named_node(&mut v, "c_superc", "super", "CALL", "svc.java");
        v.put_node_metadata(
            id_of("c_superc"),
            r#"{"kind":"constructor_call","method":false,"argCount":0,"isThis":false}"#,
        );
        edge(&mut v, "m_ctor", "c_superc", "CONTAINS");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JAVA_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("java_calls.dl evaluates");

        assert_eq!(
            id_pairs(&eval, "instantiates"),
            BTreeSet::from([(id_of("c_new"), id_of("c_svc")), (id_of("c_newpt"), id_of("r_pt"))]),
            "INSTANTIATES: class + record; unknown class and the .kt call derive nothing"
        );
        assert_eq!(
            id_pairs(&eval, "ctor_calls"),
            BTreeSet::from([
                (id_of("c_new"), id_of("m_ctor")),
                (id_of("c_new"), id_of("m_ctor2")),
                (id_of("c_newpt"), id_of("m_cc")),
            ]),
            "ctor CALLS: ALL ctors (DELTA 2) + the compact ctor via the CONTAINS arm"
        );
        assert_eq!(
            id_pairs(&eval, "same_class_calls"),
            BTreeSet::from([
                (id_of("c_plain"), id_of("m_helper")),
                (id_of("c_this_recv"), id_of("m_helper")),
                (id_of("c_inlam"), id_of("m_helper")),
                (id_of("c_innested"), id_of("m_helper")),
                (id_of("c_inlamctor"), id_of("m_helper")),
            ]),
            "same-class CALLS (DELTA 3): ordinary-method-body + this-receiver + CLOSURE-lifted \
             (single, nested, and the ctor-expression-lambda LEGACY-PARITY arm) resolve; \
             foreign receiver, field-initializer, and field-initializer-lambda derive nothing"
        );
        assert_eq!(
            id_pairs(&eval, "static_calls"),
            BTreeSet::from([(id_of("c_static"), id_of("m_stat"))]),
            "static-style CALLS: class-named receiver only"
        );
        assert_eq!(
            id_pairs(&eval, "this_ctor_calls"),
            BTreeSet::from([
                (id_of("c_thisc"), id_of("m_ctor")),
                (id_of("c_thisc"), id_of("m_ctor2")),
            ]),
            "this() delegation: all same-class ctors (DELTA 2)"
        );
        assert_eq!(
            id_pairs(&eval, "super_ctor_calls"),
            BTreeSet::from([(id_of("c_superc"), id_of("m_bctor"))]),
            "super() delegation: the superclass ctor via extends metadata"
        );
        let calls_heads: BTreeSet<&str> = specs
            .iter()
            .filter(|s| s.edge_type == "CALLS")
            .map(|s| s.predicate.as_str())
            .collect();
        assert_eq!(
            calls_heads,
            BTreeSet::from([
                "ctor_calls",
                "same_class_calls",
                "static_calls",
                "this_ctor_calls",
                "super_ctor_calls"
            ]),
            "the 5 CALLS producers materialize"
        );
        assert!(
            specs.iter().any(|s| s.edge_type == "INSTANTIATES" && s.predicate == "instantiates"),
            "INSTANTIATES materializes"
        );
        assert!(
            specs.iter().all(|s| s.additive && s.meta.is_empty()),
            "every head additive with empty meta"
        );
    }

    /// java_annotations.dl — the S14 surface:
    /// - happy path: ATTRIBUTE "Marker" → ANNOTATION_TYPE Marker;
    /// - DELTA 1 pin: a duplicate same-named ANNOTATION_TYPE — an edge per
    ///   candidate (legacy Map kept one);
    /// - .java gates BOTH ways (load-bearing — kotlin emits both node
    ///   types): a .kt ATTRIBUTE never resolves, and a .kt ANNOTATION_TYPE
    ///   is never a target;
    /// - unknown annotation name derives nothing.
    #[test]
    fn java_annotations_pack_resolves_attributes() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "an_1", "Marker", "ANNOTATION_TYPE", "marker.java");
        named_node(&mut v, "an_2", "Marker", "ANNOTATION_TYPE", "marker2.java");
        named_node(&mut v, "an_kt", "KMark", "ANNOTATION_TYPE", "mark.kt");
        named_node(&mut v, "at_1", "Marker", "ATTRIBUTE", "app.java");
        named_node(&mut v, "at_kt", "Marker", "ATTRIBUTE", "app.kt");
        named_node(&mut v, "at_k2", "KMark", "ATTRIBUTE", "app.java");
        named_node(&mut v, "at_none", "NoSuch", "ATTRIBUTE", "app.java");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JAVA_ANNOTATIONS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("java_annotations.dl evaluates");

        assert_eq!(
            id_pairs(&eval, "ann_resolves"),
            BTreeSet::from([
                (id_of("at_1"), id_of("an_1")),
                (id_of("at_1"), id_of("an_2")),
            ]),
            "ANNOTATION_RESOLVES_TO: both same-named candidates (DELTA 1); the .kt \
             attribute, the .kt-declared target and the unknown name derive nothing"
        );
        assert_eq!(specs.len(), 1, "one head");
        assert!(
            specs[0].edge_type == "ANNOTATION_RESOLVES_TO"
                && specs[0].additive
                && specs[0].meta.is_empty(),
            "additive empty-meta ANNOTATION_RESOLVES_TO"
        );
    }

    // ── Go wave: fixture tests per arm (ports of go-resolve/test/Spec.hs:50-301
    //    plus the numbered-delta predictions — predictions FIRST, in the assert
    //    messages). The dogfood graph has ZERO Go nodes (spec probe + the
    //    Datalog re-probe), so these fixtures + the GRAFEMA_GO_DIFF_DB repo
    //    harness in differential.rs ARE the differential ground truth. ──────

    /// The GO module-path WORKSPACE_PACKAGE fact (orchestrator P1 shape).
    fn go_mod_fact(v: &mut FixtureStorageView, module_path: &str) {
        let sid = format!("go.mod->WORKSPACE_PACKAGE->{module_path}");
        named_node(v, &sid, module_path, "WORKSPACE_PACKAGE", "go.mod");
        v.put_node_metadata(id_of(&sid), r#"{"language":"go"}"#);
    }

    fn derived_pairs(v: &FixtureStorageView, src: &str, pred: &str) -> BTreeSet<(u128, u128)> {
        let eval = evaluate(v, src, Stats::default(), EvalLimits::none(), EventLog::discard())
            .unwrap_or_else(|e| panic!("pack evaluates: {e}"));
        eval.facts(pred)
            .into_iter()
            .map(|r| {
                (
                    r[0].as_id().expect("src id"),
                    r[1].as_id().expect("dst id"),
                )
            })
            .collect()
    }

    /// go_imports — Spec.hs:52-92 ported: same-module hit, stdlib skip,
    /// third-party skip, the root-package arm, the per-MODULE multiplicity
    /// (DELTA G2-2), the exact-isStdLib dot-less-module-path skip (DELTA G2-1
    /// CLOSED), the plain-stripPrefix boundary bug removal, and pack inertness
    /// without the P1 fact.
    #[test]
    fn go_imports_same_module_arms_on_fixture() {
        let mut v = FixtureStorageView::new(1);
        go_mod_fact(&mut v, "github.com/user/project");
        // Target package with TWO files (DELTA G2-2) + a root-level module.
        node(&mut v, "mod_auth1", "MODULE", "pkg/auth/auth.go");
        node(&mut v, "mod_auth2", "MODULE", "pkg/auth/token.go");
        node(&mut v, "mod_root", "MODULE", "main.go");
        // Importers (all metadata `path`, the analyzer contract Imports.hs:73-79).
        named_node(&mut v, "imp_auth", "github.com/user/project/pkg/auth", "IMPORT", "cmd/main.go");
        v.put_node_metadata(id_of("imp_auth"), r#"{"path":"github.com/user/project/pkg/auth"}"#);
        named_node(&mut v, "imp_fmt", "fmt", "IMPORT", "cmd/main.go");
        v.put_node_metadata(id_of("imp_fmt"), r#"{"path":"fmt"}"#);
        named_node(&mut v, "imp_3p", "github.com/sirupsen/logrus", "IMPORT", "cmd/main.go");
        v.put_node_metadata(id_of("imp_3p"), r#"{"path":"github.com/sirupsen/logrus"}"#);
        named_node(&mut v, "imp_root", "github.com/user/project", "IMPORT", "cmd/main.go");
        v.put_node_metadata(id_of("imp_root"), r#"{"path":"github.com/user/project"}"#);
        // The legacy plain-stripPrefix boundary bug shape: module path is a
        // non-'/'-boundary string prefix — must NOT resolve (legacy missed too).
        node(&mut v, "mod_p2", "MODULE", "roject2/x/x.go");
        named_node(&mut v, "imp_p2", "github.com/user/project2/x", "IMPORT", "cmd/main.go");
        v.put_node_metadata(id_of("imp_p2"), r#"{"path":"github.com/user/project2/x"}"#);
        // A non-go IMPORT with a go-looking path must be gated out (DELTA-5 file gate).
        named_node(&mut v, "imp_js", "github.com/user/project/pkg/auth", "IMPORT", "app.ts");
        v.put_node_metadata(id_of("imp_js"), r#"{"path":"github.com/user/project/pkg/auth"}"#);

        let pairs = derived_pairs(&v, GO_IMPORTS_DL, "go_import_from");
        assert_eq!(
            pairs,
            BTreeSet::from([
                // PREDICTION DELTA G2-2: one edge per MODULE in the package dir
                // (legacy: first module only).
                (id_of("imp_auth"), id_of("mod_auth1")),
                (id_of("imp_auth"), id_of("mod_auth2")),
                // Root-package arm: P == module path → the "" directory.
                (id_of("imp_root"), id_of("mod_root")),
            ]),
            "stdlib/third-party/boundary-bug/non-go importers derive nothing; \
             same-module derives per-MODULE (G2-2); root import hits main.go"
        );

        // Dot-less module path (G2-1 CLOSED): legacy isStdLib skips
        // "myapp/util" BEFORE prefix-stripping — the exact first_segment gate
        // reproduces the skip.
        let mut v2 = FixtureStorageView::new(1);
        go_mod_fact(&mut v2, "myapp");
        node(&mut v2, "mod_util", "MODULE", "util/u.go");
        named_node(&mut v2, "imp_util", "myapp/util", "IMPORT", "main.go");
        v2.put_node_metadata(id_of("imp_util"), r#"{"path":"myapp/util"}"#);
        assert!(
            derived_pairs(&v2, GO_IMPORTS_DL, "go_import_from").is_empty(),
            "dot-less module path: legacy isStdLib skips it — exact gate, no edge (G2-1 closed)"
        );

        // No P1 fact ⇒ the module-prefix arms are inert (the nomod VARIANT
        // owns that world — orchestrator-selected, P3).
        let mut v3 = FixtureStorageView::new(1);
        node(&mut v3, "mod_a", "MODULE", "pkg/auth/auth.go");
        named_node(&mut v3, "imp_a", "example.com/pkg/auth", "IMPORT", "main.go");
        v3.put_node_metadata(id_of("imp_a"), r#"{"path":"example.com/pkg/auth"}"#);
        assert!(
            derived_pairs(&v3, GO_IMPORTS_DL, "go_import_from").is_empty(),
            "without the go.mod fact the main pack derives nothing"
        );
    }

    /// go_imports_nomod — Spec.hs:80-85 ported (empty-modPath suffix fallback)
    /// plus the G2-3a all-matches SUPERSET and the G2-3b '/'-boundary
    /// refinement predictions.
    #[test]
    fn go_imports_nomod_suffix_fallback_on_fixture() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "mod_auth", "MODULE", "pkg/auth/auth.go");
        named_node(&mut v, "imp_auth", "example.com/pkg/auth", "IMPORT", "main.go");
        v.put_node_metadata(id_of("imp_auth"), r#"{"path":"example.com/pkg/auth"}"#);
        // G2-3b: dir "auth" is a RAW suffix of ".../oauth" (legacy false
        // positive) but NOT a '/'-boundary suffix — pack must NOT match.
        named_node(&mut v, "imp_oauth", "example.com/pkg/oauth", "IMPORT", "main.go");
        v.put_node_metadata(id_of("imp_oauth"), r#"{"path":"example.com/pkg/oauth"}"#);
        node(&mut v, "mod_rawauth", "MODULE", "auth/a.go");
        // stdlib skip applies in the fallback too ("fmt" — even with a local
        // dir literally named fmt).
        named_node(&mut v, "imp_fmt", "fmt", "IMPORT", "main.go");
        v.put_node_metadata(id_of("imp_fmt"), r#"{"path":"fmt"}"#);
        node(&mut v, "mod_fmt", "MODULE", "fmt/f.go");
        // G2-3a: two dirs share the boundary suffix → ALL matches derived.
        node(&mut v, "mod_u1", "MODULE", "a/util/u.go");
        node(&mut v, "mod_u2", "MODULE", "util/u.go");
        named_node(&mut v, "imp_util", "example.com/a/util", "IMPORT", "main.go");
        v.put_node_metadata(id_of("imp_util"), r#"{"path":"example.com/a/util"}"#);

        let pairs = derived_pairs(&v, GO_IMPORTS_NOMOD_DL, "go_import_suffix");
        assert_eq!(
            pairs,
            BTreeSet::from([
                // "pkg/auth" and "auth" are both '/'-boundary suffixes of the
                // auth import — but only pkg/auth/... has modules at "pkg/auth";
                // "auth/a.go"'s dir IS "auth", also a boundary suffix → both.
                (id_of("imp_auth"), id_of("mod_auth")),
                (id_of("imp_auth"), id_of("mod_rawauth")),
                // PREDICTION G2-3a: all suffix matches (legacy: alphabetical first).
                (id_of("imp_util"), id_of("mod_u1")),
                (id_of("imp_util"), id_of("mod_u2")),
            ]),
            "boundary-suffix matches only (G2-3b drops the …/oauth raw-suffix \
             false positive); stdlib skipped; all matches derived (G2-3a)"
        );
    }

    /// go_calls — Spec.hs:98-146 ported: the three strategies, the EXCLUSIVE
    /// dispatch, the stdlib skip on S1, closure/interface_method exclusion,
    /// the cross-package S2 miss, and the G3-1 duplicate-(dir,name) SUPERSET.
    #[test]
    fn go_calls_three_strategies_and_dispatch_on_fixture() {
        let mut v = FixtureStorageView::new(1);
        go_mod_fact(&mut v, "github.com/user/project");

        // S1: package-qualified via same-file import alias.
        node(&mut v, "mod_utils", "MODULE", "pkg/utils/utils.go");
        named_node(&mut v, "fn_do", "DoStuff", "FUNCTION", "pkg/utils/utils.go");
        v.put_node_metadata(id_of("fn_do"), r#"{"kind":"function"}"#);
        named_node(&mut v, "imp_utils", "github.com/user/project/pkg/utils", "IMPORT", "cmd/main.go");
        v.put_node_metadata(
            id_of("imp_utils"),
            r#"{"path":"github.com/user/project/pkg/utils","local_name":"utils"}"#,
        );
        named_node(&mut v, "call_do", "utils.DoStuff", "CALL", "cmd/main.go");
        v.put_node_metadata(id_of("call_do"), r#"{"receiver":"utils"}"#);

        // S1 stdlib skip: alias to "fmt" — even with a same-name local function.
        named_node(&mut v, "imp_fmt", "fmt", "IMPORT", "cmd/main.go");
        v.put_node_metadata(id_of("imp_fmt"), r#"{"path":"fmt","local_name":"fmt"}"#);
        named_node(&mut v, "call_println", "fmt.Println", "CALL", "cmd/main.go");
        v.put_node_metadata(id_of("call_println"), r#"{"receiver":"fmt"}"#);
        named_node(&mut v, "fn_println", "Println", "FUNCTION", "fmt/print.go");
        v.put_node_metadata(id_of("fn_println"), r#"{"kind":"function"}"#);

        // Dispatch exclusivity: receiver matches an alias whose path is
        // stdlib AND a method index entry exists for (receiver, name) —
        // legacy dispatches S1 ONLY (alias match), which skips; S3 must NOT
        // fire (Hs:163-174).
        named_node(&mut v, "m_trap", "Println", "FUNCTION", "pkg/trap.go");
        v.put_node_metadata(id_of("m_trap"), r#"{"kind":"method","receiver":"fmt"}"#);

        // S2: same-package receiverless call (sub-dir AND root-dir shapes).
        named_node(&mut v, "fn_helper", "helper", "FUNCTION", "pkg/util.go");
        v.put_node_metadata(id_of("fn_helper"), r#"{"kind":"function"}"#);
        named_node(&mut v, "call_helper", "helper", "CALL", "pkg/main.go");
        named_node(&mut v, "fn_rootfn", "rootFn", "FUNCTION", "tool.go");
        v.put_node_metadata(id_of("fn_rootfn"), r#"{"kind":"function"}"#);
        named_node(&mut v, "call_rootfn", "rootFn", "CALL", "main.go");
        // Cross-package S2 miss (Spec.hs:134-139).
        named_node(&mut v, "call_cross", "helper", "CALL", "cmd/main.go");
        // Closure exclusion (Spec.hs:141-146): kind=closure never indexed.
        named_node(&mut v, "fn_clo", "<closure>", "FUNCTION", "pkg/main.go");
        v.put_node_metadata(id_of("fn_clo"), r#"{"kind":"closure"}"#);
        named_node(&mut v, "call_clo", "<closure>", "CALL", "pkg/main.go");
        // G3-1: duplicate (dir, name) — a _test.go sibling defines helper too.
        named_node(&mut v, "fn_helper2", "helper", "FUNCTION", "pkg/util_test.go");
        v.put_node_metadata(id_of("fn_helper2"), r#"{"kind":"function"}"#);

        // S3: method call where a variable shares the type's name (Spec.hs:120-127).
        named_node(&mut v, "m_start", "Start", "FUNCTION", "pkg/server.go");
        v.put_node_metadata(id_of("m_start"), r#"{"kind":"method","receiver":"Server"}"#);
        named_node(&mut v, "call_start", "s.Start", "CALL", "pkg/main.go");
        v.put_node_metadata(id_of("call_start"), r#"{"receiver":"Server"}"#);
        // Unknown receiver (Spec.hs:128-132): no edge.
        named_node(&mut v, "call_unk", "x.Unknown", "CALL", "pkg/main.go");
        v.put_node_metadata(id_of("call_unk"), r#"{"receiver":"x"}"#);

        let eval = evaluate(&v, GO_CALLS_DL, Stats::default(), EvalLimits::none(), EventLog::discard())
            .expect("go_calls.dl evaluates");
        let mut pairs: BTreeSet<(u128, u128)> = BTreeSet::new();
        for pred in ["go_call_s1", "go_call_s2", "go_call_s3"] {
            for r in eval.facts(pred) {
                pairs.insert((r[0].as_id().unwrap(), r[1].as_id().unwrap()));
            }
        }
        assert_eq!(
            pairs,
            BTreeSet::from([
                (id_of("call_do"), id_of("fn_do")),
                // PREDICTION G3-1: both same-(dir,name) functions derived
                // (legacy last-wins picked one).
                (id_of("call_helper"), id_of("fn_helper")),
                (id_of("call_helper"), id_of("fn_helper2")),
                (id_of("call_rootfn"), id_of("fn_rootfn")),
                (id_of("call_start"), id_of("m_start")),
            ]),
            "S1 alias hit; S1 stdlib skip; S1-only dispatch (no S3 fallback for \
             alias receivers); S2 same-dir + root-dir; S2 cross-package miss; \
             closure excluded; S3 type-named receiver; unknown receiver miss"
        );
    }

    /// go_interfaces — Spec.hs:152-210 ported: subset hit, missing-method
    /// miss, empty-interface miss, multi-struct fan-out, pointer receiver;
    /// plus the G6-2 (struct-side) and G6-3 (interface-side, verdict C3)
    /// name-merge predictions.
    #[test]
    fn go_interfaces_subset_satisfaction_on_fixture() {
        let mut v = FixtureStorageView::new(1);
        // Reader{Read} ⊆ MyReader{Read} → IMPLEMENTS.
        node(&mut v, "iface_reader", "INTERFACE", "io.go");
        named_node(&mut v, "im_read", "Read", "FUNCTION", "io.go");
        v.put_node_metadata(id_of("im_read"), r#"{"kind":"interface_method"}"#);
        edge(&mut v, "iface_reader", "im_read", "CONTAINS");
        named_node(&mut v, "cls_myreader", "MyReader", "CLASS", "reader.go");
        named_node(&mut v, "sm_read", "Read", "FUNCTION", "reader.go");
        v.put_node_metadata(id_of("sm_read"), r#"{"kind":"method","receiver":"MyReader","pointer_receiver":true}"#);
        // ReadWriter{Read,Write} ⊄ MyReader{Read} → no edge (missing Write).
        node(&mut v, "iface_rw", "INTERFACE", "io.go");
        named_node(&mut v, "im_read2", "Read", "FUNCTION", "io.go");
        v.put_node_metadata(id_of("im_read2"), r#"{"kind":"interface_method"}"#);
        named_node(&mut v, "im_write", "Write", "FUNCTION", "io.go");
        v.put_node_metadata(id_of("im_write"), r#"{"kind":"interface_method"}"#);
        edge(&mut v, "iface_rw", "im_read2", "CONTAINS");
        edge(&mut v, "iface_rw", "im_write", "CONTAINS");
        // Empty interface → never satisfied (the non-empty gate via cand seeding).
        node(&mut v, "iface_empty", "INTERFACE", "types.go");
        named_node(&mut v, "cls_any", "Anything", "CLASS", "impl.go");
        // Second struct also implementing Reader (multi-struct fan-out).
        named_node(&mut v, "cls_fr", "FileReader", "CLASS", "file.go");
        named_node(&mut v, "sm_fread", "Read", "FUNCTION", "file.go");
        v.put_node_metadata(id_of("sm_fread"), r#"{"kind":"method","receiver":"FileReader"}"#);

        let pairs = derived_pairs(&v, GO_INTERFACES_DL, "go_implements");
        assert_eq!(
            pairs,
            BTreeSet::from([
                (id_of("cls_myreader"), id_of("iface_reader")),
                (id_of("cls_fr"), id_of("iface_reader")),
            ]),
            "subset hit (pointer receiver matches by bare name); missing-method \
             and empty-interface miss; one edge per implementing struct"
        );

        // PREDICTION G6-3 (verdict C3): duplicate interface NAMES — legacy
        // unions their method sets ({Read} ∪ {Close} = {Read,Close}, rejecting
        // a Read-only struct) and the per-NODE pack accepts the {Read} node.
        let mut v2 = FixtureStorageView::new(1);
        named_node(&mut v2, "if_a", "Reader", "INTERFACE", "a.go");
        named_node(&mut v2, "ifm_a", "Read", "FUNCTION", "a.go");
        v2.put_node_metadata(id_of("ifm_a"), r#"{"kind":"interface_method"}"#);
        edge(&mut v2, "if_a", "ifm_a", "CONTAINS");
        named_node(&mut v2, "if_b", "Reader", "INTERFACE", "b.go");
        named_node(&mut v2, "ifm_b", "Close", "FUNCTION", "b.go");
        v2.put_node_metadata(id_of("ifm_b"), r#"{"kind":"interface_method"}"#);
        edge(&mut v2, "if_b", "ifm_b", "CONTAINS");
        named_node(&mut v2, "cls_r", "R", "CLASS", "r.go");
        named_node(&mut v2, "rm", "Read", "FUNCTION", "r.go");
        v2.put_node_metadata(id_of("rm"), r#"{"kind":"method","receiver":"R"}"#);
        // PREDICTION G6-2: a same-named CLASS twin also receives the edge.
        named_node(&mut v2, "cls_r2", "R", "CLASS", "r2.go");
        let pairs2 = derived_pairs(&v2, GO_INTERFACES_DL, "go_implements");
        assert_eq!(
            pairs2,
            BTreeSet::from([
                (id_of("cls_r"), id_of("if_a")),
                (id_of("cls_r2"), id_of("if_a")),
            ]),
            "G6-3: per-NODE requirement sets (legacy's name-union rejected this); \
             G6-2: every same-named CLASS gets the edge (legacy last-wins one)"
        );
    }

    /// go_types — TYPE_OF + RETURNS: recursive prefix strip, primitive skip,
    /// comma-peel of return_type, map/chan non-resolution, INTERFACE targets,
    /// and the G7-1 duplicate-type-name SUPERSET.
    #[test]
    fn go_types_type_of_and_returns_on_fixture() {
        let mut v = FixtureStorageView::new(1);
        named_node(&mut v, "cls_user", "User", "CLASS", "user.go");
        named_node(&mut v, "if_store", "Store", "INTERFACE", "store.go");
        // *User → User; []byte → primitive skip; []*User → User;
        // map[string]User → no type_node key; int → primitive skip.
        named_node(&mut v, "var_ptr", "u", "VARIABLE", "main.go");
        v.put_node_metadata(id_of("var_ptr"), r#"{"type":"*User"}"#);
        named_node(&mut v, "var_bytes", "b", "VARIABLE", "main.go");
        v.put_node_metadata(id_of("var_bytes"), r#"{"type":"[]byte"}"#);
        named_node(&mut v, "var_slice", "us", "VARIABLE", "main.go");
        v.put_node_metadata(id_of("var_slice"), r#"{"type":"[]*User"}"#);
        named_node(&mut v, "var_map", "m", "VARIABLE", "main.go");
        v.put_node_metadata(id_of("var_map"), r#"{"type":"map[string]User"}"#);
        named_node(&mut v, "var_int", "n", "VARIABLE", "main.go");
        v.put_node_metadata(id_of("var_int"), r#"{"type":"int"}"#);
        named_node(&mut v, "var_iface", "s", "VARIABLE", "main.go");
        v.put_node_metadata(id_of("var_iface"), r#"{"type":"Store"}"#);

        let pairs = derived_pairs(&v, GO_TYPES_DL, "go_type_of");
        assert_eq!(
            pairs,
            BTreeSet::from([
                (id_of("var_ptr"), id_of("cls_user")),
                (id_of("var_slice"), id_of("cls_user")),
                (id_of("var_iface"), id_of("if_store")),
            ]),
            "*/[] strip recursion; primitives and map types never resolve; \
             INTERFACE is a type target"
        );

        // RETURNS: "*User,error" → User only (error is a primitive);
        // "User,Store" → both; single "Config" → identity (no comma).
        named_node(&mut v, "fn_a", "loadUser", "FUNCTION", "main.go");
        v.put_node_metadata(id_of("fn_a"), r#"{"kind":"function","return_type":"*User,error"}"#);
        named_node(&mut v, "fn_b", "both", "FUNCTION", "main.go");
        v.put_node_metadata(id_of("fn_b"), r#"{"kind":"function","return_type":"User,Store"}"#);
        named_node(&mut v, "cls_cfg", "Config", "CLASS", "cfg.go");
        named_node(&mut v, "fn_c", "cfg", "FUNCTION", "main.go");
        v.put_node_metadata(id_of("fn_c"), r#"{"kind":"function","return_type":"Config"}"#);
        // G7-1: a duplicate type name — both nodes derived (legacy last-wins).
        named_node(&mut v, "cls_cfg2", "Config", "CLASS", "cfg2.go");

        let pairs = derived_pairs(&v, GO_TYPES_DL, "go_returns");
        assert_eq!(
            pairs,
            BTreeSet::from([
                (id_of("fn_a"), id_of("cls_user")),
                (id_of("fn_b"), id_of("cls_user")),
                (id_of("fn_b"), id_of("if_store")),
                (id_of("fn_c"), id_of("cls_cfg")),
                // PREDICTION G7-1: duplicate type names fan out.
                (id_of("fn_c"), id_of("cls_cfg2")),
            ]),
            "comma-peel splits return_type exactly; error primitive skipped; \
             duplicate type names fan out (G7-1)"
        );
    }

    /// go_context — Spec.hs:216-302 ported onto the structural CONTAINS seam:
    /// the certain/possible target × caller matrix, goroutine/deferred arms,
    /// the unresolved meta column, closure- and module-contained calls
    /// (G9-1/G9-3 — the pack derives what legacy INTENDED; on real analyzer
    /// ids legacy's caller lookup never matched, see the .dl header).
    #[test]
    fn go_context_propagation_matrix_on_fixture() {
        let mut v = FixtureStorageView::new(1);
        // fnA (accepts) contains callB → fnB (accepts): PROPAGATES, no meta.
        named_node(&mut v, "fn_a", "A", "FUNCTION", "pkg/handler.go");
        v.put_node_metadata(id_of("fn_a"), r#"{"kind":"function","accepts_context":true}"#);
        named_node(&mut v, "fn_b", "B", "FUNCTION", "pkg/service.go");
        v.put_node_metadata(id_of("fn_b"), r#"{"kind":"function","accepts_context":true}"#);
        named_node(&mut v, "call_b", "B", "CALL", "pkg/handler.go");
        edge(&mut v, "fn_a", "call_b", "CONTAINS");
        edge(&mut v, "call_b", "fn_b", "CALLS");
        // goroutine: SPAWNS + PROPAGATES (Spec.hs:231-243).
        named_node(&mut v, "fn_worker", "worker", "FUNCTION", "pkg/main.go");
        v.put_node_metadata(id_of("fn_worker"), r#"{"kind":"function","accepts_context":true}"#);
        named_node(&mut v, "call_w", "worker", "CALL", "pkg/main.go");
        v.put_node_metadata(id_of("call_w"), r#"{"goroutine":true}"#);
        edge(&mut v, "fn_a2", "call_w", "CONTAINS");
        named_node(&mut v, "fn_a2", "main", "FUNCTION", "pkg/main.go");
        v.put_node_metadata(id_of("fn_a2"), r#"{"kind":"function","accepts_context":true}"#);
        edge(&mut v, "call_w", "fn_worker", "CALLS");
        // deferred: DEFERS + PROPAGATES (Spec.hs:257-269).
        named_node(&mut v, "fn_cleanup", "cleanup", "FUNCTION", "pkg/api.go");
        v.put_node_metadata(id_of("fn_cleanup"), r#"{"kind":"function","accepts_context":true}"#);
        named_node(&mut v, "call_d", "cleanup", "CALL", "pkg/api.go");
        v.put_node_metadata(id_of("call_d"), r#"{"deferred":true}"#);
        edge(&mut v, "fn_a", "call_d", "CONTAINS");
        edge(&mut v, "call_d", "fn_cleanup", "CALLS");
        // No-context target: nothing (Spec.hs:245-255).
        named_node(&mut v, "fn_c", "C", "FUNCTION", "pkg/util.go");
        v.put_node_metadata(id_of("fn_c"), r#"{"kind":"function"}"#);
        named_node(&mut v, "call_c", "C", "CALL", "pkg/handler.go");
        edge(&mut v, "fn_a", "call_c", "CONTAINS");
        edge(&mut v, "call_c", "fn_c", "CALLS");
        // possible → possible: meta unresolved="true" (Spec.hs:271-286).
        named_node(&mut v, "fn_pa", "PA", "FUNCTION", "pkg/p.go");
        v.put_node_metadata(id_of("fn_pa"), r#"{"kind":"function","possible_context":true}"#);
        named_node(&mut v, "fn_pb", "PB", "FUNCTION", "pkg/p.go");
        v.put_node_metadata(id_of("fn_pb"), r#"{"kind":"function","possible_context":true}"#);
        named_node(&mut v, "call_pb", "PB", "CALL", "pkg/p.go");
        edge(&mut v, "fn_pa", "call_pb", "CONTAINS");
        edge(&mut v, "call_pb", "fn_pb", "CALLS");
        // possible caller → CERTAIN target: plain edge, NO meta (Spec.hs:288-301).
        named_node(&mut v, "call_b2", "B", "CALL", "pkg/p.go");
        edge(&mut v, "fn_pa", "call_b2", "CONTAINS");
        edge(&mut v, "call_b2", "fn_b", "CALLS");
        // Call inside a CLOSURE: no PROPAGATES (caller excluded) but SPAWNS
        // still fires (caller-independent).
        named_node(&mut v, "fn_clo", "<closure>", "FUNCTION", "pkg/z.go");
        v.put_node_metadata(id_of("fn_clo"), r#"{"kind":"closure"}"#);
        named_node(&mut v, "call_z", "B", "CALL", "pkg/z.go");
        v.put_node_metadata(id_of("call_z"), r#"{"goroutine":true}"#);
        edge(&mut v, "fn_clo", "call_z", "CONTAINS");
        edge(&mut v, "call_z", "fn_b", "CALLS");
        // Top-level call (CONTAINS from MODULE): no PROPAGATES.
        node(&mut v, "mod_top", "MODULE", "pkg/t.go");
        named_node(&mut v, "call_t", "B", "CALL", "pkg/t.go");
        edge(&mut v, "mod_top", "call_t", "CONTAINS");
        edge(&mut v, "call_t", "fn_b", "CALLS");

        let eval = evaluate(&v, GO_CONTEXT_DL, Stats::default(), EvalLimits::none(), EventLog::discard())
            .expect("go_context.dl evaluates");
        let prop: BTreeSet<(u128, u128)> = eval
            .facts("go_prop")
            .into_iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap()))
            .collect();
        assert_eq!(
            prop,
            BTreeSet::from([
                (id_of("fn_a"), id_of("fn_b")),
                (id_of("fn_a2"), id_of("fn_worker")),
                (id_of("fn_a"), id_of("fn_cleanup")),
                // Possible caller + certain target rides the PLAIN head.
                (id_of("fn_pa"), id_of("fn_b")),
            ]),
            "certain-target PROPAGATES: enclosing fn via CONTAINS; closure- and \
             module-contained calls excluded; no-context target inert"
        );
        let prop_u: BTreeSet<(u128, u128, String)> = eval
            .facts("go_prop_u")
            .into_iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap(), r[2].as_str()))
            .collect();
        assert_eq!(
            prop_u,
            BTreeSet::from([(id_of("fn_pa"), id_of("fn_pb"), "true".to_string())]),
            "possible-target edges carry unresolved=\"true\" (G9-2 projection); \
             the certain-target row must NOT appear here (Spec.hs:288-301)"
        );
        let spawns: BTreeSet<(u128, u128)> = eval
            .facts("go_spawn")
            .into_iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap()))
            .collect();
        assert_eq!(
            spawns,
            BTreeSet::from([
                (id_of("call_w"), id_of("fn_worker")),
                // Caller-independent: the closure-contained goroutine still spawns.
                (id_of("call_z"), id_of("fn_b")),
            ]),
            "SPAWNS is caller-independent (legacy :177-185)"
        );
        let defers: BTreeSet<(u128, u128)> = eval
            .facts("go_defer")
            .into_iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap()))
            .collect();
        assert_eq!(
            defers,
            BTreeSet::from([(id_of("call_d"), id_of("fn_cleanup"))]),
            "DEFERS for deferred calls with certain-context targets"
        );
    }

    /// Every go pack declares its @materialize heads with the expected edge
    /// types and ADDITIVE mode (shared vocabulary — never tombstone), and the
    /// unresolved meta column rides only the *_u context heads.
    #[test]
    fn go_packs_declare_additive_materialization() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "m", "MODULE", "a.go");
        for (src, expected) in [
            (GO_IMPORTS_DL, vec!["IMPORTS_FROM"]),
            (GO_IMPORTS_NOMOD_DL, vec!["IMPORTS_FROM"]),
            (GO_CALLS_DL, vec!["CALLS", "CALLS", "CALLS"]),
            (GO_INTERFACES_DL, vec!["IMPLEMENTS"]),
            (GO_TYPES_DL, vec!["TYPE_OF", "RETURNS"]),
            (
                GO_CONTEXT_DL,
                vec![
                    "PROPAGATES_CONTEXT",
                    "PROPAGATES_CONTEXT",
                    "SPAWNS_WITH_CONTEXT",
                    "SPAWNS_WITH_CONTEXT",
                    "DEFERS_WITH_CONTEXT",
                    "DEFERS_WITH_CONTEXT",
                ],
            ),
        ] {
            let (_eval, specs, node_specs) = evaluate_with_materialize(
                &v,
                src,
                Stats::default(),
                EvalLimits::none(),
                EventLog::discard(),
            )
            .expect("go pack evaluates with materialize");
            let mut types: Vec<&str> = specs.iter().map(|s| s.edge_type.as_str()).collect();
            let mut want = expected.clone();
            types.sort_unstable();
            want.sort_unstable();
            assert_eq!(types, want, "edge-type heads of a go pack");
            assert!(
                specs.iter().all(|s| s.additive),
                "every go head is additive (shared vocabulary)"
            );
            assert!(
                node_specs.is_empty(),
                "go packs materialize edges only, no nodes"
            );
        }
    }

    /// RFD-75 — version_coords_nodes mints one `version:coord` node per DISTINCT
    /// coord carried by the committed version:ref nodes' metadata, dedups
    /// multiple refs → one coord, and projects `coord` into the minted node's
    /// own metadata via meta(coord).
    #[test]
    fn version_coords_nodes_mints_one_per_distinct_coord() {
        let mut v = FixtureStorageView::new(1);

        // Three refs to the "release" coord (package.version, git.tag, changelog)
        // + two refs to the "@grafema/x" coord (two packages pin it). Five refs,
        // two distinct coords.
        ref_node(&mut v, "r_pkg", "0.4.0", "package.version", "release", "package.json");
        ref_node(&mut v, "r_tag", "0.4.0", "git.tag", "release", "<git>");
        ref_node(&mut v, "r_chg", "0.4.0", "changelog", "release", "CHANGELOG.md");
        ref_node(
            &mut v,
            "r_cli_x",
            "0.4.0",
            "optionalDeps[@grafema/x]",
            "@grafema/x",
            "packages/cli/package.json",
        );
        ref_node(
            &mut v,
            "r_meta_x",
            "0.3.29",
            "optionalDeps[@grafema/x]",
            "@grafema/x",
            "packages/meta/package.json",
        );

        let (eval, _specs, node_specs) = evaluate_with_materialize(
            &v,
            VERSION_COORDS_NODES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("version_coords_nodes.dl evaluates");

        // One vcoord fact per DISTINCT coord (sid, name, file, coord) — refs to
        // the same coord collapse to one row (engine set semantics).
        let minted: BTreeSet<(String, String, String, String)> = eval
            .facts("vcoord")
            .into_iter()
            .map(|r| (r[0].as_str(), r[1].as_str(), r[2].as_str(), r[3].as_str()))
            .collect();
        assert_eq!(
            minted,
            BTreeSet::from([
                (
                    "version:coord::release".to_string(),
                    "release".to_string(),
                    "release".to_string(),
                    "release".to_string()
                ),
                (
                    "version:coord::@grafema/x".to_string(),
                    "@grafema/x".to_string(),
                    "@grafema/x".to_string(),
                    "@grafema/x".to_string()
                ),
            ]),
            "one version:coord per distinct coord; multiple refs → one coord dedup"
        );

        // Spec: exactly one node-materialized head, exclusive, meta(coord).
        assert_eq!(node_specs.len(), 1, "exactly one node-materialized head");
        let ns = &node_specs[0];
        assert_eq!(ns.predicate, "vcoord");
        assert_eq!(ns.node_type, "version:coord");
        assert!(!ns.additive, "exclusive (provenance-scoped) node ownership");
        assert_eq!(ns.meta, vec!["coord".to_string()]);
    }

    /// RFD-75 — version_refs_edges joins the committed version:ref nodes against
    /// the committed version:coord nodes BY COORD NAME and derives REFERS_TO
    /// (ref → coord). Every ref of a coord links to that coord; refs of distinct
    /// coords never cross-link.
    #[test]
    fn version_refs_edges_joins_refs_to_coords_by_name() {
        let mut v = FixtureStorageView::new(1);

        // version:ref EDB (enricher-committed).
        ref_node(&mut v, "r_pkg", "0.4.0", "package.version", "release", "package.json");
        ref_node(&mut v, "r_tag", "0.4.0", "git.tag", "release", "<git>");
        ref_node(
            &mut v,
            "r_cli_x",
            "0.4.0",
            "optionalDeps[@grafema/x]",
            "@grafema/x",
            "packages/cli/package.json",
        );

        // version:coord EDB (version_coords_nodes-committed; coord rides metadata).
        coord_node(&mut v, "release");
        coord_node(&mut v, "@grafema/x");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            VERSION_REFS_EDGES_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("version_refs_edges.dl evaluates");

        let edges: BTreeSet<(u128, u128)> = eval
            .facts("refers_to")
            .into_iter()
            .map(|r| (r[0].as_id().expect("src id"), r[1].as_id().expect("dst id")))
            .collect();
        assert_eq!(
            edges,
            BTreeSet::from([
                (id_of("r_pkg"), id_of("version:coord::release")),
                (id_of("r_tag"), id_of("version:coord::release")),
                (id_of("r_cli_x"), id_of("version:coord::@grafema/x")),
            ]),
            "each ref REFERS_TO its own coord; distinct coords never cross-link"
        );

        let spec = specs
            .iter()
            .find(|s| s.edge_type == "REFERS_TO")
            .expect("REFERS_TO spec");
        assert!(spec.additive, "REFERS_TO is shared vocabulary — additive");
    }

    /// RFD-75 — the `value-lockstep` guarantee TRIPS on connascence drift (two
    /// refs to one coord with different values) and PASSES on lockstep. An
    /// externally-ingested `binary.<name>` ref (the ops release-hook locus —
    /// out of the enricher's scope) participates with NO rule change: the graph
    /// side is uniform, a binary ref REFERS_TO the same coord as package.version.
    #[test]
    fn value_lockstep_guarantee_trips_on_drift_and_includes_binary_ref() {
        // The guarantee rule, verbatim from .grafema/guarantees.yaml.
        const VALUE_LOCKSTEP: &str = r#"
violation(R) :- edge(R, C, "REFERS_TO"), edge(R2, C, "REFERS_TO"),
  neq(R, R2),
  node_attr(R, "value", V1), node_attr(R2, "value", V2),
  neq(V1, V2).
"#;

        // ── Drift case: cli pins @grafema/x = 0.3.29, meta pins 0.4.0; both
        //    REFERS_TO coord @grafema/x. Plus a matched "release" pair (pkg+tag
        //    both 0.4.0) that must NOT trip. Plus a binary ref on "release"
        //    that DOES drift (binary 0.3.29 vs package.version 0.4.0).
        let mut v = FixtureStorageView::new(1);

        ref_node(
            &mut v,
            "r_cli_x",
            "0.3.29",
            "optionalDeps[@grafema/x]",
            "@grafema/x",
            "packages/cli/package.json",
        );
        ref_node(
            &mut v,
            "r_meta_x",
            "0.4.0",
            "optionalDeps[@grafema/x]",
            "@grafema/x",
            "packages/meta/package.json",
        );
        ref_node(&mut v, "r_pkg", "0.4.0", "package.version", "release", "package.json");
        ref_node(&mut v, "r_tag", "0.4.0", "git.tag", "release", "<git>");
        // Externally-ingested binary ref (ops hook) — drifts on the release coord.
        ref_node(&mut v, "r_bin", "0.3.29", "binary.grafema", "release", "<binary>");

        coord_node(&mut v, "@grafema/x");
        coord_node(&mut v, "release");

        // Committed REFERS_TO edges (as version_refs_edges would produce).
        edge(&mut v, "r_cli_x", "version:coord::@grafema/x", "REFERS_TO");
        edge(&mut v, "r_meta_x", "version:coord::@grafema/x", "REFERS_TO");
        edge(&mut v, "r_pkg", "version:coord::release", "REFERS_TO");
        edge(&mut v, "r_tag", "version:coord::release", "REFERS_TO");
        edge(&mut v, "r_bin", "version:coord::release", "REFERS_TO");

        let eval = evaluate(
            &v,
            VALUE_LOCKSTEP,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("value-lockstep rule evaluates");

        let violators: BTreeSet<u128> = eval
            .facts("violation")
            .into_iter()
            .map(|r| r[0].as_id().expect("violation id"))
            .collect();
        // Drift trips for BOTH refs of each drifting pair (R bound to either side).
        // @grafema/x pair: r_cli_x, r_meta_x. release: r_bin drifts vs r_pkg/r_tag,
        // so r_bin, r_pkg, r_tag all appear (each is some R with a differing R2).
        assert!(
            violators.contains(&id_of("r_cli_x")) && violators.contains(&id_of("r_meta_x")),
            "@grafema/x drift (0.3.29 vs 0.4.0) trips value-lockstep"
        );
        assert!(
            violators.contains(&id_of("r_bin")),
            "externally-ingested binary ref participates — drift vs package.version trips"
        );
        assert!(
            !violators.is_empty(),
            "the guarantee TRIPS on drift (not silently passing)"
        );

        // ── Lockstep case: every ref of each coord agrees → NO violation. ──────
        let mut v2 = FixtureStorageView::new(1);
        ref_node(
            &mut v2,
            "r_cli_x",
            "0.4.0",
            "optionalDeps[@grafema/x]",
            "@grafema/x",
            "packages/cli/package.json",
        );
        ref_node(
            &mut v2,
            "r_meta_x",
            "0.4.0",
            "optionalDeps[@grafema/x]",
            "@grafema/x",
            "packages/meta/package.json",
        );
        ref_node(&mut v2, "r_pkg", "0.4.0", "package.version", "release", "package.json");
        ref_node(&mut v2, "r_bin", "0.4.0", "binary.grafema", "release", "<binary>");
        coord_node(&mut v2, "@grafema/x");
        coord_node(&mut v2, "release");
        edge(&mut v2, "r_cli_x", "version:coord::@grafema/x", "REFERS_TO");
        edge(&mut v2, "r_meta_x", "version:coord::@grafema/x", "REFERS_TO");
        edge(&mut v2, "r_pkg", "version:coord::release", "REFERS_TO");
        edge(&mut v2, "r_bin", "version:coord::release", "REFERS_TO");

        let eval2 = evaluate(
            &v2,
            VALUE_LOCKSTEP,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("value-lockstep rule evaluates (lockstep)");
        assert_eq!(
            eval2.facts("violation").len(),
            0,
            "lockstep (all refs of each coord agree) PASSES — no violation"
        );
    }
}
