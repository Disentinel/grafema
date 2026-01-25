//! NAPI bindings for GraphEngine
//!
//! Provides JavaScript API for working with Rust graph engine

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;
use std::env;
use std::sync::{Arc, RwLock};

use crate::graph::{GraphStore, GraphEngine as RustGraphEngine, compute_node_id, string_id_to_u128};
use crate::storage::{NodeRecord, EdgeRecord, AttrQuery};
use crate::datalog::{Evaluator, parse_program, parse_atom, Rule};

// Debug logging macro - enabled via NAVI_DEBUG=1
macro_rules! debug_log {
    ($($arg:tt)*) => {
        if env::var("NAVI_DEBUG").is_ok() {
            eprintln!("[RUST DEBUG] {}", format!($($arg)*));
        }
    };
}

/// JavaScript representation of NodeRecord
#[napi(object)]
pub struct JsNodeRecord {
    /// Node ID (BigInt in JS)
    pub id: BigInt,
    /// Node type as string (e.g., "FUNCTION", "CLASS", "http:route")
    pub node_type: Option<String>,
    /// File ID
    pub file_id: u32,
    /// Name offset in string table
    pub name_offset: u32,
    /// Version ("main" or "__local")
    pub version: String,
    /// Whether exported
    pub exported: bool,
    /// ID of replaced node (for incremental analysis)
    pub replaces: Option<BigInt>,
    /// Entity name (function name, class name, etc.)
    pub name: Option<String>,
    /// File path
    pub file: Option<String>,
    /// JSON metadata (async, generator, arrowFunction, line, etc.)
    pub metadata: Option<String>,
}

/// JavaScript representation of EdgeRecord
#[napi(object)]
pub struct JsEdgeRecord {
    /// Source ID (BigInt)
    pub src: BigInt,
    /// Destination ID (BigInt)
    pub dst: BigInt,
    /// Edge type as string (e.g., "CALLS", "CONTAINS", "http:routes_to")
    pub edge_type: Option<String>,
    /// Version
    pub version: String,
    /// JSON metadata (argIndex, isSpread, etc.)
    pub metadata: Option<String>,
}

/// JavaScript representation of AttrQuery
#[napi(object)]
pub struct JsAttrQuery {
    pub version: Option<String>,
    /// Node type as string. Supports wildcard: "http:*"
    pub node_type: Option<String>,
    pub file_id: Option<u32>,
    pub exported: Option<bool>,
    pub name: Option<String>,
}

/// Query result with cursor
#[napi(object)]
pub struct JsQueryResult {
    /// Found node (null if no more)
    pub node: Option<JsNodeRecord>,
    /// Next cursor (null if no more data)
    pub next_cursor: Option<u32>,
}

/// Datalog variable binding
#[napi(object)]
pub struct JsBinding {
    /// Variable name
    pub name: String,
    /// Value (as string, node IDs are stringified)
    pub value: String,
}

/// Datalog query result - one row of bindings
#[napi(object)]
pub struct JsDatalogResult {
    /// Variable bindings for this result
    pub bindings: Vec<JsBinding>,
}

/// GraphEngine - main class for working with the graph
/// Thread-safe wrapper using Arc<RwLock<>> for concurrent access
#[napi]
pub struct GraphEngine {
    engine: Arc<RwLock<RustGraphEngine>>,
    /// Loaded Datalog rules (also protected for thread-safety)
    datalog_rules: Arc<RwLock<Vec<Rule>>>,
}

#[napi]
impl GraphEngine {
    /// Open or create graph at the specified path
    /// If DB exists - opens it, otherwise creates new
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        debug_log!("NAPI GraphEngine::new() called with path: {}", path);
        let path_buf = PathBuf::from(&path);

        // Check if DB exists (nodes.bin or edges.bin)
        let nodes_exists = path_buf.join("nodes.bin").exists();
        let edges_exists = path_buf.join("edges.bin").exists();

        let engine = if nodes_exists || edges_exists {
            debug_log!("  Existing DB found, opening...");
            // Open existing DB
            RustGraphEngine::open(path_buf)
                .map_err(|e| Error::from_reason(format!("Failed to open graph: {}", e)))?
        } else {
            debug_log!("  No existing DB, creating new...");
            // Create new DB
            RustGraphEngine::create(path_buf)
                .map_err(|e| Error::from_reason(format!("Failed to create graph: {}", e)))?
        };

        debug_log!("  GraphEngine created successfully (thread-safe)");
        Ok(Self {
            engine: Arc::new(RwLock::new(engine)),
            datalog_rules: Arc::new(RwLock::new(Vec::new()))
        })
    }

    /// Open existing graph
    #[napi(factory)]
    pub fn open(path: String) -> Result<Self> {
        let engine = RustGraphEngine::open(PathBuf::from(path))
            .map_err(|e| Error::from_reason(format!("Failed to open graph: {}", e)))?;

        Ok(Self {
            engine: Arc::new(RwLock::new(engine)),
            datalog_rules: Arc::new(RwLock::new(Vec::new()))
        })
    }

    /// Add nodes to graph
    /// NOTE: Uses &self (not &mut self) to allow concurrent calls from JS.
    /// Thread safety is provided by internal Arc<RwLock<>>.
    #[napi]
    pub fn add_nodes(&self, nodes: Vec<JsNodeRecord>) -> Result<()> {
        let rust_nodes: Vec<NodeRecord> = nodes.into_iter().map(|n| {
            NodeRecord {
                id: js_bigint_to_u128(&n.id),
                node_type: n.node_type,
                file_id: n.file_id,
                name_offset: n.name_offset,
                version: n.version,
                exported: n.exported,
                replaces: n.replaces.map(|r| js_bigint_to_u128(&r)),
                deleted: false,
                name: n.name,
                file: n.file,
                metadata: n.metadata,
            }
        }).collect();

        self.engine.write().unwrap().add_nodes(rust_nodes);
        Ok(())
    }

    /// Add edges to graph
    /// NOTE: Uses &self (not &mut self) to allow concurrent calls from JS.
    /// Thread safety is provided by internal Arc<RwLock<>>.
    #[napi]
    pub fn add_edges(&self, edges: Vec<JsEdgeRecord>, skip_validation: Option<bool>) -> Result<()> {
        let rust_edges: Vec<EdgeRecord> = edges.into_iter().map(|e| {
            debug_log!("add_edges: received edge_type={:?}, metadata={:?}", e.edge_type, e.metadata);
            EdgeRecord {
                src: js_bigint_to_u128(&e.src),
                dst: js_bigint_to_u128(&e.dst),
                edge_type: e.edge_type,
                version: e.version,
                metadata: e.metadata,
                deleted: false,
            }
        }).collect();

        self.engine.write().unwrap().add_edges(rust_edges, skip_validation.unwrap_or(false));
        Ok(())
    }

    /// Delete node
    #[napi]
    pub fn delete_node(&self, id: String) {
        self.engine.write().unwrap().delete_node(parse_string_id(&id));
    }

    /// Delete edge
    #[napi]
    pub fn delete_edge(&self, src: String, dst: String, edge_type: String) {
        self.engine.write().unwrap().delete_edge(
            parse_string_id(&src),
            parse_string_id(&dst),
            &edge_type
        );
    }

    /// Get node by ID
    #[napi]
    pub fn get_node(&self, id: String) -> Option<JsNodeRecord> {
        self.engine.read().unwrap().get_node(parse_string_id(&id)).map(|n| {
            JsNodeRecord {
                id: u128_to_js_bigint(n.id),
                node_type: n.node_type,
                file_id: n.file_id,
                name_offset: n.name_offset,
                version: n.version,
                exported: n.exported,
                replaces: n.replaces.map(u128_to_js_bigint),
                name: n.name,
                file: n.file,
                metadata: n.metadata,
            }
        })
    }

    /// Check node existence
    #[napi]
    pub fn node_exists(&self, id: String) -> bool {
        self.engine.read().unwrap().node_exists(parse_string_id(&id))
    }

    /// Get readable identifier for node (TYPE:name@file)
    ///
    /// Returns string of the form:
    /// - FUNCTION:functionName@path/to/file.js
    /// - CLASS:ClassName@path/to/file.js
    /// - MODULE:path/to/file.js
    #[napi]
    pub fn get_node_identifier(&self, id: String) -> Option<String> {
        self.engine.read().unwrap().get_node_identifier(parse_string_id(&id))
    }

    /// Find nodes by attributes
    #[napi]
    pub fn find_by_attr(&self, query: JsAttrQuery) -> Vec<BigInt> {
        let rust_query = AttrQuery {
            version: query.version,
            node_type: query.node_type,
            file_id: query.file_id,
            exported: query.exported,
            name: query.name,
        };

        self.engine.read().unwrap().find_by_attr(&rust_query)
            .into_iter()
            .map(u128_to_js_bigint)
            .collect()
    }

    /// Find nodes by type (supports wildcard, e.g., "http:*")
    #[napi]
    pub fn find_by_type(&self, node_type: String) -> Vec<BigInt> {
        self.engine.read().unwrap().find_by_type(&node_type)
            .into_iter()
            .map(u128_to_js_bigint)
            .collect()
    }

    /// Get node neighbors
    #[napi]
    pub fn neighbors(&self, id: String, edge_types: Vec<String>) -> Vec<String> {
        // Convert Vec<String> to Vec<&str> for engine
        let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();
        self.engine.read().unwrap().neighbors(parse_string_id(&id), &edge_types_refs)
            .into_iter()
            .map(|id| format!("{}", id))
            .collect()
    }

    /// Breadth-first search (BFS)
    #[napi]
    pub fn bfs(&self, start_ids: Vec<String>, max_depth: u32, edge_types: Vec<String>) -> Vec<String> {
        let rust_ids: Vec<u128> = start_ids.iter().map(|s| parse_string_id(s)).collect();
        // Convert Vec<String> to Vec<&str> for engine
        let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();

        self.engine.read().unwrap().bfs(&rust_ids, max_depth as usize, &edge_types_refs)
            .into_iter()
            .map(|id| format!("{}", id))
            .collect()
    }

    /// Depth-first search (DFS)
    /// TODO: Implement DFS in GraphEngine
    #[napi]
    pub fn dfs(&self, start_ids: Vec<String>, max_depth: u32, edge_types: Vec<String>) -> Vec<String> {
        // Temporarily using BFS
        let rust_ids: Vec<u128> = start_ids.iter().map(|s| parse_string_id(s)).collect();
        // Convert Vec<String> to Vec<&str> for engine
        let edge_types_refs: Vec<&str> = edge_types.iter().map(|s| s.as_str()).collect();

        self.engine.read().unwrap().bfs(&rust_ids, max_depth as usize, &edge_types_refs)
            .into_iter()
            .map(|id| format!("{}", id))
            .collect()
    }

    /// Flush data to disk
    #[napi]
    pub fn flush(&self) -> Result<()> {
        let mut engine = self.engine.write().unwrap();
        eprintln!("[RUST FLUSH] Explicit flush requested, {} ops pending", engine.ops_since_flush);
        engine.flush()
            .map_err(|e| Error::from_reason(format!("Flush failed: {}", e)))
    }

    /// Close database and flush to disk
    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut engine = self.engine.write().unwrap();
        eprintln!("[RUST CLOSE] Closing database, flushing {} ops", engine.ops_since_flush);
        engine.flush()
            .map_err(|e| Error::from_reason(format!("Close flush failed: {}", e)))
    }

    /// Data compaction
    #[napi]
    pub fn compact(&self) -> Result<()> {
        self.engine.write().unwrap().compact()
            .map_err(|e| Error::from_reason(format!("Compaction failed: {}", e)))
    }

    /// Node count
    #[napi]
    pub fn node_count(&self) -> u32 {
        self.engine.read().unwrap().node_count() as u32
    }

    /// Edge count
    #[napi]
    pub fn edge_count(&self) -> u32 {
        self.engine.read().unwrap().edge_count() as u32
    }

    /// Check if node is an endpoint
    #[napi]
    pub fn is_endpoint(&self, id: String) -> bool {
        self.engine.read().unwrap().is_endpoint(parse_string_id(&id))
    }

    /// Get outgoing edges from node
    #[napi]
    pub fn get_outgoing_edges(&self, id: String, edge_types: Option<Vec<String>>) -> Vec<JsEdgeRecord> {
        // ID can be either numeric string (internal ID) or string ID like "SERVICE:name"
        let node_id = if id.chars().all(|c| c.is_ascii_digit()) {
            id.parse::<u128>().unwrap_or_else(|_| string_id_to_u128(&id))
        } else {
            string_id_to_u128(&id)
        };

        // Convert Vec<String> to Vec<&str> for engine
        let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref().map(|v| v.iter().map(|s| s.as_str()).collect());
        let edges = self.engine.read().unwrap().get_outgoing_edges(
            node_id,
            edge_types_refs.as_deref()
        );

        edges.into_iter().map(|e| {
            debug_log!("get_outgoing_edges: returning edge_type={:?}, metadata={:?}", e.edge_type, e.metadata);
            JsEdgeRecord {
                src: BigInt::from(e.src),
                dst: BigInt::from(e.dst),
                edge_type: e.edge_type,
                version: e.version,
                metadata: e.metadata,
            }
        }).collect()
    }

    /// Get incoming edges to node
    #[napi]
    pub fn get_incoming_edges(&self, id: String, edge_types: Option<Vec<String>>) -> Vec<JsEdgeRecord> {
        // ID can be either numeric string (internal ID) or string ID like "SERVICE:name"
        let node_id = if id.chars().all(|c| c.is_ascii_digit()) {
            id.parse::<u128>().unwrap_or_else(|_| string_id_to_u128(&id))
        } else {
            string_id_to_u128(&id)
        };

        // Convert Vec<String> to Vec<&str> for engine
        let edge_types_refs: Option<Vec<&str>> = edge_types.as_ref().map(|v| v.iter().map(|s| s.as_str()).collect());
        let edges = self.engine.read().unwrap().get_incoming_edges(
            node_id,
            edge_types_refs.as_deref()
        );

        edges.into_iter().map(|e| JsEdgeRecord {
            src: BigInt::from(e.src),
            dst: BigInt::from(e.dst),
            edge_type: e.edge_type,
            version: e.version,
            metadata: e.metadata,
        }).collect()
    }

    /// Get ALL edges from graph
    #[napi]
    pub fn get_all_edges(&self) -> Vec<JsEdgeRecord> {
        let edges = self.engine.read().unwrap().get_all_edges();

        edges.into_iter().map(|e| JsEdgeRecord {
            src: BigInt::from(e.src),
            dst: BigInt::from(e.dst),
            edge_type: e.edge_type,
            version: e.version,
            metadata: e.metadata,
        }).collect()
    }

    /// Count nodes by type (efficiently, without loading into memory)
    /// Returns JSON string with map {node_type: count}
    /// Supports wildcard in filter (e.g., "http:*")
    #[napi]
    pub fn count_nodes_by_type(&self, types: Option<Vec<String>>) -> String {
        let counts = self.engine.read().unwrap().count_nodes_by_type(types.as_deref());

        serde_json::to_string(&counts).unwrap_or_else(|_| "{}".to_string())
    }

    /// Count edges by type (efficiently, without loading into memory)
    /// Returns JSON string with map {edge_type: count}
    /// Supports wildcard in filter (e.g., "http:*")
    #[napi]
    pub fn count_edges_by_type(&self, edge_types: Option<Vec<String>>) -> String {
        let counts = self.engine.read().unwrap().count_edges_by_type(edge_types.as_deref());

        serde_json::to_string(&counts).unwrap_or_else(|_| "{}".to_string())
    }

    /// Update node version
    /// TODO: Implement update_node_version in GraphEngine
    #[napi]
    pub fn update_node_version(&self, _id: String, _version: String) {
        // TODO: Implement when the method is available in GraphEngine
        unimplemented!("update_node_version not yet implemented in GraphEngine");
    }

    // =========================================================================
    // Datalog API
    // =========================================================================

    /// Load Datalog rules from source string
    ///
    /// # Example
    /// ```javascript
    /// graph.datalogLoadRules(`
    ///     publisher(X) :- node(X, "queue:publish").
    ///     orphan(X) :- publisher(X), \\+ path(X, _).
    /// `);
    /// ```
    #[napi]
    pub fn datalog_load_rules(&self, source: String) -> Result<u32> {
        let program = parse_program(&source)
            .map_err(|e| Error::from_reason(format!("Datalog parse error: {}", e)))?;

        let count = program.rules().len();
        let mut rules = self.datalog_rules.write().unwrap();
        rules.extend(program.rules().iter().cloned());

        debug_log!("datalog_load_rules: loaded {} rules, total {}", count, rules.len());
        Ok(count as u32)
    }

    /// Clear all loaded Datalog rules
    #[napi]
    pub fn datalog_clear_rules(&self) {
        self.datalog_rules.write().unwrap().clear();
    }

    /// Execute a Datalog query and return all results
    ///
    /// # Example
    /// ```javascript
    /// const results = graph.datalogQuery('orphan(X)');
    /// // [{ bindings: [{ name: 'X', value: '123' }] }, ...]
    /// ```
    #[napi]
    pub fn datalog_query(&self, query: String) -> Result<Vec<JsDatalogResult>> {
        let atom = parse_atom(&query)
            .map_err(|e| Error::from_reason(format!("Datalog parse error: {}", e)))?;

        let engine_guard = self.engine.read().unwrap();
        let mut evaluator = Evaluator::new(&*engine_guard);

        // Load all rules into evaluator
        let rules_guard = self.datalog_rules.read().unwrap();
        for rule in rules_guard.iter() {
            evaluator.add_rule(rule.clone());
        }

        let results = evaluator.query(&atom);

        debug_log!("datalog_query: {} results for '{}'", results.len(), query);

        Ok(results
            .into_iter()
            .map(|bindings| JsDatalogResult {
                bindings: bindings
                    .iter()
                    .map(|(name, value)| JsBinding {
                        name: name.clone(),
                        value: value.as_str(),
                    })
                    .collect(),
            })
            .collect())
    }

    /// Check a guarantee (convenience method)
    ///
    /// Loads a rule defining 'violation' and returns all violations.
    ///
    /// # Example
    /// ```javascript
    /// const violations = graph.checkGuarantee(`
    ///     violation(X) :- node(X, "queue:publish"), \\+ path(X, _).
    /// `);
    /// ```
    #[napi]
    pub fn check_guarantee(&self, rule_source: String) -> Result<Vec<JsDatalogResult>> {
        let program = parse_program(&rule_source)
            .map_err(|e| Error::from_reason(format!("Datalog parse error: {}", e)))?;

        let engine_guard = self.engine.read().unwrap();
        let mut evaluator = Evaluator::new(&*engine_guard);

        // Load the guarantee rules
        for rule in program.rules() {
            evaluator.add_rule(rule.clone());
        }

        // Query for violations
        let violation_query = parse_atom("violation(X)")
            .map_err(|e| Error::from_reason(format!("Internal error: {}", e)))?;

        let results = evaluator.query(&violation_query);

        debug_log!("check_guarantee: {} violations", results.len());

        Ok(results
            .into_iter()
            .map(|bindings| JsDatalogResult {
                bindings: bindings
                    .iter()
                    .map(|(name, value)| JsBinding {
                        name: name.clone(),
                        value: value.as_str(),
                    })
                    .collect(),
            })
            .collect())
    }

    /// Get next node by query with cursor
    ///
    /// # Arguments
    /// * `query` - Filter for searching nodes
    /// * `cursor` - Position to continue from (None = beginning)
    ///
    /// # Returns
    /// JsQueryResult with node and next cursor
    #[napi]
    pub fn query_next_node(&self, query: JsAttrQuery, cursor: Option<u32>) -> JsQueryResult {
        // Only log on first call (cursor=None) to avoid flooding stderr
        if cursor.is_none() {
            debug_log!("NAPI query_next_node: node_type={:?}", query.node_type);
        }

        // Convert JS query to Rust AttrQuery
        let attr_query = AttrQuery {
            version: query.version,
            node_type: query.node_type,
            file_id: query.file_id,
            exported: query.exported,
            name: query.name,
        };

        let engine_guard = self.engine.read().unwrap();

        // Get all matching IDs
        let matching_ids = engine_guard.find_by_attr(&attr_query);

        // Determine start position
        let start_index = cursor.unwrap_or(0) as usize;

        // Check if there is a node at this position
        if start_index >= matching_ids.len() {
            return JsQueryResult {
                node: None,
                next_cursor: None,
            };
        }

        // Get node ID
        let node_id = matching_ids[start_index];

        // Get full node
        let node_opt = engine_guard.get_node(node_id);

        if let Some(node) = node_opt {
            // Get string attributes from segment if available
            let (file_str, name_str, metadata_str) = engine_guard.get_node_strings_with_metadata(node_id)
                .unwrap_or((None, None, None));

            let js_node = JsNodeRecord {
                id: u128_to_js_bigint(node.id),
                node_type: node.node_type,
                file_id: node.file_id,
                name_offset: node.name_offset,
                version: node.version,
                exported: node.exported,
                replaces: node.replaces.map(u128_to_js_bigint),
                name: name_str,
                file: file_str,
                metadata: metadata_str,
            };

            // Calculate next cursor
            let next_cursor = if start_index + 1 < matching_ids.len() {
                Some((start_index + 1) as u32)
            } else {
                None
            };

            JsQueryResult {
                node: Some(js_node),
                next_cursor,
            }
        } else {
            // Node not found, skip
            JsQueryResult {
                node: None,
                next_cursor: None,
            }
        }
    }
}

/// Calculate deterministic node ID based on its characteristics
/// node_type - string type (e.g., "FUNCTION", "CLASS", "http:route")
#[napi]
pub fn compute_node_id_js(
    node_type: String,
    name: String,
    scope: String,
    path: String,
) -> BigInt {
    let id = compute_node_id(&node_type, &name, &scope, &path);
    u128_to_js_bigint(id)
}

/// Calculate node ID from string ID
///
/// Uses BLAKE3 hash of the string to get u128
/// This ensures that nodes and edges use the same algorithm
#[napi]
pub fn compute_node_id_from_string(id: String) -> BigInt {
    let id_u128 = string_id_to_u128(&id);
    u128_to_js_bigint(id_u128)
}

// Helper functions for conversion between BigInt and u128

fn u128_to_js_bigint(value: u128) -> BigInt {
    // Convert u128 to u64 words for BigInt
    // BigInt in napi uses Vec<u64> for words
    let low = (value & 0xFFFFFFFFFFFFFFFF) as u64;
    let high = (value >> 64) as u64;

    BigInt {
        sign_bit: false,
        words: vec![low, high],
    }
}

fn js_bigint_to_u128(bigint: &BigInt) -> u128 {
    // Convert BigInt back to u128
    // words[0] = low 64 bits, words[1] = high 64 bits
    let low = bigint.words.get(0).copied().unwrap_or(0) as u128;
    let high = bigint.words.get(1).copied().unwrap_or(0) as u128;

    (high << 64) | low
}

/// Parse string ID to u128
///
/// ID can be:
/// - Numeric string ("210428658517052041070894113771662065888") - parse directly
/// - String ID ("SERVICE:name") - hash via string_id_to_u128
fn parse_string_id(id: &str) -> u128 {
    if id.chars().all(|c| c.is_ascii_digit()) {
        id.parse::<u128>().unwrap_or_else(|_| string_id_to_u128(id))
    } else {
        string_id_to_u128(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bigint_conversion() {
        let original: u128 = 123456789012345678901234567890;
        let bigint = u128_to_js_bigint(original);
        let converted = js_bigint_to_u128(&bigint);
        assert_eq!(original, converted);
    }
}
