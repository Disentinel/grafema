//! The derive engine — Gate A core (semi-naive, on real `storage_v2`).
//!
//! This engine sits BESIDE the query (top-down) engine in `crate::datalog` and does not
//! alter its behavior. It is a bottom-up, semi-naive fixpoint evaluator pinned to a
//! version-stable `storage_v2::ReadSnapshot`, sharing the query engine's `Value`, parser, builtin
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
//! - [`value`] (1) — reuse the query engine's `Value`; `Fact`, `Row`, deterministic `fact_id`.
//! - [`storage_glue`] (2) — `StorageView` trait + real-LSM impl over `ReadSnapshot`
//!   plus an in-memory fixture impl.
//! - [`parser_ext`] (3) — extend the query-engine parser for Appendix-A annotations and rules.
//! - [`stratify`] (4) — predicate dependency graph, SCC condensation, negation gating.
//! - [`builtin`] (5) — `BuiltinDef` registry; ported query-engine eval bodies with modes + cost.
//! - [`plan`] (6) — literal reorder, greedy cost from stats, join-kind selection, guards.
//! - [`exec`] (7) — semi-naive fixpoint executor with `EvalLimits` per stratum.
//! - [`events`] (8) — always-on `events.jsonl` decision and counter log.
//!
//! The crate-level entry point (single eval entry, router behind `RFDB_DERIVE_ENGINE`)
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
pub mod materialize;
pub mod pin_sidecar;
pub mod binding;
pub mod increment;
pub mod stdlib;

#[cfg(test)]
mod differential;

use crate::datalog::EvalLimits;

use binding::{BindingConflict, BindingTable};
use builtin::Stats;
use events::EventLog;
use exec::{DEFAULT_ITERATION_CAP, Evaluation, ExecError, Executor};
use materialize::{
    collect_materialize_node_specs, collect_materialize_specs, MaterializeError,
    MaterializeSpec, NodeMaterializeSpec,
};
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
    /// The `@materialize` write-back planner rejected a directive (`E-MAT-…`, e.g. a
    /// non-binary materialized head or a missing `edge_type=`). Raised on the write-back
    /// path *before* any commit, so a rejection leaves the prior generation intact.
    Materialize(MaterializeError),
    /// The predicate binding table rejected the program (`E-BIND-…`, §9.3): one predicate
    /// bound to two semirings or two arities. Raised after parse, before the fixpoint, so a
    /// malformed program aborts before any derivation or commit.
    Binding(BindingConflict),
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
            EvalError::Materialize(e) => e.code,
            EvalError::Binding(e) => e.code,
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
            EvalError::Materialize(e) => write!(f, "materialize: {e}"),
            EvalError::Binding(e) => write!(f, "binding: {e}"),
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
impl From<MaterializeError> for EvalError {
    fn from(e: MaterializeError) -> Self {
        EvalError::Materialize(e)
    }
}
impl From<BindingConflict> for EvalError {
    fn from(e: BindingConflict) -> Self {
        EvalError::Binding(e)
    }
}

/// Evaluate a derive program against a [`StorageView`] — THE single eval entry (I8).
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
    let (evaluation, _specs, _node_specs) =
        evaluate_with_materialize(view, source, stats, limits, events)?;
    Ok(evaluation)
}

/// Evaluate a program AND surface its `@materialize` / `@materialize_node` write-back
/// plans — the entry the derive write-back path uses.
///
/// Runs the identical single pipeline as [`evaluate`] (parse → stratify → plan → fixpoint;
/// I8 — there is no second eval path) and, after the fixpoint commits, collects the
/// program's `@materialize(edge_type="T")` directives into [`MaterializeSpec`]s and its
/// `@materialize_node(node_type="T")` directives into [`NodeMaterializeSpec`]s (each with
/// the stable [`materialize::rule_ast_hash`] provenance stamp). The *projection* of those
/// specs to graph edges/nodes and the single atomic commit are the engine adapter's job:
/// this entry stays a pure function of its arguments (no storage write, I1/I10). A
/// malformed directive (`E-MAT-001` missing `edge_type=`, `E-MAT-008` missing
/// `node_type=`, `E-MAT-006` unknown mode, `E-MAT-011` both directives on one rule) is
/// rejected here before the caller commits anything.
pub(crate) fn evaluate_with_materialize(
    view: &dyn StorageView,
    source: &str,
    stats: Stats,
    limits: EvalLimits,
    events: EventLog,
) -> Result<(Evaluation, Vec<MaterializeSpec>, Vec<NodeMaterializeSpec>), EvalError> {
    evaluate_with_materialize_shared(view, source, stats, limits, events, None)
}

/// [`evaluate_with_materialize`] with an optional cross-evaluation shared index cache
/// (W9 fix #1): when `shared` is `Some`, the executor seeds its Part-A build-once
/// indexes from entries previous evaluations built at the SAME `view.generation()` and
/// absorbs its own builds back on success. Pass `None` for the byte-identical unshared
/// behavior — index reuse never changes the committed result (the seeded index is the
/// same pure function of (key, view) the executor would have built itself).
pub(crate) fn evaluate_with_materialize_shared(
    view: &dyn StorageView,
    source: &str,
    stats: Stats,
    limits: EvalLimits,
    events: EventLog,
    shared: Option<&crate::derive::exec::SharedIndexCaches>,
) -> Result<(Evaluation, Vec<MaterializeSpec>, Vec<NodeMaterializeSpec>), EvalError> {
    let program = parse_ext_program(source)?;
    // §9.3 binding gate: pin one (semiring_id, arity) per predicate before any derivation,
    // so a malformed program aborts before the fixpoint and before any commit. Uniform
    // `BoolTag` at this gate (the executor is monomorphic); the table also seeds the diff()
    // seam Gate C's increment machinery consumes. Built but not yet persisted (no prior-run
    // reader exists until increments land — I10).
    let _bindings =
        BindingTable::from_program(&program, crate::storage_v2::types::BOOLTAG_SEMIRING_ID)?;
    let strat = stratify(&program)?;
    let rules = program.rules();
    let plans = plan_program(&rules, &strat, &stats)?;
    let mut executor = Executor::<BoolTag>::with_limits(view, limits, DEFAULT_ITERATION_CAP)
        .with_events(events);
    if let Some(shared) = shared {
        executor = executor.with_shared_caches(shared);
    }
    let evaluation = executor.evaluate(&plans, &rules, &strat)?;
    let specs = collect_materialize_specs(&program)?;
    let node_specs = collect_materialize_node_specs(&program)?;
    Ok((evaluation, specs, node_specs))
}

// ── Router note: the `RFDB_DERIVE_ENGINE` kill switch (P3) ─────────────
//
// Since Final #12 the derive engine IS the default. The server-side dispatch branches in
// `src/bin/rfdb_server.rs` at the datalog request handlers (`dispatch_datalog_query` /
// `dispatch_execute_datalog` / `dispatch_check_guarantee`). The branch reads the
// `RFDB_DERIVE_ENGINE` environment variable: unset (or any value other than `off`) routes
// through this [`evaluate`] entry over a version-pinned view captured via
// `storage_glue::LsmStorageView::capture(store, manifest)`; the explicit off-switch
// `RFDB_DERIVE_ENGINE=off` selects the query (top-down) engine (kept as the rollback path and
// as the explain provider — explain requests are query-engine-served under every switch state
// until the derive explain recording→wire mapping lands). The switch is read at dispatch
// (not cached at startup) so it can flip per request during validation. This module
// intentionally does not perform the env read itself: the entry stays a pure function
// of its arguments (deterministic, I1), and the routing decision lives at the dispatch
// boundary alongside the query-engine call it guards.

// ── Smoke test: end-to-end entry over the in-memory fixture ─────────

#[cfg(test)]
mod smoke {
    use super::*;
    use crate::derive::events::{EventLog, SharedMemSink};
    use crate::derive::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
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
            .map(|row| row[0].as_id().expect("id column"))
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

    /// Cross-artifact value-join PoC (`semantic-graph-as-abstract-interpretation.md` §9, iter 1).
    /// A frontend `HTTP_REQUEST` and a backend `http:route` carrying the SAME path (here in the
    /// `name` column — the exact-match value-domain) `link` ACROSS artifacts, derived by one rule
    /// joining on the shared path value. This is the smallest proof that the derive engine derives a
    /// cross-artifact `link(client, backend)` join — without any rewrite/string builtins (the nginx
    /// prefix-rewrite congruence is iter 2). A path with a client but no backend route (`/orders`)
    /// or a route with no client (`/health`) does NOT link — that asymmetry is the coverage signal.
    #[test]
    fn cross_artifact_link_on_shared_path() {
        // Build a NodeRow whose `name` carries the path-key (id_of is a fn, captures nothing).
        let n = |sid: &str, ty: &str, path: &str, file: &str| NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: path.to_string(),
            file: file.to_string(),
        };
        let mut v = FixtureStorageView::new(1);
        // Frontend: two outgoing HTTP requests.
        v.put_node(n("fe:req:/users", "HTTP_REQUEST", "/users", "web/api.js"));
        v.put_node(n("fe:req:/orders", "HTTP_REQUEST", "/orders", "web/api.js"));
        // Backend: routes. /users is served; /orders is NOT (a real coverage hole); /health has
        // no client.
        v.put_node(n("be:route:/users", "http:route", "/users", "api/users.js"));
        v.put_node(n("be:route:/health", "http:route", "/health", "api/health.js"));

        // link(C,B): a client request and a backend route sharing the path value-domain key.
        let src = r#"link(C, B) :- node(C, "HTTP_REQUEST"), attr(C, "name", P),
                                   node(B, "http:route"),    attr(B, "name", P)."#;
        let stats = Stats { total_nodes: 4, total_edges: 0, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");

        let links: std::collections::HashSet<(u128, u128)> = eval
            .facts("link")
            .iter()
            .map(|r| {
                (
                    r[0].as_id().expect("client id"),
                    r[1].as_id().expect("backend id"),
                )
            })
            .collect();
        assert_eq!(
            links,
            [(id_of("fe:req:/users"), id_of("be:route:/users"))]
                .into_iter()
                .collect(),
            "exactly the shared-path pair links across artifacts; /orders (no backend) and \
             /health (no client) do not"
        );
    }

    /// Cross-artifact link() PoC iter 2 (apparatus doc §4–§5): the THREE-artifact chain
    /// frontend → nginx → backend. The client path `/api/users` does NOT equal the backend path
    /// `/users` — nginx rewrote it. Per the declarative-source-plugin model, the nginx extractor
    /// RESOLVES the rewrite into facts (an `nginx:route` node carrying the external path + a
    /// `PROXIES_TO` edge to the backend route), so the cross-artifact join stays pure Datalog with
    /// NO string builtins. This proves the chain composes across frontend code + nginx config +
    /// backend code, and that without the nginx hop the differing strings would not link.
    #[test]
    fn cross_artifact_link_through_nginx_rewrite() {
        let n = |sid: &str, ty: &str, path: &str, file: &str| NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: path.to_string(),
            file: file.to_string(),
        };
        let mut v = FixtureStorageView::new(1);
        // Frontend calls the EXTERNAL path (what the browser hits).
        v.put_node(n("fe:req", "HTTP_REQUEST", "/api/users", "web/api.js"));
        // nginx (declarative source): the extractor resolved `location /api/ { proxy_pass …/ }`
        // into an nginx:route carrying the external path + a PROXIES_TO edge to the backend route.
        v.put_node(n("nginx:/api/users", "nginx:route", "/api/users", "infra/nginx.conf"));
        // Backend exposes the INTERNAL (rewritten) path.
        v.put_node(n("be:route", "http:route", "/users", "api/users.js"));
        v.put_edge(EdgeRow {
            src: id_of("nginx:/api/users"),
            dst: id_of("be:route"),
            edge_type: "PROXIES_TO".to_string(),
        });

        // The 3-artifact chain: client external path = nginx external path; nginx PROXIES_TO backend.
        let src = r#"link(C, B) :- node(C, "HTTP_REQUEST"), attr(C, "name", P),
                                   node(N, "nginx:route"),   attr(N, "name", P),
                                   edge(N, B, "PROXIES_TO"),  node(B, "http:route")."#;
        let stats = Stats { total_nodes: 3, total_edges: 1, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");
        let links: std::collections::HashSet<(u128, u128)> = eval
            .facts("link")
            .iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap()))
            .collect();
        assert_eq!(
            links,
            [(id_of("fe:req"), id_of("be:route"))].into_iter().collect(),
            "the frontend request links to the backend route THROUGH the nginx rewrite, \
             across all three artifacts"
        );

        // Sanity: the naive exact-path join (no nginx hop) would NOT link — the strings differ.
        let naive = r#"link(C, B) :- node(C, "HTTP_REQUEST"), attr(C, "name", P),
                                     node(B, "http:route"),    attr(B, "name", P)."#;
        let eval2 = evaluate(
            &v,
            naive,
            Stats { total_nodes: 3, total_edges: 1, ..Default::default() },
            EvalLimits::none(),
            EventLog::discard(),
        )
        .expect("evaluate");
        assert!(
            eval2.facts("link").is_empty(),
            "without the nginx rewrite hop, /api/users ≠ /users → no link (why nginx matters)"
        );
    }

    /// Cross-artifact link() PoC iter 3 (apparatus doc §6): COVERAGE as a query. The product-
    /// visible form of "coverage = what does NOT link" — the uncovered client requests are
    /// themselves a derivable relation via stratified negation over the link chain. A client call
    /// whose path has no nginx route (missing config = a real coverage hole) is flagged. This is
    /// the concrete, today-expressible shape of the demand-diff/why-not gap: the dark frontend
    /// calls surface as facts, each naming the request whose backend is unknown.
    #[test]
    fn coverage_gap_uncovered_client_request_via_negation() {
        let n = |sid: &str, ty: &str, path: &str, file: &str| NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: path.to_string(),
            file: file.to_string(),
        };
        let mut v = FixtureStorageView::new(1);
        // Covered: /api/users has the full frontend → nginx → backend chain.
        v.put_node(n("fe:users", "HTTP_REQUEST", "/api/users", "web/api.js"));
        v.put_node(n("nginx:users", "nginx:route", "/api/users", "infra/nginx.conf"));
        v.put_node(n("be:users", "http:route", "/users", "api/users.js"));
        v.put_edge(EdgeRow {
            src: id_of("nginx:users"),
            dst: id_of("be:users"),
            edge_type: "PROXIES_TO".to_string(),
        });
        // UNCOVERED: the frontend calls /api/ghost, but no nginx route handles it (missing config).
        v.put_node(n("fe:ghost", "HTTP_REQUEST", "/api/ghost", "web/api.js"));

        // covered(C) iff the cross-artifact chain links; uncovered(C) is the stratified anti-join.
        let src = r#"covered(C) :- node(C, "HTTP_REQUEST"), attr(C, "name", P),
                                   node(N, "nginx:route"),   attr(N, "name", P),
                                   edge(N, B, "PROXIES_TO"),  node(B, "http:route").
                     uncovered(C) :- node(C, "HTTP_REQUEST"), \+ covered(C)."#;
        let stats = Stats { total_nodes: 4, total_edges: 1, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");

        let mut uncovered: Vec<u128> = eval
            .facts("uncovered")
            .iter()
            .map(|r| r[0].as_id().unwrap())
            .collect();
        uncovered.sort_unstable();
        assert_eq!(
            uncovered,
            vec![id_of("fe:ghost")],
            "exactly the client request whose path has no backend route is a coverage gap"
        );
    }

    /// Cross-artifact link() PoC iter 4 (apparatus doc §2 — the value-domain's equality theory as a
    /// DERIVED CONGRUENCE, the points-to branch). A frontend and a backend reference an endpoint by
    /// DIFFERENT aliases (`ep_a` vs `ep_c`); they still link because the aliases are in the same
    /// equivalence class — computed by a recursive symmetric-transitive closure `same/2`, NOT by
    /// exact string match. This is "comparability is itself computed by a program" (a recursive
    /// Datalog rule), the third value-domain implementation alongside iter1 (exact canon key) and
    /// iter2 (extractor-resolved rewrite). The unaliased endpoint `ep_d` does NOT link.
    #[test]
    fn cross_artifact_link_via_derived_alias_congruence() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "fe", "HTTP_REQUEST");
        node(&mut v, "be", "http:route");
        node(&mut v, "be2", "http:route");
        for ep in ["ep_a", "ep_b", "ep_c", "ep_d"] {
            node(&mut v, ep, "endpoint");
        }
        // fe refers ep_a; be refers ep_c; be2 refers the unaliased ep_d.
        edge(&mut v, "fe", "ep_a", "REFERS");
        edge(&mut v, "be", "ep_c", "REFERS");
        edge(&mut v, "be2", "ep_d", "REFERS");
        // Alias chain ep_a — ep_b — ep_c (so ep_a ≡ ep_c via closure). ep_d is alone.
        edge(&mut v, "ep_a", "ep_b", "ALIASES");
        edge(&mut v, "ep_b", "ep_c", "ALIASES");

        // same/2 = the derived congruence (symmetric base + transitive recursion, BoolTag-idempotent).
        // link follows it instead of an exact key, so differently-aliased references still join.
        let src = r#"same(X, Y) :- edge(X, Y, "ALIASES").
                     same(X, Y) :- edge(Y, X, "ALIASES").
                     same(X, Z) :- same(X, Y), same(Y, Z).
                     link(F, B) :- node(F, "HTTP_REQUEST"), edge(F, E1, "REFERS"),
                                   node(B, "http:route"),    edge(B, E2, "REFERS"),
                                   same(E1, E2)."#;
        let stats = Stats { total_nodes: 7, total_edges: 5, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");
        let links: std::collections::HashSet<(u128, u128)> = eval
            .facts("link")
            .iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap()))
            .collect();
        assert_eq!(
            links,
            [(id_of("fe"), id_of("be"))].into_iter().collect(),
            "fe and be link via the derived alias equivalence class (ep_a ≡ ep_c); the unaliased \
             be2/ep_d does not — comparability computed by a recursive rule, not exact match"
        );
    }

    /// Library-semantics as a Datalog rule (apparatus doc §3 — the plugin molecule / "rules instead
    /// of an imperative enricher"). `effects-db/packages/express.yaml` declares `Application.get(path,
    /// handler)`: arg0 = ROUTE_PATH, arg1 = ENTRY_POINT_CALLBACK → materialize HANDLES. This is the
    /// libraryCallbackEnricher's job expressed as ONE rule: a `HANDLES(route, handler)` derivation
    /// from a recognized express route registration. The extractor's positional→role arg mapping
    /// (the dirty part) is represented here as role-typed edges `ARG_ROUTE_PATH`/`ARG_ENTRY_POINT_CALLBACK`
    /// (per §3: arg-role resolution lives in the extractor/facts; the SEMANTICS live in the rule). A
    /// non-express call does NOT produce HANDLES. (`@materialize` write-back is tested separately;
    /// here we prove the RULE derives the right (route, handler) pairs.)
    #[test]
    fn library_semantics_express_route_as_rule() {
        let mut v = FixtureStorageView::new(1);
        // app.get("/users", usersHandler) — a recognized express route registration. The CALL's
        // `name` carries the callee; the path LITERAL's `name` carries the route string.
        v.put_node(NodeRow {
            id: id_of("c1"),
            node_type: "CALL".to_string(),
            name: "app.get".to_string(),
            file: "web/server.js".to_string(),
        });
        v.put_node(NodeRow {
            id: id_of("p_users"),
            node_type: "LITERAL".to_string(),
            name: "/users".to_string(),
            file: "web/server.js".to_string(),
        });
        node(&mut v, "usersHandler", "FUNCTION");
        edge(&mut v, "c1", "p_users", "ARG_ROUTE_PATH");
        edge(&mut v, "c1", "usersHandler", "ARG_ENTRY_POINT_CALLBACK");
        // A non-express call with arguments — must NOT produce a route.
        v.put_node(NodeRow {
            id: id_of("c2"),
            node_type: "CALL".to_string(),
            name: "console.log".to_string(),
            file: "web/server.js".to_string(),
        });
        node(&mut v, "litX", "LITERAL");
        edge(&mut v, "c2", "litX", "ARG_ROUTE_PATH");

        // The express plugin rule: a HANDLES(route, handler) per recognized app.get registration.
        let src = r#"handles(Route, Handler) :-
                       node(C, "CALL"), attr(C, "name", "app.get"),
                       edge(C, Route, "ARG_ROUTE_PATH"),
                       edge(C, Handler, "ARG_ENTRY_POINT_CALLBACK")."#;
        let stats = Stats { total_nodes: 5, total_edges: 3, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");
        let handles: std::collections::HashSet<(u128, u128)> = eval
            .facts("handles")
            .iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap()))
            .collect();
        assert_eq!(
            handles,
            [(id_of("p_users"), id_of("usersHandler"))]
                .into_iter()
                .collect(),
            "express route /users HANDLES usersHandler, derived by rule from effects-db arg-roles; \
             the non-express console.log call produces nothing"
        );
    }

    /// Deployment-binding resolution (apparatus doc §5) — closes the gap iter2/iter3 left open: how
    /// does a frontend know WHICH proxy serves it? Via the deployment layer. The full chain now spans
    /// FOUR artifacts: frontend code → env binding (var → host) → which proxy SERVES that host →
    /// backend. All hops are STRUCTURAL joins on shared node identity (a unique env binding = exact
    /// RESOLUTION, the §5 resolution region — the same mechanism as the code import resolver, not
    /// abstract interpretation). A second frontend whose env-resolved host has NO serving proxy does
    /// NOT reach — a deployment-layer coverage gap (missing proxy config).
    #[test]
    fn deployment_binding_closes_frontend_to_backend_chain() {
        let mut v = FixtureStorageView::new(1);
        // Reaching chain: fe -USES_ENV-> apivar -BINDS_TO-> host1; nginx1 -SERVES-> host1,
        // nginx1 -PROXIES_TO-> be1.
        node(&mut v, "fe", "HTTP_REQUEST");
        node(&mut v, "apivar", "env:var");
        node(&mut v, "host1", "host");
        node(&mut v, "nginx1", "nginx:route");
        node(&mut v, "be1", "http:route");
        edge(&mut v, "fe", "apivar", "USES_ENV");
        edge(&mut v, "apivar", "host1", "BINDS_TO");
        edge(&mut v, "nginx1", "host1", "SERVES");
        edge(&mut v, "nginx1", "be1", "PROXIES_TO");
        // Dead-ending chain: fe2's env-resolved host2 has NO serving proxy (missing deploy config).
        node(&mut v, "fe2", "HTTP_REQUEST");
        node(&mut v, "apivar2", "env:var");
        node(&mut v, "host2", "host");
        edge(&mut v, "fe2", "apivar2", "USES_ENV");
        edge(&mut v, "apivar2", "host2", "BINDS_TO");

        // reaches(FE,BE): frontend env-var resolves to a host, a proxy serves that host and proxies
        // to the backend. The deployment hop (BINDS_TO) is what closes the frontend→proxy gap.
        let src = r#"reaches(FE, BE) :-
                       node(FE, "HTTP_REQUEST"), edge(FE, V, "USES_ENV"),
                       edge(V, H, "BINDS_TO"),
                       edge(P, H, "SERVES"), edge(P, BE, "PROXIES_TO"),
                       node(BE, "http:route")."#;
        let stats = Stats { total_nodes: 8, total_edges: 6, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");
        let reaches: std::collections::HashSet<(u128, u128)> = eval
            .facts("reaches")
            .iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_id().unwrap()))
            .collect();
        assert_eq!(
            reaches,
            [(id_of("fe"), id_of("be1"))].into_iter().collect(),
            "fe reaches be1 through env→host→proxy→backend; fe2's host2 has no serving proxy \
             (a deployment-layer coverage gap) so fe2 reaches nothing"
        );
    }

    /// Module dependency-CYCLE detection, built directly on the shipped `depends.dl` body.
    ///
    /// This is the clean "second migration" the plugin-pipeline note argues for: a derivation
    /// whose join keys are already first-class facts (the `file` attr), so it lowers to pure
    /// Datalog with no fuzzy resolver atom. It also demonstrates derive recursion stacked on a
    /// derived relation — `depends/2` (the bundled rule) → transitive closure `dep_reach/2`
    /// → `cycle/1 :- dep_reach(M, M)` — a real, actionable architectural finding (import cycles)
    /// expressed in three lines on top of an existing materialized edge.
    ///
    /// Topology: a.ts → b.ts → c.ts → a.ts is a 3-module cycle; x.ts imports into the cycle
    /// (`depends(m_x, m_a)`) but nothing imports back, so x is a dependent, NOT a cycle member.
    #[test]
    fn module_dependency_cycles_via_transitive_closure_over_depends() {
        let n = |sid: &str, ty: &str, file: &str| NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: sid.to_string(),
            file: file.to_string(),
        };
        let mut v = FixtureStorageView::new(1);
        // One MODULE per file (the depends.dl endpoint→module join key).
        v.put_node(n("m_a", "MODULE", "a.ts"));
        v.put_node(n("m_b", "MODULE", "b.ts"));
        v.put_node(n("m_c", "MODULE", "c.ts"));
        v.put_node(n("m_x", "MODULE", "x.ts"));
        // Import-binding endpoints: each IMPORTS_FROM goes from a node in the importer's file
        // to a node in the imported file; depends.dl maps each endpoint to its file's MODULE.
        v.put_node(n("ia_b", "IMPORT_BINDING", "a.ts")); // a.ts imports from b.ts
        v.put_node(n("tb", "FUNCTION", "b.ts"));
        v.put_node(n("ib_c", "IMPORT_BINDING", "b.ts")); // b.ts imports from c.ts
        v.put_node(n("tc", "FUNCTION", "c.ts"));
        v.put_node(n("ic_a", "IMPORT_BINDING", "c.ts")); // c.ts imports from a.ts  → closes cycle
        v.put_node(n("ta", "FUNCTION", "a.ts"));
        v.put_node(n("ix_a", "IMPORT_BINDING", "x.ts")); // x.ts imports from a.ts  → dependent only
        v.put_node(n("ta2", "FUNCTION", "a.ts"));
        edge(&mut v, "ia_b", "tb", "IMPORTS_FROM");
        edge(&mut v, "ib_c", "tc", "IMPORTS_FROM");
        edge(&mut v, "ic_a", "ta", "IMPORTS_FROM");
        edge(&mut v, "ix_a", "ta2", "IMPORTS_FROM");

        // The shipped depends/2 body (sans @materialize) + transitive closure + self-reach.
        let src = r#"depends(Msrc, Mdst) :- edge(Isrc, Idst, "IMPORTS_FROM"),
                                            attr(Isrc, "file", Fsrc), attr(Idst, "file", Fdst),
                                            node(Msrc, "MODULE"), attr(Msrc, "file", Fsrc),
                                            node(Mdst, "MODULE"), attr(Mdst, "file", Fdst),
                                            neq(Msrc, Mdst).
                     dep_reach(A, B) :- depends(A, B).
                     dep_reach(A, B) :- depends(A, C), dep_reach(C, B).
                     cycle(M) :- dep_reach(M, M)."#;
        let stats = Stats { total_nodes: 12, total_edges: 4, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");

        let cycle: std::collections::HashSet<u128> = eval
            .facts("cycle")
            .iter()
            .map(|r| r[0].as_id().unwrap())
            .collect();
        assert_eq!(
            cycle,
            [id_of("m_a"), id_of("m_b"), id_of("m_c")].into_iter().collect(),
            "exactly the 3 modules on the a→b→c→a import cycle are flagged; m_x depends INTO \
             the cycle but is not a member (nothing imports back from the cycle to x.ts)"
        );
    }

    /// MUTUAL-import detection (a 2-cycle) — the BOUNDED, non-recursive sibling of the
    /// transitive-closure cycle query. `mutual(A,B) :- depends(A,B), depends(B,A), lt(A,B)`
    /// is a plain self-join on the materialized `depends/2` (estimate ≈ |depends|², far under
    /// the §3 guard), so unlike the full closure it runs at scale without tripping E-PLAN-003
    /// (the recursive-closure q-error documented in `_ai/gaps.md`). `lt(A,B)` emits each mutual
    /// pair once. Mutual module imports are a real, common architectural smell.
    ///
    /// Fixture: a⇄b is a mutual pair; a→c is one-directional (c does not import a), so c is not
    /// part of any mutual pair.
    #[test]
    fn mutual_module_import_is_a_bounded_two_cycle_over_depends() {
        let n = |sid: &str, ty: &str, file: &str| NodeRow {
            id: id_of(sid),
            node_type: ty.to_string(),
            name: sid.to_string(),
            file: file.to_string(),
        };
        let mut v = FixtureStorageView::new(1);
        v.put_node(n("m_a", "MODULE", "a.ts"));
        v.put_node(n("m_b", "MODULE", "b.ts"));
        v.put_node(n("m_c", "MODULE", "c.ts"));
        // a⇄b mutual: a.ts imports b.ts AND b.ts imports a.ts.
        v.put_node(n("ia_b", "IMPORT_BINDING", "a.ts"));
        v.put_node(n("tb", "FUNCTION", "b.ts"));
        v.put_node(n("ib_a", "IMPORT_BINDING", "b.ts"));
        v.put_node(n("ta", "FUNCTION", "a.ts"));
        // a→c one-directional: a.ts imports c.ts, but c.ts imports nothing back.
        v.put_node(n("ia_c", "IMPORT_BINDING", "a.ts"));
        v.put_node(n("tc", "FUNCTION", "c.ts"));
        edge(&mut v, "ia_b", "tb", "IMPORTS_FROM");
        edge(&mut v, "ib_a", "ta", "IMPORTS_FROM");
        edge(&mut v, "ia_c", "tc", "IMPORTS_FROM");

        let depends_body = "depends(Msrc, Mdst) :- edge(Isrc, Idst, \"IMPORTS_FROM\"), \
             attr(Isrc, \"file\", Fsrc), attr(Idst, \"file\", Fdst), \
             node(Msrc, \"MODULE\"), attr(Msrc, \"file\", Fsrc), \
             node(Mdst, \"MODULE\"), attr(Mdst, \"file\", Fdst), neq(Msrc, Mdst).";
        let src = format!(
            "{depends_body}\nmutual(A, B) :- depends(A, B), depends(B, A), lt(A, B)."
        );
        let stats = Stats { total_nodes: 9, total_edges: 3, ..Default::default() };
        let eval = evaluate(&v, &src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");

        let pairs: Vec<std::collections::BTreeSet<u128>> = eval
            .facts("mutual")
            .iter()
            .map(|r| [r[0].as_id().unwrap(), r[1].as_id().unwrap()].into_iter().collect())
            .collect();
        assert_eq!(pairs.len(), 1, "exactly one mutual pair (lt dedups the symmetric direction)");
        assert_eq!(
            pairs[0],
            [id_of("m_a"), id_of("m_b")].into_iter().collect(),
            "the mutual pair is {{m_a, m_b}}; m_c (one-directional dependent) is not mutual"
        );
    }
}
