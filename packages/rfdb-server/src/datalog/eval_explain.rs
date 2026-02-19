//! Datalog evaluator with explain, statistics, and profiling support
//!
//! Enhanced evaluator that provides:
//! - Step-by-step execution tracing (explain mode)
//! - Query statistics (nodes visited, edges traversed, etc.)
//! - Execution timing (profiling)

use std::collections::HashMap;
use std::time::{Duration, Instant};
use serde::{Serialize, Deserialize};

use crate::graph::GraphStore;
use crate::datalog::types::*;
use crate::datalog::eval::{Value, Bindings};
use super::utils::reorder_literals;

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
    /// Number of BFS calls
    pub bfs_calls: usize,
    /// Total results produced
    pub total_results: usize,
    /// Number of rule evaluations
    pub rule_evaluations: usize,
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

        let bindings = self.eval_atom(goal);

        self.finalize_result(bindings)
    }

    /// Evaluate a conjunction of literals with explain support
    ///
    /// Reorders literals so that predicates requiring bound variables come after
    /// the predicates that provide those bindings, then evaluates left-to-right.
    pub fn eval_query(&mut self, literals: &[Literal]) -> Result<QueryResult, String> {
        let ordered = reorder_literals(literals)?;

        self.query_start = Some(Instant::now());
        self.stats = QueryStats::new();
        self.explain_steps.clear();
        self.step_counter = 0;
        self.predicate_times.clear();

        let mut current = vec![Bindings::new()];
        for literal in &ordered {
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
            current = next;
            if current.is_empty() {
                break;
            }
        }

        Ok(self.finalize_result(current))
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
                // Enumerate all edges when source is unbound
                self.stats.all_edges_calls += 1;
                let all_edges = self.engine.get_all_edges();
                self.stats.edges_traversed += all_edges.len();

                // Get edge type filter if constant
                let type_filter: Option<&str> = type_term.and_then(|t| match t {
                    Term::Const(s) => Some(s.as_str()),
                    _ => None,
                });

                // Get destination filter if constant
                let dst_filter: Option<u128> = match dst_term {
                    Term::Const(s) => s.parse::<u128>().ok(),
                    _ => None,
                };

                all_edges
                    .into_iter()
                    .filter(|e| {
                        // Filter by edge type if specified
                        if let Some(filter_type) = type_filter {
                            if e.edge_type.as_deref() != Some(filter_type) {
                                return false;
                            }
                        }
                        // Filter by destination if specified
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
            Term::Var(_var) => vec![],
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

    /// Evaluate a derived predicate (user-defined rule)
    fn eval_derived(&mut self, atom: &Atom) -> Vec<Bindings> {
        let rules = match self.rules.get(atom.predicate()) {
            Some(rules) => rules.clone(),
            None => return vec![],
        };

        let mut results = vec![];

        for rule in &rules {
            self.stats.rule_evaluations += 1;
            let body_results = match self.eval_rule_body(rule) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("datalog eval_derived: reorder error for rule {:?}: {}", rule, e);
                    continue;
                }
            };

            for bindings in body_results {
                if let Some(head_bindings) = self.project_to_head(rule, atom, &bindings) {
                    results.push(head_bindings);
                }
            }
        }

        results
    }

    /// Evaluate rule body
    ///
    /// Reorders body literals before evaluation to ensure correct variable binding order.
    fn eval_rule_body(&mut self, rule: &Rule) -> Result<Vec<Bindings>, String> {
        let ordered = reorder_literals(rule.body())?;
        let mut current = vec![Bindings::new()];

        for literal in &ordered {
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
