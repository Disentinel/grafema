//! Native Cypher query engine for RFDB
//!
//! Provides a Cypher-like query language with pull-based Volcano execution.
//! Cypher complements Datalog for interactive queries: LIMIT stops the pipeline
//! after k results (O(k) not O(N)), COUNT is supported, ORDER BY sorts results.

mod ast;
mod parser;
mod values;
mod executor;
mod planner;

pub use ast::*;
pub use parser::{parse_cypher, ParseError};
pub use values::{CypherValue, Record};
pub use executor::{Operator, eval_expr};
pub use planner::plan;

use crate::graph::GraphStore;
use crate::datalog::EvalLimits;

/// Execute a Cypher query against a graph store.
///
/// Parses the query, builds an operator tree, and pulls results.
/// Returns columns and rows in tabular format.
pub fn execute(
    engine: &dyn GraphStore,
    query_str: &str,
    limits: EvalLimits,
) -> Result<CypherResult, CypherError> {
    let query = parse_cypher(query_str)?;
    let mut op = plan(&query, engine, &limits)?;

    let columns = query
        .return_clause
        .items
        .iter()
        .map(|item| {
            item.alias
                .clone()
                .unwrap_or_else(|| format_expr(&item.expr))
        })
        .collect::<Vec<_>>();

    let mut rows = Vec::new();
    while let Some(record) = op.next()? {
        let row: Vec<serde_json::Value> = columns
            .iter()
            .map(|col| {
                record
                    .get(col)
                    .map(|v| v.to_json())
                    .unwrap_or(serde_json::Value::Null)
            })
            .collect();
        rows.push(row);
    }

    let row_count = rows.len();
    Ok(CypherResult {
        columns,
        rows,
        row_count,
    })
}

/// Format an expression for use as a column name.
///
/// Must produce the same strings as the planner's `split_return_items`
/// generates for aggregate aliases (when no explicit AS alias is given).
fn format_expr(expr: &Expr) -> String {
    match expr {
        Expr::Property(var, prop) => format!("{}.{}", var, prop),
        Expr::Variable(v) => v.clone(),
        Expr::FunctionCall(name, args) => {
            let arg_str = if args.is_empty() {
                "*".to_string()
            } else {
                format_expr(args.first().unwrap())
            };
            format!("{}({})", name, arg_str)
        }
        Expr::Star => "*".to_string(),
        _ => "?".to_string(),
    }
}

/// Result of a Cypher query execution.
#[derive(Debug, serde::Serialize)]
pub struct CypherResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    #[serde(rename = "rowCount")]
    pub row_count: usize,
}

/// Cypher engine error type.
#[derive(Debug)]
pub enum CypherError {
    Parse(parser::ParseError),
    Plan(String),
    Execution(String),
    Timeout,
    Cancelled,
}

impl std::fmt::Display for CypherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CypherError::Parse(e) => write!(f, "Parse error: {}", e),
            CypherError::Plan(e) => write!(f, "Plan error: {}", e),
            CypherError::Execution(e) => write!(f, "Execution error: {}", e),
            CypherError::Timeout => write!(f, "Query timed out"),
            CypherError::Cancelled => write!(f, "Query cancelled"),
        }
    }
}

impl std::error::Error for CypherError {}

impl From<parser::ParseError> for CypherError {
    fn from(e: parser::ParseError) -> Self {
        CypherError::Parse(e)
    }
}

#[cfg(test)]
mod tests;
