//! Layer 6 — query planner.
//!
//! Reorders rule literals for bound-first feasibility (ported from the query engine's
//! `crate::datalog::utils::reorder_literals`), applies a greedy cost ordering from
//! `StorageView` [`Stats`](crate::derive::builtin::Stats), and picks the join kind per
//! leg (hash join on Δ for recursive/derived legs, merge join on Total/EDB legs over the
//! sorted runs the [`StorageView`](crate::derive::storage_glue::StorageView) exposes).
//! Enforces the §3 planning guards (`E-PLAN-003`) including the cross-join-body and
//! per-rule materialization-estimate rejections, and surfaces the builtin mode check
//! (`E-PLAN-001`) that the registry raises for an unsatisfiable binding pattern.
//!
//! # What the planner produces
//!
//! For each rule clause the planner emits a [`RulePlan`]: the body literals in
//! feasibility-then-cost order, each annotated as a [`PlanLeg`] carrying the resolved
//! per-argument bind pattern, the leg's [`LegSource`] (extensional base relation, builtin,
//! or a derived predicate), and — for the join legs the executor runs — a [`JoinKind`].
//! The executor (Layer 7) consumes the plan without re-deriving any ordering.
//!
//! # Cost model
//!
//! Cost is a coarse, monotone estimate (spec §7). A base/EDB leg with a bound key column is
//! a narrowed scan (cheap); an unbound generator is a full relation scan (its per-type/per-
//! endpoint magnitude from the [`Stats`](crate::derive::builtin::Stats) cardinality oracle).
//! Both literal ordering (`ordering_estimate`) and the per-rule size guard (`leg_estimate`)
//! score legs through the shared `base_estimate`/`derived_estimate` helpers, so the order the
//! executor runs and the guard's product are computed from identical cardinality math. The
//! running output-size estimate multiplies the surviving fan-out of each placed leg; the §3
//! guard fires when that product exceeds `MAX_MATERIALIZED_FACTS`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;

use crate::datalog::{Atom, Literal, Rule, Term};

use super::builtin::{self, ArgMode, Stats};
use super::stratify::Stratification;

// ── Guard thresholds (spec §3) ─────────────────────────────────────

/// Per-rule materialization ceiling (spec §3): a rule whose plan-time output estimate
/// exceeds this is rejected with `E-PLAN-003`. Ten million facts.
pub const MAX_MATERIALIZED_FACTS: u64 = 10_000_000;

// ── Ground-fact cardinality (REG-1196) ─────────────────────────────

/// The exact shape of a predicate defined ENTIRELY by ground facts — a pack's
/// compiled-in registry table (`ecb_method`/`ecb_arg` from
/// effects_callable_facts.dl, `rtg_key`/`rtg_eff`, `hr_lib`, `ef_lib`, …).
#[derive(Debug, Clone)]
struct FactShape {
    /// Number of fact rows. Exact, not an estimate.
    rows: u64,
    /// Per-column count of DISTINCT constant values. Exact.
    distinct: Vec<u64>,
}

/// Exact cardinalities of every all-ground-facts predicate in the program.
///
/// These relations are the one class whose size is a property of the PROGRAM, not of the
/// graph: `ecb_method` has 180 rows whether the graph holds three nodes or half a million.
/// Sizing a keyed probe into them by a graph-derived quantity is therefore a category
/// error, and it is the one that produced REG-1196 (see [`derived_estimate`]).
#[derive(Debug, Clone, Default)]
struct FactStats {
    per_pred: HashMap<String, FactShape>,
}

impl FactStats {
    /// Collect the shapes from a program's rules. A predicate qualifies only if EVERY one
    /// of its rules is a ground fact (empty body, all head arguments constant) — one
    /// non-ground rule and the predicate's size depends on the graph again, so it is left
    /// to the ordinary derived-predicate path.
    fn from_rules(rules: &[&Rule]) -> Self {
        // predicate -> per-column sets of the rendered constant values, or None once a
        // non-ground rule for that predicate has been seen.
        let mut acc: HashMap<String, Option<Vec<HashSet<String>>>> = HashMap::new();
        for rule in rules {
            let head = rule.head();
            let entry = acc.entry(head.predicate().to_string()).or_insert_with(|| {
                Some(vec![HashSet::new(); head.args().len()])
            });
            let ground = rule.body().is_empty()
                && head.args().len() == entry.as_ref().map_or(0, |c| c.len())
                && head.args().iter().all(|t| ground_key(t).is_some());
            if !ground {
                *entry = None;
                continue;
            }
            if let Some(cols) = entry.as_mut() {
                for (i, t) in head.args().iter().enumerate() {
                    cols[i].insert(ground_key(t).expect("checked ground above"));
                }
            }
        }

        let mut per_pred = HashMap::new();
        for rule in rules {
            let pred = rule.head().predicate();
            if let Some(Some(cols)) = acc.get(pred) {
                let shape = per_pred.entry(pred.to_string()).or_insert_with(|| FactShape {
                    rows: 0,
                    distinct: cols.iter().map(|s| s.len() as u64).collect(),
                });
                shape.rows += 1;
            }
        }
        FactStats { per_pred }
    }

    fn shape(&self, pred: &str) -> Option<&FactShape> {
        self.per_pred.get(pred)
    }

    /// The per-key fan-out of a probe into a ground-fact relation: rows over the number of
    /// distinct values in the columns the probe actually keys on.
    ///
    /// "Actually keys on" excludes `_`: [`arg_pattern`] marks a wildcard [`ArgMode::Bound`]
    /// because it needs no binding, but a wildcard restricts NOTHING, so counting its
    /// column as a key would divide by a selectivity the probe never gets.
    ///
    /// The divisor is the MAX over the keyed columns' distinct counts, which is a lower
    /// bound on the number of distinct key TUPLES — so the fan-out is an over-estimate,
    /// never an under-estimate. `None` when the probe binds no real key (a full scan of a
    /// relation whose exact row count the caller already has).
    fn keyed_fanout(&self, pred: &str, atom: &Atom, pattern: &[ArgMode]) -> Option<u64> {
        let shape = self.shape(pred)?;
        let keys = atom
            .args()
            .iter()
            .enumerate()
            .filter(|(i, t)| {
                !matches!(t, Term::Wildcard) && pattern.get(*i) == Some(&ArgMode::Bound)
            })
            .filter_map(|(i, _)| shape.distinct.get(i).copied())
            .max()?;
        Some((shape.rows / keys.max(1)).max(1))
    }
}

/// A ground term's comparable value, or `None` if the term is not ground.
fn ground_key(term: &Term) -> Option<String> {
    match term {
        Term::Const(s) => Some(s.clone()),
        Term::Lit(v) => Some(format!("{v:?}")),
        Term::Var(_) | Term::Wildcard => None,
    }
}


// ── Error taxonomy (invariant I5) ──────────────────────────────────

/// Stable planner error codes (spec §12). Every rejection carries one; a silently-empty
/// plan is a forbidden failure mode (I5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanCode {
    /// A builtin literal's actual binding pattern is supported by no registered mode; the
    /// named argument positions must be bound first. Mirrors
    /// [`BuiltinCode::UnsupportedMode`](crate::derive::builtin::BuiltinCode). Spec §7.
    UnsupportedMode,
    /// A §3 guard rejection: either the body contains a cross-join (a positive literal that
    /// shares no variable with the bindings accumulated so far), or the per-rule output
    /// estimate exceeds [`MAX_MATERIALIZED_FACTS`]. Spec §3.
    GuardRejected,
    /// The literals cannot be ordered bound-first: a builtin/base leg needs a binding that
    /// no other literal in the body can provide (circular feasibility). Spec §7.
    Infeasible,
}

impl PlanCode {
    /// The stable string form emitted in diagnostics and conformance manifests.
    pub fn as_str(self) -> &'static str {
        match self {
            PlanCode::UnsupportedMode => "E-PLAN-001",
            PlanCode::GuardRejected => "E-PLAN-003",
            PlanCode::Infeasible => "E-PLAN-002",
        }
    }
}

impl fmt::Display for PlanCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A planner rejection: a stable [`PlanCode`], the offending rule head, and a one-line
/// human detail (the code is authoritative; the detail is a hint, never the sole signal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    /// Stable taxonomy code — the load-bearing, machine-checkable field.
    pub code: PlanCode,
    /// Head predicate of the rule whose planning failed.
    pub head: String,
    /// One-line human detail (e.g. the offending literal, the estimate, the required
    /// bindings). Never authoritative on its own.
    pub detail: String,
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.head, self.detail)
    }
}

impl std::error::Error for PlanError {}

/// Planner result.
pub type PlanResult<T> = Result<T, PlanError>;

// ── Leg classification ─────────────────────────────────────────────

/// What a planned body leg reads from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegSource {
    /// A base relation served from a storage column family (`node`/`type`/`edge`/
    /// `incoming`/`attr`). Extensional: served over a sorted run (merge-join leg) or a
    /// typed scan (generator).
    Base(String),
    /// A builtin filter/function shared with the query engine (`neq`/`gt`/`starts_with`/…). Consumes the
    /// current row; never a join leg.
    Builtin(String),
    /// A derived predicate (a rule head). `recursive` is `true` when it sits in the SAME
    /// stratum as the rule being planned — that leg reads the Δ relation and is hash-joined
    /// (build on Δ); otherwise it reads a frozen lower-stratum Total and is merge-joined.
    Derived { name: String, recursive: bool },
}

/// How the executor joins a leg into the partial row (spec §7 / the §3 access-path model).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinKind {
    /// Hash join with the build side on Δ (recursive/derived legs in the same stratum).
    HashOnDelta,
    /// Merge join over a [`StorageView`](crate::derive::storage_glue::StorageView) sorted
    /// run (Total / EDB legs: base relations and frozen lower strata).
    MergeOnTotal,
    /// No join: a filter/function builtin that prunes or binds within the current row.
    None,
}

/// One planned body leg: the literal, its resolved per-argument bind pattern, its source
/// classification, and the join kind the executor runs it with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanLeg {
    /// The body literal (in its original syntactic form; the executor resolves slots).
    pub literal: Literal,
    /// Per-argument bind state at the moment this leg runs (`Bound`/`Free`), in source
    /// argument order. The length equals the atom's arity.
    pub pattern: Vec<ArgMode>,
    /// What the leg reads.
    pub source: LegSource,
    /// How the leg is joined.
    pub join: JoinKind,
    /// The leg's coarse output-size estimate (spec §7), folded into the per-rule guard.
    pub estimate: u64,
}

/// The plan for one rule clause: ordered legs plus the per-rule output estimate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulePlan {
    /// Head predicate of the planned rule.
    pub head: String,
    /// Body legs in execution order (feasibility-then-cost; bound-first).
    pub legs: Vec<PlanLeg>,
    /// The per-rule output-size estimate (product of surviving leg fan-outs), checked
    /// against [`MAX_MATERIALIZED_FACTS`] by the §3 guard.
    pub estimate: u64,
    /// Upper bound on the DISTINCT values each head column can take (REG-1196). Published
    /// stratum-bottom-up by [`plan_program`] so a consumer of this predicate sizes its
    /// columns by what populates them — a node count, an attribute's value space, a
    /// ground-fact table's distinct count — instead of by this rule's own row estimate,
    /// which is the very quantity the §3 cap exists to bound.
    pub head_domains: Vec<u64>,
}

// ── Public entry points ────────────────────────────────────────────

/// Plan every rule in a program against a stratification and the run's [`Stats`].
///
/// Each clause is planned independently; the stratification is consulted to decide whether
/// a derived-predicate leg is recursive (same stratum ⇒ hash-on-Δ) or a frozen lower
/// stratum (⇒ merge-on-Total). Returns the per-rule plans in input order, or the first
/// rejection (every rejection carries a stable [`PlanCode`]).
pub fn plan_program(
    rules: &[&Rule],
    strat: &Stratification,
    stats: &Stats,
) -> PlanResult<Vec<RulePlan>> {
    // Per-predicate cardinality estimates, populated STRATUM-BOTTOM-UP: a predicate's
    // estimate is the (saturating) sum of its rules' output estimates, recorded before any
    // higher stratum that references it is planned. This is what lets `derived_estimate`
    // size a derived leg at the predicate's own magnitude instead of the whole-graph
    // magnitude (the q-error that spuriously tripped E-PLAN-003 on recursive closures and
    // on chains of small derived relations — see the flipped
    // `recursive_closure_*_qerror` test).
    let mut estimates: HashMap<String, u64> = HashMap::new();
    let mut plans: Vec<Option<RulePlan>> = (0..rules.len()).map(|_| None).collect();

    // Per-predicate, per-column domain bounds, published stratum-bottom-up alongside the
    // estimates so the §3 universe cap can see where each column's VALUES come from.
    let mut col_domains: HashMap<String, Vec<u64>> = HashMap::new();

    // Exact cardinalities of the program's compiled-in ground-fact tables (REG-1196).
    // Collected once per program: these are the relations whose size does not move with
    // the graph, so they must not be sized through a graph-derived divisor.
    let facts = FactStats::from_rules(rules);

    for stratum in &strat.strata {
        let idxs: Vec<usize> = rules
            .iter()
            .enumerate()
            .filter(|(_, r)| {
                strat.stratum_of(r.head().predicate()) == Some(stratum.index)
            })
            .map(|(i, _)| i)
            .collect();

        // Non-recursive (base-case) rules first: their estimates seed the self-leg bound
        // the recursive rules of the SAME predicate use (fixpoint size isn't known until
        // it runs; the base case is the sound seed, doubled for growth).
        //
        // INTRA-STRATUM PUBLISHING: a stratum can hold a whole producer-consumer CHAIN of
        // mutually-independent predicates — a storage-level `@materialize` back-edge (a
        // pack that both writes and reads IMPORTS_FROM, W-STRAT-001) collapses the chain
        // into one SCC. Planning each sibling with only the LOWER-stratum estimates sent
        // every same-stratum derived leg to the whole-graph None-fallback, whose product
        // q-error spuriously trips E-PLAN-003 (observed live 2026-06-10: the stdlib
        // js_import_bindings chain rule estimated b_named·visible at 905 847 × 952 ≈ 862M
        // vs an actual ~3k). Non-recursive rules are planned in source order and publish
        // their estimates into a stratum-local overlay as they go, so a leg over an
        // ALREADY-PLANNED sibling is sized at that sibling's own magnitude. Lowering an
        // estimate can only let MORE rules pass the §3 guard and reorder legs — never
        // change WHICH facts a rule derives (I1, same contract as `derived_estimate`).
        // Packs keep prelude-before-consumer source order (the established convention),
        // so the overlay is populated exactly along the dependency chain.
        let mut local_estimates: HashMap<String, u64> = estimates.clone();
        let mut local_domains: HashMap<String, Vec<u64>> = col_domains.clone();
        let mut base_case: HashMap<String, u64> = HashMap::new();
        for &i in &idxs {
            let rule = rules[i];
            let head = rule.head().predicate();
            let is_recursive = rule
                .body()
                .iter()
                .any(|l| l.atom().predicate() == head);
            if is_recursive {
                continue;
            }
            let plan =
                plan_rule_with(rule, strat, stats, &local_estimates, None, &facts, &local_domains)?;
            let e = base_case.entry(head.to_string()).or_insert(0);
            *e = (*e).max(plan.estimate);
            let le = local_estimates.entry(head.to_string()).or_insert(0);
            *le = le.saturating_add(plan.estimate);
            merge_column_domains(&mut local_domains, head, &plan.head_domains);
            plans[i] = Some(plan);
        }
        for &i in &idxs {
            if plans[i].is_some() {
                continue;
            }
            let rule = rules[i];
            let bc = base_case
                .get(rule.head().predicate())
                .copied()
                .unwrap_or(0);
            let plan = plan_rule_with(
                rule,
                strat,
                stats,
                &local_estimates,
                Some(bc),
                &facts,
                &local_domains,
            )?;
            let le = local_estimates
                .entry(rule.head().predicate().to_string())
                .or_insert(0);
            *le = le.saturating_add(plan.estimate);
            merge_column_domains(&mut local_domains, rule.head().predicate(), &plan.head_domains);
            plans[i] = Some(plan);
        }
        // Publish this stratum's predicate estimates and column domains for the strata
        // above it.
        for &i in &idxs {
            let p = plans[i].as_ref().expect("planned above");
            let e = estimates.entry(p.head.clone()).or_insert(0);
            *e = e.saturating_add(p.estimate);
            merge_column_domains(&mut col_domains, &p.head.clone(), &p.head_domains);
        }
    }

    // Defensive: a rule whose head the stratification does not place (should not happen —
    // every rule head is a derived predicate) is planned without predicate estimates.
    plans
        .into_iter()
        .zip(rules.iter())
        .map(|(p, rule)| match p {
            Some(plan) => Ok(plan),
            None => plan_rule(rule, strat, stats),
        })
        .collect()
}

/// Plan a single rule clause.
///
/// Steps (spec §7):
/// 1. Order the body literals bound-first (ported feasibility) refined by greedy cost.
/// 2. Classify each leg (base / builtin / derived), check builtin modes (`E-PLAN-001`).
/// 3. Pick the join kind (hash on Δ for same-stratum derived legs; merge on Total/EDB).
/// 4. Apply the §3 guards: cross-join body and per-rule estimate (`E-PLAN-003`).
pub fn plan_rule(rule: &Rule, strat: &Stratification, stats: &Stats) -> PlanResult<RulePlan> {
    plan_rule_with(
        rule,
        strat,
        stats,
        &HashMap::new(),
        None,
        &FactStats::default(),
        &HashMap::new(),
    )
}

/// [`plan_rule`] with the per-predicate cardinality context [`plan_program`] threads in:
/// `estimates` maps every LOWER-stratum predicate to its estimated cardinality, and
/// `self_base` carries the head's base-case estimate when THIS rule is recursive (None for
/// non-recursive rules). Without the context (empty map, None) the planner falls back to
/// the conservative whole-graph magnitude — the pre-fix behavior.
fn plan_rule_with(
    rule: &Rule,
    strat: &Stratification,
    stats: &Stats,
    estimates: &HashMap<String, u64>,
    self_base: Option<u64>,
    facts: &FactStats,
    col_domains: &HashMap<String, Vec<u64>>,
) -> PlanResult<RulePlan> {
    let head = rule.head().predicate().to_string();
    let head_stratum = strat.stratum_of(&head);

    let ordered = order_literals(rule.body(), &head, stats)?;

    let mut bound: HashSet<String> = HashSet::new();
    let mut legs: Vec<PlanLeg> = Vec::with_capacity(ordered.len());
    let mut rule_estimate: u64 = 1;
    // Per-variable upper bound on the number of DISTINCT values the variable can take,
    // recorded by the leg that first binds it, plus its SUPPORT — the set of independently
    // generated variables it is a function of. A builtin output like
    // `concat(F, Name, Sid)` is fully determined by its inputs, so multiplying its domain
    // into the head universe alongside F and Name would count the same freedom three
    // times; the support set is what stops that double-count. Both feed the §3 cap below.
    let mut domains: HashMap<String, u64> = HashMap::new();
    let mut support: HashMap<String, BTreeSet<String>> = HashMap::new();

    for (idx, lit) in ordered.iter().enumerate() {
        let atom = lit.atom();
        let pred = atom.predicate();
        let pattern = arg_pattern(atom, &bound);

        // §3 cross-join guard: a positive *relational* leg (one that introduces tuples,
        // i.e. NOT a filter/function and NOT the very first leg) that shares no variable
        // with the bindings accumulated so far is a Cartesian product. Filters and
        // functions consume the current row and never cross-join.
        if idx > 0 && lit.is_positive() && introduces_tuples(pred) && shares_no_binding(atom, &bound)
        {
            return Err(PlanError {
                code: PlanCode::GuardRejected,
                head: head.clone(),
                detail: format!(
                    "cross-join: literal `{}` shares no bound variable with the preceding body",
                    pred
                ),
            });
        }

        let source = classify(pred, strat, head_stratum);

        // Registry mode check (E-PLAN-001): reject a base/builtin literal whose actual
        // binding pattern is supported by no registered mode — an unbound comparison, or a
        // base relation asked for a run that no sort order serves (e.g. `node(Free, Free)`,
        // which would require enumerating every (id, type) pair without a bound key).
        // Derived predicates have no registry entry and are checked by stratification, not
        // here.
        match &source {
            LegSource::Builtin(name) | LegSource::Base(name) => {
                check_builtin_mode(name, &pattern, &head)?;
            }
            LegSource::Derived { .. } => {}
        }

        let join = pick_join(&source, &pattern);
        let estimate = leg_estimate(&source, atom, &pattern, stats, estimates, self_base, facts);

        // Only positive, tuple-introducing legs (those that bind previously-free variables)
        // grow the output-size estimate. Anti-joins (negative literals) and fully-bound
        // filters can only narrow the result (selectivity ≤ 1), so they must NOT multiply the
        // estimate — otherwise a cheap `node(X,T), \+ edge(_,X,"CONTAINS")` is mis-estimated
        // as the product of two relation magnitudes and spuriously trips the §3 E-PLAN-003
        // guard (observed: function-has-contains estimated 52,970,680 vs actual 1,747).
        let provided = provided_vars(atom, &bound);
        if lit.is_positive() && !provided.is_empty() {
            rule_estimate = rule_estimate.saturating_mul(estimate.max(1));
        }

        if lit.is_positive() {
            record_domains(
                &source,
                atom,
                &provided,
                stats,
                estimates,
                facts,
                col_domains,
                &mut domains,
                &mut support,
            );
        }
        bound.extend(provided);
        legs.push(PlanLeg {
            literal: lit.clone(),
            pattern,
            source,
            join,
            estimate,
        });
    }

    // §3 UNIVERSE CAP (REG-1196). The running product multiplies a per-leg fan-out for
    // every leg, so a long derivation chain compounds its per-leg q-error geometrically —
    // but a rule cannot derive more distinct rows than its head has distinct value
    // combinations. Each head column's domain is bounded by what actually populates it: a
    // node/endpoint column by the graph's node count, an attribute value by the same (a
    // node holds one value per key), a ground-fact column by that table's exact distinct
    // count. Clamping the product at that universe is the generalization of the fix option
    // recorded for the recursive case in `_ai/gaps.md` ("cap a recursive rule's estimate at
    // |nodes|^arity — closure can't exceed the universe").
    //
    // This term is monotone-DECREASING: it can only lower an estimate, so it can never
    // make the guard reject a rule it accepts today. On a production-size graph the cap is
    // astronomically above the ceiling and never binds; it earns its keep only where the
    // graph is genuinely too small to hold what the product claims.
    let head_domains = head_column_domains(rule.head(), &domains);
    let rule_estimate = rule_estimate.min(head_universe(rule.head(), &domains, &support));

    // §3 per-rule materialization guard.
    if rule_estimate > MAX_MATERIALIZED_FACTS {
        return Err(PlanError {
            code: PlanCode::GuardRejected,
            head: head.clone(),
            detail: format!(
                "per-rule output estimate {} exceeds max_materialized_facts {}",
                rule_estimate, MAX_MATERIALIZED_FACTS
            ),
        });
    }

    Ok(RulePlan {
        head,
        legs,
        estimate: rule_estimate,
        head_domains,
    })
}

// ── Literal ordering: bound-first feasibility + greedy cost ────────

/// Order body literals bound-first (ported from the query engine's `reorder_literals`) and break ties by a
/// cardinality-aware estimate. At each step the candidates are the literals whose binding
/// requirements are already satisfied (bound-first feasibility gates candidacy); among them
/// the leg with the lowest estimated cardinality under the current bindings is placed first,
/// so the most selective feasible leg leads each join. The estimate is the same per-type /
/// per-endpoint oracle the per-rule guard folds in ([`base_estimate`]) — ordering is no
/// longer cardinality-blind. Reordering is order-independent (I1): it changes only the join
/// ORDER, never WHICH facts the rule derives.
///
/// Returns `E-PLAN-002` if no candidate can be placed (circular feasibility) — the query
/// engine's "circular dependency" rejection, surfaced with a stable code (I5).
fn order_literals(body: &[Literal], head: &str, stats: &Stats) -> PlanResult<Vec<Literal>> {
    let mut bound: HashSet<String> = HashSet::new();
    let mut result: Vec<Literal> = Vec::with_capacity(body.len());
    let mut remaining: Vec<Literal> = body.to_vec();

    while !remaining.is_empty() {
        // All placeable candidates under the current bindings, ranked by a lexicographic key
        // (lower is better): (cross_join_class, cost_band, hub_rank, cost). Every term changes
        // only join ORDER, never which facts derive (I1).
        //   • cross_join_class — 0 normally; 1 for a positive tuple-introducing leg that, after
        //     the first placement, shares NO bound variable (a would-be Cartesian product). Any
        //     connected feasible leg is preferred over a disconnected free generator, so the
        //     planner never manufactures a cross-join the §3 guard would then reject.
        //   • cost_band — the cost's order of magnitude (bit length). The most selective leg
        //     still leads across DIFFERENT magnitudes (e.g. a 5-node RARE generator beats a
        //     100k-node COMMON one), but two legs of the SAME magnitude (e.g. 367 vs 370 nodes)
        //     fall in one band and defer to connectivity — so a marginal cost difference does
        //     NOT dictate a globally worse join order.
        //   • hub_rank — within a cost band at the FIRST placement (empty bindings, where every
        //     leg is disconnected and per-leg cost alone would pick the cheapest LEAF
        //     generator): rank legs by how many join KEYS they bind that OTHER body literals
        //     consume. The driver that unlocks the most downstream keyed readers leads, turning
        //     those readers into point lookups instead of fresh value-generators (observed: the
        //     stdlib `depends` rule estimates at 367·20·370·20 ≈ 54M when led by a leaf
        //     `node(M,"MODULE")` generator binding ONE key, vs ≈148k when led by its hub `edge`
        //     binding TWO endpoint keys that feed the file readers — both legs sit in the same
        //     ~370 cost band, so the marginal 367<370 must not force the worse leaf-led order).
        //     After the first leg hub_rank ≡ 0 (binding-driven feasibility takes over).
        //   • cost — the exact per-type / per-endpoint estimate, final tiebreak within a band.
        let mut best: Option<(usize, (u64, u64, u64, u64, u64))> = None;
        for (i, lit) in remaining.iter().enumerate() {
            let (can_place, provides) = can_place_and_provides(lit, &bound);
            if !can_place {
                continue;
            }
            let cross_join_class = if !result.is_empty()
                && lit.is_positive()
                && introduces_tuples(lit.atom().predicate())
                && shares_no_binding(lit.atom(), &bound)
            {
                1
            } else {
                0
            };
            let cost = ordering_estimate(lit, &bound, stats);
            // Order of magnitude: 64 − leading_zeros = number of significant bits. Costs within
            // the same power-of-two band tie here and defer to hub_rank.
            let cost_band = (u64::BITS - cost.leading_zeros()) as u64;
            let hub_rank = if result.is_empty() {
                let keys_to_others = provides
                    .iter()
                    .filter(|v| {
                        remaining.iter().enumerate().any(|(j, other)| {
                            j != i
                                && other.atom().args().iter().any(|t| match t {
                                    Term::Var(name) => name == *v,
                                    _ => false,
                                })
                        })
                    })
                    .count() as u64;
                // More keys unlocked → lower (better) rank.
                (remaining.len() as u64).saturating_sub(keys_to_others)
            } else {
                0
            };
            // FINAL tiebreak only (REG-1196, second defect): when every term above is
            // EXACTLY equal the planner used to fall back to source order, and on a
            // near-empty graph every term IS equal — each candidate costs 1 because no
            // node type has any members. Source order then led with a leg after which the
            // only feasible continuations are cross-joins, and the §3 guard rejected the
            // rule outright. One step of lookahead breaks that tie towards a body that can
            // still be ordered. Placed LAST so it cannot reorder anything on a graph where
            // cost already discriminates — production plans are untouched.
            let strands = strands_body(&remaining, i, &bound, &provides);
            let key = (cross_join_class, cost_band, hub_rank, cost, strands);
            match best {
                Some((_, bk)) if key >= bk => {}
                _ => best = Some((i, key)),
            }
        }

        match best {
            Some((i, _)) => {
                let lit = remaining.remove(i);
                let (_, provides) = can_place_and_provides(&lit, &bound);
                bound.extend(provides);
                result.push(lit);
            }
            None => {
                let stuck: Vec<String> = remaining
                    .iter()
                    .map(|l| l.atom().predicate().to_string())
                    .collect();
                return Err(PlanError {
                    code: PlanCode::Infeasible,
                    head: head.to_string(),
                    detail: format!(
                        "cannot order bound-first: no feasible binding for {:?}",
                        stuck
                    ),
                });
            }
        }
    }

    Ok(result)
}

/// Whether placing `remaining[placed]` next leaves the body with no continuation except a
/// cross-join (or no feasible continuation at all) — the shapes the §3 guard and the
/// feasibility check reject. `1` = stranded, `0` = some placeable, connected continuation
/// exists. Bodies hold a handful of literals, so the quadratic scan is free.
fn strands_body(
    remaining: &[Literal],
    placed: usize,
    bound: &HashSet<String>,
    provides: &HashSet<String>,
) -> u64 {
    let mut next_bound = bound.clone();
    next_bound.extend(provides.iter().cloned());
    let mut has_other = false;
    for (j, other) in remaining.iter().enumerate() {
        if j == placed {
            continue;
        }
        has_other = true;
        let (can_place, _) = can_place_and_provides(other, &next_bound);
        if !can_place {
            continue;
        }
        let would_cross_join = other.is_positive()
            && introduces_tuples(other.atom().predicate())
            && shares_no_binding(other.atom(), &next_bound);
        if !would_cross_join {
            return 0;
        }
    }
    u64::from(has_other)
}

/// The cardinality-aware ordering cost of a candidate literal under the current bind set
/// (spec §7). Used only to break bound-first feasibility ties during ordering, so it must be
/// a pure function of the binding state and never change WHICH facts are derived (I1).
///
/// The ranking turns on whether the leg INTRODUCES new tuples under the current bindings:
///
/// * A leg that binds NO new variable — a filter (`neq`/`gt`/…), a fully-bound existence or
///   point check (`node(BoundId,"T")`, `attr(BoundId,"k",V)`, a negated anti-join) — has
///   fan-out ≤ 1: it can only prune. It is the cheapest possible leg (cost 0) and must lead
///   the moment it is feasible. This is what keeps a type-filter running IMMEDIATELY after the
///   generator that bound its id, instead of deferring behind a second generator (which would
///   materialize the cross-product of two generators before any pruning — observed on the
///   stdlib `depends` rule: two `attr(FreeId,"file",F)` generators sorted ahead of their
///   `node(M,"MODULE")` filters blew the intermediate set to ~12M rows).
/// * A leg that DOES bind a new variable is a generator, ranked by its estimated output
///   cardinality through the SAME per-type / per-endpoint oracle the per-rule guard folds in
///   ([`base_estimate`]). Note this correctly costs `attr(FreeId,"key","val")` in GENERATOR
///   mode (binds the free id) as a keyed reverse-lookup — NOT as the 0-cost filter the old
///   `is_filter_or_function("attr")` blanket made it, which mis-ranked it ahead of cheaper
///   point-check legs.
fn ordering_estimate(lit: &Literal, bound: &HashSet<String>, stats: &Stats) -> u64 {
    let atom = lit.atom();
    let pred = atom.predicate();
    // A leg that introduces no new variable under the current bindings is a pure filter /
    // point check (fan-out ≤ 1). Negative literals are anti-joins (membership test, fan-out
    // ≤ 1). Either way: cheapest possible, lead it as soon as it is feasible.
    let provided = match lit {
        Literal::Positive(a) => provided_vars(a, bound),
        Literal::Negative(_) => HashSet::new(),
    };
    if provided.is_empty() {
        return 0;
    }
    let pattern = arg_pattern(atom, bound);
    if BASE_RELATIONS.contains(&pred) {
        base_estimate(pred, atom, &pattern, stats)
    } else {
        // A derived predicate (rule head) reachable here. Ordering runs per rule WITHOUT
        // the program-level estimates context (it only ranks candidate orders — it never
        // feeds the §3 guard), so it keeps the conservative whole-graph magnitude. It is
        // deliberately NOT given the ground-fact oracle either: ordering is I1-invariant
        // but it decides join ORDER, and REG-1196 is a guard-arithmetic fix — leaving the
        // ranking byte-identical keeps the blast radius on the estimate alone.
        derived_estimate(
            pred,
            false,
            atom,
            &pattern,
            stats,
            &HashMap::new(),
            None,
            &FactStats::default(),
        )
    }
}

// ── Feasibility (ported from the query engine's utils.rs) ──────────────────────────

/// Whether a literal can be placed given the current bound set, and which new variables it
/// provides if placed. Ported from `crate::datalog::utils::literal_can_place_and_provides`
/// and specialized to the derive builtin set; unknown predicates are derived heads (always
/// placeable, provide their free args via the rule's projection).
fn can_place_and_provides(lit: &Literal, bound: &HashSet<String>) -> (bool, HashSet<String>) {
    match lit {
        Literal::Negative(atom) => {
            // Negative literals require ALL Var args to be in bound.
            let all_bound = atom.args().iter().all(|t| match t {
                Term::Var(v) => bound.contains(v),
                _ => true,
            });
            (all_bound, HashSet::new())
        }
        Literal::Positive(atom) => positive_can_place_and_provides(atom, bound),
    }
}

fn positive_can_place_and_provides(
    atom: &Atom,
    bound: &HashSet<String>,
) -> (bool, HashSet<String>) {
    let args = atom.args();
    let pred = atom.predicate();

    match pred {
        "node" | "type" => (true, free_vars(args, bound)),
        "attr" => {
            if args.len() < 3 {
                return (true, HashSet::new());
            }
            let id_ok = is_bound_or_const(&args[0], bound);
            let name_ok = is_bound_or_const(&args[1], bound);
            let value_ok = is_bound_or_const(&args[2], bound);
            // `attr` has two placeable shapes, both backed by storage_v2's snapshot-pinned
            // attr index (parity with the query engine's `attr_to_query` + `find_by_attr`):
            //   • column reader/filter  — id bound, key bound: matches ATTR_MODES
            //     [B,B,F]/[B,B,B] and reads the bound node's column (eval_attr point lookup).
            //   • value generator       — id FREE, key AND value bound: matches
            //     ATTR_MODES [F,B,B] and produces the ids whose attr key == value via
            //     `nodes_by_attr` (the index reverse-lookup). This is what lets a rule write
            //     `attr(X, "name", "switch")` with X unbound (the query engine ran it; Gate A had scoped it
            //     out, an E-PLAN-001 capability gap now closed).
            if id_ok && name_ok {
                // Reader/filter: binds the value position if it is free.
                (true, provides_if_free(&args[2], bound))
            } else if name_ok && value_ok {
                // Generator: key + value bound, id free → provides (binds) the id var.
                (true, provides_if_free(&args[0], bound))
            } else {
                (false, HashSet::new())
            }
        }
        "edge" => (true, free_vars(args, bound)),
        "incoming" | "path" => {
            if args.is_empty() {
                return (true, HashSet::new());
            }
            let can_place = is_bound_or_const(&args[0], bound);
            let mut provides = HashSet::new();
            if can_place {
                for arg in args.iter().skip(1) {
                    provides.extend(provides_if_free(arg, bound));
                }
            }
            (can_place, provides)
        }
        "parent_function" => {
            if args.is_empty() {
                return (true, HashSet::new());
            }
            let can_place = is_bound_or_const(&args[0], bound);
            let provides = if can_place {
                args.get(1)
                    .map(|a| provides_if_free(a, bound))
                    .unwrap_or_default()
            } else {
                HashSet::new()
            };
            (can_place, provides)
        }
        "neq" | "gt" | "lt" | "gte" | "lte" | "starts_with" | "not_starts_with"
        | "string_contains" | "ends_with" => {
            let all_bound = args.iter().all(|t| match t {
                Term::Var(v) => bound.contains(v),
                _ => true,
            });
            (all_bound, HashSet::new())
        }
        // Function builtins deriving ONE output from already-bound inputs (the
        // `method_suffix` family): every position except the LAST is an input that must be
        // bound before the leg is placeable; the last position is the output, provided if
        // free (else an equality check). Mirrors the registry modes exactly
        // (STR_FN2_MODES / CONCAT_MODES / EDGE_ATTR_MODES), so a rule whose output is
        // genuinely underivable stays unplaceable here (E-PLAN-002 unsafe rule) instead of
        // reaching eval and tripping a confusing E-PLAN-001.
        // The function-shaped builtins deriving an output (or, for `split`, a SET of element
        // rows) from already-bound inputs: every position except the LAST must be bound
        // before the leg is placeable; the last position is the output, provided if free
        // (else an equality/membership check). `split` is a MULTI-ROW generator over a bound
        // string but is placed under the SAME rule — its inputs (subject, separator) must be
        // bound, and it binds the element variable; the executor's per-row loop materializes
        // every produced element row. Mirrors the registry modes exactly so a rule whose
        // output is genuinely underivable stays unplaceable here (E-PLAN-002 unsafe rule)
        // instead of reaching eval and tripping a confusing E-PLAN-001.
        "concat" | "str_lower" | "basename" | "strip_quotes" | "strip_prefix" | "strip_suffix"
        | "method_suffix" | "last_segment" | "first_segment" | "replace_all" | "path_resolve"
        | "split" | "relative_import_resolve"
        | "edge_attr"
        | "node_attr" => {
            if args.is_empty() {
                return (true, HashSet::new());
            }
            let out_pos = args.len() - 1;
            let inputs_bound = args[..out_pos].iter().all(|t| is_bound_or_const(t, bound));
            if inputs_bound {
                (true, provides_if_free(&args[out_pos], bound))
            } else {
                (false, HashSet::new())
            }
        }
        "resolved_import" => {
            if args.len() < 2 {
                return (true, HashSet::new());
            }
            let a0 = is_bound_or_const(&args[0], bound);
            let a1 = is_bound_or_const(&args[1], bound);
            if a0 || a1 {
                (true, free_vars(args, bound))
            } else {
                (false, HashSet::new())
            }
        }
        _ => {
            // Unknown/derived predicate — always placeable, provides all free Var args.
            (true, free_vars(args, bound))
        }
    }
}

/// The variables a placed literal binds (its free args under the current bound set), used
/// to advance the bound set as legs are emitted.
fn provided_vars(atom: &Atom, bound: &HashSet<String>) -> HashSet<String> {
    let (_, provides) = positive_can_place_and_provides(atom, bound);
    provides
}

// ── Classification helpers ─────────────────────────────────────────

/// Base relations served directly from storage (extensional). Mirrors the stratifier.
const BASE_RELATIONS: &[&str] = &["node", "type", "edge", "incoming", "attr"];

/// Builtin filters/functions shared with the query engine that consume the current row (never join legs,
/// never introduce new tuples). `path`/`parent_function`/`resolved_import` bind from
/// already-bound inputs and so are functions, not tuple-introducing generators.
fn is_filter_or_function(pred: &str) -> bool {
    matches!(
        pred,
        "neq" | "gt"
            | "lt"
            | "gte"
            | "lte"
            | "starts_with"
            | "not_starts_with"
            | "string_contains"
            | "ends_with"
            | "concat"
            | "str_lower"
            | "basename"
            | "strip_quotes"
            | "strip_prefix"
            | "strip_suffix"
            | "method_suffix"
            | "last_segment"
            | "first_segment"
            | "replace_all"
            | "path_resolve"
            // `split` introduces MULTIPLE rows from a bound string, but is a function for the
            // CROSS-JOIN guard's purposes: it derives its element rows from already-bound
            // inputs (it cannot be a Cartesian product — its subject/separator are bound, so
            // it always shares a binding) and never reads a base relation. Classifying it
            // here keeps it off the tuple-introducing path the guard polices, and its small
            // per-string fan-out is folded as a function (estimate 1) — never over-estimated
            // as a relation magnitude that would spuriously trip E-PLAN-003.
            | "split"
            | "relative_import_resolve"
            | "edge_attr"
            | "node_attr"
            | "attr"
            | "parent_function"
            | "resolved_import"
            | "path"
    )
}

/// True for predicates that introduce new tuples into the join (generators over a base
/// relation or a derived predicate). These are the legs the cross-join guard polices.
fn introduces_tuples(pred: &str) -> bool {
    !is_filter_or_function(pred)
}

/// Classify a body predicate into its [`LegSource`].
fn classify(pred: &str, strat: &Stratification, head_stratum: Option<usize>) -> LegSource {
    if let Some(s) = strat.stratum_of(pred) {
        let recursive = head_stratum == Some(s);
        return LegSource::Derived {
            name: pred.to_string(),
            recursive,
        };
    }
    if BASE_RELATIONS.contains(&pred) {
        return LegSource::Base(pred.to_string());
    }
    // Anything else that reaches the planner is a builtin (the query-engine-shared filter/function
    // set). `node`/`edge` are base; comparisons and string ops are builtins.
    LegSource::Builtin(pred.to_string())
}

/// Pick the join kind for a classified leg (spec §7).
fn pick_join(source: &LegSource, _pattern: &[ArgMode]) -> JoinKind {
    match source {
        // Filters/functions never join: they prune or bind within the current row.
        LegSource::Builtin(_) => JoinKind::None,
        // Base relations and frozen lower strata are merge-joined over sorted runs.
        LegSource::Base(_) => JoinKind::MergeOnTotal,
        LegSource::Derived { recursive, .. } => {
            if *recursive {
                JoinKind::HashOnDelta
            } else {
                JoinKind::MergeOnTotal
            }
        }
    }
}

/// Run the registry mode check for a builtin leg, mapping its `E-PLAN-001` to a
/// [`PlanError`] (the registry already names the required argument positions). Predicates
/// not present in the derive registry (query-engine-shared functions like `path`) are accepted: their
/// modes live in the query engine and are not gate-A planner-checked.
fn check_builtin_mode(name: &str, pattern: &[ArgMode], head: &str) -> PlanResult<()> {
    let Some(def) = builtin::lookup(name) else {
        // Not a derive-registered builtin; nothing to mode-check here.
        return Ok(());
    };
    // Build an ArgSpec pattern from the bind modes. `check_mode` only inspects the modes,
    // so synthesize Bound/Free arg values (slot indices are irrelevant to the check).
    let spec = synth_arg_spec(pattern);
    match def.check_mode(&spec) {
        Ok(_) => Ok(()),
        Err(e) => Err(PlanError {
            code: PlanCode::UnsupportedMode,
            head: head.to_string(),
            detail: format!(
                "builtin `{}` has no supported mode for pattern {:?}; bind positions {:?}",
                name, pattern, e.required_bindings
            ),
        }),
    }
}

/// Synthesize an [`ArgSpec`](crate::derive::builtin::ArgSpec) carrying only the bind
/// pattern, for [`BuiltinDef::check_mode`](crate::derive::builtin::BuiltinDef::check_mode).
fn synth_arg_spec(pattern: &[ArgMode]) -> builtin::ArgSpec {
    use builtin::ArgValue;
    use crate::datalog::Value;
    let args = pattern
        .iter()
        .enumerate()
        .map(|(slot, m)| match m {
            ArgMode::Bound => ArgValue::Bound(Value::Str(String::new())),
            ArgMode::Free => ArgValue::Free { slot },
        })
        .collect();
    builtin::ArgSpec::new(args)
}

// ── Cost estimation ────────────────────────────────────────────────

/// The coarse output-size estimate of a single leg (spec §7).
///
/// - A base generator with no bound key column scans the whole relation (its magnitude).
/// - A base leg with a bound key column is a narrowed scan: a small constant fan-out.
/// - A filter prunes (fan-out ≤ 1); a function binds one row (fan-out 1).
/// - A derived leg estimates against the larger relation magnitude (conservative; the run
///   stats refine this at execution time per the §7 re-plan rule).
fn leg_estimate(
    source: &LegSource,
    atom: &Atom,
    pattern: &[ArgMode],
    stats: &Stats,
    estimates: &HashMap<String, u64>,
    self_base: Option<u64>,
    facts: &FactStats,
) -> u64 {
    match source {
        LegSource::Builtin(_) => 1,
        LegSource::Base(rel) => base_estimate(rel, atom, pattern, stats),
        LegSource::Derived { name, recursive } => {
            derived_estimate(name, *recursive, atom, pattern, stats, estimates, self_base, facts)
        }
    }
}

/// The cardinality estimate of a base-relation leg under its current bind pattern (spec §7).
/// Factored out so the planner's literal ordering ([`order_literals`]) can rank candidate
/// legs by the SAME per-type / per-endpoint oracle that the per-rule guard folds in — the
/// ordering is no longer cardinality-blind. Pure function of `(rel, atom, pattern, stats)`.
fn base_estimate(rel: &str, atom: &Atom, pattern: &[ArgMode], stats: &Stats) -> u64 {
    let first_bound = pattern.first().map(|m| *m == ArgMode::Bound).unwrap_or(false);
    match rel {
        "node" | "type" => {
            // Per-type cardinality oracle (§7): a CONST type literal narrows the estimate
            // to that type's live count. When the oracle is populated, a const type ABSENT
            // from the map has zero live nodes (not "unknown") — so it estimates ~0 and the
            // planner won't over-estimate it at total_nodes and trip E-PLAN-003 (e.g.
            // node(M, "MESSAGE_TYPE") in a graph with no MESSAGE_TYPE nodes). A variable
            // type, or an empty oracle (unit tests), conservatively falls back to the whole
            // relation.
            let const_ty = atom.args().get(1).and_then(|t| t.const_value());
            let magnitude = match const_ty {
                Some(ty) if !stats.nodes_by_type.is_empty() => {
                    stats.nodes_by_type.get(ty).copied().unwrap_or(0)
                }
                _ => stats.total_nodes,
            };
            if first_bound {
                narrowed_fanout(magnitude)
            } else {
                magnitude.max(1)
            }
        }
        "edge" | "incoming" => {
            // An edge leg is keyed if EITHER endpoint is bound — storage_v2 serves both
            // get_outgoing_edges_at (bound src) and get_incoming_edges_at (bound dst), so a
            // bound destination is as cheap as a bound source, not a full relation scan.
            let endpoint_bound = pattern.first() == Some(&ArgMode::Bound)
                || pattern.get(1) == Some(&ArgMode::Bound);
            // A CONST edge type narrows the scan even with both endpoints free: storage_v2
            // serves a per-type edge index (`get_edges_by_type_at`), so `edge(_, _, "T")` is a
            // keyed scan of one type's edges, not a full relation scan. Without an endpoint
            // bound but with a const type, cost it as narrowed (parity with the per-type node
            // oracle) — otherwise an IMPORTS_FROM-driven join is mis-estimated at the WHOLE
            // edge count (every type), tripping the §3 estimate guard (observed: the stdlib
            // `depends` rule estimated at total_edges·N^½ ≈ 54M vs an actual ~1.6k IMPORTS_FROM).
            let const_type = atom.args().get(2).and_then(|t| t.const_value()).is_some();
            if endpoint_bound {
                // A bound endpoint is a per-node adjacency probe: its true fan-out is the
                // node's degree, whose sound population-level proxy is the graph's AVERAGE
                // degree (⌈E/N⌉), not √E. The √E model inflated every traversal hop ~300×
                // on the dogfood graph (920 vs ~3), and a 3-hop chain rule (method_calls
                // receiver chain) multiplied to 779M — a spurious E-PLAN-003.
                avg_degree(stats)
            } else if const_type {
                narrowed_fanout(stats.total_edges)
            } else {
                stats.total_edges.max(1)
            }
        }
        "attr" => {
            // Bound-id reader (`attr(boundId, "key", V)`) is a genuine point lookup: it reads
            // ONE node's column, so its fan-out is exactly 1 — it binds the value of a single
            // attribute, never a set. Modeling it at √N over-estimated a chain of column reads
            // as if each multiplied the result (the stdlib `depends` rule reads four `file`
            // columns and tripped the §3 estimate guard at √N⁴·edges; the true fan-out is 1).
            //
            // Free-id value-generator (`attr(X, "key", "val")`, key+value bound) is a keyed
            // index reverse-lookup (`nodes_by_attr`) on an EQUALITY — strictly more selective
            // than a key-prefix scan, so cost it as a doubly-narrowed fan-out (not √N, which is
            // the key-prefix model). This keeps a join that keys two MODULE nodes by an exact
            // `file` value (functionally ~1 module per file) from being mis-estimated as N².
            let value_bound = pattern.get(2) == Some(&ArgMode::Bound);
            let key_bound = pattern.get(1) == Some(&ArgMode::Bound);
            if first_bound {
                // Point column read: exactly one value.
                1
            } else if key_bound && value_bound {
                // Equality reverse-lookup: doubly narrowed (≈ N^¼).
                narrowed_fanout(narrowed_fanout(stats.total_nodes))
            } else {
                stats.total_nodes.max(1)
            }
        }
        _ => {
            let magnitude = stats.total_nodes.max(stats.total_edges);
            if first_bound {
                narrowed_fanout(magnitude)
            } else {
                magnitude.max(1)
            }
        }
    }
}

/// The cardinality estimate of a derived-predicate leg (a rule head).
///
/// With the [`plan_program`] stratum-bottom-up context, a non-recursive derived leg is
/// sized at ITS OWN predicate's estimated cardinality (`estimates[name]`); a RECURSIVE
/// self-leg uses the head's base-case estimate doubled (the fixpoint isn't known until it
/// runs; 2× base-case is the sound seed for the growth a closure adds per join). Only when
/// neither is available (direct `plan_rule` callers, e.g. unit tests) does it fall back to
/// the conservative whole-graph magnitude — the pre-fix behavior that spuriously tripped
/// E-PLAN-003 on recursive closures (M^1.5 with M = whole graph) and on chains of small
/// derived relations. Lowering an estimate can only let MORE rules pass the §3 guard and
/// reorder legs — never change WHICH facts a rule derives (I1).
fn derived_estimate(
    name: &str,
    recursive: bool,
    atom: &Atom,
    pattern: &[ArgMode],
    stats: &Stats,
    estimates: &HashMap<String, u64>,
    self_base: Option<u64>,
    facts: &FactStats,
) -> u64 {
    // A predicate defined entirely by ground facts is sized from the FACTS (REG-1196).
    // Its cardinality is a property of the program — `ecb_method` has 180 rows on every
    // graph — so the `k / total_nodes` model below, which stands the graph's node count in
    // for the relation's key population, is a category error on it. Live consequence: on a
    // 3-node graph `ecb_arg` probed at (Lib, Full) was sized at 152/3 = 50 instead of its
    // true ~1, and the four js feature packs compounded that into estimates of 3.5·10^8.
    if let Some(shape) = facts.shape(name) {
        return match facts.keyed_fanout(name, atom, pattern) {
            Some(fanout) => fanout,
            // No real key bound: a full scan, and here the row count is EXACT.
            None => shape.rows.max(1),
        };
    }

    let first_bound = pattern.first().map(|m| *m == ArgMode::Bound).unwrap_or(false);
    let any_bound = pattern.iter().any(|m| *m == ArgMode::Bound);
    let known = if recursive {
        // A same-stratum leg. A leg whose predicate already has a published estimate —
        // the intra-stratum overlay [`plan_program`] threads in (an earlier-planned
        // SIBLING of a storage-level SCC, or the head's own base-case partial sum) —
        // is sized at that magnitude doubled (the fixpoint growth seed). Only without
        // one does it fall to the head's base case; both beat the whole-graph
        // None-fallback whose product q-error spuriously tripped E-PLAN-003 on
        // producer-consumer chains collapsed into one stratum (W-STRAT-001).
        estimates
            .get(name)
            .copied()
            .map(|k| k.saturating_mul(2))
            .or_else(|| self_base.map(|b| b.saturating_mul(2)))
    } else {
        estimates.get(name).copied()
    };
    match known {
        Some(k) => {
            let k = k.max(1);
            if any_bound {
                // A bound column keys the probe into the derived relation; the per-key
                // fan-out proxy is its size over the graph's key population (≈ rows per
                // distinct key), floored at 1. The √K model gave a 1M-row relation a
                // fan-out of 1000 per probe and inflated keyed joins ~400×.
                (k / stats.total_nodes.max(1)).max(1)
            } else {
                k
            }
        }
        // No context (direct `plan_rule` callers): the pre-fix conservative magnitude.
        None => {
            let magnitude = stats.total_nodes.max(stats.total_edges).max(1);
            if first_bound {
                narrowed_fanout(magnitude)
            } else {
                magnitude
            }
        }
    }
}

// ── Value-universe bounds (the §3 cap, REG-1196) ───────────────────

/// No usable bound — the variable's domain is unknown, so it must not constrain the cap.
const UNBOUNDED: u64 = u64::MAX;

/// Record an upper bound on the number of DISTINCT values each variable this leg newly
/// binds can take. Only an upper bound is needed, and an over-estimate is always safe: it
/// merely loosens the cap.
fn record_domains(
    source: &LegSource,
    atom: &Atom,
    provided: &HashSet<String>,
    stats: &Stats,
    estimates: &HashMap<String, u64>,
    facts: &FactStats,
    col_domains: &HashMap<String, Vec<u64>>,
    domains: &mut HashMap<String, u64>,
    support: &mut HashMap<String, BTreeSet<String>>,
) {
    // A builtin is single-valued in its inputs, so everything it binds shares ONE support:
    // the union of its input variables' supports. `split` is the exception — it emits many
    // rows per input — so it generates freshly instead.
    let functional = matches!(source, LegSource::Builtin(name) if name != "split");
    if functional {
        let inputs: Vec<&String> = atom
            .args()
            .iter()
            .filter_map(|t| match t {
                Term::Var(v) if !provided.contains(v) => Some(v),
                _ => None,
            })
            .collect();
        let mut union: BTreeSet<String> = BTreeSet::new();
        let mut known = true;
        for v in inputs {
            match support.get(v) {
                Some(s) => union.extend(s.iter().cloned()),
                None => known = false,
            }
        }
        let domain = if known {
            union
                .iter()
                .map(|v| domains.get(v).copied().unwrap_or(UNBOUNDED))
                .fold(1u64, |acc, d| {
                    if acc == UNBOUNDED || d == UNBOUNDED { UNBOUNDED } else { acc.saturating_mul(d) }
                })
        } else {
            UNBOUNDED
        };
        for v in provided {
            domains.insert(v.clone(), domain.max(1));
            support.insert(
                v.clone(),
                if known { union.clone() } else { BTreeSet::from([v.clone()]) },
            );
        }
        return;
    }

    for (i, term) in atom.args().iter().enumerate() {
        let Term::Var(v) = term else { continue };
        if !provided.contains(v) {
            continue;
        }
        let domain = match source {
            LegSource::Base(rel) => base_column_domain(rel, atom, i, stats),
            LegSource::Derived { name, .. } => derived_column_domain(
                name, i, stats, estimates, facts, col_domains,
            ),
            // `split` and anything else non-functional generates freshly.
            LegSource::Builtin(_) => UNBOUNDED,
        };
        domains.insert(v.clone(), domain.max(1));
        // A relation column is an independent generator: it supports itself.
        support.insert(v.clone(), BTreeSet::from([v.clone()]));
    }
}

/// Upper bound on the distinct values a derived predicate's column `i` can yield.
///
/// The published per-column bound is the load-bearing one: it carries the ORIGIN of the
/// value (a node id, an attribute's value space, a registry column) up through the
/// derivation chain. Falling back to the predicate's estimated ROW COUNT — as the first cut
/// of this fix did — is circular: that row count is exactly the inflated product the cap
/// exists to bound, so the cap could never bind on the rules that need it (`res/2` stayed
/// at 1.1·10^8 on an empty graph).
fn derived_column_domain(
    name: &str,
    i: usize,
    stats: &Stats,
    estimates: &HashMap<String, u64>,
    facts: &FactStats,
    col_domains: &HashMap<String, Vec<u64>>,
) -> u64 {
    // A ground-fact column's distinct count is exact and needs no propagation.
    if let Some(shape) = facts.shape(name) {
        return shape.distinct.get(i).copied().unwrap_or(shape.rows);
    }
    // A relation of k rows carries at most k distinct values per column; the published
    // per-column bound is usually far tighter. Take the better of the two.
    let by_rows = estimates
        .get(name)
        .copied()
        .unwrap_or_else(|| whole_graph_magnitude(stats));
    match col_domains.get(name).and_then(|cols| cols.get(i)).copied() {
        Some(by_column) => by_column.min(by_rows),
        None => by_rows,
    }
}

/// Upper bound on the distinct values a base relation's column `i` can yield.
fn base_column_domain(rel: &str, atom: &Atom, i: usize, stats: &Stats) -> u64 {
    match rel {
        // (id, type): an id column is bounded by the live nodes of that type; the type
        // column by the number of distinct types the oracle knows.
        "node" | "type" => match i {
            0 => {
                let const_ty = atom.args().get(1).and_then(|t| t.const_value());
                match const_ty {
                    Some(ty) if !stats.nodes_by_type.is_empty() => {
                        stats.nodes_by_type.get(ty).copied().unwrap_or(0)
                    }
                    _ => stats.total_nodes,
                }
            }
            _ if !stats.nodes_by_type.is_empty() => stats.nodes_by_type.len() as u64,
            _ => stats.total_nodes,
        },
        // (src, dst, type): endpoints are node ids; the type column is bounded — loosely
        // but soundly — by the edge count.
        "edge" | "incoming" => match i {
            0 | 1 => stats.total_nodes,
            _ => stats.total_edges,
        },
        // (id, key, value): the id column is a node; a VALUE column holds at most one
        // value per node per key, so its distinct count is bounded by the node count. The
        // key column is unbounded by graph size (keys are a schema property) — but it is
        // never a head column in practice, so the loose node-count bound is enough.
        "attr" => stats.total_nodes,
        _ => whole_graph_magnitude(stats),
    }
}

/// The per-column domain bound of a rule head, in head-argument order. A constant column
/// holds exactly one value; a column whose variable no leg bounded is [`UNBOUNDED`].
fn head_column_domains(head: &Atom, domains: &HashMap<String, u64>) -> Vec<u64> {
    head.args()
        .iter()
        .map(|term| match term {
            Term::Const(_) | Term::Lit(_) => 1,
            Term::Wildcard => UNBOUNDED,
            Term::Var(v) => domains.get(v).copied().unwrap_or(UNBOUNDED),
        })
        .collect()
}

/// The rule head's value universe — the number of distinct rows it could possibly hold.
///
/// Computed over the union of the head variables' SUPPORTS, not over the columns
/// themselves: a `@materialize_node` head like
/// `cli_command(Sid, Name, F, Lib, M, Cid)` carries a `Sid` built by a `concat` chain out
/// of `F`, `Name` and `Cid`, so a naive per-column product squares those three and the cap
/// never binds where it is needed. Multiplying each independent generator exactly once is
/// both tighter and correct.
///
/// [`UNBOUNDED`] whenever any head column's origin is unknown — an unknown factor must
/// never be silently treated as 1, since that would UNDER-bound the cap and weaken the
/// guard.
fn head_universe(
    head: &Atom,
    domains: &HashMap<String, u64>,
    support: &HashMap<String, BTreeSet<String>>,
) -> u64 {
    let mut generators: BTreeSet<&String> = BTreeSet::new();
    for term in head.args() {
        match term {
            Term::Const(_) | Term::Lit(_) => {}
            Term::Wildcard => return UNBOUNDED,
            Term::Var(v) => match support.get(v) {
                Some(s) => generators.extend(s.iter()),
                None => return UNBOUNDED,
            },
        }
    }
    let mut product: u64 = 1;
    for g in generators {
        match domains.get(g) {
            Some(&d) if d != UNBOUNDED => product = product.saturating_mul(d),
            _ => return UNBOUNDED,
        }
    }
    product.max(1)
}

/// Fold one rule's head-column domains into the published bound for its predicate.
///
/// A predicate's rows are the UNION over its rules, so a column's distinct count is at
/// most the SUM of the per-rule counts — never the max, which would under-bound a
/// predicate whose arms draw from disjoint value spaces.
fn merge_column_domains(
    published: &mut HashMap<String, Vec<u64>>,
    pred: &str,
    head_domains: &[u64],
) {
    match published.get_mut(pred) {
        Some(existing) if existing.len() == head_domains.len() => {
            for (slot, add) in existing.iter_mut().zip(head_domains) {
                *slot = slot.saturating_add(*add);
            }
        }
        // First arm seen, or an arity disagreement the stratifier will reject anyway.
        _ => {
            published.insert(pred.to_string(), head_domains.to_vec());
        }
    }
}

/// The conservative whole-graph magnitude used wherever nothing better is known.
fn whole_graph_magnitude(stats: &Stats) -> u64 {
    stats.total_nodes.max(stats.total_edges).max(1)
}

/// The graph's average degree (⌈E/N⌉, floored at 1) — the population-level fan-out of a
/// single-node adjacency probe (a bound-endpoint `edge`/`incoming` leg).
fn avg_degree(stats: &Stats) -> u64 {
    let n = stats.total_nodes.max(1);
    stats.total_edges.div_ceil(n).max(1)
}

/// Fan-out of a key-narrowed scan: a small bounded multiplier of the relation, never zero.
/// Modeled as a square-root-ish bound so the per-rule product stays meaningful without a
/// per-key cardinality oracle (the open question Q5 in the StorageView contract).
fn narrowed_fanout(magnitude: u64) -> u64 {
    // Conservative: a bound key narrows to roughly √magnitude, floored at 1.
    let approx = (magnitude as f64).sqrt().ceil() as u64;
    approx.max(1)
}

// ── Small term/arg helpers ─────────────────────────────────────────

/// The per-argument bind pattern of an atom under the current bound set.
fn arg_pattern(atom: &Atom, bound: &HashSet<String>) -> Vec<ArgMode> {
    atom.args()
        .iter()
        .map(|t| {
            if is_bound_or_const(t, bound) {
                ArgMode::Bound
            } else {
                ArgMode::Free
            }
        })
        .collect()
}

/// Whether a positive atom shares no variable with the current bound set (cross-join test).
/// A ground atom (all constants) shares no *variable* but is not a cross-join — it is a
/// constant probe — so it is exempt.
fn shares_no_binding(atom: &Atom, bound: &HashSet<String>) -> bool {
    if bound.is_empty() {
        // NOTHING is bound yet: every preceding leg was a binding-free FILTER (a ground
        // probe / a variable-free negated leg — each multiplies the output by at most 1),
        // so this leg is the rule's FIRST generator, not a Cartesian product. Without this
        // exemption a filter was only safe in the WRITTEN order: once the cost model
        // reordered the cheap ground probe first, the generator that followed was falsely
        // rejected with E-PLAN-003 (ROFL conformance F3, live-probed:
        // `q0(X) :- p0(X), p1("c1","c2").`).
        return false;
    }
    let vars: Vec<&String> = atom
        .args()
        .iter()
        .filter_map(|t| match t {
            Term::Var(v) => Some(v),
            _ => None,
        })
        .collect();
    if vars.is_empty() {
        // Fully-ground probe: not a cross-join.
        return false;
    }
    !vars.iter().any(|v| bound.contains(*v))
}

/// A term is bound if it is a constant/wildcard or a variable already in `bound`.
fn is_bound_or_const(term: &Term, bound: &HashSet<String>) -> bool {
    match term {
        // A typed numeric literal is a ground value, like a quoted const.
        Term::Const(_) | Term::Lit(_) | Term::Wildcard => true,
        Term::Var(v) => bound.contains(v),
    }
}

/// The set `{v}` if `term` is a free (unbound) variable, else empty.
fn provides_if_free(term: &Term, bound: &HashSet<String>) -> HashSet<String> {
    let mut s = HashSet::new();
    if let Term::Var(v) = term {
        if !bound.contains(v) {
            s.insert(v.clone());
        }
    }
    s
}

/// All free Var names in `args` (variables not yet in `bound`).
fn free_vars(args: &[Term], bound: &HashSet<String>) -> HashSet<String> {
    args.iter()
        .filter_map(|t| match t {
            Term::Var(v) if !bound.contains(v) => Some(v.clone()),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datalog::{Atom, Literal, Rule, Term};
    use crate::derive::stratify::stratify;
    use crate::derive::parser_ext::parse_ext_program;

    fn stats(nodes: u64, edges: u64) -> Stats {
        Stats {
            total_nodes: nodes,
            total_edges: edges,
            ..Default::default()
        }
    }

    fn empty_strat() -> Stratification {
        Stratification {
            strata: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn v(name: &str) -> Term {
        Term::var(name)
    }

    fn c(val: &str) -> Term {
        Term::constant(val)
    }

    fn pos(pred: &str, args: Vec<Term>) -> Literal {
        Literal::positive(Atom::new(pred, args))
    }

    /// Stats with a populated per-type cardinality oracle (the §7 ordering input).
    fn stats_typed(nodes: u64, edges: u64, by_type: &[(&str, u64)]) -> Stats {
        Stats {
            total_nodes: nodes,
            total_edges: edges,
            nodes_by_type: by_type
                .iter()
                .map(|(t, n)| (t.to_string(), *n))
                .collect(),
        }
    }

    // ── bound-first reorder ─────────────────────────────────────────

    #[test]
    fn reorders_bound_first_generator_before_filter() {
        // h(X) :- gt(X, "5"), node(X, "FUNCTION").
        // `gt` needs X bound; `node` generates X. The planner must place `node` first.
        let rule = Rule::new(
            Atom::new("h", vec![v("X")]),
            vec![
                pos("gt", vec![v("X"), c("5")]),
                pos("node", vec![v("X"), c("FUNCTION")]),
            ],
        );
        let strat = empty_strat();
        let plan = plan_rule(&rule, &strat, &stats(100, 100)).expect("plan ok");
        assert_eq!(plan.legs.len(), 2);
        // First leg binds X (the node generator), second is the filter.
        assert_eq!(plan.legs[0].literal.atom().predicate(), "node");
        assert_eq!(plan.legs[1].literal.atom().predicate(), "gt");
        // The node generator binds the type column too; it is a base merge leg.
        assert_eq!(plan.legs[0].source, LegSource::Base("node".to_string()));
        assert_eq!(plan.legs[0].join, JoinKind::MergeOnTotal);
        // The filter is a no-join leg whose X arg is now bound.
        assert_eq!(plan.legs[1].join, JoinKind::None);
        assert_eq!(plan.legs[1].pattern, vec![ArgMode::Bound, ArgMode::Bound]);
    }

    // ── cardinality-aware ordering (§7 per-type oracle) ─────────────

    #[test]
    fn orders_most_selective_generator_first() {
        // h(X, Y) :- node(X, "COMMON"), node(Y, "RARE"), edge(X, Y, "CALLS").
        // Both node generators are feasible from the start (free id). With a per-type oracle
        // (COMMON: 100_000 live, RARE: 5 live) the planner must lead with the RARE generator —
        // the most selective feasible leg — NOT the syntactically-first COMMON one. The old
        // bound-arg-only tie-break was cardinality-blind and would have kept source order.
        let rule = Rule::new(
            Atom::new("h", vec![v("X"), v("Y")]),
            vec![
                pos("node", vec![v("X"), c("COMMON")]),
                pos("node", vec![v("Y"), c("RARE")]),
                pos("edge", vec![v("X"), v("Y"), c("CALLS")]),
            ],
        );
        let strat = empty_strat();
        let st = stats_typed(100_005, 100, &[("COMMON", 100_000), ("RARE", 5)]);
        let plan = plan_rule(&rule, &strat, &st).expect("plan ok");
        // The first leg is the RARE generator (lowest estimated cardinality).
        let first = &plan.legs[0];
        assert_eq!(first.literal.atom().predicate(), "node");
        assert_eq!(
            first.literal.atom().args().get(1).and_then(|t| t.const_value()),
            Some("RARE"),
            "most selective (RARE) generator must lead; got {:?}",
            first.literal
        );
    }

    #[test]
    fn cardinality_ordering_is_order_independent_i1() {
        // Same rule body, two source permutations. The cardinality-aware ordering must derive
        // the SAME ordered leg multiset (the set of literals is identical) — it changes only
        // the ORDER, never WHICH literals/facts (I1). We compare the chosen first leg: both
        // permutations must lead with the RARE generator regardless of source order.
        let st = stats_typed(100_005, 100, &[("COMMON", 100_000), ("RARE", 5)]);
        let strat = empty_strat();

        let body_ab = vec![
            pos("node", vec![v("X"), c("COMMON")]),
            pos("node", vec![v("Y"), c("RARE")]),
            pos("edge", vec![v("X"), v("Y"), c("CALLS")]),
        ];
        let body_ba = vec![
            pos("node", vec![v("Y"), c("RARE")]),
            pos("node", vec![v("X"), c("COMMON")]),
            pos("edge", vec![v("X"), v("Y"), c("CALLS")]),
        ];

        let plan_ab = plan_rule(
            &Rule::new(Atom::new("h", vec![v("X"), v("Y")]), body_ab),
            &strat,
            &st,
        )
        .expect("plan ab");
        let plan_ba = plan_rule(
            &Rule::new(Atom::new("h", vec![v("X"), v("Y")]), body_ba),
            &strat,
            &st,
        )
        .expect("plan ba");

        // The ordered predicate-with-type sequence is identical across permutations.
        let seq = |p: &RulePlan| -> Vec<(String, Option<String>)> {
            p.legs
                .iter()
                .map(|l| {
                    let a = l.literal.atom();
                    (
                        a.predicate().to_string(),
                        a.args().get(1).and_then(|t| t.const_value()).map(str::to_string),
                    )
                })
                .collect()
        };
        assert_eq!(
            seq(&plan_ab),
            seq(&plan_ba),
            "literal ordering must be independent of source clause order (I1)"
        );
    }

    // ── E-PLAN-001 via builtin mode check ───────────────────────────

    #[test]
    fn rejects_unsatisfiable_builtin_mode() {
        // h(X, T) :- node(X, T).  The query-engine feasibility rule places `node` freely (it can
        // generate both columns), but the derive registry's NODE_MODES support only
        // (Free,Bound)/(Bound,Bound)/(Bound,Free) — never (Free,Free): there is no sorted
        // run that enumerates every (id, type) pair without a bound key. The ordering
        // succeeds; the builtin mode check is the gate that rejects it → E-PLAN-001.
        let rule = Rule::new(
            Atom::new("h", vec![v("X"), v("T")]),
            vec![pos("node", vec![v("X"), v("T")])],
        );
        let strat = empty_strat();
        let err = plan_rule(&rule, &strat, &stats(10, 10)).expect_err("must reject");
        assert_eq!(err.code, PlanCode::UnsupportedMode, "{}", err);
        assert_eq!(err.code.as_str(), "E-PLAN-001");
    }

    // ── cross-join guard ────────────────────────────────────────────

    #[test]
    fn rejects_cross_join_body() {
        // h(X, Y) :- node(X, "A"), node(Y, "B").  X and Y never co-occur in any leg →
        // Cartesian product → E-PLAN-003.
        let rule = Rule::new(
            Atom::new("h", vec![v("X"), v("Y")]),
            vec![
                pos("node", vec![v("X"), c("A")]),
                pos("node", vec![v("Y"), c("B")]),
            ],
        );
        let strat = empty_strat();
        let err = plan_rule(&rule, &strat, &stats(100, 100)).expect_err("cross-join rejected");
        assert_eq!(err.code, PlanCode::GuardRejected, "{}", err);
        assert_eq!(err.code.as_str(), "E-PLAN-003");
        assert!(err.detail.contains("cross-join"), "{}", err.detail);
    }

    // ── connected body is NOT a cross-join ──────────────────────────

    #[test]
    fn connected_body_plans_clean() {
        // h(X, Y) :- node(X, "FUNCTION"), edge(X, Y, "CALLS").  Shared X → connected, so it
        // plans without the §3 cross-join rejection regardless of which leg the cost model
        // leads with. (The const-typed `edge(_,_,"CALLS")` is per-type-index-narrowed, so the
        // greedy ordering may lead with EITHER leg; the invariant under test is connectivity,
        // not a specific leg order — order is I1-free.)
        let rule = Rule::new(
            Atom::new("h", vec![v("X"), v("Y")]),
            vec![
                pos("node", vec![v("X"), c("FUNCTION")]),
                pos("edge", vec![v("X"), v("Y"), c("CALLS")]),
            ],
        );
        let strat = empty_strat();
        let plan = plan_rule(&rule, &strat, &stats(50, 50)).expect("connected plans");
        assert_eq!(plan.legs.len(), 2);

        // The body is connected: the second-placed leg shares variable X with the first, so it
        // is never a Cartesian product. Whichever leg leads, the trailing one binds against the
        // accumulated bindings (X) rather than scanning free.
        let first_vars: std::collections::HashSet<String> = plan.legs[0]
            .literal
            .atom()
            .args()
            .iter()
            .filter_map(|t| match t {
                Term::Var(name) => Some(name.clone()),
                _ => None,
            })
            .collect();
        let second = plan.legs[1].literal.atom();
        let second_shares = second.args().iter().any(|t| match t {
            Term::Var(name) => first_vars.contains(name),
            _ => false,
        });
        assert!(second_shares, "second leg must share a bound var (connected, not cross-join)");

        // The edge leg (in whatever position) merge-joins over the sorted run.
        let edge_leg = plan
            .legs
            .iter()
            .find(|l| l.literal.atom().predicate() == "edge")
            .expect("edge leg present");
        assert_eq!(edge_leg.join, JoinKind::MergeOnTotal);
    }

    // ── ground probe is a FILTER, safe in any position (ROFL F3) ────

    /// ROFL conformance F3 — a fully-ground body literal is a constant-probe FILTER
    /// (it binds nothing and multiplies the output by at most 1), so it is safe in
    /// ANY position. `shares_no_binding` exempted it only in the WRITTEN position:
    /// once the cost model reorders the cheap ground probe FIRST, the following
    /// generator saw an empty bound set and was falsely rejected as a cross-join
    /// (live-probed: `q0(X) :- p0(X), p1("c1","c2").` → E-PLAN-003).
    #[test]
    fn ground_probe_leg_is_safe_in_any_position() {
        let src = r#"
            p0("c0"). p0("c1").
            p1("c1", "c2").
            q0(X) :- p0(X), p1("c1", "c2").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        plan_program(&rules, &strat, &stats(100, 100))
            .expect("a ground probe leg must never trip the E-PLAN-003 cross-join guard");
    }

    /// F3 companion — an all-bound NEGATED leg (`\+ p3(_)`: no variables at all) is
    /// likewise a filter; when placed first it must not turn the following generator
    /// into a "cross-join" (same falsely-empty bound set as the ground-probe case).
    #[test]
    fn negated_novar_leg_first_does_not_reject_generator() {
        let src = r#"
            p0("c0").
            p3("z").
            qe(X) :- p0(X), \+ p3(_).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        plan_program(&rules, &strat, &stats(100, 100))
            .expect("a variable-free negated leg must never trip the E-PLAN-003 cross-join guard");
    }

    // ── per-rule materialization guard ──────────────────────────────

    #[test]
    fn rejects_oversized_rule_estimate() {
        // A two-hop generator join over a DENSE graph overflows the 10M guard.
        // h(X, Y, Z) :- edge(X, Y, "T"), edge(Y, Z, "T").  Connected via Y (not a cross-join,
        // valid modes — edge requires a bound type). The leading const-typed scan is
        // index-narrowed (√1e8 = 1e4); the second hop probes a bound endpoint, whose
        // fan-out is the AVERAGE DEGREE (E/N = 1e8/1e3 = 1e5 here — a deliberately dense
        // graph): 1e4 × 1e5 = 1e9 > MAX_MATERIALIZED_FACTS. (On a sparse graph — avg
        // degree ~1 — the same shape is a legitimate ~1e4-row join and must NOT be
        // rejected; the old √E-per-hop model did reject it, the q-error this guard-model
        // fix removed.)
        let rule = Rule::new(
            Atom::new("h", vec![v("X"), v("Y"), v("Z")]),
            vec![
                pos("edge", vec![v("X"), v("Y"), c("T")]),
                pos("edge", vec![v("Y"), v("Z"), c("T")]),
            ],
        );
        let strat = empty_strat();
        let err = plan_rule(&rule, &strat, &stats(1_000, 100_000_000))
            .expect_err("estimate guard fires");
        assert_eq!(err.code, PlanCode::GuardRejected, "{}", err);
        assert!(err.detail.contains("max_materialized_facts"), "{}", err.detail);
    }

    // ── recursive derived leg → hash-on-delta ───────────────────────

    #[test]
    fn recursive_leg_uses_hash_on_delta() {
        // reach(X, Y) :- edge(X, Y, "CALLS").
        // reach(X, Z) :- reach(X, Y), edge(Y, Z, "CALLS").
        // The self-referential `reach` leg sits in the same stratum → hash-on-Δ.
        let prog = parse_ext_program(
            "reach(X, Y) :- edge(X, Y, \"CALLS\").\n\
             reach(X, Z) :- reach(X, Y), edge(Y, Z, \"CALLS\").",
        )
        .expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &stats(100, 100)).expect("plan");
        // Find the recursive clause (the one whose body references `reach`).
        let recursive = plans
            .iter()
            .find(|p| p.legs.iter().any(|l| {
                matches!(&l.source, LegSource::Derived { name, .. } if name == "reach")
            }))
            .expect("recursive clause planned");
        let reach_leg = recursive
            .legs
            .iter()
            .find(|l| matches!(&l.source, LegSource::Derived { name, .. } if name == "reach"))
            .unwrap();
        match &reach_leg.source {
            LegSource::Derived { recursive, .. } => assert!(*recursive, "reach is recursive"),
            other => panic!("expected derived, got {:?}", other),
        }
        assert_eq!(reach_leg.join, JoinKind::HashOnDelta);
    }

    /// CHARACTERIZATION of the recursive-closure planner q-error (roadmap task #4, `_ai/gaps.md`).
    ///
    /// A transitive-closure rule is SPURIOUSLY rejected with E-PLAN-003 when the graph has many
    /// nodes, EVEN IF the recursive predicate's base relation is tiny. Root cause:
    /// `derived_estimate` (this file) sizes EVERY derived leg at the GLOBAL magnitude
    /// `total_nodes.max(total_edges)` — it has no per-predicate cardinality. So the recursive
    /// `reach` leg is estimated at the whole node count instead of its tiny base
    /// (a transitive closure is bounded by its base case's active domain, not |V|). On the real
    /// dogfood graph this produced `54259156 ≈ M^1.5` (M ≈ 142k = the global magnitude) for
    /// `dep_reach` despite only ~622 base `depends` pairs.
    ///
    /// Here: only 50 edges, but 50M nodes → the recursive `reach` leg is mis-sized at ~50M and
    /// the rule trips the 10M guard. The cycle/closure LOGIC is correct (proven in
    /// `derive::smoke`); this is purely the estimate.
    ///
    /// **When task #4 is fixed** (thread per-predicate cardinality, stratum-bottom-up, into
    /// `derived_estimate`; for the recursive self-leg use the base-case estimate), this rule will
    /// PLAN instead of rejecting — and THIS TEST MUST FLIP to `expect("...")` asserting success.
    /// Its failure is the reminder.
    #[test]
    fn recursive_closure_spuriously_tripped_by_global_magnitude_qerror() {
        let prog = parse_ext_program(
            "reach(X, Y) :- edge(X, Y, \"CALLS\").\n\
             reach(X, Z) :- reach(X, Y), edge(Y, Z, \"CALLS\").",
        )
        .expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        // 50 edges, 50M nodes: the base relation is tiny. The FIXED planner sizes the
        // recursive `reach` self-leg at 2× its base-case estimate (the tiny edge scan)
        // instead of the 50M global magnitude, so the closure plans fine. (This test
        // asserted the spurious E-PLAN-003 before the stratum-bottom-up estimates fix.)
        let plans = plan_program(&rules, &strat, &stats(50_000_000, 50))
            .expect("recursive closure over a tiny base relation must plan");
        assert_eq!(plans.len(), 2);
        let recursive_plan = &plans[1];
        assert!(
            recursive_plan.estimate <= 10_000_000,
            "recursive rule estimate must reflect the base-case magnitude, got {}",
            recursive_plan.estimate
        );
    }

    /// A chain of SMALL derived relations (the method_calls.dl shape: call_method →
    /// receiver_decl → resolved_method_call over a huge graph) must not be sized at the
    /// whole-graph magnitude per derived leg — that product spuriously tripped E-PLAN-003
    /// (observed: 777M on the 413k-node dogfood graph).
    #[test]
    fn derived_chain_uses_per_predicate_estimates_not_global_magnitude() {
        let prog = parse_ext_program(
            "a(X, Y) :- edge(X, Y, \"T1\").\n\
             b(X, Z) :- a(X, Y), edge(Y, Z, \"T2\").\n\
             c(X, W) :- b(X, Z), edge(Z, W, \"T3\").",
        )
        .expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &stats(50_000_000, 1_000))
            .expect("a chain of small derived relations must plan on a huge graph");
        // Each rule's estimate is bounded by its inputs' estimates, not 50M per leg.
        for p in &plans {
            assert!(
                p.estimate <= 10_000_000,
                "rule {} estimate {} must stay under the guard",
                p.head,
                p.estimate
            );
        }
    }
}
