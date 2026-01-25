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
}
