//! RFDB (ReginaFlowDB) - high-performance graph engine based on mmap
//!
//! # Architecture
//!
//! - **Columnar storage**: nodes.bin, edges.bin, strings.bin
//! - **Deterministic IDs**: BLAKE3(type|name|scope|path)
//! - **Delta-log**: In-memory change buffer
//! - **Background compaction**: Merge delta → immutable segments
//! - **Zero-copy access**: memmap2 without copying to RAM
//!
//! # Usage example
//!
//! ```no_run
//! use rfdb::{GraphEngine, GraphStore, NodeRecord, EdgeRecord};
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let mut engine = GraphEngine::create("./graph.rfdb")?;
//!
//! // Add nodes with string types
//! engine.add_nodes(vec![
//!     NodeRecord {
//!         id: 123456789,
//!         node_type: Some("FUNCTION".to_string()),
//!         file_id: 1,
//!         name_offset: 10,
//!         version: "main".into(),
//!         exported: true,
//!         replaces: None,
//!         deleted: false,
//!         name: Some("myFunction".to_string()),
//!         file: Some("src/main.js".to_string()),
//!         metadata: None,
//!         semantic_id: None,
//!     }
//! ]);
//!
//! // BFS обход
//! let endpoints = engine.bfs(&[123456789], 10, &["CALLS"]); // depth=10
//! println!("Found {} endpoints", endpoints.len());
//! # Ok(())
//! # }
//! ```

pub mod graph;
pub mod storage;
pub mod storage_v2;
pub mod error;
pub mod datalog;
pub mod database_manager;
pub mod session;
pub mod metrics;

#[cfg(feature = "napi")]
pub mod ffi;

pub use graph::{GraphStore, GraphEngine};
pub use storage::{NodeRecord, EdgeRecord, AttrQuery, FieldDecl, FieldType};
pub use error::{GraphError, Result};

// Re-export основных типов
pub use graph::{compute_node_id, string_id_to_u128};

// Re-export metrics types
pub use metrics::{Metrics, MetricsSnapshot, SLOW_QUERY_THRESHOLD_MS};

// Re-export NAPI bindings when feature is enabled
#[cfg(feature = "napi")]
pub use ffi::*;
