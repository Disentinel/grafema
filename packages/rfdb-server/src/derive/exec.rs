//! Layer 7 — semi-naive fixpoint executor.
//!
//! Runs the seed → Δ-loop: hash-joins on the Δ leg, the derive builtin/base eval bodies for
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

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use rayon::prelude::*;

use crate::datalog::{Atom, EvalLimits, Rule, Term, Value};

use super::builtin::{self, ArgSpec, ArgValue, Batch};
use super::catalog::BaseDispatch;
use super::increment::{self, BaseDelta};
use super::events::{EventLog, PredicateCount, PredicateDelta, StratumEntry};
use super::plan::{LegSource, RulePlan};
use super::stratify::Stratification;
use super::storage_glue::{EdgeOrder, StorageView};
use super::tag::{IdempotentTag, Tag};
use super::value::fact_id;

/// P3 (rofl-fact-model.md §3.4 normative 1): the executor-side resolution of a
/// plan-time [`BaseDispatch`] key into serving physics — the registry EVAL entry
/// (an IMPLEMENTATION key, not the program surface: `type` legs arrive already
/// resolved to node's PredicateId, `incoming` to edge's id + `SortOrder::Reverse`)
/// and the storage scan order. The ONE place the executor turns the
/// `(PredicateId, SortOrder)` half of the generalized dispatch key into code;
/// every join phase adds the leg's bound-column mask on top.
fn base_dispatch_parts(dispatch: &BaseDispatch) -> (&'static str, EdgeOrder) {
    use crate::derive::catalog::PhysStrategy;
    use crate::facts::SortOrder;
    let order = match dispatch.order {
        SortOrder::Forward => EdgeOrder::Forward,
        SortOrder::Reverse => EdgeOrder::Reverse,
    };
    let eval = match (dispatch.strategy, dispatch.arity, dispatch.order) {
        (PhysStrategy::Adjacency, 3, SortOrder::Forward) => "edge",
        (PhysStrategy::Adjacency, 3, SortOrder::Reverse) => "incoming",
        (PhysStrategy::Attribute, 2, _) => "node",
        (PhysStrategy::Attribute, 3, _) => "attr",
        // Open-space physics never classify as `LegSource::Base` (P3
        // plan.rs::classify resolves Base ONLY through the catalog's base
        // dispatch map, which holds exactly the four physical shapes above).
        _ => unreachable!(
            "open-space physics ({:?}/{}) cannot be a plan-resolved base leg",
            dispatch.strategy, dispatch.arity
        ),
    };
    (eval, order)
}

/// The default semi-naive iteration cap (spec §7): a stratum that has not saturated after
/// this many Δ rounds is rejected with [`ExecCode::IterationCap`] (`E-EXEC-002`). For an
/// `IdempotentTag` stratum termination is guaranteed by construction (I4); the cap is a
/// tripwire against a planning or storage fault, never the normal exit.
pub const DEFAULT_ITERATION_CAP: usize = 10_000;

/// A recursive semi-naive Δ this size or smaller is led with (enumerated first, then the
/// other legs probed per row) instead of following the cost-optimized plan order — see
/// [`Executor::eval_clause`]. Small enough that the per-row probes stay cheaper than a full
/// base scan (the incremental win), large enough that the live-dataset recursion — whose Δ
/// rounds are far bigger — keeps its cost-optimized order (no from-scratch regression).
const DELTA_LEAD_THRESHOLD: usize = 64;

/// Minimum partial-row count for the build-once extensional fast paths in
/// [`Executor::join_extensional`]. Below it the per-row registry eval runs unchanged: for
/// a handful of rows the per-row keyed probes are cheaper than one typed scan, and the
/// threshold keeps generators (seeded with the single empty row) and the small-Δ
/// incremental legs on their existing, work-proportional path.
const BUILD_ONCE_MIN_ROWS: usize = 64;

/// Distinct-id count above which the build-once `attr`/bound-id fast path reads its node
/// rows from ONE full sorted-node pass instead of one point probe per DISTINCT id. Below
/// it, per-distinct-id probes win (rows often repeat ids — dedup alone cuts probes); above
/// it, the single sequential scan beats tens of thousands of random LSM point reads.
const ATTR_DISTINCT_SCAN_THRESHOLD: usize = 1024;

/// Minimum partial-row count for the rayon row-parallel probe loops. Below it the
/// sequential loop (the reference implementation) runs unchanged — small legs and small
/// semi-naive Δ rounds must not pay thread-pool dispatch overhead. The parallel path
/// splits rows into ordered chunks, probes each chunk into its own output vector, and
/// concatenates the chunk outputs IN ORDER, so its output is byte-identical to the
/// sequential loop's (same multiset, same order — determinism, I1).
const PAR_MIN_ROWS: usize = 1024;

/// Rows per rayon work unit in the parallel probe loops. Small enough to load-balance
/// skewed probe costs across the pool, large enough that per-chunk vector overhead stays
/// negligible.
const PAR_CHUNK_ROWS: usize = 256;

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
    /// The external cancellation flag (`EvalLimits::cancelled`) was raised — the client
    /// disconnected mid-flight or sent an explicit cancel. The run aborts without
    /// committing, exactly like a limit overflow (`E-EXEC-003`). W8 Part 1: before this,
    /// a derive fixpoint ignored the flag entirely and ground CPU to completion (or
    /// the wall-clock deadline) long after the client died.
    Cancelled,
}

impl ExecCode {
    /// The stable string form emitted in diagnostics and conformance manifests.
    pub fn as_str(self) -> &'static str {
        match self {
            ExecCode::IterationCap => "E-EXEC-002",
            ExecCode::LimitExceeded => "E-EXEC-001",
            ExecCode::Cancelled => "E-EXEC-003",
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

// ── why(): one supporting derivation of a fact ─────────────────────

/// One supporting derivation of a derived fact — the unit of `why()`/`explain_fact`
/// provenance (spec §11). Computed on demand (no per-fact provenance is stored — that would
/// cost memory on every derived fact for a query-time-only need); a full provenance tree is
/// this applied recursively to each body fact, which the lazy on-demand shape supports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivationWitness {
    /// The rule that derived the fact, by its stable whitespace/variable-rename-invariant
    /// hash (the same `_source` stamp a materialized edge carries).
    pub rule_ast_hash: String,
    /// The POSITIVE body facts that satisfied the rule for this fact: `(predicate, ground
    /// tuple)` per positive body literal, in source order. Negated literals contribute an
    /// absence (they bind nothing) and are omitted; builtin filters likewise.
    pub body: Vec<(String, Box<[Value]>)>,
}

/// The why-NOT dual of [`DerivationWitness`] — why a fact is NOT derived (spec §6 coverage /
/// PUG why-not provenance). Computed on demand by replaying each rule for the predicate with
/// the head bound to the queried key and finding the FIRST body premise that no binding
/// satisfies — the unbound premise that, if supplied, would close the gap. The dual feeds
/// `sim()`: this names the missing premise (e.g. `edge(_, _, "IMPORTS_FROM")`), sim verifies
/// that adding it produces the fact.
///
/// Reported for the rule with the LONGEST satisfied prefix (the closest-to-firing rule).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GapWitness {
    /// The rule whose gap this characterizes (same stable hash as `DerivationWitness`).
    pub rule_ast_hash: String,
    /// The body premises that WERE satisfiable (with the head bound), in placement order —
    /// `(predicate, ground tuple)`. The gap sits immediately after this prefix.
    pub satisfied: Vec<(String, Box<[Value]>)>,
    /// The predicate of the first body premise that no binding satisfies — the unbound premise.
    pub failing_predicate: String,
    /// `true` when the failing premise is a NEGATED literal (an anti-join): a fact that is
    /// PRESENT blocks the derivation (the gap closes by REMOVING it), as opposed to a positive
    /// premise that is MISSING (the gap closes by ADDING it).
    pub failing_is_negative: bool,
}

// ── A partial binding row ──────────────────────────────────────────

/// A partial binding: variable name → bound value, accumulated as body legs are placed.
///
/// The planner ordered the body bound-first, so by the time a leg runs every input it
/// needs is present in the row. Kept as a small sorted map so equal rows have one
/// representation (determinism) and lookups stay cheap on the short variable lists rules
/// use.
type BindRow = BTreeMap<String, Value>;

/// A derive-registry builtin eval body — the per-row evaluation function the build-once fast
/// paths replicate (and defensively fall back to, row by row).
type BuiltinEval = fn(&dyn StorageView, &mut Batch, &ArgSpec) -> builtin::BuiltinResult<()>;

// ── Row-parallel join driver (Part B) ──────────────────────────────
//
// Every join probe loop in this module has the shape `for row in rows { per_row(row, &mut
// out) }` over a SHARED immutable index/view — per-row pure, no cross-row state. This
// driver runs that shape sequentially below [`PAR_MIN_ROWS`] (the reference
// implementation, byte-identical to the historical loops) and rayon-chunk-parallel at or
// above it. Chunk outputs are collected with an indexed parallel iterator and flattened
// IN CHUNK ORDER, so the parallel output equals the sequential output exactly (same rows,
// same order — not merely the same multiset).
//
// `per_row` must capture only `Sync` state: the executor itself is NOT `Sync` (it owns
// `RefCell`s for the event log and the Part-A index caches), so callers fetch/build any
// cached index BEFORE calling this and capture the index + the `&dyn StorageView` (whose
// trait carries a `Sync` supertrait) — never `&self`.
// W8 Part 1 (disconnect-cancel): `cancelled` is the external cancellation flag from
// `EvalLimits` (`None` when the caller installed none). It is polled once per ROW — a
// relaxed atomic load, unmeasurable against any real per-row join work — and a raised
// flag makes the remaining rows fall through as no-ops (sequential: break; parallel:
// each chunk drains without work). The partial output this returns is DISCARDED by the
// caller: the executor's authoritative `check_cancelled` (in `apply_leg` / the fixpoint
// loops) turns the raised flag into `E-EXEC-003` before any result is committed, so a
// cancelled run can never observe — let alone commit — the truncated row set.
fn par_join_rows<F>(rows: &[BindRow], cancelled: Option<&AtomicBool>, per_row: F) -> Vec<BindRow>
where
    F: Fn(&BindRow, &mut Vec<BindRow>) + Sync,
{
    let is_cancelled = || cancelled.is_some_and(|f| f.load(Ordering::Relaxed));
    if rows.len() < PAR_MIN_ROWS {
        let mut out = Vec::new();
        for row in rows {
            if is_cancelled() {
                break;
            }
            per_row(row, &mut out);
        }
        return out;
    }
    let chunks: Vec<Vec<BindRow>> = rows
        .par_chunks(PAR_CHUNK_ROWS)
        .map(|chunk| {
            let mut out = Vec::new();
            for row in chunk {
                if is_cancelled() {
                    break;
                }
                per_row(row, &mut out);
            }
            out
        })
        .collect();
    let mut out = Vec::with_capacity(chunks.iter().map(Vec::len).sum());
    for c in chunks {
        out.extend(c);
    }
    out
}

// ── Part A: executor-owned build-once index caches ─────────────────

/// Key of a cached typed-edge join index: `(edge type, scan order, shape)` where shape is
/// which endpoints the rows can probe (both / near-only / far-only). Two legs anywhere in
/// the program (any rule, any stratum, any semi-naive iteration) that need the same index
/// content share one build — the index depends only on the view (immutable for the
/// executor's lifetime) and this key, never on the probing rows.
type EdgeIndexKey = (String, super::storage_glue::EdgeOrder, EdgeProbeShape);

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum EdgeProbeShape {
    Both,
    ByNear,
    ByFar,
}

/// A built typed-edge join index (the hash side of
/// [`Executor::join_edge_bound_built_once`]), built from ONE `scan_edges_by_type` pass.
enum EdgeIndex {
    /// Both endpoints row-bound: `(near, far) → multiplicity` (membership + count).
    Both(HashMap<(u128, u128), usize>),
    /// Only the near endpoint row-bound: `near → [far]` buckets, in scan order.
    ByNear(HashMap<u128, Vec<u128>>),
    /// Only the far endpoint row-bound: `far → [near]` buckets, in scan order.
    ByFar(HashMap<u128, Vec<u128>>),
}

/// Key of a cached set-at-once anti-join membership set: the negated leg's predicate
/// family (`edge`/`incoming` vs `node`/`type`), the constant type, and which argument
/// positions are variables (the projection mask — [`project_anti_join_key`] keys rows on
/// exactly the variable positions, so two atoms with the same mask share one set).
type AntiJoinKey = (&'static str, String, [bool; 2]);

/// The Part-A caches, owned by one [`Executor`] — i.e. scoped to ONE immutable snapshot
/// view (`Executor::view` never changes; incremental phases that read a different base
/// construct a fresh executor, see [`maintain_incremental`]). Within that scope every
/// base-relation index is a pure function of its key, so it is built ONCE and reused
/// across legs, clauses, strata, and semi-naive iterations — the W1 finding was that
/// these were rebuilt per `join_*` call, i.e. per leg per clause per Δ-round.
///
/// `RefCell` (not a lock): the executor evaluates clauses single-threaded; only the
/// per-ROW probe loops fan out, and they receive a pre-fetched `Arc` clone of the index,
/// never the cache itself. Values are `Arc` so a fetched index stays alive (and shareable
/// across rayon workers) independent of the `RefCell` borrow.
///
/// Derived-relation indexes ([`Executor::join_derived`]) are deliberately NOT cached: a
/// recursive leg's source (Δ, or a same-stratum Total) genuinely changes every iteration,
/// and the index holds borrows into the relation store that a cache cannot outlive; a
/// frozen lower-stratum leg is rebuilt per Δ-round, but its build is O(|relation|) over an
/// in-memory map — storage scans, the measured cost driver, are what this cache removes.
///
/// Memory: bounded by the base relations the program actually touches (one bucket map per
/// distinct (edge type, order, shape), one id-set per node type, one value→ids map per
/// first-class attr key, at most one full node-row map) — the same magnitude the
/// uncached code allocated TRANSIENTLY on every single call.
struct IndexCaches {
    edge: RefCell<HashMap<EdgeIndexKey, Arc<EdgeIndex>>>,
    /// Node-membership sets for `node(BoundId, "Ty")` legs, keyed by type.
    node_members: RefCell<HashMap<String, Arc<HashSet<u128>>>>,
    /// `value → [id]` generator indexes for `attr(FreeId, key, V)`, keyed by the
    /// first-class column key (`name`/`file`/`type`).
    attr_gen: RefCell<HashMap<String, Arc<HashMap<String, Vec<u128>>>>>,
    /// The FULL `id → NodeRow` map, built lazily on the first attr/bound-id leg whose
    /// distinct-id count crosses [`ATTR_DISTINCT_SCAN_THRESHOLD`] (one sorted-node pass —
    /// the same pass the uncached code made per call, which kept only that call's ids and
    /// threw the rest away). Once built, every later attr/bound-id leg of ANY size is
    /// served from it.
    node_rows_full: RefCell<Option<Arc<HashMap<u128, super::storage_glue::NodeRow>>>>,
    /// Set-at-once anti-join membership sets.
    anti_join: RefCell<HashMap<AntiJoinKey, Arc<HashSet<Vec<Value>>>>>,
    /// `(near, far)` tuples of one typed edge scan IN SCAN ORDER, keyed by `(type,
    /// order)` — serves the fully-free `edge`/`incoming` GENERATOR leg, whose per-row
    /// eval re-scans storage on EVERY call (every Δ-round of a recursive stratum re-leads
    /// with the same generator; multiple clauses lead with the same one). Scan order is
    /// preserved so the cached emission is byte-identical to `eval_edge_dir`'s.
    edge_pairs: RefCell<HashMap<(String, super::storage_glue::EdgeOrder), Arc<Vec<(u128, u128)>>>>,
    /// Node ids of one typed node scan in scan order, keyed by type — the free `node`/
    /// `type` generator twin of `edge_pairs`.
    node_ids: RefCell<HashMap<String, Arc<Vec<u128>>>>,
    /// `(src, dst) → extracted scalar` edge-metadata index, keyed by `(edge type,
    /// metadata key)` — the build-once side of the `edge_attr` point probe (W9 fix #2).
    /// One typed metadata scan + ONE JSON parse per edge replaces a keyed source-index
    /// walk + parse PER ROW (~240µs/probe measured on the LSM store). The stored value
    /// is the scalar's string surface under `eval_edge_attr`'s exact extraction rules
    /// (String verbatim / Number by JSON text / Bool as `"true"`/`"false"`); an edge with
    /// no metadata, an unparseable blob, a missing key, or a non-scalar value is ABSENT
    /// (the per-row path's tuple non-match).
    edge_attr: RefCell<HashMap<(String, String), Arc<HashMap<(u128, u128), String>>>>,
    /// Measure-first counters: how many index BUILDS actually ran vs how many calls were
    /// served from cache. Observational only (never affect the committed result).
    builds: Cell<u64>,
    hits: Cell<u64>,
}

impl IndexCaches {
    fn new() -> Self {
        Self {
            edge: RefCell::new(HashMap::new()),
            node_members: RefCell::new(HashMap::new()),
            attr_gen: RefCell::new(HashMap::new()),
            node_rows_full: RefCell::new(None),
            anti_join: RefCell::new(HashMap::new()),
            edge_pairs: RefCell::new(HashMap::new()),
            node_ids: RefCell::new(HashMap::new()),
            edge_attr: RefCell::new(HashMap::new()),
            builds: Cell::new(0),
            hits: Cell::new(0),
        }
    }

    /// Fetch the cached value for `key` in `map`, or build it with `build` and cache it.
    /// Counts a hit or a build (the proof anchor for the cache tests).
    fn get_or_build<K, V>(
        &self,
        map: &RefCell<HashMap<K, Arc<V>>>,
        key: K,
        build: impl FnOnce() -> V,
    ) -> Arc<V>
    where
        K: std::hash::Hash + Eq,
    {
        if let Some(found) = map.borrow().get(&key) {
            self.hits.set(self.hits.get() + 1);
            return Arc::clone(found);
        }
        // Build OUTSIDE the borrow: the build closure reads storage and may take long;
        // nothing re-enters this cache during a build (joins don't nest), but keeping the
        // borrow scope minimal is free insurance.
        let built = Arc::new(build());
        map.borrow_mut().insert(key, Arc::clone(&built));
        self.builds.set(self.builds.get() + 1);
        built
    }
}

// ── W9 fix #1: cross-evaluation shared index caches ────────────────

/// What ONE `@materialize` write-back commit touched — the carry-forward contract of
/// [`SharedIndexCaches::retain_for_commit`]. The caller (the engine's write-back path)
/// constructs the commit itself, so it states EXACTLY what changed between the two
/// manifest versions; every cached index whose inputs are disjoint from the touched data
/// is bit-identical at the new version and may survive.
#[derive(Debug, Default, Clone)]
pub(crate) struct CommitTouch {
    /// Edge types the commit added edges of OR tombstoned edges of (the union of the
    /// run's `@materialize` spec `edge_type`s is a sound over-approximation).
    pub(crate) edge_types: std::collections::HashSet<String>,
    /// Whether any NODE was added or tombstoned (drops every node-derived index:
    /// memberships, attr generators, the full row map, node id lists, node anti-joins).
    pub(crate) nodes: bool,
    /// Whether the commit may have touched edges of types OUTSIDE `edge_types` — set
    /// when any node was TOMBSTONED, because `delete_node` cascades tombstones to ALL
    /// of the node's connected edges regardless of type. Drops every edge-derived index.
    pub(crate) edges_unbounded: bool,
}

/// Cross-evaluation, VERSION-KEYED home for the Part-A build-once indexes (W9 fix #1):
/// the per-[`Executor`] [`IndexCaches`] die with their executor, so a production
/// `@materialize` run of 20 stdlib packs rebuilt every node/edge/attr index 20× from
/// scratch (~31s of the measured 176.6s pack phase) — yet most consecutive packs read
/// the SAME manifest version.
///
/// # Soundness invariant
///
/// Every cached index is a pure function of `(its key, the committed data at one
/// manifest version)` — the same purity [`IndexCaches`] relies on within one executor,
/// extended across executors by MVCC: two snapshots at the same published version
/// observe identical committed data (visibility flips only at a manifest publish).
/// Therefore:
///
/// * [`SharedIndexCaches::seed`] hands entries out ONLY when the stored version equals
///   the borrowing executor's `view.generation()` — a version mismatch yields nothing
///   (never a stale index), so arbitrary foreign commits (analyzer batches, compaction,
///   deletes) are safe by construction: they bump the version and simply miss.
/// * [`SharedIndexCaches::absorb`] stores an executor's built indexes back under its
///   view's generation, merging when the version matches and replacing wholesale when
///   it does not.
/// * [`SharedIndexCaches::retain_for_commit`] is the ONE deliberate cross-version
///   carry: the `@materialize` write-back knows exactly which edge types / nodes its
///   commit touched ([`CommitTouch`]), so indexes over untouched relations are
///   bit-identical at the new version and are re-stamped instead of dropped. Scan-order
///   determinism holds for the carried entries: edge scans are sorted by endpoint pair
///   (`storage_glue`), and an edges-only commit appends no node segment, so node scan
///   order is unchanged.
/// * The ONE same-version data mutation in the engine — the delete→re-add
///   un-tombstone (`ManifestStore::remove_tombstone_edges`/`_nodes`, which resurrects
///   committed records IN the current version) — is covered by the engine calling
///   [`SharedIndexCaches::invalidate_all`] whenever it actually removes entries.
///
/// Interior `Mutex` so the engine can hold one instance per database and lend it to
/// `&self` evaluation paths; lock scope is the seed/absorb copy (Arc clones of a few
/// map entries), never an index build.
pub(crate) struct SharedIndexCaches {
    inner: std::sync::Mutex<SharedIndexInner>,
}

#[derive(Default)]
struct SharedIndexInner {
    /// Manifest version every stored entry is valid at; `None` = empty.
    version: Option<u64>,
    edge: HashMap<EdgeIndexKey, Arc<EdgeIndex>>,
    node_members: HashMap<String, Arc<HashSet<u128>>>,
    attr_gen: HashMap<String, Arc<HashMap<String, Vec<u128>>>>,
    node_rows_full: Option<Arc<HashMap<u128, super::storage_glue::NodeRow>>>,
    anti_join: HashMap<AntiJoinKey, Arc<HashSet<Vec<Value>>>>,
    edge_pairs: HashMap<(String, super::storage_glue::EdgeOrder), Arc<Vec<(u128, u128)>>>,
    node_ids: HashMap<String, Arc<Vec<u128>>>,
    edge_attr: HashMap<(String, String), Arc<HashMap<(u128, u128), String>>>,
}

impl SharedIndexCaches {
    /// An empty shared cache (nothing to seed until the first absorb).
    pub(crate) fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(SharedIndexInner::default()),
        }
    }

    /// Copy the stored entries into `caches` iff they were built at exactly `version`
    /// (Arc clones — the indexes themselves are shared, not duplicated). A version
    /// mismatch seeds nothing: correctness never depends on this method.
    fn seed(&self, version: u64, caches: &IndexCaches) {
        let inner = self.inner.lock().unwrap();
        if inner.version != Some(version) {
            return;
        }
        *caches.edge.borrow_mut() = inner.edge.clone();
        *caches.node_members.borrow_mut() = inner.node_members.clone();
        *caches.attr_gen.borrow_mut() = inner.attr_gen.clone();
        *caches.node_rows_full.borrow_mut() = inner.node_rows_full.clone();
        *caches.anti_join.borrow_mut() = inner.anti_join.clone();
        *caches.edge_pairs.borrow_mut() = inner.edge_pairs.clone();
        *caches.node_ids.borrow_mut() = inner.node_ids.clone();
        *caches.edge_attr.borrow_mut() = inner.edge_attr.clone();
    }

    /// Store an executor's built indexes under `version` after a successful evaluation.
    /// Same stored version ⇒ merge (purity makes a key collision content-identical);
    /// different ⇒ replace wholesale (the old version's entries are unreachable anyway —
    /// `seed` requires an exact version match).
    fn absorb(&self, version: u64, caches: &IndexCaches) {
        let mut inner = self.inner.lock().unwrap();
        if inner.version != Some(version) {
            *inner = SharedIndexInner::default();
            inner.version = Some(version);
        }
        inner.edge.extend(caches.edge.borrow().iter().map(|(k, v)| (k.clone(), Arc::clone(v))));
        inner
            .node_members
            .extend(caches.node_members.borrow().iter().map(|(k, v)| (k.clone(), Arc::clone(v))));
        inner
            .attr_gen
            .extend(caches.attr_gen.borrow().iter().map(|(k, v)| (k.clone(), Arc::clone(v))));
        if let Some(full) = caches.node_rows_full.borrow().as_ref() {
            inner.node_rows_full = Some(Arc::clone(full));
        }
        inner
            .anti_join
            .extend(caches.anti_join.borrow().iter().map(|(k, v)| (k.clone(), Arc::clone(v))));
        inner
            .edge_pairs
            .extend(caches.edge_pairs.borrow().iter().map(|(k, v)| (k.clone(), Arc::clone(v))));
        inner
            .node_ids
            .extend(caches.node_ids.borrow().iter().map(|(k, v)| (k.clone(), Arc::clone(v))));
        inner
            .edge_attr
            .extend(caches.edge_attr.borrow().iter().map(|(k, v)| (k.clone(), Arc::clone(v))));
    }

    /// Cross-version carry-forward after ONE `@materialize` write-back commit advanced
    /// the manifest FROM `prev_version` (the pinned read version the commit was built
    /// against) TO `new_version`: evict exactly the entries whose inputs the commit
    /// touched (see [`CommitTouch`]) and re-stamp the survivors. Sound because the
    /// caller built the commit and states the touched set; everything else is
    /// bit-identical at `new_version` (struct-level invariant above).
    ///
    /// The `prev_version` guard is load-bearing: if the stored entries were built at
    /// some OTHER version (e.g. a foreign analyzer commit landed since the last
    /// absorb), this carry's touched-set covers only the materialize commit — NOT the
    /// foreign delta — so the stale entries are dropped wholesale instead of being
    /// laundered onto `new_version`.
    pub(crate) fn retain_for_commit(
        &self,
        prev_version: u64,
        new_version: u64,
        touch: &CommitTouch,
    ) {
        let mut inner = self.inner.lock().unwrap();
        if inner.version.is_none() {
            return;
        }
        if inner.version != Some(prev_version) {
            *inner = SharedIndexInner::default();
            return;
        }
        if touch.edges_unbounded {
            // A node tombstone cascades edge tombstones of EVERY type — no edge index
            // can be proven untouched.
            inner.edge.clear();
            inner.edge_pairs.clear();
            inner.edge_attr.clear();
            inner.anti_join.retain(|(family, _, _), _| *family == "node");
        } else {
            inner.edge.retain(|(ty, _, _), _| !touch.edge_types.contains(ty));
            inner.edge_pairs.retain(|(ty, _), _| !touch.edge_types.contains(ty));
            inner.edge_attr.retain(|(ty, _), _| !touch.edge_types.contains(ty));
            inner.anti_join.retain(|(family, ty, _), _| {
                *family == "node" || !touch.edge_types.contains(ty)
            });
        }
        if touch.nodes {
            inner.node_members.clear();
            inner.attr_gen.clear();
            inner.node_rows_full = None;
            inner.node_ids.clear();
            inner.anti_join.retain(|(family, _, _), _| *family != "node");
        }
        inner.version = Some(new_version);
    }

    /// Drop EVERYTHING (W9 must-fix). The delete→re-add path (`add_edges`/`add_nodes`
    /// after a FLUSHED delete of the same key) un-tombstones in the CURRENT manifest
    /// version IN PLACE (`ManifestStore::remove_tombstone_edges`/`_nodes`) — same
    /// version, MORE visible data — so the version key alone can no longer prove the
    /// stored indexes current and the soundness invariant above would be violated by
    /// the next `seed` at that version. The engine calls this whenever an
    /// un-tombstone actually removed entries; the next evaluation rebuilds and
    /// re-absorbs against the resurrected data.
    pub(crate) fn invalidate_all(&self) {
        *self.inner.lock().unwrap() = SharedIndexInner::default();
    }

    /// Test-only inspection: `(stored version, total entry count)`.
    #[cfg(test)]
    pub(crate) fn snapshot_counts(&self) -> (Option<u64>, usize) {
        let inner = self.inner.lock().unwrap();
        let n = inner.edge.len()
            + inner.node_members.len()
            + inner.attr_gen.len()
            + usize::from(inner.node_rows_full.is_some())
            + inner.anti_join.len()
            + inner.edge_pairs.len()
            + inner.node_ids.len()
            + inner.edge_attr.len();
        (inner.version, n)
    }
}

// ── The executor ───────────────────────────────────────────────────

/// The semi-naive fixpoint executor, parameterized by the provenance tag.
///
/// Recursion is gated on [`IdempotentTag`] (I4): a non-idempotent tag could grow without
/// bound in a recursive stratum and so must not instantiate the recursive path. Gate A
/// instantiates only [`BoolTag`](super::tag::BoolTag).
pub(crate) struct Executor<'v, T: IdempotentTag> {
    /// The only access path to storage (I10).
    view: &'v dyn StorageView,
    /// Optional delta-base view for incremental maintenance (spec §9.2): a view exposing
    /// ONLY the asserted base delta `ΔB`. When set, a base leg flagged as the semi-naive
    /// delta leg reads its facts from here instead of `view`, so the seed derives exactly
    /// the facts that use a new base fact. `None` for a from-scratch evaluation (the only
    /// mode before Gate C); leaving it `None` keeps every non-incremental run byte-identical.
    delta_view: Option<&'v dyn StorageView>,
    /// Per-stratum evaluation limits (intermediate-result cap, deadline).
    limits: EvalLimits,
    /// Semi-naive iteration cap (`E-EXEC-002` on overflow).
    iteration_cap: usize,
    /// Row-count threshold for the build-once extensional fast paths
    /// ([`Self::join_extensional`]). [`BUILD_ONCE_MIN_ROWS`] by default; overridable in
    /// tests so the build-once and per-row paths can be differentially compared on small
    /// fixtures (`0` forces build-once everywhere, `usize::MAX` forces per-row).
    build_once_min_rows: usize,
    /// Always-on event log (spec §11). Default is a discarding log: every emit is a no-op
    /// that allocates nothing, so instrumentation in the hot Δ-loop costs nothing when no
    /// sink is wired. `RefCell` so `evaluate(&self, …)` keeps its immutable signature (the
    /// log is observational and must not affect the committed result — I9/I1).
    events: RefCell<EventLog>,
    /// Part-A build-once index caches: every base-relation join index is a pure function
    /// of (its key, `view`) and `view` is immutable for this executor's lifetime, so each
    /// is built ONCE here and reused across legs, clauses, strata, and semi-naive
    /// iterations. See [`IndexCaches`] for the per-index keying and the derived-relation
    /// exclusion rationale.
    caches: IndexCaches,
    /// Optional cross-evaluation shared home for the Part-A indexes (W9 fix #1):
    /// installed via [`Executor::with_shared_caches`], it pre-seeds `caches` with the
    /// entries built by PREVIOUS executors at the SAME `view.generation()` and absorbs
    /// this executor's builds back after a successful [`Executor::evaluate`]. `None`
    /// (the default) keeps every other entry path byte-identical to before.
    shared: Option<&'v SharedIndexCaches>,
    /// The stratum currently being evaluated — diagnostics only (it stamps the `stratum`
    /// field of an `E-EXEC-003` cancellation error raised from `apply_leg`, which has no
    /// stratum parameter). `Cell` so the `&self` eval paths can update it (W8 Part 1).
    cur_stratum: Cell<usize>,
    /// Carries the tag type without storing a value.
    _tag: PhantomData<T>,
}

impl<'v, T: IdempotentTag> Executor<'v, T> {
    /// Build an executor over a storage view with default limits and the standard
    /// iteration cap, discarding the event log.
    pub(crate) fn new(view: &'v dyn StorageView) -> Self {
        Self {
            view,
            delta_view: None,
            limits: EvalLimits::default(),
            iteration_cap: DEFAULT_ITERATION_CAP,
            build_once_min_rows: BUILD_ONCE_MIN_ROWS,
            events: RefCell::new(EventLog::discard()),
            caches: IndexCaches::new(),
            shared: None,
            cur_stratum: Cell::new(0),
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
            delta_view: None,
            limits,
            iteration_cap,
            build_once_min_rows: BUILD_ONCE_MIN_ROWS,
            events: RefCell::new(EventLog::discard()),
            caches: IndexCaches::new(),
            shared: None,
            cur_stratum: Cell::new(0),
            _tag: PhantomData,
        }
    }

    /// Install a cross-evaluation shared index cache (builder-style, W9 fix #1): seed
    /// this executor's Part-A caches with every entry the shared home holds at exactly
    /// `view.generation()` (a version mismatch seeds nothing), and absorb this
    /// executor's builds back after a successful [`Executor::evaluate`]. Purely an
    /// index-reuse mechanism: a seeded index is the same pure function of (key, view)
    /// the executor would have built itself, so the committed result is unchanged (the
    /// differential test anchors this).
    pub(crate) fn with_shared_caches(mut self, shared: &'v SharedIndexCaches) -> Self {
        shared.seed(self.view.generation(), &self.caches);
        self.shared = Some(shared);
        self
    }

    /// Override the build-once row threshold (test-only): `0` forces the build-once fast
    /// paths on every eligible base leg; `usize::MAX` forces the per-row path everywhere.
    /// Both settings MUST commit identical results — the differential property test
    /// (`build_once_extensional_paths_match_per_row_multisets`) compares them leg by leg.
    #[cfg(test)]
    pub(crate) fn with_build_once_min_rows(mut self, n: usize) -> Self {
        self.build_once_min_rows = n;
        self
    }

    /// Part-A cache counters: `(builds, hits)` — how many build-once base-leg indexes
    /// were actually BUILT vs served from this executor's cache. The proof anchor for
    /// the index-cache tests (a recursive stratum must show `builds` independent of the
    /// iteration count). Observational only.
    #[cfg(test)]
    pub(crate) fn index_cache_counts(&self) -> (u64, u64) {
        (self.caches.builds.get(), self.caches.hits.get())
    }

    /// Install a delta-base view (builder-style): the view exposing only `ΔB`, the asserted
    /// base delta of an incremental run. With it set, a base leg the caller marks as the
    /// semi-naive delta leg reads `ΔB` rather than the full base. Returns `self` to chain.
    pub(crate) fn with_delta_view(mut self, delta_view: &'v dyn StorageView) -> Self {
        self.delta_view = Some(delta_view);
        self
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
                false,
            ) {
                self.events
                    .borrow_mut()
                    .run_aborted(e.code.as_str(), &e.detail);
                return Err(e);
            }
        }

        // ── W8 Part 1 FINAL GUARD (post-fixpoint cancellation re-check) ──
        // A cancellation raised DURING the last join of an iteration truncates that
        // join's rows without ever re-entering a checkpoint: the truncated (possibly
        // empty) delta then looks like CONVERGENCE, the stratum loop ends, and the run
        // would return `Ok` with a PARTIAL evaluation. Observed live before this guard:
        // a client killed 2.5s into the bundled-depends `@materialize` made the eval
        // "converge" on the truncated rows, and the write-back diffed `derived = ∅`
        // against the graph — tombstoning all 1726 DEPENDS_ON edges. The flag is
        // raise-only (disconnect / explicit cancel), so one re-check here is
        // authoritative for the whole run: raised at ANY point ⇒ the committed
        // relations are untrusted ⇒ `E-EXEC-003` (abort-no-commit), never a partial
        // result.
        if self.is_cancelled() {
            let e = ExecError {
                code: ExecCode::Cancelled,
                stratum: self.cur_stratum.get(),
                detail: "query cancelled by client (disconnect or explicit cancel)"
                    .to_string(),
            };
            self.events
                .borrow_mut()
                .run_aborted(e.code.as_str(), &e.detail);
            return Err(e);
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

        // ── W9 fix #1: hand the built Part-A indexes back to the shared home (success
        // path only — a rejected run absorbed nothing, which is merely a missed reuse).
        if let Some(shared) = self.shared {
            shared.absorb(self.view.generation(), &self.caches);
        }

        Ok(out)
    }

    /// DRed phase 1 — **over-delete** (spec §9.2, deletion). Given the prior `Total`
    /// pre-loaded in `relations` and a delta view of the RETRACTED base facts `ΔB⁻`
    /// (installed via [`with_delta_view`](Self::with_delta_view), with `view` = the PRIOR
    /// base — the over-delete reasons about the OLD derivation graph), compute the set of
    /// derived facts that had at least one derivation using a deleted base fact, transitively
    /// through other candidates. This is an OVER-approximation: a candidate may still have an
    /// alternate derivation from surviving facts and be restored by the re-derive phase
    /// (commit 7) — so this method does NOT mutate `Total`; it only returns the candidate set
    /// for the caller to remove and then re-derive. Single derived stratum, positive.
    ///
    /// Mirrors the incremental seed/Δ-loop: the seed fires one variant per positive base leg
    /// reading `ΔB⁻` (facts whose derivation used a deleted base fact); the loop fires the
    /// recursive-leg variant reading the candidate Δ (facts whose derivation used a candidate)
    /// — both restricted to facts that actually exist in the prior `Total` (only an existing
    /// fact can be deleted). The working Δ rides each predicate's `Relation::delta`.
    fn over_delete(
        &self,
        plans: &[RulePlan],
        rules: &[&Rule],
        strat: &Stratification,
        pred_ids: &HashMap<String, u64>,
        relations: &mut HashMap<String, Relation<T>>,
    ) -> ExecResult<HashMap<String, HashMap<u64, DerivedFact<T>>>> {
        let mut candidates: HashMap<String, HashMap<u64, DerivedFact<T>>> = HashMap::new();
        let Some(stratum) = strat.strata.first() else {
            return Ok(candidates);
        };
        let predicates = &stratum.predicates;
        let clauses = self.collect_clauses(predicates, plans, rules);
        for p in predicates {
            if let Some(r) = relations.get_mut(p) {
                r.delta.clear();
            }
        }

        // Is `fid` a real prior fact of `pred` not yet marked a candidate? (Only an existing
        // fact can be over-deleted, and each is marked once.)
        let is_fresh_existing =
            |candidates: &HashMap<String, HashMap<u64, DerivedFact<T>>>,
             relations: &HashMap<String, Relation<T>>,
             pred: &str,
             fid: u64| {
                relations.get(pred).is_some_and(|r| r.total.contains_key(&fid))
                    && !candidates.get(pred).is_some_and(|c| c.contains_key(&fid))
            };

        // ── Seed: candidates with a derivation through a deleted base fact ──
        let mut round: HashMap<String, HashMap<u64, DerivedFact<T>>> = HashMap::new();
        for clause in &clauses {
            let pred_id = pred_ids[&clause.head_pred];
            for b in clause.base_leg_indices() {
                let rows = self.eval_clause(clause, relations, Some(b))?;
                self.check_intermediate(stratum.index, &rows)?;
                for head_row in rows {
                    let fid = fact_id(pred_id, &head_row);
                    if is_fresh_existing(&candidates, relations, &clause.head_pred, fid) {
                        round
                            .entry(clause.head_pred.clone())
                            .or_default()
                            .entry(fid)
                            .or_insert(DerivedFact { key: head_row, tag: T::one() });
                    }
                }
            }
        }
        // Commit the round into `candidates` and as each predicate's working Δ.
        for p in predicates {
            let fresh = round.remove(p).unwrap_or_default();
            for (fid, f) in &fresh {
                candidates
                    .entry(p.clone())
                    .or_default()
                    .insert(*fid, f.clone());
            }
            relations.get_mut(p).expect("stratum predicate present").delta = fresh;
        }

        // ── Loop: chase candidates through recursive legs to a fixpoint ──
        let mut iteration = 0usize;
        loop {
            let any = predicates
                .iter()
                .any(|p| relations.get(p).is_some_and(|r| !r.delta.is_empty()));
            if !any {
                break;
            }
            iteration += 1;
            if iteration > self.iteration_cap {
                return Err(ExecError {
                    code: ExecCode::IterationCap,
                    stratum: stratum.index,
                    detail: format!(
                        "over-delete did not reach fixpoint within {} iterations",
                        self.iteration_cap
                    ),
                });
            }
            self.check_deadline(stratum.index)?;

            let mut next: HashMap<String, HashMap<u64, DerivedFact<T>>> = HashMap::new();
            for clause in &clauses {
                let recs = clause.recursive_leg_indices(predicates);
                if recs.is_empty() {
                    continue;
                }
                let pred_id = pred_ids[&clause.head_pred];
                for &r in &recs {
                    let rows = self.eval_clause(clause, relations, Some(r))?;
                    self.check_intermediate(stratum.index, &rows)?;
                    for head_row in rows {
                        let fid = fact_id(pred_id, &head_row);
                        if is_fresh_existing(&candidates, relations, &clause.head_pred, fid)
                            && !next
                                .get(&clause.head_pred)
                                .is_some_and(|m| m.contains_key(&fid))
                        {
                            next.entry(clause.head_pred.clone())
                                .or_default()
                                .insert(fid, DerivedFact { key: head_row, tag: T::one() });
                        }
                    }
                }
            }
            for p in predicates {
                let fresh = next.remove(p).unwrap_or_default();
                for (fid, f) in &fresh {
                    candidates
                        .entry(p.clone())
                        .or_default()
                        .insert(*fid, f.clone());
                }
                relations.get_mut(p).expect("stratum predicate present").delta = fresh;
            }
        }

        for p in predicates {
            if let Some(r) = relations.get_mut(p) {
                r.delta.clear();
            }
        }
        Ok(candidates)
    }

    /// Whether some clause of `key`'s predicate derives exactly `key` from the CURRENT
    /// `relations` (`Total`) and base (`view`) — a head-bound body-satisfiability probe. The
    /// head variables are pinned to `key` (via [`head_bound_row`]); the body legs then read
    /// `Total`/base with those bindings fixed, so a single surviving row means `key` has a
    /// supporting derivation right now. The bounded primitive the DRed re-derive checks each
    /// over-deleted candidate with — `O(|candidates|)` probes, not a full re-evaluation.
    fn clause_derives_head(
        &self,
        clauses: &[Clause<'_>],
        relations: &HashMap<String, Relation<T>>,
        pred: &str,
        key: &[Value],
    ) -> ExecResult<bool> {
        for clause in clauses.iter().filter(|c| c.head_pred == pred) {
            let Some(init) = head_bound_row(clause.rule.head(), key) else {
                continue;
            };
            let mut rows = vec![init];
            for leg in &clause.plan.legs {
                if rows.is_empty() {
                    break;
                }
                // Every leg reads Total/base (no Δ): we are asking "is it derivable NOW".
                rows = self.apply_leg(leg, rows, relations, false)?;
            }
            if !rows.is_empty() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// DRed phase 2 — **re-derive** (spec §9.2, deletion). After [`over_delete`] has computed
    /// the candidate set and the caller has removed it from `Total`, restore every candidate
    /// that still has a derivation from the SURVIVING facts and the NEW base (`view` = the new
    /// base). A candidate is checked with [`clause_derives_head`]; restoring one can support
    /// another (recursion), so the scan repeats until a round restores nothing — the least
    /// fixpoint of "supported by surviving ∪ already-restored". Bounded by the candidate set,
    /// not the full relation.
    fn rederive(
        &self,
        plans: &[RulePlan],
        rules: &[&Rule],
        strat: &Stratification,
        relations: &mut HashMap<String, Relation<T>>,
        candidates: &HashMap<String, HashMap<u64, DerivedFact<T>>>,
    ) -> ExecResult<()> {
        let Some(stratum) = strat.strata.first() else {
            return Ok(());
        };
        let clauses = self.collect_clauses(&stratum.predicates, plans, rules);

        // The over-deleted facts to re-check (predicate, fact_id, key).
        let mut pending: Vec<(String, u64, Box<[Value]>)> = candidates
            .iter()
            .flat_map(|(p, m)| m.iter().map(move |(fid, f)| (p.clone(), *fid, f.key.clone())))
            .collect();

        loop {
            let mut restored_any = false;
            let mut still_pending: Vec<(String, u64, Box<[Value]>)> = Vec::new();
            for (pred, fid, key) in pending {
                if self.clause_derives_head(&clauses, relations, &pred, &key)? {
                    relations
                        .get_mut(&pred)
                        .expect("candidate predicate present")
                        .total
                        .insert(fid, DerivedFact { key, tag: T::one() });
                    restored_any = true;
                } else {
                    still_pending.push((pred, fid, key));
                }
            }
            pending = still_pending;
            // Fixpoint: stop when a full pass restores nothing (the remaining candidates have
            // no surviving support) or everything has been restored.
            if !restored_any || pending.is_empty() {
                break;
            }
        }
        Ok(())
    }

    /// why(): find ONE supporting derivation of `pred(key)` from the current `relations`
    /// (`Total`) and base (`view`) — the head-bound body replay of [`clause_derives_head`],
    /// but capturing the surviving row's body bindings instead of just a bool. Returns the
    /// first clause whose body is satisfiable for `key`, with the ground body facts that
    /// satisfied it; `None` if no clause derives `key` (it is not a fact, or only a base fact
    /// with no rule). Provenance is computed on demand — nothing is stored per derived fact.
    pub(crate) fn witness_fact(
        &self,
        clauses: &[Clause<'_>],
        relations: &HashMap<String, Relation<T>>,
        pred: &str,
        key: &[Value],
    ) -> ExecResult<Option<DerivationWitness>> {
        for clause in clauses.iter().filter(|c| c.head_pred == pred) {
            let Some(init) = head_bound_row(clause.rule.head(), key) else {
                continue;
            };
            let mut rows = vec![init];
            for leg in &clause.plan.legs {
                if rows.is_empty() {
                    break;
                }
                rows = self.apply_leg(leg, rows, relations, false)?;
            }
            // The first surviving row is one witnessing assignment; read each positive body
            // literal's now-ground tuple back out of it.
            if let Some(row) = rows.into_iter().next() {
                let mut body = Vec::new();
                for lit in clause.rule.body() {
                    if lit.is_positive() {
                        let atom = lit.atom();
                        if let Some(tuple) = bind_atom_args(atom, &row) {
                            body.push((atom.predicate().to_string(), tuple.into_boxed_slice()));
                        }
                    }
                }
                return Ok(Some(DerivationWitness {
                    rule_ast_hash: super::materialize::rule_ast_hash(clause.rule),
                    body,
                }));
            }
        }
        Ok(None)
    }

    /// why-NOT: explain why `pred(key)` is NOT derived by finding, for the rule that comes
    /// CLOSEST to firing, the first body premise that no binding satisfies (the unbound
    /// premise). Replays each clause for `pred` with the head bound to `key` exactly like
    /// [`Self::witness_fact`], but instead of requiring a surviving row it watches for the leg
    /// at which the partial bindings drop to empty — that leg is the gap. Returns `None` if the
    /// fact IS in fact derivable by some clause (no gap), or if no clause's head shape matches.
    pub(crate) fn witness_gap(
        &self,
        clauses: &[Clause<'_>],
        relations: &HashMap<String, Relation<T>>,
        pred: &str,
        key: &[Value],
    ) -> ExecResult<Option<GapWitness>> {
        let mut best: Option<GapWitness> = None;
        for clause in clauses.iter().filter(|c| c.head_pred == pred) {
            let Some(init) = head_bound_row(clause.rule.head(), key) else {
                continue;
            };
            let mut rows = vec![init];
            let mut satisfied: Vec<(String, Box<[Value]>)> = Vec::new();
            let mut gapped = false;
            for leg in &clause.plan.legs {
                let next = self.apply_leg(leg, rows, relations, false)?;
                if next.is_empty() {
                    // This premise has no satisfying binding given the prefix — the gap.
                    let cand = GapWitness {
                        rule_ast_hash: super::materialize::rule_ast_hash(clause.rule),
                        satisfied: satisfied.clone(),
                        failing_predicate: leg.literal.atom().predicate().to_string(),
                        failing_is_negative: leg.literal.is_negative(),
                    };
                    // Prefer the clause that got furthest (longest satisfied prefix).
                    if best.as_ref().map_or(true, |b| cand.satisfied.len() > b.satisfied.len()) {
                        best = Some(cand);
                    }
                    gapped = true;
                    break;
                }
                // The premise held: record its ground tuple (positive legs only) and continue.
                if leg.literal.is_positive() {
                    if let Some(tuple) = bind_atom_args(leg.literal.atom(), &next[0]) {
                        satisfied
                            .push((leg.literal.atom().predicate().to_string(), tuple.into_boxed_slice()));
                    }
                }
                rows = next;
            }
            if !gapped {
                // Some clause derives the fact → it is NOT a gap.
                return Ok(None);
            }
        }
        Ok(best)
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
        incremental: bool,
    ) -> ExecResult<()> {
        // Diagnostics for a mid-join `E-EXEC-003` raised in `apply_leg` (W8 Part 1).
        self.cur_stratum.set(stratum_idx);
        // Fresh relations for this stratum's predicates: from-scratch starts Total/Δ empty;
        // an incremental run keeps the pre-loaded prior Total and only clears Δ.
        for p in predicates {
            let rel = relations.entry(p.clone()).or_insert_with(Relation::new);
            rel.delta.clear();
        }

        // ── Event: stratum begin ──
        self.events
            .borrow_mut()
            .stratum_begin(stratum_idx, predicates.to_vec());

        // The clauses (plan + source rule) that belong to this stratum.
        let clauses = self.collect_clauses(predicates, plans, rules);

        // ── Seed (round 0 of semi-naive) ──
        //
        // From-scratch: every clause once with all legs reading their full source (Total for
        // a same-stratum derived leg is empty here, so the seed captures the non-recursive
        // base/lower-stratum derivations).
        //
        // Incremental: Total is pre-loaded with the prior run's facts, so a full seed would
        // re-derive everything (no saving). Instead fire ONE base-delta variant per positive
        // base leg — that leg reads only `ΔB` (the asserted base delta, via the delta view),
        // every other leg reads the full new base / prior Total — so the seed derives exactly
        // the facts that use a new base fact. The recursive Δ-loop below then propagates them
        // (insertion-monotone; the caller restricts this path to negation-free, single-
        // stratum, insert-only programs where that is sound).
        let mut seeded: HashMap<String, HashMap<u64, DerivedFact<T>>> = HashMap::new();
        for clause in &clauses {
            let pred_id = pred_ids[&clause.head_pred];
            let variants: Vec<Option<usize>> = if incremental {
                clause.base_leg_indices().into_iter().map(Some).collect()
            } else {
                vec![None]
            };
            for delta_leg in variants {
                let rows = self.eval_clause(clause, relations, delta_leg)?;
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
        // ── Empty-positive-derived-leg short-circuit (W9-iter2) ──
        //
        // A POSITIVE derived leg whose fact source is empty can extend no row, so the
        // clause derives nothing in this variant — whatever every other leg would have
        // produced. Returning before the leg loop matters because plan order can put the
        // empty leg LAST: every earlier generator/probe then runs in full only for the
        // empty join to drop all rows at the end (observed: js_property_access_full's
        // `pdef_meta` arm — zero PROPERTY_ASSIGNMENT facts on today's graphs by design,
        // see the pack header — burned ~13.7 s of attr-by-value fan-out per run for a
        // guaranteed-0-row clause). Source selection mirrors `join_derived` exactly: the
        // Δ-variant leg reads the delta, every other positive derived leg reads Total,
        // and a missing relation is the same "no facts" case `join_derived` already maps
        // to no rows. Negative legs are untouched (an empty negated relation PASSES rows).
        for (idx, leg) in clause.plan.legs.iter().enumerate() {
            if leg.literal.is_negative() {
                continue;
            }
            if let LegSource::Derived { name, .. } = &leg.source {
                let empty = match relations.get(name.as_str()) {
                    None => true,
                    Some(rel) => {
                        if delta_leg == Some(idx) {
                            rel.delta.is_empty()
                        } else {
                            rel.total.is_empty()
                        }
                    }
                };
                if empty {
                    return Ok(Vec::new());
                }
            }
        }

        // Start with a single empty binding row; each leg extends or filters it.
        let mut rows: Vec<BindRow> = vec![BindRow::new()];

        // Evaluation order. The static plan order is cost-optimized for a from-scratch run
        // (it leads with a selective generator). A semi-naive DELTA variant CAN do better by
        // leading with the Δ leg — enumerate the small Δ relation first, then probe the rest
        // per row — making the work proportional to |Δ| instead of a full base scan per round
        // (work-proportionality, spec §13). But this only wins when Δ is SMALL: with a large
        // Δ, leading with it turns the other legs into |Δ| per-row probes, which is worse than
        // the cost-optimized plan order. So lead with the Δ leg only when it is cheap — a
        // small derived Δ, or a base-delta leg (whose ΔB view is small by construction); large
        // Δ keeps the plan order. Reordering is safe: enumerating Δ needs no bound input and
        // binds the vars later legs consume, and the executor mode-checks each leg dynamically
        // from the row, independent of leg order.
        // Only an INCREMENTAL run reorders (its executor has a delta view installed); a
        // from-scratch `evaluate` keeps its cost-optimized plan order byte-for-byte, so the
        // live-dataset differential is unaffected.
        let n = clause.plan.legs.len();
        let lead_delta = self.delta_view.is_some() && match delta_leg {
            Some(d) if d < n => match &clause.plan.legs[d].source {
                // Base-delta seed (incremental insertion/deletion): the delta view is ΔB, small.
                LegSource::Base { .. } => true,
                // Recursive semi-naive Δ leg: lead only when this round's Δ is small.
                LegSource::Derived { name, .. } => relations
                    .get(name)
                    .is_some_and(|r| r.delta.len() <= DELTA_LEAD_THRESHOLD),
                LegSource::Builtin(_) => false,
            },
            _ => false,
        };
        match delta_leg {
            // Incremental small-Δ variant: lead with the Δ leg, then the rest in plan order.
            Some(d) if lead_delta => {
                rows = self.apply_leg(&clause.plan.legs[d], rows, relations, true)?;
                for (idx, leg) in clause.plan.legs.iter().enumerate() {
                    if idx == d {
                        continue;
                    }
                    if rows.is_empty() {
                        break;
                    }
                    rows = self.apply_leg(leg, rows, relations, false)?;
                }
            }
            // Plan order — the from-scratch hot path, allocation-free and byte-identical.
            _ => {
                for (idx, leg) in clause.plan.legs.iter().enumerate() {
                    if rows.is_empty() {
                        break;
                    }
                    let use_delta = delta_leg == Some(idx);
                    rows = self.apply_leg(leg, rows, relations, use_delta)?;
                }
            }
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
        leg: &crate::derive::plan::PlanLeg,
        rows: Vec<BindRow>,
        relations: &HashMap<String, Relation<T>>,
        use_delta: bool,
    ) -> ExecResult<Vec<BindRow>> {
        // W8 Part 1: the authoritative cancellation checkpoint of the join pipeline. The
        // join bodies below only SKIP remaining work when the flag is raised (they return
        // a truncated row set); this error is what discards that partial state, so a
        // cancelled run aborts (`E-EXEC-003`) instead of deriving from truncated rows.
        if self.is_cancelled() {
            return Err(ExecError {
                code: ExecCode::Cancelled,
                stratum: self.cur_stratum.get(),
                detail: "query cancelled by client (disconnect or explicit cancel)".to_string(),
            });
        }
        match &leg.source {
            // A derived predicate leg: join against this predicate's facts. A recursive leg
            // reading Δ (semi-naive) probes the delta; otherwise it probes Total. Negative
            // derived literals are anti-joins over the frozen lower stratum's Total.
            LegSource::Derived { name, .. } => {
                Ok(self.join_derived(leg, name, rows, relations, use_delta))
            }
            // A base leg flagged as the semi-naive delta leg (incremental maintenance):
            // read ONLY the asserted base delta `ΔB` via the delta view, so this clause
            // variant derives exactly the facts that use a new base fact. Positive-only —
            // a negated leg is never a delta leg (negation is stratified strictly below).
            LegSource::Base { .. } if use_delta && !leg.literal.is_negative() => {
                match self.delta_view {
                    Some(dv) => Ok(self.join_base_against(leg, rows, dv)),
                    // A delta-base leg with no delta view installed is a caller error; the
                    // safe behavior is no rows (this variant contributes nothing) rather
                    // than silently reading the full base as if it were the delta.
                    None => Ok(Vec::new()),
                }
            }
            // Base relations and builtins are served by the derive registry eval body, which
            // reads sorted runs / typed scans through the StorageView. Driving it per
            // partial row is the nested-loop join over the EDB/Total leg.
            LegSource::Base { .. } | LegSource::Builtin(_) => Ok(self.join_extensional(leg, rows)),
        }
    }

    /// Evaluate a POSITIVE base leg against an explicit `view` — the per-row registry eval,
    /// no fast paths. Used for a semi-naive delta-base leg that must read only `ΔB`; the
    /// non-incremental path ([`join_extensional`]) is left byte-identical so a from-scratch
    /// run is unaffected. Mirrors `join_extensional`'s positive projection exactly: each
    /// produced tuple binds the leg's free output slots into the row, agreeing on any
    /// already-bound shared variable.
    fn join_base_against(
        &self,
        leg: &crate::derive::plan::PlanLeg,
        rows: Vec<BindRow>,
        view: &dyn StorageView,
    ) -> Vec<BindRow> {
        let atom = leg.literal.atom();
        // P3: the eval resolves from the plan-time dispatch key — the `type`→node
        // string alias and the `incoming` name-match died at plan time. Only Base
        // legs reach here (`apply_leg` routes); a non-Base leg contributes no rows
        // (never a silent pass).
        let Some(def) = (match &leg.source {
            LegSource::Base { dispatch, .. } => builtin::lookup(base_dispatch_parts(dispatch).0),
            _ => None,
        }) else {
            return Vec::new();
        };
        let mut out: Vec<BindRow> = Vec::new();
        for row in rows {
            // W8 Part 1: skip remaining rows once cancelled (the truncated output is
            // discarded by `apply_leg`'s authoritative `E-EXEC-003`).
            if self.is_cancelled() {
                break;
            }
            let (spec, slot_vars) = resolve_arg_spec(atom, &row);
            let mut batch = Batch::new();
            if (def.eval)(view, &mut batch, &spec).is_err() {
                continue;
            }
            for produced in &batch.rows {
                let mut next = row.clone();
                let mut ok = true;
                for (slot, var) in &slot_vars {
                    match produced.get(*slot) {
                        Some(val) => {
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

    /// Join a derived-predicate leg into the partial rows.
    ///
    /// Positive: for each row, build the leg's bound key from the row's bindings, probe the
    /// chosen relation (Δ for a recursive semi-naive leg, else Total), and extend the row
    /// with the leg's free variables for every matching fact. Negative (`\+`): keep the row
    /// iff NO fact of the (frozen lower-stratum) relation matches the fully-bound key — the
    /// anti-join.
    fn join_derived(
        &self,
        leg: &crate::derive::plan::PlanLeg,
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

        if negated {
            // Anti-join: every VARIABLE arg is bound (planner ordered bound-first).
            //
            // A WILDCARD position is EXISTENTIAL: `\+ p(X, _)` drops a row iff ANY
            // fact matches on the non-wildcard columns, whatever the wildcard column
            // holds. `bind_atom_args` returns `None` on a wildcard, and reading that
            // `None` as "no match ⇒ row survives" made the whole negation silently
            // vacuous (ROFL conformance F1, live-probed: `q0(X) :- p0(X), \+ p2(X, _).`
            // returned every p0). Project both the fact keys and the per-row probe key
            // onto the NON-wildcard positions instead; the wildcard-free case keeps the
            // exact full-key set below (borrowed keys, no clones).
            let atom_args = atom.args();
            let wc_free: Vec<usize> = (0..atom_args.len())
                .filter(|&i| !matches!(atom_args[i], Term::Wildcard))
                .collect();
            if wc_free.len() < atom_args.len() {
                let keys: std::collections::HashSet<Vec<&Value>> = source
                    .values()
                    .filter(|f| f.key.len() == atom_args.len())
                    .map(|f| wc_free.iter().map(|&i| &f.key[i]).collect())
                    .collect();
                return par_join_rows(&rows, self.cancel_ref(), |row, out| {
                    let probe: Option<Vec<Value>> = wc_free
                        .iter()
                        .map(|&i| match &atom_args[i] {
                            Term::Const(s) => Some(Value::from_term_const(s)),
                            Term::Lit(v) => Some(v.clone()),
                            Term::Var(v) => row.get(v).cloned(),
                            // Unreachable: wc_free excludes wildcard positions.
                            Term::Wildcard => None,
                        })
                        .collect();
                    let present = match probe {
                        Some(key) => {
                            let borrowed: Vec<&Value> = key.iter().collect();
                            keys.contains(&borrowed)
                        }
                        // A variable position unbound for this row (the planner
                        // guarantees this does not happen for a safe rule): treated
                        // as "no match" — the row survives, matching the wildcard-free
                        // branch's behavior.
                        None => false,
                    };
                    if !present {
                        out.push(row.clone());
                    }
                });
            }
            // Wildcard-free: build the exact fact-key set ONCE; each row is then an O(1)
            // membership probe. (The per-row `values().any()` scan made every anti-join
            // O(rows × facts).) NOT cached (Part A exclusion): the source relation can
            // change between Δ-rounds, and the set borrows its keys from the relation
            // store.
            let keys: std::collections::HashSet<&[Value]> =
                source.values().map(|f| f.key.as_ref()).collect();
            return par_join_rows(&rows, self.cancel_ref(), |row, out| {
                let present = match bind_atom_args(atom, row) {
                    Some(key) => keys.contains(key.as_slice()),
                    // A key that cannot be fully bound is treated as "no match" — the row
                    // survives. The planner guarantees this does not happen for a safe rule.
                    None => false,
                };
                if !present {
                    out.push(row.clone());
                }
            });
        }

        // Positive: BUILD-ONCE hash-join. Index the relation by the leg's BOUND argument
        // positions (the probe key a row can compute), then probe per row and unify only
        // the candidate bucket. The per-row full-relation scan this replaces made every
        // helper-predicate join O(rows × facts) — the exec twin of the planner's
        // filter-before-generator lesson (observed: the method_calls pack spent
        // ~1.2 ms/row scanning a 1000-fact relation at n=20k, and timed out at 900 s on
        // the real graph).
        // A WILDCARD position is excluded even though the planner's pattern marks it
        // Bound (a wildcard is "bound" for placement feasibility — it needs nothing):
        // a probe key can never resolve it, and including it made `derived_probe_key`
        // return None on EVERY row, silently demoting the whole join to the defensive
        // per-row full scan (observed: `rtg_key(S, _)` at 22k rows x 5.7k facts = ~20 s
        // for one non-recursive rule, Wave 4). Excluding it keeps the hash probe on the
        // resolvable columns; `unify_atom` still applies the wildcard (matches anything).
        // (Independently hit by W9-iter2 on js_builtins' `bi_binding(F, LN, M, _)` leg
        // under a leading 69,871-row CALL scan — 69,871 × 484 facts ≈ 34M per-row unify
        // scans, ~10.8 s per pack, for a join the (F)-keyed build-once index serves in
        // milliseconds.)
        let atom_args = atom.args();
        let bound_positions: Vec<usize> = leg
            .pattern
            .iter()
            .enumerate()
            .filter(|(i, m)| {
                **m == crate::derive::builtin::ArgMode::Bound
                    && !matches!(atom_args[*i], Term::Wildcard)
            })
            .map(|(i, _)| i)
            .collect();

        if bound_positions.is_empty() {
            // No bound position: a genuine cross-extend — the scan IS the join.
            for row in rows {
                // W8 Part 1: cancellation skip (see `apply_leg`).
                if self.is_cancelled() {
                    break;
                }
                for fact in source.values() {
                    if let Some(extended) = unify_atom(atom, &fact.key, &row) {
                        out.push(extended);
                    }
                }
            }
            return out;
        }

        // NOT cached (Part A exclusion, documented on [`IndexCaches`]): a recursive leg's
        // source (Δ / same-stratum Total) genuinely changes every iteration, and the index
        // borrows `&DerivedFact` out of the relation store — an executor-lifetime cache
        // cannot hold those borrows. The build is an in-memory O(|relation|) pass; the
        // storage-scan rebuilds Part A targets are the measured cost driver.
        let arity = atom.args().len();
        let mut index: HashMap<Vec<Value>, Vec<&DerivedFact<T>>> = HashMap::new();
        for fact in source.values() {
            if fact.key.len() != arity {
                continue; // an arity mismatch can never unify
            }
            let k: Vec<Value> = bound_positions.iter().map(|&i| fact.key[i].clone()).collect();
            index.entry(k).or_default().push(fact);
        }
        par_join_rows(&rows, self.cancel_ref(), |row, out| {
            match derived_probe_key(atom, &bound_positions, row) {
                Some(probe) => {
                    if let Some(bucket) = index.get(&probe) {
                        for fact in bucket {
                            if let Some(extended) = unify_atom(atom, &fact.key, row) {
                                out.push(extended);
                            }
                        }
                    }
                }
                // Defensive: the planner's pattern said Bound but the row cannot resolve
                // the key — fall back to the full scan for THIS row (correctness over
                // speed; must not silently drop the row).
                None => {
                    for fact in source.values() {
                        if let Some(extended) = unify_atom(atom, &fact.key, row) {
                            out.push(extended);
                        }
                    }
                }
            }
        })
    }

    /// Join a base/builtin leg into the partial rows via the derive registry eval body.
    ///
    /// For each partial row, resolve the literal's arguments to an [`ArgSpec`] (bound
    /// values from the row, free output slots for unbound variables), run the builtin
    /// `eval` against the [`StorageView`], and extend the row with one output binding per
    /// produced [`Batch`] row. A filter/function that captures nothing produces the empty
    /// row on a pass (the row survives unchanged) or no rows on a non-match (the row is
    /// dropped). Coercion misses are tuple non-matches, never errors.
    fn join_extensional(
        &self,
        leg: &crate::derive::plan::PlanLeg,
        rows: Vec<BindRow>,
    ) -> Vec<BindRow> {
        let atom = leg.literal.atom();
        let negated = leg.literal.is_negative();
        // P3 (§3.4 normative 1): a base leg's serving physics come from the
        // plan-resolved `(PredicateId, SortOrder)` dispatch key — the `type`→node
        // string alias and the `incoming` name-match died at plan time. Builtin
        // legs keep their registry name key (functions are a name registry, not
        // predicates in the catalog).
        let dispatch: Option<BaseDispatch> = match &leg.source {
            LegSource::Base { dispatch, .. } => Some(*dispatch),
            _ => None,
        };
        let lookup_name: &str = match &dispatch {
            Some(d) => base_dispatch_parts(d).0,
            None => atom.predicate(),
        };
        let Some(def) = builtin::lookup(lookup_name) else {
            // Reachable ONLY for the closed query-engine-shared function set the
            // planner accepts without a registry entry (`path` / `parent_function` /
            // `resolved_import`): a positive leg is an empty relation, a negated one
            // a vacuous anti-join. An UNREGISTERED predicate can no longer reach
            // here: P3 plan-time classification is total over registered names and
            // aborts with E-CAT-002 otherwise, and a §3.1 open-space (body-only)
            // predicate is classified Derived and served by `join_derived`'s
            // missing-relation arm — the pre-P3 silently-empty/vacuous-negation
            // class for arbitrary unknown names is dead (round-009 H3).
            debug_assert!(
                matches!(
                    atom.predicate(),
                    "path" | "parent_function" | "resolved_import"
                ),
                "unregistered predicate '{}' reached join_extensional — the E-CAT-002 \
                 plan gate must reject it",
                atom.predicate()
            );
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
            if let Some(membership) = self.build_anti_join_set(&leg.source, atom) {
                let view = self.view;
                let eval = def.eval;
                return par_join_rows(&rows, self.cancel_ref(), |row, out| {
                    match project_anti_join_key(atom, row) {
                        // Row's projected key tuple present in the membership set ⇒ a match
                        // exists ⇒ the anti-join drops the row. Absent ⇒ the row survives.
                        Some(key) => {
                            if !membership.contains(&key) {
                                out.push(row.clone());
                            }
                        }
                        // A key position is unexpectedly unbound for this row (the planner
                        // guarantees this does not happen for a safe rule). Fall back to the
                        // exact per-row eval for this row so correctness never depends on the
                        // fast path's preconditions.
                        None => {
                            if anti_join_row_passes_on(view, eval, atom, row) {
                                out.push(row.clone());
                            }
                        }
                    }
                });
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
        if !negated
            && matches!(&dispatch, Some(d) if d.strategy == crate::derive::catalog::PhysStrategy::Attribute && d.arity == 3)
        {
            if let Some(joined) = self.join_attr_generator_built_once(leg, atom, &rows) {
                return joined;
            }
        }

        // ── Cached free GENERATORS (Part A) ──
        //
        // A fully-free `edge`/`incoming`/`node` generator leg re-scans storage on EVERY
        // call: every Δ-round of a recursive stratum re-evaluates the clause and re-leads
        // with the same generator, and multiple clauses of one program lead with the same
        // one. Serve it from the executor-cached scan-order tuple list instead — built
        // once per (type, order) per evaluation, emission byte-identical to the per-row
        // eval's (same tuples, same scan order). `build_once_min_rows == usize::MAX` (the
        // documented force-per-row sentinel) disables these like every other fast path.
        if !negated {
            use crate::derive::catalog::PhysStrategy as PS;
            let gen = match &dispatch {
                Some(d) if d.strategy == PS::Adjacency && d.arity == 3 => {
                    self.join_edge_generator_cached(base_dispatch_parts(d).1, def.eval, atom, leg, &rows)
                }
                Some(d) if d.strategy == PS::Attribute && d.arity == 2 => {
                    self.join_node_generator_cached(def.eval, atom, leg, &rows)
                }
                _ => None,
            };
            if let Some(joined) = gen {
                return joined;
            }
        }

        // ── Set-at-once positive base-leg joins (build-once, the 4th q-error layer) ──
        //
        // On the real LSM store every per-row registry eval is a storage probe; a base leg
        // fed tens of thousands of partial rows becomes as many LSM probes (in-memory fast
        // / LSM catastrophically slow, same algorithm — per-probe storage cost is the
        // bottleneck). For the three dominant row-keyed leg shapes the storage side can be
        // built ONCE (one typed scan / one batched node read) and hash-probed per row —
        // the extensional twin of [`Self::join_derived`]'s build-once index. Every shape
        // outside these, and every row whose key cannot be resolved exactly the way the
        // per-row path would resolve it, keeps the exact per-row eval (correctness floor;
        // negative legs are served by the set-at-once anti-join above or per row).
        if !negated && rows.len() >= self.build_once_min_rows {
            use crate::derive::catalog::PhysStrategy as PS;
            // P3 (§3.4 normative 1): ONE generalized build-once dispatch keyed
            // (PredicateId, SortOrder, bound_column_mask) — the id+order half is the
            // plan-resolved physics selected here, the bound mask is the leg's
            // pattern each instance specializes on (probe endpoints / bound id /
            // key columns). The former four string-name arms are the four
            // instances of the one form "build the hash side from one scan, probe
            // O(1) per row".
            let fast = match &dispatch {
                Some(d) if d.strategy == PS::Adjacency && d.arity == 3 => {
                    self.join_edge_bound_built_once(base_dispatch_parts(d).1, def.eval, atom, leg, &rows)
                }
                Some(d) if d.strategy == PS::Attribute && d.arity == 2 => {
                    self.join_node_membership_built_once(def.eval, atom, leg, &rows)
                }
                Some(d) if d.strategy == PS::Attribute && d.arity == 3 => {
                    self.join_attr_bound_id_built_once(def.eval, atom, leg, &rows)
                }
                // `edge_attr` is a builtin FUNCTION (no runs, no catalog decl)
                // that nonetheless carries a build-once instance: the explicitly
                // documented builtin-side dispatch of round-009 H4 / spec Q2 — a
                // registry-name key, deliberately NOT folded into the predicate
                // key space.
                None if lookup_name == "edge_attr" => {
                    self.join_edge_attr_built_once(def.eval, atom, leg, &rows)
                }
                _ => None,
            };
            if let Some(joined) = fast {
                return joined;
            }
        }

        // Generic per-row registry eval (the reference path). Row-parallel at scale: each
        // row's eval reads only the shared immutable view (the trait carries `Sync`), and
        // per-row purity holds for every registry builtin including Function builtins and
        // negated existence probes.
        let view = self.view;
        let eval = def.eval;
        par_join_rows(&rows, self.cancel_ref(), |row, out| {
            if negated {
                // Negative base/builtin leg = anti-join. The planner placed it bound-first,
                // so every captured Var is already bound; any free arg is a wildcard
                // existence probe. The row survives iff the eval produced NO matching tuple
                // (matches are never bound back — a negated literal contributes membership,
                // not bindings). An eval Err drops the row (the registry eval returns Err
                // only for a genuine planning fault, impossible on a planned leg).
                let (spec, _slot_vars) = resolve_arg_spec(atom, row);
                let mut batch = Batch::new();
                if eval(view, &mut batch, &spec).is_err() {
                    return;
                }
                if batch.rows.is_empty() {
                    out.push(row.clone());
                }
            } else {
                positive_row_via_eval_on(view, eval, atom, row, out);
            }
        })
    }

    /// Cached fully-free `edge`/`incoming` GENERATOR (Part A), or `None` if the leg is
    /// not the free-generator shape (a bound endpoint, a constant endpoint, a non-const
    /// type — the caller then tries the bound-probe build-once path / per-row eval).
    ///
    /// `eval_edge_dir`'s both-free mode runs one full `scan_edges_by_type` per CALL; this
    /// serves the same tuples from one cached scan-order pair list per `(type, order)`,
    /// replicating the per-row eval's emission exactly: per scanned edge, each free
    /// endpoint VARIABLE binds `Value::Id` with the shared-variable agreement check
    /// (`edge(X, X, "T")` keeps only self-loops), wildcards bind nothing (one pass row
    /// per tuple). A row that already binds an endpoint variable would put the per-row
    /// eval in keyed-probe mode — exact per-row fallback for that row.
    fn join_edge_generator_cached(
        &self,
        order: EdgeOrder,
        eval: BuiltinEval,
        atom: &Atom,
        leg: &crate::derive::plan::PlanLeg,
        rows: &[BindRow],
    ) -> Option<Vec<BindRow>> {
        use super::builtin::ArgMode;

        // The documented force-per-row sentinel disables every fast path.
        if self.build_once_min_rows == usize::MAX {
            return None;
        }
        let args = atom.args();
        if args.len() != 3 {
            return None;
        }
        let ty: String = match &args[2] {
            Term::Const(s) => s.clone(),
            Term::Lit(v) => v.as_str(),
            _ => return None,
        };
        // Both endpoints must be free: a wildcard, or a variable the planner left Free.
        for i in [0usize, 1] {
            match &args[i] {
                Term::Wildcard => {}
                Term::Var(_) => {
                    if leg.pattern.get(i) == Some(&ArgMode::Bound) {
                        return None;
                    }
                }
                _ => return None,
            }
        }
        // Only build/fetch the index if some row actually needs the free enumeration: the
        // executor's Δ-lead reorder can run a plan-Free leg AFTER the Δ leg bound its
        // variables, putting every row on the keyed per-row path — building a full-scan
        // cache there would charge an incremental run O(base) storage work for nothing
        // (the work-proportionality gate). All-keyed rows ⇒ `None` ⇒ the exact per-row
        // eval, identical to this path's own per-row fallback.
        let row_needs_enumeration = |row: &BindRow| {
            args[..2].iter().all(|t| match t {
                Term::Var(v) => !row.contains_key(v),
                _ => true, // a wildcard never binds
            })
        };
        if !rows.iter().any(row_needs_enumeration) {
            return None;
        }

        // ── The tuple list: one typed scan, in scan order, cached per (type, order). ──
        let view = self.view;
        let pairs: Arc<Vec<(u128, u128)>> =
            self.caches.get_or_build(&self.caches.edge_pairs, (ty.clone(), order), || {
                view.scan_edges_by_type(&ty, order)
                    .map(|e| match order {
                        EdgeOrder::Forward => (e.src, e.dst),
                        EdgeOrder::Reverse => (e.dst, e.src),
                    })
                    .collect()
            });

        let out = par_join_rows(rows, self.cancel_ref(), |row, out| {
            // Defensive: a row-bound endpoint variable means the per-row eval would
            // resolve it Bound and take the keyed path — run it exactly for this row.
            for i in [0usize, 1] {
                if let Term::Var(v) = &args[i] {
                    if row.contains_key(v) {
                        positive_row_via_eval_on(view, eval, atom, row, out);
                        return;
                    }
                }
            }
            for &(near, far) in pairs.iter() {
                let mut next = row.clone();
                let mut ok = true;
                for (i, val) in [(0usize, near), (1usize, far)] {
                    if let Term::Var(v) = &args[i] {
                        match next.get(v) {
                            // The shared-variable agreement check (edge(X, X, "T")):
                            // the second occurrence must equal the first.
                            Some(existing) => {
                                if *existing != Value::Id(val) {
                                    ok = false;
                                    break;
                                }
                            }
                            None => {
                                next.insert(v.clone(), Value::Id(val));
                            }
                        }
                    }
                }
                if ok {
                    out.push(next);
                }
            }
        });
        Some(out)
    }

    /// Cached fully-free `node`/`type` GENERATOR (Part A) — the node twin of
    /// [`Self::join_edge_generator_cached`]. `eval_node`'s free-id mode runs one full
    /// `scan_nodes_by_type` per CALL; this serves the same ids from one cached scan-order
    /// list per type: a free id variable binds `Value::Id` per scanned node, a wildcard
    /// id passes the row once per scanned node. `None` for any other shape (bound or
    /// constant id, non-const type) — the per-row eval stays exact.
    fn join_node_generator_cached(
        &self,
        eval: BuiltinEval,
        atom: &Atom,
        leg: &crate::derive::plan::PlanLeg,
        rows: &[BindRow],
    ) -> Option<Vec<BindRow>> {
        use super::builtin::ArgMode;

        if self.build_once_min_rows == usize::MAX {
            return None;
        }
        let args = atom.args();
        if args.len() != 2 {
            return None;
        }
        let ty: String = match &args[1] {
            Term::Const(s) => s.clone(),
            Term::Lit(v) => v.as_str(),
            _ => return None,
        };
        match &args[0] {
            Term::Wildcard => {}
            Term::Var(_) => {
                if leg.pattern.first() == Some(&ArgMode::Bound) {
                    return None;
                }
            }
            _ => return None,
        }
        // As in the edge generator: only build the cache if some row actually needs the
        // free enumeration (the Δ-lead reorder can bind a plan-Free id variable at run
        // time, putting every row on the keyed point-check path).
        let row_needs_enumeration = |row: &BindRow| match &args[0] {
            Term::Var(v) => !row.contains_key(v),
            _ => true,
        };
        if !rows.iter().any(row_needs_enumeration) {
            return None;
        }

        // ── The id list: one typed scan, in scan order, cached per type. ──
        let view = self.view;
        let ids: Arc<Vec<u128>> =
            self.caches.get_or_build(&self.caches.node_ids, ty.clone(), || {
                view.scan_nodes_by_type(&ty).map(|n| n.id).collect()
            });

        let out = par_join_rows(rows, self.cancel_ref(), |row, out| {
            match &args[0] {
                Term::Var(v) if row.contains_key(v) => {
                    // Row-bound id variable: the per-row eval would run the point check —
                    // exact per-row fallback for this row.
                    positive_row_via_eval_on(view, eval, atom, row, out);
                }
                Term::Var(v) => {
                    for &id in ids.iter() {
                        let mut next = row.clone();
                        next.insert(v.clone(), Value::Id(id));
                        out.push(next);
                    }
                }
                // Wildcard id: existence per scanned node — one pass row per match.
                Term::Wildcard => {
                    for _ in ids.iter() {
                        out.push(row.clone());
                    }
                }
                // Screened by the shape check; defensive.
                _ => positive_row_via_eval_on(view, eval, atom, row, out),
            }
        });
        Some(out)
    }

    /// Build-once hash-join for a positive `edge`/`incoming` leg with a constant type and
    /// at least one row-bound endpoint, or `None` if the leg's shape is not the build-once
    /// case (the caller then keeps the exact per-row keyed-probe fallback).
    ///
    /// Instead of one keyed storage probe per partial row (`O(rows)` LSM probes), this
    /// makes ONE pass over the typed edge scan, bucketing tuples by the endpoint(s) the
    /// rows can resolve — `near → [far]`, `far → [near]`, or a `(near, far)` multiplicity
    /// map when both endpoints are row-bound — then hash-probes per row
    /// (`O(edges_of_type + rows)`). Bucket `Vec`s preserve the scan's tuple multiset, so
    /// the fast path produces exactly the rows (and row multiplicities) the per-row evals
    /// would have. An adjacency map for one edge type is bounded by that type's edge count
    /// (≤ ~200k entries on the dogfood graph — acceptable).
    ///
    /// Shape requirements (else `None`, fall back):
    /// * the type position (arg 2) is a ground constant (its string surface equals what
    ///   the per-row path derives: `Value::from_term_const(s).as_str() == s` for any
    ///   const; a typed literal surfaces as its decimal text);
    /// * at least one endpoint is a planner-Bound VARIABLE (the probe key each row
    ///   carries); the planner's pattern is authoritative on boundness;
    /// * a non-probe endpoint is a variable or a wildcard — a constant endpoint is rare
    ///   and stays on the per-row path (correctness over coverage).
    ///
    /// Per-row defensive fallbacks (exact per-row eval for THAT row): a probe variable the
    /// row does not bind, or a probe binding with no id surface — both change the per-row
    /// eval's access path/mode, so the only safe equivalence is to run it.
    fn join_edge_bound_built_once(
        &self,
        order: EdgeOrder,
        eval: BuiltinEval,
        atom: &Atom,
        leg: &crate::derive::plan::PlanLeg,
        rows: &[BindRow],
    ) -> Option<Vec<BindRow>> {
        use super::builtin::ArgMode;

        let args = atom.args();
        if args.len() != 3 {
            return None;
        }
        let ty: String = match &args[2] {
            Term::Const(s) => s.clone(),
            Term::Lit(v) => v.as_str(),
            // A row-bound variable type would need one bucket map per distinct type;
            // out of scope — fall back.
            _ => return None,
        };
        // A probe endpoint is a planner-Bound VARIABLE: its id comes from each row.
        let near_probe =
            matches!(&args[0], Term::Var(_)) && leg.pattern.first() == Some(&ArgMode::Bound);
        let far_probe =
            matches!(&args[1], Term::Var(_)) && leg.pattern.get(1) == Some(&ArgMode::Bound);
        if !near_probe && !far_probe {
            // No row-bound endpoint: the leg is a generator/cross-extend — the per-row
            // path's full typed scan IS the right access already.
            return None;
        }
        for (i, probe) in [(0usize, near_probe), (1usize, far_probe)] {
            if !probe && matches!(&args[i], Term::Const(_) | Term::Lit(_)) {
                return None;
            }
        }

        // Map a storage EdgeRow's `(src, dst)` to this view's `(near, far)` per direction
        // — the same mapping `eval_edge_dir` and `build_anti_join_set` apply.
        let near_far = |src: u128, dst: u128| match order {
            EdgeOrder::Forward => (src, dst),
            EdgeOrder::Reverse => (dst, src),
        };

        // ── The hash side: ONE typed edge scan, cached on (type, order, shape) for the
        //    executor's lifetime (Part A — the view is immutable, so the index is too;
        //    previously rebuilt on EVERY call, i.e. per leg per clause per Δ-round).
        let shape = if near_probe && far_probe {
            EdgeProbeShape::Both
        } else if near_probe {
            EdgeProbeShape::ByNear
        } else {
            EdgeProbeShape::ByFar
        };
        let view = self.view;
        let index: Arc<EdgeIndex> =
            self.caches
                .get_or_build(&self.caches.edge, (ty.clone(), order, shape), || match shape {
                    EdgeProbeShape::Both => {
                        let mut m: HashMap<(u128, u128), usize> = HashMap::new();
                        for e in view.scan_edges_by_type(&ty, order) {
                            let (near, far) = near_far(e.src, e.dst);
                            *m.entry((near, far)).or_insert(0) += 1;
                        }
                        EdgeIndex::Both(m)
                    }
                    EdgeProbeShape::ByNear => {
                        let mut m: HashMap<u128, Vec<u128>> = HashMap::new();
                        for e in view.scan_edges_by_type(&ty, order) {
                            let (near, far) = near_far(e.src, e.dst);
                            m.entry(near).or_default().push(far);
                        }
                        EdgeIndex::ByNear(m)
                    }
                    EdgeProbeShape::ByFar => {
                        let mut m: HashMap<u128, Vec<u128>> = HashMap::new();
                        for e in view.scan_edges_by_type(&ty, order) {
                            let (near, far) = near_far(e.src, e.dst);
                            m.entry(far).or_default().push(near);
                        }
                        EdgeIndex::ByFar(m)
                    }
                });

        // ── Probe per row (row-parallel at scale; index + view shared immutable). ──
        let out = par_join_rows(rows, self.cancel_ref(), |row, out| {
            // Resolve a probe endpoint the way `resolve_arg_spec` + `bound_id` would:
            // the row's value, id-parsed. `Err` ⇒ the per-row eval would take a different
            // mode/access path ⇒ exact per-row fallback for this row.
            let resolve = |i: usize| -> Result<u128, ()> {
                match &args[i] {
                    Term::Var(v) => match row.get(v) {
                        Some(val) => val.as_id().ok_or(()),
                        None => Err(()),
                    },
                    _ => Err(()),
                }
            };
            match &*index {
                EdgeIndex::Both(m) => match (resolve(0), resolve(1)) {
                    (Ok(near), Ok(far)) => {
                        // Both bound: membership with multiplicity — the per-row eval
                        // emits one pass per matching stored tuple.
                        let count = m.get(&(near, far)).copied().unwrap_or(0);
                        for _ in 0..count {
                            out.push(row.clone());
                        }
                    }
                    _ => positive_row_via_eval_on(view, eval, atom, row, out),
                },
                EdgeIndex::ByNear(m) => probe_edge_bucket(view, m, 0, 1, eval, atom, row, out),
                EdgeIndex::ByFar(m) => probe_edge_bucket(view, m, 1, 0, eval, atom, row, out),
            }
        });
        Some(out)
    }

    /// Build-once membership probe for a positive `node`/`type` leg with a constant type
    /// and a row-bound id variable, or `None` if the leg's shape is not the build-once
    /// case (the caller then keeps the exact per-row point-lookup fallback).
    ///
    /// Instead of one `get_node` point probe per partial row, this builds the type's id
    /// set in ONE typed scan (the same scan the generator mode and the set-at-once
    /// anti-join use) and probes it O(1) per row. Per-row parity: `get_node(id)` exists
    /// with `node_type == ty` ⟺ `id` appears in `scan_nodes_by_type(ty)` — one pass row
    /// per match, the row unchanged (the id is bound, nothing is captured). A bound value
    /// with no id surface produces no tuple on the per-row path (`bound_id` → `None` →
    /// empty batch), so the row is dropped identically here.
    fn join_node_membership_built_once(
        &self,
        eval: BuiltinEval,
        atom: &Atom,
        leg: &crate::derive::plan::PlanLeg,
        rows: &[BindRow],
    ) -> Option<Vec<BindRow>> {
        use super::builtin::ArgMode;

        let args = atom.args();
        if args.len() != 2 {
            return None;
        }
        let ty: String = match &args[1] {
            Term::Const(s) => s.clone(),
            Term::Lit(v) => v.as_str(),
            // A row-bound variable type is a per-distinct-id point check; rare — fall back.
            _ => return None,
        };
        let id_var = match (&args[0], leg.pattern.first()) {
            (Term::Var(v), Some(&ArgMode::Bound)) => v,
            // A free id is the generator (single scan already); a constant id is a point
            // probe the per-row path handles.
            _ => return None,
        };

        // ── The membership set: one typed node scan, cached per type for the executor's
        //    lifetime (Part A; previously rebuilt on every call).
        let view = self.view;
        let members: Arc<HashSet<u128>> =
            self.caches.get_or_build(&self.caches.node_members, ty.clone(), || {
                view.scan_nodes_by_type(&ty).map(|n| n.id).collect()
            });

        let out = par_join_rows(rows, self.cancel_ref(), |row, out| {
            match row.get(id_var) {
                // Planner said Bound but the row lacks the binding — exact per-row eval.
                None => positive_row_via_eval_on(view, eval, atom, row, out),
                Some(val) => match val.as_id() {
                    // Per-row parity: no id surface ⇒ no tuple ⇒ the row is dropped.
                    None => {}
                    Some(id) => {
                        if members.contains(&id) {
                            out.push(row.clone());
                        }
                    }
                },
            }
        });
        Some(out)
    }

    /// Build-once point-column join for a positive `attr(Id, "key", V)` leg with a
    /// row-bound id variable and a constant key, or `None` if the leg's shape is not the
    /// build-once case (the caller then keeps the exact per-row `get_node` fallback).
    ///
    /// The per-row path issues one `get_node` LSM point probe per partial row (the
    /// `attr(C, "name", F)` leg of the method-calls pack: ~69k probes on the dogfood
    /// graph). This collects the DISTINCT bound ids the rows actually need first (rows
    /// often repeat ids — dedup alone cuts probes), then fetches their node rows once:
    /// per-distinct-id probes below [`ATTR_DISTINCT_SCAN_THRESHOLD`], or ONE sequential
    /// sorted-node pass above it (a single scan beats tens of thousands of random point
    /// reads). Each row is then served from the in-memory map with `eval_attr`'s exact
    /// bound-id semantics: missing node ⇒ drop; key outside the first-class surface ⇒
    /// coercion miss ⇒ drop (the per-row path's miss counter lives on a per-row `Batch`
    /// the executor discards, so dropping is observably identical); free value ⇒ bind the
    /// column as a `Str`; bound value ⇒ §5 `coerce_eq` against the column surface.
    fn join_attr_bound_id_built_once(
        &self,
        eval: BuiltinEval,
        atom: &Atom,
        leg: &crate::derive::plan::PlanLeg,
        rows: &[BindRow],
    ) -> Option<Vec<BindRow>> {
        use super::builtin::{coerce_eq, first_class_attr, ArgMode, CoerceEq};
        use super::storage_glue::{NodeRow, Relation, Row, SortOrder};

        let args = atom.args();
        if args.len() != 3 {
            return None;
        }
        let id_var = match (&args[0], leg.pattern.first()) {
            (Term::Var(v), Some(&ArgMode::Bound)) => v,
            // A free id is the generator (served by `join_attr_generator_built_once`); a
            // constant id is a point probe the per-row path handles.
            _ => return None,
        };
        let key: String = match &args[1] {
            Term::Const(s) => s.clone(),
            Term::Lit(v) => v.as_str(),
            // A variable/wildcard key cannot pre-commit a column read — fall back.
            _ => return None,
        };

        // ── The node rows the rows' bound ids resolve to. Part A: the first call whose
        //    DISTINCT-id count crosses [`ATTR_DISTINCT_SCAN_THRESHOLD`] builds the FULL
        //    `id → NodeRow` map in one sorted-node pass and caches it for the executor's
        //    lifetime (the uncached code made that same full pass on EVERY such call,
        //    keeping only that call's ids); every later call of any size is served from
        //    it. Below the threshold (and before any big call), per-DISTINCT-id point
        //    probes win and stay uncached — they are already proportional to the rows.
        //    Both sources give identical lookups: `get_node(id)` ≡ the sorted run's row
        //    for `id` (same snapshot, same columns).
        let view = self.view;
        let cached_full: Option<Arc<HashMap<u128, NodeRow>>> =
            self.caches.node_rows_full.borrow().clone();
        let node_rows: Arc<HashMap<u128, NodeRow>> = match cached_full {
            Some(full) => {
                self.caches.hits.set(self.caches.hits.get() + 1);
                full
            }
            None => {
                // Collect the distinct ids the rows actually need (rows often repeat ids —
                // dedup alone cuts probes).
                let mut distinct: HashSet<u128> = HashSet::new();
                for row in rows {
                    if let Some(id) = row.get(id_var).and_then(Value::as_id) {
                        distinct.insert(id);
                    }
                }
                if distinct.len() >= ATTR_DISTINCT_SCAN_THRESHOLD {
                    let mut m: HashMap<u128, NodeRow> = HashMap::new();
                    for r in view.sorted_run(Relation::Nodes, SortOrder::NodeById) {
                        if let Row::Node(n) = r {
                            m.insert(n.id, n);
                        }
                    }
                    let full = Arc::new(m);
                    *self.caches.node_rows_full.borrow_mut() = Some(Arc::clone(&full));
                    self.caches.builds.set(self.caches.builds.get() + 1);
                    full
                } else {
                    Arc::new(
                        distinct
                            .iter()
                            .filter_map(|&id| view.get_node(id).map(|n| (id, n)))
                            .collect(),
                    )
                }
            }
        };

        // ── Serve each row from the map with `eval_attr`'s exact bound-id semantics
        //    (row-parallel at scale). ──
        let out = par_join_rows(rows, self.cancel_ref(), |row, out| {
            let Some(val) = row.get(id_var) else {
                // Planner said Bound but the row lacks the binding — exact per-row eval.
                positive_row_via_eval_on(view, eval, atom, row, out);
                return;
            };
            let Some(id) = val.as_id() else {
                // Per-row parity: no id surface ⇒ `bound_id` → None ⇒ empty batch ⇒ drop.
                return;
            };
            let Some(node) = node_rows.get(&id) else {
                // Bound id not present at this generation ⇒ legitimately empty ⇒ drop.
                return;
            };
            let Some(column) = first_class_attr(node, &key) else {
                // Key outside the first-class surface ⇒ coercion miss ⇒ tuple non-match.
                return;
            };
            match &args[2] {
                // Presence of the column is enough (one pass row).
                Term::Wildcard => out.push(row.clone()),
                // Equality check with §5 coercion — `resolve_arg_spec` binds a const via
                // `Value::from_term_const`, exactly reproduced here.
                Term::Const(s) => {
                    if matches!(coerce_eq(&column, &Value::from_term_const(s)), CoerceEq::Match) {
                        out.push(row.clone());
                    }
                }
                Term::Lit(v) => {
                    if matches!(coerce_eq(&column, v), CoerceEq::Match) {
                        out.push(row.clone());
                    }
                }
                Term::Var(v) => match row.get(v) {
                    // Shared variable already bound by the row: the per-row path resolves
                    // it to a Bound arg — §5 coercion against the column surface.
                    Some(expected) => {
                        if matches!(coerce_eq(&column, expected), CoerceEq::Match) {
                            out.push(row.clone());
                        }
                    }
                    // Free output variable: bind the column value (as `eval_attr` does).
                    None => {
                        let mut next = row.clone();
                        next.insert(v.clone(), Value::Str(column));
                        out.push(next);
                    }
                },
            }
        });
        Some(out)
    }

    /// Build-once hash-join for the positive `edge_attr(Src, Dst, "TYPE", "key", Val)`
    /// point probe (W9 fix #2), or `None` if the leg is not the build-once shape (the
    /// caller then keeps the exact per-row eval).
    ///
    /// The per-row `eval_edge_attr` walks the keyed source index AND `serde_json`-parses
    /// the blob ON EVERY ROW (~240µs/probe measured on the LSM store — 68k probes made
    /// one axum_routes clause 17.8s). This builds, once per `(edge type, metadata key)`,
    /// a `(src, dst) → scalar surface` map from ONE bulk typed metadata scan
    /// ([`StorageView::scan_edge_metadata_by_type`]) with ONE parse per edge, then
    /// probes it O(1) per row.
    ///
    /// Shape requirements (else `None`): type and key are constants; src and dst are
    /// planner-Bound VARIABLES (the pack shape — a constant endpoint stays per-row).
    /// Per-row semantics are reproduced exactly: missing binding ⇒ exact per-row eval
    /// for that row; a non-id binding, an absent edge/blob/key/non-scalar ⇒ tuple
    /// non-match (drop); free value var binds `Value::Str`; bound value (var/const/lit)
    /// equality-filters on the §5 string surface — `bind_or_check`'s exact rule.
    fn join_edge_attr_built_once(
        &self,
        eval: BuiltinEval,
        atom: &Atom,
        leg: &crate::derive::plan::PlanLeg,
        rows: &[BindRow],
    ) -> Option<Vec<BindRow>> {
        use super::builtin::ArgMode;

        let args = atom.args();
        if args.len() != 5 {
            return None;
        }
        let const_str = |t: &Term| -> Option<String> {
            match t {
                Term::Const(s) => Some(s.clone()),
                Term::Lit(v) => Some(v.as_str()),
                _ => None,
            }
        };
        let ty = const_str(&args[2])?;
        let key = const_str(&args[3])?;
        let src_var = match (&args[0], leg.pattern.first()) {
            (Term::Var(v), Some(&ArgMode::Bound)) => v,
            _ => return None,
        };
        let dst_var = match (&args[1], leg.pattern.get(1)) {
            (Term::Var(v), Some(&ArgMode::Bound)) => v,
            _ => return None,
        };

        // ── The index: one bulk metadata scan + one parse per edge, cached per
        //    (type, key) for the executor's lifetime (Part A purity). ──
        let view = self.view;
        let index: Arc<HashMap<(u128, u128), String>> =
            self.caches
                .get_or_build(&self.caches.edge_attr, (ty.clone(), key.clone()), || {
                    let mut m: HashMap<(u128, u128), String> = HashMap::new();
                    for (src, dst, blob) in view.scan_edge_metadata_by_type(&ty) {
                        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&blob)
                        else {
                            continue; // unparseable blob ⇒ per-row non-match ⇒ absent
                        };
                        let val = match parsed.get(&key) {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(serde_json::Value::Number(n)) => n.to_string(),
                            Some(serde_json::Value::Bool(b)) => b.to_string(),
                            // Absent key / non-scalar ⇒ per-row non-match ⇒ absent.
                            _ => continue,
                        };
                        m.insert((src, dst), val);
                    }
                    m
                });

        let out = par_join_rows(rows, self.cancel_ref(), |row, out| {
            let (Some(sv), Some(dv)) = (row.get(src_var), row.get(dst_var)) else {
                // Planner said Bound but the row lacks a binding — exact per-row eval.
                positive_row_via_eval_on(view, eval, atom, row, out);
                return;
            };
            let (Some(src), Some(dst)) = (sv.as_id(), dv.as_id()) else {
                // Per-row parity: `bound_id` → None ⇒ empty batch ⇒ drop.
                return;
            };
            let Some(val) = index.get(&(src, dst)) else {
                return; // absent edge / metadata / key ⇒ tuple non-match
            };
            match &args[4] {
                // `bind_or_check`: a wildcard output is pure existence.
                Term::Wildcard => out.push(row.clone()),
                // Bound value: equality on the §5 string surface.
                Term::Const(s) => {
                    if Value::from_term_const(s).as_str() == *val {
                        out.push(row.clone());
                    }
                }
                Term::Lit(v) => {
                    if v.as_str() == *val {
                        out.push(row.clone());
                    }
                }
                Term::Var(v) => match row.get(v) {
                    Some(expected) => {
                        if expected.as_str() == *val {
                            out.push(row.clone());
                        }
                    }
                    None => {
                        let mut next = row.clone();
                        next.insert(v.clone(), Value::Str(val.clone()));
                        out.push(next);
                    }
                },
            }
        });
        Some(out)
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
    ///
    /// Part A: cached on `(predicate family, type, variable-position mask)` for the
    /// executor's lifetime — the set depends on the immutable view and the projection
    /// mask only (`type` is canonicalized to `node`; `edge` vs `incoming` stay distinct,
    /// their near/far projections differ).
    fn build_anti_join_set(
        &self,
        source: &LegSource,
        atom: &Atom,
    ) -> Option<Arc<HashSet<Vec<Value>>>> {
        use crate::derive::catalog::PhysStrategy as PS;
        // P3: instance selection off the plan-resolved dispatch physics (only Base
        // legs have set-at-once anti-join shapes; builtins keep the per-row path).
        let dispatch = match source {
            LegSource::Base { dispatch, .. } => *dispatch,
            _ => return None,
        };
        let args = atom.args();
        let view = self.view;
        match (dispatch.strategy, dispatch.arity) {
            (PS::Adjacency, 3) => {
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
                let order = base_dispatch_parts(&dispatch).1;
                // The cache-key kind label encodes (family, order): the two runs'
                // near/far projections differ, so they must never share a set.
                let kind: &'static str = if order == EdgeOrder::Reverse {
                    "incoming"
                } else {
                    "edge"
                };
                let mask = [
                    matches!(args[0], Term::Var(_)),
                    matches!(args[1], Term::Var(_)),
                ];
                Some(self.caches.get_or_build(
                    &self.caches.anti_join,
                    (kind, ty.clone(), mask),
                    || {
                        let mut set: HashSet<Vec<Value>> = HashSet::new();
                        for e in view.scan_edges_by_type(&ty, order) {
                            // Map storage (src,dst) to this view's (near, far) per direction.
                            let (near, far) = match order {
                                EdgeOrder::Forward => (e.src, e.dst),
                                EdgeOrder::Reverse => (e.dst, e.src),
                            };
                            let mut key: Vec<Value> = Vec::new();
                            if mask[0] {
                                key.push(Value::Id(near));
                            }
                            if mask[1] {
                                key.push(Value::Id(far));
                            }
                            set.insert(key);
                        }
                        set
                    },
                ))
            }
            (PS::Attribute, 2) => {
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
                let mask = [matches!(args[0], Term::Var(_)), false];
                Some(self.caches.get_or_build(
                    &self.caches.anti_join,
                    ("node", ty.clone(), mask),
                    || {
                        let mut set: HashSet<Vec<Value>> = HashSet::new();
                        for n in view.scan_nodes_by_type(&ty) {
                            let mut key: Vec<Value> = Vec::new();
                            if mask[0] {
                                key.push(Value::Id(n.id));
                            }
                            set.insert(key);
                        }
                        set
                    },
                ))
            }
            _ => None,
        }
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
        leg: &crate::derive::plan::PlanLeg,
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
        // A wildcard value is an existence probe, not a value join — fall back. (The
        // value term is row-independent; screening it here, before the row loop, is what
        // the per-row screen did on the first row.)
        let value_term = &args[2];
        if matches!(value_term, Term::Wildcard) {
            return None;
        }

        // ── The hash side: `value → [id]` over one sorted-node pass, cached per column
        //    key for the executor's lifetime (Part A; previously rebuilt on every call).
        let view = self.view;
        let index: Arc<HashMap<String, Vec<u128>>> =
            self.caches.get_or_build(&self.caches.attr_gen, key.to_string(), || {
                let mut index: HashMap<String, Vec<u128>> = HashMap::new();
                for row in view.sorted_run(Relation::Nodes, SortOrder::NodeById) {
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
                index
            });

        // ── Probe per row by the value's string surface (§5), binding the free id
        //    (row-parallel at scale). ──
        let out = par_join_rows(rows, self.cancel_ref(), |row, out| {
            let value = match value_term {
                Term::Const(s) => Value::from_term_const(s),
                // A typed literal is already a ground `Value`; use it directly.
                Term::Lit(v) => v.clone(),
                Term::Var(v) => match row.get(v) {
                    Some(val) => val.clone(),
                    // The value var is unexpectedly unbound (the planner makes this
                    // unreachable for a placed generator leg); this row contributes nothing.
                    None => return,
                },
                // Screened before the loop; defensive.
                Term::Wildcard => return,
            };
            let surface = value_surface(&value);
            let Some(ids) = index.get(&surface) else {
                return;
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
        });
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

    /// Per-stratum wall-clock deadline (`EvalLimits::deadline`) + the external
    /// cancellation flag (W8 Part 1): every existing deadline checkpoint in the fixpoint
    /// loops doubles as a cancellation checkpoint.
    fn check_deadline(&self, stratum: usize) -> ExecResult<()> {
        if self.is_cancelled() {
            return Err(ExecError {
                code: ExecCode::Cancelled,
                stratum,
                detail: "query cancelled by client (disconnect or explicit cancel)".to_string(),
            });
        }
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

    /// The external cancellation flag from `EvalLimits`, if the caller installed one
    /// (the server's per-connection disconnect watcher / an explicit `CancelQuery`).
    #[inline]
    fn cancel_ref(&self) -> Option<&AtomicBool> {
        self.limits.cancelled.as_deref()
    }

    /// One relaxed atomic poll of the cancellation flag (W8 Part 1). `false` when no
    /// flag is installed.
    #[inline]
    fn is_cancelled(&self) -> bool {
        self.cancel_ref().is_some_and(|f| f.load(Ordering::Relaxed))
    }
}

// ── Incremental maintenance orchestrator (DRed + insertion) ─────────

/// Pre-load each derived predicate's `Total` from a prior [`Evaluation`], keyed by the same
/// deterministic `fact_id` the seed/loop use. `None` if a prior predicate is absent from this
/// program's stratification (the program changed) — the caller then recomputes from scratch.
fn preload_relations<T: IdempotentTag>(
    prev: &Evaluation,
    pred_ids: &HashMap<String, u64>,
) -> Option<HashMap<String, Relation<T>>> {
    let mut relations: HashMap<String, Relation<T>> = HashMap::new();
    for (name, rows) in &prev.relations {
        let &pred_id = pred_ids.get(name)?;
        let rel = relations.entry(name.clone()).or_insert_with(Relation::new);
        for key in rows {
            rel.total.insert(
                fact_id(pred_id, key),
                DerivedFact { key: key.clone(), tag: T::one() },
            );
        }
    }
    Some(relations)
}

/// Maintain a program's derived relations across a base delta — the full Gate C EXIT entry
/// (spec §9.1/§9.2), composing DRed deletion and insertion. Given the prior [`Evaluation`],
/// the prior and new base views, and the [`BaseDelta`] between them, returns the maintained
/// `Evaluation` — provably equal to a from-scratch [`Executor::evaluate`] of the new base —
/// or `Ok(None)` when the program is outside the sound envelope (any negation, more than
/// one derived stratum, an `edge_attr`/`node_attr` literal, or an `attr` GENERATOR leg
/// whose key is not a first-class column — these read METADATA blobs or the `exported`
/// column, both invisible to `diff_base`'s diffed tuples: edges diff as bare
/// `[src, type, dst]`, nodes as `[id, type, name, file]`) and the caller must recompute.
///
/// Order: **delete then insert**. DRed (over-delete on the PRIOR base reading `ΔB⁻`, remove
/// the candidates, re-derive the still-supported ones against the new base) yields the LFP of
/// `prior_base − retracted`; the insertion seed/Δ-loop (reading `ΔB⁺` against the new base)
/// then adds the asserted facts — giving the LFP of `(prior − retracted) + asserted` = the
/// new base. Each phase runs its own executor because the phases read different base views.
pub(crate) fn maintain_incremental<T: IdempotentTag>(
    prev: &Evaluation,
    prev_view: &dyn StorageView,
    cur_view: &dyn StorageView,
    base_delta: &BaseDelta,
    plans: &[RulePlan],
    rules: &[&Rule],
    strat: &Stratification,
    limits: EvalLimits,
) -> ExecResult<Option<Evaluation>> {
    // Envelope: insertion is non-monotone under negation (a base insert can retract through
    // `\+`), and cross-stratum delta threading is not yet implemented — recompute instead.
    // `edge_attr` and `node_attr` are also outside the envelope: they read METADATA blobs
    // (`StorageView::edge_metadata` / `StorageView::node_metadata`), which are NOT part of
    // the diffed base tuples (`diff_base` diffs edges as bare `[src, type, dst]` and nodes
    // as `[id, type, name, file]`), so a metadata-only change yields an EMPTY `BaseDelta`
    // and a silent maintained≠scratch divergence.
    let outside_envelope = rules.iter().any(|r| {
        r.body().iter().any(|l| {
            l.is_negative() || matches!(l.atom().predicate(), "edge_attr" | "node_attr")
        })
    });
    // `attr`'s GENERATOR mode (free or wildcard id — ATTR_MODES [F,B,B] / the wildcard
    // existence path) is inside the envelope only for the first-class column keys
    // `name`/`file`/`type`: those are columns of the diffed node tuple, and the delta view
    // serves them. ANY other key (`exported`, `id`, a metadata key, or a non-constant key)
    // routes through `snapshot_nodes_by_attr`'s exported/metadata filter slots — data
    // `diff_base` cannot see, the same silent maintained≠scratch hazard. Bound-id `attr`
    // is always inside: it reads only `first_class_attr` columns (a metadata key there is
    // a deterministic coercion miss, never a blob read). Checked on the PLANS because the
    // generator mode is a join-order fact, not a syntactic one — except a wildcard id,
    // which the planner patterns as Bound but `eval_attr` routes through the generator.
    let attr_generator_outside = plans.iter().any(|p| {
        p.legs.iter().any(|leg| {
            let atom = leg.literal.atom();
            atom.predicate() == "attr"
                && (leg.pattern.first() == Some(&builtin::ArgMode::Free)
                    || matches!(atom.args().first(), Some(Term::Wildcard)))
                && !matches!(
                    atom.args().get(1),
                    Some(Term::Const(k)) if matches!(k.as_str(), "name" | "file" | "type")
                )
        })
    });
    if outside_envelope || attr_generator_outside || strat.strata.len() > 1 {
        return Ok(None);
    }

    // W8 Part 1: keep a handle on the cancellation flag — `limits` is moved into the
    // executors below, and the FINAL GUARD at the end of this function needs it.
    let cancel_flag = limits.cancelled.clone();

    let pred_ids = assign_pred_ids(strat);
    let Some(mut relations) = preload_relations::<T>(prev, &pred_ids) else {
        return Ok(None);
    };

    let has_retract = !base_delta.nodes.retracted.is_empty()
        || !base_delta.edges.retracted.is_empty();
    let has_assert =
        !base_delta.nodes.asserted.is_empty() || !base_delta.edges.asserted.is_empty();

    // ── DRed deletion (over-delete on the PRIOR base, then re-derive on the new base) ──
    if has_retract {
        let retracted_view = increment::delta_view_retracted(base_delta);
        let del = Executor::<T>::with_limits(prev_view, limits.clone(), DEFAULT_ITERATION_CAP)
            .with_delta_view(&retracted_view);
        let candidates = del.over_delete(plans, rules, strat, &pred_ids, &mut relations)?;
        for (pred, facts) in &candidates {
            if let Some(rel) = relations.get_mut(pred) {
                for fid in facts.keys() {
                    rel.total.remove(fid);
                }
            }
        }
        let red = Executor::<T>::with_limits(cur_view, limits.clone(), DEFAULT_ITERATION_CAP);
        red.rederive(plans, rules, strat, &mut relations, &candidates)?;
    }

    // ── Insertion (semi-naive seed from ΔB⁺ against the new base) ──
    if has_assert {
        let asserted_view = increment::delta_view(base_delta);
        let ins = Executor::<T>::with_limits(cur_view, limits, DEFAULT_ITERATION_CAP)
            .with_delta_view(&asserted_view);
        for stratum in &strat.strata {
            ins.eval_stratum(
                stratum.index,
                &stratum.predicates,
                plans,
                rules,
                &pred_ids,
                &mut relations,
                true,
            )?;
        }
    }

    // ── W8 Part 1 FINAL GUARD — same reasoning as [`Executor::evaluate`]: a flag
    // raised during the last join truncates rows without re-entering a checkpoint, and
    // the maintained relations would be committed as if complete. Raised ⇒ E-EXEC-003.
    if cancel_flag.is_some_and(|f| f.load(Ordering::Relaxed)) {
        return Err(ExecError {
            code: ExecCode::Cancelled,
            stratum: 0,
            detail: "query cancelled by client (disconnect or explicit cancel)".to_string(),
        });
    }

    // Project into the deterministic public form (so a byte comparison against scratch holds).
    let mut out = Evaluation::default();
    for (name, rel) in &relations {
        let mut rows: Vec<Box<[Value]>> = rel.total.values().map(|f| f.key.clone()).collect();
        rows.sort_by(|a, b| cmp_tuple(a, b));
        out.relations.insert(name.clone(), rows);
    }
    Ok(Some(out))
}

/// why(): explain ONE supporting derivation of `pred(key)` over a snapshot. Evaluates the
/// program to populate the derived relations, then replays the head-bound body of each clause
/// of `pred` to capture a witnessing assignment (see [`Executor::witness_fact`]). `None` if
/// the fact is not derivable. Not a hot path — explanation is a query-time operation.
pub(crate) fn explain_fact<T: IdempotentTag>(
    view: &dyn StorageView,
    plans: &[RulePlan],
    rules: &[&Rule],
    strat: &Stratification,
    pred: &str,
    key: &[Value],
    limits: EvalLimits,
) -> ExecResult<Option<DerivationWitness>> {
    let exec = Executor::<T>::with_limits(view, limits, DEFAULT_ITERATION_CAP);
    let evaluation = exec.evaluate(plans, rules, strat)?;
    let pred_ids = assign_pred_ids(strat);
    let Some(relations) = preload_relations::<T>(&evaluation, &pred_ids) else {
        return Ok(None);
    };
    let all_preds: Vec<String> = strat.strata.iter().flat_map(|s| s.predicates.clone()).collect();
    let clauses = exec.collect_clauses(&all_preds, plans, rules);
    exec.witness_fact(&clauses, &relations, pred, key)
}

/// why-NOT entry point (spec §6 coverage): explain why `pred(key)` is NOT derived. Mirrors
/// [`explain_fact`] — full evaluation to populate the derived relations, then a head-bound
/// replay per clause via [`Executor::witness_gap`] to find the unbound premise. `None` when the
/// fact is actually derivable (no gap) or no clause head matches the key's shape.
pub(crate) fn explain_gap<T: IdempotentTag>(
    view: &dyn StorageView,
    plans: &[RulePlan],
    rules: &[&Rule],
    strat: &Stratification,
    pred: &str,
    key: &[Value],
    limits: EvalLimits,
) -> ExecResult<Option<GapWitness>> {
    let exec = Executor::<T>::with_limits(view, limits, DEFAULT_ITERATION_CAP);
    let evaluation = exec.evaluate(plans, rules, strat)?;
    let pred_ids = assign_pred_ids(strat);
    let Some(relations) = preload_relations::<T>(&evaluation, &pred_ids) else {
        return Ok(None);
    };
    let all_preds: Vec<String> = strat.strata.iter().flat_map(|s| s.predicates.clone()).collect();
    let clauses = exec.collect_clauses(&all_preds, plans, rules);
    exec.witness_gap(&clauses, &relations, pred, key)
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

    /// The body-leg positions that read a BASE (EDB) relation positively — the legs a base
    /// delta `ΔB` can change. The semi-naive incremental seed fires one variant per such
    /// leg (that leg reading `ΔB`, the rest full), deriving exactly the facts that use a new
    /// base fact. Negated base legs are anti-joins, never a delta source.
    fn base_leg_indices(&self) -> Vec<usize> {
        self.plan
            .legs
            .iter()
            .enumerate()
            .filter_map(|(i, leg)| match &leg.source {
                LegSource::Base { .. } if leg.literal.is_positive() => Some(i),
                _ => None,
            })
            .collect()
    }
}

// ── Per-row eval bodies (free functions: callable from the rayon row-parallel loops,
//    which must not capture `&Executor` — it owns `RefCell`s and is not `Sync`) ────────

/// Run the registry eval for ONE row of a POSITIVE base/builtin leg against `view` and
/// extend it with every produced tuple — the exact per-row path of
/// [`Executor::join_extensional`], also used verbatim as the build-once fast paths'
/// defensive per-row fallback so a row the fast path cannot serve gets byte-identical
/// treatment.
fn positive_row_via_eval_on(
    view: &dyn StorageView,
    eval: BuiltinEval,
    atom: &Atom,
    row: &BindRow,
    out: &mut Vec<BindRow>,
) {
    // Resolve args → ArgSpec. Free (unbound) variables get sequential output slots;
    // the slot→variable map lets us write the produced values back into the row.
    let (spec, slot_vars) = resolve_arg_spec(atom, row);
    let mut batch = Batch::new();
    // The registry eval returns Err only for a genuine planning fault; the planner
    // already mode-checked every leg, so a runtime Err here is impossible on a
    // planned leg. If it ever fired, the safe behavior is "no rows" (never a crash).
    if eval(view, &mut batch, &spec).is_err() {
        return;
    }
    extend_row_with_batch(row, &batch, &slot_vars, out);
}

/// Probe one row against a single-endpoint edge bucket map (`probe_pos` is the
/// row-bound endpoint's argument position, `other_pos` the captured/matched one),
/// reproducing the per-row eval's semantics exactly: a free other-variable binds each
/// bucket id (with the shared-variable agreement check the generic loop applies); a
/// wildcard, or a row-bound other-variable with an id surface, filters/passes with one
/// output row per matching stored tuple. Any resolution the per-row path would treat
/// differently (unbound probe var, non-id probe surface, non-id other-binding, a
/// non-variable other term) falls back to the exact per-row eval for THIS row.
#[allow(clippy::too_many_arguments)]
fn probe_edge_bucket(
    view: &dyn StorageView,
    buckets: &HashMap<u128, Vec<u128>>,
    probe_pos: usize,
    other_pos: usize,
    eval: BuiltinEval,
    atom: &Atom,
    row: &BindRow,
    out: &mut Vec<BindRow>,
) {
    let args = atom.args();
    let probe_id = match &args[probe_pos] {
        Term::Var(v) => match row.get(v).and_then(Value::as_id) {
            Some(id) => id,
            None => {
                // Unbound probe var or a binding with no id surface: the per-row
                // eval's access path changes — run it exactly.
                positive_row_via_eval_on(view, eval, atom, row, out);
                return;
            }
        },
        // The shape check screened constant probe endpoints; defensive.
        _ => {
            positive_row_via_eval_on(view, eval, atom, row, out);
            return;
        }
    };
    let Some(bucket) = buckets.get(&probe_id) else {
        // No edges at this key: the per-row eval would produce an empty batch — the
        // row is dropped.
        return;
    };
    match &args[other_pos] {
        // Wildcard: existence per stored tuple — one pass row per edge (the per-row
        // eval emits `push_pass()` per match, and the generic loop replicates the
        // partial row once per pass).
        Term::Wildcard => {
            for _ in bucket {
                out.push(row.clone());
            }
        }
        Term::Var(v) => match row.get(v) {
            // Planner said Free but the row carries a binding (shared variable): the
            // per-row eval runs in check mode. An id surface filters the bucket; a
            // non-id surface changes the eval's path — exact fallback.
            Some(existing) => match existing.as_id() {
                Some(fid) => {
                    for &other in bucket {
                        if other == fid {
                            out.push(row.clone());
                        }
                    }
                }
                None => positive_row_via_eval_on(view, eval, atom, row, out),
            },
            // Free output variable: bind each bucket id.
            None => {
                for &other in bucket {
                    let mut next = row.clone();
                    next.insert(v.clone(), Value::Id(other));
                    out.push(next);
                }
            }
        },
        // A constant other endpoint was screened out by the shape check; defensive.
        _ => positive_row_via_eval_on(view, eval, atom, row, out),
    }
}

/// Exact per-row anti-join fallback for a single row: run the registry eval against
/// `view` and report whether the row survives (no matching tuple produced). Used only
/// when the row's key could not be projected for the set probe (a safety net the planner
/// makes unreachable on a safe rule).
fn anti_join_row_passes_on(
    view: &dyn StorageView,
    eval: BuiltinEval,
    atom: &Atom,
    row: &BindRow,
) -> bool {
    let (spec, _slot_vars) = resolve_arg_spec(atom, row);
    let mut batch = Batch::new();
    if eval(view, &mut batch, &spec).is_err() {
        // An eval fault drops the row from a positive leg; for an anti-join the safe,
        // membership-preserving choice is "no match found" so the row survives.
        return true;
    }
    batch.rows.is_empty()
}

// ── Binding / unification helpers ──────────────────────────────────

/// Extend `row` with every produced batch tuple — the positive projection of
/// [`Executor::join_extensional`]'s per-row path. Each produced tuple yields one clone of
/// the row with the leg's free output slots bound; a value for an already-bound shared
/// variable must agree or the candidate is dropped. Shared by the generic per-row loop and
/// the build-once fast paths' defensive fallback so both bind and agreement-check
/// identically (a single body — they cannot drift).
fn extend_row_with_batch(
    row: &BindRow,
    batch: &Batch,
    slot_vars: &[(usize, String)],
    out: &mut Vec<BindRow>,
) {
    for produced in &batch.rows {
        let mut next = row.clone();
        let mut ok = true;
        for (slot, var) in slot_vars {
            match produced.get(*slot) {
                Some(val) => {
                    // If the variable was already bound (shared variable across legs),
                    // the produced value must agree, else the row is dropped.
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

/// Build the ground tuple for `atom`'s args from a binding row, in arg order. Returns
/// `None` if any arg is an unbound variable (a fully-bound key was expected, e.g. for an
/// anti-join or a head projection).
/// The probe key of a derived-leg hash-join for one row: the values of the leg's BOUND
/// argument positions (consts/typed literals directly, vars from the row's bindings).
/// `None` when a position the planner marked Bound cannot be resolved against the row —
/// the caller falls back to a scan for that row (defensive; must not drop it).
fn derived_probe_key(atom: &Atom, bound_positions: &[usize], row: &BindRow) -> Option<Vec<Value>> {
    let args = atom.args();
    let mut out = Vec::with_capacity(bound_positions.len());
    for &i in bound_positions {
        match &args[i] {
            Term::Const(s) => out.push(Value::from_term_const(s)),
            Term::Lit(v) => out.push(v.clone()),
            Term::Var(v) => out.push(row.get(v)?.clone()),
            // A wildcard is never Bound in the planner's pattern; treat as unresolvable.
            Term::Wildcard => return None,
        }
    }
    Some(out)
}

fn bind_atom_args(atom: &Atom, row: &BindRow) -> Option<Vec<Value>> {
    let mut out = Vec::with_capacity(atom.args().len());
    for t in atom.args() {
        match t {
            Term::Const(s) => out.push(Value::from_term_const(s)),
            // A typed literal is already a ground `Value`; use it directly.
            Term::Lit(v) => out.push(v.clone()),
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
        // Typed numeric literals surface as their decimal text.
        Value::Int(i) => i.to_string(),
        Value::Float(f) => f.to_string(),
        // The attr-probe surface must stay byte-identical to the per-row path
        // (`bound_value_surface` = `Value::as_str`): a BigInt probes by its exact
        // decimal, a Term by its canonical text — same strings, same matches.
        Value::BigInt(_) | Value::Term(_) => v.as_str(),
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
            // A typed literal is already a ground `Value`; use it directly.
            Term::Lit(v) => out.push(v.clone()),
            Term::Var(v) => out.push(row.get(v)?.clone()),
            // A wildcard in a head is not a captured column; a safe rule never has one.
            Term::Wildcard => return None,
        }
    }
    Some(out.into_boxed_slice())
}

/// Build the initial binding row that pins a clause's HEAD to a specific ground tuple — the
/// seed for a head-bound body-satisfiability probe (DRed re-derive). Each head variable binds
/// the tuple's value at its position; a head constant must already agree (else `None`, the
/// tuple is not an instance of this head). A head wildcard binds nothing.
fn head_bound_row(head: &Atom, key: &[Value]) -> Option<BindRow> {
    if head.args().len() != key.len() {
        return None;
    }
    let mut row = BindRow::new();
    for (t, val) in head.args().iter().zip(key.iter()) {
        match t {
            Term::Var(v) => match row.get(v) {
                Some(existing) if existing != val => return None,
                Some(_) => {}
                None => {
                    row.insert(v.clone(), val.clone());
                }
            },
            Term::Const(s) => {
                if &Value::from_term_const(s) != val {
                    return None;
                }
            }
            // A typed literal is already a ground `Value`; compare it directly.
            Term::Lit(v) => {
                if v != val {
                    return None;
                }
            }
            Term::Wildcard => {}
        }
    }
    Some(row)
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
            // A typed literal is already a ground `Value`; compare it directly.
            Term::Lit(v) => {
                if v != val {
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
            // A typed literal is already a ground `Value`; bind it directly.
            Term::Lit(v) => args.push(ArgValue::Bound(v.clone())),
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

/// Total order over [`Value`] for a deterministic committed result (I1). The query engine's `Value`
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
        // Typed numeric literals get a deterministic place in the total order: same-variant
        // pairs compare by their string surface; otherwise by a fixed variant rank so the
        // result stays a total order regardless of which numeric variants appear.
        (Value::Int(x), Value::Int(y)) => x.cmp(y),
        (Value::Float(x), Value::Float(y)) => x.to_bits().cmp(&y.to_bits()),
        // P1 variants: deterministic same-variant orders (I1 needs determinism only —
        // the NORMATIVE §9.2 canon-bytes order is `Value`'s own `Ord`; this local order
        // predates it and stays untouched for the existing variants' committed-sort
        // stability). BigInt: by byte length, then bytes. Term: functor, arity, then
        // args recursively.
        (Value::BigInt(x), Value::BigInt(y)) => {
            x.len().cmp(&y.len()).then_with(|| x.cmp(y))
        }
        (Value::Term(x), Value::Term(y)) => x
            .functor
            .cmp(&y.functor)
            .then_with(|| x.args.len().cmp(&y.args.len()))
            .then_with(|| cmp_tuple(&x.args, &y.args)),
        _ => value_rank(a).cmp(&value_rank(b)),
    }
}

/// Fixed variant rank for [`cmp_value`]'s cross-variant fallback (keeps the existing
/// Id < Str ordering, places numerics after them deterministically; the P1 variants
/// extend the rank without moving any existing one).
fn value_rank(v: &Value) -> u8 {
    match v {
        Value::Id(_) => 0,
        Value::Str(_) => 1,
        Value::Int(_) => 2,
        Value::Float(_) => 3,
        Value::BigInt(_) => 4,
        Value::Term(_) => 5,
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
    use crate::derive::parser_ext::parse_ext_program;
    use crate::derive::plan::plan_program;
    use crate::derive::storage_glue::{EdgeRow, FixtureStorageView, NodeRow};
    use crate::derive::stratify::stratify;
    use crate::derive::tag::BoolTag;
    use crate::derive::builtin::Stats;

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
    /// Wave 4 regression — a WILDCARD argument in a derived/fact leg must be
    /// EXCLUDED from the build-once probe key: the planner's pattern marks it
    /// Bound (placement feasibility), but `derived_probe_key` cannot resolve
    /// it, and including it silently demoted the whole join to the defensive
    /// per-row FULL SCAN (observed: `rtg_key(S, _)` at 22k rows × 5.7k facts
    /// = ~20 s for one non-recursive rule on the dogfood copy). This pins the
    /// CORRECTNESS of the indexed path on every wildcard arrangement; the
    /// perf measurement lives in the `wave4_rtg_cost_bisect` probe.
    #[test]
    fn derived_join_wildcard_positions_stay_indexed_and_correct() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "a", "CALL");
        node(&mut v, "b", "CALL");
        node(&mut v, "c", "CALL");

        let src = r#"
            k("a", "x"). k("a", "y"). k("b", "x").
            name(N) :- node(C, "CALL"), attr(C, "name", N).
            hit1(N) :- name(N), k(N, _).
            hit2(N) :- name(N), k(_, N).
        "#;
        let eval = run(src, &v, Stats::default());
        let names = |pred: &str| -> std::collections::BTreeSet<String> {
            eval.facts(pred).into_iter().map(|r| r[0].as_str()).collect()
        };
        use std::collections::BTreeSet;
        assert_eq!(
            names("hit1"),
            BTreeSet::from(["a".to_string(), "b".to_string()]),
            "wildcard value column: keys with any value match, dedup'd"
        );
        assert_eq!(
            names("hit2"),
            BTreeSet::<String>::new(),
            "wildcard key column: no CALL name appears as a k VALUE"
        );
        // (An ALL-wildcard positive leg `k(_, _)` is a nonemptiness filter: since
        // the F3 filter-in-any-position fix it plans (a binding-free leg is never a
        // Cartesian product) and set-semantics head projection dedups its rows —
        // the same emptiness semantics its negated twin `\+ k(_, _)` gets in
        // `ground_fact_probe_filters_in_any_position`.)
    }

    /// ROFL conformance F2 (availability), part 1 — a body literal over a predicate
    /// with NO facts and NO rules is an EMPTY relation: the rule derives nothing and
    /// the evaluation TERMINATES with the correct empty result. Before the fix,
    /// `stratify` hit a `debug_assert!` panic on the unknown predicate
    /// (stratify.rs: "body predicate 'p9' is neither derived, materialize-linked,
    /// base, nor builtin"), which on the (debug-built) server killed the connection
    /// thread — the client saw NO response past the 30 s deadline (live-probed >45 s).
    #[test]
    fn unknown_predicate_leg_terminates_with_empty_result() {
        let v = FixtureStorageView::new(1);
        let src = r#"
            p0("c0"). p0("c1").
            q0(X) :- p0(X), p9(X).
        "#;
        let eval = run(src, &v, Stats::default());
        assert!(
            eval.facts("q0").is_empty(),
            "q0 must be empty (p9 is an empty relation), got: {:?}",
            eval.facts("q0")
        );
    }

    /// F2 part 2 — the wall-clock deadline is a hard backstop on this same program
    /// shape: an already-expired deadline aborts the evaluation with the coded
    /// `E-EXEC-001` error instead of hanging or answering. Before the fix this test
    /// never reached the executor (the same stratify panic as part 1).
    #[test]
    fn unknown_predicate_leg_expired_deadline_aborts_with_e_exec_001() {
        let v = FixtureStorageView::new(1);
        let src = r#"
            p0("c0"). p0("c1").
            q0(X) :- p0(X), p9(X).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats::default()).expect("plan");

        let mut limits = EvalLimits::none();
        // Already expired: the first fixpoint checkpoint must trip it.
        limits.deadline = Some(Instant::now() - std::time::Duration::from_millis(1));
        let exec = Executor::<BoolTag>::with_limits(&v, limits, DEFAULT_ITERATION_CAP);
        let err = exec
            .evaluate(&plans, &rules, &strat)
            .expect_err("an expired deadline must abort the evaluation");
        assert_eq!(err.code, ExecCode::LimitExceeded);
        assert_eq!(err.code.as_str(), "E-EXEC-001");
    }

    /// F3 behavior pin — an ALL-wildcard POSITIVE leg `k(_, _)` is a nonemptiness
    /// filter (before the F3 fix the reorder could place it first and the guard then
    /// falsely rejected the following generator with E-PLAN-003): nonempty `k` passes
    /// rows through (set-semantics head projection dedups the per-fact copies), and
    /// an unknown predicate (`km`: no facts, no rules — an empty relation) filters
    /// everything.
    #[test]
    fn all_wildcard_positive_leg_is_a_nonemptiness_filter() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "a", "CALL");
        let src = r#"
            k("a", "x"). k("a", "y").
            name(N) :- node(C, "CALL"), attr(C, "name", N).
            hit3(N) :- name(N), k(_, _).
            hit4(N) :- name(N), km(_, _).
        "#;
        let eval = run(src, &v, Stats::default());
        let names = |pred: &str| -> Vec<String> {
            eval.facts(pred).into_iter().map(|r| r[0].as_str()).collect()
        };
        assert_eq!(names("hit3"), vec!["a".to_string()], "nonempty k passes, deduped");
        assert!(names("hit4").is_empty(), "empty km filters everything");
    }

    /// ROFL conformance F3, exec side — a fully-ground body literal is a FILTER in
    /// any position: present fact ⇒ pass-through, absent fact ⇒ empty result. Also
    /// covers the variable-free negated legs the same reorder used to false-reject:
    /// `\+ p3(_)` (nonempty relation ⇒ drop all) and `\+ p4(_)` over a predicate with
    /// no facts and no rules (empty relation ⇒ vacuous, pass all — the F2 shape under
    /// negation). Before the F3 planner fix every one of these rules was rejected
    /// with E-PLAN-003 once the ground/novar leg was ordered first.
    #[test]
    fn ground_fact_probe_filters_in_any_position() {
        let v = FixtureStorageView::new(1);
        let src = r#"
            p0("c0"). p0("c1").
            p1("c1", "c2").
            p3("z").
            qy(X) :- p0(X), p1("c1", "c2").
            qn(X) :- p0(X), p1("c9", "c9").
            qe(X) :- p0(X), \+ p3(_).
            qf(X) :- p0(X), \+ p4(_).
        "#;
        let eval = run(src, &v, Stats::default());
        let names = |pred: &str| -> std::collections::BTreeSet<String> {
            eval.facts(pred).into_iter().map(|r| r[0].as_str()).collect()
        };
        use std::collections::BTreeSet;
        let all = BTreeSet::from(["c0".to_string(), "c1".to_string()]);
        assert_eq!(names("qy"), all, "present ground fact = pass-through filter");
        assert_eq!(
            names("qn"),
            BTreeSet::<String>::new(),
            "absent ground fact = the rule derives nothing"
        );
        assert_eq!(
            names("qe"),
            BTreeSet::<String>::new(),
            "\\+ p3(_): p3 is nonempty, the emptiness anti-join drops every row"
        );
        assert_eq!(
            names("qf"),
            all,
            "\\+ p4(_): p4 has no facts and no rules (empty relation), the negation is vacuous"
        );
    }

    /// ROFL conformance F1 (soundness) — a WILDCARD inside a NEGATED derived/fact
    /// leg is EXISTENTIAL: `\+ p2(X, _)` must drop a row iff ANY `p2(x, ·)` fact
    /// exists for the row's `x`. The anti-join used `bind_atom_args`, which returns
    /// `None` on a wildcard, and `None` was read as "no match ⇒ row survives" — so
    /// every row survived and the negation was silently vacuous (live-probed:
    /// `q0(X) :- p0(X), \+ p2(X, _).` returned {c0, c1}; correct is {c0}).
    #[test]
    fn negated_derived_leg_with_wildcard_is_existential() {
        let v = FixtureStorageView::new(1);
        let src = r#"
            p0("c0"). p0("c1").
            p2("c1", "c9").
            q0(X) :- p0(X), \+ p2(X, _).
        "#;
        let eval = run(src, &v, Stats::default());
        let got: std::collections::BTreeSet<String> =
            eval.facts("q0").into_iter().map(|r| r[0].as_str()).collect();
        assert_eq!(
            got,
            std::collections::BTreeSet::from(["c0".to_string()]),
            "\\+ p2(X, _) must be an existential anti-join: c1 has a p2 fact, only c0 survives"
        );
    }

    /// F1 companion — the wildcard may sit in ANY position of a negated fact leg;
    /// the anti-join is existential over the non-wildcard columns: `\+ p2(_, X)`
    /// keys on the VALUE column.
    #[test]
    fn negated_derived_leg_wildcard_arrangements() {
        let v = FixtureStorageView::new(1);
        let src = r#"
            p0("c0"). p0("c1"). p0("c9").
            p2("c1", "c9").
            qv(X) :- p0(X), \+ p2(_, X).
        "#;
        let eval = run(src, &v, Stats::default());
        let got: std::collections::BTreeSet<String> =
            eval.facts("qv").into_iter().map(|r| r[0].as_str()).collect();
        assert_eq!(
            got,
            std::collections::BTreeSet::from(["c0".to_string(), "c1".to_string()]),
            "\\+ p2(_, X): only c9 appears as a p2 VALUE, so it is dropped"
        );
    }

    // ── W8 Part 1: external cancellation (`EvalLimits::cancelled`) ──

    /// A pre-raised cancellation flag aborts the evaluation with `E-EXEC-003` before any
    /// result is produced — the executor half of disconnect-cancel. (The server half — the
    /// per-connection watcher that raises this flag on peer EOF — lives in
    /// `bin/rfdb_server.rs`.)
    #[test]
    fn cancelled_flag_aborts_evaluation_with_e_exec_003() {
        use std::sync::atomic::AtomicBool;
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "a", "FUNCTION");
        node(&mut v, "b", "FUNCTION");
        edge(&mut v, "a", "b", "CALLS");

        let src = r#"hit(X, Y) :- node(X, "FUNCTION"), edge(X, Y, "CALLS")."#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats::default()).expect("plan");

        let mut limits = EvalLimits::none();
        let flag = Arc::new(AtomicBool::new(true));
        limits.cancelled = Some(Arc::clone(&flag));
        let exec = Executor::<BoolTag>::with_limits(&v, limits, DEFAULT_ITERATION_CAP);
        let err = exec
            .evaluate(&plans, &rules, &strat)
            .expect_err("a raised cancellation flag must abort the run");
        assert_eq!(err.code, ExecCode::Cancelled);
        assert_eq!(err.code.as_str(), "E-EXEC-003");

        // The SAME program with the flag installed but UNRAISED evaluates normally and
        // commits the full result — no false cancels.
        flag.store(false, Ordering::Relaxed);
        let mut limits2 = EvalLimits::none();
        limits2.cancelled = Some(flag);
        let exec2 = Executor::<BoolTag>::with_limits(&v, limits2, DEFAULT_ITERATION_CAP);
        let eval = exec2.evaluate(&plans, &rules, &strat).expect("unraised flag evaluates");
        assert_eq!(eval.facts("hit").len(), 1, "full result with an unraised flag");
    }

    /// THE partial-result escape (the live incident this guards): a cancellation that
    /// lands DURING the final join leg — after every earlier checkpoint has passed —
    /// truncates that leg's rows, the stratum "converges" on the truncated delta, and
    /// without the final guard `evaluate` returned `Ok` with a PARTIAL evaluation (the
    /// `@materialize` write-back then diffed `derived = ∅` against the live graph and
    /// tombstoned all 1,726 DEPENDS_ON edges on the dogfood copy). The wrapper view
    /// raises the flag deterministically the moment the eval touches the LAST leg's
    /// relation ("FOLLOWS") — no timing, no threads.
    #[test]
    fn cancel_during_final_leg_is_an_error_never_a_partial_result() {
        use crate::derive::storage_glue::{EdgeOrder, Relation as SgRelation, Row, SortOrder};

        struct CancelOnFollowsView<'a> {
            inner: &'a FixtureStorageView,
            flag: Arc<AtomicBool>,
        }
        impl CancelOnFollowsView<'_> {
            fn raise_if_follows(&self, ty: &str) {
                if ty == "FOLLOWS" {
                    self.flag.store(true, Ordering::Relaxed);
                }
            }
        }
        impl StorageView for CancelOnFollowsView<'_> {
            fn generation(&self) -> u64 {
                self.inner.generation()
            }
            fn sorted_run(
                &self,
                rel: SgRelation,
                order: SortOrder,
            ) -> Box<dyn Iterator<Item = Row> + '_> {
                self.inner.sorted_run(rel, order)
            }
            fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = NodeRow> + '_> {
                self.inner.scan_nodes_by_type(ty)
            }
            fn scan_edges_by_type(
                &self,
                ty: &str,
                order: EdgeOrder,
            ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
                self.raise_if_follows(ty);
                self.inner.scan_edges_by_type(ty, order)
            }
            fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
                self.raise_if_follows(edge_type);
                self.inner.edges_from(src, edge_type)
            }
            fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
                self.raise_if_follows(edge_type);
                self.inner.edges_to(dst, edge_type)
            }
            fn get_node(&self, id: u128) -> Option<NodeRow> {
                self.inner.get_node(id)
            }
            fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<NodeRow> {
                self.inner.nodes_by_attr(key, value)
            }
            fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
                self.inner.edge_metadata(src, dst, edge_type)
            }
            fn node_metadata(&self, id: u128) -> Option<String> {
                self.inner.node_metadata(id)
            }
            fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)> {
                self.inner.scan_edge_metadata_by_type(edge_type)
            }
        }

        // ≥ BUILD_ONCE_MIN_ROWS rows must reach the final leg so it takes the
        // build-once path: the index build (one typed scan of "FOLLOWS") raises the
        // flag BEFORE the row loop, `par_join_rows` then drains every row as a no-op,
        // and the truncated output is EMPTY — the empty seed looks like instant
        // convergence and skips the Δ-loop's per-iteration checkpoint entirely. (With
        // a NONEMPTY truncation the next iteration's `check_deadline` already catches
        // the flag; the empty case is the one only the final guard can catch.)
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "b", "FUNCTION");
        node(&mut v, "c", "FUNCTION");
        edge(&mut v, "b", "c", "FOLLOWS");
        for i in 0..(BUILD_ONCE_MIN_ROWS + 8) {
            let sid = format!("a{i}");
            node(&mut v, &sid, "FUNCTION");
            edge(&mut v, &sid, "b", "CALLS");
        }

        let flag = Arc::new(AtomicBool::new(false));
        let view = CancelOnFollowsView { inner: &v, flag: Arc::clone(&flag) };

        let src = r#"hit(X, Z) :- edge(X, Y, "CALLS"), edge(Y, Z, "FOLLOWS")."#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats::default()).expect("plan");

        let mut limits = EvalLimits::none();
        limits.cancelled = Some(Arc::clone(&flag));
        let exec = Executor::<BoolTag>::with_limits(&view, limits, DEFAULT_ITERATION_CAP);
        let err = exec
            .evaluate(&plans, &rules, &strat)
            .expect_err("a mid-final-leg cancellation must abort, never commit a partial result");
        assert_eq!(err.code, ExecCode::Cancelled);
        assert_eq!(err.code.as_str(), "E-EXEC-003");
        assert!(
            flag.load(Ordering::Relaxed),
            "harness integrity: the view must actually have raised the flag mid-eval"
        );
    }

    /// Run a program with an event sink installed, returning both the committed evaluation
    /// and the captured event sequence.
    fn run_with_events(
        src: &str,
        view: &FixtureStorageView,
        stats: Stats,
    ) -> (Evaluation, Vec<crate::derive::events::Event>) {
        use crate::derive::events::{EventLog, SharedMemSink};
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
            .map(|row| row[0].as_id().expect("id column"))
            .collect();
        out.sort_unstable();
        out
    }

    // ── Incremental maintenance: maintained ≡ scratch (insert-only) ──

    /// The Gate C EXIT invariant for the monotone envelope: over many seeded base
    /// INSERTIONS into a recursive transitive-closure view, the incrementally-maintained
    /// relation is byte-identical to a from-scratch re-evaluation of the new snapshot.
    ///
    /// Each cycle: pick a pseudo-random edge (deterministic LCG — no `rand`/clock in tests),
    /// add it, diff the base (`diff_base`), maintain from the prior result against a delta
    /// view of `ΔB` (`evaluate_incremental`), and compare to a full `evaluate` of the new
    /// base. The two must agree on every cycle.
    #[test]
    fn incremental_insertion_equals_scratch_over_seeded_cycles() {
        use crate::derive::increment::diff_base;

        // Transitive closure: negation-free, single recursive stratum, the monotone envelope.
        let src = "path(A, B) :- edge(A, B, \"E\").\n\
                   path(A, B) :- edge(A, C, \"E\"), path(C, B).";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 6, total_edges: 8, ..Default::default() },
        )
        .expect("plan");

        const N: u128 = 6;
        let nid = |i: u128| id_of(&format!("n{i}"));
        let build = |edges: &[(u128, u128)], gen: u64| {
            let mut v = FixtureStorageView::new(gen);
            for &(s, d) in edges {
                v.put_edge(EdgeRow {
                    src: nid(s),
                    dst: nid(d),
                    edge_type: "E".to_string(),
                });
            }
            v
        };
        let eval_scratch = |view: &FixtureStorageView| {
            Executor::<BoolTag>::with_limits(view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
                .evaluate(&plans, &rules, &strat)
                .expect("scratch evaluate")
        };

        let mut edges: Vec<(u128, u128)> = vec![(0, 1), (1, 2)];
        let mut prev_view = build(&edges, 0);
        let mut prev_eval = eval_scratch(&prev_view);

        let mut lcg: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut saw_nonempty_delta = false;
        let mut saw_growth = false;

        for cycle in 1..=100u64 {
            lcg = lcg.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let s = ((lcg >> 33) as u128) % N;
            let d = ((lcg >> 17) as u128) % N;
            if edges.contains(&(s, d)) {
                continue; // a duplicate edit is a no-op cycle; skip to a meaningful one
            }
            edges.push((s, d));
            let cur_view = build(&edges, cycle);

            let base_delta = diff_base(&prev_view, &cur_view);
            let has_retraction = !base_delta.nodes.retracted.is_empty()
                || !base_delta.edges.retracted.is_empty();
            assert!(!has_retraction, "insert-only edits produce no base retraction");
            if !base_delta.is_empty() {
                saw_nonempty_delta = true;
            }

            let maintained = maintain_incremental::<BoolTag>(
                &prev_eval,
                &prev_view,
                &cur_view,
                &base_delta,
                &plans,
                &rules,
                &strat,
                EvalLimits::none(),
            )
            .expect("incremental maintain")
            .expect("monotone envelope → Some, not a recompute fallback");

            let scratch = eval_scratch(&cur_view);
            assert_eq!(
                maintained.relations, scratch.relations,
                "cycle {cycle}: maintained must equal scratch (edge n{s}->n{d})"
            );
            if maintained.facts("path").len() > prev_eval.facts("path").len() {
                saw_growth = true;
            }

            prev_view = cur_view;
            prev_eval = maintained;
        }
        assert!(saw_nonempty_delta, "some cycle must have applied a real base delta");
        assert!(saw_growth, "some insertion must have grown the transitive closure");
    }

    // ── sim(): hypothetical-edit query (Gate E "new feature") ──

    /// `sim()` answers a why-NOT counterfactual: "IF I added this edge, which derived facts
    /// would appear?" — without committing the edit. It is exactly `maintain_incremental`
    /// run over a HYPOTHETICAL `BaseDelta` against an overlay view: the engine already has
    /// the machinery, so sim is the maintain seam used in read-only mode. This is the
    /// hypothetical-questions dual of `why()` (PUG-style why-not provenance, apparatus §6):
    /// a coverage gap names the unbound premise; sim proves a candidate fact closes it.
    ///
    /// The test pins the two soundness obligations that make sim trustworthy:
    ///   (1) SOUND — `sim(base, Δ) ≡ scratch(base ∪ Δ)`: the predicted facts are exactly
    ///       what a real commit-then-evaluate would have produced.
    ///   (2) NON-DESTRUCTIVE — the base view and the prior evaluation are byte-identical
    ///       before and after the what-if; the hypothetical never leaks into committed state.
    #[test]
    fn sim_hypothetical_edit_predicts_derived_facts_without_mutating_base() {
        use crate::derive::increment::diff_base;

        // Reachability via transitive closure — the monotone envelope sim relies on.
        let src = "reach(A, B) :- edge(A, B, \"E\").\n\
                   reach(A, B) :- edge(A, C, \"E\"), reach(C, B).";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 4, total_edges: 4, ..Default::default() },
        )
        .expect("plan");

        let nid = |n: &str| id_of(n);
        let build = |edges: &[(&str, &str)], gen: u64| {
            let mut v = FixtureStorageView::new(gen);
            for &(s, d) in edges {
                v.put_edge(EdgeRow {
                    src: nid(s),
                    dst: nid(d),
                    edge_type: "E".to_string(),
                });
            }
            v
        };
        let eval_scratch = |view: &FixtureStorageView| {
            Executor::<BoolTag>::with_limits(view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
                .evaluate(&plans, &rules, &strat)
                .expect("scratch evaluate")
        };
        let reaches = |eval: &Evaluation, from: &str, to: &str| {
            eval.facts("reach").iter().any(|r| {
                r[0].as_id() == Some(nid(from)) && r[1].as_id() == Some(nid(to))
            })
        };

        // Committed base: a -> b -> c, and a dangling target `d`. `a` does NOT reach `d`:
        // a coverage gap whose unbound premise is "some edge into d".
        let base_edges = [("a", "b"), ("b", "c")];
        let base_view = build(&base_edges, 0);
        let base_eval = eval_scratch(&base_view);
        assert!(reaches(&base_eval, "a", "c"), "precondition: a reaches c");
        assert!(!reaches(&base_eval, "a", "d"), "precondition: the gap — a does NOT reach d");

        // The hypothetical edit the gap analysis would propose: c -> d. Build the overlay
        // view (base ∪ Δ) WITHOUT mutating `base_view`, and the hypothetical delta.
        let hypo_edges = [("a", "b"), ("b", "c"), ("c", "d")];
        let hypo_view = build(&hypo_edges, 1);
        let hypo_delta = diff_base(&base_view, &hypo_view);
        assert_eq!(hypo_delta.edges.asserted.len(), 1, "exactly one hypothetical edge");
        assert!(hypo_delta.edges.retracted.is_empty(), "a pure what-if addition");

        // sim() = maintain over the hypothetical delta. Read-only: no flush, no write-back.
        let simulated = maintain_incremental::<BoolTag>(
            &base_eval,
            &base_view,
            &hypo_view,
            &hypo_delta,
            &plans,
            &rules,
            &strat,
            EvalLimits::none(),
        )
        .expect("sim maintain")
        .expect("monotone envelope → Some prediction, not a recompute fallback");

        // (1) SOUND — the prediction equals what a real commit would have derived, AND it
        // actually closes the gap (a now reaches d transitively through the hypothetical edge).
        let committed = eval_scratch(&hypo_view);
        assert_eq!(
            simulated.relations, committed.relations,
            "sim must predict exactly scratch(base ∪ hypothetical)"
        );
        assert!(reaches(&simulated, "a", "d"), "sim predicts the gap closes: a reaches d");

        // (2) NON-DESTRUCTIVE — the what-if left the committed world untouched: a re-eval of
        // the original base is byte-identical to `base_eval`, and the gap is still open there.
        let base_after = eval_scratch(&base_view);
        assert_eq!(
            base_eval.relations, base_after.relations,
            "the hypothetical must not mutate the committed base"
        );
        assert!(!reaches(&base_after, "a", "d"), "uncommitted: the real graph still has the gap");
    }

    /// The envelope guard: a program with negation cannot be insertion-maintained (a base
    /// insert can RETRACT a derived fact through `\\+`), so `evaluate_incremental` returns
    /// `None` (recompute) rather than a wrong delta.
    #[test]
    fn incremental_refuses_negation_returns_none() {
        // `orphan(A)` depends on a negated `path` — non-monotone under insertion.
        let src = "path(A, B) :- edge(A, B, \"E\").\n\
                   orphan(A) :- node(A, \"N\"), \\+ path(A, _).";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 3, total_edges: 1, ..Default::default() },
        )
        .expect("plan");

        let mut v = FixtureStorageView::new(1);
        edge(&mut v, "a", "b", "E");
        let empty = Evaluation::default();
        let base_delta = crate::derive::increment::diff_base(&v, &v);
        let out = maintain_incremental::<BoolTag>(
            &empty, &v, &v, &base_delta, &plans, &rules, &strat, EvalLimits::none(),
        )
        .expect("no executor error");
        assert!(out.is_none(), "negation → recompute fallback, never a wrong increment");
    }

    /// The envelope guard for `edge_attr`: its input is the edge METADATA blob, which
    /// `diff_base` cannot see (edges diff as bare `[src, type, dst]` triples). The test
    /// first PROVES the hazard — a metadata-only change yields an EMPTY `BaseDelta` while
    /// the from-scratch results differ — then asserts `maintain_incremental` refuses such
    /// a program (returns `None` → recompute) instead of silently keeping stale facts.
    #[test]
    fn incremental_refuses_edge_attr_returns_none() {
        let src = "via_import(A, B) :- edge(A, B, \"CALLS\"), edge_attr(A, B, \"CALLS\", \"via\", \"import\").";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let stats = Stats { total_nodes: 2, total_edges: 1, ..Default::default() };
        let plans = plan_program(&rules, &strat, &stats).expect("plan");

        // Same edge triple in both generations; ONLY the metadata blob changes.
        let mk = |meta: &str, gen: u64| {
            let mut v = FixtureStorageView::new(gen);
            edge(&mut v, "a", "b", "CALLS");
            v.put_edge_metadata(id_of("a"), id_of("b"), "CALLS", meta);
            v
        };
        let prev_view = mk("{\"via\":\"import\"}", 1);
        let cur_view = mk("{\"via\":\"dynamic\"}", 2);

        // The hazard, demonstrated: the base diff is EMPTY, yet scratch results differ.
        let base_delta = crate::derive::increment::diff_base(&prev_view, &cur_view);
        assert_eq!(base_delta.len(), 0, "metadata-only change is invisible to diff_base");
        let prev = run(src, &prev_view, stats.clone());
        let cur_scratch = run(src, &cur_view, stats);
        assert_ne!(
            prev.relations, cur_scratch.relations,
            "scratch DOES see the metadata change (via_import fact must disappear)"
        );

        // The guard: a program mentioning edge_attr is outside the envelope → recompute.
        let out = maintain_incremental::<BoolTag>(
            &prev, &prev_view, &cur_view, &base_delta, &plans, &rules, &strat, EvalLimits::none(),
        )
        .expect("no executor error");
        assert!(out.is_none(), "edge_attr → recompute fallback, never stale maintained facts");
    }

    /// The envelope guard for `node_attr`: its input is the NODE METADATA blob, which
    /// `diff_base` cannot see (nodes diff as `[id, type, name, file]` tuples — no metadata
    /// column). The test first PROVES the hazard — a node-metadata-only change yields an
    /// EMPTY `BaseDelta` while the from-scratch results differ — then asserts
    /// `maintain_incremental` refuses such a program (returns `None` → recompute) instead
    /// of silently keeping stale facts. The exact node twin of the `edge_attr` guard.
    #[test]
    fn incremental_refuses_node_attr_returns_none() {
        let src = "arrow_fn(A) :- node(A, \"FUNCTION\"), node_attr(A, \"kind\", \"arrow\").";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let stats = Stats { total_nodes: 1, total_edges: 0, ..Default::default() };
        let plans = plan_program(&rules, &strat, &stats).expect("plan");

        // Same node tuple (id/type/name/file) in both generations; ONLY the metadata
        // blob changes.
        let mk = |meta: &str, gen: u64| {
            let mut v = FixtureStorageView::new(gen);
            node(&mut v, "a", "FUNCTION");
            v.put_node_metadata(id_of("a"), meta);
            v
        };
        let prev_view = mk("{\"kind\":\"arrow\"}", 1);
        let cur_view = mk("{\"kind\":\"declaration\"}", 2);

        // The hazard, demonstrated: the base diff is EMPTY, yet scratch results differ.
        let base_delta = crate::derive::increment::diff_base(&prev_view, &cur_view);
        assert_eq!(base_delta.len(), 0, "node-metadata-only change is invisible to diff_base");
        let prev = run(src, &prev_view, stats.clone());
        let cur_scratch = run(src, &cur_view, stats);
        assert_ne!(
            prev.relations, cur_scratch.relations,
            "scratch DOES see the metadata change (arrow_fn fact must disappear)"
        );

        // The guard: a program mentioning node_attr is outside the envelope → recompute.
        let out = maintain_incremental::<BoolTag>(
            &prev, &prev_view, &cur_view, &base_delta, &plans, &rules, &strat, EvalLimits::none(),
        )
        .expect("no executor error");
        assert!(out.is_none(), "node_attr → recompute fallback, never stale maintained facts");
    }

    /// The envelope guard for `attr`'s GENERATOR mode with a non-first-class key:
    /// `attr(F, "kind", "arrow")` with a free id routes the key through the real view's
    /// metadata filter slots (`snapshot_nodes_by_attr`: anything outside `name`/`file`/
    /// `type` → `exported`-column or metadata-filter lookup), which `diff_base` cannot see
    /// (nodes diff as `[id, type, name, file]`) — so a metadata-only change yields an EMPTY
    /// `BaseDelta` and a silent maintained≠scratch divergence, exactly the `node_attr`
    /// hazard through a different door. The fixture's `nodes_by_attr` deliberately serves
    /// only first-class keys, so the divergence itself is only reachable on the LSM view;
    /// this test pins the REFUSAL (returns `None` → recompute) for both a metadata key and
    /// the `exported` column.
    #[test]
    fn incremental_refuses_attr_metadata_generator_returns_none() {
        let stats = Stats { total_nodes: 1, total_edges: 0, ..Default::default() };
        let mk = |gen: u64| {
            let mut v = FixtureStorageView::new(gen);
            node(&mut v, "a", "FUNCTION");
            v
        };
        let prev_view = mk(1);
        let cur_view = mk(2);
        let base_delta = crate::derive::increment::diff_base(&prev_view, &cur_view);
        assert_eq!(base_delta.len(), 0, "tuple-identical generations diff empty");

        for src in [
            "arrow_fn(A) :- attr(A, \"kind\", \"arrow\").",
            "exported_fn(A) :- attr(A, \"exported\", \"true\").",
        ] {
            let prog = parse_ext_program(src).expect("parse");
            let strat = stratify(&prog).expect("stratify");
            let rules = prog.rules();
            let plans = plan_program(&rules, &strat, &stats).expect("plan");
            let prev = run(src, &prev_view, stats.clone());
            let out = maintain_incremental::<BoolTag>(
                &prev, &prev_view, &cur_view, &base_delta, &plans, &rules, &strat,
                EvalLimits::none(),
            )
            .expect("no executor error");
            assert!(
                out.is_none(),
                "attr generator with non-first-class key → recompute fallback ({src})"
            );
        }
    }

    /// A WILDCARD id is the generator in disguise: the planner patterns `_` as Bound
    /// (`is_bound_or_const`), but `eval_attr` routes it through the same `nodes_by_attr`
    /// existence path as a free id — so the envelope guard must catch it syntactically,
    /// not from the plan pattern. (A wildcard-id `attr` shares no variable with any other
    /// literal, so the only plannable form is the ground existence probe.)
    #[test]
    fn incremental_refuses_attr_wildcard_id_metadata_key() {
        let src = "flag(\"y\") :- attr(_, \"kind\", \"arrow\").";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let stats = Stats { total_nodes: 1, total_edges: 0, ..Default::default() };
        let plans = plan_program(&rules, &strat, &stats).expect("plan");

        let mut prev_view = FixtureStorageView::new(1);
        node(&mut prev_view, "a", "FUNCTION");
        let mut cur_view = FixtureStorageView::new(2);
        node(&mut cur_view, "a", "FUNCTION");
        let base_delta = crate::derive::increment::diff_base(&prev_view, &cur_view);

        let prev = run(src, &prev_view, stats);
        let out = maintain_incremental::<BoolTag>(
            &prev, &prev_view, &cur_view, &base_delta, &plans, &rules, &strat,
            EvalLimits::none(),
        )
        .expect("no executor error");
        assert!(out.is_none(), "wildcard-id attr with metadata key → recompute fallback");
    }

    /// The guard must NOT over-refuse: an `attr` generator on a FIRST-CLASS key
    /// (`name`/`file`/`type`) reads only columns of the diffed node tuple — the stdlib
    /// `depends` rule is built on `attr(FreeId, "file", F)` generators, and refusing them
    /// would silently turn every `@materialize` maintain back into a full recompute.
    /// Maintained must stay available AND ≡ scratch across a node insertion.
    #[test]
    fn incremental_keeps_attr_first_class_generator_inside_envelope() {
        let src = "in_f(A) :- attr(A, \"file\", \"f.js\").";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let stats = Stats { total_nodes: 2, total_edges: 0, ..Default::default() };
        let plans = plan_program(&rules, &strat, &stats).expect("plan");

        let mut prev_view = FixtureStorageView::new(1);
        node(&mut prev_view, "a", "FUNCTION");
        let mut cur_view = FixtureStorageView::new(2);
        node(&mut cur_view, "a", "FUNCTION");
        node(&mut cur_view, "b", "FUNCTION");

        let base_delta = crate::derive::increment::diff_base(&prev_view, &cur_view);
        assert_eq!(base_delta.len(), 1, "one asserted node");

        let prev = run(src, &prev_view, stats.clone());
        let maintained = maintain_incremental::<BoolTag>(
            &prev, &prev_view, &cur_view, &base_delta, &plans, &rules, &strat,
            EvalLimits::none(),
        )
        .expect("no executor error")
        .expect("first-class attr generator stays INSIDE the maintain envelope");
        let scratch = run(src, &cur_view, stats);
        assert_eq!(maintained.relations, scratch.relations, "maintained ≡ scratch");
    }

    /// DRed end-to-end: deleting a base edge whose derived fact still has an ALTERNATE
    /// derivation must KEEP that fact (over-delete marks it, re-derive restores it). Diamond
    /// a→b, a→c, b→d, c→d; delete b→d; `(a,d)` survives via a→c→d.
    #[test]
    fn deletion_rederives_fact_with_surviving_alternate_path() {
        use crate::derive::increment::diff_base;
        let (src,) = closure_program();
        let prog = parse_ext_program(&src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 4, total_edges: 4, ..Default::default() },
        )
        .expect("plan");

        let mk = |edges: &[(&str, &str)], gen: u64| {
            let mut v = FixtureStorageView::new(gen);
            for &(s, d) in edges {
                edge(&mut v, s, d, "E");
            }
            v
        };
        let prev_view = mk(&[("a", "b"), ("a", "c"), ("b", "d"), ("c", "d")], 1);
        let cur_view = mk(&[("a", "b"), ("a", "c"), ("c", "d")], 2); // b→d deleted
        let prev = Executor::<BoolTag>::with_limits(&prev_view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
            .evaluate(&plans, &rules, &strat)
            .expect("prev");

        let base_delta = diff_base(&prev_view, &cur_view);
        let maintained = maintain_incremental::<BoolTag>(
            &prev, &prev_view, &cur_view, &base_delta, &plans, &rules, &strat, EvalLimits::none(),
        )
        .expect("maintain")
        .expect("monotone envelope");
        let scratch = Executor::<BoolTag>::with_limits(&cur_view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
            .evaluate(&plans, &rules, &strat)
            .expect("scratch");

        assert_eq!(maintained.relations, scratch.relations, "DRed ≡ scratch on diamond delete");
        // (a,d) must still be present — re-derived from the surviving a→c→d.
        let ad = maintained
            .facts("path")
            .iter()
            .any(|r| r[0] == Value::Id(id_of("a")) && r[1] == Value::Id(id_of("d")));
        assert!(ad, "(a,d) survives via the alternate a→c→d derivation");
    }

    /// The full Gate C EXIT invariant: over 100 seeded base edits that MIX insertions and
    /// deletions, the maintained relation (DRed + insertion) is byte-identical to scratch.
    #[test]
    fn incremental_mixed_insert_delete_equals_scratch_over_seeded_cycles() {
        use crate::derive::increment::diff_base;
        let (src,) = closure_program();
        let prog = parse_ext_program(&src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 6, total_edges: 8, ..Default::default() },
        )
        .expect("plan");

        const N: u128 = 6;
        let nid = |i: u128| id_of(&format!("n{i}"));
        let build = |edges: &[(u128, u128)], gen: u64| {
            let mut v = FixtureStorageView::new(gen);
            for &(s, d) in edges {
                v.put_edge(EdgeRow { src: nid(s), dst: nid(d), edge_type: "E".to_string() });
            }
            v
        };
        let eval_scratch = |view: &FixtureStorageView| {
            Executor::<BoolTag>::with_limits(view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
                .evaluate(&plans, &rules, &strat)
                .expect("scratch")
        };

        let mut edges: Vec<(u128, u128)> = vec![(0, 1), (1, 2), (2, 3), (3, 4)];
        let mut prev_view = build(&edges, 0);
        let mut prev_eval = eval_scratch(&prev_view);

        let mut lcg: u64 = 0xD1B5_4A32_D192_ED03;
        let (mut saw_insert, mut saw_delete) = (false, false);
        for cycle in 1..=100u64 {
            lcg = lcg.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let s = ((lcg >> 33) as u128) % N;
            let d = ((lcg >> 17) as u128) % N;
            let remove = (lcg >> 3) & 1 == 0;
            if remove {
                match edges.iter().position(|&e| e == (s, d)) {
                    Some(pos) => {
                        edges.remove(pos);
                        saw_delete = true;
                    }
                    None => continue,
                }
            } else if edges.contains(&(s, d)) {
                continue;
            } else {
                edges.push((s, d));
                saw_insert = true;
            }
            let cur_view = build(&edges, cycle);
            let base_delta = diff_base(&prev_view, &cur_view);
            let maintained = maintain_incremental::<BoolTag>(
                &prev_eval, &prev_view, &cur_view, &base_delta, &plans, &rules, &strat,
                EvalLimits::none(),
            )
            .expect("maintain")
            .expect("monotone envelope");
            let scratch = eval_scratch(&cur_view);
            assert_eq!(
                maintained.relations, scratch.relations,
                "cycle {cycle}: maintained ≡ scratch ({}n{s}->n{d})",
                if remove { "del " } else { "add " }
            );
            prev_view = cur_view;
            prev_eval = maintained;
        }
        assert!(saw_insert && saw_delete, "the mix exercised both insertion and deletion");
    }

    /// Gate C exit, second half (spec §13 line 339: "work-proportionality holds"). Having
    /// proven maintained ≡ scratch, prove the incremental path's work scales with the base
    /// DELTA's impact, not the base SIZE. Method: insert one ISOLATED edge (its closure
    /// impact is a single new fact, constant regardless of base size) into a transitive-
    /// closure view over a growing chain, measuring total base rows touched through the
    /// `StorageView` (`WorkCountingView`). As the base grows, a from-scratch evaluation does
    /// strictly more work (it recomputes the whole closure) while the maintain run stays
    /// ~flat (it only touches the delta and the empty neighbourhood it propagates into).
    #[test]
    fn incremental_insertion_work_proportional_to_delta_not_base_size() {
        use crate::derive::increment::diff_base;
        let (src,) = closure_program();
        let prog = parse_ext_program(&src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 32, total_edges: 32, ..Default::default() },
        )
        .expect("plan");

        let nid = |i: u128| id_of(&format!("n{i}"));
        let build = |edges: &[(u128, u128)]| {
            let mut v = FixtureStorageView::new(1);
            for &(s, d) in edges {
                v.put_edge(EdgeRow { src: nid(s), dst: nid(d), edge_type: "E".to_string() });
            }
            v
        };
        // The delta: a small ISOLATED component (two fresh nodes' chain n900→n901→n902),
        // disconnected from the bulk chain. Its closure impact (3 new paths) is constant,
        // INDEPENDENT of how big the rest of the base is — so the incremental work must be a
        // small constant while a from-scratch run pays for the whole growing base.
        let delta_edges: [(u128, u128); 2] = [(900, 901), (901, 902)];

        // Measure (maintain_work, scratch_work) for a base chain of `k` edges.
        let measure = |k: u128| -> (usize, usize) {
            let base: Vec<(u128, u128)> = (0..k).map(|i| (i, i + 1)).collect();
            let mut cur = base.clone();
            cur.extend_from_slice(&delta_edges);
            let prev = Executor::<BoolTag>::new(&build(&base))
                .evaluate(&plans, &rules, &strat)
                .expect("prev");
            let delta = diff_base(&build(&base), &build(&cur));

            let pv = WorkCountingView::new(build(&base));
            let cv = WorkCountingView::new(build(&cur));
            let maintained = maintain_incremental::<BoolTag>(
                &prev, &pv, &cv, &delta, &plans, &rules, &strat, EvalLimits::none(),
            )
            .expect("maintain")
            .expect("monotone envelope");

            let sv = WorkCountingView::new(build(&cur));
            let scratch = Executor::<BoolTag>::new(&sv)
                .evaluate(&plans, &rules, &strat)
                .expect("scratch");
            assert_eq!(maintained.relations, scratch.relations, "k={k}: still ≡ scratch");
            (pv.rows.load(Ordering::Relaxed) + cv.rows.load(Ordering::Relaxed), sv.rows.load(Ordering::Relaxed))
        };

        let (m_small, s_small) = measure(6);
        let (m_large, s_large) = measure(24); // 4× the base
        eprintln!(
            "WORK-PROP scaling: maintain {m_small}->{m_large}  scratch {s_small}->{s_large}"
        );

        // 1. Scratch work scales with base size — quadrupling the chain costs it much more.
        assert!(
            s_large > s_small * 2,
            "scratch work must grow with base size (small={s_small}, large={s_large})"
        );
        // 2. Maintain work stays ~flat — the isolated delta's impact is base-size-independent;
        //    a 4× larger base must not materially increase the incremental work.
        assert!(
            m_large <= m_small + 4,
            "maintain work must stay ~flat as the base grows \
             (small={m_small}, large={m_large})"
        );
        // 3. At the larger size the incremental win is decisive.
        assert!(
            m_large * 4 < s_large,
            "maintain must do far less work than scratch at scale \
             (maintain={m_large}, scratch={s_large})"
        );
    }

    // ── why(): one supporting derivation ────────────────────────────

    #[test]
    fn why_explains_a_transitive_path_and_a_direct_one() {
        use crate::derive::exec::explain_fact;
        let (src,) = closure_program();
        let prog = parse_ext_program(&src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 3, total_edges: 2, ..Default::default() },
        )
        .expect("plan");
        let mut v = FixtureStorageView::new(1);
        edge(&mut v, "a", "b", "E");
        edge(&mut v, "b", "c", "E");

        let recursive_hash =
            crate::derive::materialize::rule_ast_hash(&prog.items[1].rule); // clause 2
        let base_hash =
            crate::derive::materialize::rule_ast_hash(&prog.items[0].rule); // clause 1

        // path(a,c) is transitive: derived by `path :- edge(a,C), path(C,c)` with C=b.
        let w = explain_fact::<BoolTag>(
            &v, &plans, &rules, &strat, "path",
            &[Value::Id(id_of("a")), Value::Id(id_of("c"))], EvalLimits::none(),
        )
        .expect("no error")
        .expect("path(a,c) is derivable");
        assert_eq!(w.rule_ast_hash, recursive_hash, "explained by the recursive clause");
        let preds: Vec<&str> = w.body.iter().map(|(p, _)| p.as_str()).collect();
        assert!(preds.contains(&"edge") && preds.contains(&"path"), "body = edge + path: {preds:?}");
        // The supporting `path` body fact is exactly path(b,c).
        let path_fact = w.body.iter().find(|(p, _)| p == "path").map(|(_, t)| t).unwrap();
        assert_eq!(&path_fact[..], &[Value::Id(id_of("b")), Value::Id(id_of("c"))]);

        // path(a,b) is direct: derived by `path :- edge(a,b)` (the first clause).
        let w2 = explain_fact::<BoolTag>(
            &v, &plans, &rules, &strat, "path",
            &[Value::Id(id_of("a")), Value::Id(id_of("b"))], EvalLimits::none(),
        )
        .unwrap()
        .expect("path(a,b) is derivable");
        assert_eq!(w2.rule_ast_hash, base_hash, "explained by the base clause");
        assert_eq!(w2.body.len(), 1, "one body fact (the edge)");
        assert_eq!(w2.body[0].0, "edge");

        // A non-fact has no derivation.
        let none = explain_fact::<BoolTag>(
            &v, &plans, &rules, &strat, "path",
            &[Value::Id(id_of("c")), Value::Id(id_of("a"))], EvalLimits::none(),
        )
        .unwrap();
        assert!(none.is_none(), "path(c,a) is not derivable → no witness");
    }

    // ── why-NOT(): the unbound premise of a missing fact (coverage / §6) ──

    /// `explain_gap` names the FIRST body premise that no binding satisfies for a fact that is
    /// NOT derived — the why-not dual of `why()`. Program: `p(X) :- node(X,"FUNCTION"),
    /// edge(X,Y,"CALLS")`. `f1` calls `g` (so `p(f1)` holds); `f2` is a FUNCTION with no CALLS
    /// edge, so `p(f2)` fails exactly at the `edge` premise — the missing premise sim would add.
    #[test]
    fn why_not_names_the_unbound_premise_of_a_missing_fact() {
        use crate::derive::exec::explain_gap;
        let src = "p(X) :- node(X, \"FUNCTION\"), edge(X, Y, \"CALLS\").";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 3, total_edges: 1, ..Default::default() },
        )
        .expect("plan");
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "f1", "FUNCTION");
        node(&mut v, "f2", "FUNCTION");
        node(&mut v, "g", "FUNCTION");
        edge(&mut v, "f1", "g", "CALLS"); // f1 calls g → p(f1) holds; f2 calls nothing.

        // p(f2): NOT derived — the gap is the missing `edge(f2, _, "CALLS")` premise.
        let gap = explain_gap::<BoolTag>(
            &v, &plans, &rules, &strat, "p", &[Value::Id(id_of("f2"))], EvalLimits::none(),
        )
        .expect("no error")
        .expect("p(f2) is NOT derivable → a gap");
        assert_eq!(gap.failing_predicate, "edge", "the unbound premise is the CALLS edge");
        assert!(!gap.failing_is_negative, "a MISSING positive premise (closes by adding), not a blocker");

        // p(f1): IS derivable → no gap.
        let none = explain_gap::<BoolTag>(
            &v, &plans, &rules, &strat, "p", &[Value::Id(id_of("f1"))], EvalLimits::none(),
        )
        .unwrap();
        assert!(none.is_none(), "p(f1) is derivable (f1 calls g) → no gap");
    }

    /// `witness_gap` over a MULTI-clause predicate reports the gap of the clause that came
    /// CLOSEST to firing (longest satisfied prefix), not the first clause that fails. Two rules
    /// for `q`: rule 1 fails immediately (no `R1` edge), rule 2 satisfies one more premise
    /// (`R2` holds) before failing at `R3`. The reported gap must be rule 2's (deeper prefix).
    #[test]
    fn why_not_reports_the_closest_to_firing_clause() {
        use crate::derive::exec::explain_gap;
        let src = "q(X) :- node(X, \"A\"), edge(X, Y, \"R1\").\n\
                   q(X) :- node(X, \"A\"), edge(X, Y, \"R2\"), edge(Y, Z, \"R3\").";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 2, total_edges: 1, ..Default::default() },
        )
        .expect("plan");
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "x", "A");
        node(&mut v, "y", "A");
        edge(&mut v, "x", "y", "R2"); // rule 2 gets one premise deeper than rule 1; no R1, no R3.

        let gap = explain_gap::<BoolTag>(
            &v, &plans, &rules, &strat, "q", &[Value::Id(id_of("x"))], EvalLimits::none(),
        )
        .expect("no error")
        .expect("q(x) is not derivable → a gap");
        // Rule 2 satisfied {node, edge(R2)} before failing → prefix ≥ 2 (beats rule 1's ≤ 1).
        assert!(
            gap.satisfied.len() >= 2,
            "reported the closest-to-firing clause (rule 2, deeper prefix), got prefix {}",
            gap.satisfied.len()
        );
        assert_eq!(gap.failing_predicate, "edge", "the deepest gap is the missing R3 edge");
    }

    /// A NEGATED premise that fails is a PRESENT blocker, not a missing fact — the gap closes by
    /// REMOVING it (`failing_is_negative = true`). Program: `safe(X) :- node(X,"FUNCTION"),
    /// \+ edge(X,Y,"DANGER")`. f2 has a DANGER edge, so `safe(f2)` is blocked at the anti-join.
    #[test]
    fn why_not_flags_a_present_blocker_for_a_negated_premise() {
        use crate::derive::exec::explain_gap;
        let src = "safe(X) :- node(X, \"FUNCTION\"), \\+ edge(X, _, \"DANGER\").";
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 2, total_edges: 1, ..Default::default() },
        )
        .expect("plan");
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "f1", "FUNCTION");
        node(&mut v, "f2", "FUNCTION");
        edge(&mut v, "f2", "f1", "DANGER"); // f2 has a DANGER edge → safe(f2) is blocked.

        // safe(f2): NOT derived — blocked by the PRESENT danger edge (close by removing it).
        let gap = explain_gap::<BoolTag>(
            &v, &plans, &rules, &strat, "safe", &[Value::Id(id_of("f2"))], EvalLimits::none(),
        )
        .expect("no error")
        .expect("safe(f2) is NOT derivable → a gap");
        assert_eq!(gap.failing_predicate, "edge", "blocked at the negated DANGER-edge premise");
        assert!(gap.failing_is_negative, "a PRESENT blocker (close by REMOVING), not a missing premise");

        // safe(f1): no danger edge → derivable, no gap.
        let none = explain_gap::<BoolTag>(
            &v, &plans, &rules, &strat, "safe", &[Value::Id(id_of("f1"))], EvalLimits::none(),
        )
        .unwrap();
        assert!(none.is_none(), "safe(f1) holds (no DANGER edge) → no gap");
    }

    /// A NAMED var appearing ONLY inside a negated literal is UNSAFE Datalog (it can never be
    /// positively bound, so a negated leg cannot existentially close over it as a wildcard does).
    /// The planner correctly REJECTS it as `Infeasible` (E-PLAN-002) — it does NOT silently
    /// mis-handle it. The wildcard form is the well-formed existential and evaluates correctly.
    /// (This pins the SAFETY behavior; an earlier note mistook the plan-time rejection for a
    /// silent why-not gap — it is a correct rejection, see gaps.md correction.)
    #[test]
    fn named_existential_var_in_negation_is_rejected_as_unsafe() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "f1", "FUNCTION");
        node(&mut v, "f2", "FUNCTION");
        edge(&mut v, "f2", "f1", "DANGER"); // f2 has danger; f1 does not.
        let stats = Stats { total_nodes: 2, total_edges: 1, ..Default::default() };

        // Wildcard existential = well-formed: only f1 (no danger edge) is safe.
        let wild = run("safe(X) :- node(X, \"FUNCTION\"), \\+ edge(X, _, \"DANGER\").", &v, stats.clone());
        assert_eq!(ids(&wild, "safe"), vec![id_of("f1")], "wildcard `\\+ edge(X,_,DANGER)`: only f1 is safe");

        // Named var Y used ONLY in the negation = UNSAFE → the planner rejects it (E-PLAN-002),
        // rather than producing a wrong or vacuous result.
        let prog = parse_ext_program("safe(X) :- node(X, \"FUNCTION\"), \\+ edge(X, Y, \"DANGER\").")
            .expect("parses (safety is a planner check, not a parse error)");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let err = plan_program(&rules, &strat, &stats).expect_err("named-only-in-negation is unsafe → rejected");
        assert_eq!(err.code.as_str(), "E-PLAN-002", "rejected as infeasible/unsafe, got {:?}", err.code);
    }

    // ── DRed phase 1: over-delete candidate set ─────────────────────

    /// Pre-load each derived predicate's `Total` from a prior `Evaluation`, keyed by the same
    /// deterministic `fact_id` `over_delete`/`evaluate_incremental` use (the test analogue of
    /// the engine's prior-snapshot load).
    fn preload(
        prev: &Evaluation,
        pred_ids: &HashMap<String, u64>,
    ) -> HashMap<String, Relation<BoolTag>> {
        let mut relations: HashMap<String, Relation<BoolTag>> = HashMap::new();
        for (name, rows) in &prev.relations {
            let pid = pred_ids[name];
            let rel = relations.entry(name.clone()).or_insert_with(Relation::new);
            for key in rows {
                rel.total.insert(
                    fact_id(pid, key),
                    DerivedFact { key: key.clone(), tag: BoolTag::one() },
                );
            }
        }
        relations
    }

    /// The `(src, dst)` id-pairs of a binary derived predicate's over-delete candidate set.
    fn pair_set(
        candidates: &HashMap<String, HashMap<u64, DerivedFact<BoolTag>>>,
        pred: &str,
    ) -> std::collections::BTreeSet<(u128, u128)> {
        candidates
            .get(pred)
            .into_iter()
            .flat_map(|m| m.values())
            .map(|f| match (&f.key[0], &f.key[1]) {
                (Value::Id(s), Value::Id(d)) => (*s, *d),
                _ => panic!("expected id columns"),
            })
            .collect()
    }

    fn closure_program() -> (String,) {
        ("path(A, B) :- edge(A, B, \"E\").\n\
          path(A, B) :- edge(A, C, \"E\"), path(C, B)."
            .to_string(),)
    }

    #[test]
    fn over_delete_marks_all_paths_through_a_deleted_edge() {
        // Chain a → b → c → d; delete b→c. Every path that used b→c must be a candidate
        // (no alternates in a chain), and nothing else.
        let (src,) = closure_program();
        let prog = parse_ext_program(&src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 4, total_edges: 3, ..Default::default() },
        )
        .expect("plan");
        let pred_ids = assign_pred_ids(&strat);

        let mut old_base = FixtureStorageView::new(1);
        for (s, d) in [("a", "b"), ("b", "c"), ("c", "d")] {
            edge(&mut old_base, s, d, "E");
        }
        let prev = Executor::<BoolTag>::with_limits(&old_base, EvalLimits::none(), DEFAULT_ITERATION_CAP)
            .evaluate(&plans, &rules, &strat)
            .expect("prev closure");

        // ΔB⁻ = {edge b→c}.
        let mut retracted = FixtureStorageView::new(1);
        edge(&mut retracted, "b", "c", "E");

        let mut relations = preload(&prev, &pred_ids);
        let exec =
            Executor::<BoolTag>::with_limits(&old_base, EvalLimits::none(), DEFAULT_ITERATION_CAP)
                .with_delta_view(&retracted);
        let candidates = exec
            .over_delete(&plans, &rules, &strat, &pred_ids, &mut relations)
            .expect("over_delete");

        let got = pair_set(&candidates, "path");
        let want: std::collections::BTreeSet<(u128, u128)> = [
            (id_of("a"), id_of("c")),
            (id_of("a"), id_of("d")),
            (id_of("b"), id_of("c")),
            (id_of("b"), id_of("d")),
        ]
        .into_iter()
        .collect();
        assert_eq!(got, want, "exactly the paths that used b→c");
        // Total is untouched (over_delete computes, does not mutate — re-derive removes later).
        assert!(relations["path"].total.len() >= want.len() + 2, "prev Total intact");
    }

    #[test]
    fn over_delete_over_approximates_a_fact_with_an_alternate_derivation() {
        // Diamond: a→b, a→c, b→d, c→d. Delete b→d. (a,d) has an ALTERNATE derivation via
        // a→c→d, but it ALSO had one through b→d, so over-delete (correctly) lists it as a
        // candidate — the re-derive phase (commit 7) is what restores it.
        let (src,) = closure_program();
        let prog = parse_ext_program(&src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(
            &rules,
            &strat,
            &Stats { total_nodes: 4, total_edges: 4, ..Default::default() },
        )
        .expect("plan");
        let pred_ids = assign_pred_ids(&strat);

        let mut old_base = FixtureStorageView::new(1);
        for (s, d) in [("a", "b"), ("a", "c"), ("b", "d"), ("c", "d")] {
            edge(&mut old_base, s, d, "E");
        }
        let prev = Executor::<BoolTag>::with_limits(&old_base, EvalLimits::none(), DEFAULT_ITERATION_CAP)
            .evaluate(&plans, &rules, &strat)
            .expect("prev closure");

        let mut retracted = FixtureStorageView::new(1);
        edge(&mut retracted, "b", "d", "E");

        let mut relations = preload(&prev, &pred_ids);
        let candidates =
            Executor::<BoolTag>::with_limits(&old_base, EvalLimits::none(), DEFAULT_ITERATION_CAP)
                .with_delta_view(&retracted)
                .over_delete(&plans, &rules, &strat, &pred_ids, &mut relations)
                .expect("over_delete");

        let got = pair_set(&candidates, "path");
        assert!(got.contains(&(id_of("b"), id_of("d"))), "deleted edge's path is a candidate");
        assert!(
            got.contains(&(id_of("a"), id_of("d"))),
            "(a,d) over-deleted even though a→c→d survives (re-derive restores it)"
        );
        assert!(!got.contains(&(id_of("c"), id_of("d"))), "c→d path untouched");
        assert!(!got.contains(&(id_of("a"), id_of("c"))), "a→c path untouched");
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

    use crate::derive::storage_glue::{EdgeOrder, NodeRow as GlueNodeRow};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Wraps a fixture view and counts how many full typed relation scans the run issues,
    /// so a test can assert the set-at-once anti-join touches each negated base relation a
    /// BOUNDED number of times (independent of the row count) — not once per row.
    struct ScanCountingView {
        inner: FixtureStorageView,
        edge_scans: AtomicUsize,
        node_scans: AtomicUsize,
        /// Full attr-index reverse lookups (`nodes_by_attr`) — the per-row cost the
        /// build-once attr hash-join eliminates.
        attr_calls: AtomicUsize,
        /// Sorted-node passes (`sorted_run(Nodes, …)`) — the bounded build side of the
        /// build-once attr hash-join.
        node_sorted_runs: AtomicUsize,
    }

    impl ScanCountingView {
        fn new(inner: FixtureStorageView) -> Self {
            Self {
                inner,
                edge_scans: AtomicUsize::new(0),
                node_scans: AtomicUsize::new(0),
                attr_calls: AtomicUsize::new(0),
                node_sorted_runs: AtomicUsize::new(0),
            }
        }
    }

    impl StorageView for ScanCountingView {
        fn generation(&self) -> u64 {
            self.inner.generation()
        }
        fn sorted_run(
            &self,
            rel: crate::derive::storage_glue::Relation,
            order: crate::derive::storage_glue::SortOrder,
        ) -> Box<dyn Iterator<Item = crate::derive::storage_glue::Row> + '_> {
            if rel == crate::derive::storage_glue::Relation::Nodes {
                self.node_sorted_runs.fetch_add(1, Ordering::Relaxed);
            }
            self.inner.sorted_run(rel, order)
        }
        fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = GlueNodeRow> + '_> {
            self.node_scans.fetch_add(1, Ordering::Relaxed);
            self.inner.scan_nodes_by_type(ty)
        }
        fn scan_edges_by_type(
            &self,
            ty: &str,
            order: EdgeOrder,
        ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
            self.edge_scans.fetch_add(1, Ordering::Relaxed);
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
            self.attr_calls.fetch_add(1, Ordering::Relaxed);
            self.inner.nodes_by_attr(key, value)
        }
        fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
            self.inner.edge_metadata(src, dst, edge_type)
        }
        fn node_metadata(&self, id: u128) -> Option<String> {
            self.inner.node_metadata(id)
        }
        fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)> {
            self.inner.scan_edge_metadata_by_type(edge_type)
        }
    }

    /// Wraps a fixture view and counts the TOTAL number of base rows the run touches across
    /// every access method (typed scans, sorted runs, keyed `edges_from`/`edges_to`,
    /// point lookups). This is the honest "storage work" metric for the work-proportionality
    /// gate: a from-scratch run reads the whole base, an incremental run should read only the
    /// delta plus the bounded slices its propagation probes.
    struct WorkCountingView {
        inner: FixtureStorageView,
        rows: AtomicUsize,
    }
    impl WorkCountingView {
        fn new(inner: FixtureStorageView) -> Self {
            Self { inner, rows: AtomicUsize::new(0) }
        }
        fn bump(&self, n: usize) {
            self.rows.fetch_add(n, Ordering::Relaxed);
        }
    }
    impl StorageView for WorkCountingView {
        fn generation(&self) -> u64 {
            self.inner.generation()
        }
        fn sorted_run(
            &self,
            rel: crate::derive::storage_glue::Relation,
            order: crate::derive::storage_glue::SortOrder,
        ) -> Box<dyn Iterator<Item = crate::derive::storage_glue::Row> + '_> {
            let rows: Vec<_> = self.inner.sorted_run(rel, order).collect();
            self.bump(rows.len());
            Box::new(rows.into_iter())
        }
        fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = GlueNodeRow> + '_> {
            let rows: Vec<_> = self.inner.scan_nodes_by_type(ty).collect();
            self.bump(rows.len());
            Box::new(rows.into_iter())
        }
        fn scan_edges_by_type(
            &self,
            ty: &str,
            order: EdgeOrder,
        ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
            let rows: Vec<_> = self.inner.scan_edges_by_type(ty, order).collect();
            self.bump(rows.len());
            Box::new(rows.into_iter())
        }
        fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
            let rows = self.inner.edges_from(src, edge_type);
            self.bump(rows.len());
            rows
        }
        fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
            let rows = self.inner.edges_to(dst, edge_type);
            self.bump(rows.len());
            rows
        }
        fn get_node(&self, id: u128) -> Option<GlueNodeRow> {
            let r = self.inner.get_node(id);
            self.bump(r.is_some() as usize);
            r
        }
        fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<GlueNodeRow> {
            let rows = self.inner.nodes_by_attr(key, value);
            self.bump(rows.len());
            rows
        }
        fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
            let r = self.inner.edge_metadata(src, dst, edge_type);
            self.bump(r.is_some() as usize);
            r
        }
        fn node_metadata(&self, id: u128) -> Option<String> {
            let r = self.inner.node_metadata(id);
            self.bump(r.is_some() as usize);
            r
        }
        fn scan_edge_metadata_by_type(&self, edge_type: &str) -> Vec<(u128, u128, String)> {
            let rows = self.inner.scan_edge_metadata_by_type(edge_type);
            self.bump(rows.len());
            rows
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
            view.edge_scans.load(Ordering::Relaxed) <= 1,
            "set-at-once anti-join scans the CALLS relation at most once (got {}), \
             not once per row",
            view.edge_scans.load(Ordering::Relaxed)
        );
        assert!(
            view.edge_scans.load(Ordering::Relaxed) < n,
            "edge scans ({}) must be bounded, not O(rows={})",
            view.edge_scans.load(Ordering::Relaxed),
            n
        );
    }

    // ── Part A: the executor-owned index cache survives semi-naive iterations ──

    /// A RECURSIVE rule (transitive closure over a chain) drives the Δ-loop through ~n
    /// iterations, and every iteration re-applies the clause's base `edge` leg. Before the
    /// executor-owned index cache, `join_edge_bound_built_once` re-built its hash side —
    /// one FULL `scan_edges_by_type` pass — on every iteration ("build-once" was per CALL,
    /// not per evaluation: the W1 review finding). With the cache the index is built once
    /// per (type, order, shape) per EVALUATION: the typed-edge scan count must be O(1),
    /// independent of the iteration count, and the executor's cache counters must show
    /// iterations-many hits against a constant number of builds.
    #[test]
    fn recursive_closure_builds_edge_index_once_across_iterations() {
        let n = 48usize; // chain length ⇒ ~n Δ-rounds to saturate the closure
        let mut v = FixtureStorageView::new(1);
        for i in 0..=n {
            node(&mut v, &format!("c{i}"), "STEP");
        }
        for i in 0..n {
            edge(&mut v, &format!("c{i}"), &format!("c{}", i + 1), "NEXT");
        }
        let view = ScanCountingView::new(v);
        let src = r#"
            reach(X, Y) :- edge(X, Y, "NEXT").
            reach(X, Y) :- reach(X, Z), edge(Z, Y, "NEXT").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let stats = Stats {
            total_nodes: (n + 1) as u64,
            total_edges: n as u64,
            ..Default::default()
        };
        let plans = plan_program(&rules, &strat, &stats).expect("plan");
        // Force the build-once fast paths on every eligible leg regardless of the Δ row
        // count, so the small fixture exercises exactly the code path the big packs take.
        let exec =
            Executor::<BoolTag>::with_limits(&view, EvalLimits::none(), DEFAULT_ITERATION_CAP)
                .with_build_once_min_rows(0);
        let eval = exec.evaluate(&plans, &rules, &strat).expect("evaluate");

        // Correctness floor: the closure of a chain c0→…→cn has n(n+1)/2 pairs.
        assert_eq!(
            eval.facts("reach").len(),
            n * (n + 1) / 2,
            "transitive closure of an {n}-edge chain"
        );

        // The cache proof, at the storage boundary: the typed NEXT scan ran a bounded,
        // iteration-independent number of times (one per cached index shape — the
        // recursive clause's bound-endpoint index, plus at most one generator pass for
        // the non-recursive seed clause), NOT once per Δ-round.
        let scans = view.edge_scans.load(Ordering::Relaxed);
        assert!(
            scans <= 3,
            "typed edge scans must be O(1) per evaluation (got {scans}); \
             before the index cache this was O(iterations) ≈ {n}"
        );
        assert!(
            scans < n / 2,
            "edge scans ({scans}) must not grow with the ~{n} Δ-iterations"
        );

        // And at the executor's own counters: the Δ-loop served the edge leg from cache
        // on (almost) every iteration — many hits, a constant number of builds.
        let (builds, hits) = exec.index_cache_counts();
        assert!(
            builds <= 2,
            "at most one index build per cached shape (got {builds})"
        );
        assert!(
            hits as usize >= n / 2,
            "the ~{n} Δ-iterations must be served from the cache (got {hits} hits)"
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
            view.attr_calls.load(Ordering::Relaxed),
            0,
            "attr value-generator must be built once (sorted_run), never per-row nodes_by_attr"
        );
        // The hash side is built with a BOUNDED number of sorted-node passes — crucially NOT
        // proportional to the n driver rows (a per-row build would be ≥ n).
        assert!(
            view.node_sorted_runs.load(Ordering::Relaxed) < n,
            "sorted-node passes ({}) must be bounded, not O(rows={})",
            view.node_sorted_runs.load(Ordering::Relaxed),
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
        use crate::derive::events::{EventKind, EVENT_SCHEMA_VERSION};

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
        use crate::derive::events::{EventKind, EventLog, SharedMemSink};

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

    /// Differential property test for the build-once extensional fast paths (the 4th
    /// q-error layer fix): on a fixture covering every special-cased leg shape — edge
    /// near-bound / far-bound / both-bound / wildcard endpoint, `incoming`, attr
    /// value-free / value-const / shared-variable / non-first-class key, node membership,
    /// a dangling edge endpoint (missing node), and a non-id binding probed into an edge
    /// endpoint (per-row fallback parity) — the build-once path (threshold 0) and the
    /// per-row path (threshold MAX) must produce IDENTICAL `BindRow` MULTISETS at every
    /// base leg of every planned clause: same rows, same multiplicities, leg by leg. Then
    /// the two full evaluations must commit identical fact sets per predicate.
    #[test]
    fn build_once_extensional_paths_match_per_row_multisets() {
        let mut v = FixtureStorageView::new(1);
        // Type A nodes (two share the name "dup" — duplicate-name fan-out).
        for (sid, name) in [
            ("a1", "dup"),
            ("a2", "dup"),
            ("a3", "x"),
            ("a4", "a4"),
            ("a5", "recv"),
            ("a6", "zz"),
        ] {
            v.put_node(NodeRow {
                id: id_of(sid),
                node_type: "A".to_string(),
                name: name.to_string(),
                file: "f.js".to_string(),
            });
        }
        // Type B nodes (b1 shares the name "dup" with a1/a2 — the shared-var attr join).
        for (sid, name) in [("b1", "dup"), ("b2", "y"), ("b3", "b3")] {
            v.put_node(NodeRow {
                id: id_of(sid),
                node_type: "B".to_string(),
                name: name.to_string(),
                file: "f.js".to_string(),
            });
        }
        // E edges: fan-out 2 from a1; a4 -> a dangling id (no node row); a5 -> b1.
        for (s, d) in [("a1", "b1"), ("a1", "b2"), ("a2", "b1"), ("a3", "b3"), ("a5", "b1")] {
            edge(&mut v, s, d, "E");
        }
        v.put_edge(EdgeRow {
            src: id_of("a4"),
            dst: id_of("missing-node"),
            edge_type: "E".to_string(),
        });
        // E2 edges: exactly one overlaps E (a1 -> b1) for the both-bound membership check.
        edge(&mut v, "a1", "b1", "E2");
        edge(&mut v, "a6", "b3", "E2");

        let src = r#"
            e_far(X, Y)    :- node(X, "A"), edge(X, Y, "E").
            e_far_w(X)     :- node(X, "A"), edge(X, _, "E").
            e_near(Y, X)   :- node(Y, "B"), edge(X, Y, "E").
            e_in(Y, X)     :- node(Y, "B"), incoming(Y, X, "E").
            e_both(X, Y)   :- edge(X, Y, "E"), edge(X, Y, "E2").
            a_free(X, N)   :- node(X, "A"), attr(X, "name", N).
            a_const(X)     :- node(X, "A"), attr(X, "name", "dup").
            a_shared(X, Y) :- node(X, "A"), edge(X, Y, "E"), attr(X, "name", N), attr(Y, "name", N).
            a_meta(X)      :- node(X, "A"), attr(X, "weird_key", _).
            n_member(X, Y) :- edge(X, Y, "E"), node(Y, "B").
            str_probe(NM, Y) :- node(C, "A"), attr(C, "name", NM), edge(NM, Y, "E").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats::default()).expect("plan");

        // Threshold 0 forces build-once on every eligible leg; MAX forces per-row always.
        let fast = Executor::<BoolTag>::new(&v).with_build_once_min_rows(0);
        let slow = Executor::<BoolTag>::new(&v).with_build_once_min_rows(usize::MAX);

        fn multiset(rows: &[BindRow]) -> HashMap<BindRow, usize> {
            let mut m: HashMap<BindRow, usize> = HashMap::new();
            for r in rows {
                *m.entry(r.clone()).or_insert(0) += 1;
            }
            m
        }

        // Replay every clause leg by leg (all bodies are base/builtin-only by
        // construction), comparing the two paths' output row MULTISETS at each leg.
        let mut legs_compared = 0usize;
        for plan in &plans {
            let mut rows: Vec<BindRow> = vec![BindRow::new()];
            for leg in &plan.legs {
                match &leg.source {
                    LegSource::Base { .. } | LegSource::Builtin(_) => {}
                    other => panic!("test program must be base/builtin-only, got {other:?}"),
                }
                let out_fast = fast.join_extensional(leg, rows.clone());
                let out_slow = slow.join_extensional(leg, rows.clone());
                assert_eq!(
                    multiset(&out_fast),
                    multiset(&out_slow),
                    "build-once vs per-row diverge at leg {:?} of rule {} (rows in: {})",
                    leg.literal,
                    plan.head,
                    rows.len()
                );
                legs_compared += 1;
                rows = out_slow;
            }
        }
        assert!(
            legs_compared >= 20,
            "the fixture program must exercise a broad leg set, compared only {legs_compared}"
        );

        // End-to-end: both executors commit identical fact sets per predicate.
        let e_fast = fast.evaluate(&plans, &rules, &strat).expect("fast eval");
        let e_slow = slow.evaluate(&plans, &rules, &strat).expect("slow eval");
        assert_eq!(
            e_fast.relations.keys().collect::<Vec<_>>(),
            e_slow.relations.keys().collect::<Vec<_>>()
        );
        for (pred, facts_slow) in &e_slow.relations {
            let f: HashSet<&[Value]> =
                e_fast.relations[pred].iter().map(|b| b.as_ref()).collect();
            let s: HashSet<&[Value]> = facts_slow.iter().map(|b| b.as_ref()).collect();
            assert_eq!(f, s, "fact sets diverge for {pred}");
        }
        // Sanity: the shapes actually derived something (no vacuous pass).
        assert!(!e_slow.relations["e_far"].is_empty());
        assert!(!e_slow.relations["e_both"].is_empty());
        assert!(!e_slow.relations["a_shared"].is_empty());
        assert!(e_slow.relations["a_meta"].is_empty(), "non-first-class key derives nothing");
    }

    /// `strip_prefix/3` through the full pipeline (parse → stratify → plan → execute): the
    /// builtin places as a function leg AFTER its inputs are bound, EXTRACTS the rest for a
    /// matching name, and FILTERS OUT (no row — match-and-extract, never an identity
    /// fallback) a non-matching one. The "*:./foo" star re-export source shape.
    #[test]
    fn strip_prefix_rule_extracts_star_reexport_source_and_filters() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "*:./foo", "IMPORT");
        node(&mut v, "./bar", "IMPORT");
        let src = r#"star_source(X, R) :-
                         node(X, "IMPORT"), attr(X, "name", N), strip_prefix(N, "*:", R)."#;
        let eval = run(src, &v, Stats::default());
        let facts = eval.facts("star_source");
        assert_eq!(facts.len(), 1, "only the star re-export matches; ./bar derives no row");
        assert_eq!(facts[0][0].as_id(), Some(id_of("*:./foo")));
        assert_eq!(facts[0][1], Value::Str("./foo".to_string()));
    }

    // ── W9 fix #2: edge_attr build-once index ─────────────────────────

    /// The `edge_attr` fixture: CALLS edges covering every metadata shape the per-row
    /// eval distinguishes — present string key, a different value, NO metadata,
    /// unparseable JSON, a null (non-scalar) value, plus number and bool surfaces.
    fn edge_attr_fixture() -> FixtureStorageView {
        let mut v = FixtureStorageView::new(1);
        for sid in ["a", "b", "c", "d", "e"] {
            node(&mut v, sid, "CALL");
        }
        for (s, d) in [("a", "b"), ("a", "c"), ("b", "c"), ("c", "a"), ("d", "e")] {
            edge(&mut v, s, d, "CALLS");
        }
        v.put_edge_metadata(
            id_of("a"),
            id_of("b"),
            "CALLS",
            r#"{"via":"import","weight":3,"flag":true}"#,
        );
        v.put_edge_metadata(id_of("a"), id_of("c"), "CALLS", r#"{"via":"direct"}"#);
        // ("b","c"): no metadata at all.
        v.put_edge_metadata(id_of("c"), id_of("a"), "CALLS", "{not json");
        v.put_edge_metadata(id_of("d"), id_of("e"), "CALLS", r#"{"via":null}"#);
        v
    }

    /// Differential anchor for the build-once `edge_attr` path: forcing the fast path
    /// (`min_rows = 0`) and forcing the per-row reference path (`min_rows = MAX`) must
    /// commit identical fact sets across BIND, CHECK, number- and bool-surface modes —
    /// including the non-match shapes (missing blob / unparseable / null / absent key).
    #[test]
    fn edge_attr_built_once_matches_per_row_all_modes() {
        let v = edge_attr_fixture();
        let src = r#"
            via(C, T, V) :- edge(C, T, "CALLS"), edge_attr(C, T, "CALLS", "via", V).
            imp(C, T) :- edge(C, T, "CALLS"), edge_attr(C, T, "CALLS", "via", "import").
            w(C, T, V) :- edge(C, T, "CALLS"), edge_attr(C, T, "CALLS", "weight", V).
            b(C, T, V) :- edge(C, T, "CALLS"), edge_attr(C, T, "CALLS", "flag", V).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats::default()).expect("plan");
        let fast = Executor::<BoolTag>::new(&v).with_build_once_min_rows(0);
        let slow = Executor::<BoolTag>::new(&v).with_build_once_min_rows(usize::MAX);
        let e_fast = fast.evaluate(&plans, &rules, &strat).expect("fast");
        let e_slow = slow.evaluate(&plans, &rules, &strat).expect("slow");
        for pred in ["via", "imp", "w", "b"] {
            let f: HashSet<&[Value]> =
                e_fast.relations[pred].iter().map(|x| x.as_ref()).collect();
            let s: HashSet<&[Value]> =
                e_slow.relations[pred].iter().map(|x| x.as_ref()).collect();
            assert_eq!(f, s, "fact sets diverge for {pred}");
        }
        // Ground truth (not just fast≡slow): exactly the two parseable string values…
        assert_eq!(e_fast.relations["via"].len(), 2, "import + direct only");
        // …the equality check keeps only the import edge…
        assert_eq!(e_fast.relations["imp"].len(), 1);
        assert_eq!(e_fast.relations["imp"][0][0].as_id(), Some(id_of("a")));
        // …and number/bool surfaces match the per-row JSON-text rendering.
        assert_eq!(e_fast.relations["w"][0][2], Value::Str("3".to_string()));
        assert_eq!(e_fast.relations["b"][0][2], Value::Str("true".to_string()));
        // The fast executor actually built the (type, key)-keyed indexes (one per
        // distinct key: via, weight, flag — plus the edge generator's pair list).
        let (builds, _hits) = fast.index_cache_counts();
        assert!(builds >= 3, "expected ≥3 edge_attr index builds, got {builds}");
    }

    // ── W9 fix #1: cross-evaluation shared index caches ───────────────

    /// A program touching every shared index family: a typed node generator
    /// (`node_ids`), two typed edge generators (`edge_pairs`), and a negated base leg
    /// (`anti_join`).
    const SHARED_CACHE_PROG: &str = r#"
        f(X) :- node(X, "FUNCTION").
        c(X, Y) :- edge(X, Y, "CONTAINS").
        k(X, Y) :- edge(X, Y, "CALLS").
        orphan(X) :- node(X, "FUNCTION"), \+ incoming(X, _, "CALLS").
    "#;

    fn shared_cache_fixture(generation: u64) -> FixtureStorageView {
        let mut v = FixtureStorageView::new(generation);
        for i in 0..5 {
            node(&mut v, &format!("fn{i}"), "FUNCTION");
        }
        edge(&mut v, "fn0", "fn1", "CALLS");
        edge(&mut v, "fn1", "fn2", "CALLS");
        edge(&mut v, "fn0", "fn3", "CONTAINS");
        v
    }

    /// Evaluate `src` on `v` with `shared` installed; return (committed evaluation,
    /// builds, hits).
    fn run_shared(
        src: &str,
        v: &FixtureStorageView,
        shared: &SharedIndexCaches,
    ) -> (Evaluation, u64, u64) {
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &Stats::default()).expect("plan");
        let exec = Executor::<BoolTag>::with_limits(v, EvalLimits::none(), DEFAULT_ITERATION_CAP)
            .with_shared_caches(shared);
        let eval = exec.evaluate(&plans, &rules, &strat).expect("evaluate");
        let (b, h) = exec.index_cache_counts();
        (eval, b, h)
    }

    /// The reuse proof: a SECOND executor over the same generation builds ZERO indexes
    /// (everything served from the shared home) and commits the identical result — and
    /// the result equals an unshared run (index reuse is observationally invisible).
    #[test]
    fn shared_caches_reuse_across_executors_at_same_generation() {
        let v = shared_cache_fixture(1);
        let shared = SharedIndexCaches::new();

        let baseline = run(SHARED_CACHE_PROG, &v, Stats::default());
        let (e1, b1, _) = run_shared(SHARED_CACHE_PROG, &v, &shared);
        assert!(b1 >= 4, "first run builds node_ids + 2×edge_pairs + anti_join (got {b1})");
        assert_eq!(e1.relations, baseline.relations, "sharing must not change the result");

        let (e2, b2, h2) = run_shared(SHARED_CACHE_PROG, &v, &shared);
        assert_eq!(b2, 0, "second run at the same generation must build NOTHING");
        assert!(h2 > 0, "…and must actually be served from the shared cache");
        assert_eq!(e2.relations, baseline.relations);
    }

    /// The version guard: a view at a DIFFERENT generation seeds nothing (a stale index
    /// is never handed out), and the absorb re-keys the store to the new generation.
    #[test]
    fn shared_caches_seed_nothing_on_generation_mismatch() {
        let shared = SharedIndexCaches::new();
        let v1 = shared_cache_fixture(1);
        let (_, b1, _) = run_shared(SHARED_CACHE_PROG, &v1, &shared);
        assert!(b1 > 0);
        assert_eq!(shared.snapshot_counts().0, Some(1));

        let v2 = shared_cache_fixture(2);
        let (_, b2, _) = run_shared(SHARED_CACHE_PROG, &v2, &shared);
        assert_eq!(b2, b1, "generation mismatch ⇒ cold caches ⇒ same builds as run 1");
        assert_eq!(shared.snapshot_counts().0, Some(2), "absorb re-keys to the new generation");
    }

    /// The carry-forward matrix (`retain_for_commit`): after a commit that touched ONLY
    /// the CALLS edge type, the CALLS indexes are evicted while the CONTAINS and node
    /// indexes carry to the new version; a node-touching commit drops the node side; a
    /// node-REMOVING commit (`edges_unbounded`) drops every edge index; a commit whose
    /// `prev_version` does not match the stored entries drops everything.
    #[test]
    fn shared_caches_retain_for_commit_evicts_exactly_the_touched_axes() {
        let calls_only = r#"k(X, Y) :- edge(X, Y, "CALLS")."#;
        let contains_only = r#"c(X, Y) :- edge(X, Y, "CONTAINS")."#;
        let fns_only = r#"f(X) :- node(X, "FUNCTION")."#;
        let touch = |tys: &[&str], nodes: bool, unbounded: bool| CommitTouch {
            edge_types: tys.iter().map(|s| s.to_string()).collect(),
            nodes,
            edges_unbounded: unbounded,
        };

        // CALLS-only commit: CALLS evicted, CONTAINS + node carried.
        let shared = SharedIndexCaches::new();
        run_shared(SHARED_CACHE_PROG, &shared_cache_fixture(1), &shared);
        shared.retain_for_commit(1, 2, &touch(&["CALLS"], false, false));
        let v2 = shared_cache_fixture(2);
        let (_, b, _) = run_shared(contains_only, &v2, &shared);
        assert_eq!(b, 0, "CONTAINS edge_pairs must carry across the CALLS-only commit");
        let (_, b, _) = run_shared(fns_only, &v2, &shared);
        assert_eq!(b, 0, "node_ids must carry across an edges-only commit");
        let (_, b, _) = run_shared(calls_only, &v2, &shared);
        assert_eq!(b, 1, "the touched CALLS index must be rebuilt");

        // Node-adding commit: node side dropped, untouched edge side carried.
        let shared = SharedIndexCaches::new();
        run_shared(SHARED_CACHE_PROG, &shared_cache_fixture(1), &shared);
        shared.retain_for_commit(1, 2, &touch(&[], true, false));
        let (_, b, _) = run_shared(fns_only, &v2, &shared);
        assert_eq!(b, 1, "node_ids must be dropped by a node-touching commit");
        let (_, b, _) = run_shared(contains_only, &v2, &shared);
        assert_eq!(b, 0, "edge indexes survive a node-ADD commit");

        // Node-removing commit (tombstones cascade to edges of every type).
        let shared = SharedIndexCaches::new();
        run_shared(SHARED_CACHE_PROG, &shared_cache_fixture(1), &shared);
        shared.retain_for_commit(1, 2, &touch(&[], true, true));
        let (_, b, _) = run_shared(contains_only, &v2, &shared);
        assert_eq!(b, 1, "edges_unbounded must drop EVERY edge index");

        // prev_version mismatch: a foreign commit landed since the absorb — drop all.
        let shared = SharedIndexCaches::new();
        run_shared(SHARED_CACHE_PROG, &shared_cache_fixture(1), &shared);
        shared.retain_for_commit(7, 8, &touch(&[], false, false));
        assert_eq!(shared.snapshot_counts(), (None, 0), "stale entries must not be laundered");
    }

    // ── W9-iter2: wildcard join-key exclusion + empty-derived-leg short-circuit ──

    /// A derived leg carrying a WILDCARD argument must still join through the build-once
    /// hash index on its non-wildcard bound positions and produce the exact result set.
    /// (The planner marks a wildcard `Bound`; before the W9-iter2 fix `derived_probe_key`
    /// returned `None` on it and every row took the defensive full-relation scan — same
    /// answers, O(rows × facts) cost: js_builtins' `bi_binding(F, LN, M, _)` leg burned
    /// ~10.8 s/pack on the dogfood graph. The key fix must not change the answers.)
    #[test]
    fn derived_leg_with_wildcard_joins_on_remaining_key() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "a", "CALL");
        node(&mut v, "b", "CALL");
        node(&mut v, "c", "OTHER");

        // helper(File, Tag, Extra): two facts share file "f.js" (every fixture node's
        // file), with distinct extras the wildcard must NOT key or filter on.
        let src = r#"
            helper(F, "t1", "x1") :- node(N, "CALL"), attr(N, "file", F), attr(N, "name", "a").
            helper(F, "t2", "x2") :- node(N, "CALL"), attr(N, "file", F), attr(N, "name", "b").
            out(N, T) :- node(N, "CALL"), attr(N, "file", F), helper(F, T, _).
        "#;
        let eval = run(src, &v, Stats::default());
        // Both CALL nodes join both helper facts through the (F)-keyed index: 2×2 rows.
        let mut got: Vec<(u128, String)> = eval
            .facts("out")
            .iter()
            .map(|r| (r[0].as_id().unwrap(), r[1].as_str()))
            .collect();
        got.sort();
        let mut want = vec![
            (id_of("a"), "t1".to_string()),
            (id_of("a"), "t2".to_string()),
            (id_of("b"), "t1".to_string()),
            (id_of("b"), "t2".to_string()),
        ];
        want.sort();
        assert_eq!(got, want, "wildcard leg must neither over- nor under-join");
    }

    /// A clause with an EMPTY positive derived leg derives nothing — and must do so
    /// without evaluating its other legs (the short-circuit). The observable contract:
    /// (a) the clause's head set is empty exactly as before;
    /// (b) a clause whose empty derived relation appears only under NEGATION still
    ///     derives (an empty negated relation passes every row — the short-circuit must
    ///     skip negative legs or it would wrongly null whole packs: rust_calls'
    ///     `\+ rs_macro(C)` with zero macro calls).
    #[test]
    fn empty_positive_derived_leg_short_circuits_but_negation_still_passes() {
        let mut v = FixtureStorageView::new(1);
        node(&mut v, "a", "CALL");
        node(&mut v, "b", "CALL");

        let src = r#"
            never(N) :- node(N, "NO_SUCH_TYPE").
            pos(N) :- node(N, "CALL"), never(N).
            neg(N) :- node(N, "CALL"), \+ never(N).
        "#;
        let eval = run(src, &v, Stats::default());
        assert!(
            eval.facts("pos").is_empty(),
            "a positive leg over an empty derived relation derives nothing"
        );
        assert_eq!(
            ids(&eval, "neg"),
            {
                let mut e = vec![id_of("a"), id_of("b")];
                e.sort_unstable();
                e
            },
            "an empty relation under negation must still PASS rows (short-circuit must \
             not fire on negative legs)"
        );
    }
    // ── P3: incoming ≡ edge-Reverse dispatch equivalence (round-009 H4) ──

    /// The §6.3 fold under pin: an `incoming(D, S, T)` leg and the endpoint-swapped
    /// `edge(S, D, T)` leg are the SAME relation read through the two declared runs.
    /// Plan level: the `incoming` leg's plan-resolved dispatch is EDGE's PredicateId
    /// with `SortOrder::Reverse`. Output level: the two programs derive identical
    /// fact sets on the fixture — under both the build-once and the per-row paths
    /// (min_rows 0 vs the usize::MAX force-per-row sentinel).
    #[test]
    fn incoming_leg_is_edge_reverse_run() {
        use crate::facts::SortOrder;

        let mut v = FixtureStorageView::new(1);
        node(&mut v, "f1", "FUNCTION");
        node(&mut v, "f2", "FUNCTION");
        node(&mut v, "f3", "FUNCTION");
        edge(&mut v, "f1", "f2", "CALLS");
        edge(&mut v, "f3", "f2", "CALLS");
        edge(&mut v, "f2", "f1", "CALLS");

        let src_incoming = r#"r(X, Y) :- node(X, "FUNCTION"), incoming(X, Y, "CALLS")."#;
        let src_edge_rev = r#"r(X, Y) :- node(X, "FUNCTION"), edge(Y, X, "CALLS")."#;

        // Plan level: the incoming leg resolves to edge's id + Reverse.
        let prog = parse_ext_program(src_incoming).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let mut catalog = crate::derive::catalog::PredicateCatalog::with_base_relations();
        let plans = crate::derive::plan::plan_program_with_catalog(
            &rules,
            &strat,
            &Stats::default(),
            &mut catalog,
        )
        .expect("plan");
        let edge_id = catalog.get("edge").unwrap().id;
        let leg = plans[0]
            .legs
            .iter()
            .find(|l| l.literal.atom().predicate() == "incoming")
            .expect("incoming leg planned");
        match &leg.source {
            LegSource::Base { name, dispatch } => {
                assert_eq!(name, "incoming", "surface name preserved");
                assert_eq!(dispatch.id, edge_id, "incoming IS edge's relation");
                assert_eq!(dispatch.order, SortOrder::Reverse, "…read through the Reverse run");
            }
            other => panic!("incoming must be a base leg, got {other:?}"),
        }

        // Output level, both dispatch modes.
        for min_rows in [0usize, usize::MAX] {
            let facts_of = |src: &str| -> std::collections::BTreeSet<Vec<Value>> {
                let prog = parse_ext_program(src).expect("parse");
                let strat = stratify(&prog).expect("stratify");
                let rules = prog.rules();
                let plans =
                    plan_program(&rules, &strat, &Stats::default()).expect("plan");
                let exec = Executor::<BoolTag>::new(&v).with_build_once_min_rows(min_rows);
                let eval = exec.evaluate(&plans, &rules, &strat).expect("eval");
                eval.facts("r").iter().map(|f| f.to_vec()).collect()
            };
            let via_incoming = facts_of(src_incoming);
            let via_edge_rev = facts_of(src_edge_rev);
            assert_eq!(
                via_incoming, via_edge_rev,
                "incoming and endpoint-swapped edge must derive identical facts (min_rows {min_rows})"
            );
            assert_eq!(via_incoming.len(), 3, "fixture has 3 incoming pairs");
        }
    }
}
