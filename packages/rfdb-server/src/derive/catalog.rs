//! The predicate catalog (rofl-fact-model.md §3.1) — declared physics per predicate.
//!
//! P1 scope: the catalog is ENGINE-RESIDENT — constructed at the derive entry, one per
//! evaluation context, with ZERO `storage_v2` dependencies (so §8 rule 1 already holds
//! and the future extraction into the `rfdb-facts` crate is a pure move). §3.1's
//! «каталог живёт в манифесте» and the compaction-driven [`PredicateStats`] become true
//! in P2/P3 when the store seam exists; P1 is normatively "no format change" (§10.4).
//!
//! Population (P1, made LIVE by P3):
//! - [`PredicateCatalog::with_base_relations`] pre-registers exactly the five base
//!   relation SURFACE names the planner serves from storage, with arities matching
//!   the executor's builtin registry (locked by a drift-guard test), and — P3 —
//!   the name → [`BaseDispatch`] resolution the planner and executor key on
//!   (`incoming` = `edge`'s Reverse run, `type` = `node`; §6.3 / §3.4).
//! - [`PredicateCatalog::declare_strict`] registers every rule-head name (strict
//!   arity validation, `E-CAT-002`) and every §3.1 open-space body-only name at
//!   plan construction (`plan::plan_program_with_catalog`). Since P3 the planner
//!   CONSUMES the catalog: base-leg classification via [`Self::base_dispatch`],
//!   cardinality via each decl's [`PredicateStats`]
//!   ([`Self::populate_base_live_stats`]).
//!
//! §2.7's reflexive predicates (`rule/2`, `asserted_by/2`, …) are deliberately NOT
//! pre-declared: they have no facts and no consumers until P4, and a dead registry
//! would be an empty implementation.

use std::collections::HashMap;

use crate::facts::SortOrder;

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
/// semiring/key_cols.
///
/// `E-CAT-002` (P3) — the undeclared/conflicting-predicate gate: strict head
/// validation ([`PredicateCatalog::declare_head_strict`], ledger round-005 C3) and the
/// FactStore read path's unknown-`CatalogPredicateId` rejection (migrated from P2's
/// `E-CAT-001` per round-007-pre C10). At the planner it surfaces as
/// `PlanCode::CatalogRejected` with the same stable string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError {
    /// The stable taxonomy code: `"E-CAT-001"` | `"E-CAT-002"`.
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

/// The plan-time-resolved dispatch key of a storage-served base-relation leg (P3,
/// §3.4 normative 1): the OWNING predicate's catalog id and which declared run
/// serves the leg. This is where the two name-level aliases dissolve (§6.3):
/// `incoming` resolves to `edge`'s id with [`SortOrder::Reverse`] (incoming IS
/// edge's reverse run), and `type` resolves to `node`'s id (the registry alias).
/// The executor keys its generalized build-once instances on
/// `(id, order, bound_column_mask)`; the estimator reads the resolved decl's
/// physics + [`PredicateStats`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseDispatch {
    /// Catalog id of the OWNING predicate (`incoming` → `edge`'s id, `type` →
    /// `node`'s id).
    pub id: CatalogPredicateId,
    /// Which declared run serves the leg (§3.1 `key_cols` vs `reverse`).
    pub order: SortOrder,
    /// The owning decl's physical strategy — copied at resolution so the executor
    /// (which holds no catalog) selects its build-once instance from the physics.
    pub strategy: PhysStrategy,
    /// The owning decl's arity (same rationale).
    pub arity: u8,
}

/// The predicate catalog: name → id interning (dense `u32`, insertion order) plus the
/// declarations.
#[derive(Debug, Clone, Default)]
pub struct PredicateCatalog {
    ids: HashMap<String, CatalogPredicateId>,
    decls: Vec<PredicateDecl>,
    /// P3: name → storage-served dispatch key for the base-relation SURFACE names.
    /// Populated by [`Self::with_base_relations`] only — rule heads and §3.1
    /// open-space defaults never enter here, so `base_dispatch` is also the
    /// planner's base-leg classification predicate (the single owner of what
    /// used to be `plan.rs::BASE_RELATIONS`).
    base_names: HashMap<String, BaseDispatch>,
}

impl PredicateCatalog {
    /// An empty catalog (no base relations — prefer [`Self::with_base_relations`] for
    /// an evaluation context).
    pub fn new() -> Self {
        Self::default()
    }

    /// A catalog pre-registered with exactly the five base relation SURFACE names
    /// the planner serves from storage — since P3 this registration IS the owner of
    /// the base name set (`plan.rs::BASE_RELATIONS` retired with round-009).
    /// Arities mirror the executor's builtin registry (`builtin.rs` — `node/2`,
    /// `type/2`, `edge/3`, `incoming/3`, `attr/3`; drift-guarded by a test).
    ///
    /// Reverse runs per the §6.3 normative matrix:
    /// - `edge` (Adjacency, key `(0,1)`) declares reverse `(1,0)` — the incoming run.
    /// - `incoming` IS `edge`'s reverse run per §6.3: since P3 its DISPATCH resolves
    ///   to `(edge, Reverse)` ([`Self::base_dispatch`]); its own Adjacency decl keyed
    ///   `(1,0)` is kept for the P2 facts layer (own-name fid identity) until P6's
    ///   physical rebuild de-aliases it.
    /// - `node`/`type` (Attribute over the node-type column) and `attr` declare the
    ///   `(1,0)` reverse — §6.3 gives `node_type` a reverse run (today's `by_type` L1
    ///   index) and the attr families (`file`/`name`) likewise; `type`'s dispatch
    ///   resolves to `node` (the registry alias, dissolved at plan time since P3).
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
        // Registration order = the historical planner base-relation order (ids are
        // dense and insertion-ordered; NOT load-bearing — §9.2 forbids hashing
        // interned ids).
        let node = cat.declare(attribute("node", 2)).expect("fresh catalog");
        cat.declare(attribute("type", 2)).expect("fresh catalog");
        let edge = cat
            .declare(adjacency("edge", 3, &[0, 1], &[1, 0]))
            .expect("fresh catalog");
        cat.declare(adjacency("incoming", 3, &[1, 0], &[0, 1]))
            .expect("fresh catalog");
        let attr = cat.declare(attribute("attr", 3)).expect("fresh catalog");
        // P3 dispatch resolution (§3.4 normative 1 / §6.3): the SURFACE names map to
        // (owning id, run). `incoming` folds into edge's Reverse run and `type` into
        // node — at the DISPATCH level only. The alias DECLS above are kept for the
        // P2 facts layer (each still a legal own-name predicate with its own fid
        // identity; Q4 explicitly permits the alias-decl form — the physical
        // de-aliasing is P6's rebuild).
        for (name, id, order) in [
            ("node", node, SortOrder::Forward),
            ("type", node, SortOrder::Forward),
            ("edge", edge, SortOrder::Forward),
            ("incoming", edge, SortOrder::Reverse),
            ("attr", attr, SortOrder::Forward),
        ] {
            let owner = &cat.decls[id.0 as usize];
            let dispatch = BaseDispatch {
                id,
                order,
                strategy: owner.strategy,
                arity: owner.arity,
            };
            cat.base_names.insert(name.to_string(), dispatch);
        }
        cat
    }

    /// P3: resolve a base-relation SURFACE name to its storage dispatch key, or
    /// `None` when the name is not storage-served (a rule head, an open-space
    /// default, a builtin — the planner classifies those elsewhere).
    pub fn base_dispatch(&self, name: &str) -> Option<BaseDispatch> {
        self.base_names.get(name).copied()
    }

    /// P4 (rofl-fact-model.md §2.4 / §3.1, ledger round-010-pre D13): the
    /// canonical declaration of the reserved `supersedes/2` predicate —
    /// `Adjacency` over `(aid_new, aid_old)` with the reverse run on `c1`, so
    /// the §2.4 liveness anti-join is a prefix probe by the superseded aid, not
    /// a scan. Declared by the FACTS backend at construction (the store that
    /// owns supersedes facts) — deliberately NOT part of
    /// [`Self::with_base_relations`]: the base id-space and `base_names`
    /// dispatch are pinned by the P3 plan goldens, and the derive executor has
    /// no supersedes storage service until the fixpoint engine moves onto the
    /// FactStore seam (P6/P7).
    pub fn supersedes_decl() -> PredicateDecl {
        PredicateDecl {
            id: CatalogPredicateId(0), // assigned by declare()
            name: "supersedes".to_string(),
            arity: 2,
            strategy: PhysStrategy::Adjacency,
            cardinality: Cardinality::MultiValued,
            temporal: TemporalScope::Timeless,
            semiring: crate::storage_v2::types::BOOLTAG_SEMIRING_ID,
            key_cols: Box::new([0, 1]),
            reverse: Some(Box::new([1, 0])),
            author_priority: Box::new([]),
            stats: PredicateStats::default(),
        }
    }

    /// P3: the plan-time [`PredicateStats`] population (round-009 H5 / open
    /// question Q1): map the run's live relation magnitudes into the base decls'
    /// `live_facts`/`live_asserts`. `node`/`type` and `attr` carry the live node
    /// count (an attr row is a node column — the node count is the magnitude the
    /// pre-P3 estimator used and the sound plan-time proxy until P6's compaction
    /// stats count true attr rows); `edge`/`incoming` carry the live edge count.
    /// `distinct`/`max_fanout` stay 0 and `updated_at_tx` stays 0 — the documented
    /// "compaction stats never computed" state (P6 owns them); the estimator gates
    /// its distinct-branch on `distinct[i] > 0`, which is what makes the P3 plans
    /// provably identical to pre-P3.
    pub fn populate_base_live_stats(&mut self, total_nodes: u64, total_edges: u64) {
        for decl in &mut self.decls {
            let live = match decl.strategy {
                PhysStrategy::Adjacency => total_edges,
                PhysStrategy::Attribute => total_nodes,
                // Open-space / rule-head decls carry no storage-backed live count
                // until P4 wires FactStore::stats() through here.
                _ => continue,
            };
            decl.stats.live_facts = live;
            decl.stats.live_asserts = live;
        }
    }

    /// P3 strict registration (`E-CAT-002`, ledger round-005 C3): register a
    /// program predicate name with the §3.1 default rule, REJECTING an arity
    /// conflict with an existing declaration instead of silently returning it.
    /// Used by the planner for BOTH rule heads (strict head validation — including
    /// a head shadowing a base-relation name at a different arity, `edge/1` over
    /// base `edge/3`: the round-009 conscious flip of the P1 shadowing pin) and
    /// for the §3.1 open-space registration of body-only predicates (a name used
    /// at two arities in one program was a silently-empty join pre-P3). A name
    /// matching the existing decl's arity returns the existing id unmutated (a
    /// same-arity base shadow still plans; the stratum check wins downstream).
    pub fn declare_strict(
        &mut self,
        name: &str,
        arity: u8,
    ) -> Result<CatalogPredicateId, CatalogError> {
        if let Some(&id) = self.ids.get(name) {
            let existing = &self.decls[id.0 as usize];
            if existing.arity != arity {
                return Err(CatalogError {
                    code: "E-CAT-002",
                    detail: format!(
                        "predicate '{name}/{arity}' conflicts with the declared '{name}/{}'",
                        existing.arity
                    ),
                });
            }
            return Ok(id);
        }
        Ok(self.declare_default(name, arity))
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

    /// P3 rewrite of the P1 drift guards (round-009 H7: they retired WITH the
    /// `plan.rs::BASE_RELATIONS` const they guarded — the catalog is now the single
    /// owner of the base name set). Each base SURFACE name's decl arity is still
    /// mechanically locked to the executor's builtin registry.
    #[test]
    fn base_relations_registered_with_executor_arities() {
        let cat = PredicateCatalog::with_base_relations();
        let registry = crate::derive::builtin::registry();
        let base_names = ["node", "type", "edge", "incoming", "attr"];
        assert_eq!(cat.len(), base_names.len());
        for name in base_names {
            let executor_arity = registry
                .iter()
                .find(|b| b.name == name)
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
        // edge is Adjacency keyed (0,1) with reverse (1,0); incoming keeps its P2
        // alias DECL keyed (1,0) for the facts layer while its DISPATCH resolves to
        // edge's Reverse run (guarded below).
        let edge = cat.get("edge").unwrap();
        assert_eq!(edge.strategy, PhysStrategy::Adjacency);
        assert_eq!(&edge.key_cols[..], &[0, 1]);
        assert_eq!(edge.reverse.as_deref(), Some(&[1u8, 0][..]));
        let incoming = cat.get("incoming").unwrap();
        assert_eq!(incoming.strategy, PhysStrategy::Adjacency);
        assert_eq!(&incoming.key_cols[..], &[1, 0]);
    }

    /// P3 §6.3 dispatch fold: `incoming` resolves to EDGE's id + Reverse, `type`
    /// to NODE's id + Forward; the three physical names resolve to themselves
    /// Forward; non-base names (heads, open-space defaults) never resolve.
    #[test]
    fn base_dispatch_folds_incoming_and_type_aliases() {
        let mut cat = PredicateCatalog::with_base_relations();
        let node = cat.get("node").unwrap().id;
        let edge = cat.get("edge").unwrap().id;
        let attr = cat.get("attr").unwrap().id;
        for (name, id, order, strategy, arity) in [
            ("node", node, SortOrder::Forward, PhysStrategy::Attribute, 2),
            ("type", node, SortOrder::Forward, PhysStrategy::Attribute, 2),
            ("edge", edge, SortOrder::Forward, PhysStrategy::Adjacency, 3),
            ("incoming", edge, SortOrder::Reverse, PhysStrategy::Adjacency, 3),
            ("attr", attr, SortOrder::Forward, PhysStrategy::Attribute, 3),
        ] {
            assert_eq!(
                cat.base_dispatch(name),
                Some(BaseDispatch { id, order, strategy, arity }),
                "{name} dispatch"
            );
        }
        // Rule heads and open-space defaults are NOT storage-served.
        cat.declare_default("reaches", 2);
        assert_eq!(cat.base_dispatch("reaches"), None);
        assert_eq!(cat.base_dispatch("gt"), None, "builtins are not base-dispatched");
    }

    /// P3 strict registration: same-arity get-or-declare; conflicting arity is
    /// `E-CAT-002` — including a base-relation shadow at a different arity (the
    /// round-009 conscious flip of the P1 shadowing acceptance).
    #[test]
    fn declare_strict_rejects_arity_conflict_with_e_cat_002() {
        let mut cat = PredicateCatalog::with_base_relations();
        let a = cat.declare_strict("reaches", 2).expect("fresh declare");
        let b = cat.declare_strict("reaches", 2).expect("same arity is idempotent");
        assert_eq!(a, b);
        let err = cat.declare_strict("reaches", 3).unwrap_err();
        assert_eq!(err.code, "E-CAT-002");
        // Base shadowing: same arity returns the base decl unmutated…
        let edge_id = cat.declare_strict("edge", 3).expect("same-arity base shadow");
        assert_eq!(edge_id, cat.get("edge").unwrap().id);
        assert_eq!(cat.get("edge").unwrap().strategy, PhysStrategy::Adjacency);
        // …a conflicting arity is E-CAT-002 (was silently accepted in P1).
        assert_eq!(cat.declare_strict("edge", 1).unwrap_err().code, "E-CAT-002");
    }

    /// P3 plan-time stats population (round-009 H5): Adjacency decls carry the
    /// live edge count, Attribute decls the live node count; distinct/max_fanout
    /// and updated_at_tx stay 0 (compaction stats are P6's by name); open-space
    /// decls stay zeroed.
    #[test]
    fn populate_base_live_stats_maps_the_oracle_magnitudes() {
        let mut cat = PredicateCatalog::with_base_relations();
        cat.declare_default("reaches", 2);
        cat.populate_base_live_stats(413, 1200);
        for (name, live) in [
            ("node", 413),
            ("type", 413),
            ("attr", 413),
            ("edge", 1200),
            ("incoming", 1200),
        ] {
            let s = &cat.get(name).unwrap().stats;
            assert_eq!(s.live_facts, live, "{name} live_facts");
            assert_eq!(s.live_asserts, live, "{name} live_asserts");
            assert!(s.distinct.is_empty(), "{name} distinct stays uncomputed");
            assert_eq!(s.max_fanout, 0, "{name} max_fanout stays uncomputed");
            assert_eq!(s.updated_at_tx, 0, "{name} 0 = compaction never computed");
        }
        assert_eq!(cat.get("reaches").unwrap().stats, PredicateStats::default());
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
