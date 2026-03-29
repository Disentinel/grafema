//! Cypher AST types
//!
//! Represents parsed Cypher queries. Supports a subset of Cypher:
//! MATCH with node/relationship patterns, WHERE filters, RETURN with
//! aggregation, ORDER BY, and LIMIT.

/// A complete Cypher query.
#[derive(Debug, Clone, PartialEq)]
pub struct CypherQuery {
    pub match_clause: MatchClause,
    pub where_clause: Option<Expr>,
    pub return_clause: ReturnClause,
    pub order_by: Option<Vec<(Expr, SortDir)>>,
    pub limit: Option<u64>,
}

/// MATCH clause: a chain of node/relationship patterns.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchClause {
    pub pattern: PatternChain,
}

/// A chain of alternating node and relationship patterns.
/// e.g., (a:FUNCTION)-[:CALLS]->(b:FUNCTION)
#[derive(Debug, Clone, PartialEq)]
pub struct PatternChain {
    /// First node pattern
    pub start: NodePattern,
    /// Alternating (relationship, node) pairs
    pub segments: Vec<(RelPattern, NodePattern)>,
}

/// A node pattern: (variable:Label {prop: value})
#[derive(Debug, Clone, PartialEq)]
pub struct NodePattern {
    pub variable: Option<String>,
    pub labels: Vec<String>,
    pub properties: Vec<(String, Expr)>,
}

/// A relationship pattern: -[:TYPE]-> or <-[:TYPE]- or -[:TYPE]-
#[derive(Debug, Clone, PartialEq)]
pub struct RelPattern {
    pub variable: Option<String>,
    pub rel_types: Vec<String>,
    pub direction: Direction,
    /// Variable-length path: *min..max
    pub length: Option<(u32, u32)>,
}

/// Relationship direction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    Outgoing, // ->
    Incoming, // <-
    Both,     // --
}

/// RETURN clause items.
#[derive(Debug, Clone, PartialEq)]
pub struct ReturnClause {
    pub items: Vec<ReturnItem>,
}

/// A single RETURN expression with optional alias.
#[derive(Debug, Clone, PartialEq)]
pub struct ReturnItem {
    pub expr: Expr,
    pub alias: Option<String>,
}

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SortDir {
    Asc,
    Desc,
}

/// Expression AST node.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// Property access: n.name
    Property(String, String),
    /// Literal value
    Literal(CypherLiteral),
    /// Binary comparison: =, <>, <, >, <=, >=
    BinaryOp(Box<Expr>, BinOp, Box<Expr>),
    /// Logical AND
    And(Box<Expr>, Box<Expr>),
    /// Logical OR
    Or(Box<Expr>, Box<Expr>),
    /// Logical NOT
    Not(Box<Expr>),
    /// String CONTAINS
    Contains(Box<Expr>, Box<Expr>),
    /// String STARTS WITH
    StartsWith(Box<Expr>, Box<Expr>),
    /// String ENDS WITH
    EndsWith(Box<Expr>, Box<Expr>),
    /// Function call: COUNT(x), COUNT(*)
    FunctionCall(String, Vec<Expr>),
    /// Variable reference
    Variable(String),
    /// Star (for COUNT(*))
    Star,
    /// IS NULL
    IsNull(Box<Expr>),
    /// IS NOT NULL
    IsNotNull(Box<Expr>),
}

/// Binary operator.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinOp {
    Eq,  // =
    Neq, // <>
    Lt,  // <
    Gt,  // >
    Lte, // <=
    Gte, // >=
}

/// Literal value in expressions.
#[derive(Debug, Clone, PartialEq)]
pub enum CypherLiteral {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Null,
}
