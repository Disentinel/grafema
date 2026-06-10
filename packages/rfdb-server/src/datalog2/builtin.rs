//! Layer 5 — builtin predicate registry.
//!
//! Holds the `BuiltinDef` registry and ports the v1 eval bodies (`node`/`type`,
//! `edge`, `incoming`, `attr`, `neq`, `gt`/`lt`/`gte`/`lte`, `starts_with`,
//! `not_starts_with`, `string_contains`), each annotated with its supported binding
//! modes and a cost estimate, served through [`StorageView`]. Invariant I5: an
//! unsupported binding mode for a builtin is rejected with `E-PLAN-001`.
//!
//! # One registration point
//!
//! [`registry`] is the single place every builtin is declared. The planner consults a
//! [`BuiltinDef`] for its arity, kind, supported [`Mode`]s, and cost; the executor calls
//! its [`BuiltinDef::eval`] with the storage view, an output [`Batch`], and the resolved
//! [`ArgSpec`] for the literal. No builtin reads storage directly — every access goes
//! through the locked `StorageView` surface (I10).
//!
//! # Modes and `E-PLAN-001`
//!
//! Each argument of a literal is, at plan time, either already *bound* (a constant or a
//! variable bound by an earlier literal) or *free* (an as-yet-unbound variable / wildcard
//! to be produced). A [`Mode`] is the per-position bind pattern a builtin supports. The
//! planner calls [`BuiltinDef::check_mode`]; if the literal's actual pattern matches no
//! supported mode the call is rejected with [`BuiltinError`] carrying `E-PLAN-001` and the
//! list of argument positions that would need to be bound first (spec §7).
//!
//! # `attr` coercion (spec §5)
//!
//! `attr(Id, Key, Value)` reads a node's first-class column (`name`/`file`/`type`/`id`)
//! through the single permitted bound-id point lookup ([`StorageView::get_node`]). The
//! comparison against a literal `Value` is performed at the value level; a comparison that
//! cannot be satisfied because the literal cannot be coerced to the column's surface
//! (e.g. a numeric literal against a string column with no numeric reading) is a **tuple
//! non-match** that increments [`Batch::coercion_misses`] — never a crash and never a
//! silently-empty query masquerading as "no such node". Metadata-key attrs are not part of
//! the Gate A `StorageView` row surface (`NodeRow` carries only id/type/name/file); an
//! attr key outside the first-class set is reported as a coercion miss for the same reason
//! and resolved when the row surface gains metadata in a later gate.

use std::fmt;

use crate::datalog::Value;

use super::storage_glue::{EdgeOrder, EdgeRow, NodeRow, StorageView};

// ── Errors (invariant I5) ──────────────────────────────────────────

/// Stable, machine-readable builtin error codes (invariant I5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinCode {
    /// A literal's actual binding pattern is supported by no registered [`Mode`] of the
    /// builtin: the planner must bind the named positions first. Spec §7.
    UnsupportedMode,
}

impl BuiltinCode {
    /// The stable string form emitted in diagnostics and conformance manifests.
    pub fn as_str(self) -> &'static str {
        match self {
            BuiltinCode::UnsupportedMode => "E-PLAN-001",
        }
    }
}

impl fmt::Display for BuiltinCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A builtin planning/evaluation rejection (invariant I5): a stable [`BuiltinCode`] plus a
/// human detail and the argument positions whose binding the rejection requires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinError {
    /// Stable taxonomy code — the load-bearing, machine-checkable field.
    pub code: BuiltinCode,
    /// The builtin that rejected the call.
    pub builtin: &'static str,
    /// One-line human detail (never the sole signal; the code is authoritative).
    pub detail: String,
    /// Argument positions (0-based) that must be bound before the call is feasible. For
    /// `E-PLAN-001` this names the required bindings (spec §7).
    pub required_bindings: Vec<usize>,
}

impl fmt::Display for BuiltinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} [{}] (bind positions {:?}): {}",
            self.code, self.builtin, self.required_bindings, self.detail
        )
    }
}

impl std::error::Error for BuiltinError {}

/// Result of a builtin operation (plan-time mode check or eval).
pub type BuiltinResult<T> = Result<T, BuiltinError>;

// ── Binding modes ──────────────────────────────────────────────────

/// The bind-state of a single literal argument at plan time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgMode {
    /// Already bound: a constant, or a variable bound by an earlier literal.
    Bound,
    /// Free: an unbound variable or wildcard, to be produced by this literal.
    Free,
}

/// A supported binding pattern for a builtin: one [`ArgMode`] per argument position.
///
/// The planner matches a literal's actual pattern against each registered `Mode`; the
/// match is exact per position (`Bound` requires the actual arg be bound, `Free` requires
/// it be free). A builtin with no matching mode is rejected with `E-PLAN-001`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mode {
    /// Per-position bind pattern. `len()` equals the builtin's arity.
    pub args: &'static [ArgMode],
}

impl Mode {
    /// Whether `actual` (the literal's per-position bind state) satisfies this mode.
    fn matches(&self, actual: &[ArgMode]) -> bool {
        self.args.len() == actual.len()
            && self
                .args
                .iter()
                .zip(actual.iter())
                .all(|(want, have)| want == have)
    }
}

// ── Argument specification ─────────────────────────────────────────

/// One resolved argument of a builtin literal, as the executor presents it.
///
/// At eval time every argument is one of: a literal constant, a variable already bound to
/// a value by the surrounding row, or a free output variable to be produced. The slot
/// index identifies which output column a [`Free`](ArgValue::Free) variable fills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgValue {
    /// A bound value: a constant literal or a variable bound by an earlier literal.
    Bound(Value),
    /// A free output variable; `slot` is its position in the produced [`Row`]'s output
    /// column order (the order the registry documents for the builtin).
    Free { slot: usize },
    /// A wildcard `_`: free but never captured (no output column).
    Wildcard,
}

impl ArgValue {
    /// The plan-time [`ArgMode`] this argument presents.
    pub fn mode(&self) -> ArgMode {
        match self {
            ArgValue::Bound(_) => ArgMode::Bound,
            ArgValue::Free { .. } | ArgValue::Wildcard => ArgMode::Free,
        }
    }

    /// The bound value, if this argument is bound.
    pub fn as_bound(&self) -> Option<&Value> {
        match self {
            ArgValue::Bound(v) => Some(v),
            _ => None,
        }
    }
}

/// The resolved arguments of one builtin literal, in source position order.
///
/// Built once per literal occurrence per row by the executor; the builtin's `eval` reads
/// it positionally. Output bindings are written to a [`Batch`] keyed by the [`ArgValue::Free`]
/// slots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgSpec {
    /// One entry per builtin argument, in declared order.
    pub args: Vec<ArgValue>,
}

impl ArgSpec {
    /// Build an arg spec from resolved arguments.
    pub fn new(args: Vec<ArgValue>) -> Self {
        Self { args }
    }

    /// The per-position bind pattern, for mode checking.
    pub fn pattern(&self) -> Vec<ArgMode> {
        self.args.iter().map(ArgValue::mode).collect()
    }

    /// The number of output columns (distinct free, captured slots).
    fn output_arity(&self) -> usize {
        self.args
            .iter()
            .filter_map(|a| match a {
                ArgValue::Free { slot } => Some(*slot + 1),
                _ => None,
            })
            .max()
            .unwrap_or(0)
    }
}

// ── Output batch ───────────────────────────────────────────────────

/// An output row: one [`Value`] per captured free slot of the builtin literal, in slot
/// order. A filter/function builtin that captures nothing produces the empty row `[]`
/// (one such row = "the filter passed").
pub type Row = Box<[Value]>;

/// The accumulator a builtin writes produced rows into, plus the `coercion_miss` counter
/// (spec §5 / §11 events). The executor drains `rows` to feed the next join leg and folds
/// `coercion_misses` into the run's event counters.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Batch {
    /// Produced output rows (slot-ordered values). For filters/functions that capture no
    /// variable a single empty row signals a pass; an empty `rows` signals no match.
    pub rows: Vec<Row>,
    /// Count of literal-level coercion failures (spec §5): a comparison that could not be
    /// satisfied because a literal could not be coerced to the column surface. A miss is a
    /// tuple non-match, never an error and never a silently-empty query.
    pub coercion_misses: u64,
}

impl Batch {
    /// A fresh, empty batch.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one produced output row.
    fn push(&mut self, row: Row) {
        self.rows.push(row);
    }

    /// Record a filter/function pass that captures no variables (the empty row).
    fn push_pass(&mut self) {
        self.rows.push(Vec::new().into_boxed_slice());
    }

    /// Record one literal-level coercion miss (a tuple non-match, spec §5).
    fn coercion_miss(&mut self) {
        self.coercion_misses += 1;
    }
}

// ── Builtin kind, cost, def ────────────────────────────────────────

/// Whether a builtin produces tuples, prunes them, or computes a derived column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinKind {
    /// Produces tuples from storage (e.g. `node`, `edge`, `incoming`).
    Generator,
    /// Prunes the current row, capturing no new variable (e.g. `neq`, `gt`, `starts_with`).
    Filter,
    /// Binds a derived value from already-bound inputs (e.g. forward `attr` reading a column).
    Function,
}

/// Minimal storage statistics the cost functions consult. A trimmed surface (the full
/// `Stats` lives with the planner in a later layer); cost only needs relation magnitudes.
#[derive(Debug, Clone, Default)]
pub struct Stats {
    /// Total live nodes at the run's snapshot.
    pub total_nodes: u64,
    /// Total live edges at the run's snapshot.
    pub total_edges: u64,
    /// Per-node-type live counts — the §7 cardinality oracle. A bound type literal in a
    /// `node(X, "TYPE")` generator narrows the estimate to that type's count; an empty map (or
    /// an absent type) falls back to `total_nodes`. Lets the planner place an empty-type leg
    /// first instead of over-estimating it at the whole relation (which spuriously trips
    /// E-PLAN-003 — e.g. node(M, "MESSAGE_TYPE") in a graph with zero MESSAGE_TYPE nodes).
    pub nodes_by_type: std::collections::HashMap<String, u64>,
}

/// A registered builtin (spec §7): name, arity, supported modes, cost, kind, and eval body.
///
/// `eval` reads only through [`StorageView`], writes produced rows / coercion misses into
/// the [`Batch`], and consumes the resolved [`ArgSpec`]. It returns `Err` only for a
/// genuine planning fault (`E-PLAN-001`); ordinary non-matches are an empty `Batch`, and
/// coercion failures are counted, never errors.
pub struct BuiltinDef {
    /// Predicate name as written in rules.
    pub name: &'static str,
    /// Argument count.
    pub arity: usize,
    /// Supported binding modes; a literal matching none is rejected `E-PLAN-001`.
    pub modes: &'static [Mode],
    /// Generator / Filter / Function classification.
    pub kind: BuiltinKind,
    /// Evaluation body. Reads via `StorageView`, writes into `Batch`, consumes `ArgSpec`.
    pub eval: fn(&dyn StorageView, &mut Batch, &ArgSpec) -> BuiltinResult<()>,
}

impl BuiltinDef {
    /// Check that `spec` matches one of this builtin's modes (invariant I5).
    ///
    /// On success returns the matched [`Mode`] (for cost). On failure returns
    /// `E-PLAN-001` naming the argument positions a feasible mode would require bound.
    pub fn check_mode(&self, spec: &ArgSpec) -> BuiltinResult<Mode> {
        let actual = spec.pattern();
        if let Some(m) = self.modes.iter().find(|m| m.matches(&actual)) {
            return Ok(*m);
        }
        // Build the required-binding hint: positions where every supported mode of the
        // matching arity wants `Bound` but the actual arg is `Free`.
        let mut required = Vec::new();
        for (pos, have) in actual.iter().enumerate() {
            if *have == ArgMode::Free
                && self
                    .modes
                    .iter()
                    .filter(|m| m.args.len() == actual.len())
                    .all(|m| m.args.get(pos) == Some(&ArgMode::Bound))
            {
                required.push(pos);
            }
        }
        Err(BuiltinError {
            code: BuiltinCode::UnsupportedMode,
            builtin: self.name,
            detail: format!(
                "no supported binding mode for `{}` with pattern {:?}",
                self.name, actual
            ),
            required_bindings: required,
        })
    }
}

// ── Shared value-extraction helpers ────────────────────────────────

/// Pull the bound id from a [`ArgValue::Bound`] (string forms are parsed once). Returns
/// `None` for a free/wildcard arg or a non-id string.
fn bound_id(arg: &ArgValue) -> Option<u128> {
    arg.as_bound().and_then(Value::as_id)
}

/// Pull the bound string surface from a [`ArgValue::Bound`].
fn bound_str(arg: &ArgValue) -> Option<String> {
    arg.as_bound().map(Value::as_str)
}

/// The string surface of a bound literal used as an attr equality target (spec §5): a
/// `Value::Str` is its own string, a `Value::Id` is its decimal surface — exactly the
/// surface v1's `attr_to_query` writes into the `AttrQuery`. The index reverse-lookup then
/// matches against the column's stored string, so this is the same coercion the bound-id
/// filter path applies through [`coerce_eq`], just driven through the index instead of a
/// per-node read.
fn bound_value_surface(arg: &ArgValue) -> Option<String> {
    arg.as_bound().map(Value::as_str)
}

/// The captured output slot of an argument, if it is a free, captured variable.
fn free_slot(arg: &ArgValue) -> Option<usize> {
    match arg {
        ArgValue::Free { slot } => Some(*slot),
        _ => None,
    }
}

/// Build a slot-ordered output row binding the given `(slot, value)` pairs. `width` is the
/// row's column count (the spec's output arity); unspecified slots are unreachable because
/// every captured slot is supplied by construction.
fn emit_row(width: usize, bindings: &[(usize, Value)]) -> Row {
    // Placeholder unit strings are never observed: each captured slot is written below.
    let mut cols: Vec<Value> = vec![Value::Str(String::new()); width];
    for (slot, value) in bindings {
        cols[*slot] = value.clone();
    }
    cols.into_boxed_slice()
}

// ── Generators: node / type, edge, incoming ────────────────────────

/// `node(X, T)` / `type(X, T)` — nodes by type.
///
/// Modes: `node(Free, Bound)` generates all nodes of the bound type; `node(Bound, Bound)`
/// checks the bound id has the bound type (point lookup, the id is already bound);
/// `node(Bound, Free)` binds the type of the bound id. Reads via `scan_nodes_by_type`
/// (generator) or `get_node` (bound id).
fn eval_node(view: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let id_arg = &spec.args[0];
    let ty_arg = &spec.args[1];
    let width = spec.output_arity();

    match (id_arg, ty_arg) {
        // node(Free X, "TYPE") — generate ids of that type.
        (ArgValue::Free { slot }, ArgValue::Bound(ty)) => {
            let ty = ty.as_str();
            for n in view.scan_nodes_by_type(&ty) {
                out.push(emit_row(width, &[(*slot, Value::Id(n.id))]));
            }
        }
        // node(_, "TYPE") — existence/pass over that type (no capture).
        (ArgValue::Wildcard, ArgValue::Bound(ty)) => {
            let ty = ty.as_str();
            for _ in view.scan_nodes_by_type(&ty) {
                out.push_pass();
            }
        }
        // node(BoundId, "TYPE") — check the bound id has that type.
        (ArgValue::Bound(_), ArgValue::Bound(ty)) => {
            if let Some(id) = bound_id(id_arg) {
                if let Some(n) = view.get_node(id) {
                    if n.node_type == ty.as_str() {
                        out.push_pass();
                    }
                }
            }
        }
        // node(BoundId, Free T) — bind the type of the bound id.
        (ArgValue::Bound(_), ArgValue::Free { slot }) => {
            if let Some(id) = bound_id(id_arg) {
                if let Some(n) = view.get_node(id) {
                    out.push(emit_row(width, &[(*slot, Value::Str(n.node_type))]));
                }
            }
        }
        // node(BoundId, _) — existence of the bound id.
        (ArgValue::Bound(_), ArgValue::Wildcard) => {
            if let Some(id) = bound_id(id_arg) {
                if view.get_node(id).is_some() {
                    out.push_pass();
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// `edge(Src, Dst, T)` — forward edges of a bound type.
///
/// Modes: `edge(Free, Free, Bound)` generates all `(src,dst)` of the type;
/// `edge(Bound, Free, Bound)` generates the bound source's outgoing of the type;
/// `edge(Bound, Bound, Bound)` checks the triple exists. Reads `scan_edges_by_type`
/// forward.
fn eval_edge(view: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    eval_edge_dir(view, out, spec, EdgeOrder::Forward)
}

/// `incoming(Dst, Src, T)` — reverse edges of a bound type (the `incoming` view).
///
/// Argument order is `(dst, src, type)`. Modes mirror `edge` over the reverse key. Reads
/// `scan_edges_by_type` reverse.
fn eval_incoming(view: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    eval_edge_dir(view, out, spec, EdgeOrder::Reverse)
}

/// Shared body for `edge`/`incoming`. For `Forward` the args are `(src, dst, type)`; for
/// `Reverse` they are `(dst, src, type)`. We resolve the type, then read the smallest
/// possible edge set for the bound endpoints (§8.3): a bound endpoint is served through a
/// snapshot-pinned *keyed* probe (`edges_from`/`edges_to`), proportional to that endpoint's
/// fan-out — never a full relation scan. Only when BOTH endpoints are free do we fall back
/// to the full typed scan (`scan_edges_by_type`), which the planner already costs as the
/// fully-free generator.
fn eval_edge_dir(
    view: &dyn StorageView,
    out: &mut Batch,
    spec: &ArgSpec,
    order: EdgeOrder,
) -> BuiltinResult<()> {
    // arg[0] is the "near" endpoint in the directional view; arg[1] the "far"; arg[2] type.
    let near_arg = &spec.args[0];
    let far_arg = &spec.args[1];
    let ty_arg = &spec.args[2];
    let width = spec.output_arity();

    let ty = match bound_str(ty_arg) {
        Some(t) => t,
        // Variable edge-type is out of this layer's supported modes (caught by check_mode);
        // defensively yield nothing rather than scanning every type.
        None => return Ok(()),
    };

    // Map a storage EdgeRow's `(src, dst)` to this view's `(near, far)` endpoints.
    let near_far = |src: u128, dst: u128| match order {
        EdgeOrder::Forward => (src, dst),
        EdgeOrder::Reverse => (dst, src),
    };

    let near_bound = bound_id(near_arg);
    let far_bound = bound_id(far_arg);

    // Choose the access path by which endpoints are bound. The keyed probes accept a
    // storage-key id (src for `edges_from`, dst for `edges_to`); translate the view's
    // near/far back into storage src/dst per direction. `EdgeRow` always carries the
    // canonical `(src, dst)`, so the same `near_far` mapping reconstructs the view tuple.
    let edges: Vec<EdgeRow> = match (near_bound, far_bound) {
        // Near endpoint bound — use the index keyed on near. Forward: near == src →
        // `edges_from`; Reverse: near == dst → `edges_to`.
        (Some(near_id), _) => match order {
            EdgeOrder::Forward => view.edges_from(near_id, &ty),
            EdgeOrder::Reverse => view.edges_to(near_id, &ty),
        },
        // Only the far endpoint bound — use the index keyed on far. Forward: far == dst →
        // `edges_to`; Reverse: far == src → `edges_from`.
        (None, Some(far_id)) => match order {
            EdgeOrder::Forward => view.edges_to(far_id, &ty),
            EdgeOrder::Reverse => view.edges_from(far_id, &ty),
        },
        // Both free — the only case that needs the full typed scan (the planner's
        // fully-free generator cost). Collect it through the same code path below.
        (None, None) => view.scan_edges_by_type(&ty, order).collect(),
    };

    for e in edges {
        let (near, far) = near_far(e.src, e.dst);
        // A keyed probe already filtered the bound endpoint; re-check defensively and to
        // apply the OTHER bound endpoint's filter when both are bound (check-triple mode).
        if let Some(nb) = near_bound {
            if nb != near {
                continue;
            }
        }
        if let Some(fb) = far_bound {
            if fb != far {
                continue;
            }
        }
        // Build captured outputs for any free endpoints.
        let mut binds: Vec<(usize, Value)> = Vec::new();
        if let Some(slot) = free_slot(near_arg) {
            binds.push((slot, Value::Id(near)));
        }
        if let Some(slot) = free_slot(far_arg) {
            binds.push((slot, Value::Id(far)));
        }
        if binds.is_empty() {
            out.push_pass();
        } else {
            out.push(emit_row(width, &binds));
        }
    }
    Ok(())
}

// ── Function: attr (first-class columns, with §5 coercion) ─────────

/// First-class node columns `attr` can read at Gate A (the `StorageView` row surface).
/// Metadata-key attrs are not yet on the row surface and resolve to a coercion miss.
/// `pub(crate)`: the executor's build-once `attr` fast path reads the SAME column map so
/// the hash-probed result is byte-identical to this per-row eval.
pub(crate) fn first_class_attr(node: &NodeRow, key: &str) -> Option<String> {
    match key {
        "name" => Some(node.name.clone()),
        "file" => Some(node.file.clone()),
        "type" => Some(node.node_type.clone()),
        "id" => Some(node.id.to_string()),
        _ => None,
    }
}

/// `attr(Id, Key, Value)` — read a first-class column of a bound node (spec §5).
///
/// Modes: `attr(Bound, Bound, Free)` binds the column value; `attr(Bound, Bound, Bound)`
/// checks the column equals the literal. The id is always bound (the only permitted point
/// lookup, §8.3); the key is always a bound literal. A literal `Value` that cannot be
/// coerced to the column's string surface, or a key outside the first-class set, is a
/// coercion miss (tuple non-match, counted — never crash, never silent-empty).
fn eval_attr(view: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let id_arg = &spec.args[0];
    let key_arg = &spec.args[1];
    let val_arg = &spec.args[2];
    let width = spec.output_arity();

    let key = match bound_str(key_arg) {
        Some(k) => k,
        None => return Ok(()),
    };

    // Generator mode `attr(FreeId, "key", "val")` (ATTR_MODES [F, B, B]): the id is a free
    // output and the value is a bound literal — produce every node whose attr key == value
    // via the snapshot-pinned attr index (parity with v1's `find_by_attr`). This is the
    // capability Gate A had scoped out (E-PLAN-001 on an unbound id).
    if id_arg.mode() == ArgMode::Free {
        let Some(slot) = free_slot(id_arg) else {
            // A wildcard id with a value literal: existence over the matching set. Bound by
            // the same index path; no captured id column.
            if let Some(value) = bound_value_surface(val_arg) {
                for _ in view.nodes_by_attr(&key, &value) {
                    out.push_pass();
                }
            }
            return Ok(());
        };
        // The value position must be bound for this mode (the mode check guarantees it);
        // its string surface is the equality target, applying §5 coercion: a literal that
        // has a string surface drives the index reverse-lookup, exactly as the filter path
        // compares against the column's string surface.
        let value = match bound_value_surface(val_arg) {
            Some(v) => v,
            None => return Ok(()),
        };
        for n in view.nodes_by_attr(&key, &value) {
            out.push(emit_row(width, &[(slot, Value::Id(n.id))]));
        }
        return Ok(());
    }

    let id = match bound_id(id_arg) {
        Some(id) => id,
        // No bound id → nothing to read (mode check guarantees boundness; defensive).
        None => return Ok(()),
    };

    let node = match view.get_node(id) {
        Some(n) => n,
        // Bound id not present at this generation → no match (legitimately empty).
        None => return Ok(()),
    };

    let column = match first_class_attr(&node, &key) {
        Some(v) => v,
        // Key outside the first-class row surface (e.g. a metadata key) — coercion miss
        // per §5: the literal-level read cannot be satisfied on the Gate A surface.
        None => {
            out.coercion_miss();
            return Ok(());
        }
    };

    match val_arg {
        // attr(Id, Key, Free V) — bind the column value.
        ArgValue::Free { slot } => {
            out.push(emit_row(width, &[(*slot, Value::Str(column))]));
        }
        ArgValue::Wildcard => {
            // Presence of the column is enough.
            out.push_pass();
        }
        // attr(Id, Key, "literal") — equality check with §5 coercion.
        ArgValue::Bound(expected) => match coerce_eq(&column, expected) {
            CoerceEq::Match => out.push_pass(),
            CoerceEq::NoMatch => {}
            CoerceEq::Miss => out.coercion_miss(),
        },
    }
    Ok(())
}

/// Outcome of comparing a column's string surface against a literal value (spec §5).
/// `pub(crate)`: shared with the executor's build-once `attr` fast path (same coercion).
pub(crate) enum CoerceEq {
    /// The literal coerced and equals the column.
    Match,
    /// The literal coerced but does not equal the column (ordinary tuple non-match).
    NoMatch,
    /// The literal could not be coerced to the column surface (a coercion miss).
    Miss,
}

/// Compare a column's string surface against a literal at the value level (spec §5).
///
/// A [`Value::Str`] literal compares by string surface (always coercible). A
/// [`Value::Id`] literal coerces by its decimal surface; if the column has no such surface
/// the comparison is a coercion miss rather than a silent non-match — the distinction is
/// what `coercion_misses` records.
/// `pub(crate)`: shared with the executor's build-once `attr` fast path (same coercion).
pub(crate) fn coerce_eq(column: &str, expected: &Value) -> CoerceEq {
    match expected {
        Value::Str(s) => {
            if column == s {
                CoerceEq::Match
            } else {
                CoerceEq::NoMatch
            }
        }
        // Typed numeric literals compare by their string surface, like a quoted const.
        Value::Int(_) | Value::Float(_) => {
            if column == expected.as_str() {
                CoerceEq::Match
            } else {
                CoerceEq::NoMatch
            }
        }
        Value::Id(id) => {
            // The literal is an id; coerce by comparing the column's id surface. A column
            // that does not parse as an id cannot be coerced → miss.
            match column.parse::<u128>() {
                Ok(col_id) if col_id == *id => CoerceEq::Match,
                Ok(_) => CoerceEq::NoMatch,
                Err(_) => CoerceEq::Miss,
            }
        }
    }
}

// ── Filters: neq, numeric comparisons, string predicates ───────────

/// `neq(X, Y)` — both args bound; pass iff their string surfaces differ.
fn eval_neq(_view: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    if let (Some(a), Some(b)) = (bound_str(&spec.args[0]), bound_str(&spec.args[1])) {
        if a != b {
            out.push_pass();
        }
    }
    Ok(())
}

/// `method_suffix(FullName, Method)` — the substring after the LAST `.` of a dotted call
/// name (`"kb.queryNodes"` → `"queryNodes"`). NO row when the name has no dot or the
/// suffix is empty: a bare `foo()` is not a method call (mirrors the method-call-resolver
/// plugin's skip). Function kind: a free arg1 binds the suffix; a bound arg1 filters on
/// equality with it.
fn eval_method_suffix(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let Some(full) = bound_str(&spec.args[0]) else {
        return Ok(());
    };
    let Some(dot) = full.rfind('.') else {
        return Ok(());
    };
    let suffix = &full[dot + 1..];
    if suffix.is_empty() {
        return Ok(());
    }
    if spec.args[1].mode() == ArgMode::Free {
        match free_slot(&spec.args[1]) {
            Some(slot) => {
                let width = spec.output_arity();
                out.push(emit_row(width, &[(slot, Value::Str(suffix.to_string()))]));
            }
            // Wildcard method column: pure existence of a dotted suffix.
            None => out.push_pass(),
        }
    } else if bound_str(&spec.args[1]).as_deref() == Some(suffix) {
        out.push_pass();
    }
    Ok(())
}

/// Numeric comparison filter shared by `gt`/`lt`/`gte`/`lte`. Both args parse as `f64`; a
/// non-numeric surface is a coercion miss (tuple non-match, counted — §5), matching v1's
/// graceful failure but surfacing it instead of swallowing it.
fn eval_numeric_cmp(
    out: &mut Batch,
    spec: &ArgSpec,
    pass: fn(f64, f64) -> bool,
) -> BuiltinResult<()> {
    let (ls, rs) = match (bound_str(&spec.args[0]), bound_str(&spec.args[1])) {
        (Some(l), Some(r)) => (l, r),
        _ => return Ok(()),
    };
    let left: f64 = match ls.parse() {
        Ok(v) => v,
        Err(_) => {
            out.coercion_miss();
            return Ok(());
        }
    };
    let right: f64 = match rs.parse() {
        Ok(v) => v,
        Err(_) => {
            out.coercion_miss();
            return Ok(());
        }
    };
    if pass(left, right) {
        out.push_pass();
    }
    Ok(())
}

fn eval_gt(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    eval_numeric_cmp(out, spec, |l, r| l > r)
}
fn eval_lt(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    eval_numeric_cmp(out, spec, |l, r| l < r)
}
fn eval_gte(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    eval_numeric_cmp(out, spec, |l, r| l >= r)
}
fn eval_lte(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    eval_numeric_cmp(out, spec, |l, r| l <= r)
}

/// `starts_with(Value, Prefix)` — both bound; pass iff `Value` begins with `Prefix`.
fn eval_starts_with(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    if let (Some(v), Some(p)) = (bound_str(&spec.args[0]), bound_str(&spec.args[1])) {
        if v.starts_with(&p) {
            out.push_pass();
        }
    }
    Ok(())
}

/// `not_starts_with(Value, Prefix)` — both bound; pass iff `Value` does NOT begin with
/// `Prefix`. (A semantic complement filter, not stratified negation.)
fn eval_not_starts_with(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    if let (Some(v), Some(p)) = (bound_str(&spec.args[0]), bound_str(&spec.args[1])) {
        if !v.starts_with(&p) {
            out.push_pass();
        }
    }
    Ok(())
}

/// `string_contains(Value, Substring)` — both bound; pass iff `Value` contains `Substring`.
fn eval_string_contains(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    if let (Some(v), Some(s)) = (bound_str(&spec.args[0]), bound_str(&spec.args[1])) {
        if v.contains(&s) {
            out.push_pass();
        }
    }
    Ok(())
}

/// `ends_with(Value, Suffix)` — both bound; pass iff `Value` ends with `Suffix`. The
/// suffix twin of `starts_with` (string surfaces per spec §5).
fn eval_ends_with(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    if let (Some(v), Some(s)) = (bound_str(&spec.args[0]), bound_str(&spec.args[1])) {
        if v.ends_with(&s) {
            out.push_pass();
        }
    }
    Ok(())
}

// ── Functions: string derivations (concat / str_lower / basename / strip_quotes /
//    strip_prefix) ──

/// Shared tail of the [B…,F]/[B…,B] function builtins (the `method_suffix` discipline):
/// the computed `produced` value either BINDS the output position (free/captured),
/// passes existence (wildcard), or FILTERS on equality with an already-bound output.
fn bind_or_check(out: &mut Batch, spec: &ArgSpec, pos: usize, produced: &str) {
    if spec.args[pos].mode() == ArgMode::Free {
        match free_slot(&spec.args[pos]) {
            Some(slot) => {
                let width = spec.output_arity();
                out.push(emit_row(width, &[(slot, Value::Str(produced.to_string()))]));
            }
            // Wildcard output column: pure existence of a produced value.
            None => out.push_pass(),
        }
    } else if bound_str(&spec.args[pos]).as_deref() == Some(produced) {
        out.push_pass();
    }
}

/// `concat(A, B, Out)` — string concatenation of the two bound §5 string surfaces.
/// Function kind: a free arg2 binds `A ++ B`; a bound arg2 filters on equality with it.
fn eval_concat(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let (Some(a), Some(b)) = (bound_str(&spec.args[0]), bound_str(&spec.args[1])) else {
        return Ok(());
    };
    let produced = format!("{a}{b}");
    bind_or_check(out, spec, 2, &produced);
    Ok(())
}

/// `str_lower(S, L)` — `L` is the ASCII-lowercased surface of `S` (`to_ascii_lowercase`;
/// non-ASCII characters pass through unchanged — identifiers/paths/edge types are the
/// intended domain, not locale-aware text). Free arg1 binds; bound arg1 equality-filters.
fn eval_str_lower(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let Some(s) = bound_str(&spec.args[0]) else {
        return Ok(());
    };
    let produced = s.to_ascii_lowercase();
    bind_or_check(out, spec, 1, &produced);
    Ok(())
}

/// `basename(P, B)` — the substring after the LAST `/` of a path (`"a/b/c.js"` →
/// `"c.js"`); identity when the path has no `/` (`"c.js"` → `"c.js"`). NO row when the
/// result is empty (a trailing slash, `"a/b/"`): an empty basename names nothing
/// (mirrors `method_suffix`'s empty-suffix skip). Free arg1 binds; bound arg1 filters.
fn eval_basename(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let Some(p) = bound_str(&spec.args[0]) else {
        return Ok(());
    };
    let produced = match p.rfind('/') {
        Some(slash) => &p[slash + 1..],
        None => p.as_str(),
    };
    if produced.is_empty() {
        return Ok(());
    }
    bind_or_check(out, spec, 1, produced);
    Ok(())
}

/// `strip_quotes(R, V)` — `V` is `R` minus ONE pair of surrounding MATCHING quotes
/// (`"x"` → `x`, `'x'` → `x`, `""x""` → `"x"`); identity when `R` is not so wrapped
/// (unquoted, mismatched `"x'`, or too short to carry a pair). Free arg1 binds; bound
/// arg1 equality-filters. A wrapped empty string (`""` → ``) still produces its row —
/// the empty VALUE is a legitimate stripping result, unlike `basename`'s empty name.
fn eval_strip_quotes(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let Some(r) = bound_str(&spec.args[0]) else {
        return Ok(());
    };
    let bytes = r.as_bytes();
    let produced = if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        &r[1..r.len() - 1]
    } else {
        r.as_str()
    };
    bind_or_check(out, spec, 1, produced);
    Ok(())
}


/// `strip_prefix(S, Prefix, Rest)` — `Rest` is `S` minus its leading `Prefix`
/// (`strip_prefix("*:./foo", "*:", R)` → `"./foo"`; the star re-export source and
/// `"TName::"` split shapes). NO row when `S` does not START with `Prefix`: a
/// match-and-extract, not an identity fallback (mirrors `basename`'s no-row stance — a
/// non-match names nothing). `S == Prefix` still produces its row binding the empty REST
/// (the empty value is a legitimate extraction result, `strip_quotes`' stance), and an
/// empty `Prefix` matches everything (identity). Free arg2 binds; bound arg2
/// equality-filters.
fn eval_strip_prefix(_v: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let (Some(s), Some(prefix)) = (bound_str(&spec.args[0]), bound_str(&spec.args[1])) else {
        return Ok(());
    };
    let Some(rest) = s.strip_prefix(prefix.as_str()) else {
        return Ok(());
    };
    bind_or_check(out, spec, 2, rest);
    Ok(())
}

// ── Function: edge_attr (edge-metadata point probe) ────────────────

/// `edge_attr(Src, Dst, Type, Key, Val)` — read a TOP-LEVEL string/number field `Key`
/// from the metadata JSON of the bound edge `Src -[Type]-> Dst` (the metadata twin of
/// `attr`, served by the one-edge point probe [`StorageView::edge_metadata`] — all of
/// src/dst/type are already bound, §8.3). Free arg4 binds the field's string surface
/// (a JSON string verbatim, a JSON number by its JSON text); bound arg4 equality-filters.
///
/// Missing edge, edge without metadata, unparseable metadata, missing key, or a
/// non-scalar value (bool/null/array/object) ⇒ NO row — a tuple non-match, never an
/// error (the graph legitimately contains edges without the asked-for field).
fn eval_edge_attr(view: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let (Some(src), Some(dst)) = (bound_id(&spec.args[0]), bound_id(&spec.args[1])) else {
        return Ok(());
    };
    let (Some(ty), Some(key)) = (bound_str(&spec.args[2]), bound_str(&spec.args[3])) else {
        return Ok(());
    };
    let Some(blob) = view.edge_metadata(src, dst, &ty) else {
        return Ok(());
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&blob) else {
        return Ok(());
    };
    let produced = match parsed.get(&key) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        // Absent key or a non-scalar (bool/null/array/object) value: no row.
        _ => return Ok(()),
    };
    bind_or_check(out, spec, 4, &produced);
    Ok(())
}

// ── Function: node_attr (node-metadata point probe) ────────────────

/// `node_attr(NodeId, Key, Val)` — read a TOP-LEVEL string/number field `Key` from the
/// metadata JSON of the bound node `NodeId` (the node twin of `edge_attr`, served by the
/// one-node point probe [`StorageView::node_metadata`] — the id is already bound, §8.3).
/// Free arg2 binds the field's string surface (a JSON string verbatim, a JSON number by
/// its JSON text); bound arg2 equality-filters.
///
/// Missing node, node without metadata, unparseable metadata, missing key, or a
/// non-scalar value (bool/null/array/object) ⇒ NO row — a tuple non-match, never an
/// error (the graph legitimately contains nodes without the asked-for field).
fn eval_node_attr(view: &dyn StorageView, out: &mut Batch, spec: &ArgSpec) -> BuiltinResult<()> {
    let Some(id) = bound_id(&spec.args[0]) else {
        return Ok(());
    };
    let Some(key) = bound_str(&spec.args[1]) else {
        return Ok(());
    };
    let Some(blob) = view.node_metadata(id) else {
        return Ok(());
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&blob) else {
        return Ok(());
    };
    let produced = match parsed.get(&key) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        // Absent key or a non-scalar (bool/null/array/object) value: no row.
        _ => return Ok(()),
    };
    bind_or_check(out, spec, 2, &produced);
    Ok(())
}

// ── Mode tables ────────────────────────────────────────────────────

use ArgMode::{Bound as B, Free as F};

/// `node`/`type` modes: generate by type, check id+type, bind type of id.
const NODE_MODES: &[Mode] = &[
    Mode { args: &[F, B] }, // node(X, "TYPE") — generate
    Mode { args: &[B, B] }, // node(id, "TYPE") — check
    Mode { args: &[B, F] }, // node(id, T) — bind type
];

/// `edge`/`incoming` modes: type is always bound at Gate A. Near endpoint may be bound to
/// narrow; far endpoint may be bound to check.
const EDGE_MODES: &[Mode] = &[
    Mode { args: &[F, F, B] }, // edge(S, D, "T") — generate all
    Mode { args: &[B, F, B] }, // edge(s, D, "T") — outgoing of s
    Mode { args: &[F, B, B] }, // edge(S, d, "T") — sources into d
    Mode { args: &[B, B, B] }, // edge(s, d, "T") — check triple
];

/// `attr` modes: a bound-id reader (bind/check the column value) and a value generator.
const ATTR_MODES: &[Mode] = &[
    Mode { args: &[B, B, F] }, // attr(id, "key", V)     — bind the column value
    Mode { args: &[B, B, B] }, // attr(id, "key", "val") — check the column equals the literal
    Mode { args: &[F, B, B] }, // attr(X, "key", "val")  — generate ids whose key == value
];

/// Two-argument filter modes: both arguments must be bound.
const FILTER2_MODES: &[Mode] = &[Mode { args: &[B, B] }];

/// `method_suffix/2` modes: the full dotted name (arg0) must be bound; the method-name
/// column (arg1) is either free (bind the extracted suffix) or bound (equality check).
const METHOD_SUFFIX_MODES: &[Mode] = &[Mode { args: &[B, F] }, Mode { args: &[B, B] }];

/// Unary string-function modes (`str_lower`/`basename`/`strip_quotes`): the input (arg0)
/// must be bound; the output (arg1) is either free (bind) or bound (equality check) —
/// the same discipline as [`METHOD_SUFFIX_MODES`].
const STR_FN2_MODES: &[Mode] = &[Mode { args: &[B, F] }, Mode { args: &[B, B] }];

/// `concat/3`/`strip_prefix/3` modes: both inputs bound; the output (last position) is
/// free (bind) or bound (equality check).
const CONCAT_MODES: &[Mode] = &[Mode { args: &[B, B, F] }, Mode { args: &[B, B, B] }];

/// `edge_attr/5` modes: the edge triple (src, dst, type) and the metadata key are always
/// bound (a point probe on a bound edge); the value is free (bind) or bound (check).
const EDGE_ATTR_MODES: &[Mode] = &[
    Mode { args: &[B, B, B, B, F] },
    Mode { args: &[B, B, B, B, B] },
];

/// `node_attr/3` modes: the node id and the metadata key are always bound (a point probe
/// on a bound node — there is deliberately NO generator mode, unlike `attr`'s [F,B,B]);
/// the value is free (bind) or bound (check).
const NODE_ATTR_MODES: &[Mode] = &[
    Mode { args: &[B, B, F] },
    Mode { args: &[B, B, B] },
];

// ── The registry (one registration point) ──────────────────────────

/// All Gate A builtins, in a single declaration. The planner and executor look up a
/// builtin by name here; this is the sole registration point (spec §7).
pub fn registry() -> Vec<BuiltinDef> {
    vec![
        BuiltinDef {
            name: "node",
            arity: 2,
            modes: NODE_MODES,
            kind: BuiltinKind::Generator,
            eval: eval_node,
        },
        BuiltinDef {
            name: "type",
            arity: 2,
            modes: NODE_MODES,
            kind: BuiltinKind::Generator,
            eval: eval_node,
        },
        BuiltinDef {
            name: "edge",
            arity: 3,
            modes: EDGE_MODES,
            kind: BuiltinKind::Generator,
            eval: eval_edge,
        },
        BuiltinDef {
            name: "incoming",
            arity: 3,
            modes: EDGE_MODES,
            kind: BuiltinKind::Generator,
            eval: eval_incoming,
        },
        BuiltinDef {
            name: "attr",
            arity: 3,
            modes: ATTR_MODES,
            kind: BuiltinKind::Function,
            eval: eval_attr,
        },
        BuiltinDef {
            name: "neq",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_neq,
        },
        BuiltinDef {
            name: "gt",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_gt,
        },
        BuiltinDef {
            name: "lt",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_lt,
        },
        BuiltinDef {
            name: "gte",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_gte,
        },
        BuiltinDef {
            name: "lte",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_lte,
        },
        BuiltinDef {
            name: "starts_with",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_starts_with,
        },
        BuiltinDef {
            name: "not_starts_with",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_not_starts_with,
        },
        BuiltinDef {
            name: "string_contains",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_string_contains,
        },
        BuiltinDef {
            name: "method_suffix",
            arity: 2,
            modes: METHOD_SUFFIX_MODES,
            kind: BuiltinKind::Function,
            eval: eval_method_suffix,
        },
        BuiltinDef {
            name: "ends_with",
            arity: 2,
            modes: FILTER2_MODES,
            kind: BuiltinKind::Filter,
            eval: eval_ends_with,
        },
        BuiltinDef {
            name: "concat",
            arity: 3,
            modes: CONCAT_MODES,
            kind: BuiltinKind::Function,
            eval: eval_concat,
        },
        BuiltinDef {
            name: "str_lower",
            arity: 2,
            modes: STR_FN2_MODES,
            kind: BuiltinKind::Function,
            eval: eval_str_lower,
        },
        BuiltinDef {
            name: "basename",
            arity: 2,
            modes: STR_FN2_MODES,
            kind: BuiltinKind::Function,
            eval: eval_basename,
        },
        BuiltinDef {
            name: "strip_quotes",
            arity: 2,
            modes: STR_FN2_MODES,
            kind: BuiltinKind::Function,
            eval: eval_strip_quotes,
        },
        BuiltinDef {
            name: "strip_prefix",
            arity: 3,
            modes: CONCAT_MODES,
            kind: BuiltinKind::Function,
            eval: eval_strip_prefix,
        },
        BuiltinDef {
            name: "edge_attr",
            arity: 5,
            modes: EDGE_ATTR_MODES,
            kind: BuiltinKind::Function,
            eval: eval_edge_attr,
        },
        BuiltinDef {
            name: "node_attr",
            arity: 3,
            modes: NODE_ATTR_MODES,
            kind: BuiltinKind::Function,
            eval: eval_node_attr,
        },
    ]
}

/// Look up a builtin by name in the registry (linear; the set is small and fixed).
pub fn lookup(name: &str) -> Option<BuiltinDef> {
    registry().into_iter().find(|b| b.name == name)
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::manifest::ManifestStore;
    use crate::storage_v2::multi_shard::MultiShardStore;
    use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};
    use std::collections::HashMap;
    use std::sync::Arc;

    use super::super::storage_glue::LsmStorageView;

    fn id_of(semantic_id: &str) -> u128 {
        u128::from_le_bytes(
            blake3::hash(semantic_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        )
    }

    fn node_rec(sid: &str, ty: &str, name: &str, file: &str) -> NodeRecordV2 {
        NodeRecordV2 {
            semantic_id: sid.to_string(),
            id: id_of(sid),
            node_type: ty.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    fn edge_rec(src: &str, dst: &str, ty: &str) -> EdgeRecordV2 {
        EdgeRecordV2 {
            src: id_of(src),
            dst: id_of(dst),
            edge_type: ty.to_string(),
            metadata: String::new(),
        }
    }

    /// A small committed store with two functions, one class, and CALLS/CONTAINS edges.
    fn build_view() -> LsmStorageView {
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();
        let nodes = vec![
            node_rec("a/fn1", "FUNCTION", "fn1", "a/file.js"),
            node_rec("a/fn2", "FUNCTION", "fn2", "a/file.js"),
            node_rec("b/cls1", "CLASS", "Widget", "b/file.js"),
        ];
        let edges = vec![
            edge_rec("a/fn1", "a/fn2", "CALLS"),
            edge_rec("a/fn1", "b/cls1", "CONTAINS"),
            edge_rec("a/fn2", "b/cls1", "CALLS"),
        ];
        store
            .commit_batch(
                nodes,
                edges,
                &["a/file.js".to_string(), "b/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();
        LsmStorageView::capture(Arc::new(store), &manifest)
    }

    fn s(v: &str) -> Value {
        Value::Str(v.to_string())
    }

    fn run(name: &str, spec: ArgSpec) -> Batch {
        let view = build_view();
        let def = lookup(name).expect("builtin registered");
        // Mode must be supported for the call to proceed.
        def.check_mode(&spec).expect("mode supported");
        let mut out = Batch::new();
        (def.eval)(&view, &mut out, &spec).expect("eval ok");
        out
    }

    // ── registry / mode ────────────────────────────────────────────

    #[test]
    fn registry_has_all_ported_builtins() {
        for name in [
            "node",
            "type",
            "edge",
            "incoming",
            "attr",
            "neq",
            "gt",
            "lt",
            "gte",
            "lte",
            "starts_with",
            "not_starts_with",
            "string_contains",
            "method_suffix",
            "ends_with",
            "concat",
            "str_lower",
            "basename",
            "strip_quotes",
            "strip_prefix",
            "edge_attr",
            "node_attr",
        ] {
            assert!(lookup(name).is_some(), "missing builtin {name}");
        }
    }

    /// Every registered builtin must ALSO be known to the stratifier (the `BUILTINS` array
    /// in stratify.rs) so it is never mistaken for a derived predicate — method_suffix was
    /// once registered here but forgotten there (debug_assert panic). Pin the pairing for
    /// the whole registry so a future builtin cannot repeat the miss.
    #[test]
    fn every_registered_builtin_is_extensional_for_the_stratifier() {
        for def in registry() {
            let args = (0..def.arity)
                .map(|i| format!("V{i}"))
                .collect::<Vec<_>>()
                .join(", ");
            let src = format!("p(V0) :- {}({args}).", def.name);
            let prog =
                crate::datalog2::parser_ext::parse_ext_program(&src).expect("probe rule parses");
            let strat = crate::datalog2::stratify::stratify(&prog).expect("stratifies");
            assert_eq!(
                strat.strata.len(),
                1,
                "builtin `{}` must be extensional (one stratum, only `p` derived) — \
                 is it missing from stratify.rs BUILTINS?",
                def.name
            );
            assert_eq!(strat.strata[0].predicates, vec!["p".to_string()]);
        }
    }

    #[test]
    fn arity_matches_mode_widths() {
        for def in registry() {
            for m in def.modes {
                assert_eq!(m.args.len(), def.arity, "{} mode width", def.name);
            }
        }
    }

    #[test]
    fn unsupported_mode_is_e_plan_001_naming_bindings() {
        // edge(S, D, T) with a FREE type is unsupported at Gate A → E-PLAN-001 naming the
        // type position (2) which every same-arity mode requires bound.
        let def = lookup("edge").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Free { slot: 1 },
            ArgValue::Free { slot: 2 },
        ]);
        let err = def.check_mode(&spec).unwrap_err();
        assert_eq!(err.code, BuiltinCode::UnsupportedMode);
        assert_eq!(err.code.as_str(), "E-PLAN-001");
        assert!(err.required_bindings.contains(&2), "must name type position");
    }

    #[test]
    fn attr_free_id_and_free_value_is_unsupported_mode() {
        // attr(Free, "name", FreeV) — neither the bound-id reader ([B,B,_]) nor the value
        // generator ([F,B,B]) applies: the reader needs arg0 (id) bound while the generator
        // needs arg2 (value) bound. The call is still rejected with the authoritative
        // E-PLAN-001 code. The required-binding HINT names only positions that *every*
        // same-arity mode requires bound; with the generator now registered there is no such
        // single position (the reader wants arg0, the generator wants arg2), so position 0 is
        // no longer pinned as the sole fix — binding EITHER arg0 (→ reader) or arg2
        // (→ generator) resolves it.
        let def = lookup("attr").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("name")),
            ArgValue::Free { slot: 1 },
        ]);
        let err = def.check_mode(&spec).unwrap_err();
        assert_eq!(err.code.as_str(), "E-PLAN-001");
        assert!(
            !err.required_bindings.contains(&0),
            "id is left free by the [F,B,B] generator mode, so it is no longer the sole \
             required binding; got {:?}",
            err.required_bindings
        );
    }

    // ── node / type ────────────────────────────────────────────────

    #[test]
    fn node_generates_ids_by_type() {
        let spec = ArgSpec::new(vec![ArgValue::Free { slot: 0 }, ArgValue::Bound(s("FUNCTION"))]);
        let out = run("node", spec);
        let ids: Vec<u128> = out
            .rows
            .iter()
            .map(|r| match &r[0] {
                Value::Id(id) => *id,
                _ => panic!("expected id"),
            })
            .collect();
        assert_eq!(ids.len(), 2, "two FUNCTION nodes");
        assert!(ids.contains(&id_of("a/fn1")));
        assert!(ids.contains(&id_of("a/fn2")));
    }

    #[test]
    fn type_alias_behaves_like_node() {
        let spec = ArgSpec::new(vec![ArgValue::Free { slot: 0 }, ArgValue::Bound(s("CLASS"))]);
        let out = run("type", spec);
        assert_eq!(out.rows.len(), 1, "one CLASS node");
    }

    #[test]
    fn node_check_bound_id_and_type() {
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("a/fn1"))),
            ArgValue::Bound(s("FUNCTION")),
        ]);
        assert_eq!(run("node", spec).rows.len(), 1, "id is a FUNCTION");

        let wrong = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("a/fn1"))),
            ArgValue::Bound(s("CLASS")),
        ]);
        assert_eq!(run("node", wrong).rows.len(), 0, "id is not a CLASS");
    }

    #[test]
    fn node_binds_type_of_bound_id() {
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("node", spec);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("CLASS"));
    }

    // ── edge / incoming ────────────────────────────────────────────

    #[test]
    fn edge_generates_all_of_type() {
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Free { slot: 1 },
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run("edge", spec);
        assert_eq!(out.rows.len(), 2, "two CALLS edges");
        for r in &out.rows {
            assert!(matches!(r[0], Value::Id(_)));
            assert!(matches!(r[1], Value::Id(_)));
        }
    }

    #[test]
    fn edge_outgoing_of_bound_source() {
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("a/fn1"))),
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run("edge", spec);
        assert_eq!(out.rows.len(), 1, "fn1 CALLS fn2");
        assert_eq!(out.rows[0][0], Value::Id(id_of("a/fn2")));
    }

    #[test]
    fn edge_check_triple_exists() {
        let present = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("a/fn1"))),
            ArgValue::Bound(Value::Id(id_of("a/fn2"))),
            ArgValue::Bound(s("CALLS")),
        ]);
        assert_eq!(run("edge", present).rows.len(), 1);

        let absent = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("a/fn2"))),
            ArgValue::Bound(Value::Id(id_of("a/fn1"))),
            ArgValue::Bound(s("CALLS")),
        ]);
        assert_eq!(run("edge", absent).rows.len(), 0);
    }

    #[test]
    fn incoming_binds_sources_into_bound_dst() {
        // incoming(dst, Src, "CALLS"): who CALLS cls1? — fn2 (a/fn2 -> b/cls1 CALLS).
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run("incoming", spec);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], Value::Id(id_of("a/fn2")));
    }

    // ── keyed-probe access path (no full-type scan when an endpoint is bound) ──

    use super::super::storage_glue::{EdgeRow, FixtureStorageView, NodeRow as GlueNodeRow};
    use std::cell::Cell;

    /// A `StorageView` that delegates to a fixture but counts which access path each call
    /// takes, so a test can assert that a bound endpoint is served by a *keyed* probe and
    /// NEVER by the full `scan_edges_by_type`.
    struct CountingView {
        inner: FixtureStorageView,
        scans: Cell<usize>,
        from_probes: Cell<usize>,
        to_probes: Cell<usize>,
    }

    impl CountingView {
        fn new(inner: FixtureStorageView) -> Self {
            Self {
                inner,
                scans: Cell::new(0),
                from_probes: Cell::new(0),
                to_probes: Cell::new(0),
            }
        }
    }

    impl StorageView for CountingView {
        fn generation(&self) -> u64 {
            self.inner.generation()
        }
        fn sorted_run(
            &self,
            rel: super::super::storage_glue::Relation,
            order: super::super::storage_glue::SortOrder,
        ) -> Box<dyn Iterator<Item = super::super::storage_glue::Row> + '_> {
            self.inner.sorted_run(rel, order)
        }
        fn scan_nodes_by_type(&self, ty: &str) -> Box<dyn Iterator<Item = GlueNodeRow> + '_> {
            self.inner.scan_nodes_by_type(ty)
        }
        fn scan_edges_by_type(
            &self,
            ty: &str,
            order: EdgeOrder,
        ) -> Box<dyn Iterator<Item = EdgeRow> + '_> {
            self.scans.set(self.scans.get() + 1);
            self.inner.scan_edges_by_type(ty, order)
        }
        fn edges_from(&self, src: u128, edge_type: &str) -> Vec<EdgeRow> {
            self.from_probes.set(self.from_probes.get() + 1);
            self.inner.edges_from(src, edge_type)
        }
        fn edges_to(&self, dst: u128, edge_type: &str) -> Vec<EdgeRow> {
            self.to_probes.set(self.to_probes.get() + 1);
            self.inner.edges_to(dst, edge_type)
        }
        fn get_node(&self, id: u128) -> Option<GlueNodeRow> {
            self.inner.get_node(id)
        }
        fn nodes_by_attr(&self, key: &str, value: &str) -> Vec<GlueNodeRow> {
            self.inner.nodes_by_attr(key, value)
        }
        fn edge_metadata(&self, src: u128, dst: u128, edge_type: &str) -> Option<String> {
            self.inner.edge_metadata(src, dst, edge_type)
        }
        fn node_metadata(&self, id: u128) -> Option<String> {
            self.inner.node_metadata(id)
        }
    }

    fn counting_view() -> CountingView {
        let mut v = FixtureStorageView::new(1);
        for (sid, ty, name, file) in [
            ("a/fn1", "FUNCTION", "fn1", "a/file.js"),
            ("a/fn2", "FUNCTION", "fn2", "a/file.js"),
            ("b/cls1", "CLASS", "Widget", "b/file.js"),
        ] {
            v.put_node(GlueNodeRow {
                id: id_of(sid),
                node_type: ty.to_string(),
                name: name.to_string(),
                file: file.to_string(),
            });
        }
        for (src, dst, ty) in [
            ("a/fn1", "a/fn2", "CALLS"),
            ("a/fn1", "b/cls1", "CONTAINS"),
            ("a/fn2", "b/cls1", "CALLS"),
        ] {
            v.put_edge(EdgeRow {
                src: id_of(src),
                dst: id_of(dst),
                edge_type: ty.to_string(),
            });
        }
        CountingView::new(v)
    }

    fn run_on<'a>(view: &'a CountingView, name: &str, spec: ArgSpec) -> Batch {
        let def = lookup(name).expect("builtin registered");
        def.check_mode(&spec).expect("mode supported");
        let mut out = Batch::new();
        (def.eval)(view, &mut out, &spec).expect("eval ok");
        out
    }

    #[test]
    fn edge_bound_src_uses_keyed_probe_not_scan() {
        // edge(BoundSrc, Free, "CALLS") — must hit edges_from, never scan_edges_by_type.
        let view = counting_view();
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("a/fn1"))),
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run_on(&view, "edge", spec);
        assert_eq!(out.rows.len(), 1, "fn1 CALLS fn2");
        assert_eq!(out.rows[0][0], Value::Id(id_of("a/fn2")));
        assert_eq!(view.scans.get(), 0, "no full-type scan for a bound src");
        assert_eq!(view.from_probes.get(), 1, "served by one keyed edges_from probe");
        assert_eq!(view.to_probes.get(), 0);
    }

    #[test]
    fn edge_bound_dst_uses_keyed_probe_not_scan() {
        // edge(Free, BoundDst, "CALLS") — far (dst) bound → edges_to, never a scan.
        let view = counting_view();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run_on(&view, "edge", spec);
        assert_eq!(out.rows.len(), 1, "fn2 CALLS cls1");
        assert_eq!(out.rows[0][0], Value::Id(id_of("a/fn2")), "binds the free src");
        assert_eq!(view.scans.get(), 0, "no full-type scan for a bound dst");
        assert_eq!(view.to_probes.get(), 1, "served by one keyed edges_to probe");
        assert_eq!(view.from_probes.get(), 0);
    }

    #[test]
    fn incoming_bound_dst_uses_keyed_probe_not_scan() {
        // incoming(BoundDst, Free, "CALLS") — Reverse near (dst) bound → edges_to.
        let view = counting_view();
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run_on(&view, "incoming", spec);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], Value::Id(id_of("a/fn2")));
        assert_eq!(view.scans.get(), 0, "no full-type scan for a bound dst (reverse)");
        assert_eq!(view.to_probes.get(), 1, "reverse near=dst → keyed edges_to");
        assert_eq!(view.from_probes.get(), 0);
    }

    #[test]
    fn incoming_bound_src_uses_keyed_probe_not_scan() {
        // incoming(Free, BoundSrc, "CALLS") — Reverse far (src) bound → edges_from.
        let view = counting_view();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(Value::Id(id_of("a/fn2"))),
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run_on(&view, "incoming", spec);
        // a/fn2 -CALLS-> b/cls1 ; incoming(dst=cls1, src=fn2) → near (dst) free binds cls1.
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], Value::Id(id_of("b/cls1")));
        assert_eq!(view.scans.get(), 0, "no full-type scan for a bound src (reverse)");
        assert_eq!(view.from_probes.get(), 1, "reverse far=src → keyed edges_from");
        assert_eq!(view.to_probes.get(), 0);
    }

    #[test]
    fn edge_check_triple_uses_keyed_probe_not_scan() {
        // edge(BoundSrc, BoundDst, "CALLS") — both bound → keyed near probe + far filter.
        let view = counting_view();
        let present = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("a/fn1"))),
            ArgValue::Bound(Value::Id(id_of("a/fn2"))),
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run_on(&view, "edge", present);
        assert_eq!(out.rows.len(), 1, "fn1 CALLS fn2 exists");
        assert_eq!(view.scans.get(), 0, "triple check uses the keyed near probe");
        assert_eq!(view.from_probes.get(), 1);
    }

    #[test]
    fn edge_both_free_falls_back_to_scan() {
        // edge(Free, Free, "CALLS") — only here is a full typed scan the correct path.
        let view = counting_view();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Free { slot: 1 },
            ArgValue::Bound(s("CALLS")),
        ]);
        let out = run_on(&view, "edge", spec);
        assert_eq!(out.rows.len(), 2, "two CALLS edges");
        assert_eq!(view.scans.get(), 1, "fully-free generator uses the typed scan");
        assert_eq!(view.from_probes.get(), 0);
        assert_eq!(view.to_probes.get(), 0);
    }

    // ── attr (+ coercion) ──────────────────────────────────────────

    #[test]
    fn attr_binds_first_class_columns() {
        for (key, expected) in [("name", "Widget"), ("type", "CLASS"), ("file", "b/file.js")] {
            let spec = ArgSpec::new(vec![
                ArgValue::Bound(Value::Id(id_of("b/cls1"))),
                ArgValue::Bound(s(key)),
                ArgValue::Free { slot: 0 },
            ]);
            let out = run("attr", spec);
            assert_eq!(out.rows.len(), 1, "attr {key} binds");
            assert_eq!(out.rows[0][0], s(expected));
            assert_eq!(out.coercion_misses, 0);
        }
    }

    #[test]
    fn attr_check_equality_match_and_nonmatch() {
        let m = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Bound(s("name")),
            ArgValue::Bound(s("Widget")),
        ]);
        let out = run("attr", m);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.coercion_misses, 0);

        let nm = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Bound(s("name")),
            ArgValue::Bound(s("Other")),
        ]);
        let out = run("attr", nm);
        assert_eq!(out.rows.len(), 0, "ordinary non-match, not a miss");
        assert_eq!(out.coercion_misses, 0);
    }

    #[test]
    fn attr_unknown_key_is_coercion_miss_not_crash() {
        // A metadata key outside the Gate A row surface → coercion miss (counted), never a
        // crash and never silently treated as "no such node".
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Bound(s("object")),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("attr", spec);
        assert_eq!(out.rows.len(), 0);
        assert_eq!(out.coercion_misses, 1, "unknown key recorded as a miss");
    }

    #[test]
    fn attr_uncoercible_literal_is_miss() {
        // Compare the string column "Widget" against an Id literal: the column has no id
        // surface → coercion miss, not a silent non-match.
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of("b/cls1"))),
            ArgValue::Bound(s("name")),
            ArgValue::Bound(Value::Id(123)),
        ]);
        let out = run("attr", spec);
        assert_eq!(out.rows.len(), 0);
        assert_eq!(out.coercion_misses, 1);
    }

    #[test]
    fn attr_missing_node_is_empty_not_miss() {
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(0xdead_beef)),
            ArgValue::Bound(s("name")),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("attr", spec);
        assert_eq!(out.rows.len(), 0, "no such node → legitimately empty");
        assert_eq!(out.coercion_misses, 0, "absence is not a coercion miss");
    }

    // ── attr value-generator (parity with v1 find_by_attr) ─────────

    #[test]
    fn attr_generator_mode_is_supported() {
        // attr(Free X, "name", "switch") — the [F, B, B] generator mode is registered, so
        // the mode check passes (Gate A had rejected this as E-PLAN-001).
        let def = lookup("attr").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("name")),
            ArgValue::Bound(s("switch")),
        ]);
        def.check_mode(&spec).expect("attr generator mode supported");
    }

    /// A fixture with two FUNCTION nodes named `switch` and one named `loop`, to exercise the
    /// value generator returning *exactly* the matching ids.
    fn switch_fixture() -> FixtureStorageView {
        let mut v = FixtureStorageView::new(1);
        for (sid, ty, name, file) in [
            ("a/sw1", "FUNCTION", "switch", "a/file.js"),
            ("a/sw2", "FUNCTION", "switch", "b/file.js"),
            ("a/lp1", "FUNCTION", "loop", "a/file.js"),
        ] {
            v.put_node(GlueNodeRow {
                id: id_of(sid),
                node_type: ty.to_string(),
                name: name.to_string(),
                file: file.to_string(),
            });
        }
        v
    }

    #[test]
    fn attr_generator_binds_unbound_id_to_matching_nodes_on_fixture() {
        // attr(X, "name", "switch") with X unbound → exactly the two `switch` node ids.
        let view = switch_fixture();
        let def = lookup("attr").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("name")),
            ArgValue::Bound(s("switch")),
        ]);
        def.check_mode(&spec).expect("mode supported");
        let mut out = Batch::new();
        (def.eval)(&view, &mut out, &spec).expect("eval ok");

        let mut got: Vec<u128> = out
            .rows
            .iter()
            .map(|r| match &r[0] {
                Value::Id(id) => *id,
                other => panic!("expected an id, got {other:?}"),
            })
            .collect();
        got.sort_unstable();
        let mut expected = vec![id_of("a/sw1"), id_of("a/sw2")];
        expected.sort_unstable();
        assert_eq!(got, expected, "generator binds exactly the two `switch` ids");
        assert_eq!(out.coercion_misses, 0);

        // A value that matches nothing → empty, not an error.
        let none = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("name")),
            ArgValue::Bound(s("nonesuch")),
        ]);
        let mut out2 = Batch::new();
        (def.eval)(&view, &mut out2, &none).expect("eval ok");
        assert_eq!(out2.rows.len(), 0, "no node named `nonesuch`");
    }

    #[test]
    fn attr_generator_real_and_fixture_parity() {
        // Real LSM view (build_view): two FUNCTIONs named fn1/fn2, one CLASS named Widget.
        // attr(X, "name", "fn1") must bind exactly a/fn1 on both the real index and the
        // fixture — parity of the value-generator path with v1's find_by_attr.
        let real = build_view();
        let mut fixture = FixtureStorageView::new(1);
        for (sid, ty, name, file) in [
            ("a/fn1", "FUNCTION", "fn1", "a/file.js"),
            ("a/fn2", "FUNCTION", "fn2", "a/file.js"),
            ("b/cls1", "CLASS", "Widget", "b/file.js"),
        ] {
            fixture.put_node(GlueNodeRow {
                id: id_of(sid),
                node_type: ty.to_string(),
                name: name.to_string(),
                file: file.to_string(),
            });
        }

        let def = lookup("attr").unwrap();
        let eval_gen = |view: &dyn StorageView, key: &str, val: &str| -> Vec<u128> {
            let spec = ArgSpec::new(vec![
                ArgValue::Free { slot: 0 },
                ArgValue::Bound(s(key)),
                ArgValue::Bound(s(val)),
            ]);
            def.check_mode(&spec).expect("mode supported");
            let mut out = Batch::new();
            (def.eval)(view, &mut out, &spec).expect("eval ok");
            let mut ids: Vec<u128> = out
                .rows
                .iter()
                .map(|r| match &r[0] {
                    Value::Id(id) => *id,
                    other => panic!("expected id, got {other:?}"),
                })
                .collect();
            ids.sort_unstable();
            ids
        };

        // name → fn1 : exactly a/fn1 on both.
        let real_name = eval_gen(&real, "name", "fn1");
        let fix_name = eval_gen(&fixture, "name", "fn1");
        assert_eq!(real_name, vec![id_of("a/fn1")], "real binds a/fn1 by name");
        assert_eq!(real_name, fix_name, "real/fixture name-generator parity");

        // type → FUNCTION : both functions on both.
        let real_ty = eval_gen(&real, "type", "FUNCTION");
        let fix_ty = eval_gen(&fixture, "type", "FUNCTION");
        let mut expect_fns = vec![id_of("a/fn1"), id_of("a/fn2")];
        expect_fns.sort_unstable();
        assert_eq!(real_ty, expect_fns, "real binds both FUNCTIONs by type");
        assert_eq!(real_ty, fix_ty, "real/fixture type-generator parity");

        // file → b/file.js : exactly b/cls1 on both.
        let real_file = eval_gen(&real, "file", "b/file.js");
        let fix_file = eval_gen(&fixture, "file", "b/file.js");
        assert_eq!(real_file, vec![id_of("b/cls1")], "real binds b/cls1 by file");
        assert_eq!(real_file, fix_file, "real/fixture file-generator parity");
    }

    // ── filters ────────────────────────────────────────────────────

    #[test]
    fn neq_passes_when_different() {
        let pass = ArgSpec::new(vec![ArgValue::Bound(s("a")), ArgValue::Bound(s("b"))]);
        assert_eq!(run("neq", pass).rows.len(), 1);
        let fail = ArgSpec::new(vec![ArgValue::Bound(s("a")), ArgValue::Bound(s("a"))]);
        assert_eq!(run("neq", fail).rows.len(), 0);
    }

    #[test]
    fn numeric_comparisons() {
        let mk = |a: &str, b: &str| ArgSpec::new(vec![ArgValue::Bound(s(a)), ArgValue::Bound(s(b))]);
        assert_eq!(run("gt", mk("5", "3")).rows.len(), 1);
        assert_eq!(run("gt", mk("3", "5")).rows.len(), 0);
        assert_eq!(run("lt", mk("3", "5")).rows.len(), 1);
        assert_eq!(run("gte", mk("5", "5")).rows.len(), 1);
        assert_eq!(run("lte", mk("5", "5")).rows.len(), 1);
        assert_eq!(run("lte", mk("6", "5")).rows.len(), 0);
    }

    #[test]
    fn numeric_nonnumeric_is_coercion_miss() {
        let spec = ArgSpec::new(vec![ArgValue::Bound(s("abc")), ArgValue::Bound(s("3"))]);
        let out = run("gt", spec);
        assert_eq!(out.rows.len(), 0);
        assert_eq!(out.coercion_misses, 1, "non-numeric surface is a miss");
    }

    #[test]
    fn string_predicates() {
        let sw = ArgSpec::new(vec![
            ArgValue::Bound(s("queue:publish")),
            ArgValue::Bound(s("queue:")),
        ]);
        assert_eq!(run("starts_with", sw).rows.len(), 1);

        let nsw = ArgSpec::new(vec![
            ArgValue::Bound(s("queue:publish")),
            ArgValue::Bound(s("http:")),
        ]);
        assert_eq!(run("not_starts_with", nsw).rows.len(), 1);

        let sc = ArgSpec::new(vec![
            ArgValue::Bound(s("queue:publish")),
            ArgValue::Bound(s("pub")),
        ]);
        assert_eq!(run("string_contains", sc).rows.len(), 1);

        let sc_no = ArgSpec::new(vec![
            ArgValue::Bound(s("queue:publish")),
            ArgValue::Bound(s("zzz")),
        ]);
        assert_eq!(run("string_contains", sc_no).rows.len(), 0);
    }

    // ── ends_with ──────────────────────────────────────────────────

    #[test]
    fn ends_with_passes_on_suffix_only() {
        let hit = ArgSpec::new(vec![ArgValue::Bound(s("src/app.test.js")), ArgValue::Bound(s(".js"))]);
        assert_eq!(run("ends_with", hit).rows.len(), 1);
        let miss = ArgSpec::new(vec![ArgValue::Bound(s("src/app.test.js")), ArgValue::Bound(s(".ts"))]);
        assert_eq!(run("ends_with", miss).rows.len(), 0);
        // A PREFIX is not a suffix (the starts_with complement check).
        let prefix = ArgSpec::new(vec![ArgValue::Bound(s("src/app.js")), ArgValue::Bound(s("src/"))]);
        assert_eq!(run("ends_with", prefix).rows.len(), 0);
    }

    // ── concat ─────────────────────────────────────────────────────

    #[test]
    fn concat_binds_and_checks() {
        // [B, B, F] — bind the concatenation.
        let bind = ArgSpec::new(vec![
            ArgValue::Bound(s("kb.")),
            ArgValue::Bound(s("queryNodes")),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("concat", bind);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("kb.queryNodes"));

        // [B, B, B] — equality check: pass and non-match.
        let hit = ArgSpec::new(vec![
            ArgValue::Bound(s("a")),
            ArgValue::Bound(s("b")),
            ArgValue::Bound(s("ab")),
        ]);
        assert_eq!(run("concat", hit).rows.len(), 1);
        let miss = ArgSpec::new(vec![
            ArgValue::Bound(s("a")),
            ArgValue::Bound(s("b")),
            ArgValue::Bound(s("ba")),
        ]);
        assert_eq!(run("concat", miss).rows.len(), 0);
    }

    #[test]
    fn concat_free_input_is_unsupported_mode() {
        // concat(Free, B, F) — both inputs must be bound first (E-PLAN-001 names arg 0).
        let def = lookup("concat").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("b")),
            ArgValue::Free { slot: 1 },
        ]);
        let err = def.check_mode(&spec).unwrap_err();
        assert_eq!(err.code.as_str(), "E-PLAN-001");
        assert!(err.required_bindings.contains(&0), "must name the free input");
    }

    // ── str_lower ──────────────────────────────────────────────────

    #[test]
    fn str_lower_binds_ascii_lowercase_and_checks() {
        let bind = ArgSpec::new(vec![ArgValue::Bound(s("HTTP_Route")), ArgValue::Free { slot: 0 }]);
        let out = run("str_lower", bind);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("http_route"));

        let hit = ArgSpec::new(vec![ArgValue::Bound(s("ABC")), ArgValue::Bound(s("abc"))]);
        assert_eq!(run("str_lower", hit).rows.len(), 1);
        let miss = ArgSpec::new(vec![ArgValue::Bound(s("ABC")), ArgValue::Bound(s("ABC"))]);
        assert_eq!(run("str_lower", miss).rows.len(), 0, "output position is the LOWERED surface");
    }

    // ── basename ───────────────────────────────────────────────────

    #[test]
    fn basename_after_last_slash_identity_and_empty_skip() {
        // Substring after the LAST '/'.
        let deep = ArgSpec::new(vec![ArgValue::Bound(s("src/a/b/file.js")), ArgValue::Free { slot: 0 }]);
        let out = run("basename", deep);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("file.js"));

        // No '/' → identity.
        let flat = ArgSpec::new(vec![ArgValue::Bound(s("file.js")), ArgValue::Free { slot: 0 }]);
        let out = run("basename", flat);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("file.js"));

        // Trailing slash → empty basename → NO row (mirrors method_suffix's empty skip).
        let trailing = ArgSpec::new(vec![ArgValue::Bound(s("src/dir/")), ArgValue::Free { slot: 0 }]);
        assert_eq!(run("basename", trailing).rows.len(), 0);

        // [B, B] check mode.
        let hit = ArgSpec::new(vec![ArgValue::Bound(s("a/b.js")), ArgValue::Bound(s("b.js"))]);
        assert_eq!(run("basename", hit).rows.len(), 1);
        let miss = ArgSpec::new(vec![ArgValue::Bound(s("a/b.js")), ArgValue::Bound(s("a"))]);
        assert_eq!(run("basename", miss).rows.len(), 0);
    }

    // ── strip_quotes ───────────────────────────────────────────────

    #[test]
    fn strip_quotes_one_matching_pair_else_identity() {
        let case = |input: &str, expect: &str| {
            let spec = ArgSpec::new(vec![ArgValue::Bound(s(input)), ArgValue::Free { slot: 0 }]);
            let out = run("strip_quotes", spec);
            assert_eq!(out.rows.len(), 1, "strip_quotes({input:?}) must produce one row");
            assert_eq!(out.rows[0][0], s(expect), "strip_quotes({input:?})");
        };
        case("\"./util\"", "./util"); // double quotes stripped
        case("'./util'", "./util"); // single quotes stripped
        case("\"\"x\"\"", "\"x\""); // exactly ONE pair stripped
        case("./util", "./util"); // unquoted → identity
        case("\"./util'", "\"./util'"); // MISMATCHED pair → identity
        case("\"", "\""); // a lone quote (len 1) → identity
        case("\"\"", ""); // a wrapped empty string strips to the empty VALUE (a row)

        // [B, B] check mode.
        let hit = ArgSpec::new(vec![ArgValue::Bound(s("'x'")), ArgValue::Bound(s("x"))]);
        assert_eq!(run("strip_quotes", hit).rows.len(), 1);
        let miss = ArgSpec::new(vec![ArgValue::Bound(s("'x'")), ArgValue::Bound(s("'x'"))]);
        assert_eq!(run("strip_quotes", miss).rows.len(), 0);
    }

    // ── strip_prefix ───────────────────────────────────────────────

    #[test]
    fn strip_prefix_match_and_extract_no_identity_fallback() {
        // [B, B, F] — bind the rest after the prefix (the "*:./foo" star re-export shape).
        let bind = ArgSpec::new(vec![
            ArgValue::Bound(s("*:./foo")),
            ArgValue::Bound(s("*:")),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("strip_prefix", bind);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("./foo"));

        // The "TName::" split shape.
        let split = ArgSpec::new(vec![
            ArgValue::Bound(s("Widget::render")),
            ArgValue::Bound(s("Widget::")),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("strip_prefix", split);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("render"));

        // Non-matching prefix → NO row (match-and-extract, never an identity fallback).
        let miss = ArgSpec::new(vec![
            ArgValue::Bound(s("./foo")),
            ArgValue::Bound(s("*:")),
            ArgValue::Free { slot: 0 },
        ]);
        assert_eq!(run("strip_prefix", miss).rows.len(), 0);

        // S == Prefix strips to the empty REST — still a row (strip_quotes' empty-VALUE
        // stance, unlike basename's empty-name skip).
        let empty_rest = ArgSpec::new(vec![
            ArgValue::Bound(s("*:")),
            ArgValue::Bound(s("*:")),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("strip_prefix", empty_rest);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s(""));

        // An empty prefix matches everything → identity.
        let empty_prefix = ArgSpec::new(vec![
            ArgValue::Bound(s("./foo")),
            ArgValue::Bound(s("")),
            ArgValue::Free { slot: 0 },
        ]);
        let out = run("strip_prefix", empty_prefix);
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("./foo"));

        // [B, B, B] — equality check: pass and non-match.
        let hit = ArgSpec::new(vec![
            ArgValue::Bound(s("*:./foo")),
            ArgValue::Bound(s("*:")),
            ArgValue::Bound(s("./foo")),
        ]);
        assert_eq!(run("strip_prefix", hit).rows.len(), 1);
        let check_miss = ArgSpec::new(vec![
            ArgValue::Bound(s("*:./foo")),
            ArgValue::Bound(s("*:")),
            ArgValue::Bound(s("*:./foo")),
        ]);
        assert_eq!(
            run("strip_prefix", check_miss).rows.len(),
            0,
            "output position is the REST, not the full surface"
        );
    }

    #[test]
    fn strip_prefix_free_input_is_unsupported_mode() {
        // strip_prefix(Free, B, F) — both inputs must be bound first (E-PLAN-001 names arg 0).
        let def = lookup("strip_prefix").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("*:")),
            ArgValue::Free { slot: 1 },
        ]);
        let err = def.check_mode(&spec).unwrap_err();
        assert_eq!(err.code.as_str(), "E-PLAN-001");
        assert!(err.required_bindings.contains(&0), "must name the free input");
    }

    // ── edge_attr ──────────────────────────────────────────────────

    /// Fixture: c1 -CALLS-> m1 with metadata; c2 -CALLS-> m1 without; plus a node set.
    fn edge_attr_fixture() -> FixtureStorageView {
        let mut v = FixtureStorageView::new(1);
        for (sid, ty, name) in [
            ("c1", "CALL", "kb.queryNodes"),
            ("c2", "CALL", "other.run"),
            ("m1", "METHOD", "queryNodes"),
        ] {
            v.put_node(GlueNodeRow {
                id: id_of(sid),
                node_type: ty.to_string(),
                name: name.to_string(),
                file: "a/file.js".to_string(),
            });
        }
        for src in ["c1", "c2"] {
            v.put_edge(EdgeRow {
                src: id_of(src),
                dst: id_of("m1"),
                edge_type: "CALLS".to_string(),
            });
        }
        v.put_edge_metadata(
            id_of("c1"),
            id_of("m1"),
            "CALLS",
            r#"{"via":"instance_of","line":42,"flags":[1,2],"ok":true}"#,
        );
        v
    }

    fn run_edge_attr(view: &dyn StorageView, src: &str, dst: &str, ty: &str, key: &str, val: ArgValue) -> Batch {
        let def = lookup("edge_attr").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of(src))),
            ArgValue::Bound(Value::Id(id_of(dst))),
            ArgValue::Bound(s(ty)),
            ArgValue::Bound(s(key)),
            val,
        ]);
        def.check_mode(&spec).expect("mode supported");
        let mut out = Batch::new();
        (def.eval)(view, &mut out, &spec).expect("eval ok");
        out
    }

    #[test]
    fn edge_attr_binds_string_and_number_fields() {
        let v = edge_attr_fixture();
        // String field → its value verbatim.
        let out = run_edge_attr(&v, "c1", "m1", "CALLS", "via", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("instance_of"));
        // Number field → its JSON text surface.
        let out = run_edge_attr(&v, "c1", "m1", "CALLS", "line", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("42"));
    }

    #[test]
    fn edge_attr_missing_or_nonscalar_is_no_row_never_error() {
        let v = edge_attr_fixture();
        // Missing key.
        assert_eq!(run_edge_attr(&v, "c1", "m1", "CALLS", "nope", ArgValue::Free { slot: 0 }).rows.len(), 0);
        // Non-scalar values: array and bool are NOT string/number fields.
        assert_eq!(run_edge_attr(&v, "c1", "m1", "CALLS", "flags", ArgValue::Free { slot: 0 }).rows.len(), 0);
        assert_eq!(run_edge_attr(&v, "c1", "m1", "CALLS", "ok", ArgValue::Free { slot: 0 }).rows.len(), 0);
        // Edge exists but carries no metadata.
        assert_eq!(run_edge_attr(&v, "c2", "m1", "CALLS", "via", ArgValue::Free { slot: 0 }).rows.len(), 0);
        // No such edge (wrong type / wrong endpoints).
        assert_eq!(run_edge_attr(&v, "c1", "m1", "NOPE", "via", ArgValue::Free { slot: 0 }).rows.len(), 0);
        assert_eq!(run_edge_attr(&v, "m1", "c1", "CALLS", "via", ArgValue::Free { slot: 0 }).rows.len(), 0);
    }

    #[test]
    fn edge_attr_check_mode_and_unsupported_mode() {
        let v = edge_attr_fixture();
        // [B,B,B,B,B] equality check.
        assert_eq!(
            run_edge_attr(&v, "c1", "m1", "CALLS", "via", ArgValue::Bound(s("instance_of"))).rows.len(),
            1
        );
        assert_eq!(
            run_edge_attr(&v, "c1", "m1", "CALLS", "via", ArgValue::Bound(s("unique"))).rows.len(),
            0
        );
        // A free endpoint is not a supported mode (the probe needs the bound triple).
        let def = lookup("edge_attr").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(Value::Id(id_of("m1"))),
            ArgValue::Bound(s("CALLS")),
            ArgValue::Bound(s("via")),
            ArgValue::Free { slot: 1 },
        ]);
        let err = def.check_mode(&spec).unwrap_err();
        assert_eq!(err.code.as_str(), "E-PLAN-001");
        assert!(err.required_bindings.contains(&0));
    }

    #[test]
    fn edge_attr_real_lsm_store_reads_committed_edge_metadata() {
        // Same probe over the REAL store: commit an edge carrying metadata and read the
        // field back through the snapshot-pinned keyed index (LsmStorageView).
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();
        let nodes = vec![
            node_rec("c1", "CALL", "kb.queryNodes", "a/file.js"),
            node_rec("m1", "METHOD", "queryNodes", "b/file.js"),
        ];
        let mut e = edge_rec("c1", "m1", "CALLS");
        e.metadata = r#"{"via":"instance_of","line":42}"#.to_string();
        store
            .commit_batch(
                nodes,
                vec![e],
                &["a/file.js".to_string(), "b/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();
        let view = LsmStorageView::capture(Arc::new(store), &manifest);

        let out = run_edge_attr(&view, "c1", "m1", "CALLS", "via", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("instance_of"));
        let out = run_edge_attr(&view, "c1", "m1", "CALLS", "line", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows[0][0], s("42"));
        // Missing key on the real path: no row, no error.
        assert_eq!(run_edge_attr(&view, "c1", "m1", "CALLS", "nope", ArgValue::Free { slot: 0 }).rows.len(), 0);
    }

    // ── rule-level: concat + edge_attr through the full evaluate() entry ──

    /// End-to-end (parse → stratify → plan → fixpoint): a rule joining `edge_attr` (the
    /// metadata field of a CALLS edge) with a two-step `concat` derives exactly the call
    /// whose edge carries the field — the c2 edge without metadata produces nothing.
    #[test]
    fn rule_level_concat_and_edge_attr_via_evaluate() {
        use crate::datalog::EvalLimits;
        use crate::datalog2::events::EventLog;
        use crate::datalog2::evaluate;

        let v = edge_attr_fixture();
        let src = r#"linked(C, M, S) :-
                       node(C, "CALL"),
                       edge(C, M, "CALLS"),
                       edge_attr(C, M, "CALLS", "via", V),
                       attr(C, "name", N),
                       concat(N, ":", T),
                       concat(T, V, S)."#;
        let stats = Stats { total_nodes: 3, total_edges: 2, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");

        let facts = eval.facts("linked");
        assert_eq!(facts.len(), 1, "only the metadata-carrying CALLS edge links");
        assert_eq!(facts[0][0], Value::Id(id_of("c1")));
        assert_eq!(facts[0][1], Value::Id(id_of("m1")));
        assert_eq!(
            facts[0][2],
            s("kb.queryNodes:instance_of"),
            "name ++ ':' ++ metadata-via, derived through two concat hops"
        );
    }

    // ── node_attr ──────────────────────────────────────────────────

    /// Fixture: f1 with metadata; f2 without; mirrors `edge_attr_fixture` on the node axis.
    fn node_attr_fixture() -> FixtureStorageView {
        let mut v = FixtureStorageView::new(1);
        for (sid, ty, name) in [
            ("f1", "FUNCTION", "handler"),
            ("f2", "FUNCTION", "helper"),
        ] {
            v.put_node(GlueNodeRow {
                id: id_of(sid),
                node_type: ty.to_string(),
                name: name.to_string(),
                file: "a/file.js".to_string(),
            });
        }
        v.put_node_metadata(
            id_of("f1"),
            r#"{"kind":"arrow","line":42,"flags":[1,2],"ok":true}"#,
        );
        v
    }

    fn run_node_attr(view: &dyn StorageView, id: &str, key: &str, val: ArgValue) -> Batch {
        let def = lookup("node_attr").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Bound(Value::Id(id_of(id))),
            ArgValue::Bound(s(key)),
            val,
        ]);
        def.check_mode(&spec).expect("mode supported");
        let mut out = Batch::new();
        (def.eval)(view, &mut out, &spec).expect("eval ok");
        out
    }

    #[test]
    fn node_attr_binds_string_and_number_fields() {
        let v = node_attr_fixture();
        // String field → its value verbatim.
        let out = run_node_attr(&v, "f1", "kind", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("arrow"));
        // Number field → its JSON text surface.
        let out = run_node_attr(&v, "f1", "line", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("42"));
    }

    #[test]
    fn node_attr_missing_or_nonscalar_is_no_row_never_error() {
        let v = node_attr_fixture();
        // Missing key.
        assert_eq!(run_node_attr(&v, "f1", "nope", ArgValue::Free { slot: 0 }).rows.len(), 0);
        // Non-scalar values: array and bool are NOT string/number fields.
        assert_eq!(run_node_attr(&v, "f1", "flags", ArgValue::Free { slot: 0 }).rows.len(), 0);
        assert_eq!(run_node_attr(&v, "f1", "ok", ArgValue::Free { slot: 0 }).rows.len(), 0);
        // Node exists but carries no metadata.
        assert_eq!(run_node_attr(&v, "f2", "kind", ArgValue::Free { slot: 0 }).rows.len(), 0);
        // No such node.
        assert_eq!(run_node_attr(&v, "nope", "kind", ArgValue::Free { slot: 0 }).rows.len(), 0);
    }

    #[test]
    fn node_attr_check_mode_and_unsupported_mode() {
        let v = node_attr_fixture();
        // [B,B,B] equality check.
        assert_eq!(
            run_node_attr(&v, "f1", "kind", ArgValue::Bound(s("arrow"))).rows.len(),
            1
        );
        assert_eq!(
            run_node_attr(&v, "f1", "kind", ArgValue::Bound(s("declaration"))).rows.len(),
            0
        );
        // A free id is not a supported mode (the probe needs the bound id — there is
        // deliberately NO generator mode, unlike `attr`'s [F,B,B]).
        let def = lookup("node_attr").unwrap();
        let spec = ArgSpec::new(vec![
            ArgValue::Free { slot: 0 },
            ArgValue::Bound(s("kind")),
            ArgValue::Bound(s("arrow")),
        ]);
        let err = def.check_mode(&spec).unwrap_err();
        assert_eq!(err.code.as_str(), "E-PLAN-001");
        assert!(err.required_bindings.contains(&0));
    }

    #[test]
    fn node_attr_real_lsm_store_reads_committed_node_metadata() {
        // Same probe over the REAL store: commit a node carrying metadata and read the
        // field back through the snapshot point lookup (LsmStorageView).
        let mut store = MultiShardStore::ephemeral(4);
        let mut manifest = ManifestStore::ephemeral();
        let mut n1 = node_rec("f1", "FUNCTION", "handler", "a/file.js");
        n1.metadata = r#"{"kind":"arrow","line":42}"#.to_string();
        let nodes = vec![n1, node_rec("f2", "FUNCTION", "helper", "a/file.js")];
        store
            .commit_batch(
                nodes,
                vec![],
                &["a/file.js".to_string()],
                HashMap::new(),
                &mut manifest,
            )
            .unwrap();
        let view = LsmStorageView::capture(Arc::new(store), &manifest);

        let out = run_node_attr(&view, "f1", "kind", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0][0], s("arrow"));
        let out = run_node_attr(&view, "f1", "line", ArgValue::Free { slot: 0 });
        assert_eq!(out.rows[0][0], s("42"));
        // Missing key / no metadata on the real path: no row, no error.
        assert_eq!(run_node_attr(&view, "f1", "nope", ArgValue::Free { slot: 0 }).rows.len(), 0);
        assert_eq!(run_node_attr(&view, "f2", "kind", ArgValue::Free { slot: 0 }).rows.len(), 0);
    }

    // ── rule-level: node_attr through the full evaluate() entry ──

    /// End-to-end (parse → stratify → plan → fixpoint): a rule filtering on a node's
    /// metadata field derives exactly the node carrying it — f2 (no metadata) produces
    /// nothing.
    #[test]
    fn rule_level_node_attr_via_evaluate() {
        use crate::datalog::EvalLimits;
        use crate::datalog2::events::EventLog;
        use crate::datalog2::evaluate;

        let v = node_attr_fixture();
        let src = r#"arrow_fn(F, L) :-
                       node(F, "FUNCTION"),
                       node_attr(F, "kind", "arrow"),
                       node_attr(F, "line", L)."#;
        let stats = Stats { total_nodes: 2, total_edges: 0, ..Default::default() };
        let eval = evaluate(&v, src, stats, EvalLimits::none(), EventLog::discard())
            .expect("evaluate");

        let facts = eval.facts("arrow_fn");
        assert_eq!(facts.len(), 1, "only the metadata-carrying FUNCTION derives");
        assert_eq!(facts[0][0], Value::Id(id_of("f1")));
        assert_eq!(facts[0][1], s("42"), "number field surfaces as JSON text");
    }
}
