//! RFDB (ReginaFlowDB) - high-performance graph engine
//!
//! # Architecture
//!
//! - **V2 columnar storage**: segment-based with snapshots
//! - **Deterministic IDs**: BLAKE3(type|name|scope|path)
//! - **Datalog query engine**: declarative graph queries with recursive rules
//! - **Cypher query engine**: pull-based Volcano executor with LIMIT, COUNT, ORDER BY
//!
//! # Usage example
//!
//! ```no_run
//! use rfdb::{GraphEngineV2, GraphStore, NodeRecord, EdgeRecord};
//!
//! let mut engine = GraphEngineV2::create_ephemeral();
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
//! // BFS traversal
//! let endpoints = engine.bfs(&[123456789], 10, &["CALLS"]); // depth=10
//! println!("Found {} endpoints", endpoints.len());
//! ```

pub mod graph;
pub mod storage;
pub mod storage_v2;
pub mod error;
pub mod datalog;
pub mod cypher;
pub mod database_manager;
pub mod session;
pub mod metrics;

pub use graph::{GraphStore, GraphEngineV2};
pub use storage::{NodeRecord, EdgeRecord, AttrQuery, FieldDecl, FieldType};
pub use error::{GraphError, Result};

// Re-export основных типов
pub use graph::{compute_node_id, string_id_to_u128};

// Re-export metrics types
pub use metrics::{Metrics, MetricsSnapshot, SLOW_QUERY_THRESHOLD_MS};
