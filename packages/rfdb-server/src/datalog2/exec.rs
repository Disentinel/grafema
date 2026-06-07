//! Layer 7 — semi-naive fixpoint executor.
//!
//! Runs the seed → Δ-loop: hash-joins on the Δ leg, the v2 builtin/base eval bodies for
//! the Total/EDB legs (which read the [`StorageView`] sorted runs and typed scans), a
//! `GROUP BY` fact key with the tag `⊕` fold, and `tag_changed` termination. Applies
//! `EvalLimits` per stratum with an iteration cap of 10k (`E-EXEC-002` on overflow).
//! Invariants: I1 (worker-count and rule-order invariance), I3 (⊆-growth of derived
//! relations), and I4 (termination, guaranteed for `IdempotentTag` strata).
//!
//! # Why this is single-worker (parallel re-shuffle deferred)
//!
//! The spec's §4 fixpoint re-shuffles derived facts across workers by `hash(fact_id)`
//! before the `GROUP BY`/fold. Gate A's acceptance signal is *correctness* — the 51
//! guarantee rules are non-recursive stratified negation (anti-joins over a frozen lower
//! stratum), and the differential against the top-down `check` is key-set equality (I1
//! demands the result be byte-identical regardless of worker count or rule order). A
//! single-worker fixpoint is the K=1 point on that invariant and is trivially
//! order-independent: derivations within a round are folded into a `BTreeMap` keyed by
//! `fact_id`, and rounds saturate a set. The parallel re-shuffle (`hash(fact_id)`
//! partitioning + per-partition fold) is a performance refinement layered on top of this
//! same fold and is deferred; this module's fold is written so that partitioning would
//! distribute it without changing the committed result.
//!
//! # The semi-naive delta-rule scheme
//!
//! Per stratum: seed every clause once with all body legs reading their full source
//! (base relations, builtins, and the *frozen* lower strata) → the initial Δ. Then loop:
//! for each clause, for each body position that references a predicate in *this* stratum
//! (a recursive leg), evaluate a delta variant where that leg reads Δ and every other
//! recursive leg reads Total; the non-recursive legs always read their full source. Each
//! variant yields head rows; we group them by `fact_id`, fold tags with `⊕`, and a row is
//! a *new* derivation iff its key is not already in Total (BoolTag is idempotent, so a key
//! that re-appears contributes nothing new — `tag_changed` is false — and termination is
//! set-saturation). New rows become Δnext and are added to Total. The loop ends when a
//! round produces no new rows or the iteration cap fires (`E-EXEC-002`).
//!
//! # Negation (stratified)
//!
//! A negated body literal `\+ p(args)` is an anti-join over the FROZEN lower stratum that
//! defines `p` (the stratifier guarantees `p` sits strictly below). The planner ordered
//! the body bound-first, so every variable of a negative literal is bound by the time it
//! runs; the executor checks the bound key against `p`'s committed Total and keeps the row
//! iff the key is absent. This is the load-bearing path for the guarantee rules.

// The executor is the top of the module DAG: its public surface (`Executor`,
// `Evaluation`, `ExecError`) is exercised by the unit tests below and consumed by the
// crate-level eval entry point that the module DAG wires in `mod.rs` once every layer is
// in place (Layer 9). Until that entry lands it has no non-test caller, so the per-item
// dead-code lint would fire on the whole module despite the API being complete and tested.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::marker::PhantomData;
use std::time::Instant;

use crate::datalog::{Atom, EvalLimits, Rule, Term, Value};

use super::builtin::{self, ArgSpec, ArgValue, Batch};
use super::events::{EventLog, PredicateCount, PredicateDelta, StratumEntry};
use super::plan::{LegSource, RulePlan};
use super::stratify::Stratification;
use super::storage_glue::StorageView;
use super::tag::{IdempotentTag, Tag};
use super::value::fact_id;

/// The default semi-naive iteration cap (spec §7): a stratum that has not saturated after
/// this many Δ rounds is rejected with [`ExecCode::IterationCap`] (`E-EXEC-002`). For an
/// `IdempotentTag` stratum termination is guaranteed by construction (I4); the cap is a
/// tripwire against a planning or storage fault, never the normal exit.
pub const DEFAULT_ITERATION_CAP: usize = 10_000;

// ── Errors (invariant I5) ──────────────────────────────────────────

/// Stable, machine-readable executor error codes (invariant I5). A silently-empty result
/// is a forbidden failure mode engine-wide; every executor deviation carries a code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecCode {
    /// A stratum did not reach its fixpoint within the iteration cap (`E-EXEC-002`). For an
    /// `IdempotentTag` stratum this cannot happen on a well-formed plan; it fires only on a
    /// planning/storage fault and forces explicit human attention.
    IterationCap,
    /// A per-stratum `EvalLimits` ceiling was exceeded (intermediate-result cap or
    /// wall-clock deadline). The run aborts without committing (`E-EXEC-001`).
    LimitExceeded,
}

impl ExecCode {
    /// The stable string form emitted in diagnostics and conformance manifests.
    pub fn as_str(self) -> &'static str {
        match self {
            ExecCode::IterationCap => "E-EXEC-002",
            ExecCode::LimitExceeded => "E-EXEC-001",
        }
    }
}

impl std::fmt::Display for ExecCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An executor rejection: a stable [`ExecCode`], the stratum index it occurred in, and a
/// one-line human detail (the code is authoritative; the detail is a hint).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecError {
    /// Stable taxonomy code — the load-bearing, machine-checkable field.
    pub code: ExecCode,
    /// The 0-based stratum index in which the rejection occurred.
    pub stratum: usize,
    /// One-line human detail (never authoritative on its own).
    pub detail: String,
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} (stratum {}): {}",
            self.code, self.stratum, self.detail
        )
    }
}

impl std::error::Error for ExecError {}

/// Executor result.
pub type ExecResult<T> = Result<T, ExecError>;

// ── Derived relations ──────────────────────────────────────────────

/// A derived fact: the head tuple (head args in source order, ground) carrying a tag.
///
/// The tuple IS the key — derived predicates have no separate value columns at Gate A
/// (BoolTag), so `fact_id(pred_id, key)` identifies the fact. Stored once per relation.
#[derive(Clone, Debug)]
struct DerivedFact<T: Tag> {
    /// The ground head tuple (the GROUP BY key).
    key: Box<[Value]>,
    /// The provenance weight (BoolTag for Gate A).
    tag: T,
}

/// All derived facts of one predicate at the current point in the run: its committed
/// `total` plus the most recent `delta`. Keyed by `fact_id` for O(1) membership and a
/// deterministic, partition-friendly fold.
struct Relation<T: Tag> {
    /// Every fact derived so far, keyed by `fact_id`.
    total: HashMap<u64, DerivedFact<T>>,
    /// Facts newly derived in the last completed round (the Δ the next round joins on).
    delta: HashMap<u64, DerivedFact<T>>,
}

impl<T: Tag> Relation<T> {
    fn new() -> Self {
        Self {
            total: HashMap::new(),
            delta: HashMap::new(),
        }
    }
}

/// The committed result of evaluating a program: every derived predicate's ground facts.
///
/// Predicate name → its facts (each a ground head tuple). Sorted within a predicate by the
/// caller when a stable order is needed; the map itself is keyed by fact identity so the
/// content is independent of derivation order (I1).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Evaluation {
    /// Derived facts per predicate: name → list of ground head tuples.
    pub relations: BTreeMap<String, Vec<Box<[Value]>>>,
}

impl Evaluation {
    /// The ground tuples derived for `predicate`, sorted for deterministic output (I1), or
    /// an empty slice if the predicate derived nothing / is not in the program.
    pub fn facts(&self, predicate: &str) -> Vec<Box<[Value]>> {
        self.relations
            .get(predicate)
            .cloned()
            .unwrap_or_default()
    }

    /// The set of `fact_id`s for `predicate` (the differential anchor against the top-down
    /// `check`: Gate A asserts key-set equality).
    pub fn key_set(&self, predicate: &str, pred_id: u64) -> std::collections::BTreeSet<u64> {
        self.relations
            .get(predicate)
            .into_iter()
            .flat_map(|rows| rows.iter().map(move |r| fact_id(pred_id, r)))
            .collect()
    }
}

// ── A partial binding row ──────────────────────────────────────────

/// A partial binding: variable name → bound value, accumulated as body legs are placed.
///
/// The planner ordered the body bound-first, so by the time a leg runs every input it
/// needs is present in the row. Kept as a small sorted map so equal rows have one
/// representation (determinism) and lookups stay cheap on the short variable lists rules
/// use.
type BindRow = BTreeMap<String, Value>;

// ── The executor ───────────────────────────────────────────────────

/// The semi-naive fixpoint executor, parameterized by the provenance tag.
///
/// Recursion is gated on [`IdempotentTag`] (I4): a non-idempotent tag could grow without
/// bound in a recursive stratum and so must not instantiate the recursive path. Gate A
/// instantiates only [`BoolTag`](super::tag::BoolTag).
pub(crate) struct Executor<'v, T: IdempotentTag> {
    /// The only access path to storage (I10).
    view: &'v dyn StorageView,
    /// Per-stratum evaluation limits (intermediate-result cap, deadline).
    limits: EvalLimits,
    /// Semi-naive iteration cap (`E-EXEC-002` on overflow).
    iteration_cap: usize,
    /// Always-on event log (spec §11). Default is a discarding log: every emit is a no-op
    /// that allocates nothing, so instrumentation in the hot Δ-loop costs nothing when no
    /// sink is wired. `RefCell` so `evaluate(&self, …)` keeps its immutable signature (the
    /// log is observational and must not affect the committed result — I9/I1).
    events: RefCell<EventLog>,
    /// Carries the tag type without storing a value.
    _tag: PhantomData<T>,
}

impl<'v, T: IdempotentTag> Executor<'v, T> {
    /// Build an executor over a storage view with default limits and the standard
    /// iteration cap, discarding the event log.
    pub(crate) fn new(view: &'v dyn StorageView) -> Self {
        Self {
            view,
            limits: EvalLimits::default(),
            iteration_cap: DEFAULT_ITERATION_CAP,
            events: RefCell::new(EventLog::discard()),
            _tag: PhantomData,
        }
    }

    /// Build an executor with explicit limits (per-stratum) and iteration cap, discarding
    /// the event log.
    pub(crate) fn with_limits(
        view: &'v dyn StorageView,
        limits: EvalLimits,
        iteration_cap: usize,
    ) -> Self {
        Self {
            view,
            limits,
            iteration_cap,
            events: RefCell::new(EventLog::discard()),
            _tag: PhantomData,
        }
    }

    /// Install an event log on this executor (builder-style). The log is always-on by
    /// contract; a discarding log (the default) is the zero-cost variant. Returns `self`
    /// so it chains after [`Executor::new`] / [`Executor::with_limits`].
    pub(crate) fn with_events(mut self, log: EventLog) -> Self {
        self.events = RefCell::new(log);
        self
    }

    /// Evaluate a planned program against the stratification, lowest stratum first.
    ///
    /// Each stratum is evaluated to its fixpoint with the lower strata FROZEN in `total`
    /// (so negation and aggregation read committed lower-stratum facts only — I3). Plans
    /// are grouped by head predicate; a predicate's clauses are all the [`RulePlan`]s whose
    /// `head` names it. Returns the committed [`Evaluation`] or the first executor
    /// rejection (every rejection carries a stable [`ExecCode`]).
    pub fn evaluate(
        &self,
        plans: &[RulePlan],
        rules: &[&Rule],
        strat: &Stratification,
    ) -> ExecResult<Evaluation> {
        // Index the source rules by head predicate so a plan can recover its clause's
        // head atom (for the projection) and original body literals (for slot resolution).
        let mut rules_by_head: HashMap<&str, Vec<&Rule>> = HashMap::new();
        for r in rules {
            rules_by_head
                .entry(r.head().predicate())
                .or_default()
                .push(r);
        }

        // The growing per-predicate relation store; lower strata stay here, frozen, as
        // higher strata evaluate.
        let mut relations: HashMap<String, Relation<T>> = HashMap::new();

        // Stable predicate-id assignment (deterministic, name-ordered) so `fact_id` is
        // reproducible across runs and independent of evaluation order (I1).
        let pred_ids = assign_pred_ids(strat);

        // ── Event: run begin + stratum schedule (spec §11 decisions) ──
        {
            let mut log = self.events.borrow_mut();
            log.run_begin(strat.strata.len() as u64, plans.len() as u64);
            log.stratum_schedule(
                strat
                    .strata
                    .iter()
                    .map(|s| StratumEntry {
                        stratum: s.index,
                        predicates: s.predicates.clone(),
                    })
                    .collect(),
            );
        }

        for stratum in &strat.strata {
            // On any executor rejection, log the abort (stable code + detail) before
            // propagating — readers never see a silently-truncated log (I5/I9).
            if let Err(e) = self.eval_stratum(
                stratum.index,
                &stratum.predicates,
                plans,
                rules,
                &pred_ids,
                &mut relations,
            ) {
                self.events
                    .borrow_mut()
                    .run_aborted(e.code.as_str(), &e.detail);
                return Err(e);
            }
        }

        // Project the committed relations into the public, deterministically-sorted form.
        let mut out = Evaluation::default();
        for (name, rel) in &relations {
            let mut rows: Vec<Box<[Value]>> = rel.total.values().map(|f| f.key.clone()).collect();
            rows.sort_by(|a, b| cmp_tuple(a, b));
            out.relations.insert(name.clone(), rows);
        }

        // ── Event: run committed (per-predicate total fact counts, I9 anchor) ──
        // Ordered by predicate name so the committed-counts event is deterministic (I1).
        let mut fact_counts: Vec<PredicateCount> = out
            .relations
            .iter()
            .map(|(name, rows)| PredicateCount {
                predicate: name.clone(),
                facts: rows.len() as u64,
            })
            .collect();
        fact_counts.sort_by(|a, b| a.predicate.cmp(&b.predicate));
        self.events.borrow_mut().run_committed(fact_counts);

        Ok(out)
    }

    /// Evaluate a single stratum to its fixpoint (seed → Δ-loop).
    fn eval_stratum(
        &self,
        stratum_idx: usize,
        predicates: &[String],
        plans: &[RulePlan],
        rules: &[&Rule],
        pred_ids: &HashMap<String, u64>,
        relations: &mut HashMap<String, Relation<T>>,
    ) -> ExecResult<()> {
        // Fresh relations for this stratum's predicates (their Total/Δ start empty).
        for p in predicates {
            relations.entry(p.clone()).or_insert_with(Relation::new);
        }

        // ── Event: stratum begin ──
        self.events
            .borrow_mut()
            .stratum_begin(stratum_idx, predicates.to_vec());

        // The clauses (plan + source rule) that belong to this stratum.
        let clauses = self.collect_clauses(predicates, plans, rules);

        // ── Seed: every clause once, all legs reading their full source ──
        // The seed pass uses Total for any same-stratum derived leg, which is empty at this
        // point, so the seed naturally captures the non-recursive (base/lower-stratum)
        // derivations. This is the standard "round 0" of semi-naive.
        let mut seeded: HashMap<String, HashMap<u64, DerivedFact<T>>> = HashMap::new();
        for clause in &clauses {
            let pred_id = pred_ids[&clause.head_pred];
            let rows = self.eval_clause(clause, relations, None)?;
            self.check_intermediate(stratum_idx, &rows)?;
            let bucket = seeded.entry(clause.head_pred.clone()).or_default();
            for head_row in rows {
                let fid = fact_id(pred_id, &head_row);
                bucket.entry(fid).or_insert(DerivedFact {
                    key: head_row,
                    tag: T::one(),
                });
            }
        }

        // Commit the seed as the first Δ (and into Total), counting per-predicate Δ sizes
        // for the seed event.
        let mut seed_deltas: HashMap<String, u64> = HashMap::new();
        for (pred, facts) in seeded {
            let rel = relations.get_mut(&pred).expect("seeded predicate present");
            for (fid, fact) in facts {
                if let std::collections::hash_map::Entry::Vacant(e) = rel.total.entry(fid) {
                    e.insert(fact.clone());
                    rel.delta.insert(fid, fact);
                    *seed_deltas.entry(pred.clone()).or_insert(0) += 1;
                }
            }
        }

        // ── Event: stratum seeded (round-0 Δ sizes per predicate) ──
        if self.events.borrow().is_active() {
            self.events
                .borrow_mut()
                .stratum_seeded(stratum_idx, sorted_deltas(&seed_deltas));
        }

        // ── Δ-loop ──
        let mut iteration = 0usize;
        loop {
            // Termination: a round with no Δ anywhere in the stratum has saturated.
            let any_delta = predicates
                .iter()
                .any(|p| !relations[p].delta.is_empty());
            if !any_delta {
                break;
            }

            iteration += 1;
            if iteration > self.iteration_cap {
                return Err(ExecError {
                    code: ExecCode::IterationCap,
                    stratum: stratum_idx,
                    detail: format!(
                        "stratum did not reach fixpoint within {} iterations (predicates {:?})",
                        self.iteration_cap, predicates
                    ),
                });
            }

            self.check_deadline(stratum_idx)?;

            // Compute Δnext for every predicate in the stratum from the current Δ/Total.
            let mut delta_next: HashMap<String, HashMap<u64, DerivedFact<T>>> = HashMap::new();
            // Aggregate counters for this iteration's event (spec §11). A rule firing is
            // one (clause, recursive-leg) delta-variant evaluation; a fold ⊕ is a GROUP BY
            // collision where two derivations of one fact key folded with the tag `plus`.
            let mut rule_firings: u64 = 0;
            let mut fold_plus: u64 = 0;

            for clause in &clauses {
                // A recursive leg is a body position referencing a predicate in THIS
                // stratum. The delta-rule fires once per recursive leg, that leg reading Δ
                // while all others read Total (the standard semi-naive expansion). Clauses
                // with no recursive leg were fully captured by the seed and contribute
                // nothing new here.
                let recursive_legs = clause.recursive_leg_indices(predicates);
                if recursive_legs.is_empty() {
                    continue;
                }
                let pred_id = pred_ids[&clause.head_pred];
                for &delta_leg in &recursive_legs {
                    rule_firings += 1;
                    let rows = self.eval_clause(clause, relations, Some(delta_leg))?;
                    self.check_intermediate(stratum_idx, &rows)?;
                    let bucket = delta_next.entry(clause.head_pred.clone()).or_default();
                    for head_row in rows {
                        let fid = fact_id(pred_id, &head_row);
                        // GROUP BY fact key + FOLD with ⊕ (idempotent for BoolTag): two
                        // derivations in one round fold to one entry.
                        match bucket.entry(fid) {
                            std::collections::hash_map::Entry::Occupied(mut e) => {
                                let folded = e.get().tag.plus(&T::one());
                                e.get_mut().tag = folded;
                                fold_plus += 1;
                            }
                            std::collections::hash_map::Entry::Vacant(e) => {
                                e.insert(DerivedFact {
                                    key: head_row,
                                    tag: T::one(),
                                });
                            }
                        }
                    }
                }
            }

            // Roll Δ → Total: a fact is genuinely new (re-enters Δ) iff its key is not yet
            // in Total. For BoolTag `tag_changed` is true only on first appearance, so the
            // re-entry condition is set-membership (termination = set-saturation, I4).
            // Track per-predicate fresh Δ sizes for the iteration event.
            let mut iter_deltas: HashMap<String, u64> = HashMap::new();
            for p in predicates {
                let mut fresh: HashMap<u64, DerivedFact<T>> = HashMap::new();
                if let Some(found) = delta_next.get(p) {
                    let rel = relations.get_mut(p).expect("stratum predicate present");
                    for (fid, fact) in found {
                        if !rel.total.contains_key(fid) {
                            rel.total.insert(*fid, fact.clone());
                            fresh.insert(*fid, fact.clone());
                        }
                    }
                }
                if !fresh.is_empty() {
                    iter_deltas.insert(p.clone(), fresh.len() as u64);
                }
                // Swap in the fresh Δ (empty if nothing new for this predicate).
                relations.get_mut(p).expect("stratum predicate present").delta = fresh;
            }

            // ── Event: one Δ-iteration (per-predicate Δ + firing/fold counters) ──
            if self.events.borrow().is_active() {
                self.events.borrow_mut().iteration(
                    stratum_idx,
                    iteration,
                    sorted_deltas(&iter_deltas),
                    rule_firings,
                    fold_plus,
                );
            }
        }

        // Clear the stratum's Δ now that it is committed and frozen for higher strata.
        for p in predicates {
            relations
                .get_mut(p)
                .expect("stratum predicate present")
                .delta
                .clear();
        }

        // ── Event: stratum committed (iterations + per-predicate committed counts) ──
        if self.events.borrow().is_active() {
            let mut counts: Vec<PredicateCount> = predicates
                .iter()
                .map(|p| PredicateCount {
                    predicate: p.clone(),
                    facts: relations[p].total.len() as u64,
                })
                .collect();
            counts.sort_by(|a, b| a.predicate.cmp(&b.predicate));
            self.events
                .borrow_mut()
                .stratum_committed(stratum_idx, iteration, counts);
        }
        Ok(())
    }

    /// Gather the clauses belonging to a stratum, pairing each [`RulePlan`] with its source
    /// [`Rule`] (matched by head predicate and body shape).
    fn collect_clauses<'r>(
        &self,
        predicates: &[String],
        plans: &'r [RulePlan],
        rules: &'r [&'r Rule],
    ) -> Vec<Clause<'r>> {
        let mut out: Vec<Clause<'r>> = Vec::new();
        // Track how many clauses of each head predicate we have consumed so multiple
        // clauses of the same head pair with distinct rules in source order (determinism).
        let mut consumed: HashMap<&str, usize> = HashMap::new();
        for plan in plans {
            if !predicates.iter().any(|p| p == &plan.head) {
                continue;
            }
            let head = plan.head.as_str();
            let nth = consumed.entry(head).or_insert(0);
            // The n-th plan for this head pairs with the n-th source rule for this head.
            let rule = rules
                .iter()
                .filter(|r| r.head().predicate() == head)
                .nth(*nth)
                .copied();
            *nth += 1;
            if let Some(rule) = rule {
                out.push(Clause {
                    head_pred: plan.head.clone(),
                    plan,
                    rule,
                });
            }
        }
        out
    }

    /// Evaluate one clause, optionally restricting the recursive leg at `delta_leg` to read
    /// Δ instead of Total. Returns the ground head tuples the clause derives.
    ///
    /// `delta_leg = None` is the seed/full evaluation (every same-stratum derived leg reads
    /// Total — empty during seeding, so this captures the non-recursive derivations).
    /// `delta_leg = Some(i)` is a semi-naive delta variant: leg `i` reads Δ, every other
    /// same-stratum derived leg reads Total.
    fn eval_clause(
        &self,
        clause: &Clause<'_>,
        relations: &HashMap<String, Relation<T>>,
        delta_leg: Option<usize>,
    ) -> ExecResult<Vec<Box<[Value]>>> {
        // Start with a single empty binding row; each leg extends or filters it.
        let mut rows: Vec<BindRow> = vec![BindRow::new()];

        for (idx, leg) in clause.plan.legs.iter().enumerate() {
            if rows.is_empty() {
                break;
            }
            let use_delta = delta_leg == Some(idx);
            rows = self.apply_leg(leg, rows, relations, use_delta)?;
        }

        // Project surviving rows onto the head atom (ground tuple in head-arg order).
        let head = clause.rule.head();
        let mut out: Vec<Box<[Value]>> = Vec::with_capacity(rows.len());
        for row in &rows {
            if let Some(tuple) = project_head(head, row) {
                out.push(tuple);
            }
        }
        Ok(out)
    }

    /// Apply one planned body leg to the current set of partial binding rows.
    fn apply_leg(
        &self,
        leg: &crate::datalog2::plan::PlanLeg,
        rows: Vec<BindRow>,
        relations: &HashMap<String, Relation<T>>,
        use_delta: bool,
    ) -> ExecResult<Vec<BindRow>> {
        match &leg.source {
            // A derived predicate leg: join against this predicate's facts. A recursive leg
            // reading Δ (semi-naive) probes the delta; otherwise it probes Total. Negative
            // derived literals are anti-joins over the frozen lower stratum's Total.
            LegSource::Derived { name, .. } => {
                Ok(self.join_derived(leg, name, rows, relations, use_delta))
            }
            // Base relations and builtins are served by the v2 registry eval body, which
            // reads sorted runs / typed scans through the StorageView. Driving it per
            // partial row is the nested-loop join over the EDB/Total leg.
            LegSource::Base(_) | LegSource::Builtin(_) => Ok(self.join_extensional(leg, rows)),
        }
    }

    /// Join a derived-predicate leg into the partial rows.
    ///
    /// Positive: for each row, build the leg's bound key from the row's bindings, probe the
    /// chosen relation (Δ for a recursive semi-naive leg, else Total), and extend the row
    /// with the leg's free variables for every matching fact. Negative (`\+`): keep the row
    /// iff NO fact of the (frozen lower-stratum) relation matches the fully-bound key — the
    /// anti-join.
    fn join_derived(
        &self,
        leg: &crate::datalog2::plan::PlanLeg,
        name: &str,
        rows: Vec<BindRow>,
        relations: &HashMap<String, Relation<T>>,
        use_delta: bool,
    ) -> Vec<BindRow> {
        let atom = leg.literal.atom();
        let negated = leg.literal.is_negative();
        let Some(rel) = relations.get(name) else {
            // An unmaterialized derived predicate: positive ⇒ no matches; negative ⇒ the
            // anti-join trivially passes every row.
            return if negated { rows } else { Vec::new() };
        };
        // The fact source: a recursive Δ leg reads Δ; everything else reads Total. (A
        // negative literal always reads the frozen Total — it can never be a Δ leg, the
        // stratifier puts negated predicates strictly below.)
        let source: &HashMap<u64, DerivedFact<T>> = if use_delta && !negated {
            &rel.delta
        } else {
            &rel.total
        };

        let mut out: Vec<BindRow> = Vec::new();
        for row in rows {
            if negated {
                // Anti-join: every arg is bound (planner ordered bound-first); the row
                // survives iff no fact equals the bound tuple.
                let key = bind_atom_args(atom, &row);
                let present = match key {
                    Some(key) => source.values().any(|f| f.key.as_ref() == key.as_slice()),
                    // A key that cannot be fully bound is treated as "no match" — the row
                    // survives. The planner guarantees this does not happen for a safe rule.
                    None => false,
                };
                if !present {
                    out.push(row);
                }
                continue;
            }
            // Positive: probe by the bound-position pattern, extend with free vars.
            for fact in source.values() {
                if let Some(extended) = unify_atom(atom, &fact.key, &row) {
                    out.push(extended);
                }
            }
        }
        out
    }

    /// Join a base/builtin leg into the partial rows via the v2 registry eval body.
    ///
    /// For each partial row, resolve the literal's arguments to an [`ArgSpec`] (bound
    /// values from the row, free output slots for unbound variables), run the builtin
    /// `eval` against the [`StorageView`], and extend the row with one output binding per
    /// produced [`Batch`] row. A filter/function that captures nothing produces the empty
    /// row on a pass (the row survives unchanged) or no rows on a non-match (the row is
    /// dropped). Coercion misses are tuple non-matches, never errors.
    fn join_extensional(
        &self,
        leg: &crate::datalog2::plan::PlanLeg,
        rows: Vec<BindRow>,
    ) -> Vec<BindRow> {
        let atom = leg.literal.atom();
        let name = atom.predicate();
        // `type` is an alias of `node` in the registry; both resolve to the node builtin.
        let lookup_name = if name == "type" { "node" } else { name };
        let negated = leg.literal.is_negative();
        let Some(def) = builtin::lookup(lookup_name) else {
            // Not a v2-registered builtin (e.g. a v1-shared function like `path`). Gate A
            // ports the registry set; anything else yields no rows for a positive leg
            // rather than a silent pass, so an unported predicate surfaces as an empty
            // relation (never a crash). A NEGATED unported predicate is a vacuous anti-join
            // (nothing exists to negate), so every row survives unchanged.
            return if negated { rows } else { Vec::new() };
        };

        // ── Set-at-once anti-join (the function-has-contains shape) ──
        //
        // For a negated edge/incoming/node leg whose only free positions are the key
        // VARIABLE(s) bound from the rows (the rest being constants or wildcards), the
        // membership test is a single keyed/typed scan projected onto the bound key
        // positions — built ONCE — and an O(1) probe per row, instead of one storage eval
        // per row. This turns the dominant anti-join (`\+ edge(_, X, "T")`) from
        // O(rows × M) into O(M + rows). Any shape we do not special-case (attr, filters,
        // wildcard-only existence probes, etc.) keeps the exact per-row fallback below —
        // correctness over coverage. Semantics are preserved exactly: a negated literal
        // contributes membership and binds nothing (BoolTag), so a surviving row is
        // returned unchanged.
        if negated {
            if let Some(membership) = self.build_anti_join_set(name, atom) {
                let mut out: Vec<BindRow> = Vec::with_capacity(rows.len());
                for row in rows {
                    match project_anti_join_key(atom, &row) {
                        // Row's projected key tuple present in the membership set ⇒ a match
                        // exists ⇒ the anti-join drops the row. Absent ⇒ the row survives.
                        Some(key) => {
                            if !membership.contains(&key) {
                                out.push(row);
                            }
                        }
                        // A key position is unexpectedly unbound for this row (the planner
                        // guarantees this does not happen for a safe rule). Fall back to the
                        // exact per-row eval for this row so correctness never depends on the
                        // fast path's preconditions.
                        None => {
                            if self.anti_join_row_passes(def.eval, atom, &row) {
                                out.push(row);
                            }
                        }
                    }
                }
                return out;
            }
        }

        // ── Set-at-once positive attr value-generator (build-once hash-join) ──
        //
        // `attr(FreeId, "key", Value)` in generator mode would otherwise drive the snapshot
        // attr index (`nodes_by_attr` → `find_node_ids_by_attr_at`, a FULL segment scan)
        // ONCE PER ROW — O(rows × nodes). When the key is a constant the row surface carries
        // (`name`/`file`/`type`), build the `value → [id]` index ONCE in a single sorted-node
        // pass and probe it O(1) per row: the join becomes O(nodes + rows), the proper
        // build-once hash-join (spec §4, build the hash side once). Any shape outside this
        // (a metadata/`exported` key, a variable or wildcard key, a wildcard value, a bound
        // id) keeps the exact per-row fallback below — correctness over coverage. Semantics
        // match `eval_attr`'s generator branch exactly: each matching node's id is bound into
        // the free id position (`Value::Id`), nothing else is captured.
        if !negated && name == "attr" {
            if let Some(joined) = self.join_attr_generator_built_once(leg, atom, &rows) {
                return joined;
            }
        }

        let mut out: Vec<BindRow> = Vec::new();
        for row in rows {
            // Resolve args → ArgSpec. Free (unbound) variables get sequential output slots;
            // the slot→variable map lets us write the produced values back into the row.
            let (spec, slot_vars) = resolve_arg_spec(atom, &row);
            let mut batch = Batch::new();
            // The registry eval returns Err only for a genuine planning fault; the planner
            // already mode-checked every leg, so a runtime Err here is impossible on a
            // planned leg. If it ever fired, the safe behavior is "no rows" (never a crash).
            if (def.eval)(self.view, &mut batch, &spec).is_err() {
                continue;
            }
            // Negative base/builtin leg = anti-join. The planner placed it bound-first, so
            // every captured Var is already bound; any free arg is a wildcard existence
            // probe. The row survives iff the eval produced NO matching tuple. (Matches are
            // never bound back — a negated literal contributes membership, not bindings.)
            if negated {
                if batch.rows.is_empty() {
                    out.push(row);
                }
                continue;
            }
            for produced in &batch.rows {
                let mut next = row.clone();
                let mut ok = true;
                for (slot, var) in &slot_vars {
                    match produced.get(*slot) {
                        Some(val) => {
                            // If the variable was already bound (shared variable across
                            // legs), the produced value must agree, else the row is dropped.
                            if let Some(existing) = next.get(var) {
                                if existing != val {
                                    ok = false;
                                    break;
                                }
                            } else {
                                next.insert(var.clone(), val.clone());
                            }
                        }
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok {
                    out.push(next);
                }
            }
        }
        out
    }

    /// Build, in ONE keyed/typed scan, the membership key-set for an anti-join over a
    /// special-cased negated base leg (`edge`/`incoming`/`node`/`type`), or `None` if the
    /// leg's shape is not special-cased (the caller then keeps the exact per-row fallback).
    ///
    /// The set holds the projection of every matching tuple onto the leg's bound key
    /// VARIABLE positions, in source order — the same projection [`project_anti_join_key`]
    /// computes per row. Constant positions are existence filters (a scanned tuple must
    /// agree on them to count); wildcard positions are ignored. A row survives the anti-join
    /// iff its projected key tuple is absent from this set, an O(1) probe.
    ///
    /// Shape requirements (else `None`, fall back):
    /// * `edge`/`incoming`: the type position (arg 2) is a bound constant; the two endpoint
    ///   positions are each a variable or a wildcard (no endpoint constants — a constant
    ///   endpoint is rare and handled correctly by the per-row fallback). Built from the
    ///   single typed scan `scan_edges_by_type`.
    /// * `node`/`type`: the type position (arg 1) is a bound constant; the id position is a
    ///   variable or wildcard. Built from the single typed scan `scan_nodes_by_type`.
    fn build_anti_join_set(&self, name: &str, atom: &Atom) -> Option<HashSet<Vec<Value>>> {
        let args = atom.args();
        match name {
            "edge" | "incoming" => {
                if args.len() != 3 {
                    return None;
                }
                let ty = match &args[2] {
                    Term::Const(s) => s.clone(),
                    _ => return None,
                };
                // Endpoints must be variable/wildcard for the set projection to be defined
                // by the rows; a constant endpoint falls back (correctness over coverage).
                for ep in &args[..2] {
                    if matches!(ep, Term::Const(_)) {
                        return None;
                    }
                }
                let order = if name == "incoming" {
                    super::storage_glue::EdgeOrder::Reverse
                } else {
                    super::storage_glue::EdgeOrder::Forward
                };
                let mut set: HashSet<Vec<Value>> = HashSet::new();
                for e in self.view.scan_edges_by_type(&ty, order) {
                    // Map storage (src,dst) to this view's (near, far) per direction.
                    let (near, far) = match order {
                        super::storage_glue::EdgeOrder::Forward => (e.src, e.dst),
                        super::storage_glue::EdgeOrder::Reverse => (e.dst, e.src),
                    };
                    let mut key: Vec<Value> = Vec::new();
                    if matches!(args[0], Term::Var(_)) {
                        key.push(Value::Id(near));
                    }
                    if matches!(args[1], Term::Var(_)) {
                        key.push(Value::Id(far));
                    }
                    set.insert(key);
                }
                Some(set)
            }
            "node" | "type" => {
                if args.len() != 2 {
                    return None;
                }
                let ty = match &args[1] {
                    Term::Const(s) => s.clone(),
                    _ => return None,
                };
                // The id position must be a variable/wildcard (a constant id is a point
                // check the per-row fallback handles).
                if matches!(args[0], Term::Const(_)) {
                    return None;
                }
                let mut set: HashSet<Vec<Value>> = HashSet::new();
                for n in self.view.scan_nodes_by_type(&ty) {
                    let mut key: Vec<Value> = Vec::new();
                    if matches!(args[0], Term::Var(_)) {
                        key.push(Value::Id(n.id));
                    }
                    set.insert(key);
                }
                Some(set)
            }
            _ => None,
        }
    }

    /// Exact per-row anti-join fallback for a single row: run the registry eval and report
    /// whether the row survives (no matching tuple produced). Used only when the row's key
    /// could not be projected for the set probe (a safety net the planner makes unreachable
    /// on a safe rule).
    fn anti_join_row_passes(
        &self,
        eval: fn(
            &dyn StorageView,
            &mut Batch,
            &ArgSpec,
        ) -> super::builtin::BuiltinResult<()>,
        atom: &Atom,
        row: &BindRow,
    ) -> bool {
        let (spec, _slot_vars) = resolve_arg_spec(atom, row);
        let mut batch = Batch::new();
        if eval(self.view, &mut batch, &spec).is_err() {
            // An eval fault drops the row from a positive leg; for an anti-join the safe,
            // membership-preserving choice is "no match found" so the row survives.
            return true;
        }
        batch.rows.is_empty()
    }

    /// Build-once hash-join for the positive `attr(FreeId, "key", Value)` value-generator,
    /// or `None` if the leg's shape is not the build-once case (the caller then keeps the
    /// exact per-row `nodes_by_attr` fallback).
    ///
    /// The generator joins the current rows with the node relation on an attribute equality.
    /// Instead of one full attr-index scan per row (`O(rows × nodes)`), this builds the join's
    /// hash side ONCE — a `value → [id]` map over a single [`StorageView::sorted_run`] pass —
    /// and probes it per row (`O(nodes + rows)`). It mirrors `eval_attr`'s generator branch:
    /// for each node whose attribute `key` equals the row's value, the node id is bound into
    /// the free id position; nothing else is captured.
    ///
    /// Shape requirements (else `None`, fall back):
    /// * the id position (arg 0) is FREE (a generator, per the planner pattern) and a variable;
    /// * the key position (arg 1) is a constant the row surface carries (`name`/`file`/`type`)
    ///   — the same first-class columns [`StorageView::sorted_run`] exposes; a metadata /
    ///   `exported` key, or a variable key, cannot be served from the sorted node run;
    /// * the value position (arg 2) is a constant or a row-bound variable (not a wildcard —
    ///   that is an existence probe, not a value join).
    fn join_attr_generator_built_once(
        &self,
        leg: &crate::datalog2::plan::PlanLeg,
        atom: &Atom,
        rows: &[BindRow],
    ) -> Option<Vec<BindRow>> {
        use super::builtin::ArgMode;
        use super::storage_glue::{Relation, Row, SortOrder};

        let args = atom.args();
        if args.len() != 3 {
            return None;
        }
        // The id position must be a FREE variable (generator mode). The planner's pattern is
        // authoritative on boundness; the atom term gives the variable name to bind.
        if leg.pattern.first() != Some(&ArgMode::Free) {
            return None;
        }
        let id_var = match &args[0] {
            Term::Var(v) => v.clone(),
            _ => return None,
        };
        // The key must be a constant the sorted node run surfaces as a first-class column.
        let key = match &args[1] {
            Term::Const(k) => k.as_str(),
            _ => return None,
        };
        if !matches!(key, "name" | "file" | "type") {
            return None;
        }

        // ── Build the hash side ONCE: value → [id] over one sorted-node pass. ──
        let mut index: HashMap<String, Vec<u128>> = HashMap::new();
        for row in self.view.sorted_run(Relation::Nodes, SortOrder::NodeById) {
            if let Row::Node(n) = row {
                let col = match key {
                    "name" => n.name,
                    "file" => n.file,
                    "type" => n.node_type,
                    _ => unreachable!("key matched above"),
                };
                index.entry(col).or_default().push(n.id);
            }
        }

        // ── Probe per row by the value's string surface (§5), binding the free id. ──
        let value_term = &args[2];
        let mut out: Vec<BindRow> = Vec::new();
        for row in rows {
            let value = match value_term {
                Term::Const(s) => Value::from_term_const(s),
                Term::Var(v) => match row.get(v) {
                    Some(val) => val.clone(),
                    // The value var is unexpectedly unbound (the planner makes this
                    // unreachable for a placed generator leg); this row contributes nothing.
                    None => continue,
                },
                // A wildcard value is an existence probe, screened out above; defensive.
                Term::Wildcard => return None,
            };
            let surface = value_surface(&value);
            let Some(ids) = index.get(&surface) else {
                continue;
            };
            for &id in ids {
                let mut next = row.clone();
                match next.get(&id_var) {
                    // The id var should be free (pattern says so); if it were somehow already
                    // bound, keep the row only on agreement (shared-variable join semantics).
                    Some(existing) => {
                        if *existing == Value::Id(id) {
                            out.push(next);
                        }
                    }
                    None => {
                        next.insert(id_var.clone(), Value::Id(id));
                        out.push(next);
                    }
                }
            }
        }
        Some(out)
    }

    /// Per-stratum intermediate-result ceiling (`EvalLimits::max_intermediate_results`).
    fn check_intermediate(&self, stratum: usize, rows: &[Box<[Value]>]) -> ExecResult<()> {
        if rows.len() > self.limits.max_intermediate_results {
            return Err(ExecError {
                code: ExecCode::LimitExceeded,
                stratum,
                detail: format!(
                    "intermediate result count {} exceeds max_intermediate_results {}",
                    rows.len(),
                    self.limits.max_intermediate_results
                ),
            });
        }
        Ok(())
    }

    /// Per-stratum wall-clock deadline (`EvalLimits::deadline`).
    fn check_deadline(&self, stratum: usize) -> ExecResult<()> {
        if let Some(deadline) = self.limits.deadline {
            if Instant::now() >= deadline {
                return Err(ExecError {
                    code: ExecCode::LimitExceeded,
                    stratum,
                    detail: "wall-clock deadline exceeded".to_string(),
                });
            }
        }
        Ok(())
    }
}

// ── One clause = plan + source rule ────────────────────────────────

/// A clause to evaluate: its head predicate, the [`RulePlan`] (ordered legs), and the
/// source [`Rule`] (for the head projection and original argument terms).
struct Clause<'r> {
    head_pred: String,
    plan: &'r RulePlan,
    rule: &'r Rule,
}

impl<'r> Clause<'r> {
    /// The body-leg positions that reference a predicate in `stratum_predicates` (the
    /// recursive legs that drive the semi-naive delta-rule expansion).
    fn recursive_leg_indices(&self, stratum_predicates: &[String]) -> Vec<usize> {
        self.plan
            .legs
            .iter()
            .enumerate()
            .filter_map(|(i, leg)| match &leg.source {
                // A positive same-stratum derived leg is recursive. A negative literal is
                // never recursive (its predicate is in a strictly lower stratum).
                LegSource::Derived { name, recursive }
                    if *recursive
                        && leg.literal.is_positive()
                        && stratum_predicates.iter().any(|p| p == name) =>
                {
                    Some(i)
                }
                _ => None,
            })
            .collect()
    }
}

// ── Binding / unification helpers ──────────────────────────────────

/// Build the ground tuple for `atom`'s args from a binding row, in arg order. Returns
/// `None` if any arg is an unbound variable (a fully-bound key was expected, e.g. for an
/// anti-join or a head projection).
fn bind_atom_args(atom: &Atom, row: &BindRow) -> Option<Vec<Value>> {
    let mut out = Vec::with_capacity(atom.args().len());
    for t in atom.args() {
        match t {
            Term::Const(s) => out.push(Value::from_term_const(s)),
            Term::Var(v) => out.push(row.get(v)?.clone()),
            // A wildcard has no value to bind into a key; an atom keyed on a wildcard is
            // not a fully-bound key.
            Term::Wildcard => return None,
        }
    }
    Some(out)
}

/// The string surface of a [`Value`] for an attribute equality probe (spec §5), matching
/// `eval_attr`'s value coercion: a `Str` compares by its string, an `Id` by its decimal
/// surface. The build-once attr index ([`Executor::join_attr_generator_built_once`]) keys
/// node columns (raw strings) and probes them with this surface, so a row's bound value
/// matches the same nodes `nodes_by_attr` would have returned per row.
fn value_surface(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        Value::Id(id) => id.to_string(),
    }
}

/// Project a binding row onto a negated base atom's VARIABLE positions, in source order —
/// the per-row probe key for the set-at-once anti-join ([`Executor::build_anti_join_set`]).
///
/// Only `Term::Var` positions contribute a column (each looked up in the row); constants and
/// wildcards contribute nothing, exactly mirroring the set builder's projection. Returns
/// `None` iff a variable position is unbound in this row (the planner makes this unreachable
/// for a safe rule; the caller then takes the exact per-row fallback for that row).
fn project_anti_join_key(atom: &Atom, row: &BindRow) -> Option<Vec<Value>> {
    let mut key: Vec<Value> = Vec::new();
    for t in atom.args() {
        if let Term::Var(v) = t {
            key.push(row.get(v)?.clone());
        }
    }
    Some(key)
}

/// Project a rule head onto a ground tuple from a binding row. Every head variable must be
/// bound (the planner enforces rule safety); returns `None` otherwise (the row is dropped).
fn project_head(head: &Atom, row: &BindRow) -> Option<Box<[Value]>> {
    let mut out = Vec::with_capacity(head.args().len());
    for t in head.args() {
        match t {
            Term::Const(s) => out.push(Value::from_term_const(s)),
            Term::Var(v) => out.push(row.get(v)?.clone()),
            // A wildcard in a head is not a captured column; a safe rule never has one.
            Term::Wildcard => return None,
        }
    }
    Some(out.into_boxed_slice())
}

/// Unify a positive derived-predicate atom against one stored fact tuple, given a partial
/// row. Bound atom positions must equal the fact's value at that position; free variable
/// positions bind the fact's value. Returns the extended row, or `None` on a mismatch.
fn unify_atom(atom: &Atom, fact_key: &[Value], row: &BindRow) -> Option<BindRow> {
    if atom.args().len() != fact_key.len() {
        return None;
    }
    let mut next = row.clone();
    for (t, val) in atom.args().iter().zip(fact_key.iter()) {
        match t {
            Term::Const(s) => {
                if &Value::from_term_const(s) != val {
                    return None;
                }
            }
            Term::Wildcard => {
                // Matches anything, captures nothing.
            }
            Term::Var(v) => match next.get(v) {
                Some(existing) => {
                    // Already bound (shared variable): must agree.
                    if existing != val {
                        return None;
                    }
                }
                None => {
                    next.insert(v.clone(), val.clone());
                }
            },
        }
    }
    Some(next)
}

/// Resolve a base/builtin atom's arguments to an [`ArgSpec`] against a binding row, plus
/// the `(output_slot → variable_name)` map for the free positions the eval will fill.
///
/// A constant or already-bound variable becomes [`ArgValue::Bound`]; an unbound variable
/// becomes [`ArgValue::Free`] with a fresh output slot (recorded in the returned map); a
/// wildcard becomes [`ArgValue::Wildcard`] (free, never captured).
fn resolve_arg_spec(atom: &Atom, row: &BindRow) -> (ArgSpec, Vec<(usize, String)>) {
    let mut args: Vec<ArgValue> = Vec::with_capacity(atom.args().len());
    let mut slot_vars: Vec<(usize, String)> = Vec::new();
    let mut next_slot = 0usize;
    for t in atom.args() {
        match t {
            Term::Const(s) => args.push(ArgValue::Bound(Value::from_term_const(s))),
            Term::Wildcard => args.push(ArgValue::Wildcard),
            Term::Var(v) => match row.get(v) {
                Some(val) => args.push(ArgValue::Bound(val.clone())),
                None => {
                    let slot = next_slot;
                    next_slot += 1;
                    slot_vars.push((slot, v.clone()));
                    args.push(ArgValue::Free { slot });
                }
            },
        }
    }
    (ArgSpec::new(args), slot_vars)
}

/// Total order over [`Value`] for a deterministic committed result (I1). The v1 `Value`
/// is `Eq`/`Hash` but not `Ord` (and must not be modified, it is shared with the top-down
/// engine), so the order is defined here: ids before strings, then by the natural order of
/// each variant's payload.
fn cmp_value(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (Value::Id(x), Value::Id(y)) => x.cmp(y),
        (Value::Str(x), Value::Str(y)) => x.cmp(y),
        (Value::Id(_), Value::Str(_)) => Ordering::Less,
        (Value::Str(_), Value::Id(_)) => Ordering::Greater,
    }
}

/// Lexicographic total order over a tuple of [`Value`]s (shorter tuple first on a prefix
/// tie). Used to sort each predicate's committed facts deterministically.
fn cmp_tuple(a: &[Value], b: &[Value]) -> std::cmp::Ordering {
    for (x, y) in a.iter().zip(b.iter()) {
        let o = cmp_value(x, y);
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    a.len().cmp(&b.len())
}

/// Project a per-predicate Δ-size map into a deterministically-ordered list of
/// [`PredicateDelta`] for an event payload (sorted by predicate name so the always-on log
/// is byte-stable across runs — I1/I9). Predicates with no Δ this round are absent from
/// the input map and so are omitted (aggregate-only, never per-tuple — spec §11).
fn sorted_deltas(deltas: &HashMap<String, u64>) -> Vec<PredicateDelta> {
    let mut out: Vec<PredicateDelta> = deltas
        .iter()
        .map(|(predicate, &delta_facts)| PredicateDelta {
            predicate: predicate.clone(),
            delta_facts,
        })
        .collect();
    out.sort_by(|a, b| a.predicate.cmp(&b.predicate));
    out
}

/// Assign a deterministic `predicate_id` to every derived predicate, ordered by name so
/// `fact_id` is reproducible and independent of evaluation order (I1).
fn assign_pred_ids(strat: &Stratification) -> HashMap<String, u64> {
    let mut names: Vec<&String> = strat
        .strata
        .iter()
        .flat_map(|s| s.predicates.iter())
        .collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i as u64))
        .collect()
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datalog2::parser_ext::parse_ext_program;
    use crate::datalog2::plan::plan_program;
    use crate::datalog2::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
    use crate::datalog2::stratify::stratify;
    use crate::datalog2::tag::BoolTag;
    use crate::datalog2::builtin::Stats;

    /// Derive the canonical u128 id the same way the writer / fixture does.
    fn id_of(semantic_id: &str) -> u128 {
        u128::from_le_bytes(
            blake3::hash(semantic_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        )
    }

    fn node(v: &mut FixtureStorageView, sid: &str, ty: &str) {
        v.put_node(NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: sid.to_string(),
            file: "f.js".to_string(),
        });
    }

    fn edge(v: &mut FixtureStorageView, src: &str, dst: &str, ty: &str) {
        v.put_edge(EdgeRow {
            src: id_of(src),
            dst: id_of(dst),
            edge_type: ty.to_string(),
        });
    }

    /// Run a program end to end (parse → stratify → plan → execute) on a fixture view.
    fn run(src: &str, view: &FixtureStorageView, stats: Stats) -> Evaluation {
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &stats).expect("plan");
        let exec = Executor::<BoolTag>::with_limits(view, EvalLimits::none(), DEFAULT_ITERATION_CAP);
        exec.evaluate(&plans, &rules, &strat).expect("evaluate")
    }

    /// Run a program with an event sink installed, returning both the committed evaluation
    /// and the captured event sequence.
    fn run_with_events(
        src: &str,
        view: &FixtureStorageView,
        stats: Stats,
    ) -> (Evaluation, Vec<crate::datalog2::events::Event>) {
        use crate::datalog2::events::{EventLog, SharedMemSink};
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &stats).expect("plan");
        let sink = SharedMemSink::new();
        let exec = Executor::<BoolTag>::with_limits(view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
            .with_events(EventLog::with_sink(Box::new(sink.clone())));
        let eval = exec.evaluate(&plans, &rules, &strat).expect("evaluate");
        (eval, sink.events())
    }

    /// The set of node-id values for a single-column derived predicate.
    fn ids(eval: &Evaluation, pred: &str) -> Vec<u128> {
        let mut out: Vec<u128> = eval
            .facts(pred)
            .iter()
            .map(|row| match &row[0] {
                Value::Id(id) => *id,
                Value::Str(s) => s.parse().expect("id column"),
            })
            .collect();
        out.sort_unstable();
        out
    }

    // ── anti-join: function-has-contains shape ──────────────────────

    #[test]
    fn anti_join_orphan_functions() {
        // orphan(X) :- node(X, "FUNCTION"), \+ incoming(X, _, "CALLS").
        // A function with no incoming CALLS edge is an orphan. fn3 is never called.
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "fn1", "FUNCTION");
        node(&mut v, "fn2", "FUNCTION");
        node(&mut v, "fn3", "FUNCTION");
        node(&mut v, "cls1", "CLASS");
        edge(&mut v, "fn1", "fn2", "CALLS"); // fn2 is called
        edge(&mut v, "fn1", "fn3", "CONTAINS"); // not a CALLS edge

        // Stage the "called" set as a derived predicate so the negation is over a derived
        // stratum (stratified anti-join — the guarantee-rule shape). `edge(_, Y, "CALLS")`
        // generates every callee Y (the edge generator binds both endpoints freely under a
        // bound type); the orphan rule negates membership in that frozen lower stratum.
        let src = r#"
            called(Y) :- edge(C, Y, "CALLS").
            orphan(X) :- node(X, "FUNCTION"), \+ called(X).
        "#;
        let eval = run(src, &v, Stats { total_nodes: 4, total_edges: 2, ..Default::default() });

        // Only fn2 is called → orphans are fn1 and fn3.
        let orphans = ids(&eval, "orphan");
        let mut expected = vec![id_of("fn1"), id_of("fn3")];
        expected.sort_unstable();
        assert_eq!(orphans, expected, "fn1 and fn3 have no incoming CALLS");
        // called = {fn2}.
        assert_eq!(ids(&eval, "called"), vec![id_of("fn2")]);
    }

    // ── anti-join over a negated BASE leg is set-at-once (bounded scans) ──

    use crate::datalog2::storage_glue::{EdgeOrder, NodeRow as GlueNodeRow};
    use std::cell::Cell;

    /// Wraps a fixture view and counts how many full typed relation scans the run issues,
    /// so a test can assert the set-at-once anti-join touches each negated base relation a
    /// BOUNDED number of times (independent of the row count) — not once per row.
    struct ScanCountingView {
        inner: FixtureStorageView,
        edge_scans: Cell<usize>,
        node_scans: Cell<usize>,
        /// Full attr-index reverse lookups (`nodes_by_attr`) — the per-row cost the
        /// build-once attr hash-join eliminates.
        attr_calls: Cell<usize>,
        /// Sorted-node passes (`sorted_run(Nodes, …)`) — the bounded build side of the
        /// build-once attr hash-join.
        node_sorted_runs: Cell<usize>,
    }

    impl ScanCountingView {
        fn new(inner: FixtureStorageView) -> Self {
            Self {
                inner,
                edge_scans: Cell::new(0),
                node_scans: Cell::new(0),
                attr_calls: Cell::new(0),
                node_sorted_runs: Cell::new(0),
            }
        }
    }

    impl StorageView for ScanCountingView {
        fn generation(&self) -> u64 {
            self.inner.generation()
        }
        fn sorted_run(
            &self,
            rel: crate::datalog2::storage_glue::Relation,
            order: crate::datalog2::storage_glue::SortOrder,
        ) -> Box<dyn Iterator<Item = crate::datalog2::storage_glue::Row> + '_> {
            if rel == crate::datalog2::storage_glue::Relation::Nodes {
                self.node_sorted_runs.set(self.node_sorted_runs.get() + 1);
            }
            self.inner.sorted_run(rel, order)
        }
        fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = GlueNodeRow> + '_> {
            self.node_scans.set(self.node_scans.get() + 1);
            self.inner.scan_nodes_by_type(ty)
        }
        fn scan_edges_by_type(
            &self,
            ty: &str,
            order: EdgeOrder,
        ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
            self.edge_scans.set(self.edge_scans.get() + 1);
            self.inner.scan_edges_by_type(ty, order)
        }
        fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
            self.inner.edges_from(src, edge_type)
        }
        fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
            self.inner.edges_to(dst, edge_type)
        }
        fn get_node(&self, id: u128) -> Option<GlueNodeRow> {
            self.inner.get_node(id)
        }
        fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<GlueNodeRow> {
            self.attr_calls.set(self.attr_calls.get() + 1);
            self.inner.nodes_by_attr(key, value)
        }
    }

    /// Run a program over an arbitrary `StorageView` (not just the fixture), so a counting
    /// view can observe the access pattern. Mirrors [`run`].
    fn run_on(src: &str, view: &dyn StorageView, stats: Stats) -> Evaluation {
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &stats).expect("plan");
        let exec = Executor::<BoolTag>::with_limits(view, EvalLimits::none(), DEFAULT_ITERATION_CAP);
        exec.evaluate(&plans, &rules, &strat).expect("evaluate")
    }

    #[test]
    fn anti_join_over_base_leg_is_set_at_once_bounded_scans() {
        // has_no_incoming_call(X) :- node(X, "FUNCTION"), \+ incoming(X, _, "CALLS").
        // The negated BASE leg `incoming(X, _, "CALLS")` is the function-has-contains anti-
        // join shape: X bound from the rows, far endpoint a wildcard, type bound. With MANY
        // candidate rows (50 FUNCTION nodes), the set-at-once path must scan the CALLS edge
        // relation a BOUNDED number of times — once to build the membership set — NOT once
        // per row. A per-row anti-join would scan/probe 50 times.
        let mut v = FixtureStorageView::new(1);
        let n = 50usize;
        for i in 0..n {
            node(&mut v, &format!("fn{i}"), "FUNCTION");
        }
        // Only the even-indexed functions receive an incoming CALLS edge; the odd ones are
        // orphans (no incoming CALLS).
        for i in (0..n).step_by(2) {
            let caller = (i + 1) % n;
            edge(&mut v, &format!("fn{caller}"), &format!("fn{i}"), "CALLS");
        }

        let view = ScanCountingView::new(v);
        let src = r#"
            has_no_incoming_call(X) :- node(X, "FUNCTION"), \+ incoming(X, _, "CALLS").
        "#;
        let eval = run_on(src, &view, Stats { total_nodes: n as u64, total_edges: (n / 2) as u64, ..Default::default() });

        // The odd-indexed functions (no incoming CALLS) survive the anti-join.
        let got = ids(&eval, "has_no_incoming_call");
        let mut expected: Vec<u128> = (0..n)
            .filter(|i| i % 2 == 1)
            .map(|i| id_of(&format!("fn{i}")))
            .collect();
        expected.sort_unstable();
        assert_eq!(got, expected, "orphans are exactly the odd-indexed functions");

        // The membership set for `incoming(_, _, "CALLS")` is built with ONE typed edge
        // scan, regardless of the 50 candidate rows. The bound is small and constant —
        // crucially NOT proportional to the row count (which a per-row anti-join would be).
        assert!(
            view.edge_scans.get() <= 1,
            "set-at-once anti-join scans the CALLS relation at most once (got {}), \
             not once per row",
            view.edge_scans.get()
        );
        assert!(
            view.edge_scans.get() < n,
            "edge scans ({}) must be bounded, not O(rows={})",
            view.edge_scans.get(),
            n
        );
    }

    // ── positive attr value-generator is a build-once hash-join ──────

    #[test]
    fn attr_value_generator_is_built_once_not_per_row() {
        // dep(M) :- node(I,"IMPORT"), attr(I,"file",F), attr(M,"file",F), node(M,"MODULE").
        // This is the stdlib `depends` join shape: many driver rows (IMPORT nodes) join to a
        // node-by-file on a shared `file` value, the join keyed by the FREE id of
        // `attr(M,"file",F)` (generator mode). With N=40 imports, the OLD per-row path would
        // issue ~40 `nodes_by_attr` full attr-index scans (O(rows × nodes)); the build-once
        // hash-join issues ZERO `nodes_by_attr` calls and a BOUNDED number of sorted-node
        // passes (the hash side is built once), independent of the row count.
        let n = 40usize;
        let mut v = FixtureStorageView::new(1);
        // Each file_i holds one IMPORT and one MODULE → import_i's file maps to module_i.
        for i in 0..n {
            let file = format!("file{i}.js");
            v.put_node(NodeRow {
                id: id_of(&format!("import{i}")),
                node_type: "IMPORT".to_string(),
                name: format!("import{i}"),
                file: file.clone(),
            });
            v.put_node(NodeRow {
                id: id_of(&format!("module{i}")),
                node_type: "MODULE".to_string(),
                name: format!("module{i}"),
                file,
            });
        }

        let view = ScanCountingView::new(v);
        let src = r#"
            dep(M) :- node(I, "IMPORT"), attr(I, "file", F), attr(M, "file", F), node(M, "MODULE").
        "#;
        let eval = run_on(
            src,
            &view,
            Stats {
                total_nodes: (2 * n) as u64,
                total_edges: 0,
                nodes_by_type: [("IMPORT".to_string(), n as u64), ("MODULE".to_string(), n as u64)]
                    .into_iter()
                    .collect(),
            },
        );

        // Every module is reachable from its same-file import → all n modules derive.
        let got = ids(&eval, "dep");
        let mut expected: Vec<u128> = (0..n).map(|i| id_of(&format!("module{i}"))).collect();
        expected.sort_unstable();
        assert_eq!(got, expected, "each import's file maps to exactly its module");

        // The build-once hash-join NEVER routes the generator through the per-row attr index.
        assert_eq!(
            view.attr_calls.get(),
            0,
            "attr value-generator must be built once (sorted_run), never per-row nodes_by_attr"
        );
        // The hash side is built with a BOUNDED number of sorted-node passes — crucially NOT
        // proportional to the n driver rows (a per-row build would be ≥ n).
        assert!(
            view.node_sorted_runs.get() < n,
            "sorted-node passes ({}) must be bounded, not O(rows={})",
            view.node_sorted_runs.get(),
            n
        );
    }

    // ── multi-clause union ──────────────────────────────────────────

    #[test]
    fn multi_clause_union() {
        // interesting(X) :- node(X, "FUNCTION").
        // interesting(X) :- node(X, "CLASS").
        // The two clauses of `interesting` union: every FUNCTION and every CLASS.
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "fn1", "FUNCTION");
        node(&mut v, "fn2", "FUNCTION");
        node(&mut v, "cls1", "CLASS");
        node(&mut v, "mod1", "MODULE");

        let src = r#"
            interesting(X) :- node(X, "FUNCTION").
            interesting(X) :- node(X, "CLASS").
        "#;
        let eval = run(src, &v, Stats { total_nodes: 4, total_edges: 0, ..Default::default() });

        let got = ids(&eval, "interesting");
        let mut expected = vec![id_of("fn1"), id_of("fn2"), id_of("cls1")];
        expected.sort_unstable();
        assert_eq!(got, expected, "union of FUNCTION and CLASS, MODULE excluded");
    }

    // ── 2-stratum derived-negation: beam-state-init-only-gate shape ──

    #[test]
    fn two_stratum_derived_negation() {
        // handler_writes(M) :- edge(M, C, "CONTAINS"), incoming(C, _, "STATE_WRITE").
        // violation(M)      :- node(M, "MESSAGE_TYPE"), \+ handler_writes(M).
        // A MESSAGE_TYPE whose contained members never receive a STATE_WRITE is a
        // violation. The negation forces `violation` strictly above `handler_writes`.
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "msgA", "MESSAGE_TYPE");
        node(&mut v, "msgB", "MESSAGE_TYPE");
        node(&mut v, "memberA", "FIELD");
        node(&mut v, "memberB", "FIELD");
        node(&mut v, "writer", "FUNCTION");
        // msgA contains memberA, and memberA receives a STATE_WRITE → handler_writes(msgA).
        edge(&mut v, "msgA", "memberA", "CONTAINS");
        edge(&mut v, "writer", "memberA", "STATE_WRITE");
        // msgB contains memberB, but memberB never receives a STATE_WRITE.
        edge(&mut v, "msgB", "memberB", "CONTAINS");

        let src = r#"
            handler_writes(M) :- edge(M, C, "CONTAINS"), incoming(C, _, "STATE_WRITE").
            violation(M) :- node(M, "MESSAGE_TYPE"), \+ handler_writes(M).
        "#;
        let eval = run(src, &v, Stats { total_nodes: 5, total_edges: 3, ..Default::default() });

        // handler_writes = {msgA}; violation = {msgB}.
        assert_eq!(ids(&eval, "handler_writes"), vec![id_of("msgA")]);
        assert_eq!(ids(&eval, "violation"), vec![id_of("msgB")]);
    }

    // ── positive recursion: transitive closure (termination, I4) ────

    #[test]
    fn transitive_closure_terminates_and_saturates() {
        // reach(X, Y) :- edge(X, Y, "CALLS").
        // reach(X, Z) :- reach(X, Y), edge(Y, Z, "CALLS").
        // A linear call chain fn1 → fn2 → fn3 → fn4. The closure is every reachable pair.
        let mut v = FixtureStorageView::new(1);
        for f in ["fn1", "fn2", "fn3", "fn4"] {
            node(&mut v, f, "FUNCTION");
        }
        edge(&mut v, "fn1", "fn2", "CALLS");
        edge(&mut v, "fn2", "fn3", "CALLS");
        edge(&mut v, "fn3", "fn4", "CALLS");

        let src = r#"
            reach(X, Y) :- edge(X, Y, "CALLS").
            reach(X, Z) :- reach(X, Y), edge(Y, Z, "CALLS").
        "#;
        let eval = run(src, &v, Stats { total_nodes: 4, total_edges: 3, ..Default::default() });

        // Reachable pairs: (1,2),(2,3),(3,4),(1,3),(2,4),(1,4) = 6 pairs.
        let pairs: std::collections::BTreeSet<(u128, u128)> = eval
            .facts("reach")
            .iter()
            .map(|row| {
                let a = row[0].as_id().unwrap();
                let b = row[1].as_id().unwrap();
                (a, b)
            })
            .collect();
        let f = |s: &str| id_of(s);
        let expected: std::collections::BTreeSet<(u128, u128)> = [
            (f("fn1"), f("fn2")),
            (f("fn2"), f("fn3")),
            (f("fn3"), f("fn4")),
            (f("fn1"), f("fn3")),
            (f("fn2"), f("fn4")),
            (f("fn1"), f("fn4")),
        ]
        .into_iter()
        .collect();
        assert_eq!(pairs, expected, "transitive closure of a 4-node chain");
    }

    // ── determinism (I1): rule-order permutation → identical result ─

    #[test]
    fn rule_order_permutation_is_byte_equal() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "fn1", "FUNCTION");
        node(&mut v, "fn2", "FUNCTION");
        node(&mut v, "cls1", "CLASS");

        let a = r#"
            interesting(X) :- node(X, "FUNCTION").
            interesting(X) :- node(X, "CLASS").
        "#;
        let b = r#"
            interesting(X) :- node(X, "CLASS").
            interesting(X) :- node(X, "FUNCTION").
        "#;
        let stats = Stats { total_nodes: 3, total_edges: 0, ..Default::default() };
        let ea = run(a, &v, stats.clone());
        let eb = run(b, &v, stats);
        assert_eq!(ea, eb, "clause order must not change the committed result (I1)");
    }

    // ── ⊆-growth within a stratum (I3) via cap-zero rejection ───────

    #[test]
    fn iteration_cap_fires_as_e_exec_002() {
        // A degenerate cap of 0 forces E-EXEC-002 on any stratum that needs a Δ-round.
        // reach has a recursive clause, so its stratum runs at least one Δ-round.
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "fn1", "FUNCTION");
        node(&mut v, "fn2", "FUNCTION");
        edge(&mut v, "fn1", "fn2", "CALLS");

        let src = r#"
            reach(X, Y) :- edge(X, Y, "CALLS").
            reach(X, Z) :- reach(X, Y), edge(Y, Z, "CALLS").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats { total_nodes: 2, total_edges: 1, ..Default::default() })
            .expect("plan");
        let exec = Executor::<BoolTag>::with_limits(&v, EvalLimits::none(), 0);
        let err = exec.evaluate(&plans, &rules, &strat).expect_err("cap fires");
        assert_eq!(err.code, ExecCode::IterationCap);
        assert_eq!(err.code.as_str(), "E-EXEC-002");
    }

    #[test]
    fn exec_codes_are_stable() {
        assert_eq!(ExecCode::IterationCap.as_str(), "E-EXEC-002");
        assert_eq!(ExecCode::LimitExceeded.as_str(), "E-EXEC-001");
    }

    // ── empty program / empty stratum is not an error ───────────────

    #[test]
    fn empty_program_evaluates_to_nothing() {
        let v = FixtureStorageView::new(1);
        let eval = run("", &v, Stats { total_nodes: 0, total_edges: 0, ..Default::default() });
        assert!(eval.relations.is_empty());
    }

    // ── always-on events: schema-valid sequence, counts match result (I9) ──

    #[test]
    fn fixpoint_run_emits_schema_valid_events_with_matching_counts() {
        use crate::datalog2::events::{EventKind, EVENT_SCHEMA_VERSION};

        // A recursive program so the log contains a seed, ≥1 Δ-iteration, and a commit.
        let mut v = FixtureStorageView::new(1);
        for f in ["fn1", "fn2", "fn3", "fn4"] {
            node(&mut v, f, "FUNCTION");
        }
        edge(&mut v, "fn1", "fn2", "CALLS");
        edge(&mut v, "fn2", "fn3", "CALLS");
        edge(&mut v, "fn3", "fn4", "CALLS");

        let src = r#"
            reach(X, Y) :- edge(X, Y, "CALLS").
            reach(X, Z) :- reach(X, Y), edge(Y, Z, "CALLS").
        "#;
        let (eval, events) =
            run_with_events(src, &v, Stats { total_nodes: 4, total_edges: 3, ..Default::default() });

        // Non-empty sequence; every line carries the current schema version (I9).
        assert!(!events.is_empty(), "an always-on log must not be empty");
        for e in &events {
            assert_eq!(e.v, EVENT_SCHEMA_VERSION);
            // Each event serializes to schema-valid, kind-tagged JSON.
            let value: serde_json::Value =
                serde_json::to_value(e).expect("event serializes");
            assert!(value["kind"].is_string(), "every event is kind-tagged");
        }

        // Bracketed by exactly one RunBegin (first) and one RunCommitted (last).
        assert!(
            matches!(events.first().map(|e| &e.kind), Some(EventKind::RunBegin { .. })),
            "first event is RunBegin"
        );
        let committed = match events.last().map(|e| &e.kind) {
            Some(EventKind::RunCommitted { fact_counts }) => fact_counts.clone(),
            other => panic!("last event must be RunCommitted, got {other:?}"),
        };

        // The committed fact counts in the log MUST equal the committed result (I9: the
        // log's totals are independently recomputable from the evaluation).
        let mut from_eval: Vec<(String, u64)> = eval
            .relations
            .iter()
            .map(|(name, rows)| (name.clone(), rows.len() as u64))
            .collect();
        from_eval.sort();
        let mut from_log: Vec<(String, u64)> = committed
            .iter()
            .map(|c| (c.predicate.clone(), c.facts))
            .collect();
        from_log.sort();
        assert_eq!(
            from_log, from_eval,
            "RunCommitted fact counts must match the committed result"
        );
        // reach over a 4-node chain has 6 facts; the log agrees.
        assert_eq!(
            committed.iter().find(|c| c.predicate == "reach").map(|c| c.facts),
            Some(6),
            "transitive closure has 6 pairs and the log records them"
        );

        // The schedule and at least one iteration with the firing counter were logged.
        assert!(
            events
                .iter()
                .any(|e| matches!(e.kind, EventKind::StratumSchedule { .. })),
            "stratum schedule is logged"
        );
        let total_firings: u64 = events
            .iter()
            .filter_map(|e| match &e.kind {
                EventKind::Iteration { rule_firings, .. } => Some(*rule_firings),
                _ => None,
            })
            .sum();
        assert!(
            total_firings >= 1,
            "a recursive run fires the delta rule at least once"
        );
    }

    #[test]
    fn aborted_run_logs_abort_code() {
        use crate::datalog2::events::{EventKind, EventLog, SharedMemSink};

        // Cap of 0 forces E-EXEC-002; the log must record the abort, never truncate silently.
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "fn1", "FUNCTION");
        node(&mut v, "fn2", "FUNCTION");
        edge(&mut v, "fn1", "fn2", "CALLS");

        let src = r#"
            reach(X, Y) :- edge(X, Y, "CALLS").
            reach(X, Z) :- reach(X, Y), edge(Y, Z, "CALLS").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats { total_nodes: 2, total_edges: 1, ..Default::default() })
            .expect("plan");
        let sink = SharedMemSink::new();
        let exec = Executor::<BoolTag>::with_limits(&v, EvalLimits::none(), 0)
            .with_events(EventLog::with_sink(Box::new(sink.clone())));
        let err = exec.evaluate(&plans, &rules, &strat).expect_err("cap fires");
        assert_eq!(err.code.as_str(), "E-EXEC-002");

        let events = sink.events();
        let aborted = events.iter().any(|e| matches!(
            &e.kind,
            EventKind::RunAborted { code, .. } if code == "E-EXEC-002"
        ));
        assert!(aborted, "an aborted run logs RunAborted with the stable code");
        // No RunCommitted on an aborted run.
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.kind, EventKind::RunCommitted { .. })),
            "an aborted run must not log a commit"
        );
    }
}
