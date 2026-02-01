//! Datalog evaluator
//!
//! Evaluates Datalog queries against a GraphEngine.

use std::collections::HashMap;
use crate::graph::{GraphStore, GraphEngine};
use crate::datalog::types::*;

/// A value in Datalog bindings
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Value {
    /// Node ID (u128)
    Id(u128),
    /// String value
    Str(String),
}

impl Value {
    /// Parse a string as an ID or keep as string
    pub fn from_term_const(s: &str) -> Self {
        if let Ok(id) = s.parse::<u128>() {
            Value::Id(id)
        } else {
            Value::Str(s.to_string())
        }
    }

    /// Get as u128 if possible
    pub fn as_id(&self) -> Option<u128> {
        match self {
            Value::Id(id) => Some(*id),
            Value::Str(s) => s.parse().ok(),
        }
    }

    /// Get as string
    pub fn as_str(&self) -> String {
        match self {
            Value::Id(id) => id.to_string(),
            Value::Str(s) => s.clone(),
        }
    }
}

/// Variable bindings
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bindings {
    map: HashMap<String, Value>,
}

impl Bindings {
    /// Create empty bindings
    pub fn new() -> Self {
        Bindings { map: HashMap::new() }
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Get a binding
    pub fn get(&self, var: &str) -> Option<&Value> {
        self.map.get(var)
    }

    /// Set a binding
    pub fn set(&mut self, var: &str, value: Value) {
        self.map.insert(var.to_string(), value);
    }

    /// Extend with another bindings, returning None if conflict
    pub fn extend(&self, other: &Bindings) -> Option<Bindings> {
        let mut result = self.clone();
        for (k, v) in &other.map {
            if let Some(existing) = result.map.get(k) {
                if existing != v {
                    return None; // Conflict
                }
            } else {
                result.map.insert(k.clone(), v.clone());
            }
        }
        Some(result)
    }

    /// Get all bindings as iterator
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.map.iter()
    }
}

/// Datalog evaluator
pub struct Evaluator<'a> {
    engine: &'a GraphEngine,
    rules: HashMap<String, Vec<Rule>>,
}

impl<'a> Evaluator<'a> {
    /// Create a new evaluator
    pub fn new(engine: &'a GraphEngine) -> Self {
        Evaluator {
            engine,
            rules: HashMap::new(),
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

    /// Query for all bindings satisfying an atom
    pub fn query(&self, goal: &Atom) -> Vec<Bindings> {
        self.eval_atom(goal)
    }

    /// Evaluate a query (conjunction of literals)
    ///
    /// Returns all bindings satisfying the conjunction.
    /// This allows queries like `node(X, "type"), attr(X, "url", U)`.
    pub fn eval_query(&self, literals: &[Literal]) -> Vec<Bindings> {
        let mut current = vec![Bindings::new()];

        for literal in literals {
            let mut next = vec![];

            for bindings in &current {
                match literal {
                    Literal::Positive(atom) => {
                        // Substitute known bindings into atom
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);

                        for result in results {
                            if let Some(merged) = bindings.extend(&result) {
                                next.push(merged);
                            }
                        }
                    }
                    Literal::Negative(atom) => {
                        // Negation: check that atom has no solutions
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);

                        if results.is_empty() {
                            // Negation succeeds - keep current bindings
                            next.push(bindings.clone());
                        }
                        // If results not empty, negation fails - drop bindings
                    }
                }
            }

            current = next;
            if current.is_empty() {
                break;
            }
        }

        current
    }

    /// Evaluate an atom (built-in or derived)
    pub fn eval_atom(&self, atom: &Atom) -> Vec<Bindings> {
        match atom.predicate() {
            "node" => self.eval_node(atom),
            "edge" => self.eval_edge(atom),
            "incoming" => self.eval_incoming(atom),
            "path" => self.eval_path(atom),
            "attr" => self.eval_attr(atom),
            "neq" => self.eval_neq(atom),
            "starts_with" => self.eval_starts_with(atom),
            "not_starts_with" => self.eval_not_starts_with(atom),
            _ => self.eval_derived(atom),
        }
    }

    /// Evaluate node(Id, Type) predicate
    fn eval_node(&self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let id_term = &args[0];
        let type_term = &args[1];

        match (id_term, type_term) {
            // node(X, "type") - find all nodes of type
            (Term::Var(var), Term::Const(node_type)) => {
                let ids = self.engine.find_by_type(node_type);
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
                if let Ok(id) = id_str.parse::<u128>() {
                    if let Some(node) = self.engine.get_node(id) {
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
                if let Ok(id) = id_str.parse::<u128>() {
                    if let Some(node) = self.engine.get_node(id) {
                        if node.node_type.as_deref() == Some(expected_type) {
                            return vec![Bindings::new()];
                        }
                    }
                }
                vec![]
            }
            // node(X, Y) - enumerate all nodes (expensive!)
            (Term::Var(id_var), Term::Var(type_var)) => {
                // Get all node types we know about
                let type_counts = self.engine.count_nodes_by_type(None);
                let mut results = vec![];

                for node_type in type_counts.keys() {
                    let ids = self.engine.find_by_type(node_type);
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
    fn eval_edge(&self, atom: &Atom) -> Vec<Bindings> {
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

                // Get edge type filter
                let edge_types: Option<Vec<&str>> = type_term.and_then(|t| match t {
                    Term::Const(s) => Some(vec![s.as_str()]),
                    _ => None,
                });

                let edges = self.engine.get_outgoing_edges(
                    src_id,
                    edge_types.as_ref().map(|v| v.as_slice()),
                );

                edges
                    .into_iter()
                    .filter_map(|e| {
                        let mut b = Bindings::new();

                        // Bind dst
                        match dst_term {
                            Term::Var(var) => b.set(var, Value::Id(e.dst)),
                            Term::Const(s) => {
                                if s.parse::<u128>().ok() != Some(e.dst) {
                                    return None;
                                }
                            }
                            Term::Wildcard => {}
                        }

                        // Bind edge type if variable
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
                let all_edges = self.engine.get_all_edges();

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

    /// Evaluate incoming(Dst, Src, Type) predicate - find edges pointing TO a node
    fn eval_incoming(&self, atom: &Atom) -> Vec<Bindings> {
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

                // Get edge type filter
                let edge_types: Option<Vec<&str>> = type_term.and_then(|t| match t {
                    Term::Const(s) => Some(vec![s.as_str()]),
                    _ => None,
                });

                let edges = self.engine.get_incoming_edges(
                    dst_id,
                    edge_types.as_ref().map(|v| v.as_slice()),
                );

                edges
                    .into_iter()
                    .filter_map(|e| {
                        let mut b = Bindings::new();

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

                        // Bind edge type if variable
                        if let Some(Term::Var(var)) = type_term {
                            if let Some(etype) = e.edge_type {
                                b.set(var, Value::Str(etype));
                            }
                        }

                        Some(b)
                    })
                    .collect()
            }
            Term::Var(_var) => {
                // Would need to enumerate all edges - expensive
                vec![]
            }
            _ => vec![],
        }
    }

    /// Evaluate attr(NodeId, AttrName, Value) predicate - access node attributes/metadata
    ///
    /// Built-in attributes: "name", "file", "type"
    /// Metadata attributes: any key from the node's metadata JSON (e.g., "object", "method")
    fn eval_attr(&self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 3 {
            return vec![];
        }

        let id_term = &args[0];
        let attr_term = &args[1];
        let value_term = &args[2];

        // Need bound node ID
        let node_id = match id_term {
            Term::Const(id_str) => match id_str.parse::<u128>() {
                Ok(id) => id,
                Err(_) => return vec![],
            },
            _ => return vec![], // Need bound ID for now
        };

        // Get the node
        let node = match self.engine.get_node(node_id) {
            Some(n) => n,
            None => return vec![],
        };

        // Get attribute name (must be constant for now)
        let attr_name = match attr_term {
            Term::Const(name) => name.as_str(),
            _ => return vec![], // Need constant attr name
        };

        // Get attribute value based on name
        let attr_value: Option<String> = match attr_name {
            "name" => node.name.clone(),
            "file" => node.file.clone(),
            "type" => node.node_type.clone(),
            // Check metadata JSON for other attributes
            _ => {
                if let Some(ref metadata_str) = node.metadata {
                    // Parse JSON and extract attribute
                    if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(metadata_str) {
                        metadata.get(attr_name).and_then(|v| {
                            match v {
                                serde_json::Value::String(s) => Some(s.clone()),
                                serde_json::Value::Number(n) => Some(n.to_string()),
                                serde_json::Value::Bool(b) => Some(b.to_string()),
                                _ => None,
                            }
                        })
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };

        // Check if attribute exists
        let attr_value = match attr_value {
            Some(v) => v,
            None => return vec![], // Attribute doesn't exist
        };

        // Match against value term
        match value_term {
            Term::Var(var) => {
                let mut b = Bindings::new();
                b.set(var, Value::Str(attr_value));
                vec![b]
            }
            Term::Const(expected) => {
                if &attr_value == expected {
                    vec![Bindings::new()] // Match succeeded
                } else {
                    vec![] // No match
                }
            }
            Term::Wildcard => {
                vec![Bindings::new()] // Wildcard always matches if attr exists
            }
        }
    }

    /// Evaluate path(Src, Dst) predicate using BFS
    fn eval_path(&self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let src_term = &args[0];
        let dst_term = &args[1];

        match (src_term, dst_term) {
            // path("src", "dst") - check if path exists
            (Term::Const(src_str), Term::Const(dst_str)) => {
                let src_id = match src_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };
                let dst_id = match dst_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                // BFS with all edge types, max depth 100
                let reachable = self.engine.bfs(&[src_id], 100, &[]);

                if reachable.contains(&dst_id) {
                    vec![Bindings::new()]
                } else {
                    vec![]
                }
            }
            // path("src", X) - find all reachable nodes
            (Term::Const(src_str), Term::Var(var)) => {
                let src_id = match src_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                let reachable = self.engine.bfs(&[src_id], 100, &[]);

                reachable
                    .into_iter()
                    .filter(|&id| id != src_id) // exclude self
                    .map(|id| {
                        let mut b = Bindings::new();
                        b.set(var, Value::Id(id));
                        b
                    })
                    .collect()
            }
            // path("src", _) - check if any path exists
            (Term::Const(src_str), Term::Wildcard) => {
                let src_id = match src_str.parse::<u128>() {
                    Ok(id) => id,
                    Err(_) => return vec![],
                };

                let reachable = self.engine.bfs(&[src_id], 100, &[]);

                // Has path if reaches anything other than self
                if reachable.iter().any(|&id| id != src_id) {
                    vec![Bindings::new()]
                } else {
                    vec![]
                }
            }
            _ => vec![],
        }
    }

    /// Evaluate neq(X, Y) - inequality constraint
    /// Both arguments must be bound (either constants or bound variables)
    fn eval_neq(&self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let left = &args[0];
        let right = &args[1];

        // Get string values from terms (both must be constants at this point)
        let left_val = match left {
            Term::Const(s) => s.as_str(),
            _ => return vec![], // Variables must be bound before neq check
        };

        let right_val = match right {
            Term::Const(s) => s.as_str(),
            _ => return vec![], // Variables must be bound before neq check
        };

        // Return success (empty bindings) if not equal, fail otherwise
        if left_val != right_val {
            vec![Bindings::new()]
        } else {
            vec![]
        }
    }

    /// Evaluate starts_with(X, Prefix) - string prefix check
    fn eval_starts_with(&self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let value = &args[0];
        let prefix = &args[1];

        let value_str = match value {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        let prefix_str = match prefix {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        if value_str.starts_with(prefix_str) {
            vec![Bindings::new()]
        } else {
            vec![]
        }
    }

    /// Evaluate not_starts_with(X, Prefix) - negative string prefix check
    fn eval_not_starts_with(&self, atom: &Atom) -> Vec<Bindings> {
        let args = atom.args();
        if args.len() < 2 {
            return vec![];
        }

        let value = &args[0];
        let prefix = &args[1];

        let value_str = match value {
            Term::Const(s) => s.as_str(),
            _ => return vec![],
        };

        let prefix_str = match prefix {
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
    fn eval_derived(&self, atom: &Atom) -> Vec<Bindings> {
        let rules = match self.rules.get(atom.predicate()) {
            Some(rules) => rules,
            None => return vec![],
        };

        let mut results = vec![];

        for rule in rules {
            // Evaluate rule body and collect bindings
            let body_results = self.eval_rule_body(rule);

            // Project bindings to head variables
            for bindings in body_results {
                if let Some(head_bindings) = self.project_to_head(rule, atom, &bindings) {
                    results.push(head_bindings);
                }
            }
        }

        results
    }

    /// Evaluate rule body and return all satisfying bindings
    fn eval_rule_body(&self, rule: &Rule) -> Vec<Bindings> {
        let mut current = vec![Bindings::new()];

        for literal in rule.body() {
            let mut next = vec![];

            for bindings in &current {
                match literal {
                    Literal::Positive(atom) => {
                        // Substitute known bindings into atom
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);

                        for result in results {
                            if let Some(merged) = bindings.extend(&result) {
                                next.push(merged);
                            }
                        }
                    }
                    Literal::Negative(atom) => {
                        // Negation: check that atom has no solutions
                        let substituted = self.substitute_atom(atom, bindings);
                        let results = self.eval_atom(&substituted);

                        if results.is_empty() {
                            // Negation succeeds - keep current bindings
                            next.push(bindings.clone());
                        }
                        // If results not empty, negation fails - drop bindings
                    }
                }
            }

            current = next;
            if current.is_empty() {
                break;
            }
        }

        current
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
                    // Check if query has a corresponding variable
                    if let Some(Term::Var(query_var)) = query.args().get(i) {
                        result.set(query_var, value.clone());
                    }
                }
            }
        }

        Some(result)
    }
}
