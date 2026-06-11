//! Datalog v2 standard library — bundled, annotation-light `.dl` rule programs that ship
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
///   `js_property_access_ns` (while legacy resolution stays ON its edges are
///   near-duplicates; once legacy is gated this ordering is load-bearing, and
///   `depends` — which also consumes IMPORTS_FROM and currently runs first on
///   the legacy edges — must move after it); `js_class_inheritance` PRODUCES
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
///   hybrid packs read as committed EDB, so it runs strictly before them
///   (while legacy import-resolution stays ON its edges are near-duplicates;
///   once legacy is gated this ordering is load-bearing, and `depends` must
///   move after it).
/// An orchestrator running the packs sequentially must preserve this order:
/// depends → js_local_refs → js_same_file_calls → js_this_method_calls →
/// rust_calls → rust_cross_methods_ctor → rust_trait_resolve →
/// rust_receiver_typing → rust_imports → js_module_imports →
/// js_import_bindings → js_class_inheritance →
/// js_cross_file_calls → js_property_access_ns → js_property_access_full →
/// js_builtins_nodes → js_builtins_edges → method_calls → shape_verifier →
/// axum_routes.
pub const STDLIB_PACKS: &[(&str, &str)] = &[
    ("depends", DEPENDS_DL),
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
    ("method_calls", METHOD_CALLS_DL),
    ("shape_verifier", SHAPE_VERIFIER_DL),
    ("axum_routes", AXUM_ROUTES_DL),
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
    use crate::datalog2::builtin::Stats;
    use crate::datalog2::events::EventLog;
    use crate::datalog2::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
    use crate::datalog2::{evaluate, evaluate_with_materialize};
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

    /// An edge plus a metadata blob attached to it (for `edge_attr` probes —
    /// PASSES_ARGUMENT `index` etc.).
    fn edge_meta(v: &mut FixtureStorageView, src: &str, dst: &str, ty: &str, meta: &str) {
        edge(v, src, dst, ty);
        v.put_edge_metadata(id_of(src), id_of(dst), ty, meta);
    }

    /// The (src, dst, meta-columns) triples of a 3-ary materialized predicate.
    fn triples(
        eval: &crate::datalog2::exec::Evaluation,
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

    /// PROBE (resolve→datalog2 migration, Wave 0) — ground-facts e2e smoke.
    ///
    /// Proves `Rule::fact` heads (parser-level evidence: `datalog/parser.rs:269`)
    /// survive the FULL v2 pipeline — parse → binding gate → stratify → plan → exec →
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
                "depends",
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
                "method_calls",
                "shape_verifier",
                "axum_routes",
            ],
            "canonical run order: depends → Wave-1 resolver packs → Wave-1b packs \
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
             method_calls → shape_verifier → axum_routes (producers strictly \
             before consumers)"
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
        assert_eq!(stdlib_pack("method_calls"), Some(METHOD_CALLS_DL));
        assert_eq!(stdlib_pack("shape_verifier"), Some(SHAPE_VERIFIER_DL));
        assert_eq!(stdlib_pack("axum_routes"), Some(AXUM_ROUTES_DL));
        assert_eq!(stdlib_pack("nope"), None, "unknown pack name resolves to None");
    }

    /// PROBE 3 (resolve→datalog2 migration, Wave 0) — stratifier acceptance of a
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
        use crate::datalog2::parser_ext::parse_ext_program;
        use crate::datalog2::stratify::stratify;

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

    /// The bundled js_local_refs pack reproduces JsLocalRefs.hs on a fixture covering
    /// every arm, every skip-set, one negative per arm, and the pinned deltas:
    /// - all 8 declaration types resolve a same-file REFERENCE (arm coverage);
    /// - the imported(F,N) skip-set (IMPORT_BINDING) suppresses resolution;
    /// - the rt_global ground-facts skip-list suppresses resolution ("console");
    /// - cross-file declarations never match (file-flat negative);
    /// - non-JS files are gated out (a .rs REFERENCE with a same-file match);
    /// - empty names never match (the resolver's index exclusion);
    /// - DELTA 1 PINNED: duplicate (file,name) declarations derive an edge to EVERY
    ///   candidate (the resolver's Map kept one arbitrary winner — deriving what the
    ///   delta says, not what the resolver did).
    #[test]
    fn js_local_refs_resolves_same_file_decls_with_skip_sets() {
        let mut v = FixtureStorageView::new(1);

        // One declaration + one reference per declaration type (all in app.ts).
        let decls = [
            ("d_fn", "helper", "FUNCTION"),
            ("d_var", "state", "VARIABLE"),
            ("d_const", "LIMIT", "CONSTANT"),
            ("d_class", "Engine", "CLASS"),
            ("d_param", "input", "PARAMETER"),
            ("d_iface", "Shape", "INTERFACE"),
            ("d_enum", "Color", "ENUM"),
            ("d_syn", "Alias", "TYPE_SYNONYM"),
        ];
        for (sid, name, ty) in decls {
            named_node(&mut v, sid, name, ty, "app.ts");
            named_node(&mut v, &format!("r_{sid}"), name, "REFERENCE", "app.ts");
        }

        // Skip-set 1: imported name (IMPORT_BINDING shadows the local FUNCTION).
        named_node(&mut v, "b_ext", "ext", "IMPORT_BINDING", "app.ts");
        named_node(&mut v, "d_ext", "ext", "FUNCTION", "app.ts");
        named_node(&mut v, "r_ext", "ext", "REFERENCE", "app.ts");

        // Skip-set 2: runtime global ("console" is on the 97-name facts list).
        named_node(&mut v, "d_console", "console", "VARIABLE", "app.ts");
        named_node(&mut v, "r_console", "console", "REFERENCE", "app.ts");

        // Negative: declaration only in ANOTHER file.
        named_node(&mut v, "d_far", "far", "FUNCTION", "b.ts");
        named_node(&mut v, "r_far", "far", "REFERENCE", "app.ts");

        // Negative: non-JS file (gate).
        named_node(&mut v, "d_rfn", "rfn", "FUNCTION", "main.rs");
        named_node(&mut v, "r_rfn", "rfn", "REFERENCE", "main.rs");

        // Negative: empty names never match.
        named_node(&mut v, "d_empty", "", "FUNCTION", "app.ts");
        named_node(&mut v, "r_empty", "", "REFERENCE", "app.ts");

        // DELTA 1: duplicate (file,name) decls — derive BOTH.
        named_node(&mut v, "d_dup_v", "dup", "VARIABLE", "app.ts");
        named_node(&mut v, "d_dup_p", "dup", "PARAMETER", "app.ts");
        named_node(&mut v, "r_dup", "dup", "REFERENCE", "app.ts");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_LOCAL_REFS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_local_refs.dl evaluates");

        let mut expected: BTreeSet<(u128, u128, String)> = decls
            .iter()
            .map(|(sid, _, _)| {
                (
                    id_of(&format!("r_{sid}")),
                    id_of(sid),
                    "js-local-refs".to_string(),
                )
            })
            .collect();
        expected.insert((id_of("r_dup"), id_of("d_dup_v"), "js-local-refs".to_string()));
        expected.insert((id_of("r_dup"), id_of("d_dup_p"), "js-local-refs".to_string()));
        assert_eq!(
            triples(&eval, "js_local_ref"),
            expected,
            "all 8 decl types + BOTH dup candidates (DELTA 1); imported/rt_global/\
             cross-file/.rs/empty-name references derive nothing"
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

        // A1: direct call → FUNCTION.
        named_node(&mut v, "f_run", "run", "FUNCTION", "app.ts");
        named_node(&mut v, "c_fn", "run", "CALL", "app.ts");

        // Ladder: FUNCTION beats VARIABLE.
        named_node(&mut v, "f_make", "make", "FUNCTION", "app.ts");
        named_node(&mut v, "v_make", "make", "VARIABLE", "app.ts");
        named_node(&mut v, "c_pref", "make", "CALL", "app.ts");

        // A2 + DELTA 1: VARIABLE and CONSTANT both derive (no FUNCTION).
        named_node(&mut v, "v_cb", "cb", "VARIABLE", "app.ts");
        named_node(&mut v, "k_cb", "cb", "CONSTANT", "app.ts");
        named_node(&mut v, "c_var", "cb", "CALL", "app.ts");

        // A3: uppercase ctor → CLASS; lowercase negative; ladder suppression.
        named_node(&mut v, "cls_widget", "Widget", "CLASS", "app.ts");
        named_node(&mut v, "c_ctor", "Widget", "CALL", "app.ts");
        named_node(&mut v, "cls_low", "widget2", "CLASS", "app.ts");
        named_node(&mut v, "c_low", "widget2", "CALL", "app.ts");
        named_node(&mut v, "v_box", "Box", "VARIABLE", "app.ts");
        named_node(&mut v, "cls_box", "Box", "CLASS", "app.ts");
        named_node(&mut v, "c_box", "Box", "CALL", "app.ts");

        // Import-binding skip on direct calls.
        named_node(&mut v, "b_ext", "ext", "IMPORT_BINDING", "app.ts");
        named_node(&mut v, "f_ext", "ext", "FUNCTION", "app.ts");
        named_node(&mut v, "c_ext", "ext", "CALL", "app.ts");

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
        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 5, "five CALLS heads (A1, A2, A3, B1, B2)");
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

    /// The bundled js_this_method_calls pack reproduces JsThisMethodCalls.hs exactly:
    /// - unique same-file METHOD resolves (the arm firing);
    /// - two same-named METHODs in the file → ambiguity skip (the neq/ambig idiom);
    /// - "this.a.b" derives NOTHING even with a METHOD named "b" present — the
    ///   concat-equality construction reproduces the resolver's stripThis miss and
    ///   CORRECTS the migration spec's anticipated method_suffix superset delta;
    /// - non-this calls, cross-file methods, .rs files derive nothing;
    /// - DELTA 2 PINNED: .mts is rejected (the resolver's OWN 6-extension gate,
    ///   narrower than the orchestrator's 8-extension stream filter).
    #[test]
    fn js_this_method_calls_unique_method_with_ambiguity_skip() {
        let mut v = FixtureStorageView::new(1);

        // Arm fires: unique "save" METHOD in app.ts.
        named_node(&mut v, "m_save", "save", "METHOD", "app.ts");
        named_node(&mut v, "c1", "this.save", "CALL", "app.ts");

        // Ambiguity skip: two "load" METHODs in app.ts.
        named_node(&mut v, "m_load1", "load", "METHOD", "app.ts");
        named_node(&mut v, "m_load2", "load", "METHOD", "app.ts");
        named_node(&mut v, "c2", "this.load", "CALL", "app.ts");

        // Multi-dot exactness pin: METHOD "b" exists, "this.a.b" must NOT resolve.
        named_node(&mut v, "m_b", "b", "METHOD", "app.ts");
        named_node(&mut v, "c3", "this.a.b", "CALL", "app.ts");

        // File gate: .rs is not JS.
        named_node(&mut v, "m_go", "go", "METHOD", "main.rs");
        named_node(&mut v, "c4", "this.go", "CALL", "main.rs");

        // Prefix negative: not a this-call.
        named_node(&mut v, "c5", "notthis.save", "CALL", "app.ts");

        // Cross-file negative: METHOD only in b.ts.
        named_node(&mut v, "m_far", "far", "METHOD", "b.ts");
        named_node(&mut v, "c6", "this.far", "CALL", "app.ts");

        // DELTA 2 pin: .mts rejected by the resolver's own 6-extension gate.
        named_node(&mut v, "m_mts", "save", "METHOD", "app.mts");
        named_node(&mut v, "c7", "this.save", "CALL", "app.mts");

        let (eval, specs, _node_specs) = evaluate_with_materialize(
            &v,
            JS_THIS_METHOD_CALLS_DL,
            Stats::default(),
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("js_this_method_calls.dl evaluates");

        assert_eq!(
            triples(&eval, "js_this_method_call"),
            BTreeSet::from([(
                id_of("c1"),
                id_of("m_save"),
                "js-this-method-calls".to_string()
            )]),
            "exactly c1→m_save: ambiguous 'load', multi-dot 'this.a.b', .rs, non-this, \
             cross-file and .mts (DELTA 2) all derive nothing"
        );

        let calls_specs: Vec<_> = specs.iter().filter(|s| s.edge_type == "CALLS").collect();
        assert_eq!(calls_specs.len(), 1, "exactly one CALLS head");
        assert!(calls_specs[0].additive, "CALLS is shared — additive");
        assert_eq!(calls_specs[0].meta, vec!["resolvedVia".to_string()]);
    }

    /// The bundled rust_calls pack reproduces RustCallResolution.hs:
    /// - R1 exact (file,name) match, including a receiver-shaped method call (the
    ///   Wave-0 direct CALL -READS_FROM-> receiver — the resolver never conditioned
    ///   on it, the bare-name exact arm covers it);
    /// - R2 '::'-suffix fallback with the segment boundary ("do_y" must NOT match
    ///   FUNCTION "y") and the exact-beats-suffix preference negation;
    /// - cross-file and non-.rs negatives;
    /// - DELTA 1 PINNED: duplicate (file,name) FUNCTIONs derive an edge per
    ///   candidate (the resolver's Map kept the last one);
    /// - DELTA 2 PINNED: a multi-segment FUNCTION name ("b::c") matches via the
    ///   suffix arm (the resolver's lastSegment comparison never could).
    #[test]
    fn rust_calls_exact_then_suffix_fallback() {
        let mut v = FixtureStorageView::new(1);

        // R1 exact.
        named_node(&mut v, "f_helper", "helper", "FUNCTION", "lib.rs");
        named_node(&mut v, "c1", "helper", "CALL", "lib.rs");

        // R2 suffix.
        named_node(&mut v, "f_helper2", "helper2", "FUNCTION", "lib.rs");
        named_node(&mut v, "c2", "utils::helper2", "CALL", "lib.rs");

        // Exact beats suffix: both "m::foo" and "foo" exist; only the exact fires.
        named_node(&mut v, "f_qual", "m::foo", "FUNCTION", "lib.rs");
        named_node(&mut v, "f_foo", "foo", "FUNCTION", "lib.rs");
        named_node(&mut v, "c3", "m::foo", "CALL", "lib.rs");

        // Method call with a Wave-0 receiver shape — resolves by bare name (R1).
        named_node(&mut v, "f_process", "process", "FUNCTION", "lib.rs");
        named_node(&mut v, "c4", "process", "CALL", "lib.rs");
        named_node(&mut v, "recv", "w", "REFERENCE", "lib.rs");
        edge(&mut v, "c4", "recv", "READS_FROM");

        // Cross-file negative.
        named_node(&mut v, "f_far", "far", "FUNCTION", "other.rs");
        named_node(&mut v, "c5", "far", "CALL", "lib.rs");

        // File gate negative: same shape in a .ts file.
        named_node(&mut v, "f_js", "jsfn", "FUNCTION", "app.ts");
        named_node(&mut v, "c6", "jsfn", "CALL", "app.ts");

        // Suffix boundary negative: "do_y" must not match FUNCTION "y".
        named_node(&mut v, "f_y", "y", "FUNCTION", "lib.rs");
        named_node(&mut v, "c7", "do_y", "CALL", "lib.rs");

        // DELTA 1: two `fn new` in one file — both derive.
        named_node(&mut v, "f_new1", "new", "FUNCTION", "lib.rs");
        named_node(&mut v, "f_new2", "new", "FUNCTION", "lib.rs");
        named_node(&mut v, "c8", "Widget::new", "CALL", "lib.rs");

        // DELTA 2: multi-segment FUNCTION name matches as a suffix.
        named_node(&mut v, "f_bc", "b::c", "FUNCTION", "lib.rs");
        named_node(&mut v, "c9", "a::b::c", "CALL", "lib.rs");

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
            via(&[("c1", "f_helper"), ("c3", "f_qual"), ("c4", "f_process")]),
            "R1: exact matches incl. the qualified name and the receiver-shaped \
             method call; cross-file/.ts/empty negatives derive nothing"
        );
        assert_eq!(
            triples(&eval, "rust_suffix_call"),
            via(&[
                ("c2", "f_helper2"),
                ("c8", "f_new1"),
                ("c8", "f_new2"),
                ("c9", "f_bc"),
            ]),
            "R2: suffix fallback — c3 is suppressed by its exact match (preference \
             negation), 'do_y' misses the '::y' boundary, c8 derives BOTH dup \
             functions (DELTA 1), c9 matches the multi-segment name (DELTA 2)"
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

        named_node(&mut v, "f_helper", "helper", "FUNCTION", "lib.rs");
        // (a) macro invocation `helper!()` — same name, same file.
        named_node(&mut v, "c_mac", "helper", "CALL", "lib.rs");
        v.put_node_metadata(id_of("c_mac"), r#"{"macro":true,"method":false}"#);
        // (b) plain call `helper()`.
        named_node(&mut v, "c_plain", "helper", "CALL", "lib.rs");

        // (c) macro `paths::mk!()` — would suffix-match fn mk across R2's
        // "::" boundary if not filtered.
        named_node(&mut v, "f_mk", "mk", "FUNCTION", "lib.rs");
        named_node(&mut v, "c_macq", "paths::mk", "CALL", "lib.rs");
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
        eval: &crate::datalog2::exec::Evaluation,
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

        // A1 same-file: Dog extends Animal in a.ts; Plain has no superClass.
        named_node(&mut v, "cls_animal", "Animal", "CLASS", "a.ts");
        named_node(&mut v, "cls_dog", "Dog", "CLASS", "a.ts");
        v.put_node_metadata(id_of("cls_dog"), r#"{"superClass":"Animal"}"#);
        named_node(&mut v, "cls_plain", "Plain", "CLASS", "a.ts");

        // Fall-through gate: Cat extends Base — Base exists BOTH same-file and
        // as an import binding; only the same-file edge may derive.
        named_node(&mut v, "cls_base_local", "Base", "CLASS", "b.ts");
        named_node(&mut v, "cls_cat", "Cat", "CLASS", "b.ts");
        v.put_node_metadata(id_of("cls_cat"), r#"{"superClass":"Base"}"#);
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
            ]),
            "A1: same-file superclass (+ DELTA 1 both duplicates); the self-name \
             class (neq), the no-superClass class and the .rs file derive nothing"
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
    /// - negatives: namespace binding (IN="*", the legacy producer's arm),
    ///   re-export EXPORT_BINDING (DELTA 1 subset — Wave 2b), an IMPORT with no
    ///   resolved MODULE edge, the .rs file gate.
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
        bind(&mut v, "b_ns", "utils", "*"); // import * as utils — excluded
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
             binding, importing the pre-alias name, the re-export binding \
             (DELTA 1), the unresolved import and the .rs file derive NOTHING"
        );

        // IMPORTS_FROM is shared vocabulary — additive; legacy edges carry
        // empty metadata, so no meta columns (exact parity).
        let if_specs: Vec<_> = specs
            .iter()
            .filter(|s| s.edge_type == "IMPORTS_FROM")
            .collect();
        assert_eq!(if_specs.len(), 1, "exactly one IMPORTS_FROM head");
        assert!(if_specs[0].additive, "IMPORTS_FROM is shared — additive");
        assert!(
            if_specs[0].meta.is_empty(),
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
        // The DELTA-1 pin: a named re-export with NO IMPORT seam for its source.
        named_node(&mut v, "eb_ghost", "g", "EXPORT_BINDING", "mid.ts");
        v.put_node_metadata(
            id_of("eb_ghost"),
            r#"{"exportedName":"ghost","source":"./nowhere"}"#,
        );

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
        bind(&mut v, "b_ghost", "ghost", "ghost"); // named hop without seam — DELTA 1 miss

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
            ]),
            "chains collapse to the FINAL declaration (named hop with rebinding \
             through the IMPORT seam; 2-hop star chain through RE_EXPORTS); the \
             seam-less named hop (DELTA 1) derives nothing and no edge ever \
             targets a re-export EXPORT_BINDING"
        );
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
        named_node(&mut v, "cls_localerr", "Error", "CLASS", "d.ts");
        named_node(&mut v, "cls_shadow", "Shadow", "CLASS", "d.ts");
        v.put_node_metadata(id_of("cls_shadow"), r#"{"superClass":"Error"}"#);

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
        assert_eq!(node_specs.len(), 4, "four @materialize_node heads");
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
            1,
            "one IMPORTS_FROM head"
        );
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
    /// - DELTA 1: bare specifier `lodash` → NO edge (workspace arms out);
    /// - the 8-extension importer gate: the same specifier in a .py file → NOTHING;
    /// - star re-exports: `*:./lib/util.js` → RE_EXPORTS via the export ladder,
    ///   and `*:./typesonly` (MODULE, no exports) → RE_EXPORTS via the
    ///   resolveModulePathDirect ModuleIndex FALLBACK (fails without the m-ladder);
    /// - meta resolvedPath projected on both heads, additive (legacy parity).
    #[test]
    fn js_module_imports_ladder_star_and_probe_arms() {
        let mut v = FixtureStorageView::new(1);

        // Target files: MODULE per file; an EXPORT node marks exporting files.
        let target = |v: &mut FixtureStorageView, m: &str, e: Option<&str>, file: &str| {
            named_node(v, m, "mod", "MODULE", file);
            if let Some(e) = e {
                named_node(v, e, "named", "EXPORT", file);
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
        imp(&mut v, "i_bare", "lodash", "src/app/main.ts"); // DELTA 1: miss
        imp(&mut v, "i_nope", "./nope", "src/app/main.ts"); // no candidate: miss
        imp(&mut v, "i_py", "./lib/util.js", "tool.py"); // importer gate: miss

        // Star re-exports (EXPORT "*:<src>") in a barrel file.
        named_node(&mut v, "e_star1", "*:./lib/util.js", "EXPORT", "src/app/barrel.ts");
        named_node(&mut v, "e_star2", "*:./typesonly", "EXPORT", "src/app/barrel.ts");

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
            ]),
            "swap / ../-collapse+ext-order / exact / index-fallback / \
             ExportIndex-probe resolve; side (no exports), bare (DELTA 1), \
             nope (no candidate) and the .py importer derive NOTHING"
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
            ]),
            "star via the export ladder (swap arm) + the exports-less target \
             via the resolveModulePathDirect ModuleIndex fallback"
        );

        // Both heads declared additive with meta(resolvedPath) — legacy parity.
        let ifs: Vec<_> = specs.iter().filter(|s| s.edge_type == "IMPORTS_FROM").collect();
        assert_eq!(ifs.len(), 1, "one IMPORTS_FROM head");
        assert!(ifs[0].additive, "IMPORTS_FROM is shared vocabulary — additive");
        assert_eq!(ifs[0].meta, vec!["resolvedPath".to_string()]);
        let res: Vec<_> = specs.iter().filter(|s| s.edge_type == "RE_EXPORTS").collect();
        assert_eq!(
            res.len(),
            1,
            "one RE_EXPORTS spec (the annotation covers both star_reexport clauses)"
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
        use crate::datalog2::parser_ext::parse_ext_program;
        use crate::datalog2::plan::plan_program;
        use crate::datalog2::stratify::stratify;

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
        ] {
            nodes_by_type.insert(ty.to_string(), n);
        }
        let stats = Stats {
            total_nodes: 426_665,
            total_edges: 905_847,
            nodes_by_type,
        };

        let known_failures = ["rust_cross_methods_ctor", "rust_receiver_typing"];
        let mut failed: Vec<String> = Vec::new();
        for (name, src) in STDLIB_PACKS {
            if known_failures.contains(name) {
                continue;
            }
            let program = parse_ext_program(src).unwrap_or_else(|e| panic!("{name}: parse: {e}"));
            let strat = stratify(&program).unwrap_or_else(|e| panic!("{name}: stratify: {e}"));
            let rules = program.rules();
            if let Err(e) = plan_program(&rules, &strat, &stats) {
                failed.push(format!("{name}: {e}"));
            }
        }
        assert!(
            failed.is_empty(),
            "packs must plan under dogfood-scale stats (E-PLAN-003 is a \
             production rejection, not a perf hint):\n{}",
            failed.join("\n")
        );
    }

}
