//! Core Datalog types: Term, Atom, Literal, Rule, Program

use std::collections::HashSet;

/// A term in Datalog - variable, constant, or wildcard
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Term {
    /// Variable (starts with uppercase, e.g., X, Y, Queue)
    Var(String),
    /// Constant (string literal, e.g., "queue:publish")
    Const(String),
    /// Wildcard (_) - matches anything, not captured
    Wildcard,
}

impl Term {
    /// Create a variable term
    pub fn var(name: &str) -> Self {
        Term::Var(name.to_string())
    }

    /// Create a constant term
    pub fn constant(value: &str) -> Self {
        Term::Const(value.to_string())
    }

    /// Create a wildcard term
    pub fn wildcard() -> Self {
        Term::Wildcard
    }

    /// Check if this term is a variable
    pub fn is_var(&self) -> bool {
        matches!(self, Term::Var(_))
    }

    /// Check if this term is a constant
    pub fn is_const(&self) -> bool {
        matches!(self, Term::Const(_))
    }

    /// Check if this term is a wildcard
    pub fn is_wildcard(&self) -> bool {
        matches!(self, Term::Wildcard)
    }

    /// Get variable name if this is a variable
    pub fn var_name(&self) -> Option<&str> {
        match self {
            Term::Var(name) => Some(name),
            _ => None,
        }
    }

    /// Get constant value if this is a constant
    pub fn const_value(&self) -> Option<&str> {
        match self {
            Term::Const(value) => Some(value),
            _ => None,
        }
    }
}

/// An atom (predicate with arguments)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Atom {
    predicate: String,
    args: Vec<Term>,
}

impl Atom {
    /// Create a new atom
    pub fn new(predicate: &str, args: Vec<Term>) -> Self {
        Atom {
            predicate: predicate.to_string(),
            args,
        }
    }

    /// Get predicate name
    pub fn predicate(&self) -> &str {
        &self.predicate
    }

    /// Get arguments
    pub fn args(&self) -> &[Term] {
        &self.args
    }

    /// Get arity (number of arguments)
    pub fn arity(&self) -> usize {
        self.args.len()
    }

    /// Get all variable names in this atom
    pub fn variables(&self) -> HashSet<String> {
        self.args
            .iter()
            .filter_map(|t| t.var_name().map(|s| s.to_string()))
            .collect()
    }

    /// Check if atom is ground (no variables)
    pub fn is_ground(&self) -> bool {
        self.args.iter().all(|t| !t.is_var())
    }
}

/// A literal - positive or negative atom
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Literal {
    Positive(Atom),
    Negative(Atom),
}

impl Literal {
    /// Create a positive literal
    pub fn positive(atom: Atom) -> Self {
        Literal::Positive(atom)
    }

    /// Create a negative literal
    pub fn negative(atom: Atom) -> Self {
        Literal::Negative(atom)
    }

    /// Check if positive
    pub fn is_positive(&self) -> bool {
        matches!(self, Literal::Positive(_))
    }

    /// Check if negative
    pub fn is_negative(&self) -> bool {
        matches!(self, Literal::Negative(_))
    }

    /// Get the underlying atom
    pub fn atom(&self) -> &Atom {
        match self {
            Literal::Positive(a) | Literal::Negative(a) => a,
        }
    }

    /// Get all variable names in this literal
    pub fn variables(&self) -> HashSet<String> {
        self.atom().variables()
    }
}

/// A Datalog rule: head :- body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    head: Atom,
    body: Vec<Literal>,
}

impl Rule {
    /// Create a new rule with head and body
    pub fn new(head: Atom, body: Vec<Literal>) -> Self {
        Rule { head, body }
    }

    /// Create a fact (rule with empty body)
    pub fn fact(head: Atom) -> Self {
        Rule {
            head,
            body: Vec::new(),
        }
    }

    /// Get the head atom
    pub fn head(&self) -> &Atom {
        &self.head
    }

    /// Get the body literals
    pub fn body(&self) -> &[Literal] {
        &self.body
    }

    /// Check if this is a fact (empty body)
    pub fn is_fact(&self) -> bool {
        self.body.is_empty()
    }

    /// Get all variables in the rule (head + body)
    pub fn all_variables(&self) -> HashSet<String> {
        let mut vars = self.head.variables();
        for lit in &self.body {
            vars.extend(lit.variables());
        }
        vars
    }

    /// Get variables that appear in positive body literals
    fn positive_body_variables(&self) -> HashSet<String> {
        self.body
            .iter()
            .filter(|l| l.is_positive())
            .flat_map(|l| l.variables())
            .collect()
    }

    /// Check if rule is safe (all head vars appear in positive body literals)
    /// Facts are always safe.
    pub fn is_safe(&self) -> bool {
        if self.is_fact() {
            // Facts must be ground
            return self.head.is_ground();
        }

        let head_vars = self.head.variables();
        let positive_vars = self.positive_body_variables();

        head_vars.iter().all(|v| positive_vars.contains(v))
    }
}

/// A Datalog program - collection of rules
#[derive(Clone, Debug)]
pub struct Program {
    rules: Vec<Rule>,
}

impl Program {
    /// Create a new program from rules
    pub fn new(rules: Vec<Rule>) -> Self {
        Program { rules }
    }

    /// Get all rules
    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    /// Get all predicates defined by rules (head predicates)
    pub fn defined_predicates(&self) -> HashSet<&str> {
        self.rules.iter().map(|r| r.head.predicate()).collect()
    }

    /// Get rules defining a specific predicate
    pub fn rules_for(&self, predicate: &str) -> Vec<&Rule> {
        self.rules
            .iter()
            .filter(|r| r.head.predicate() == predicate)
            .collect()
    }

    /// Check if all rules are safe
    pub fn is_safe(&self) -> bool {
        self.rules.iter().all(|r| r.is_safe())
    }
}
