//! Semantic embedding search for RFDB (feature-gated: --features embedding).
//!
//! Adds a vector search tier to the RFDB query fallback chain:
//! exact -> substring -> token Jaccard -> **embedding ANN** (this module).
//!
//! Uses candle (all-MiniLM-L6-v2) for embeddings and LanceDB for vector storage.
//! LanceDB sits alongside RFDB as a sidecar store, synced after compaction.

pub mod model;
pub mod store;
pub mod sync;

use std::path::Path;
use tokio::sync::RwLock;

use crate::error::Result;

/// Embedding dimension for all-MiniLM-L6-v2.
pub const EMBEDDING_DIM: usize = 384;

/// Result of an embedding similarity search.
#[derive(Debug, Clone)]
pub struct EmbeddingMatch {
    /// Node ID (BLAKE3 hash).
    pub node_id: u128,
    /// Original node name.
    pub name: String,
    /// Node type (FUNCTION, CLASS, etc.).
    pub node_type: String,
    /// Cosine similarity score (0.0 - 1.0, higher = more similar).
    pub score: f32,
}

/// Statistics from a sync operation.
#[derive(Debug, Default)]
pub struct SyncStats {
    pub nodes_upserted: usize,
    pub nodes_deleted: usize,
    pub embeddings_computed: usize,
    pub duration_ms: u64,
}

/// Orchestrates embedding model + LanceDB store.
///
/// Lazily initialized: model loaded on first use, LanceDB opened on first query/sync.
/// Thread-safe via RwLock for the mutable model state.
pub struct EmbeddingEngine {
    model: RwLock<model::EmbeddingModel>,
    store: RwLock<store::VectorStore>,
}

impl EmbeddingEngine {
    /// Create a new engine. Does NOT load model or open store yet (lazy).
    pub fn new(lance_dir: &Path, model_cache_dir: &Path) -> Result<Self> {
        Ok(Self {
            model: RwLock::new(model::EmbeddingModel::new(model_cache_dir)),
            store: RwLock::new(store::VectorStore::new(lance_dir)),
        })
    }

    /// Search for nodes semantically similar to the query string.
    ///
    /// On any error (model not loaded, LanceDB unavailable), returns empty vec.
    pub async fn search(
        &self,
        query: &str,
        node_type: Option<&str>,
        k: usize,
        min_score: f32,
    ) -> Vec<EmbeddingMatch> {
        // Ensure model is loaded
        {
            let mut model = self.model.write().await;
            if !model.is_loaded() {
                if let Err(e) = model.load() {
                    tracing::warn!("Embedding model load failed: {}", e);
                    return vec![];
                }
            }
        }

        // Compute query embedding
        let query_text = model::format_node_text("", query); // No type prefix for queries
        let query_embedding = {
            let model = self.model.read().await;
            match model.embed_one(&query_text) {
                Ok(emb) => emb,
                Err(e) => {
                    tracing::warn!("Query embedding failed: {}", e);
                    return vec![];
                }
            }
        };

        // Search LanceDB
        let mut store = self.store.write().await;
        if let Err(e) = store.ensure_open().await {
            tracing::warn!("LanceDB open failed: {}", e);
            return vec![];
        }

        match store.search(&query_embedding, node_type, k).await {
            Ok(results) => results
                .into_iter()
                .filter(|r| r.score >= min_score)
                .map(|r| EmbeddingMatch {
                    node_id: r.node_id,
                    name: r.name,
                    node_type: r.node_type,
                    score: r.score,
                })
                .collect(),
            Err(e) => {
                tracing::warn!("Embedding search failed: {}", e);
                vec![]
            }
        }
    }

    /// Sync RFDB nodes into LanceDB.
    ///
    /// Called after compact(). Computes embeddings for nodes and upserts to LanceDB.
    pub async fn sync(
        &self,
        nodes: &[crate::storage_v2::types::NodeRecordV2],
        tombstoned_ids: &[u128],
    ) -> Result<SyncStats> {
        // Ensure model is loaded
        {
            let mut model = self.model.write().await;
            if !model.is_loaded() {
                model
                    .load()
                    .map_err(|e| crate::error::GraphError::Embedding(e.to_string()))?;
            }
        }

        let model = self.model.read().await;
        let mut store = self.store.write().await;
        store
            .ensure_open()
            .await
            .map_err(|e| crate::error::GraphError::Embedding(e.to_string()))?;

        sync::sync_nodes(&*model, &mut *store, nodes, tombstoned_ids).await
    }

    /// Check if the embedding model is available (downloaded).
    pub async fn is_model_available(&self) -> bool {
        let model = self.model.read().await;
        model.is_cached()
    }
}
