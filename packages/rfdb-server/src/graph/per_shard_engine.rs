//! PerShardEngine — RFD-71 Stage 1 abstraction layer.
//!
//! Introduces the engine-level indirection the RFD-71 design
//! (`_ai/research/rfd71-per-shard-locking-design.md`) calls for, WITHOUT
//! yet splitting the engine lock. Stage 1's stated goal: "implement the
//! GraphStore trait by delegating to shards with SEQUENTIAL locks (no
//! concurrency yet — just the abstraction)", keep existing tests green.
//!
//! ## What this is (Stage 1)
//!
//! A thin wrapper around the existing [`GraphEngineV2`]. Every `GraphStore`
//! method delegates to the inner engine. There is no behavioral change and
//! no added concurrency — the inner `MultiShardStore` still owns the
//! `Vec<Shard>` and the global indexes (`node_to_shard`, `file_to_node_ids`,
//! `enrichment_edge_to_shard`).
//!
//! ## What this is NOT (deferred to later stages)
//!
//! The design's target struct is:
//! ```text
//! PerShardEngine {
//!     shards: Vec<RwLock<Shard>>,
//!     global_state: Mutex<GlobalState>,
//!     manifest_store: RwLock<ManifestStore>,
//!     planner: ShardPlanner,
//! }
//! ```
//! Moving the shards OUT of `MultiShardStore` into `Vec<RwLock<Shard>>`
//! here is inseparable from rewriting `commit_batch_ext`'s phases
//! (`multi_shard.rs:1076-1430`) onto the new lock map — which Stage 1
//! explicitly excludes ("Do NOT rewrite commit_batch_ext phases"). So in
//! Stage 1 the per-shard fields are represented by the inner engine; the
//! wrapper is the seam future stages widen.
//!
//! ## Downcast transparency (critical)
//!
//! Five call sites in `bin/rfdb_server.rs` downcast the trait object to
//! `GraphEngineV2` (commit_batch_v2 hot path + 4 snapshot ops). To keep
//! them working with zero churn, [`as_any`](PerShardEngine::as_any) and
//! [`as_any_mut`](PerShardEngine::as_any_mut) return the INNER engine's
//! `Any`, so `downcast_mut::<GraphEngineV2>()` continues to resolve.

use std::any::Any;
use std::collections::HashMap;
use std::path::Path;

use crate::error::Result;
use crate::storage::{AttrQuery, EdgeRecord, FieldDecl, NodeRecord};
use crate::storage_v2::{ShardDiagnostics, ShardL0Counts};
use super::{GraphEngineV2, GraphStore};

/// RFD-71 Stage 1 engine: delegates to an inner [`GraphEngineV2`] behind
/// the unchanged [`GraphStore`] trait. Sequential locking only.
pub struct PerShardEngine {
    inner: GraphEngineV2,
}

impl PerShardEngine {
    /// Create a new on-disk engine at `path`.
    pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
        Ok(Self {
            inner: GraphEngineV2::create(path)?,
        })
    }

    /// Open an existing on-disk engine at `path`.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        Ok(Self {
            inner: GraphEngineV2::open(path)?,
        })
    }

    /// Create an ephemeral (in-memory) engine for tests.
    pub fn create_ephemeral() -> Self {
        Self {
            inner: GraphEngineV2::create_ephemeral(),
        }
    }

    /// Wrap an already-constructed inner engine.
    pub fn from_inner(inner: GraphEngineV2) -> Self {
        Self { inner }
    }

    /// Borrow the inner engine (for engine-specific operations that haven't
    /// been lifted onto the trait, e.g. snapshot tagging).
    pub fn inner(&self) -> &GraphEngineV2 {
        &self.inner
    }

    /// Mutably borrow the inner engine.
    pub fn inner_mut(&mut self) -> &mut GraphEngineV2 {
        &mut self.inner
    }
}

impl GraphStore for PerShardEngine {
    // === NODE OPERATIONS ===

    fn add_nodes(&mut self, nodes: Vec<NodeRecord>) {
        self.inner.add_nodes(nodes)
    }

    fn delete_node(&mut self, id: u128) {
        self.inner.delete_node(id)
    }

    fn get_node(&self, id: u128) -> Option<NodeRecord> {
        self.inner.get_node(id)
    }

    fn node_exists(&self, id: u128) -> bool {
        self.inner.node_exists(id)
    }

    fn get_node_identifier(&self, id: u128) -> Option<String> {
        self.inner.get_node_identifier(id)
    }

    fn find_by_attr(&self, query: &AttrQuery) -> Vec<u128> {
        self.inner.find_by_attr(query)
    }

    fn find_by_attr_chunked(
        &self,
        query: &AttrQuery,
        chunk_size: usize,
        callback: &mut dyn FnMut(&[u128]) -> bool,
    ) {
        self.inner.find_by_attr_chunked(query, chunk_size, callback)
    }

    fn find_by_type(&self, node_type: &str) -> Vec<u128> {
        self.inner.find_by_type(node_type)
    }

    // === EDGE OPERATIONS ===

    fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool) {
        self.inner.add_edges(edges, skip_validation)
    }

    fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
        self.inner.delete_edge(src, dst, edge_type)
    }

    fn neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        self.inner.neighbors(id, edge_types)
    }

    fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        self.inner.get_outgoing_edges(node_id, edge_types)
    }

    fn get_incoming_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        self.inner.get_incoming_edges(node_id, edge_types)
    }

    fn get_all_edges(&self) -> Vec<EdgeRecord> {
        self.inner.get_all_edges()
    }

    fn get_edges_by_type(&self, edge_type: &str) -> Vec<EdgeRecord> {
        self.inner.get_edges_by_type(edge_type)
    }

    fn count_nodes_by_type(&self, types: Option<&[String]>) -> HashMap<String, usize> {
        self.inner.count_nodes_by_type(types)
    }

    fn count_edges_by_type(&self, edge_types: Option<&[String]>) -> HashMap<String, usize> {
        self.inner.count_edges_by_type(edge_types)
    }

    // === TRAVERSAL ===

    fn bfs(&self, start: &[u128], max_depth: usize, edge_types: &[&str]) -> Vec<u128> {
        self.inner.bfs(start, max_depth, edge_types)
    }

    // === MAINTENANCE ===

    fn flush(&mut self) -> Result<()> {
        self.inner.flush()
    }

    fn flush_data_only(&mut self) -> Result<()> {
        self.inner.flush_data_only()
    }

    fn rebuild_indexes(&mut self) -> Result<()> {
        self.inner.rebuild_indexes()
    }

    fn compact(&mut self) -> Result<()> {
        self.inner.compact()
    }

    // === STATS ===

    fn node_count(&self) -> usize {
        self.inner.node_count()
    }

    fn edge_count(&self) -> usize {
        self.inner.edge_count()
    }

    // === ENGINE-SPECIFIC ===

    fn clear(&mut self) {
        self.inner.clear()
    }

    fn declare_fields(&mut self, fields: Vec<FieldDecl>) {
        self.inner.declare_fields(fields)
    }

    // === DIAGNOSTICS ===

    fn shard_diagnostics(&self) -> Vec<ShardDiagnostics> {
        self.inner.shard_diagnostics()
    }

    fn shard_l0_segment_counts(&self) -> Vec<ShardL0Counts> {
        self.inner.shard_l0_segment_counts()
    }

    fn disk_size_bytes(&self) -> u64 {
        self.inner.disk_size_bytes()
    }

    // === DOWNCAST SUPPORT ===
    //
    // Delegate to the INNER engine's `Any` so existing
    // `downcast_*::<GraphEngineV2>()` call sites in bin/rfdb_server.rs
    // (commit_batch_v2 + snapshot ops) keep resolving transparently.

    fn as_any(&self) -> &dyn Any {
        self.inner.as_any()
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self.inner.as_any_mut()
    }
}
