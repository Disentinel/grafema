//! The predicate binding table (spec §9.3): the per-predicate dual of compaction-⊕.
//!
//! `compaction/tag_fold.rs` guards, per *record*, that two tags of one fact key share a
//! `semiring_id` before it folds them (`E-FMT-002`). The binding table is the same guard
//! one level up: per *predicate*, it pins a single `(semiring_id, arity)` and the set of
//! rule hashes that derive it, so a program can never bind one predicate under two
//! semirings or two arities. That uniformity is what makes the per-record fold sound —
//! every record of predicate `p` is known to live in `p`'s one semiring.
//!
//! # Why a table, and why now
//!
//! At Gate B every predicate is `BoolTag`, so the *semiring* arm of the gate is not yet
//! reachable through the public eval surface — but the *arity* arm is (two clauses of one
//! predicate with different head arity is a malformed program the stratifier does not
//! reject). The semiring arm is exercised directly in the unit tests, the same way
//! `tag_fold` exercises its Count/Conf folds before any non-Bool semiring is materialized:
//! the mechanism is load-bearing the moment Gate C's tag-expression parser supplies a
//! per-predicate `semiring_id` other than `BoolTag`.
//!
//! # The `diff()` seam (for Gate C increments)
//!
//! [`BindingTable::diff`] is a pure comparison of two tables (this run vs. a prior run's
//! table) producing a [`BindingChange`] per predicate. The Gate C EDB Differ / increment
//! machinery consumes it to decide what must be re-derived: a predicate whose semiring or
//! arity changed, or whose defining rule set changed, cannot be incrementally maintained
//! and must be recomputed from scratch. No storage I/O lives here (I10) — persistence of a
//! prior-run table into the manifest is the increment machinery's concern, where its first
//! reader exists, not this gate's.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use super::parser_ext::ExtProgram;
use crate::error::GraphError;

/// Reserved [`crate::storage_v2::manifest::Manifest::tags`] key under which a materialization
/// run persists its binding table as a neutral JSON blob. The manifest `tags` map is an
/// opaque `String → String` channel (storage_v2 stores it without interpreting it — I10), so
/// the binding table crosses runs without storage_v2 ever depending on datalog2 types. The
/// next run loads the blob to diff its predicate set against this one (Gate C increments).
pub const MANIFEST_TAG_KEY: &str = "datalog2.binding_table";

/// What one predicate is bound to: its semiring, its head arity, and the set of normalized
/// rule-AST hashes (see [`super::materialize::rule_ast_hash`]) of the clauses that derive it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PredicateBinding {
    /// The semiring its provenance tags live in (`BOOLTAG_SEMIRING_ID` at Gate B).
    pub semiring_id: u16,
    /// The head arity — every clause of this predicate must agree.
    pub arity: usize,
    /// The normalized rule-AST hashes of the clauses defining this predicate. A `BTreeSet`
    /// so the table is order-independent and two runs that list clauses in a different
    /// source order produce equal tables (deterministic, I1).
    pub rule_hashes: BTreeSet<String>,
}

/// A binding violation: one predicate bound two incompatible ways within a single program.
///
/// Carries a stable taxonomy code (I5 — never a silent merge), mirroring `tag_fold`'s
/// per-record `E-FMT-002`. `E-BIND-001` is a semiring disagreement, `E-BIND-002` an arity
/// disagreement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingConflict {
    /// Stable code — the load-bearing field.
    pub code: &'static str,
    /// The predicate that was bound two ways.
    pub predicate: String,
    /// One-line human detail (never authoritative on its own).
    pub detail: String,
}

impl std::fmt::Display for BindingConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for BindingConflict {}

/// The predicate → binding registry for one program.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingTable {
    map: BTreeMap<String, PredicateBinding>,
}

impl BindingTable {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that a clause derives `predicate` under `semiring_id` with head `arity`,
    /// tagging it with `rule_hash`. Idempotent on `(predicate, semiring_id, arity)`: a
    /// second clause of the same predicate merely adds its hash to the set. A clash on
    /// `semiring_id` (`E-BIND-001`) or `arity` (`E-BIND-002`) is rejected — never merged.
    pub fn bind(
        &mut self,
        predicate: &str,
        semiring_id: u16,
        arity: usize,
        rule_hash: String,
    ) -> Result<(), BindingConflict> {
        match self.map.get_mut(predicate) {
            Some(existing) => {
                if existing.semiring_id != semiring_id {
                    return Err(BindingConflict {
                        code: "E-BIND-001",
                        predicate: predicate.to_string(),
                        detail: format!(
                            "predicate '{predicate}' already bound to semiring_id {} but a \
                             clause binds it to {semiring_id}",
                            existing.semiring_id
                        ),
                    });
                }
                if existing.arity != arity {
                    return Err(BindingConflict {
                        code: "E-BIND-002",
                        predicate: predicate.to_string(),
                        detail: format!(
                            "predicate '{predicate}' already bound at arity {} but a clause \
                             binds it at arity {arity}",
                            existing.arity
                        ),
                    });
                }
                existing.rule_hashes.insert(rule_hash);
            }
            None => {
                let mut rule_hashes = BTreeSet::new();
                rule_hashes.insert(rule_hash);
                self.map.insert(
                    predicate.to_string(),
                    PredicateBinding {
                        semiring_id,
                        arity,
                        rule_hashes,
                    },
                );
            }
        }
        Ok(())
    }

    /// Build the binding table for a parsed program, binding every rule's head predicate
    /// under one `semiring_id` (uniform at Gate B — the executor is monomorphic `BoolTag`).
    ///
    /// Returns the first [`BindingConflict`] encountered (a malformed program — e.g. two
    /// clauses of one predicate with different arity), so the gate fires before the caller
    /// commits anything.
    pub fn from_program(
        program: &ExtProgram,
        semiring_id: u16,
    ) -> Result<Self, BindingConflict> {
        let mut table = Self::new();
        for item in &program.items {
            let head = item.rule.head();
            let hash = super::materialize::rule_ast_hash(&item.rule);
            table.bind(head.predicate(), semiring_id, head.arity(), hash)?;
        }
        Ok(table)
    }

    /// Borrow one predicate's binding, if present.
    pub fn get(&self, predicate: &str) -> Option<&PredicateBinding> {
        self.map.get(predicate)
    }

    /// Iterate `(predicate, binding)` in predicate order.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &PredicateBinding)> {
        self.map.iter()
    }

    /// Number of bound predicates.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Whether the table binds no predicate.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Compare this table (the current run) against a `prev` run's table, predicate by
    /// predicate, producing one [`BindingChange`] for every predicate that differs. A
    /// predicate present and identical in both yields nothing. The result is ordered by
    /// predicate (deterministic). Pure — no I/O (I10).
    ///
    /// This is the seam Gate C's increment machinery consumes: a `SemiringChanged` or
    /// `ArityChanged` predicate cannot be incrementally maintained (its stored tags are in
    /// the wrong algebra / shape) and must be recomputed; a `RulesChanged` predicate's
    /// delta is bounded by the clauses that were added/removed; `Added`/`Removed` bound the
    /// fact-level work at the edges.
    pub fn diff(&self, prev: &BindingTable) -> Vec<BindingChange> {
        let mut changes = Vec::new();
        // Predicates in `self` (current): added or possibly changed.
        for (predicate, cur) in &self.map {
            match prev.map.get(predicate) {
                None => changes.push(BindingChange::Added {
                    predicate: predicate.clone(),
                }),
                Some(old) => {
                    if cur.semiring_id != old.semiring_id {
                        changes.push(BindingChange::SemiringChanged {
                            predicate: predicate.clone(),
                            from: old.semiring_id,
                            to: cur.semiring_id,
                        });
                    } else if cur.arity != old.arity {
                        changes.push(BindingChange::ArityChanged {
                            predicate: predicate.clone(),
                            from: old.arity,
                            to: cur.arity,
                        });
                    } else if cur.rule_hashes != old.rule_hashes {
                        let added: BTreeSet<String> =
                            cur.rule_hashes.difference(&old.rule_hashes).cloned().collect();
                        let removed: BTreeSet<String> =
                            old.rule_hashes.difference(&cur.rule_hashes).cloned().collect();
                        changes.push(BindingChange::RulesChanged {
                            predicate: predicate.clone(),
                            added,
                            removed,
                        });
                    }
                }
            }
        }
        // Predicates only in `prev`: removed.
        for predicate in prev.map.keys() {
            if !self.map.contains_key(predicate) {
                changes.push(BindingChange::Removed {
                    predicate: predicate.clone(),
                });
            }
        }
        changes.sort_by(|a, b| a.predicate().cmp(b.predicate()));
        changes
    }

    // ── Neutral manifest blob (cross-run persistence, §9.3) ──────────

    /// Serialize the table to the neutral JSON blob stored under [`MANIFEST_TAG_KEY`].
    /// Deterministic (the `BTreeMap`/`BTreeSet` ordering is canonical), so two equal tables
    /// produce byte-identical blobs (I1). Carries the FULL `rule_ast_hash` strings — the
    /// authoritative hash for increment decisions, distinct from the per-record u32
    /// `ProvenanceV2.rule_ast_hash` segment index (which is a separate, lossy locator).
    pub fn to_blob(&self) -> String {
        // A map of plain strings/ints over BTree containers cannot fail to serialize.
        serde_json::to_string(self).unwrap_or_else(|_| "{\"map\":{}}".to_string())
    }

    /// Parse a binding table from its [`to_blob`](Self::to_blob) JSON. A corrupt blob (or one
    /// from an incompatible build) is `E-FMT-004` — never a silent empty table (I11), which
    /// would force a spurious recompute or a wrong delta.
    pub fn from_blob(blob: &str) -> Result<Self, GraphError> {
        serde_json::from_str(blob)
            .map_err(|e| GraphError::MalformedBindingBlob(e.to_string()))
    }

    /// Store this table into a manifest `tags` map under [`MANIFEST_TAG_KEY`].
    pub fn store_in_tags(&self, tags: &mut HashMap<String, String>) {
        tags.insert(MANIFEST_TAG_KEY.to_string(), self.to_blob());
    }

    /// Load the prior run's table from a manifest `tags` map, or `Ok(None)` if the key is
    /// absent (a first run / a generation written before binding tables existed — the
    /// increment path then falls back to a full recompute). A present-but-corrupt blob is
    /// `E-FMT-004`, surfaced rather than swallowed.
    pub fn load_from_tags(tags: &HashMap<String, String>) -> Result<Option<Self>, GraphError> {
        match tags.get(MANIFEST_TAG_KEY) {
            Some(blob) => Self::from_blob(blob).map(Some),
            None => Ok(None),
        }
    }
}

/// One predicate's change between a prior run's binding table and the current one.
///
/// `SemiringChanged`/`ArityChanged` are *recompute* signals (the stored tags are in the
/// wrong algebra/shape); `RulesChanged` bounds the delta by the added/removed clauses;
/// `Added`/`Removed` bound the fact-level work at the edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingChange {
    /// A predicate the current run binds that the prior run did not.
    Added { predicate: String },
    /// A predicate the prior run bound that the current run does not.
    Removed { predicate: String },
    /// The predicate's semiring changed — a full recompute signal.
    SemiringChanged {
        predicate: String,
        from: u16,
        to: u16,
    },
    /// The predicate's head arity changed — a full recompute signal.
    ArityChanged {
        predicate: String,
        from: usize,
        to: usize,
    },
    /// Same semiring and arity, but the set of defining clauses changed.
    RulesChanged {
        predicate: String,
        added: BTreeSet<String>,
        removed: BTreeSet<String>,
    },
}

impl BindingChange {
    /// The predicate this change is about (for ordering / lookup).
    pub fn predicate(&self) -> &str {
        match self {
            BindingChange::Added { predicate }
            | BindingChange::Removed { predicate }
            | BindingChange::SemiringChanged { predicate, .. }
            | BindingChange::ArityChanged { predicate, .. }
            | BindingChange::RulesChanged { predicate, .. } => predicate,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datalog2::parser_ext::parse_ext_program;
    use crate::storage_v2::types::{
        BOOLTAG_SEMIRING_ID, CONFTAG_SEMIRING_ID, COUNTTAG_SEMIRING_ID,
    };

    fn bool_table_from(src: &str) -> Result<BindingTable, BindingConflict> {
        let program = parse_ext_program(src).expect("program parses");
        BindingTable::from_program(&program, BOOLTAG_SEMIRING_ID)
    }

    #[test]
    fn two_clauses_one_predicate_merge_rule_hashes() {
        // `path` is defined by two clauses of equal arity → one binding, two hashes.
        let table = bool_table_from(
            "path(A, B) :- edge(A, B).\n\
             path(A, B) :- edge(A, C), path(C, B).",
        )
        .expect("uniform arity → no conflict");
        let b = table.get("path").expect("path bound");
        assert_eq!(b.semiring_id, BOOLTAG_SEMIRING_ID);
        assert_eq!(b.arity, 2);
        assert_eq!(b.rule_hashes.len(), 2, "two distinct clauses → two hashes");
    }

    #[test]
    fn arity_disagreement_is_e_bind_002() {
        // Same predicate at arity 2 then arity 3 — malformed, and NOT caught upstream.
        let err = bool_table_from("p(A, B) :- e(A, B).\np(A, B, C) :- e(A, B), e(B, C).")
            .expect_err("arity clash must be rejected");
        assert_eq!(err.code, "E-BIND-002");
        assert_eq!(err.predicate, "p");
    }

    /// The load-bearing semiring arm: not reachable through the all-`BoolTag` eval surface
    /// yet, so asserted directly (as `tag_fold` asserts its Count/Conf folds). The moment a
    /// `@tag(count)` rule supplies a non-Bool `semiring_id`, this gate stops a program from
    /// binding one predicate to two semirings.
    #[test]
    fn semiring_disagreement_is_e_bind_001() {
        let mut table = BindingTable::new();
        table
            .bind("dep", COUNTTAG_SEMIRING_ID, 2, "h1".into())
            .expect("first bind");
        let err = table
            .bind("dep", CONFTAG_SEMIRING_ID, 2, "h2".into())
            .expect_err("semiring clash must be rejected");
        assert_eq!(err.code, "E-BIND-001");
        assert_eq!(err.predicate, "dep");
        // The first binding is untouched by the rejected second bind.
        assert_eq!(table.get("dep").unwrap().semiring_id, COUNTTAG_SEMIRING_ID);
        assert_eq!(table.get("dep").unwrap().rule_hashes.len(), 1);
    }

    #[test]
    fn rebinding_same_shape_is_idempotent_on_hash() {
        let mut table = BindingTable::new();
        table.bind("p", BOOLTAG_SEMIRING_ID, 2, "h1".into()).unwrap();
        table.bind("p", BOOLTAG_SEMIRING_ID, 2, "h1".into()).unwrap();
        assert_eq!(table.get("p").unwrap().rule_hashes.len(), 1, "same hash dedups");
        table.bind("p", BOOLTAG_SEMIRING_ID, 2, "h2".into()).unwrap();
        assert_eq!(table.get("p").unwrap().rule_hashes.len(), 2, "new hash adds");
    }

    #[test]
    fn diff_reports_added_removed_rules_changed() {
        let prev = bool_table_from("p(A, B) :- e(A, B).").unwrap();
        // Current: `p` gains a second clause, and a new predicate `q` appears.
        let cur = bool_table_from(
            "p(A, B) :- e(A, B).\n\
             p(A, B) :- e(A, C), p(C, B).\n\
             q(A) :- e(A, A).",
        )
        .unwrap();
        let changes = cur.diff(&prev);
        // Ordered by predicate: p (RulesChanged) before q (Added).
        assert_eq!(changes.len(), 2);
        match &changes[0] {
            BindingChange::RulesChanged { predicate, added, removed } => {
                assert_eq!(predicate, "p");
                assert_eq!(added.len(), 1, "one clause added to p");
                assert!(removed.is_empty());
            }
            other => panic!("expected p RulesChanged, got {other:?}"),
        }
        assert!(matches!(&changes[1], BindingChange::Added { predicate } if predicate == "q"));
    }

    #[test]
    fn diff_reports_arity_change_as_recompute_signal() {
        let prev = bool_table_from("p(A, B) :- e(A, B).").unwrap();
        let cur = bool_table_from("p(A, B, C) :- e(A, B), e(B, C).").unwrap();
        let changes = cur.diff(&prev);
        assert_eq!(changes.len(), 1);
        assert!(matches!(
            &changes[0],
            BindingChange::ArityChanged { predicate, from: 2, to: 3 } if predicate == "p"
        ));
    }

    #[test]
    fn diff_reports_removed_predicate() {
        let prev = bool_table_from("p(A, B) :- e(A, B).\nq(A) :- e(A, A).").unwrap();
        let cur = bool_table_from("p(A, B) :- e(A, B).").unwrap();
        let changes = cur.diff(&prev);
        assert_eq!(changes.len(), 1);
        assert!(matches!(&changes[0], BindingChange::Removed { predicate } if predicate == "q"));
    }

    // ── Neutral manifest blob (cross-run persistence) ────────────────

    #[test]
    fn blob_round_trips_through_manifest_tags() {
        let table = bool_table_from(
            "path(A, B) :- e(A, B).\n\
             path(A, B) :- e(A, C), path(C, B).\n\
             q(A) :- e(A, A).",
        )
        .unwrap();
        let mut tags: HashMap<String, String> = HashMap::new();
        table.store_in_tags(&mut tags);
        assert!(tags.contains_key(MANIFEST_TAG_KEY), "blob stored under reserved key");

        let loaded = BindingTable::load_from_tags(&tags)
            .expect("well-formed blob parses")
            .expect("key present");
        assert_eq!(loaded, table, "manifest blob round-trips the binding table");
        // The full rule hashes survive (the authoritative increment key, not the u32 index).
        assert_eq!(loaded.get("path").unwrap().rule_hashes.len(), 2);
    }

    #[test]
    fn load_from_tags_absent_key_is_none() {
        let tags: HashMap<String, String> = HashMap::new();
        assert!(
            BindingTable::load_from_tags(&tags).unwrap().is_none(),
            "first run / pre-binding-table generation → None, caller recomputes"
        );
    }

    #[test]
    fn corrupt_blob_is_e_fmt_004_not_silent_empty() {
        let mut tags: HashMap<String, String> = HashMap::new();
        tags.insert(MANIFEST_TAG_KEY.to_string(), "{not valid json".to_string());
        let err = BindingTable::load_from_tags(&tags).expect_err("corrupt blob must error");
        assert_eq!(err.code(), "E-FMT-004");
    }

    #[test]
    fn blob_is_deterministic() {
        // Same program, different source order → equal tables → byte-identical blobs (I1).
        let a = bool_table_from("p(A, B) :- e(A, B).\nq(A) :- e(A, A).").unwrap();
        let b = bool_table_from("q(A) :- e(A, A).\np(A, B) :- e(A, B).").unwrap();
        assert_eq!(a.to_blob(), b.to_blob(), "canonical ordering → stable blob");
    }

    #[test]
    fn identical_tables_diff_empty() {
        let a = bool_table_from("p(A, B) :- e(A, B).\nq(A) :- e(A, A).").unwrap();
        let b = bool_table_from("q(A) :- e(A, A).\np(A, B) :- e(A, B).").unwrap();
        assert!(a.diff(&b).is_empty(), "same program, different source order → equal tables");
    }
}
