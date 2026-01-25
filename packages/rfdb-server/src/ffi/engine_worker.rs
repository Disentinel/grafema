//! Engine Worker - single-threaded command processor for GraphEngine
//!
//! This module provides thread-safe access to GraphEngine through a channel-based
//! command pattern. All mutations go through a single worker thread, eliminating
//! race conditions.
//!
//! Architecture:
//! ```text
//! JS Thread(s)          Channel              Worker Thread
//!     │                    │                      │
//!     ├─ addEdges() ──────►│ Command::AddEdges ──►│ engine.add_edges()
//!     ├─ addNodes() ──────►│ Command::AddNodes ──►│ engine.add_nodes()
//!     ├─ flush() ─────────►│ Command::Flush ─────►│ engine.flush()
//!     │◄──────────────────│ Response ◄───────────│
//! ```

use std::path::PathBuf;
use std::thread::{self, JoinHandle};
use crossbeam_channel::{unbounded, Sender, Receiver};

use crate::graph::GraphEngine as RustGraphEngine;
use crate::graph::GraphStore;
use crate::storage::{NodeRecord, EdgeRecord, AttrQuery};
use crate::error::{Result, GraphError};
use crate::datalog::{QueryResult, parse_program, parse_atom, EvaluatorExplain};

/// Commands that can be sent to the engine worker
pub enum Command {
    // Write operations (blocking - wait for acknowledgment)
    AddNodes {
        nodes: Vec<NodeRecord>,
        response_tx: Sender<()>,
    },
    AddEdges {
        edges: Vec<EdgeRecord>,
        skip_validation: bool,
        response_tx: Sender<()>,
    },
    DeleteNode {
        id: u128,
        response_tx: Sender<()>,
    },
    DeleteEdge {
        src: u128,
        dst: u128,
        edge_type: String,
        response_tx: Sender<()>,
    },

    // Read operations (require response)
    GetNode {
        id: u128,
        response_tx: Sender<Option<NodeRecord>>,
    },
    NodeExists {
        id: u128,
        response_tx: Sender<bool>,
    },
    GetNodeIdentifier {
        id: u128,
        response_tx: Sender<Option<String>>,
    },
    FindByAttr {
        query: AttrQuery,
        response_tx: Sender<Vec<u128>>,
    },
    FindByType {
        node_type: String,
        response_tx: Sender<Vec<u128>>,
    },
    Neighbors {
        id: u128,
        edge_types: Vec<String>,
        response_tx: Sender<Vec<u128>>,
    },
    Bfs {
        start_ids: Vec<u128>,
        max_depth: usize,
        edge_types: Vec<String>,
        response_tx: Sender<Vec<u128>>,
    },
    GetOutgoingEdges {
        node_id: u128,
        edge_types: Option<Vec<String>>,
        response_tx: Sender<Vec<EdgeRecord>>,
    },
    GetIncomingEdges {
        node_id: u128,
        edge_types: Option<Vec<String>>,
        response_tx: Sender<Vec<EdgeRecord>>,
    },
    GetAllEdges {
        response_tx: Sender<Vec<EdgeRecord>>,
    },
    IsEndpoint {
        id: u128,
        response_tx: Sender<bool>,
    },
    GetNodeStringsWithMetadata {
        id: u128,
        response_tx: Sender<Option<(Option<String>, Option<String>, Option<String>)>>,
    },

    // Stats operations
    NodeCount {
        response_tx: Sender<usize>,
    },
    EdgeCount {
        response_tx: Sender<usize>,
    },
    CountNodesByType {
        types: Option<Vec<String>>,
        response_tx: Sender<std::collections::HashMap<String, usize>>,
    },
    CountEdgesByType {
        edge_types: Option<Vec<String>>,
        response_tx: Sender<std::collections::HashMap<String, usize>>,
    },

    // Datalog operations
    DatalogQuery {
        /// Full Datalog program (rules + query)
        rule_source: String,
        /// Whether to include explain steps
        explain: bool,
        /// Response channel
        response_tx: Sender<std::result::Result<QueryResult, String>>,
    },
    /// Check a guarantee (convenience wrapper for violation query)
    CheckGuarantee {
        rule_source: String,
        explain: bool,
        response_tx: Sender<std::result::Result<QueryResult, String>>,
    },

    // Control operations
    Flush {
        response_tx: Sender<Result<()>>,
    },
    Compact {
        response_tx: Sender<Result<()>>,
    },
    Shutdown,
}

/// Handle to communicate with the engine worker
pub struct EngineHandle {
    command_tx: Sender<Command>,
    worker_handle: Option<JoinHandle<()>>,
}

impl EngineHandle {
    /// Create a new engine and spawn worker thread
    pub fn create(path: PathBuf) -> Result<Self> {
        let engine = RustGraphEngine::create(&path)?;
        Self::spawn_worker(engine)
    }

    /// Open existing engine and spawn worker thread
    pub fn open(path: PathBuf) -> Result<Self> {
        let engine = RustGraphEngine::open(&path)?;
        Self::spawn_worker(engine)
    }

    fn spawn_worker(engine: RustGraphEngine) -> Result<Self> {
        let (command_tx, command_rx) = unbounded::<Command>();

        let worker_handle = thread::spawn(move || {
            worker_loop(engine, command_rx);
        });

        Ok(Self {
            command_tx,
            worker_handle: Some(worker_handle),
        })
    }

    // =========================================================================
    // Write operations (blocking - wait for acknowledgment to ensure visibility)
    // =========================================================================

    pub fn add_nodes(&self, nodes: Vec<NodeRecord>) {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::AddNodes { nodes, response_tx });
        let _ = response_rx.recv(); // Wait for acknowledgment
    }

    pub fn add_edges(&self, edges: Vec<EdgeRecord>, skip_validation: bool) {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::AddEdges { edges, skip_validation, response_tx });
        let _ = response_rx.recv();
    }

    pub fn delete_node(&self, id: u128) {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::DeleteNode { id, response_tx });
        let _ = response_rx.recv(); // Wait for acknowledgment
    }

    pub fn delete_edge(&self, src: u128, dst: u128, edge_type: String) {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::DeleteEdge { src, dst, edge_type, response_tx });
        let _ = response_rx.recv(); // Wait for acknowledgment
    }

    // =========================================================================
    // Read operations (blocking, wait for response)
    // =========================================================================

    pub fn get_node(&self, id: u128) -> Option<NodeRecord> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::GetNode { id, response_tx });
        response_rx.recv().ok().flatten()
    }

    pub fn node_exists(&self, id: u128) -> bool {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::NodeExists { id, response_tx });
        response_rx.recv().unwrap_or(false)
    }

    pub fn get_node_identifier(&self, id: u128) -> Option<String> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::GetNodeIdentifier { id, response_tx });
        response_rx.recv().ok().flatten()
    }

    pub fn find_by_attr(&self, query: AttrQuery) -> Vec<u128> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::FindByAttr { query, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn find_by_type(&self, node_type: String) -> Vec<u128> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::FindByType { node_type, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn neighbors(&self, id: u128, edge_types: Vec<String>) -> Vec<u128> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::Neighbors { id, edge_types, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn bfs(&self, start_ids: Vec<u128>, max_depth: usize, edge_types: Vec<String>) -> Vec<u128> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::Bfs { start_ids, max_depth, edge_types, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<Vec<String>>) -> Vec<EdgeRecord> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::GetOutgoingEdges { node_id, edge_types, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn get_incoming_edges(&self, node_id: u128, edge_types: Option<Vec<String>>) -> Vec<EdgeRecord> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::GetIncomingEdges { node_id, edge_types, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn get_all_edges(&self) -> Vec<EdgeRecord> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::GetAllEdges { response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn is_endpoint(&self, id: u128) -> bool {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::IsEndpoint { id, response_tx });
        response_rx.recv().unwrap_or(false)
    }

    pub fn get_node_strings_with_metadata(&self, id: u128) -> Option<(Option<String>, Option<String>, Option<String>)> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::GetNodeStringsWithMetadata { id, response_tx });
        response_rx.recv().ok().flatten()
    }

    // =========================================================================
    // Stats operations
    // =========================================================================

    pub fn node_count(&self) -> usize {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::NodeCount { response_tx });
        response_rx.recv().unwrap_or(0)
    }

    pub fn edge_count(&self) -> usize {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::EdgeCount { response_tx });
        response_rx.recv().unwrap_or(0)
    }

    pub fn count_nodes_by_type(&self, types: Option<Vec<String>>) -> std::collections::HashMap<String, usize> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::CountNodesByType { types, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    pub fn count_edges_by_type(&self, edge_types: Option<Vec<String>>) -> std::collections::HashMap<String, usize> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::CountEdgesByType { edge_types, response_tx });
        response_rx.recv().unwrap_or_default()
    }

    // =========================================================================
    // Datalog operations
    // =========================================================================

    /// Execute a Datalog query with optional explain mode
    pub fn datalog_query(&self, rule_source: String, explain: bool) -> std::result::Result<QueryResult, String> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::DatalogQuery { rule_source, explain, response_tx });
        response_rx.recv().map_err(|e| e.to_string())?
    }

    /// Check a guarantee (runs violation(X) query on provided rules)
    pub fn check_guarantee(&self, rule_source: String, explain: bool) -> std::result::Result<QueryResult, String> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::CheckGuarantee { rule_source, explain, response_tx });
        response_rx.recv().map_err(|e| e.to_string())?
    }

    // =========================================================================
    // Control operations
    // =========================================================================

    pub fn flush(&self) -> Result<()> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::Flush { response_tx });
        response_rx.recv().map_err(|e| GraphError::Io(
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        ))?
    }

    pub fn compact(&self) -> Result<()> {
        let (response_tx, response_rx) = unbounded();
        let _ = self.command_tx.send(Command::Compact { response_tx });
        response_rx.recv().map_err(|e| GraphError::Io(
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        ))?
    }

    pub fn shutdown(&self) {
        let _ = self.command_tx.send(Command::Shutdown);
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        // Send shutdown command
        let _ = self.command_tx.send(Command::Shutdown);

        // Wait for worker to finish
        if let Some(handle) = self.worker_handle.take() {
            let _ = handle.join();
        }
    }
}

/// Worker loop - processes commands sequentially
fn worker_loop(mut engine: RustGraphEngine, command_rx: Receiver<Command>) {
    eprintln!("[EngineWorker] Started");

    while let Ok(command) = command_rx.recv() {
        match command {
            // Write operations (send acknowledgment after completion)
            Command::AddNodes { nodes, response_tx } => {
                engine.add_nodes(nodes);
                let _ = response_tx.send(()); // Acknowledge completion
            }
            Command::AddEdges { edges, skip_validation, response_tx } => {
                engine.add_edges(edges, skip_validation);
                let _ = response_tx.send(());
            }
            Command::DeleteNode { id, response_tx } => {
                engine.delete_node(id);
                let _ = response_tx.send(()); // Acknowledge completion
            }
            Command::DeleteEdge { src, dst, edge_type, response_tx } => {
                engine.delete_edge(src, dst, &edge_type);
                let _ = response_tx.send(()); // Acknowledge completion
            }

            // Read operations
            Command::GetNode { id, response_tx } => {
                let _ = response_tx.send(engine.get_node(id));
            }
            Command::NodeExists { id, response_tx } => {
                let _ = response_tx.send(engine.node_exists(id));
            }
            Command::GetNodeIdentifier { id, response_tx } => {
                let _ = response_tx.send(engine.get_node_identifier(id));
            }
            Command::FindByAttr { query, response_tx } => {
                let _ = response_tx.send(engine.find_by_attr(&query));
            }
            Command::FindByType { node_type, response_tx } => {
                let _ = response_tx.send(engine.find_by_type(&node_type));
            }
            Command::Neighbors { id, edge_types, response_tx } => {
                let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
                let _ = response_tx.send(engine.neighbors(id, &edge_types_refs));
            }
            Command::Bfs { start_ids, max_depth, edge_types, response_tx } => {
                let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
                let _ = response_tx.send(engine.bfs(&start_ids, max_depth, &edge_types_refs));
            }
            Command::GetOutgoingEdges { node_id, edge_types, response_tx } => {
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());
                let _ = response_tx.send(engine.get_outgoing_edges(node_id, edge_types_refs.as_deref()));
            }
            Command::GetIncomingEdges { node_id, edge_types, response_tx } => {
                let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref()
                    .map(|v| v.iter().map(|s| s.as_str()).collect());
                let _ = response_tx.send(engine.get_incoming_edges(node_id, edge_types_refs.as_deref()));
            }
            Command::GetAllEdges { response_tx } => {
                let _ = response_tx.send(engine.get_all_edges());
            }
            Command::IsEndpoint { id, response_tx } => {
                let _ = response_tx.send(engine.is_endpoint(id));
            }
            Command::GetNodeStringsWithMetadata { id, response_tx } => {
                let _ = response_tx.send(engine.get_node_strings_with_metadata(id));
            }

            // Stats operations
            Command::NodeCount { response_tx } => {
                let _ = response_tx.send(engine.node_count());
            }
            Command::EdgeCount { response_tx } => {
                let _ = response_tx.send(engine.edge_count());
            }
            Command::CountNodesByType { types, response_tx } => {
                let _ = response_tx.send(engine.count_nodes_by_type(types.as_deref()));
            }
            Command::CountEdgesByType { edge_types, response_tx } => {
                let _ = response_tx.send(engine.count_edges_by_type(edge_types.as_deref()));
            }

            // Datalog operations
            Command::DatalogQuery { rule_source, explain, response_tx } => {
                let result = execute_datalog_query(&engine, &rule_source, explain);
                let _ = response_tx.send(result);
            }
            Command::CheckGuarantee { rule_source, explain, response_tx } => {
                let result = execute_check_guarantee(&engine, &rule_source, explain);
                let _ = response_tx.send(result);
            }

            // Control operations
            Command::Flush { response_tx } => {
                let _ = response_tx.send(engine.flush());
            }
            Command::Compact { response_tx } => {
                let _ = response_tx.send(engine.compact());
            }
            Command::Shutdown => {
                eprintln!("[EngineWorker] Shutting down, flushing...");
                let _ = engine.flush();
                break;
            }
        }
    }

    eprintln!("[EngineWorker] Stopped");
}

/// Execute a Datalog query with explain support
fn execute_datalog_query(
    engine: &RustGraphEngine,
    rule_source: &str,
    explain: bool,
) -> std::result::Result<QueryResult, String> {
    // Parse the program
    let program = parse_program(rule_source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    // Create evaluator with explain mode
    let mut evaluator = EvaluatorExplain::new(engine, explain);

    // Load all rules
    for rule in program.rules() {
        evaluator.add_rule(rule.clone());
    }

    // Find the query - look for a rule with predicate "query" or use first rule's head
    let query_atom = if let Some(query_rule) = program.rules().iter().find(|r| r.head().predicate() == "query") {
        query_rule.head().clone()
    } else if let Some(first_rule) = program.rules().first() {
        // Use first rule's head as query
        first_rule.head().clone()
    } else {
        return Err("No rules found in program".to_string());
    };

    // Execute query
    let result = evaluator.query(&query_atom);

    Ok(result)
}

/// Execute a guarantee check (violation query)
fn execute_check_guarantee(
    engine: &RustGraphEngine,
    rule_source: &str,
    explain: bool,
) -> std::result::Result<QueryResult, String> {
    // Parse the program
    let program = parse_program(rule_source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;

    // Create evaluator with explain mode
    let mut evaluator = EvaluatorExplain::new(engine, explain);

    // Load all rules
    for rule in program.rules() {
        evaluator.add_rule(rule.clone());
    }

    // Query for violations
    let violation_query = parse_atom("violation(X)")
        .map_err(|e| format!("Internal error parsing violation query: {}", e))?;

    // Execute query
    let result = evaluator.query(&violation_query);

    Ok(result)
}
