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
pub(crate) const DEPENDS_DL: &str = include_str!("stdlib/depends.dl");

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
}
