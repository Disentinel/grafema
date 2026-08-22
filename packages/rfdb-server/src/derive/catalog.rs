//! The predicate catalog (rofl-fact-model.md §3.1) — declared physics per predicate.
//!
//! P1 scope: the catalog is ENGINE-RESIDENT — constructed at the derive entry, one per
//! evaluation context, with ZERO `storage_v2` dependencies (so §8 rule 1 already holds
//! and the future extraction into the `rfdb-facts` crate is a pure move). §3.1's
//! «каталог живёт в манифесте» and the compaction-driven [`PredicateStats`] become true
//! in P2/P3 when the store seam exists; P1 is normatively "no format change" (§10.4).
//!
//! Population in P1:
//! - [`PredicateCatalog::with_base_relations`] pre-registers exactly the five base
//!   relations the planner serves from storage (`plan.rs` `BASE_RELATIONS`), with
//!   arities matching the executor's builtin registry (locked by a drift-guard test).
//! - [`PredicateCatalog::declare_default`] registers every rule-head name at plan
//!   construction (`plan::plan_program_with_catalog`) — the single, minimal
//!   "everything references the catalog" wiring. Registration is OBSERVATIONAL in P1:
//!   no planning decision reads the catalog (guarded by a plan-equality test); the
//!   `(PredicateId, SortOrder, bound_mask)` dispatch migration that makes the planner
//!   consume it is P3 (§3.4).
//!
//! §2.7's reflexive predicates (`rule/2`, `asserted_by/2`, …) are deliberately NOT
//! pre-declared: they have no facts and no consumers until P4, and a dead registry
//! would be an empty implementation.

use std::collections::HashMap;

/// A catalog-interned predicate identifier (§3.1: `u32`, dense, insertion-ordered
/// within a catalog instance).
///
/// DISTINCT from `derive::value::PredicateId` (a `u64` plan-resolved hash id,
/// `value.rs:13`) — the two are unified by P3's dispatch migration, not before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CatalogPredicateId(pub u32);

/// An interned author identifier (§2.2). P1 carries the TYPE only: priority lists are
/// always empty until assertions land (P4/P5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AuthorId(pub u32);

/// The physical strategy of a predicate (§3.1 table): tuple shape + sort keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PhysStrategy {
    /// `(Id, Id)` tuples; sort keys `(c0, c1)` AND `(c1, c0)` — two runs. Inherits the
    /// edge segments (src/dst blooms, per-predicate zone map).
    Adjacency,
    /// `(Id, Scalar)` tuples; `(c0)` forward, `(c1, c0)` reverse when declared.
    /// Inherits node segments, string table, bloom on `c0`.
    Attribute,
    /// `(Id, S1..Sk)`, k ≤ 8; sort key `(c0)`. Node segments; n-ary tuple in one row.
    Composite,
    /// Arbitrary arity; sort key `(c0)` by default. The default for the open predicate
    /// space — a new predicate needs nobody's permission (§3.1).
    Nary,
    /// `(Fid, …)` — `Adjacency` with `c0 = fid` instead of an entity id.
    Reified,
}

/// Fact multiplicity per key (§2.3). `Functional` is DECLARABLE in P1 but attaches no
/// behavior — conflict resolution (`conflict/5`, `E-FUNC-001`) is P5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Cardinality {
    /// Any number of live facts per key — the default.
    MultiValued,
    /// At most one live fact per key (enforcement lands in P5).
    Functional,
}

/// Temporal scope of a predicate's facts (§2.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TemporalScope {
    /// Facts hold independent of the tick — the default.
    Timeless,
    /// Facts are indexed by tick (the run/simulation dimension).
    Ticked,
}

/// Planner statistics (§3.1 — «НЕ опционально»: the FIELD exists from P1 on, keeping
/// the normative struct shape). `updated_at_tx == 0` means "never computed" — the
/// defined P1 state; computation, compaction updates, and manifest persistence are P3
/// (§10.4 phase table), which is the named owner.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PredicateStats {
    /// Exact live fact count.
    pub live_facts: u64,
    /// Exact live assertion count.
    pub live_asserts: u64,
    /// Per column: number of distinct values.
    pub distinct: Box<[u64]>,
    /// max |{rows sharing key_cols[0]}|.
    pub max_fanout: u64,
    /// Manifest version the stats were computed at; 0 = never computed.
    pub updated_at_tx: u64,
}

/// A predicate declaration (§3.1, fields verbatim): the ONE place a predicate gets its
/// physics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PredicateDecl {
    /// Catalog-interned id (dense, insertion order within this catalog instance).
    pub id: CatalogPredicateId,
    /// Predicate name (e.g. `"edge"`, `"CALLS"`, `"name"`).
    pub name: String,
    /// The single arity contract (replaces `E-MAT-002`/`E-MAT-009` in later phases).
    pub arity: u8,
    /// Physical strategy (§3.1 table).
    pub strategy: PhysStrategy,
    /// §2.3 — `Functional` | `MultiValued`.
    pub cardinality: Cardinality,
    /// §2.8 — `Timeless` | `Ticked`.
    pub temporal: TemporalScope,
    /// Semiring id; `BOOLTAG_SEMIRING_ID` (= 0) by default.
    pub semiring: u16,
    /// Column indexes forming the sort key.
    pub key_cols: Box<[u8]>,
    /// §6.3 — the reverse run's sort key, when declared.
    pub reverse: Option<Box<[u8]>>,
    /// §2.3 step 1 of conflict resolution. Always empty in P1 (authors land in P4).
    pub author_priority: Box<[AuthorId]>,
    /// §3.4 planner stats — zeroed until P3 computes them.
    pub stats: PredicateStats,
}

/// A catalog rejection (stable string code per the `ExecCode` convention).
///
/// `E-CAT-001` — conflicting redeclaration: same name, any differing DECLARED field
/// (arity/strategy/cardinality/temporal/semiring/key_cols/reverse/author_priority —
/// everything except the assigned `id` and the runtime-mutable `stats`). A physical-axis
/// difference is never silently dropped: P3+ dispatch and tag_fold key off
/// semiring/key_cols. (`E-CAT-002`, the undeclared-predicate gate on the read path,
/// is P3.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError {
    /// The stable taxonomy code: `"E-CAT-001"`.
    pub code: &'static str,
    /// Human-oriented hint (never load-bearing).
    pub detail: String,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for CatalogError {}

/// The predicate catalog: name → id interning (dense `u32`, insertion order) plus the
/// declarations.
#[derive(Debug, Clone, Default)]
pub struct PredicateCatalog {
    ids: HashMap<String, CatalogPredicateId>,
    decls: Vec<PredicateDecl>,
}

impl PredicateCatalog {
    /// An empty catalog (no base relations — prefer [`Self::with_base_relations`] for
    /// an evaluation context).
    pub fn new() -> Self {
        Self::default()
    }

    /// A catalog pre-registered with exactly the five base relations the planner
    /// serves from storage. Arities mirror the executor's builtin registry
    /// (`builtin.rs` — `node/2`, `type/2`, `edge/3`, `incoming/3`, `attr/3`); the
    /// name set mirrors `plan.rs` `BASE_RELATIONS` (drift-guarded by tests in both
    /// directions).
    ///
    /// Reverse runs per the §6.3 normative matrix:
    /// - `edge` (Adjacency, key `(0,1)`) declares reverse `(1,0)` — the incoming run.
    /// - `incoming` IS `edge`'s reverse run per §6.3, but the planner treats it as its
    ///   own relation name (`plan.rs`), so P1 registers it as its own Adjacency decl
    ///   keyed `(1,0)`; P3's dispatch migration folds it into `edge`'s reverse
    ///   `SortOrder`.
    /// - `node`/`type` (Attribute over the node-type column) and `attr` declare the
    ///   `(1,0)` reverse — §6.3 gives `node_type` a reverse run (today's `by_type` L1
    ///   index) and the attr families (`file`/`name`) likewise.
    pub fn with_base_relations() -> Self {
        let mut cat = Self::new();
        let adjacency = |name: &str, arity: u8, key: &[u8], rev: &[u8]| PredicateDecl {
            id: CatalogPredicateId(0), // assigned by declare()
            name: name.to_string(),
            arity,
            strategy: PhysStrategy::Adjacency,
            cardinality: Cardinality::MultiValued,
            temporal: TemporalScope::Timeless,
            semiring: crate::storage_v2::types::BOOLTAG_SEMIRING_ID,
            key_cols: key.into(),
            reverse: Some(rev.into()),
            author_priority: Box::new([]),
            stats: PredicateStats::default(),
        };
        let attribute = |name: &str, arity: u8| PredicateDecl {
            id: CatalogPredicateId(0),
            name: name.to_string(),
            arity,
            strategy: PhysStrategy::Attribute,
            cardinality: Cardinality::MultiValued,
            temporal: TemporalScope::Timeless,
            semiring: crate::storage_v2::types::BOOLTAG_SEMIRING_ID,
            key_cols: Box::new([0]),
            reverse: Some(Box::new([1, 0])),
            author_priority: Box::new([]),
            stats: PredicateStats::default(),
        };
        // Registration order = the planner's BASE_RELATIONS order (ids are dense and
        // insertion-ordered; NOT load-bearing — §9.2 forbids hashing interned ids).
        cat.declare(attribute("node", 2)).expect("fresh catalog");
        cat.declare(attribute("type", 2)).expect("fresh catalog");
        cat.declare(adjacency("edge", 3, &[0, 1], &[1, 0]))
            .expect("fresh catalog");
        cat.declare(adjacency("incoming", 3, &[1, 0], &[0, 1]))
            .expect("fresh catalog");
        cat.declare(attribute("attr", 3)).expect("fresh catalog");
        cat
    }

    /// Declare a predicate. Identical redeclaration (same name AND every declared field
    /// equal — arity/strategy/cardinality/temporal/semiring/key_cols/reverse/
    /// author_priority; the assigned `id` and runtime `stats` are excluded) is
    /// idempotent and returns the existing id; ANY other redeclaration is rejected with
    /// `E-CAT-001`, never merged and never silently dropped — a same-logical-shape
    /// redeclare that differs in a physical axis (semiring/key_cols/reverse) would
    /// otherwise be a latent silent-swallow once P3 dispatch and tag_fold key off those
    /// fields.
    pub fn declare(&mut self, decl: PredicateDecl) -> Result<CatalogPredicateId, CatalogError> {
        if let Some(&id) = self.ids.get(&decl.name) {
            let existing = &self.decls[id.0 as usize];
            let identical = existing.arity == decl.arity
                && existing.strategy == decl.strategy
                && existing.cardinality == decl.cardinality
                && existing.temporal == decl.temporal
                && existing.semiring == decl.semiring
                && existing.key_cols == decl.key_cols
                && existing.reverse == decl.reverse
                && existing.author_priority == decl.author_priority;
            if identical {
                return Ok(id);
            }
            return Err(CatalogError {
                code: "E-CAT-001",
                detail: format!(
                    "conflicting redeclaration of '{}': existing (arity {}, {:?}, {:?}, {:?}, semiring {}, key {:?}, reverse {:?}, priority {:?}) vs new (arity {}, {:?}, {:?}, {:?}, semiring {}, key {:?}, reverse {:?}, priority {:?})",
                    decl.name,
                    existing.arity,
                    existing.strategy,
                    existing.cardinality,
                    existing.temporal,
                    existing.semiring,
                    existing.key_cols,
                    existing.reverse,
                    existing.author_priority,
                    decl.arity,
                    decl.strategy,
                    decl.cardinality,
                    decl.temporal,
                    decl.semiring,
                    decl.key_cols,
                    decl.reverse,
                    decl.author_priority,
                ),
            });
        }
        let id = CatalogPredicateId(
            u32::try_from(self.decls.len()).expect("catalog cannot exceed u32 predicates"),
        );
        let mut decl = decl;
        decl.id = id;
        self.ids.insert(decl.name.clone(), id);
        self.decls.push(decl);
        Ok(id)
    }

    /// Name-level get-or-declare with the §3.1 DEFAULT rule: an undeclared `name`
    /// receives `Nary` / `MultiValued` / `Timeless` / BoolTag semiring / key `(c0)` /
    /// no reverse / empty author priority / zeroed stats. A name that is ALREADY
    /// declared returns its existing id WITHOUT mutating the declaration — the default
    /// rule applies only to undeclared predicates, so this can never conflict (that is
    /// what lets rule-head registration run on every program without changing any
    /// pre-P1 acceptance; strict head validation is P3's `E-CAT-002`).
    pub fn declare_default(&mut self, name: &str, arity: u8) -> CatalogPredicateId {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        self.declare(PredicateDecl {
            id: CatalogPredicateId(0),
            name: name.to_string(),
            arity,
            strategy: PhysStrategy::Nary,
            cardinality: Cardinality::MultiValued,
            temporal: TemporalScope::Timeless,
            semiring: crate::storage_v2::types::BOOLTAG_SEMIRING_ID,
            key_cols: Box::new([0]),
            reverse: None,
            author_priority: Box::new([]),
            stats: PredicateStats::default(),
        })
        .expect("declare of an absent name cannot conflict")
    }

    /// Look up a declaration by name.
    pub fn get(&self, name: &str) -> Option<&PredicateDecl> {
        self.ids.get(name).map(|id| &self.decls[id.0 as usize])
    }

    /// Look up a declaration by interned id.
    pub fn get_by_id(&self, id: CatalogPredicateId) -> Option<&PredicateDecl> {
        self.decls.get(id.0 as usize)
    }

    /// Iterate declarations in insertion (id) order.
    pub fn iter(&self) -> impl Iterator<Item = &PredicateDecl> {
        self.decls.iter()
    }

    /// Number of declared predicates.
    pub fn len(&self) -> usize {
        self.decls.len()
    }

    /// Whether the catalog has no declarations.
    pub fn is_empty(&self) -> bool {
        self.decls.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_relations_registered_with_executor_arities() {
        let cat = PredicateCatalog::with_base_relations();
        // Exactly the base relations, each arity read LIVE from the executor's builtin
        // registry (builtin.rs `registry()`) — a mechanical lock like the name drift
        // guard below, so an arity change in `registry()` fails HERE instead of
        // silently diverging from the catalog registration.
        let registry = crate::derive::builtin::registry();
        assert_eq!(cat.len(), crate::derive::plan::BASE_RELATIONS.len());
        for name in crate::derive::plan::BASE_RELATIONS {
            let executor_arity = registry
                .iter()
                .find(|b| b.name == *name)
                .unwrap_or_else(|| panic!("{name} must be an executor builtin"))
                .arity;
            let decl = cat.get(name).unwrap_or_else(|| panic!("{name} registered"));
            assert_eq!(
                usize::from(decl.arity),
                executor_arity,
                "{name} arity must match the executor's registry()"
            );
            assert!(
                decl.reverse.is_some(),
                "{name}: every base relation carries a §6.3 reverse run"
            );
            assert_eq!(decl.semiring, crate::storage_v2::types::BOOLTAG_SEMIRING_ID);
        }
        // edge is Adjacency keyed (0,1) with reverse (1,0); incoming is the reverse-run
        // VIEW registered as its own name, keyed (1,0) (folded into edge in P3).
        let edge = cat.get("edge").unwrap();
        assert_eq!(edge.strategy, PhysStrategy::Adjacency);
        assert_eq!(&edge.key_cols[..], &[0, 1]);
        assert_eq!(edge.reverse.as_deref(), Some(&[1u8, 0][..]));
        let incoming = cat.get("incoming").unwrap();
        assert_eq!(incoming.strategy, PhysStrategy::Adjacency);
        assert_eq!(&incoming.key_cols[..], &[1, 0]);
    }

    /// Drift guard: the catalog's base-name set must equal the planner's
    /// `BASE_RELATIONS` (plan.rs) so the P3 dispatch migration cannot silently diverge
    /// from the P1 registration.
    #[test]
    fn base_names_match_plan_base_relations() {
        let cat = PredicateCatalog::with_base_relations();
        let catalog_names: std::collections::BTreeSet<&str> =
            cat.iter().map(|d| d.name.as_str()).collect();
        let plan_names: std::collections::BTreeSet<&str> =
            crate::derive::plan::BASE_RELATIONS.iter().copied().collect();
        assert_eq!(
            catalog_names, plan_names,
            "catalog base registration and plan.rs BASE_RELATIONS must stay in lockstep"
        );
    }

    #[test]
    fn declare_default_applies_the_section_3_1_default_rule() {
        let mut cat = PredicateCatalog::with_base_relations();
        let id = cat.declare_default("reaches", 2);
        let decl = cat.get_by_id(id).expect("declared");
        assert_eq!(decl.name, "reaches");
        assert_eq!(decl.arity, 2);
        assert_eq!(decl.strategy, PhysStrategy::Nary);
        assert_eq!(decl.cardinality, Cardinality::MultiValued);
        assert_eq!(decl.temporal, TemporalScope::Timeless);
        assert_eq!(decl.semiring, crate::storage_v2::types::BOOLTAG_SEMIRING_ID);
        assert_eq!(decl.reverse, None);
        assert!(decl.author_priority.is_empty());
        assert_eq!(decl.stats, PredicateStats::default());
        assert_eq!(decl.stats.updated_at_tx, 0, "0 = never computed (P3 owns computation)");
    }

    #[test]
    fn declare_default_is_name_level_get_or_declare() {
        let mut cat = PredicateCatalog::with_base_relations();
        let a = cat.declare_default("reaches", 2);
        let b = cat.declare_default("reaches", 2);
        assert_eq!(a, b, "same name interns to the same id");
        // An already-declared name returns its id WITHOUT mutation (the §3.1 default
        // rule applies only to undeclared predicates) — including a base relation.
        let edge_id = cat.declare_default("edge", 3);
        assert_eq!(edge_id, cat.get("edge").unwrap().id);
        assert_eq!(
            cat.get("edge").unwrap().strategy,
            PhysStrategy::Adjacency,
            "declare_default must not overwrite an existing declaration"
        );
        assert_eq!(cat.len(), 6, "no duplicate decl rows created");
    }

    #[test]
    fn conflicting_redeclaration_is_e_cat_001_identical_is_idempotent() {
        let mut cat = PredicateCatalog::with_base_relations();
        let id = cat.declare_default("supersedes", 2);
        // Identical redeclare: idempotent, same id.
        let again = cat
            .declare(cat.get("supersedes").unwrap().clone())
            .expect("identical redeclare is idempotent");
        assert_eq!(id, again);
        // Conflicting arity → E-CAT-001.
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.arity = 3;
        let err = cat.declare(conflicting).unwrap_err();
        assert_eq!(err.code, "E-CAT-001");
        // Conflicting strategy → E-CAT-001.
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.strategy = PhysStrategy::Adjacency;
        assert_eq!(cat.declare(conflicting).unwrap_err().code, "E-CAT-001");
        // Conflicting cardinality → E-CAT-001 (Functional is declarable, P5 behavior).
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.cardinality = Cardinality::Functional;
        assert_eq!(cat.declare(conflicting).unwrap_err().code, "E-CAT-001");
        // Conflicting temporal → E-CAT-001.
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.temporal = TemporalScope::Ticked;
        assert_eq!(cat.declare(conflicting).unwrap_err().code, "E-CAT-001");
        // Physical axes: a redeclare with the SAME four logical axes but a different
        // semiring / key_cols / reverse / author_priority is a CONFLICT, not a silent
        // drop — P3 dispatch and tag_fold key off these fields.
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.semiring = crate::storage_v2::types::BOOLTAG_SEMIRING_ID + 1;
        assert_eq!(cat.declare(conflicting).unwrap_err().code, "E-CAT-001");
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.key_cols = Box::new([1]);
        assert_eq!(cat.declare(conflicting).unwrap_err().code, "E-CAT-001");
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.reverse = Some(Box::new([1, 0]));
        assert_eq!(cat.declare(conflicting).unwrap_err().code, "E-CAT-001");
        let mut conflicting = cat.get("supersedes").unwrap().clone();
        conflicting.author_priority = Box::new([AuthorId(7)]);
        assert_eq!(cat.declare(conflicting).unwrap_err().code, "E-CAT-001");
        // The catalog is unchanged after the rejections.
        assert_eq!(cat.get("supersedes").unwrap().arity, 2);
        assert_eq!(
            cat.get("supersedes").unwrap().semiring,
            crate::storage_v2::types::BOOLTAG_SEMIRING_ID
        );
    }

    #[test]
    fn ids_are_dense_and_insertion_ordered() {
        let mut cat = PredicateCatalog::new();
        let a = cat.declare_default("a", 1);
        let b = cat.declare_default("b", 2);
        let c = cat.declare_default("c", 3);
        assert_eq!((a, b, c), (CatalogPredicateId(0), CatalogPredicateId(1), CatalogPredicateId(2)));
        // Roundtrip name → id → decl.
        for (name, id) in [("a", a), ("b", b), ("c", c)] {
            assert_eq!(cat.get(name).unwrap().id, id);
            assert_eq!(cat.get_by_id(id).unwrap().name, name);
        }
        // Functional is declarable in P1 (types only; behavior is P5).
        let mut functional = cat.get("a").unwrap().clone();
        functional.name = "sid".to_string();
        functional.cardinality = Cardinality::Functional;
        let sid = cat.declare(functional).expect("declarable");
        assert_eq!(
            cat.get_by_id(sid).unwrap().cardinality,
            Cardinality::Functional
        );
    }
}
