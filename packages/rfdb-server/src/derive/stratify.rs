//! Layer 4 — stratification.
//!
//! Builds the predicate dependency graph (including storage-level `@materialize`
//! dependencies and negation edges), condenses it into strongly-connected components,
//! and orders the resulting strata. A negation edge inside an SCC is rejected with
//! `E-STRAT-001`. Invariant I3 (strata) and §4 (stratification) are enforced here.
//!
//! # What is a node in the dependency graph
//!
//! Only **derived (IDB) predicates** — those that appear as a rule *head* — are graph
//! nodes. Everything a body literal can reference falls into one of:
//!
//! - **base relations** (`node`/`type`, `edge`, `incoming`, `attr`) — views over the
//!   storage column families (§3 "base preds = views over node/edge CFs"). These are
//!   never strata; they are the EDB seed for the lowest stratum.
//! - **builtins** (`neq`, `gt`, `lt`, `gte`, `lte`, `starts_with`, `not_starts_with`,
//!   `string_contains`, `path`, `parent_function`, `resolved_import`, …) — filters /
//!   functions / generators shared with the query engine. Not strata either.
//! - **derived predicates** — head predicates of the program. These are the nodes.
//!
//! # Storage-level `@materialize` dependencies (§4, W-STRAT-001)
//!
//! `@materialize(edge_type = "T")` on a rule head `p` declares that evaluating `p`
//! writes real edges of type `"T"` back to the graph. Therefore any *other* rule whose
//! body reads `edge(_, _, "T")` (or `incoming(_, _, "T")`) transitively depends on `p`:
//! the `"T"` edges it reads do not exist until `p` has run. This is the
//! "edge(_,_,"T") depends on the rule materializing T" clause.
//!
//! When the edge *type* argument is a **variable** (`edge(_, _, Ty)`) the reader could
//! observe edges of *any* materialized type, so it conservatively depends on **all**
//! materialized predicates, and the construction records `W-STRAT-001` (placed in the
//! top stratum by the resulting ordering — it sinks below every materializer).
//!
//! `@materialize_node(node_type = "T")` has the exact NODE analog: a rule whose body
//! reads `node(X, "T")` (or `type(X, "T")`) in a program that node-materializes `"T"`
//! has the same cross-run storage feedback, so it depends on the node-materializing
//! predicate; a **variable** node type conservatively depends on all node-materialized
//! predicates (the same `W-STRAT-001`). The axes never cross: a variable edge type
//! depends only on edge materializers, a variable node type only on node materializers.
//! (Reads of a materialized node's *fields* via `attr(X, …)`/`node_attr(X, …)` are not
//! tracked — the same deliberate boundary as edge metadata reads via `edge_attr` on the
//! edge axis.)
//!
//! # Algorithm
//!
//! 1. Collect the derived-predicate set (rule heads) and the `@materialize` map
//!    (`edge_type → materializing predicate`).
//! 2. For every rule, add a dependency edge `head → q` for each body predicate `q`,
//!    where `q` is either a derived predicate it references directly, or a materialized
//!    predicate it references *indirectly* through a base `edge`/`incoming` literal.
//!    Edges are tagged [`DepKind::Negative`] when the body literal is negated (`\+`),
//!    otherwise [`DepKind::Positive`]. (Aggregation edges would also be `Negative`-class
//!    for the in-cycle check; aggregates are rejected at parse in Gate A, so only
//!    negation can produce a stratum-crossing edge here.)
//! 3. Tarjan SCC condensation.
//! 4. If any `Negative` edge has both endpoints in the same SCC ⇒ `E-STRAT-001` naming
//!    the cycle.
//! 5. Topologically order the SCCs (a predicate's stratum is strictly above the strata
//!    of everything it depends on) and emit the ordered list of strata.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::datalog::{Literal, Rule, Term};
use crate::derive::parser_ext::{Annotation, ExtProgram, Item};

/// Stable, machine-readable stratification error/warning codes (invariant I5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StratCode {
    /// A negative (or aggregating) dependency lies inside a strongly-connected
    /// component — the program is not stratifiable. Spec §4 / I3.
    NegationInCycle,
}

impl StratCode {
    /// The stable string form emitted in diagnostics and conformance manifests.
    pub fn as_str(self) -> &'static str {
        match self {
            StratCode::NegationInCycle => "E-STRAT-001",
        }
    }
}

impl std::fmt::Display for StratCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Stable warning codes surfaced during stratification (non-fatal, invariant I5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StratWarning {
    /// A body literal reads `edge`/`incoming` with a **variable** edge-type argument, so
    /// it conservatively depends on every `@materialize` predicate (§4). The reader is
    /// pushed to the top stratum by the resulting ordering.
    ConservativeMaterializeDep,
}

impl StratWarning {
    /// The stable string form emitted in diagnostics and conformance manifests.
    pub fn as_str(self) -> &'static str {
        match self {
            StratWarning::ConservativeMaterializeDep => "W-STRAT-001",
        }
    }
}

impl std::fmt::Display for StratWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A stratification rejection (invariant I5): a stable [`StratCode`] plus a
/// human-readable detail and the cycle of predicate names that triggered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StratError {
    /// Stable taxonomy code — the load-bearing, machine-checkable field.
    pub code: StratCode,
    /// One-line human detail (never the sole signal; the code is authoritative).
    pub detail: String,
    /// The predicate names forming the offending strongly-connected component, sorted
    /// for determinism. For `E-STRAT-001` this is the cycle the negation closed.
    pub cycle: Vec<String>,
}

impl std::fmt::Display for StratError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} (cycle: {}): {}",
            self.code,
            self.cycle.join(" -> "),
            self.detail
        )
    }
}

impl std::error::Error for StratError {}

/// Whether a dependency edge crosses a stratum boundary that negation/aggregation
/// requires (`Negative`) or merely orders recursion within a stratum (`Positive`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepKind {
    /// Ordinary positive dependency. May appear inside an SCC (recursion).
    Positive,
    /// Negation (`\+`) — or, in later gates, aggregation. Must NOT appear inside an SCC
    /// (§4 / I3). A `Negative` edge inside an SCC is `E-STRAT-001`.
    Negative,
}

/// One stratum: a set of mutually-recursive derived predicates evaluated together.
///
/// `index` is the evaluation order (0 = lowest, evaluated first). Negation and
/// aggregation in a stratum may only read predicates in strictly lower strata (I3); the
/// ordering guarantees this by construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stratum {
    /// Evaluation order, 0-based and ascending; lower strata evaluate first.
    pub index: usize,
    /// Derived predicates in this stratum, sorted for deterministic output (I1).
    pub predicates: Vec<String>,
}

/// The result of stratifying a program: the ordered strata plus any warnings raised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stratification {
    /// Strata in ascending evaluation order (index 0 first).
    pub strata: Vec<Stratum>,
    /// Non-fatal warnings (e.g. `W-STRAT-001` conservative materialize dependency).
    pub warnings: Vec<StratWarning>,
}

impl Stratification {
    /// The stratum index of a derived predicate, or `None` if it is not derived.
    pub fn stratum_of(&self, predicate: &str) -> Option<usize> {
        self.strata
            .iter()
            .find(|s| s.predicates.iter().any(|p| p == predicate))
            .map(|s| s.index)
    }
}

/// Base relations served directly from storage column families (§3). Never strata.
const BASE_RELATIONS: &[&str] = &["node", "type", "edge", "incoming", "attr"];

/// Builtins shared with the query engine (filters / functions / generators). Never strata.
/// Mirrors `crate::datalog::utils` placement table and `eval.rs` dispatch.
const BUILTINS: &[&str] = &[
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
    "strip_suffix",
    "last_segment",
    "first_segment",
    "replace_all",
    "path_resolve",
    "split",
    "relative_import_resolve",
    "edge_attr",
    "node_attr",
    "path",
    "parent_function",
    "resolved_import",
];

/// True iff `pred` is a base relation or a builtin (i.e. NOT a derived predicate).
fn is_extensional(pred: &str) -> bool {
    BASE_RELATIONS.contains(&pred) || BUILTINS.contains(&pred)
}

/// Extract the `@materialize(edge_type = "T")` edge type declared on an item, if any.
///
/// Gate A only consumes the `edge_type` key (binary materialization to edges, §3 / the
/// Architect's Q2 resolution). Other materialize keys round-trip without affecting
/// stratification.
fn materialized_edge_type(item: &Item) -> Option<String> {
    for ann in &item.annotations {
        if let Annotation::Materialize { pairs, .. } = ann {
            for kv in pairs {
                if kv.key == "edge_type" {
                    return Some(kv.value.clone());
                }
            }
        }
    }
    None
}

/// Extract the `@materialize_node(node_type = "T")` node type declared on an item, if
/// any — the node twin of [`materialized_edge_type`]. A rule node-materializing `"T"`
/// is a storage-level producer for any `node(X, "T")` / `type(X, "T")` reader: the `"T"`
/// nodes it writes do not exist until it has run (the same cross-run feedback as edge
/// materialization, treated with the same conservative dependency).
fn materialized_node_type(item: &Item) -> Option<String> {
    for ann in &item.annotations {
        if let Annotation::MaterializeNode { pairs, .. } = ann {
            for kv in pairs {
                if kv.key == "node_type" {
                    return Some(kv.value.clone());
                }
            }
        }
    }
    None
}

/// The edge-type argument of an `edge`/`incoming` literal, if it is the 3-arg form.
///
/// Returns:
/// - `Some(Some(t))` — a constant edge type `"t"` (third arg is a `Const`);
/// - `Some(None)` — a *variable* edge type (third arg is a `Var`/`Wildcard`); the reader
///   conservatively depends on all materialized predicates (W-STRAT-001);
/// - `None` — not an edge/incoming relation, or not the 3-arg typed form.
fn edge_type_arg(lit: &Literal) -> Option<Option<String>> {
    let atom = lit.atom();
    let pred = atom.predicate();
    if pred != "edge" && pred != "incoming" {
        return None;
    }
    match atom.args().get(2) {
        Some(Term::Const(t)) => Some(Some(t.clone())),
        // A typed literal edge-type behaves like the equivalent constant.
        Some(Term::Lit(v)) => Some(Some(v.as_str())),
        Some(Term::Var(_)) | Some(Term::Wildcard) => Some(None),
        // Fewer than 3 args (e.g. `edge(X, Y)`): no edge-type dependency.
        None => None,
    }
}

/// The node-type argument of a `node`/`type` literal, if present — the node twin of
/// [`edge_type_arg`], mirroring its contract exactly:
/// - `Some(Some(t))` — a constant node type `"t"` (second arg `Const`/`Lit`);
/// - `Some(None)` — a *variable* node type (`Var`/`Wildcard`); the reader conservatively
///   depends on all node-materialized predicates (W-STRAT-001);
/// - `None` — not a node/type relation, or the untyped 1-arg `node(X)` form (no type
///   dependency, mirroring the 2-arg `edge(X, Y)` leniency).
fn node_type_arg(lit: &Literal) -> Option<Option<String>> {
    let atom = lit.atom();
    let pred = atom.predicate();
    if pred != "node" && pred != "type" {
        return None;
    }
    match atom.args().get(1) {
        Some(Term::Const(t)) => Some(Some(t.clone())),
        Some(Term::Lit(v)) => Some(Some(v.as_str())),
        Some(Term::Var(_)) | Some(Term::Wildcard) => Some(None),
        None => None,
    }
}

/// A directed dependency edge `from -> to` with a sign.
struct DepEdge {
    from: String,
    to: String,
    kind: DepKind,
}

/// Build the predicate dependency graph from an [`ExtProgram`].
///
/// Returns `(derived_predicates, edges, warnings)`. `derived_predicates` is every rule
/// head; `edges` are head→dependency edges (positive and negative); `warnings` records
/// any `W-STRAT-001` conservative materialize dependency.
fn build_dep_graph(
    program: &ExtProgram,
) -> (BTreeSet<String>, Vec<DepEdge>, Vec<StratWarning>) {
    // Derived predicate set = all rule heads.
    let mut derived: BTreeSet<String> = BTreeSet::new();
    for item in &program.items {
        derived.insert(item.rule.head().predicate().to_string());
    }

    // @materialize map: edge_type -> set of predicates that materialize it.
    let mut materialize_map: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    // @materialize_node map: node_type -> set of predicates that node-materialize it.
    let mut node_materialize_map: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for item in &program.items {
        if let Some(ety) = materialized_edge_type(item) {
            materialize_map
                .entry(ety)
                .or_default()
                .insert(item.rule.head().predicate().to_string());
        }
        if let Some(nty) = materialized_node_type(item) {
            node_materialize_map
                .entry(nty)
                .or_default()
                .insert(item.rule.head().predicate().to_string());
        }
    }
    // All materialized predicates (for the conservative variable-type cases), per axis:
    // a variable EDGE type depends on the edge materializers, a variable NODE type on the
    // node materializers — never cross-axis.
    let all_materialized: BTreeSet<String> = materialize_map
        .values()
        .flat_map(|s| s.iter().cloned())
        .collect();
    let all_node_materialized: BTreeSet<String> = node_materialize_map
        .values()
        .flat_map(|s| s.iter().cloned())
        .collect();

    let mut edges: Vec<DepEdge> = Vec::new();
    let mut warned_conservative = false;
    let mut warnings: Vec<StratWarning> = Vec::new();

    let maps = MaterializeMaps {
        edge: &materialize_map,
        all_edge: &all_materialized,
        node: &node_materialize_map,
        all_node: &all_node_materialized,
    };
    for item in &program.items {
        let head = item.rule.head().predicate().to_string();
        add_body_deps(
            &item.rule,
            &head,
            &derived,
            &maps,
            &mut edges,
            &mut warned_conservative,
            &mut warnings,
        );
    }

    (derived, edges, warnings)
}

/// The per-program materialize producer maps, by axis (edge vs node), threaded through
/// [`add_body_deps`]: concrete-type readers depend on that type's producers; variable-
/// type readers conservatively depend on ALL producers of the same axis (W-STRAT-001).
struct MaterializeMaps<'a> {
    edge: &'a BTreeMap<String, BTreeSet<String>>,
    all_edge: &'a BTreeSet<String>,
    node: &'a BTreeMap<String, BTreeSet<String>>,
    all_node: &'a BTreeSet<String>,
}

/// Add all dependency edges contributed by one rule's body.
fn add_body_deps(
    rule: &Rule,
    head: &str,
    derived: &BTreeSet<String>,
    maps: &MaterializeMaps<'_>,
    edges: &mut Vec<DepEdge>,
    warned_conservative: &mut bool,
    warnings: &mut Vec<StratWarning>,
) {
    for lit in rule.body() {
        let kind = if lit.is_negative() {
            DepKind::Negative
        } else {
            DepKind::Positive
        };
        let body_pred = lit.atom().predicate();

        // 1. Direct dependency on a derived predicate.
        if derived.contains(body_pred) {
            edges.push(DepEdge {
                from: head.to_string(),
                to: body_pred.to_string(),
                kind,
            });
            continue;
        }

        // 2. Storage-level materialize dependency through a base literal — the same
        //    construction on both axes: `edge`/`incoming` readers vs `@materialize`
        //    producers, `node`/`type` readers vs `@materialize_node` producers.
        let type_read = edge_type_arg(lit)
            .map(|arg| (arg, maps.edge, maps.all_edge))
            .or_else(|| node_type_arg(lit).map(|arg| (arg, maps.node, maps.all_node)));
        if let Some((type_arg, producer_map, all_producers)) = type_read {
            match type_arg {
                Some(ty) => {
                    // Concrete type: depend on whoever materializes exactly that type.
                    if let Some(producers) = producer_map.get(&ty) {
                        for producer in producers {
                            edges.push(DepEdge {
                                from: head.to_string(),
                                to: producer.clone(),
                                kind,
                            });
                        }
                    }
                }
                None => {
                    // Variable type: conservatively depend on all same-axis materializers
                    // (W-STRAT-001), as long as there is at least one.
                    if !all_producers.is_empty() {
                        for producer in all_producers {
                            edges.push(DepEdge {
                                from: head.to_string(),
                                to: producer.clone(),
                                kind,
                            });
                        }
                        if !*warned_conservative {
                            *warned_conservative = true;
                            warnings.push(StratWarning::ConservativeMaterializeDep);
                        }
                    }
                }
            }
            continue;
        }

        // 3. Otherwise it is a base relation or builtin — no dependency edge.
        debug_assert!(
            is_extensional(body_pred) || derived.contains(body_pred),
            "body predicate '{body_pred}' is neither derived, materialize-linked, base, nor builtin"
        );
    }
}

/// Tarjan's strongly-connected-components, returning components in **reverse**
/// topological order (a component appears before the components it depends on — i.e.
/// dependencies-last). Each component is the set of predicate names in it.
fn tarjan_sccs(
    nodes: &BTreeSet<String>,
    edges: &[DepEdge],
) -> Vec<BTreeSet<String>> {
    // Adjacency: from -> [to] (dedup; sign ignored for SCC structure).
    let mut adj: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    for n in nodes {
        adj.entry(n.as_str()).or_default();
    }
    for e in edges {
        // Only edges between graph nodes (derived predicates) shape SCCs.
        if nodes.contains(&e.from) && nodes.contains(&e.to) {
            adj.entry(e.from.as_str()).or_default().insert(e.to.as_str());
        }
    }

    struct State<'a> {
        index: usize,
        indices: HashMap<&'a str, usize>,
        lowlink: HashMap<&'a str, usize>,
        on_stack: HashSet<&'a str>,
        stack: Vec<&'a str>,
        out: Vec<BTreeSet<String>>,
        adj: &'a HashMap<&'a str, BTreeSet<&'a str>>,
    }

    fn strongconnect<'a>(v: &'a str, st: &mut State<'a>) {
        st.indices.insert(v, st.index);
        st.lowlink.insert(v, st.index);
        st.index += 1;
        st.stack.push(v);
        st.on_stack.insert(v);

        if let Some(succs) = st.adj.get(v) {
            // Iterate over a snapshot to satisfy the borrow checker; BTreeSet → ordered.
            let succs: Vec<&'a str> = succs.iter().copied().collect();
            for w in succs {
                if !st.indices.contains_key(w) {
                    strongconnect(w, st);
                    let lw = st.lowlink[w];
                    let lv = st.lowlink[v];
                    st.lowlink.insert(v, lv.min(lw));
                } else if st.on_stack.contains(w) {
                    let iw = st.indices[w];
                    let lv = st.lowlink[v];
                    st.lowlink.insert(v, lv.min(iw));
                }
            }
        }

        if st.lowlink[v] == st.indices[v] {
            let mut comp = BTreeSet::new();
            loop {
                let w = st.stack.pop().expect("non-empty stack while popping SCC");
                st.on_stack.remove(w);
                comp.insert(w.to_string());
                if w == v {
                    break;
                }
            }
            st.out.push(comp);
        }
    }

    let mut st = State {
        index: 0,
        indices: HashMap::new(),
        lowlink: HashMap::new(),
        on_stack: HashSet::new(),
        stack: Vec::new(),
        out: Vec::new(),
        adj: &adj,
    };

    // Deterministic node iteration order (BTreeSet) → deterministic SCC numbering (I1).
    for n in nodes {
        if !st.indices.contains_key(n.as_str()) {
            strongconnect(n.as_str(), &mut st);
        }
    }

    // Tarjan emits SCCs in reverse topological order (dependencies discovered/closed
    // first). For a node u depending on v, the component of v is emitted before u's.
    st.out
}

/// Stratify a parsed derive program (§4).
///
/// Builds the predicate dependency graph (direct derived deps + storage-level
/// `@materialize` deps + negation signs), condenses strongly-connected components, and
/// rejects any negation/aggregation edge inside an SCC with [`StratCode::NegationInCycle`]
/// (`E-STRAT-001`). On success returns the strata in ascending evaluation order plus any
/// non-fatal warnings (e.g. `W-STRAT-001`).
pub fn stratify(program: &ExtProgram) -> Result<Stratification, StratError> {
    let (derived, edges, warnings) = build_dep_graph(program);

    // Trivial program with no derived predicates: nothing to evaluate.
    if derived.is_empty() {
        return Ok(Stratification {
            strata: Vec::new(),
            warnings,
        });
    }

    let sccs = tarjan_sccs(&derived, &edges);

    // Map every predicate to its SCC id (index into `sccs`).
    let mut scc_of: HashMap<&str, usize> = HashMap::new();
    for (i, comp) in sccs.iter().enumerate() {
        for p in comp {
            scc_of.insert(p.as_str(), i);
        }
    }

    // §4 / I3: a negation (or aggregation) edge inside an SCC is not stratifiable.
    for e in &edges {
        // Only edges between derived predicates can close an SCC.
        let (Some(&sf), Some(&st)) = (scc_of.get(e.from.as_str()), scc_of.get(e.to.as_str()))
        else {
            continue;
        };
        if e.kind == DepKind::Negative && sf == st {
            let mut cycle: Vec<String> = sccs[sf].iter().cloned().collect();
            cycle.sort();
            return Err(StratError {
                code: StratCode::NegationInCycle,
                detail: format!(
                    "negated dependency '{}' -> '{}' lies inside a recursive cycle; \
                     stratified negation requires the negated predicate in a strictly lower stratum",
                    e.from, e.to
                ),
                cycle,
            });
        }
    }

    // Condensation DAG: scc -> set of sccs it depends on (excluding self-loops).
    let mut cond_adj: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
    for i in 0..sccs.len() {
        cond_adj.entry(i).or_default();
    }
    for e in &edges {
        let (Some(&sf), Some(&st)) = (scc_of.get(e.from.as_str()), scc_of.get(e.to.as_str()))
        else {
            continue;
        };
        if sf != st {
            cond_adj.entry(sf).or_default().insert(st);
        }
    }

    // Assign a stratum index to each SCC = (longest dependency chain depth below it).
    // A predicate's stratum is strictly above everything it depends on (I3): an SCC's
    // level is 1 + max(level of dependencies), 0 if it depends on nothing derived.
    // Computed by memoized DFS over the (acyclic) condensation DAG.
    let mut level: HashMap<usize, usize> = HashMap::new();
    for i in 0..sccs.len() {
        compute_level(i, &cond_adj, &mut level);
    }

    // Group SCCs by level; merge SCCs sharing a level into one stratum (they are mutually
    // independent — no dependency path between them — so order within a level is free).
    let mut by_level: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    for (i, comp) in sccs.iter().enumerate() {
        let lvl = level[&i];
        let bucket = by_level.entry(lvl).or_default();
        for p in comp {
            bucket.insert(p.clone());
        }
    }

    let strata: Vec<Stratum> = by_level
        .into_iter()
        .enumerate()
        .map(|(idx, (_lvl, preds))| Stratum {
            index: idx,
            predicates: preds.into_iter().collect(),
        })
        .collect();

    Ok(Stratification { strata, warnings })
}

/// Memoized longest-path-to-a-sink depth for an SCC in the condensation DAG. The
/// condensation is acyclic by construction, so the recursion terminates.
fn compute_level(
    scc: usize,
    cond_adj: &BTreeMap<usize, BTreeSet<usize>>,
    level: &mut HashMap<usize, usize>,
) -> usize {
    if let Some(&l) = level.get(&scc) {
        return l;
    }
    let mut max_dep = 0usize;
    let mut has_dep = false;
    if let Some(deps) = cond_adj.get(&scc) {
        for &d in deps {
            has_dep = true;
            let dl = compute_level(d, cond_adj, level);
            max_dep = max_dep.max(dl);
        }
    }
    let lvl = if has_dep { max_dep + 1 } else { 0 };
    level.insert(scc, lvl);
    lvl
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::parser_ext::parse_ext_program;

    /// The stratum index that a derived predicate lands in.
    fn stratum_of(strat: &Stratification, pred: &str) -> usize {
        strat
            .stratum_of(pred)
            .unwrap_or_else(|| panic!("predicate '{pred}' not found in any stratum"))
    }

    #[test]
    fn single_nonrecursive_rule_is_one_stratum() {
        let src = r#"depends(X, Y) :- edge(X, Y, "IMPORTS_FROM")."#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 1);
        assert_eq!(strat.strata[0].predicates, vec!["depends".to_string()]);
        assert!(strat.warnings.is_empty());
    }

    #[test]
    fn base_and_builtin_predicates_are_not_strata() {
        // node/edge/attr/gt are extensional — only `violation` is a derived predicate.
        let src = r#"violation(X) :- node(X, "CALL"), edge(X, _, "CALLS"),
            attr(X, "argCount", A), gt(A, "0")."#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 1);
        assert_eq!(strat.strata[0].predicates, vec!["violation".to_string()]);
    }

    #[test]
    fn beam_state_init_only_gate_stratifies_into_two_layers() {
        // The multi-clause / derived-predicate guarantee shape (per the Gate A plan):
        // a helper predicate `handler_writes` materialized below, and a `violation` rule
        // that negates it. Stratified negation forces `violation` strictly above
        // `handler_writes` → two layers.
        let src = r#"
            handler_writes(M) :- edge(M, C, "CONTAINS"), edge(C, _, "STATE_WRITE"), node(M, "MESSAGE_TYPE").
            violation(M) :- node(M, "MESSAGE_TYPE"), edge(M, _, "INIT_ONLY"), \+ handler_writes(M).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 2, "expected two strata");
        let hw = stratum_of(&strat, "handler_writes");
        let vio = stratum_of(&strat, "violation");
        assert!(
            hw < vio,
            "handler_writes (stratum {hw}) must be strictly below violation (stratum {vio})"
        );
        assert_eq!(hw, 0);
        assert_eq!(vio, 1);
    }

    #[test]
    fn synthetic_negation_cycle_yields_e_strat_001() {
        // p depends positively on q; q depends NEGATIVELY on p → negation inside an SCC.
        let src = r#"
            p(X) :- q(X).
            q(X) :- node(X, "FUNCTION"), \+ p(X).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let err = stratify(&prog).expect_err("must reject negation-in-cycle");
        assert_eq!(err.code, StratCode::NegationInCycle);
        assert_eq!(err.code.as_str(), "E-STRAT-001");
        // The cycle names both predicates.
        assert!(err.cycle.contains(&"p".to_string()));
        assert!(err.cycle.contains(&"q".to_string()));
    }

    #[test]
    fn positive_recursion_is_allowed_in_one_stratum() {
        // Seeded recursion (reach) — positive self-dependency is fine; one stratum.
        let src = r#"
            reach(S, Y) :- edge(S, Y, "DEPENDS").
            reach(S, Z) :- reach(S, Y), edge(Y, Z, "DEPENDS").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 1);
        assert_eq!(strat.strata[0].predicates, vec!["reach".to_string()]);
    }

    #[test]
    fn materialize_edge_type_creates_storage_level_dependency() {
        // `depends` materializes DEPENDS_ON; `chain` reads edge(_, _, "DEPENDS_ON"),
        // so it depends on `depends` even though it never names it directly (§4).
        let src = r#"
            @materialize(edge_type = "DEPENDS_ON")
            depends(X, Y) :- edge(X, Y, "IMPORTS_FROM").
            chain(X, Z) :- edge(X, Y, "DEPENDS_ON"), edge(Y, Z, "DEPENDS_ON").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 2);
        let dep = stratum_of(&strat, "depends");
        let chain = stratum_of(&strat, "chain");
        assert!(
            dep < chain,
            "depends (materializer, stratum {dep}) must be below chain (reader, stratum {chain})"
        );
    }

    #[test]
    fn materialize_node_type_creates_storage_level_dependency() {
        // The NODE analog of the edge feedback: `mkissue` node-materializes ISSUE;
        // `reader` reads node(X, "ISSUE"), so it depends on `mkissue` even though it
        // never names it directly — the same cross-run storage feedback, mirrored.
        let src = r#"
            @materialize_node(node_type = "ISSUE")
            mkissue(S, N, F) :- node(C, "CALL"), attr(C, "name", N), attr(C, "file", F),
                                concat("issue::", C, S).
            reader(X) :- node(X, "ISSUE").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 2);
        let mk = stratum_of(&strat, "mkissue");
        let rd = stratum_of(&strat, "reader");
        assert!(
            mk < rd,
            "mkissue (node materializer, stratum {mk}) must be below reader (stratum {rd})"
        );
        // A reader of an UNRELATED node type takes no dependency (single stratum).
        let unrelated = r#"
            @materialize_node(node_type = "ISSUE")
            mkissue(S, N, F) :- node(C, "CALL"), attr(C, "name", N), attr(C, "file", F),
                                concat("issue::", C, S).
            other(X) :- node(X, "FUNCTION").
        "#;
        let strat2 = stratify(&parse_ext_program(unrelated).expect("parse")).expect("stratify");
        assert_eq!(strat2.strata.len(), 1, "unrelated node-type read takes no dependency");
    }

    #[test]
    fn variable_node_type_depends_on_all_node_materializers_and_warns() {
        // node(X, Ty) with a VARIABLE type → conservative dependency on every NODE
        // materializer (the same W-STRAT-001 treatment as the variable edge type).
        let src = r#"
            @materialize_node(node_type = "ISSUE")
            mkissue(S, N, F) :- node(C, "CALL"), attr(C, "name", N), attr(C, "file", F),
                                concat("issue::", C, S).
            reader(X, Ty) :- node(X, Ty).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert!(
            strat.warnings.contains(&StratWarning::ConservativeMaterializeDep),
            "variable node-type read must warn W-STRAT-001"
        );
        let mk = stratum_of(&strat, "mkissue");
        let rd = stratum_of(&strat, "reader");
        assert!(mk < rd, "reader must sink below the node materializer");
    }

    #[test]
    fn variable_edge_type_does_not_depend_on_node_materializers() {
        // The axes never cross: a variable EDGE type in a program with only NODE
        // materializers takes no conservative dependency (and vice versa).
        let src = r#"
            @materialize_node(node_type = "ISSUE")
            mkissue(S, N, F) :- node(C, "CALL"), attr(C, "name", N), attr(C, "file", F),
                                concat("issue::", C, S).
            reader(X, Y, Ty) :- edge(X, Y, Ty).
        "#;
        let strat = stratify(&parse_ext_program(src).expect("parse")).expect("stratify");
        assert_eq!(
            strat.strata.len(),
            1,
            "a variable edge-type read must not depend on node materializers"
        );
        assert!(strat.warnings.is_empty(), "no conservative dep ⇒ no W-STRAT-001");
    }

    #[test]
    fn variable_edge_type_depends_on_all_materializers_and_warns() {
        // `reader` reads edge(_, _, Ty) with a VARIABLE type → conservative dependency on
        // every materializer (W-STRAT-001).
        let src = r#"
            @materialize(edge_type = "DEPENDS_ON")
            depends(X, Y) :- edge(X, Y, "IMPORTS_FROM").
            reader(X, Y, Ty) :- edge(X, Y, Ty).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert!(
            strat.warnings.contains(&StratWarning::ConservativeMaterializeDep),
            "variable edge-type read must warn W-STRAT-001"
        );
        assert_eq!(StratWarning::ConservativeMaterializeDep.as_str(), "W-STRAT-001");
        let dep = stratum_of(&strat, "depends");
        let reader = stratum_of(&strat, "reader");
        assert!(dep < reader, "reader must sink below the materializer");
    }

    #[test]
    fn negation_through_materialize_in_cycle_yields_e_strat_001() {
        // A materialize predicate `mat` reads edge(_,_,"T") materialized by a predicate
        // that NEGATIVELY depends back on `mat` → a negation edge inside an SCC, routed
        // through the storage-level @materialize map (not a directly-named predicate).
        let src = r#"
            @materialize(edge_type = "T")
            mat(X, Y) :- node(X, "A"), edge(X, Y, "REF"), \+ other(X).
            other(X) :- edge(X, _, "T").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let err = stratify(&prog).expect_err("negation-in-cycle through @materialize");
        assert_eq!(err.code, StratCode::NegationInCycle);
        assert!(err.cycle.contains(&"mat".to_string()));
        assert!(err.cycle.contains(&"other".to_string()));
    }

    #[test]
    fn independent_predicates_share_a_stratum() {
        // Two unrelated derived predicates, neither depending on the other, both depend
        // only on base relations → same (lowest) stratum.
        let src = r#"
            a(X) :- node(X, "FUNCTION").
            b(X) :- node(X, "CLASS").
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 1);
        assert_eq!(
            strat.strata[0].predicates,
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn three_layer_negation_chain_orders_strictly() {
        // c :- \+ b ; b :- \+ a ; a :- base. Three strata, strictly ordered.
        let src = r#"
            a(X) :- node(X, "FUNCTION").
            b(X) :- node(X, "FUNCTION"), \+ a(X).
            c(X) :- node(X, "FUNCTION"), \+ b(X).
        "#;
        let prog = parse_ext_program(src).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        assert_eq!(strat.strata.len(), 3);
        assert_eq!(stratum_of(&strat, "a"), 0);
        assert_eq!(stratum_of(&strat, "b"), 1);
        assert_eq!(stratum_of(&strat, "c"), 2);
    }

    #[test]
    fn empty_program_has_no_strata() {
        let prog = parse_ext_program("").expect("parse empty");
        let strat = stratify(&prog).expect("stratify");
        assert!(strat.strata.is_empty());
    }

    #[test]
    fn strat_codes_are_stable() {
        assert_eq!(StratCode::NegationInCycle.as_str(), "E-STRAT-001");
        assert_eq!(StratWarning::ConservativeMaterializeDep.as_str(), "W-STRAT-001");
    }
}
