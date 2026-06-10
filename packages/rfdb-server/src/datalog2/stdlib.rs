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
/// edges CALL → type (the type is pack-owned, so fixed violations retract on rerun).
///
/// ORDERING: must run AFTER [`METHOD_CALLS_DL`] — its skip-resolved filter reads
/// CALLS as EDB (legal here: this program does not materialize CALLS).
pub const SHAPE_VERIFIER_DL: &str = include_str!("stdlib/shape_verifier.dl");

/// The bundled Axum route-detection rule pack — the edges half of
/// `plugins/axum-route-detector.mjs` (`http:route` NODE creation is deferred to
/// node-materialization). Derives, from `.route("/path", get(handler))` calls in
/// Rust files (argument positions read via `edge_attr` on PASSES_ARGUMENT `index`):
/// - `ROUTES_TO`  (route CALL → handler, `meta(method, path)`),
/// - `HANDLED_BY` (path LITERAL → handler, `meta(method)`).
///
/// Both target types are pre-registered SHARED vocabulary
/// (`packages/types/src/edges.ts`) ⇒ `mode = "additive"` on both heads.
pub const AXUM_ROUTES_DL: &str = include_str!("stdlib/axum_routes.dl");

/// The named stdlib rule packs, addressable on the wire as `"@stdlib/<name>"`
/// (`MaterializeDatalog` and the other empty-source-defaulting dispatchers), listed
/// in CANONICAL RUN ORDER. The order is a CONTRACT, not cosmetics:
/// `shape_verifier` reads CALLS as EDB (its skip-resolved negation), so it MUST run
/// after `method_calls` has committed its CALLS edges — an orchestrator running the
/// packs sequentially must preserve this order:
/// depends → method_calls → shape_verifier → axum_routes.
pub const STDLIB_PACKS: &[(&str, &str)] = &[
    ("depends", DEPENDS_DL),
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

        let (_eval, specs) = evaluate_with_materialize(
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

        let (eval, specs) = evaluate_with_materialize(
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

        let (eval, specs) = evaluate_with_materialize(
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

        // r8: second argument is not a CALL — no handler endpoint, hence no edges
        // (the plugin minted a handler-less GET http:route node; node creation is the
        // documented out-of-scope residue).
        named_node(&mut v, "r8", "route", "CALL", "src/ref.rs");
        named_node(&mut v, "p8", "/ref", "LITERAL", "src/ref.rs");
        named_node(&mut v, "ref8", "make_router", "REFERENCE", "src/ref.rs");
        edge_meta(&mut v, "r8", "p8", "PASSES_ARGUMENT", idx0);
        edge_meta(&mut v, "r8", "ref8", "PASSES_ARGUMENT", idx1);

        let (eval, specs) = evaluate_with_materialize(
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
    }

    /// The wire-addressable pack registry: canonical order (an ordering CONTRACT —
    /// shape_verifier reads CALLS as EDB so it must follow method_calls), name → source
    /// lookup, and None for unknown names (the dispatcher owns the E-MAT-007 error).
    #[test]
    fn stdlib_pack_registry_resolves_names_in_canonical_order() {
        let names: Vec<&str> = STDLIB_PACKS.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names,
            vec!["depends", "method_calls", "shape_verifier", "axum_routes"],
            "canonical run order: depends → method_calls → shape_verifier → axum_routes"
        );
        assert_eq!(stdlib_pack("depends"), Some(DEPENDS_DL));
        assert_eq!(stdlib_pack("method_calls"), Some(METHOD_CALLS_DL));
        assert_eq!(stdlib_pack("shape_verifier"), Some(SHAPE_VERIFIER_DL));
        assert_eq!(stdlib_pack("axum_routes"), Some(AXUM_ROUTES_DL));
        assert_eq!(stdlib_pack("nope"), None, "unknown pack name resolves to None");
    }
}
