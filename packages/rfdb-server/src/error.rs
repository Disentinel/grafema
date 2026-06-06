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

    /// E-FMT-001 (Datalog v2, spec §6/§8.1/§I11): a derived segment carries a
    /// tag/payload whose `semiring_id` (or `lattice_id`) is not recognized by
    /// this build. Per I11 the reader MUST surface this as a typed error rather
    /// than silently defaulting — unknown id = error, never garbage.
    #[error("E-FMT-001: unknown semiring_id {0} in segment tag block")]
    UnknownSemiringId(u16),

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

    #[error("Database already in use. Lock file: {0}. If this is stale, remove the LOCK file manually.")]
    DatabaseLocked(String),

    #[error("Query timeout: {0}")]
    QueryTimeout(String),

    #[error("Query cancelled")]
    QueryCancelled,

    #[error("Query limit exceeded: {0}")]
    QueryLimitExceeded(String),

    #[error("Embedding error: {0}")]
    Embedding(String),

    /// MVCC B4: write-write conflict detected at the commit point — another
    /// commit published a newer version touching one of this commit's
    /// `changed_files` after this commit's read-snapshot. The caller must
    /// re-snapshot/recompute/retry; on bounded-retry exhaustion this surfaces
    /// as a hard error (pathological same-file contention).
    #[error("Commit conflict on file(s) {files:?}: snapshot v{snapshot_version} < last-committed v{conflicting_version}")]
    ConflictedCommit {
        files: Vec<String>,
        snapshot_version: u64,
        conflicting_version: u64,
    },
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
            GraphError::DatabaseLocked(_) => "DATABASE_LOCKED",
            GraphError::QueryTimeout(_) => "QUERY_TIMEOUT",
            GraphError::QueryCancelled => "QUERY_CANCELLED",
            GraphError::QueryLimitExceeded(_) => "QUERY_LIMIT_EXCEEDED",
            GraphError::ConflictedCommit { .. } => "COMMIT_CONFLICT",
            GraphError::UnknownSemiringId(_) => "E-FMT-001",
            _ => "INTERNAL_ERROR",
        }
    }
}
