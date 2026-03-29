//! Sync logic: RFDB → LanceDB after compaction.
//!
//! Strategy: full replace. After compaction, RFDB has clean L1 segments.
//! We embed all live node names and write them to LanceDB.
//! Tombstoned nodes are deleted from LanceDB.

use crate::storage_v2::types::NodeRecordV2;

use super::model::{format_node_text, EmbeddingModel};
use super::store::{VectorRecord, VectorStore};
use super::SyncStats;

/// Batch size for embedding computation during sync.
const SYNC_BATCH_SIZE: usize = 256;

/// Run a full sync from RFDB nodes to LanceDB.
///
/// 1. Filter nodes with non-empty names
/// 2. Batch-compute embeddings (256 at a time)
/// 3. Upsert into LanceDB
/// 4. Delete tombstoned node IDs
pub async fn sync_nodes(
    model: &EmbeddingModel,
    store: &mut VectorStore,
    nodes: &[NodeRecordV2],
    tombstoned_ids: &[u128],
) -> crate::error::Result<SyncStats> {
    let start = std::time::Instant::now();
    let mut stats = SyncStats::default();

    // Filter: only nodes with non-empty names are worth embedding
    let embeddable: Vec<&NodeRecordV2> = nodes
        .iter()
        .filter(|n| !n.name.is_empty())
        .collect();

    // Process in batches
    for chunk in embeddable.chunks(SYNC_BATCH_SIZE) {
        // Format texts for embedding
        let texts: Vec<String> = chunk
            .iter()
            .map(|n| format_node_text(&n.node_type, &n.name))
            .collect();
        let text_refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();

        // Compute embeddings
        let embeddings = model
            .embed(&text_refs)
            .map_err(|e| crate::error::GraphError::Embedding(e.to_string()))?;
        stats.embeddings_computed += embeddings.len();

        // Build records
        let records: Vec<VectorRecord> = chunk
            .iter()
            .zip(embeddings.into_iter())
            .map(|(node, embedding)| VectorRecord {
                node_id: node.id,
                node_type: node.node_type.clone(),
                name: node.name.clone(),
                embedding,
            })
            .collect();

        let upserted = store
            .upsert(records)
            .await
            .map_err(|e| crate::error::GraphError::Embedding(e.to_string()))?;
        stats.nodes_upserted += upserted;
    }

    // Delete tombstoned nodes
    if !tombstoned_ids.is_empty() {
        let deleted = store
            .delete(tombstoned_ids)
            .await
            .map_err(|e| crate::error::GraphError::Embedding(e.to_string()))?;
        stats.nodes_deleted = deleted;
    }

    stats.duration_ms = start.elapsed().as_millis() as u64;
    Ok(stats)
}
