//! P3 plan-equality goldens (rofl-fact-model.md §3.4, run-migration round-009).
//!
//! The P3 contract migrates `base_estimate` off the five string names onto
//! `(PredicateDecl, pattern)` and the base-leg dispatch onto
//! `(PredicateId, SortOrder, bound_column_mask)` — with the hard requirement
//! that, while `distinct`/`max_fanout` are unknown (= 0, the pre-compaction
//! state), the planner produces plans IDENTICAL to the pre-P3 planner's on the
//! base five. This module pins that equality STRUCTURALLY: one blake3
//! fingerprint per (program, stats-profile, rule) over every bundled stdlib
//! pack in its EVALUATED composition plus the plan.rs fixture shapes, compared
//! against a golden file GENERATED AT PRE-P3 HEAD (a977886a) and committed with
//! ledger round-009-pre — ahead of the P3 implementation, so the "before" side
//! is git-auditable.
//!
//! The fingerprint renders every plan-struct field that P3 is required to keep
//! equal (head, ordered legs: literal, bind pattern, source kind + SURFACE
//! name, join kind, estimate; per-rule estimate; head domains). The leg-source
//! render is deliberately name-level (`base:incoming`, `base:type`) so the P3
//! `LegSource` shape change (carrying the resolved `(PredicateId, SortOrder)`)
//! does not perturb the fingerprint — the resolution is pinned by its own unit
//! tests; THIS gate pins that everything the pre-P3 planner decided is decided
//! identically.
//!
//! Regenerate (only legitimate at a plan-CHANGING phase boundary, with the
//! ledger updated): `cargo test --lib derive::plan_golden::regen -- --ignored`.

use super::builtin::Stats;
use super::parser_ext::parse_ext_program;
use super::plan::{plan_program, LegSource, RulePlan};
use super::stratify::stratify;

/// The committed golden fingerprints (generated at pre-P3 HEAD).
const GOLDEN: &str = include_str!("golden/p3_plan_fingerprints.txt");

/// Fixture programs mirroring the plan.rs test shapes (source-level, planned
/// through `plan_program` like the packs). The consciously-flipped P3 pins
/// (base-name-shadowing heads) are EXCLUDED by design — their new behavior is
/// pinned by their own tests, not by this equality gate.
const FIXTURES: &[(&str, &str)] = &[
    (
        "fx_catalog_mix",
        r#"
            same(X, Y) :- edge(X, Y, "ALIASES").
            same(X, Y) :- edge(Y, X, "ALIASES").
            same(X, Z) :- same(X, Y), same(Y, Z).
            flagged(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS").
            linked(F, B) :- node(F, "HTTP_REQUEST"), edge(F, E1, "REFERS"),
                            node(B, "http:route"), edge(B, E2, "REFERS"),
                            same(E1, E2), gt(F, 0).
        "#,
    ),
    (
        "fx_reorder_filter",
        r#"h(X) :- gt(X, "5"), node(X, "FUNCTION")."#,
    ),
    (
        "fx_selective_first",
        r#"h(X, Y) :- node(X, "COMMON"), node(Y, "RARE"), edge(X, Y, "CALLS")."#,
    ),
    (
        "fx_cross_join_reject",
        r#"h(X, Y) :- node(X, "A"), node(Y, "B")."#,
    ),
    ("fx_node_free_free_reject", r#"h(X, T) :- node(X, T)."#),
    (
        "fx_reach_closure",
        "reach(X, Y) :- edge(X, Y, \"CALLS\").\n\
         reach(X, Z) :- reach(X, Y), edge(Y, Z, \"CALLS\").",
    ),
    (
        "fx_derived_chain",
        "a(X, Y) :- edge(X, Y, \"T1\").\n\
         b(X, Z) :- a(X, Y), edge(Y, Z, \"T2\").\n\
         c(X, W) :- b(X, Z), edge(Z, W, \"T3\").",
    ),
    (
        "fx_ground_probe_f3",
        r#"
            p0("c0"). p0("c1").
            p1("c1", "c2").
            q0(X) :- p0(X), p1("c1", "c2").
        "#,
    ),
    (
        "fx_negated_novar_f3",
        r#"
            p0("c0").
            p3("z").
            qe(X) :- p0(X), \+ p3(_).
        "#,
    ),
    (
        "fx_attr_shapes",
        r#"
            an(X) :- attr(X, "name", "switch").
            af(X, F) :- node(X, "FUNCTION"), attr(X, "file", F).
            avv(X, Y) :- node(X, "MODULE"), attr(X, "file", F), attr(Y, "file", F), node(Y, "MODULE"), neq(X, Y).
        "#,
    ),
    (
        "fx_incoming_and_type_alias",
        r#"
            inc(X, Y) :- node(X, "FUNCTION"), incoming(X, Y, "CALLS").
            t(X) :- type(X, "FUNCTION").
        "#,
    ),
    (
        "fx_edge_attr_probe",
        r#"ea(X, Y, V) :- node(X, "A"), edge(X, Y, "E"), edge_attr(X, Y, "E", "k", V)."#,
    ),
    (
        "fx_negation_anti_join",
        r#"flag(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS")."#,
    ),
    (
        "fx_function_builtins",
        r#"
            fb(X, S, E) :- node(X, "MODULE"), attr(X, "file", F), split(F, "/", S), concat(S, ".js", E).
        "#,
    ),
];

/// Profile 1: production-magnitude stats with a populated per-type oracle
/// (absent types estimate ~0 — the oracle semantics under pin).
fn stats_prod() -> Stats {
    Stats {
        total_nodes: 413_000,
        total_edges: 1_200_000,
        nodes_by_type: [
            ("MODULE", 3_000u64),
            ("FUNCTION", 95_000),
            ("CLASS", 12_000),
            ("METHOD", 40_000),
            ("CALL", 210_000),
            ("IMPORT", 25_000),
            ("VARIABLE", 60_000),
            ("CONSTANT", 18_000),
            ("PROPERTY", 9_000),
            ("EXTERNAL_FUNCTION", 7_000),
            ("IMPORT_BINDING", 20_000),
            ("REFERENCE", 55_000),
            ("http:route", 40),
            ("COMMON", 100_000),
            ("RARE", 5),
            ("A", 50),
            ("B", 50),
        ]
        .into_iter()
        .map(|(t, n)| (t.to_string(), n))
        .collect(),
    }
}

/// Profile 2: empty stats (the unit-test / cold fallback paths).
fn stats_empty() -> Stats {
    Stats::default()
}

/// Name-level leg-source render — stable across the P3 `LegSource` migration.
fn render_source(s: &LegSource) -> String {
    match s {
        LegSource::Base { name, .. } => format!("base:{name}"),
        LegSource::Builtin(n) => format!("builtin:{n}"),
        LegSource::Derived { name, recursive } => format!("derived:{name}:{recursive}"),
    }
}

fn render_plan(p: &RulePlan) -> String {
    let legs: Vec<String> = p
        .legs
        .iter()
        .map(|l| {
            format!(
                "{:?}|{:?}|{}|{:?}|{}",
                l.literal,
                l.pattern,
                render_source(&l.source),
                l.join,
                l.estimate
            )
        })
        .collect();
    format!(
        "head={} estimate={} domains={:?} legs=[{}]",
        p.head,
        p.estimate,
        p.head_domains,
        legs.join(" ;; ")
    )
}

fn fingerprint(text: &str) -> String {
    blake3::hash(text.as_bytes()).as_bytes()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The full battery: every bundled stdlib pack (evaluated composition) + the
/// fixture shapes, under both stats profiles. One output line per rule (or one
/// ERR line per program when planning rejects — the rejection CODE and head
/// are part of the pinned surface; detail strings are documented
/// non-authoritative and excluded).
fn compute_fingerprints() -> String {
    let mut programs: Vec<(String, &str)> = Vec::new();
    for (name, src) in super::stdlib::STDLIB_PACKS {
        programs.push((format!("pack:{name}"), src));
    }
    for (name, src) in FIXTURES {
        programs.push((format!("fixture:{name}"), src));
    }

    let profiles: [(&str, Stats); 2] = [("prod", stats_prod()), ("empty", stats_empty())];

    let mut out = String::new();
    for (name, src) in &programs {
        let prog = parse_ext_program(src)
            .unwrap_or_else(|e| panic!("golden battery program {name} must parse: {e}"));
        let strat = stratify(&prog)
            .unwrap_or_else(|e| panic!("golden battery program {name} must stratify: {e}"));
        let rules = prog.rules();
        for (profile, stats) in &profiles {
            match plan_program(&rules, &strat, stats) {
                Ok(plans) => {
                    for (i, p) in plans.iter().enumerate() {
                        out.push_str(&format!(
                            "{name}|{profile}|{i}|{}|{}\n",
                            p.head,
                            fingerprint(&render_plan(p))
                        ));
                    }
                }
                Err(e) => {
                    out.push_str(&format!("{name}|{profile}|ERR|{}|{}\n", e.code, e.head));
                }
            }
        }
    }
    out
}

/// A rule-count sanity floor so the gate cannot silently pin a near-empty
/// battery (e.g. a battery-construction regression that drops the packs).
const MIN_GOLDEN_LINES: usize = 1_000;

/// THE P3 plan-equality gate: fingerprints must be bit-identical to the golden
/// file generated at pre-P3 HEAD. Divergence output names every differing line
/// (program, profile, rule head), so a regression localizes to a rule.
#[test]
fn p3_plan_fingerprints_match_pre_p3_golden() {
    let got = compute_fingerprints();
    let got_lines: Vec<&str> = got.lines().collect();
    let want_lines: Vec<&str> = GOLDEN.lines().collect();
    assert!(
        got_lines.len() >= MIN_GOLDEN_LINES,
        "golden battery collapsed: only {} lines (floor {})",
        got_lines.len(),
        MIN_GOLDEN_LINES
    );
    if got != GOLDEN {
        let mut diffs: Vec<String> = Vec::new();
        let n = got_lines.len().max(want_lines.len());
        for i in 0..n {
            let g = got_lines.get(i).copied().unwrap_or("<missing>");
            let w = want_lines.get(i).copied().unwrap_or("<missing>");
            if g != w {
                diffs.push(format!("line {}:\n  golden: {w}\n  got:    {g}", i + 1));
            }
        }
        panic!(
            "P3 plan-equality gate: {} fingerprint line(s) diverged from the pre-P3 golden \
             (run-migration round-009 H1):\n{}",
            diffs.len(),
            diffs.join("\n")
        );
    }
}

/// Regenerator (manual, `--ignored`): writes the golden file from the CURRENT
/// planner. Legitimate ONLY when a phase contract changes plans on purpose and
/// the ledger records it; running it to silence the gate defeats the gate.
#[test]
#[ignore = "writes the golden file from the current planner; ledger-gated"]
fn regen() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/derive/golden/p3_plan_fingerprints.txt");
    std::fs::write(&path, compute_fingerprints()).expect("write golden");
    println!("golden written to {}", path.display());
}
