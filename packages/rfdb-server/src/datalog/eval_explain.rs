//! Datalog evaluator with explain, statistics, and profiling support
//!
//! Enhanced evaluator that provides:
//! - Step-by-step execution tracing (explain mode)
//! - Query statistics (nodes visited, edges traversed, etc.)
//! - Execution timing (profiling)

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use serde::{Serialize, Deserialize};

use crate::graph::GraphStore;
use crate::storage::AttrQuery;
use crate::datalog::types::*;
use crate::datalog::eval::{Value, Bindings};
use super::utils::reorder_literals;
use super::eval::HASH_JOIN_THRESHOLD;

/// Statistics collected during query execution
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct QueryStats {
    /// Number of nodes visited
    pub nodes_visited: usize,
    /// Number of edges traversed
    pub edges_traversed: usize,
    /// Number of find_by_type calls
    pub find_by_type_calls: usize,
    /// Number of get_node calls
    pub get_node_calls: usize,
    /// Number of get_outgoing_edges calls
    pub outgoing_edge_calls: usize,
    /// Number of get_incoming_edges calls
    pub incoming_edge_calls: usize,
    /// Number of get_all_edges calls
    pub all_edges_calls: usize,
    /// Number of get_edges_by_type calls (indexed lookup)
    pub edges_by_type_calls: usize,
    /// Number of BFS calls
    pub bfs_calls: usize,
    /// Total results produced
    pub total_results: usize,
    /// Number of rule evaluations
    pub rule_evaluations: usize,
    /// Number of hash join operations (edge/incoming batched via edge-type index)
    pub hash_join_count: usize,
    /// Intermediate results per step
    pub intermediate_counts: Vec<usize>,
}

impl QueryStats {
    pub fn new() -> Self {
        Self::default()
    }
}

/// A single step in query execution (for explain mode)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExplainStep {
    /// Step number
    pub step: usize,
    /// What operation was performed
    pub operation: String,
    /// Predicate being evaluated
    pub predicate: String,
    /// Arguments (as strings)
    pub args: Vec<String>,
    /// Number of results from this step
    pub result_count: usize,
    /// Time taken for this step
    pub duration_us: u64,
    /// Additional details
    pub details: Option<String>,
}

/// Profiling information
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct QueryProfile {
    /// Total execution time
    pub total_duration_us: u64,
    /// Time spent in each predicate type
    pub predicate_times: HashMap<String, u64>,
    /// Time spent in rule body evaluation
    pub rule_eval_time_us: u64,
    /// Time spent in projection
    pub projection_time_us: u64,
}

/// Complete query result with explain and profiling
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryResult {
    /// The actual bindings results
    pub bindings: Vec<HashMap<String, String>>,
    /// Statistics
    pub stats: QueryStats,
    /// Execution profile
    pub profile: QueryProfile,
    /// Explain steps (only if explain=true)
    pub explain_steps: Vec<ExplainStep>,
    /// Warnings about expensive query patterns
    pub warnings: Vec<String>,
}

/// Evaluator with explain and profiling support
pub struct EvaluatorExplain<'a> {
    engine: &'a dyn GraphStore,
    rules: HashMap<String, Vec<Rule>>,
    /// Whether to collect explain steps
    explain_mode: bool,
    /// Collected statistics
    stats: QueryStats,
    /// Collected explain steps
    explain_steps: Vec<ExplainStep>,
    /// Current step counter
    step_counter: usize,
    /// Predicate timing
    predicate_times: HashMap<String, Duration>,
    /// Query start time
    query_start: Option<Instant>,
    /// Warnings about expensive query patterns
    warnings: Vec<String>,
}

impl<'a> EvaluatorExplain<'a> {
    /// Create a new evaluator
    pub fn new(engine: &'a dyn GraphStore, explain_mode: bool) -> Self {
        EvaluatorExplain {
            engine,
            rules: HashMap::new(),
            explain_mode,
            stats: QueryStats::new(),
            explain_steps: Vec::new(),
            step_counter: 0,
            predicate_times: HashMap::new(),
            query_start: None,
            warnings: Vec::new(),
        }
    }

    /// Add a rule
    pub fn add_rule(&mut self, rule: Rule) {
        let predicate = rule.head().predicate().to_string();
        self.rules.entry(predicate).or_default().push(rule);
    }

    /// Load multiple rules
    pub fn load_rules(&mut self, rules: Vec<Rule>) {
        for rule in rules {
            self.add_rule(rule);
        }
    }

    /// Query for all bindings satisfying an atom, with explain and profiling
    pub fn query(&mut self, goal: &Atom) -> QueryResult {
        self.query_start = Some(Instant::now());
        self.stats = QueryStats::new();
        self.explain_steps.clear();
        self.step_counter = 0;
        self.predicate_times.clear();
        self.warnings.clear();

        let bindings = self.eval_atom(goal);

        self.finalize_result(bindings)
    }

    /// Evaluate a conjunction of literals with explain support
    ///
    /// Reorders literals so that predicates requiring bound variables come after
    /// the predicates that provide those bindings, then evaluates left-to-right.
    /// Uses hash join optimization for edge/incoming predicates when applicable.
    pub fn eval_query(&mut self, literals: &[Literal]) -> Result<QueryResult, String> {
        let ordered = reorder_literals(literals)?;

        self.query_start = Some(Instant::now());
        self.stats = QueryStats::new();
        self.explain_steps.clear();
        self.step_counter = 0;
        self.predicate_times.clear();
        self.warnings.clear();

        let mut current = vec![Bindings::new()];
        let mut bound_vars: HashSet<String> = HashSet::new();

        for literal in &ordered {
            // Check if hash join applies for positive edge/incoming literals
            if let Literal::Positive(atom) = literal {
                if let Some(join_var) = self.should_hash_join(atom, &bound_vars, current.len()) {
                    let start = Instant::now();
                    current = match atom.predicate() {
                        "edge" => self.eval_edge_hash_join(atom, &current, &join_var),
                        "incoming" => self.eval_incoming_hash_join(atom, &current, &join_var),
                        _ => unreachable!(),
                    };
                    let duration = start.elapsed();
                    self.record_step(
                        "hash_join",
                        atom.predicate(),
                        atom.args(),
                        current.len(),
                        duration,
                        Some(format!("key_var={}, bindings_in={}", join_var, current.len())),
                    );
                    for var in atom.variables() {
                        bound_vars.insert(var);
                    }
                    if current.is_empty() {
                        break;
                    }
                    continue;
                }
            }

            // Check if hash join applies for negation edge/incoming literals
            if let Literal::Negative(atom) = literal {
                if let Some(join_var) = self.should_hash_join(atom, &bound_vars, current.len()) {
                    let start = Instant::now();
                    current = self.eval_negation_hash_join(atom, &current, &join_var);
                    let duration = start.elapsed();
                    self.record_step(
                        "hash_join_negation",
                        atom.predicate(),
                        atom.args(),
                        current.len(),
                        duration,
                        Some(format!("key_var={}", join_var)),
                    );
                    if current.is_empty() {
                        break;
                    }
                    continue;
                }
            }

            let mut next = vec![];
            for bindings in &current {
                match literal {
                    Literal::Positive(atom) => {
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);
                        for result in results {
                            if let Some(merged) = bindings.extend(&result) {
                                next.push(merged);
                            }
                        }
                    }
                    Literal::Negative(atom) => {
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);
                        if results.is_empty() {
                            next.push(bindings.clone());
                        }
                    }
                }
            }

            // Update bound_vars with variables from this literal
            for var in literal.variables() {
                bound_vars.insert(var);
            }

            current = next;
            if current.is_empty() {
                break;
            }
        }

        Ok(self.finalize_result(current))
    }

    /// Decide whether to use hash join for an edge/incoming literal.
    /// See Evaluator::should_hash_join for full documentation.
    fn should_hash_join(&self, atom: &Atom, bound_vars: &HashSet<String>, current_count: usize) -> Option<String> {
        let pred = atom.predicate();
        if pred != "edge" && pred != "incoming" {
            return None;
        }

        let args = atom.args();
        if args.len() < 3 {
            return None;
        }

        if !args[2].is_const() {
            return None;
        }

        if current_count <= HASH_JOIN_THRESHOLD {
            return None;
        }

        match &args[0] {
            Term::Var(var) if bound_vars.contains(var.as_str()) => Some(var.clone()),
            _ => None,
        }
    }

    /// Hash join for `edge(Src, Dst, "TYPE")` where Src is bound.
    /// See Evaluator::eval_edge_hash_join for full documentation.
    fn eval_edge_hash_join(&mut self, atom: &Atom, current: &[Bindings], src_var: &str) -> Vec<Bindings> {
        let args = atom.args();
        let dst_term = &args[1];
        let type_term = args.get(2);

        let edge_type = match type_term {
            Some(Term::Const(s)) => s.as_str(),
            _ => return vec![],
        };

        self.stats.edges_by_type_calls += 1;
        self.stats.hash_join_count += 1;
        let edges = self.engine.get_edges_by_type(edge_type);
        self.stats.edges_traversed += edges.len();

        let mut index: HashMap<u128, Vec<u128>> = HashMap::new();
        for e in &edges {
            index.entry(e.src).or_default().push(e.dst);
        }

        let mut results = Vec::new();
        for bindings in current {
            let src_id = match bindings.get(src_var).and_then(|v| v.as_id()) {
                Some(id) => id,
                None => continue,
            };

            if let Some(dsts) = index.get(&src_id) {
                for &dst_id in dsts {
                    if let Term::Const(expected_dst) = dst_term {
                        if expected_dst.parse::<u128>().ok() != Some(dst_id) {
                            continue;
                        }
                    }

                    let mut new_bindings = bindings.clone();

                    match dst_term {
                        Term::Var(var) => new_bindings.set(var, Value::Id(dst_id)),
                        Term::Const(_) => {}
                        Term::Wildcard => {}
                    }

                    if let Some(Term::Var(var)) = type_term {
                        new_bindings.set(var, Value::Str(edge_type.to_string()));
                    }

                    results.push(new_bindings);
                }
            }
        }

        results
    }

    /// Hash join for `incoming(Dst, Src, "TYPE")` where Dst is bound.
    /// See Evaluator::eval_incoming_hash_join for full documentation.
    fn eval_incoming_hash_join(&mut self, atom: &Atom, current: &[Bindings], dst_var: &str) -> Vec<Bindings> {
        let args = atom.args();
        let src_term = &args[1];
        let type_term = args.get(2);

        let edge_type = match type_term {
            Some(Term::Const(s)) => s.as_str(),
            _ => return vec![],
        };

        self.stats.edges_by_type_calls += 1;
        self.stats.hash_join_count += 1;
        let edges = self.engine.get_edges_by_type(edge_type);
        self.stats.edges_traversed += edges.len();

        let mut index: HashMap<u128, Vec<u128>> = HashMap::new();
        for e in &edges {
            index.entry(e.dst).or_default().push(e.src);
        }

        let mut results = Vec::new();
        for bindings in current {
            let dst_id = match bindings.get(dst_var).and_then(|v| v.as_id()) {
                Some(id) => id,
                None => continue,
            };

            if let Some(srcs) = index.get(&dst_id) {
                for &src_id in srcs {
                    if let Term::Const(expected_src) = src_term {
                        if expected_src.parse::<u128>().ok() != Some(src_id) {
                            continue;
                        }
                    }

                    let mut new_bindings = bindings.clone();

                    match src_term {
                        Term::Var(var) => new_bindings.set(var, Value::Id(src_id)),
                        Term::Const(_) => {}
                        Term::Wildcard => {}
                    }

                    if let Some(Term::Var(var)) = type_term {
                        new_bindings.set(var, Value::Str(edge_type.to_string()));
                    }

                    results.push(new_bindings);
                }
            }
        }

        results
    }

    /// Hash join for negation: `\+ edge(X, _, "TYPE")` or `\+ incoming(X, _, "TYPE")`
    /// See Evaluator::eval_negation_hash_join for full documentation.
    fn eval_negation_hash_join(&mut self, atom: &Atom, current: &[Bindings], key_var: &str) -> Vec<Bindings> {
        let args = atom.args();
        let edge_type = match args.get(2) {
            Some(Term::Const(s)) => s.as_str(),
            _ => return current.to_vec(),
        };

        self.stats.edges_by_type_calls += 1;
        self.stats.hash_join_count += 1;
        let edges = self.engine.get_edges_by_type(edge_type);
        self.stats.edges_traversed += edges.len();

        let exists: HashSet<u128> = match atom.predicate() {
            "edge" => edges.iter().map(|e| e.src).collect(),
            "incoming" => edges.iter().map(|e| e.dst).collect(),
            _ => return current.to_vec(),
        };

        current.iter()
            .filter(|bindings| {
                match bindings.get(key_var).and_then(|v| v.as_id()) {
                    Some(id) => !exists.contains(&id),
                    None => true,
                }
            })
            .cloned()
            .collect()
    }

    /// Build the final QueryResult from raw bindings
    fn finalize_result(&mut self, bindings: Vec<Bindings>) -> QueryResult {
        self.stats.total_results = bindings.len();

        let total_duration = self.query_start
            .map(|s| s.elapsed())
            .unwrap_or_default();

        let bindings_out: Vec<HashMap<String, String>> = bindings
            .into_iter()
            .map(|b| {
                b.iter()
                    .map(|(k, v)| (k.clone(), v.as_str()))
                    .collect()
            })
            .collect();

        let profile = QueryProfile {
            total_duration_us: total_duration.as_micros() as u64,
            predicate_times: self.predicate_times
                .iter()
                .map(|(k, v)| (k.clone(), v.as_micros() as u64))
                .collect(),
            rule_eval_time_us: 0, // not yet tracked per-rule
            projection_time_us: 0, // not yet tracked
        };

        QueryResult {
            bindings: bindings_out,
            stats: self.stats.clone(),
            profile,
            explain_steps: if self.explain_mode {
                self.explain_steps.clone()
            } else {
                Vec::new()
            },
            warnings: {
                let mut w = std::mem::take(&mut self.warnings);
                w.sort_unstable();
                w.dedup();
                w
            },
        }
    }

    /// Record an explain step
    fn record_step(&mut self, operation: &str, predicate: &str, args: &[Term], result_count: usize, duration: Duration, details: Option<String>) {
        if self.explain_mode {
            self.step_counter += 1;
            self.explain_steps.push(ExplainStep {
                step: self.step_counter,
                operation: operation.to_string(),
                predicate: predicate.to_string(),
                args: args.iter().map(|t| format!("{:?}", t)).collect(),
                result_count,
                duration_us: duration.as_micros() as u64,
                details,
            });
        }

        // Always track timing per predicate
        *self.predicate_times.entry(predicate.to_string()).or_default() += duration;

        // Track intermediate counts
        self.stats.intermediate_counts.push(result_count);
    }

    /// Evaluate an atom (built-in or derived)
    fn eval_atom(&mut self, atom: &Atom) -> Vec<Bindings> {
        let start = Instant::now();

        let result = match atom.predicate() {
            "node" | "type" => self.eval_node(atom),
            "edge" => self.eval_edge(atom),
            "incoming" => self.eval_incoming(atom),
            "path" => self.eval_path(atom),
            "attr" => self.eval_attr(atom),
            "neq" => self.eval_neq(atom),
            "starts_with" => self.eval_starts_with(atom),
            "not_starts_with" => self.eval_not_starts_with(atom),
            "string_contains" => self.eval_string_contains(atom),
            "parent_function" => self.eval_parent_function(atom),
            _ => self.eval_derived(atom),
        };

        let duration = start.elapsed();
        self.record_step("eval_atom", atom.predicate(), atom.args(), result.len(), duration, None);

        result
    }

    /// Evaluate node(Id, Type) predicate
    fn eval_node(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let id_term = &args[0];
        let type_term = &args[1];

        match (id_term, type_term) {
            // node(X, "type") - find all nodes of type
            (Term::Var(var), Term::Const(node_type)) => {
                self.stats.find_by_type_calls += 1;
                let ids = self.engine.find_by_type(node_type);
                self.stats.nodes_visited += ids.len();

                ids.into_iter()
                    .map(|id| {
                        let mut b = Bindings::new();
                        b.set(var, Value::Id(id));
                        b
                    })
                    .collect()
            }
            // node("id", Type) - find type of specific node
            (Term::Const(id_str), Term::Var(var)) => {
                self.stats.get_node_calls += 1;
                if let Ok(id) = id_str.parse::<u128>() {
                    if let Some(node) = self.engine.get_node(id) {
                        self.stats.nodes_visited += 1;
                        if let Some(node_type) = node.node_type {
                            let mut b = Bindings::new();
                            b.set(var, Value::Str(node_type));
                            return vec![b];
                        }
                    }
                }
                vec![]
            }
            // node("id", "type") - check if node exists with type
            (Term::Const(id_str), Term::Const(expected_type)) => {
                self.stats.get_node_calls += 1;
                if let Ok(id) = id_str.parse::<u128>() {
                    if let Some(node) = self.engine.get_node(id) {
                        self.stats.nodes_visited += 1;
                        if node.node_type.as_deref() == Some(expected_type) {
                            return vec![Bindings::new()];
                        }
                    }
                }
                vec![]
            }
            // node(X, Y) - enumerate all nodes (expensive!)
            (Term::Var(id_var), Term::Var(type_var)) => {
                self.warnings.push("Full node scan: consider binding type".to_string());
                let type_counts = self.engine.count_nodes_by_type(None);
                let mut results = vec![];

                for node_type in type_counts.keys() {
                    self.stats.find_by_type_calls += 1;
                    let ids = self.engine.find_by_type(node_type);
                    self.stats.nodes_visited += ids.len();

                    for id in ids {
                        let mut b = Bindings::new();
                        b.set(id_var, Value::Id(id));
                        b.set(type_var, Value::Str(node_type.clone()));
                        results.push(b);
                    }
                }
                results
            }
            _ => vec![],
        }
    }

    /// Evaluate edge(Src, Dst, Type) predicate
    fn eval_edge(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let src_term = &args[0];
        let dst_term = &args[1];
        let type_term = args.get(2);

        match src_term {
            Term::Const(src_str) => {
                let src_id = match src_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                let edge_types: Option<Vec<&str>> = type_term.and_then(|t| match t {
                    Term::Const(s) => Some(vec![s.as_str()]),
                    _ => None,
                });

                self.stats.outgoing_edge_calls += 1;
                let edges = self.engine.get_outgoing_edges(
                    src_id,
                    edge_types.as_ref().map(|v| v.as_slice()),
                );
                self.stats.edges_traversed += edges.len();

                edges
                    .into_iter()
                    .filter_map(|e| {
                        let mut b = Bindings::new();

                        match dst_term {
                            Term::Var(var) => b.set(var, Value::Id(e.dst)),
                            Term::Const(s) => {
                                if s.parse::<u128>().ok() != Some(e.dst) {
                                    return None;
                                }
                            }
                            Term::Wildcard => {}
                        }

                        if let Some(Term::Var(var)) = type_term {
                            if let Some(etype) = e.edge_type {
                                b.set(var, Value::Str(etype));
                            }
                        }

                        Some(b)
                    })
                    .collect()
            }
            Term::Var(src_var) => {
                // Use edge-type index when type is a constant
                let type_filter: Option<&str> = type_term.and_then(|t| match t {
                    Term::Const(s) => Some(s.as_str()),
                    _ => None,
                });

                let edges = if let Some(edge_type) = type_filter {
                    self.stats.edges_by_type_calls += 1;
                    self.engine.get_edges_by_type(edge_type)
                } else {
                    self.warnings.push("Full edge scan: consider binding source node".to_string());
                    self.stats.all_edges_calls += 1;
                    self.engine.get_all_edges()
                };
                self.stats.edges_traversed += edges.len();

                // Get destination filter if constant
                let dst_filter: Option<u128> = match dst_term {
                    Term::Const(s) => s.parse::<u128>().ok(),
                    _ => None,
                };

                edges
                    .into_iter()
                    .filter(|e| {
                        if let Some(filter_dst) = dst_filter {
                            if e.dst != filter_dst {
                                return false;
                            }
                        }
                        true
                    })
                    .map(|e| {
                        let mut b = Bindings::new();

                        // Bind source variable
                        b.set(src_var, Value::Id(e.src));

                        // Bind destination
                        if let Term::Var(var) = dst_term {
                            b.set(var, Value::Id(e.dst));
                        }

                        // Bind edge type if variable
                        if let Some(Term::Var(var)) = type_term {
                            if let Some(etype) = e.edge_type {
                                b.set(var, Value::Str(etype));
                            }
                        }

                        b
                    })
                    .collect()
            }
            _ => vec![],
        }
    }

    /// Evaluate incoming(Dst, Src, Type) predicate
    fn eval_incoming(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let dst_term = &args[0];
        let src_term = &args[1];
        let type_term = args.get(2);

        match dst_term {
            Term::Const(dst_str) => {
                let dst_id = match dst_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                let edge_types: Option<Vec<&str>> = type_term.and_then(|t| match t {
                    Term::Const(s) => Some(vec![s.as_str()]),
                    _ => None,
                });

                self.stats.incoming_edge_calls += 1;
                let edges = self.engine.get_incoming_edges(
                    dst_id,
                    edge_types.as_ref().map(|v| v.as_slice()),
                );
                self.stats.edges_traversed += edges.len();

                edges
                    .into_iter()
                    .filter_map(|e| {
                        let mut b = Bindings::new();

                        match src_term {
                            Term::Var(var) => b.set(var, Value::Id(e.src)),
                            Term::Const(s) => {
                                if s.parse::<u128>().ok() != Some(e.src) {
                                    return None;
                                }
                            }
                            Term::Wildcard => {}
                        }

                        if let Some(Term::Var(var)) = type_term {
                            if let Some(etype) = e.edge_type {
                                b.set(var, Value::Str(etype));
                            }
                        }

                        Some(b)
                    })
                    .collect()
            }
            Term::Var(dst_var) => {
                // Use edge-type index when type is a constant
                let type_filter: Option<&str> = type_term.and_then(|t| match t {
                    Term::Const(s) => Some(s.as_str()),
                    _ => None,
                });

                let edges = if let Some(edge_type) = type_filter {
                    self.stats.edges_by_type_calls += 1;
                    self.engine.get_edges_by_type(edge_type)
                } else {
                    return vec![];
                };
                self.stats.edges_traversed += edges.len();

                edges
                    .into_iter()
                    .filter_map(|e| {
                        let mut b = Bindings::new();

                        // Bind dst variable
                        b.set(dst_var, Value::Id(e.dst));

                        // Bind src
                        match src_term {
                            Term::Var(var) => b.set(var, Value::Id(e.src)),
                            Term::Const(s) => {
                                if s.parse::<u128>().ok() != Some(e.src) {
                                    return None;
                                }
                            }
                            Term::Wildcard => {}
                        }

                        if let Some(Term::Var(var)) = type_term {
                            if let Some(etype) = e.edge_type {
                                b.set(var, Value::Str(etype));
                            }
                        }

                        Some(b)
                    })
                    .collect()
            }
            _ => vec![],
        }
    }

    /// Evaluate attr(NodeId, AttrName, Value) predicate
    fn eval_attr(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 3 {
            return vec![];
        }

        let id_term = &args[0];
        let attr_term = &args[1];
        let value_term = &args[2];

        // Reverse lookup: attr(X, "name", "foo") — X unbound, attr name and value both constant
        if let (Term::Var(id_var), Term::Const(attr_name), Term::Const(expected_value)) =
            (id_term, attr_term, value_term)
        {
            self.stats.find_by_type_calls += 1;
            let query = Self::attr_to_query(attr_name, expected_value);
            let ids = self.engine.find_by_attr(&query);
            self.stats.nodes_visited += ids.len();
            return ids
                .into_iter()
                .map(|id| {
                    let mut b = Bindings::new();
                    b.set(id_var, Value::Id(id));
                    b
                })
                .collect();
        }

        // Forward lookup: need bound node ID
        let node_id = match id_term {
            Term::Const(id_str) => match id_str.parse::<u128>() {
                Ok(id) => id,
                Err(_) => return vec![],
            },
            _ => return vec![],
        };

        self.stats.get_node_calls += 1;
        let node = match self.engine.get_node(node_id) {
            Some(n) => n,
            None => return vec![],
        };
        self.stats.nodes_visited += 1;

        let attr_name = match attr_term {
            Term::Const(name) => name.as_str(),
            _ => return vec![],
        };

        let attr_value: Option<String> = match attr_name {
            "name" => node.name.clone(),
            "file" => node.file.clone(),
            "type" => node.node_type.clone(),
            // Metadata JSON attributes (supports nested paths like "config.port")
            _ => {
                if let Some(ref metadata_str) = node.metadata {
                    if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(metadata_str) {
                        crate::datalog::utils::get_metadata_value(&metadata, attr_name)
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };

        let attr_value = match attr_value {
            Some(v) => v,
            None => return vec![],
        };

        match value_term {
            Term::Var(var) => {
                let mut b = Bindings::new();
                b.set(var, Value::Str(attr_value));
                vec![b]
            }
            Term::Const(expected) => {
                if &attr_value == expected {
                    vec![Bindings::new()]
                } else {
                    vec![]
                }
            }
            Term::Wildcard => {
                vec![Bindings::new()]
            }
        }
    }

    /// Build an AttrQuery from a Datalog attribute name and value.
    fn attr_to_query(attr_name: &str, value: &str) -> AttrQuery {
        let mut query = AttrQuery::default();
        match attr_name {
            "name" => query.name = Some(value.to_string()),
            "file" => query.file = Some(value.to_string()),
            "type" => query.node_type = Some(value.to_string()),
            _ => query.metadata_filters = vec![(attr_name.to_string(), value.to_string())],
        }
        query
    }

    /// Evaluate path(Src, Dst) predicate using BFS
    fn eval_path(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let src_term = &args[0];
        let dst_term = &args[1];

        match (src_term, dst_term) {
            (Term::Const(src_str), Term::Const(dst_str)) => {
                let src_id = match src_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };
                let dst_id = match dst_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                self.stats.bfs_calls += 1;
                let reachable = self.engine.bfs(&[src_id], 100, &[]);
                self.stats.nodes_visited += reachable.len();

                if reachable.contains(&dst_id) {
                    vec![Bindings::new()]
                } else {
                    vec![]
                }
            }
            (Term::Const(src_str), Term::Var(var)) => {
                let src_id = match src_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                self.stats.bfs_calls += 1;
                let reachable = self.engine.bfs(&[src_id], 100, &[]);
                self.stats.nodes_visited += reachable.len();

                reachable
                    .into_iter()
                    .filter(|&id| id != src_id)
                    .map(|id| {
                        let mut b = Bindings::new();
                        b.set(var, Value::Id(id));
                        b
                    })
                    .collect()
            }
            (Term::Const(src_str), Term::Wildcard) => {
                let src_id = match src_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                self.stats.bfs_calls += 1;
                let reachable = self.engine.bfs(&[src_id], 100, &[]);
                self.stats.nodes_visited += reachable.len();

                if reachable.iter().any(|&id| id != src_id) {
                    vec![Bindings::new()]
                } else {
                    vec![]
                }
            }
            _ => vec![],
        }
    }

    /// Evaluate neq(X, Y)
    fn eval_neq(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let left_val = match &args[0] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        let right_val = match &args[1] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        if left_val != right_val {
            vec![Bindings::new()]
        } else {
            vec![]
        }
    }

    /// Evaluate starts_with(X, Prefix)
    fn eval_starts_with(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let value_str = match &args[0] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        let prefix_str = match &args[1] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        if value_str.starts_with(prefix_str) {
            vec![Bindings::new()]
        } else {
            vec![]
        }
    }

    /// Evaluate not_starts_with(X, Prefix)
    fn eval_not_starts_with(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let value_str = match &args[0] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        let prefix_str = match &args[1] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        if !value_str.starts_with(prefix_str) {
            vec![Bindings::new()]
        } else {
            vec![]
        }
    }

    /// Evaluate string_contains(Value, Substring)
    fn eval_string_contains(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let value_str = match &args[0] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        let substring_str = match &args[1] {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        if value_str.contains(substring_str) {
            vec![Bindings::new()]
        } else {
            vec![]
        }
    }

    /// Evaluate parent_function(NodeId, FunctionId) predicate.
    ///
    /// Mirror of Evaluator::eval_parent_function with stat tracking.
    /// See eval.rs for full documentation.
    fn eval_parent_function(&mut self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let node_id = match &args[0] {
            Term::Const(id_str) => match id_str.parse::<u128>() {
                Ok(id) => id,
                Err(_) => return vec![],
            },
            _ => return vec![],
        };

        let fn_term = &args[1];

        const FUNCTION_TYPES: &[&str] = &["FUNCTION", "METHOD"];
        const STOP_TYPES: &[&str] = &["FUNCTION", "METHOD", "MODULE", "CLASS"];
        const TRAVERSAL_TYPES: &[&str] = &["CONTAINS", "HAS_SCOPE", "DECLARES"];
        const MAX_DEPTH: usize = 20;

        // PARAMETER special case
        self.stats.get_node_calls += 1;
        if let Some(input_node) = self.engine.get_node(node_id) {
            self.stats.nodes_visited += 1;
            if input_node.node_type.as_deref() == Some("PARAMETER") {
                self.stats.incoming_edge_calls += 1;
                let param_edges = self.engine.get_incoming_edges(node_id, Some(&["HAS_PARAMETER"]));
                self.stats.edges_traversed += param_edges.len();
                for edge in param_edges {
                    let parent_id = edge.src;
                    self.stats.get_node_calls += 1;
                    if let Some(parent_node) = self.engine.get_node(parent_id) {
                        self.stats.nodes_visited += 1;
                        let parent_type = parent_node.node_type.as_deref().unwrap_or("");
                        if FUNCTION_TYPES.contains(&parent_type) {
                            return Self::match_fn_term(fn_term, parent_id);
                        }
                    }
                }
                return vec![];
            }
        } else {
            return vec![];
        }

        // BFS
        self.stats.bfs_calls += 1;
        let mut visited = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back((node_id, 0usize));

        while let Some((current_id, depth)) = queue.pop_front() {
            if depth > MAX_DEPTH || !visited.insert(current_id) {
                continue;
            }

            self.stats.incoming_edge_calls += 1;
            let edges = self.engine.get_incoming_edges(current_id, Some(TRAVERSAL_TYPES));
            self.stats.edges_traversed += edges.len();

            for edge in edges {
                let parent_id = edge.src;
                if visited.contains(&parent_id) {
                    continue;
                }

                self.stats.get_node_calls += 1;
                if let Some(parent_node) = self.engine.get_node(parent_id) {
                    self.stats.nodes_visited += 1;
                    let parent_type = parent_node.node_type.as_deref().unwrap_or("");

                    if FUNCTION_TYPES.contains(&parent_type) {
                        return Self::match_fn_term(fn_term, parent_id);
                    } else if STOP_TYPES.contains(&parent_type) {
                        return vec![];
                    } else {
                        queue.push_back((parent_id, depth + 1));
                    }
                }
            }
        }

        vec![]
    }

    /// Match the FunctionId term against a found parent function ID.
    fn match_fn_term(fn_term: &Term, parent_id: u128) -> Vec<Bindings> {
        match fn_term {
            Term::Var(var) => {
                let mut b = Bindings::new();
                b.set(var, Value::Id(parent_id));
                vec![b]
            }
            Term::Const(expected) => {
                if expected.parse::<u128>().ok() == Some(parent_id) {
                    vec![Bindings::new()]
                } else {
                    vec![]
                }
            }
            Term::Wildcard => vec![Bindings::new()],
        }
    }

    /// Evaluate a derived predicate (user-defined rule)
    fn eval_derived(&mut self, atom: &Atom) -> Vec<Bindings> {
        let rules = match self.rules.get(atom.predicate()) {
            Some(rules) => rules.clone(),
            None => return vec![],
        };

        let mut results = vec![];

        for rule in &rules {
            self.stats.rule_evaluations += 1;

            // Push down bound args from query into rule body.
            let initial = self.bind_from_query(&rule, atom);

            let body_results = match self.eval_rule_body_with(&rule, initial) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("datalog eval_derived: reorder error for rule {:?}: {}", rule, e);
                    continue;
                }
            };

            for bindings in body_results {
                if let Some(head_bindings) = self.project_to_head(&rule, atom, &bindings) {
                    results.push(head_bindings);
                }
            }
        }

        results
    }

    /// Map bound arguments from the query atom into rule head variables.
    fn bind_from_query(&self, rule: &Rule, query: &Atom) -> Bindings {
        let head = rule.head();
        let mut bindings = Bindings::new();

        for (i, head_term) in head.args().iter().enumerate() {
            if let Term::Var(var) = head_term {
                if let Some(Term::Const(value)) = query.args().get(i) {
                    bindings.set(var, Value::from_term_const(value));
                }
            }
        }

        bindings
    }

    /// Evaluate rule body with initial bindings.
    ///
    /// Reorders body literals before evaluation to ensure correct variable binding order.
    /// Uses hash join optimization for edge/incoming predicates when applicable.
    fn eval_rule_body_with(&mut self, rule: &Rule, initial: Bindings) -> Result<Vec<Bindings>, String> {
        let ordered = reorder_literals(rule.body())?;
        let mut current = vec![initial];
        let mut bound_vars: HashSet<String> = HashSet::new();

        for literal in &ordered {
            // Check if hash join applies for positive edge/incoming literals
            if let Literal::Positive(atom) = literal {
                if let Some(join_var) = self.should_hash_join(atom, &bound_vars, current.len()) {
                    let start = Instant::now();
                    current = match atom.predicate() {
                        "edge" => self.eval_edge_hash_join(atom, &current, &join_var),
                        "incoming" => self.eval_incoming_hash_join(atom, &current, &join_var),
                        _ => unreachable!(),
                    };
                    let duration = start.elapsed();
                    self.record_step(
                        "hash_join",
                        atom.predicate(),
                        atom.args(),
                        current.len(),
                        duration,
                        Some(format!("key_var={}", join_var)),
                    );
                    for var in atom.variables() {
                        bound_vars.insert(var);
                    }
                    if current.is_empty() {
                        break;
                    }
                    continue;
                }
            }

            // Check if hash join applies for negation edge/incoming literals
            if let Literal::Negative(atom) = literal {
                if let Some(join_var) = self.should_hash_join(atom, &bound_vars, current.len()) {
                    let start = Instant::now();
                    current = self.eval_negation_hash_join(atom, &current, &join_var);
                    let duration = start.elapsed();
                    self.record_step(
                        "hash_join_negation",
                        atom.predicate(),
                        atom.args(),
                        current.len(),
                        duration,
                        Some(format!("key_var={}", join_var)),
                    );
                    if current.is_empty() {
                        break;
                    }
                    continue;
                }
            }

            let mut next = vec![];

            for bindings in &current {
                match literal {
                    Literal::Positive(atom) => {
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);

                        for result in results {
                            if let Some(merged) = bindings.extend(&result) {
                                next.push(merged);
                            }
                        }
                    }
                    Literal::Negative(atom) => {
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);

                        if results.is_empty() {
                            next.push(bindings.clone());
                        }
                    }
                }
            }

            for var in literal.variables() {
                bound_vars.insert(var);
            }

            current = next;
            if current.is_empty() {
                break;
            }
        }

        Ok(current)
    }

    /// Substitute known bindings into an atom
    fn substitute_atom(&self, atom: &Atom, bindings: &Bindings) -> Atom {
        let new_args: Vec<Term> = atom
            .args()
            .iter()
            .map(|term| match term {
                Term::Var(var) => {
                    if let Some(value) = bindings.get(var) {
                        Term::Const(value.as_str())
                    } else {
                        term.clone()
                    }
                }
                _ => term.clone(),
            })
            .collect();

        Atom::new(atom.predicate(), new_args)
    }

    /// Project body bindings to head atom pattern
    fn project_to_head(&self, rule: &Rule, query: &Atom, bindings: &Bindings) -> Option<Bindings> {
        let head = rule.head();
        let mut result = Bindings::new();

        for (i, term) in head.args().iter().enumerate() {
            if let Term::Var(var) = term {
                if let Some(value) = bindings.get(var) {
                    if let Some(Term::Var(query_var)) = query.args().get(i) {
                        result.set(query_var, value.clone());
                    }
                }
            }
        }

        Some(result)
    }
}
