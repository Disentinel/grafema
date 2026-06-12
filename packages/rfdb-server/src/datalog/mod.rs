//! The Datalog **query engine** for ReginaFlowDB.
//!
//! This is the interactive, top-down engine behind `datalogQuery`, `checkGuarantee`
//! (guarantee violations + explain witnesses) and the wire datalog evaluation debug
//! path (`RFDB_DERIVE_ENGINE=off`). It is ALSO the Gate A reference oracle for the
//! derive engine (`crate::derive` — the materializing, semi-naive engine behind
//! `@materialize`); the two engines deliberately coexist: query = interactive
//! evaluation, derive = incremental fixpoint materialization.
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
mod utils;

pub use types::*;
pub use parser::*;
pub use eval::*;
pub use eval_explain::*;

#[cfg(test)]
mod tests;
