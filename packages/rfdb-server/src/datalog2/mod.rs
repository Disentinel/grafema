//! Datalog v2 engine — Gate A core (semi-naive, on real `storage_v2`).
//!
//! This engine sits BESIDE the v1 top-down engine in `crate::datalog` and does not
//! alter its behavior. It is a bottom-up, semi-naive fixpoint evaluator pinned to a
//! version-stable `storage_v2::ReadSnapshot`, sharing v1's `Value`, parser, builtin
//! bodies, `GraphStore` access, and `EvalLimits`.
//!
//! # Gate A scope
//!
//! Gate A implements the BoolTag core over the locked `StorageView` contract:
//! base predicates as views over node/edge column families, transient derived
//! predicates in RAM, `@materialize` predicates projected to edges/nodes, semi-naive
//! Δ-loop with hash/merge joins over sorted runs, stratified negation, and an
//! always-on `events.jsonl` decision log. Count/Conf/Product tags, lattices, the EDB
//! Differ, `why()`, `sim()`, and `@materialize` write-back are explicitly deferred to
//! later gates (B/C/E).
//!
//! # Module DAG
//!
//! Lower layers compile and pass their invariant checks before higher layers fan out:
//!
//! - [`tag`] (0) — `Sealed`/`Tag`/`InvertibleTag`/`IdempotentTag` traits; `BoolTag`.
//! - [`value`] (1) — reuse v1 `Value`; `Fact`, `Row`, deterministic `fact_id`.
//! - [`storage_glue`] (2) — `StorageView` trait + real-LSM impl over `ReadSnapshot`
//!   plus an in-memory fixture impl.
//! - [`parser_ext`] (3) — extend the v1 parser for Appendix-A annotations and rules.
//! - [`stratify`] (4) — predicate dependency graph, SCC condensation, negation gating.
//! - [`builtin`] (5) — `BuiltinDef` registry; ported v1 eval bodies with modes + cost.
//! - [`plan`] (6) — literal reorder, greedy cost from stats, join-kind selection, guards.
//! - [`exec`] (7) — semi-naive fixpoint executor with `EvalLimits` per stratum.
//! - [`events`] (8) — always-on `events.jsonl` decision and counter log.
//!
//! The crate-level entry point (single eval entry, router behind `RFDB_DATALOG_V2`)
//! is wired in this module once the layers above are in place.

pub mod tag;
pub mod value;
pub mod storage_glue;
pub mod parser_ext;
pub mod stratify;
pub mod builtin;
pub mod plan;
pub mod exec;
pub mod events;

#[cfg(test)]
mod differential;

use crate::datalog::EvalLimits;

use builtin::Stats;
use events::EventLog;
use exec::{DEFAULT_ITERATION_CAP, Evaluation, ExecError, Executor};
use parser_ext::{parse_ext_program, ExtParseError};
use plan::{plan_program, PlanError};
use storage_glue::StorageView;
use stratify::{stratify, StratError};
use tag::BoolTag;

// ── The single eval entry (invariant I8) ───────────────────────────

/// A rejection from any stage of the one eval pipeline.
///
/// Each variant carries the originating stage's coded error verbatim (every one of which
/// owns a stable `E-…` taxonomy code, invariant I5), so a caller can recover the exact
/// failure point and code without the entry reinterpreting it. There is exactly one eval
/// entry ([`evaluate`]) and therefore exactly one place these are produced (I8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvalError {
    /// The Appendix-A subset parser rejected the source (`E-PARSE-…`).
    Parse(ExtParseError),
    /// The stratifier rejected the program (`E-STRAT-…`, e.g. negation inside an SCC).
    Stratify(StratError),
    /// The planner rejected a rule (`E-PLAN-…`, e.g. an unsupported binding mode or a
    /// guard violation).
    Plan(PlanError),
    /// The fixpoint executor aborted (`E-EXEC-…`, e.g. an iteration cap or a limit ceiling).
    Exec(ExecError),
}

impl EvalError {
    /// The stable taxonomy code of the underlying stage error (the load-bearing field;
    /// the surrounding text is only a hint).
    pub fn code(&self) -> &str {
        match self {
            EvalError::Parse(e) => e.code.as_str(),
            EvalError::Stratify(e) => e.code.as_str(),
            EvalError::Plan(e) => e.code.as_str(),
            EvalError::Exec(e) => e.code.as_str(),
        }
    }
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EvalError::Parse(e) => write!(f, "parse: {e}"),
            EvalError::Stratify(e) => write!(f, "stratify: {e}"),
            EvalError::Plan(e) => write!(f, "plan: {e}"),
            EvalError::Exec(e) => write!(f, "exec: {e}"),
        }
    }
}

impl std::error::Error for EvalError {}

impl From<ExtParseError> for EvalError {
    fn from(e: ExtParseError) -> Self {
        EvalError::Parse(e)
    }
}
impl From<StratError> for EvalError {
    fn from(e: StratError) -> Self {
        EvalError::Stratify(e)
    }
}
impl From<PlanError> for EvalError {
    fn from(e: PlanError) -> Self {
        EvalError::Plan(e)
    }
}
impl From<ExecError> for EvalError {
    fn from(e: ExecError) -> Self {
        EvalError::Exec(e)
    }
}

/// Evaluate a Datalog v2 program against a [`StorageView`] — THE single eval entry (I8).
///
/// One linear pipeline, no fork for explain: parse the Appendix-A subset
/// ([`parse_ext_program`]) → stratify ([`stratify`]) → plan every rule
/// ([`plan_program`]) → run the semi-naive fixpoint ([`Executor::evaluate`]), emitting
/// decisions and counters into `events` along the way. Explain is a *recording* of this
/// same run (the caller installs an [`EventLog`] sink and reads the captured events);
/// there is deliberately no separate explain path.
///
/// `stats` carries the snapshot's relation magnitudes for the planner's cost model;
/// `limits` are the per-stratum [`EvalLimits`] (intermediate-result ceiling + deadline).
/// `events` is the always-on event log — pass [`EventLog::discard`] for the zero-cost
/// variant or [`EventLog::with_sink`] to capture the decision trace.
///
/// Returns the committed [`Evaluation`] (every derived predicate's ground facts) or the
/// first stage rejection ([`EvalError`], every variant carrying a stable code, I5).
pub(crate) fn evaluate(
    view: &dyn StorageView,
    source: &str,
    stats: Stats,
    limits: EvalLimits,
    events: EventLog,
) -> Result<Evaluation, EvalError> {
    let program = parse_ext_program(source)?;
    let strat = stratify(&program)?;
    let rules = program.rules();
    let plans = plan_program(&rules, &strat, &stats)?;
    let executor = Executor::<BoolTag>::with_limits(view, limits, DEFAULT_ITERATION_CAP)
        .with_events(events);
    let evaluation = executor.evaluate(&plans, &rules, &strat)?;
    Ok(evaluation)
}

// ── Router note: the `RFDB_DATALOG_V2` kill switch (P3) ─────────────
//
// The v2 engine ships behind a kill switch and does NOT yet replace the v1 top-down
// engine. When the server-side dispatch is wired, it branches in `src/bin/rfdb_server.rs`
// at the two datalog request handlers — `Request::DatalogQuery` (calls
// `execute_datalog_query`) and `Request::ExecuteDatalog` (calls `execute_datalog`),
// `src/bin/rfdb_server.rs:1601` / `:1612`. The branch reads the `RFDB_DATALOG_V2`
// environment variable: when set to `off` (or unset, during rollout) the request flows to
// the existing v1 path UNCHANGED (the default, so the v1 behavior is never disturbed);
// when set to `on` the handler captures a version-pinned view via
// `storage_glue::LsmStorageView::capture(store, manifest)` and routes the query through
// this [`evaluate`] entry. The switch is read at dispatch (not cached at startup) so it can
// flip per request during validation. This module intentionally does not perform the env
// read itself: the entry stays a pure function of its arguments (deterministic, I1), and
// the routing decision lives at the dispatch boundary alongside the v1 call it guards.

// ── Smoke test: end-to-end entry over the in-memory fixture ─────────

#[cfg(test)]
mod smoke {
    use super::*;
    use crate::datalog2::events::{EventLog, SharedMemSink};
    use crate::datalog2::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
    use crate::datalog::Value;

    /// Canonical u128 id derivation (identical to the writer / fixture).
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

    /// The single eval entry, parse→stratify→plan→exec, must flag exactly the orphan
    /// FUNCTION: a function node with NO incoming CONTAINS edge. `fnA` is contained by a
    /// CLASS (has a CONTAINS edge into it); `fnB` is orphaned (no CONTAINS into it). The
    /// negated base leg `\+ edge(_, X, "CONTAINS")` is the stratified anti-join.
    #[test]
    fn orphan_function_via_entry() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "cls", "CLASS");
        node(&mut v, "fnA", "FUNCTION");
        node(&mut v, "fnB", "FUNCTION");
        edge(&mut v, "cls", "fnA", "CONTAINS"); // fnA IS contained; fnB is the orphan.

        let src = r#"violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS")."#;

        let stats = Stats {
            total_nodes: 3,
            total_edges: 1,
            ..Default::default()
        };
        let sink = SharedMemSink::new();
        let eval = evaluate(
            &v,
            src,
            stats,
            EvalLimits::none(),
            EventLog::with_sink(Box::new(sink.clone())),
        )
        .expect("evaluate");

        // Exactly the orphan FUNCTION (fnB) is flagged.
        let mut flagged: Vec<u128> = eval
            .facts("violation")
            .iter()
            .map(|row| match &row[0] {
                Value::Id(id) => *id,
                Value::Str(s) => s.parse().expect("id column"),
            })
            .collect();
        flagged.sort_unstable();
        assert_eq!(
            flagged,
            vec![id_of("fnB")],
            "only the FUNCTION without an incoming CONTAINS edge is a violation"
        );

        // The single entry emitted a decision trace (explain is a recording of this run).
        assert!(
            !sink.events().is_empty(),
            "the eval entry must emit events (I9: the log is the source of truth)"
        );
    }
}
