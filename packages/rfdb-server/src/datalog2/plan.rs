//! Layer 6 — query planner.
//!
//! Reorders rule literals for bound-first feasibility (ported from v1
//! `crate::datalog::utils::reorder_literals`), applies a greedy cost ordering from
//! `StorageView` [`Stats`](crate::datalog2::builtin::Stats), and picks the join kind per
//! leg (hash join on Δ for recursive/derived legs, merge join on Total/EDB legs over the
//! sorted runs the [`StorageView`](crate::datalog2::storage_glue::StorageView) exposes).
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
//! a narrowed scan (cheap); an unbound generator is a full relation scan (its magnitude).
//! Builtins delegate to their registered [`BuiltinDef::cost`](crate::datalog2::builtin::BuiltinDef)
//! against the matched [`Mode`](crate::datalog2::builtin::Mode). The planner's running
//! output-size estimate multiplies the surviving fan-out of each placed leg; the §3 guard
//! fires when that product exceeds `MAX_MATERIALIZED_FACTS`.

use std::collections::HashSet;
use std::fmt;

use crate::datalog::{Atom, Literal, Rule, Term};

use super::builtin::{self, ArgMode, Stats};
use super::stratify::Stratification;

// ── Guard thresholds (spec §3) ─────────────────────────────────────

/// Per-rule materialization ceiling (spec §3): a rule whose plan-time output estimate
/// exceeds this is rejected with `E-PLAN-003`. Ten million facts.
pub const MAX_MATERIALIZED_FACTS: u64 = 10_000_000;

// ── Error taxonomy (invariant I5) ──────────────────────────────────

/// Stable planner error codes (spec §12). Every rejection carries one; a silently-empty
/// plan is a forbidden failure mode (I5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanCode {
    /// A builtin literal's actual binding pattern is supported by no registered mode; the
    /// named argument positions must be bound first. Mirrors
    /// [`BuiltinCode::UnsupportedMode`](crate::datalog2::builtin::BuiltinCode). Spec §7.
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
    /// A builtin filter/function shared with v1 (`neq`/`gt`/`starts_with`/…). Consumes the
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
    /// Merge join over a [`StorageView`](crate::datalog2::storage_glue::StorageView) sorted
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
    rules
        .iter()
        .map(|rule| plan_rule(rule, strat, stats))
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
    let head = rule.head().predicate().to_string();
    let head_stratum = strat.stratum_of(&head);

    let ordered = order_literals(rule.body(), &head)?;

    let mut bound: HashSet<String> = HashSet::new();
    let mut legs: Vec<PlanLeg> = Vec::with_capacity(ordered.len());
    let mut rule_estimate: u64 = 1;

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
        let estimate = leg_estimate(&source, &pattern, stats);

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

        bound.extend(provided);
        legs.push(PlanLeg {
            literal: lit.clone(),
            pattern,
            source,
            join,
            estimate,
        });
    }

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
    })
}

// ── Literal ordering: bound-first feasibility + greedy cost ────────

/// Order body literals bound-first (ported from v1 `reorder_literals`) and break ties by
/// greedy cost. At each step the candidates are the literals whose binding requirements are
/// already satisfied; among them the lowest static cost is placed first.
///
/// Returns `E-PLAN-002` if no candidate can be placed (circular feasibility) — the v1
/// engine's "circular dependency" rejection, surfaced with a stable code (I5).
fn order_literals(body: &[Literal], head: &str) -> PlanResult<Vec<Literal>> {
    let mut bound: HashSet<String> = HashSet::new();
    let mut result: Vec<Literal> = Vec::with_capacity(body.len());
    let mut remaining: Vec<Literal> = body.to_vec();

    while !remaining.is_empty() {
        // All placeable candidates under the current bindings.
        let mut best: Option<(usize, u64)> = None;
        for (i, lit) in remaining.iter().enumerate() {
            let (can_place, _) = can_place_and_provides(lit, &bound);
            if !can_place {
                continue;
            }
            let c = static_cost(lit, &bound);
            match best {
                Some((_, bc)) if c >= bc => {}
                _ => best = Some((i, c)),
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

/// A coarse static cost used only to break feasibility ties during ordering. A leg that
/// binds a key column (narrowed scan) is cheaper than an unbound full scan; filters are
/// cheapest (they only prune the current row).
fn static_cost(lit: &Literal, bound: &HashSet<String>) -> u64 {
    let atom = lit.atom();
    let pred = atom.predicate();
    if is_filter_or_function(pred) {
        return 0;
    }
    // Count already-bound argument positions; more bound = narrower = cheaper.
    let bound_args = atom
        .args()
        .iter()
        .filter(|t| is_bound_or_const(t, bound))
        .count() as u64;
    // Invert so that more bound args → lower cost. Unbound generators cost the most.
    let arity = atom.args().len() as u64;
    (arity + 1).saturating_sub(bound_args)
}

// ── Feasibility (ported from v1 utils.rs) ──────────────────────────

/// Whether a literal can be placed given the current bound set, and which new variables it
/// provides if placed. Ported from `crate::datalog::utils::literal_can_place_and_provides`
/// and specialized to the v2 builtin set; unknown predicates are derived heads (always
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
            // v2 Gate A: `attr` is a column reader/filter requiring a bound Id (matches
            // ATTR_MODES [B,B,F]/[B,B,B] and eval_attr in builtin.rs). Finding nodes by attr
            // VALUE (a generator over a value index) is deferred — so attr is only placeable
            // once its Id is bound by a preceding generator (e.g. node(X,T)). This keeps the
            // feasibility layer in sync with the registry, which has no [Free,Bound,Bound]
            // mode (was: E-PLAN-001 on switch-has-cases / if-has-consequent when the planner
            // tried to place attr first as a generator).
            if id_ok && name_ok {
                (true, provides_if_free(&args[2], bound))
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
        | "string_contains" => {
            let all_bound = args.iter().all(|t| match t {
                Term::Var(v) => bound.contains(v),
                _ => true,
            });
            (all_bound, HashSet::new())
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

/// Builtin filters/functions shared with v1 that consume the current row (never join legs,
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
    // Anything else that reaches the planner is a builtin (the v1-shared filter/function
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
/// not present in the v2 registry (v1-shared functions like `path`) are accepted: their
/// modes live in the v1 engine and are not gate-A planner-checked.
fn check_builtin_mode(name: &str, pattern: &[ArgMode], head: &str) -> PlanResult<()> {
    let Some(def) = builtin::lookup(name) else {
        // Not a v2-registered builtin; nothing to mode-check here.
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

/// Synthesize an [`ArgSpec`](crate::datalog2::builtin::ArgSpec) carrying only the bind
/// pattern, for [`BuiltinDef::check_mode`](crate::datalog2::builtin::BuiltinDef::check_mode).
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
fn leg_estimate(source: &LegSource, pattern: &[ArgMode], stats: &Stats) -> u64 {
    let has_bound_key = pattern.first().map(|m| *m == ArgMode::Bound).unwrap_or(false);
    match source {
        LegSource::Builtin(_) => 1,
        LegSource::Base(rel) => {
            let magnitude = match rel.as_str() {
                "node" | "type" | "attr" => stats.total_nodes,
                "edge" | "incoming" => stats.total_edges,
                _ => stats.total_nodes.max(stats.total_edges),
            };
            if has_bound_key {
                // Narrowed by a bound key column: a bounded fan-out per probe.
                narrowed_fanout(magnitude)
            } else {
                magnitude.max(1)
            }
        }
        LegSource::Derived { .. } => {
            let magnitude = stats.total_nodes.max(stats.total_edges);
            if has_bound_key {
                narrowed_fanout(magnitude)
            } else {
                magnitude.max(1)
            }
        }
    }
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
        Term::Const(_) | Term::Wildcard => true,
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
    use crate::datalog2::stratify::stratify;
    use crate::datalog2::parser_ext::parse_ext_program;

    fn stats(nodes: u64, edges: u64) -> Stats {
        Stats {
            total_nodes: nodes,
            total_edges: edges,
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

    // ── E-PLAN-001 via builtin mode check ───────────────────────────

    #[test]
    fn rejects_unsatisfiable_builtin_mode() {
        // h(X, T) :- node(X, T).  The v1 feasibility rule places `node` freely (it can
        // generate both columns), but the v2 registry's NODE_MODES support only
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
        // h(X, Y) :- node(X, "FUNCTION"), edge(X, Y, "CALLS").  Shared X → connected.
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
        // edge's src is now bound by node → forward-narrowed, merge leg.
        let edge_leg = &plan.legs[1];
        assert_eq!(edge_leg.literal.atom().predicate(), "edge");
        assert_eq!(edge_leg.pattern[0], ArgMode::Bound); // src bound
        assert_eq!(edge_leg.join, JoinKind::MergeOnTotal);
    }

    // ── per-rule materialization guard ──────────────────────────────

    #[test]
    fn rejects_oversized_rule_estimate() {
        // Two unbound full-relation generators over a huge relation overflow the 10M guard.
        // h(X, Y) :- node(X, "A"), edge(X, Y, "T").  node scans all nodes; edge then
        // narrows by X, but with 1e8 nodes the product crosses MAX_MATERIALIZED_FACTS.
        let rule = Rule::new(
            Atom::new("h", vec![v("X"), v("Y")]),
            vec![
                pos("node", vec![v("X"), c("A")]),
                pos("edge", vec![v("X"), v("Y"), c("T")]),
            ],
        );
        let strat = empty_strat();
        let err = plan_rule(&rule, &strat, &stats(100_000_000, 100_000_000))
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
}
