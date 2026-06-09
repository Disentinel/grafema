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
}
