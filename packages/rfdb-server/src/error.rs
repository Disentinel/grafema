//! Error types for graph engine

use thiserror::Error;

pub type Result<T> = std::result::Result<T, GraphError>;

#[derive(Error, Debug)]
pub enum GraphError {
    #[error("Node not found: {0}")]
    NodeNotFound(u128),

    #[error("Edge not found: {src} -> {dst}")]
    EdgeNotFound { src: u128, dst: u128 },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] bincode::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Index error: {0}")]
    Index(String),

    #[error("Invalid file format: {0}")]
    InvalidFormat(String),

    #[error("Compaction error: {0}")]
    Compaction(String),

    #[error("Delta log overflow (>{0} entries)")]
    DeltaLogOverflow(usize),

    // Multi-database error variants (REG-335)
    #[error("Database '{0}' already exists")]
    DatabaseExists(String),

    #[error("Database '{0}' not found")]
    DatabaseNotFound(String),

    #[error("Database '{0}' is in use and cannot be dropped")]
    DatabaseInUse(String),

    #[error("No database selected")]
    NoDatabaseSelected,

    #[error("Operation not allowed in read-only mode")]
    ReadOnlyMode,

    #[error("Invalid database name: {0}")]
    InvalidDatabaseName(String),
}

impl GraphError {
    /// Get error code for wire protocol
    pub fn code(&self) -> &'static str {
        match self {
            GraphError::DatabaseExists(_) => "DATABASE_EXISTS",
            GraphError::DatabaseNotFound(_) => "DATABASE_NOT_FOUND",
            GraphError::DatabaseInUse(_) => "DATABASE_IN_USE",
            GraphError::NoDatabaseSelected => "NO_DATABASE_SELECTED",
            GraphError::ReadOnlyMode => "READ_ONLY_MODE",
            GraphError::InvalidDatabaseName(_) => "INVALID_DATABASE_NAME",
            _ => "INTERNAL_ERROR",
        }
    }
}
