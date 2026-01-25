//! Datalog interpreter for ReginaFlowDB
//!
//! Provides a Datalog-like query language for expressing graph guarantees.
//!
//! # Example
//! ```ignore
//! violation(X) :- node(X, "queue:publish"), \+ path(X, _).
//! ```

mod types;
mod parser;
mod eval;
mod eval_explain;

pub use types::*;
pub use parser::*;
pub use eval::*;
pub use eval_explain::*;

#[cfg(test)]
mod tests;
