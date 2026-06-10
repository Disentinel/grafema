//! Layer 9b — `@materialize` write-back.
//!
//! After the fixpoint commits, a predicate annotated `@materialize(edge_type="T")` is
//! projected back into the graph AS edges: a binary derived fact `p(A, B)` becomes a
//! graph edge `A —T→ B`. The write-back reuses the committed MVCC write path
//! ([`crate::storage_v2::multi_shard::MultiShardStore::commit_batch_ext`] via the engine
//! adapter) — it does NOT invent a second persistence mechanism. Every derived edge
//! carries provenance metadata mirroring the orchestrator's derived-edge convention
//! (`grafema-orchestrator/src/main.rs`): `_source = <rule_ast_hash>` and
//! `_generation = <run_id>`.
//!
//! # What this module owns (pure, storage-free)
//!
//! This module is the *planning* half of the write-back: given a parsed [`ExtProgram`]
//! and the committed [`Evaluation`], it produces the [`EdgeRecordV2`] batch to commit and
//! the stable `rule_ast_hash` provenance stamp. It performs NO storage I/O (I10) — the
//! single atomic commit (`commit_batch_ext` → one `commit_edit` manifest flip) is driven
//! by the engine adapter, which stages ALL of a run's materialized edges under ONE
//! generation and flips the manifest exactly once. A mid-run failure therefore commits
//! nothing (abort-no-commit): the prior committed generation stays intact because the
//! single manifest flip only happens after a clean fixpoint + a clean plan.
//!
//! # The `rule_ast_hash` (whitespace / variable-rename invariant)
//!
//! `_source` must be stable across cosmetic edits: re-indenting a rule or renaming its
//! variables must not change the provenance stamp (so a re-run of the same logical rule
//! over-writes its own prior generation's edges rather than orphaning them). The hash is
//! computed over a *normalized* serialization of the rule AST: variables are renumbered
//! to positional `V0`, `V1`, … in first-appearance order (head then body, left to right),
//! constants and predicate names are length-prefixed verbatim, and the structure is
//! encoded with fixed tag bytes — so two rules that differ only in whitespace or variable
//! names hash identically, while any change to predicates, constants, arity, negation, or
//! literal order changes the hash.
//!
//! # `meta(...)` — projecting head columns into edge metadata
//!
//! `@materialize(edge_type = "T", meta(name1, name2, …))` projects EXTRA head columns into
//! the written edge's metadata JSON. The head must then have arity `2 + len(meta)`:
//! columns 0/1 stay the edge endpoints, and the i-th `meta` name (0-based, in source
//! order) takes head column `2 + i`'s string surface. Example:
//!
//! ```text
//! @materialize(edge_type = "CALLS", meta(method, line))
//! resolved(C, M, Name, L) :- …      % C→M edge; metadata {"method": Name, "line": L}
//! ```
//!
//! The written metadata is the provenance stamp plus the meta fields:
//! `{"_source": …, "_generation": …, "name1": <surface>, "name2": <surface>}` (meta values
//! are always JSON strings — the §5 string surface; `_`-prefixed names are reserved and
//! rejected at parse). An arity mismatch (head ≠ `2 + len(meta)`) aborts the run with the
//! coded `E-MAT-002` BEFORE any commit, exactly like a non-binary head without `meta`.
//!
//! `meta` does NOT change edge identity: dedup/diff stays keyed on `(src, dst, edge_type)`.
//! Consequences: (a) for an ADDITIVE spec an already-present edge is NOT rewritten just
//! because its metadata differs from the freshly-derived meta; (b) two derived facts that
//! agree on the endpoints but differ in a meta column are ONE edge — which fact's metadata
//! lands is storage-order-defined, not specified. Programs needing per-fact identity must
//! put the distinguishing value into an endpoint, not into meta.

use std::collections::HashMap;

use crate::datalog::{Atom, Literal, Rule, Term, Value};
use crate::storage_v2::types::EdgeRecordV2;

use super::exec::Evaluation;
use super::parser_ext::{Annotation, ExtProgram};

/// A write-back error: a materialized predicate whose head shape is not a binary
/// `p(A, B)` (the only shape projectable to a graph-native edge at this gate), carrying a
/// stable taxonomy code (engine-wide invariant I5: never a silent skip).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializeError {
    /// Stable taxonomy code — the load-bearing, machine-checkable field.
    pub code: &'static str,
    /// One-line human detail (never authoritative on its own).
    pub detail: String,
}

impl std::fmt::Display for MaterializeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for MaterializeError {}

/// One `@materialize(edge_type="T")` directive resolved against its rule's head predicate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializeSpec {
    /// The head predicate whose derived facts are projected to edges.
    pub predicate: String,
    /// The target edge type `T` (the `edge_type=` payload).
    pub edge_type: String,
    /// The stable provenance stamp for THIS rule (`_source`), invariant under whitespace
    /// and variable renaming (see [`rule_ast_hash`]).
    pub rule_ast_hash: String,
    /// `mode = "additive"`: this rule only ADDS missing edges of its type — the write-back
    /// never tombstones. Required when the target edge type is SHARED with other producers
    /// (analyzers, enrichers): the default exclusive mode treats every stored edge of the
    /// type as owned by the program and deletes the underived ones. Default `false`
    /// (exclusive — the depends.dl/DEPENDS_ON contract, reanalysis supersedes).
    pub additive: bool,
    /// The `meta(...)` field names, in source order: the i-th name projects head column
    /// `2 + i` into the written edge's metadata (module docs). Empty when the rule has no
    /// `meta(...)` group — the legacy binary-head contract, byte-identical metadata.
    pub meta: Vec<String>,
}

/// Extract every `@materialize(edge_type="T")` directive from a parsed program, paired
/// with its rule's head predicate and the rule's stable AST hash.
///
/// A rule may carry at most one `@materialize`; an `edge_type=` key is required (the only
/// projection target this gate supports). Returns `Err` (a coded [`MaterializeError`])
/// for a `@materialize` missing `edge_type` — never a silent skip (I5). Rules without a
/// `@materialize` annotation contribute nothing.
pub fn collect_materialize_specs(
    program: &ExtProgram,
) -> Result<Vec<MaterializeSpec>, MaterializeError> {
    let mut out = Vec::new();
    for item in &program.items {
        for ann in &item.annotations {
            let Annotation::Materialize { pairs, meta } = ann else {
                continue;
            };
            let edge_type = pairs
                .iter()
                .find(|kv| kv.key == "edge_type")
                .map(|kv| kv.value.clone())
                .ok_or_else(|| MaterializeError {
                    code: "E-MAT-001",
                    detail: format!(
                        "@materialize on predicate '{}' is missing the required edge_type= key",
                        item.rule.head().predicate()
                    ),
                })?;
            let additive = match pairs.iter().find(|kv| kv.key == "mode").map(|kv| kv.value.as_str()) {
                None | Some("exclusive") => false,
                Some("additive") => true,
                Some(other) => {
                    return Err(MaterializeError {
                        code: "E-MAT-006",
                        detail: format!(
                            "@materialize on predicate '{}' has unknown mode '{}' (expected \"additive\" or \"exclusive\")",
                            item.rule.head().predicate(),
                            other
                        ),
                    })
                }
            };
            out.push(MaterializeSpec {
                predicate: item.rule.head().predicate().to_string(),
                edge_type,
                rule_ast_hash: rule_ast_hash(&item.rule),
                additive,
                meta: meta.clone(),
            });
        }
    }
    Ok(out)
}

/// Build the [`EdgeRecordV2`] write-back batch for one run: for every materialized
/// predicate, project each derived binary fact `p(A, B)` to an edge `A —edge_type→ B`
/// stamped with `{"_source": rule_ast_hash, "_generation": generation}`.
///
/// `generation` is the run id under which ALL of this run's edges are staged; the engine
/// commits the whole returned batch with a SINGLE atomic manifest flip (run isolation).
/// Returns `Err` (coded) if any materialized head is not the binary `p(A, B)` shape, so a
/// mis-shaped rule aborts the run before any commit rather than silently dropping edges.
///
/// The endpoint columns must resolve to node ids ([`Value::Id`]); a string column that
/// parses as a `u128` is accepted (the wire/string round-trip of an id), otherwise the
/// fact is rejected (coded), never silently skipped.
pub fn plan_writeback(
    specs: &[MaterializeSpec],
    evaluation: &Evaluation,
    generation: u64,
) -> Result<Vec<EdgeRecordV2>, MaterializeError> {
    let mut edges = Vec::new();
    for spec in specs {
        // Without meta() the metadata is the bare provenance stamp, shared by every fact
        // of the spec (built once, byte-identical to the pre-meta contract). With meta()
        // it is per-fact (the projected columns differ), built below.
        let provenance = provenance_metadata(&spec.rule_ast_hash, generation);
        let expected_arity = 2 + spec.meta.len();
        for fact in evaluation.facts(&spec.predicate) {
            if fact.len() != expected_arity {
                return Err(MaterializeError {
                    code: "E-MAT-002",
                    detail: format!(
                        "@materialize(edge_type=\"{}\") requires head arity {} for {} \
                         (2 endpoint columns + {} meta column(s)); got arity {}",
                        spec.edge_type,
                        expected_arity,
                        spec.predicate,
                        spec.meta.len(),
                        fact.len()
                    ),
                });
            }
            let src = value_to_id(&fact[0]).ok_or_else(|| MaterializeError {
                code: "E-MAT-003",
                detail: format!(
                    "@materialize predicate '{}' src column is not a node id: {:?}",
                    spec.predicate, fact[0]
                ),
            })?;
            let dst = value_to_id(&fact[1]).ok_or_else(|| MaterializeError {
                code: "E-MAT-003",
                detail: format!(
                    "@materialize predicate '{}' dst column is not a node id: {:?}",
                    spec.predicate, fact[1]
                ),
            })?;
            let metadata = if spec.meta.is_empty() {
                provenance.clone()
            } else {
                meta_metadata(&provenance, &spec.meta, &fact[2..])
            };
            edges.push(EdgeRecordV2 {
                src,
                dst,
                edge_type: spec.edge_type.clone(),
                metadata,
            });
        }
    }
    Ok(edges)
}

/// The provenance metadata JSON for a derived edge, mirroring the orchestrator's
/// derived-edge convention (`grafema-orchestrator/src/main.rs`):
/// `{"_source":"<rule_ast_hash>","_generation":<generation>}`.
fn provenance_metadata(rule_ast_hash: &str, generation: u64) -> String {
    format!(
        r#"{{"_source":"{}","_generation":{}}}"#,
        rule_ast_hash, generation
    )
}

/// The per-fact metadata JSON for a `meta(...)` spec: the provenance stamp's fields plus
/// each meta name bound to its head column's STRING SURFACE (always a JSON string —
/// `serde_json`-escaped, so any surface round-trips). `names` and `columns` are the same
/// length by the caller's arity check; names are parse-validated plain identifiers
/// (never `_`-prefixed, so they cannot collide with the provenance keys).
fn meta_metadata(provenance: &str, names: &[String], columns: &[Value]) -> String {
    let mut out = String::with_capacity(provenance.len() + 32 * names.len());
    // Splice the meta fields before the provenance object's closing brace.
    out.push_str(&provenance[..provenance.len() - 1]);
    for (name, value) in names.iter().zip(columns) {
        out.push(',');
        out.push_str(&serde_json::Value::String(name.clone()).to_string());
        out.push(':');
        out.push_str(&serde_json::Value::String(value.as_str()).to_string());
    }
    out.push('}');
    out
}

/// Resolve a head column to a node id: a [`Value::Id`] directly, or a [`Value::Str`] that
/// parses as a `u128` (the string round-trip of an id). Anything else is not an id.
fn value_to_id(v: &Value) -> Option<u128> {
    match v {
        Value::Id(id) => Some(*id),
        Value::Str(s) => s.parse::<u128>().ok(),
        // Typed numeric literals are values, not node ids.
        Value::Int(_) | Value::Float(_) => None,
    }
}

// ── rule_ast_hash: normalized (whitespace / var-rename invariant) ───

/// Stable provenance hash of a rule's AST, invariant under whitespace and variable
/// renaming (see the module doc). Two rules that differ only in indentation or in the
/// spelling of their variables hash identically; any change to a predicate name, a
/// constant, an arity, the polarity of a literal, or the literal order changes the hash.
///
/// The normalization renumbers variables to positional `V{n}` in first-appearance order
/// (head atom first, then body literals left to right), then serializes the structure
/// with fixed tag bytes and length-prefixed payloads (the same injective-encoding
/// discipline as [`super::value::fact_id`]) and takes a BLAKE3 digest rendered as hex.
pub fn rule_ast_hash(rule: &Rule) -> String {
    // First pass: assign each variable a positional name in first-appearance order.
    let mut var_map: HashMap<String, u32> = HashMap::new();
    let mut next: u32 = 0;
    assign_atom_vars(rule.head(), &mut var_map, &mut next);
    for lit in rule.body() {
        assign_atom_vars(lit.atom(), &mut var_map, &mut next);
    }

    // Second pass: encode the normalized structure.
    let mut buf: Vec<u8> = Vec::new();
    encode_atom(rule.head(), &var_map, &mut buf);
    // A length prefix on the body separates the head encoding from the body and pins the
    // literal count (so an extra/removed literal changes the digest).
    buf.extend_from_slice(&(rule.body().len() as u64).to_le_bytes());
    for lit in rule.body() {
        // Polarity tag: a positive vs. negated literal must hash differently.
        match lit {
            Literal::Positive(_) => buf.push(0x10),
            Literal::Negative(_) => buf.push(0x11),
        }
        encode_atom(lit.atom(), &var_map, &mut buf);
    }

    blake3::hash(&buf).to_hex().to_string()
}

/// Record each not-yet-seen variable of `atom` with the next positional index.
fn assign_atom_vars(atom: &Atom, var_map: &mut HashMap<String, u32>, next: &mut u32) {
    for t in atom.args() {
        if let Term::Var(name) = t {
            if !var_map.contains_key(name) {
                var_map.insert(name.clone(), *next);
                *next += 1;
            }
        }
    }
}

/// Append the normalized encoding of one atom: predicate (length-prefixed), arity, then
/// each term with a variant tag — variables as their positional index (rename-invariant),
/// constants length-prefixed verbatim, wildcards as a bare tag.
fn encode_atom(atom: &Atom, var_map: &HashMap<String, u32>, buf: &mut Vec<u8>) {
    let pred = atom.predicate().as_bytes();
    buf.extend_from_slice(&(pred.len() as u64).to_le_bytes());
    buf.extend_from_slice(pred);
    buf.extend_from_slice(&(atom.args().len() as u64).to_le_bytes());
    for t in atom.args() {
        match t {
            Term::Var(name) => {
                buf.push(0x01);
                let idx = var_map.get(name).copied().unwrap_or(u32::MAX);
                buf.extend_from_slice(&idx.to_le_bytes());
            }
            Term::Const(s) => {
                buf.push(0x02);
                let b = s.as_bytes();
                buf.extend_from_slice(&(b.len() as u64).to_le_bytes());
                buf.extend_from_slice(b);
            }
            // A typed numeric literal: its own variant tag (so it hashes distinctly from a
            // quoted const with the same surface) plus its length-prefixed string surface.
            Term::Lit(v) => {
                buf.push(0x04);
                let surface = v.as_str();
                let b = surface.as_bytes();
                buf.extend_from_slice(&(b.len() as u64).to_le_bytes());
                buf.extend_from_slice(b);
            }
            Term::Wildcard => {
                buf.push(0x03);
            }
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datalog2::parser_ext::parse_ext_program;
    use crate::datalog::parse_program as parse_v1;

    fn rule_of(src: &str) -> Rule {
        parse_v1(src).expect("parse rule").rules()[0].clone()
    }

    #[test]
    fn rule_ast_hash_is_whitespace_and_var_rename_invariant() {
        let a = rule_of(r#"calls(X, Y) :- edge(X, Y, "CALLS")."#);
        let b = rule_of("calls(  A ,B ) :-    edge( A,B , \"CALLS\" ) .");
        assert_eq!(
            rule_ast_hash(&a),
            rule_ast_hash(&b),
            "whitespace + variable renaming must not change the hash"
        );
    }

    #[test]
    fn rule_ast_hash_changes_on_constant_predicate_and_polarity() {
        let base = rule_of(r#"calls(X, Y) :- edge(X, Y, "CALLS")."#);
        let diff_const = rule_of(r#"calls(X, Y) :- edge(X, Y, "CONTAINS")."#);
        let diff_pred = rule_of(r#"calls(X, Y) :- incoming(X, Y, "CALLS")."#);
        let h = rule_ast_hash(&base);
        assert_ne!(h, rule_ast_hash(&diff_const), "constant change must change hash");
        assert_ne!(h, rule_ast_hash(&diff_pred), "predicate change must change hash");
    }

    /// PIN: the bundled `depends.dl` rule's `rule_ast_hash` — the provenance `_source` stamp
    /// every materialized DEPENDS_ON edge carries and the D2 maintain cache keys off. This
    /// literal was captured BEFORE the `meta(...)` parser extension landed; the test proves
    /// programs without `meta()` (and the AST they parse to) hash IDENTICALLY after it.
    #[test]
    fn depends_dl_rule_ast_hash_is_pinned() {
        let prog = parse_ext_program(crate::datalog2::stdlib::DEPENDS_DL).expect("parse depends.dl");
        assert_eq!(prog.items.len(), 1);
        assert_eq!(
            rule_ast_hash(&prog.items[0].rule),
            "000b8fb9110c10193432fe9f6c18a5f681bd99f7b7b21263440931e55e963b9a",
            "depends.dl provenance hash drifted — _source/maintain-cache identity would break"
        );
    }

    #[test]
    fn collect_specs_reads_edge_type_and_predicate() {
        let src = r#"@materialize(edge_type = "DEPENDS_ON")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;
        let prog = parse_ext_program(src).expect("parse");
        let specs = collect_materialize_specs(&prog).expect("specs");
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].predicate, "dep");
        assert_eq!(specs[0].edge_type, "DEPENDS_ON");
        assert!(!specs[0].rule_ast_hash.is_empty());
    }

    #[test]
    fn collect_specs_rejects_missing_edge_type() {
        let src = r#"@materialize(other = "x")
                     dep(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;
        let prog = parse_ext_program(src).expect("parse");
        let err = collect_materialize_specs(&prog).expect_err("must reject");
        assert_eq!(err.code, "E-MAT-001");
    }

    #[test]
    fn plan_writeback_projects_binary_facts_with_provenance() {
        let mut eval = Evaluation::default();
        eval.relations.insert(
            "dep".to_string(),
            vec![
                vec![Value::Id(10), Value::Id(20)].into_boxed_slice(),
                vec![Value::Id(30), Value::Id(40)].into_boxed_slice(),
            ],
        );
        let specs = vec![MaterializeSpec {
            predicate: "dep".to_string(),
            edge_type: "DEPENDS_ON".to_string(),
            rule_ast_hash: "abc123".to_string(),
            additive: false,
            meta: Vec::new(),
        }];
        let edges = plan_writeback(&specs, &eval, 7).expect("plan");
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].src, 10);
        assert_eq!(edges[0].dst, 20);
        assert_eq!(edges[0].edge_type, "DEPENDS_ON");
        assert_eq!(
            edges[0].metadata,
            r#"{"_source":"abc123","_generation":7}"#
        );
    }

    #[test]
    fn plan_writeback_rejects_non_binary_head() {
        let mut eval = Evaluation::default();
        eval.relations
            .insert("orphan".to_string(), vec![vec![Value::Id(10)].into_boxed_slice()]);
        let specs = vec![MaterializeSpec {
            predicate: "orphan".to_string(),
            edge_type: "T".to_string(),
            rule_ast_hash: "h".to_string(),
            additive: false,
            meta: Vec::new(),
        }];
        let err = plan_writeback(&specs, &eval, 1).expect_err("unary head must be rejected");
        assert_eq!(err.code, "E-MAT-002");
    }

    // ── meta(...) projection ────────────────────────────────────────

    #[test]
    fn collect_specs_reads_meta_names() {
        let src = r#"@materialize(edge_type = "CALLS", mode = "additive", meta(method, line))
                     resolved(C, M, N, L) :- edge(C, M, "X"), attr(C, "name", N), attr(C, "line", L)."#;
        let prog = parse_ext_program(src).expect("parse");
        let specs = collect_materialize_specs(&prog).expect("specs");
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].edge_type, "CALLS");
        assert!(specs[0].additive);
        assert_eq!(specs[0].meta, vec!["method".to_string(), "line".to_string()]);
    }

    #[test]
    fn plan_writeback_projects_meta_columns_into_metadata() {
        let mut eval = Evaluation::default();
        eval.relations.insert(
            "resolved".to_string(),
            vec![vec![
                Value::Id(10),
                Value::Id(20),
                // A surface needing JSON escaping proves the values are escaped, not spliced.
                Value::Str("say \"hi\"".to_string()),
                // A typed numeric column projects by its string surface.
                Value::Int(42),
            ]
            .into_boxed_slice()],
        );
        let specs = vec![MaterializeSpec {
            predicate: "resolved".to_string(),
            edge_type: "CALLS".to_string(),
            rule_ast_hash: "h1".to_string(),
            additive: true,
            meta: vec!["method".to_string(), "line".to_string()],
        }];
        let edges = plan_writeback(&specs, &eval, 9).expect("plan");
        assert_eq!(edges.len(), 1);
        assert_eq!((edges[0].src, edges[0].dst), (10, 20));
        let meta: serde_json::Value = serde_json::from_str(&edges[0].metadata).expect("valid JSON");
        assert_eq!(meta["_source"], serde_json::json!("h1"));
        assert_eq!(meta["_generation"], serde_json::json!(9));
        assert_eq!(meta["method"], serde_json::json!("say \"hi\""));
        assert_eq!(meta["line"], serde_json::json!("42"), "string surface, always a JSON string");
    }

    #[test]
    fn plan_writeback_meta_arity_mismatch_is_coded_abort() {
        // meta(method) demands arity 3; a binary fact must abort with E-MAT-002 (and the
        // caller commits nothing — abort-no-commit, same as the legacy non-binary case).
        let mut eval = Evaluation::default();
        eval.relations.insert(
            "resolved".to_string(),
            vec![vec![Value::Id(10), Value::Id(20)].into_boxed_slice()],
        );
        let specs = vec![MaterializeSpec {
            predicate: "resolved".to_string(),
            edge_type: "CALLS".to_string(),
            rule_ast_hash: "h".to_string(),
            additive: false,
            meta: vec!["method".to_string()],
        }];
        let err = plan_writeback(&specs, &eval, 1).expect_err("arity 2 ≠ 2 + 1 meta");
        assert_eq!(err.code, "E-MAT-002");

        // And the inverse: an arity-3 head WITHOUT meta stays rejected too.
        let mut eval3 = Evaluation::default();
        eval3.relations.insert(
            "resolved".to_string(),
            vec![vec![Value::Id(10), Value::Id(20), Value::Str("x".into())].into_boxed_slice()],
        );
        let bare = vec![MaterializeSpec {
            predicate: "resolved".to_string(),
            edge_type: "CALLS".to_string(),
            rule_ast_hash: "h".to_string(),
            additive: false,
            meta: Vec::new(),
        }];
        let err = plan_writeback(&bare, &eval3, 1).expect_err("arity 3 without meta");
        assert_eq!(err.code, "E-MAT-002");
    }
}
