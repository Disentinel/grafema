//! LanceDB vector store for node embeddings.
//!
//! Schema: (node_id: Utf8, node_type: Utf8, name: Utf8, embedding: FixedSizeList<f32>(384))
//! Stored at: <db>.embeddings.lance/ alongside <db>.rfdb/
//!
//! Node IDs stored as 32-char lowercase hex strings (Arrow lacks u128).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use arrow_array::{
    Array, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator, StringArray,
    RecordBatchReader,
};
use arrow_schema::{DataType, Field, Schema};
use lancedb::query::{ExecutableQuery, QueryBase};

use super::model::EMBEDDING_DIM;

/// Table name within LanceDB.
const TABLE_NAME: &str = "node_embeddings";

/// A record to upsert into LanceDB.
pub struct VectorRecord {
    pub node_id: u128,
    pub node_type: String,
    pub name: String,
    pub embedding: Vec<f32>,
}

/// A search result from ANN query.
#[derive(Debug, Clone)]
pub struct VectorSearchResult {
    pub node_id: u128,
    pub name: String,
    pub node_type: String,
    /// Similarity score (higher = more similar).
    pub score: f32,
}

pub struct VectorStore {
    path: PathBuf,
    db: Option<lancedb::Connection>,
    table: Option<lancedb::Table>,
}

impl VectorStore {
    /// Create wrapper (connection NOT opened yet).
    pub fn new(lance_dir: &Path) -> Self {
        Self {
            path: lance_dir.to_path_buf(),
            db: None,
            table: None,
        }
    }

    /// Open or create the LanceDB database and table.
    pub async fn ensure_open(&mut self) -> Result<(), StoreError> {
        if self.table.is_some() {
            return Ok(());
        }

        let db = lancedb::connect(self.path.to_string_lossy().as_ref())
            .execute()
            .await
            .map_err(|e| StoreError::Lance(e.to_string()))?;

        // Try to open existing table, or create if not found
        let table = match db.open_table(TABLE_NAME).execute().await {
            Ok(t) => t,
            Err(_) => {
                let schema = Self::create_schema();
                let batch = Self::empty_batch(&schema)?;
                let batches = RecordBatchIterator::new(vec![Ok(batch)], Arc::new(schema));
                let reader: Box<dyn RecordBatchReader + Send> = Box::new(batches);
                db.create_table(TABLE_NAME, reader)
                    .execute()
                    .await
                    .map_err(|e| StoreError::Lance(format!("create table: {}", e)))?
            }
        };

        self.db = Some(db);
        self.table = Some(table);
        Ok(())
    }

    /// Upsert a batch of records. Uses add() for simplicity (full replace pattern).
    ///
    /// For a true merge-on-key, LanceDB merge_insert is available but has
    /// ownership constraints. Since sync does a full replace after compact,
    /// simple add() is correct.
    pub async fn upsert(&mut self, records: Vec<VectorRecord>) -> Result<usize, StoreError> {
        let table = self.table.as_mut().ok_or(StoreError::NotOpen)?;
        if records.is_empty() {
            return Ok(0);
        }

        let count = records.len();
        let batch = Self::records_to_batch(&records)?;
        let schema = Self::create_schema();
        let batches = RecordBatchIterator::new(vec![Ok(batch)], Arc::new(schema));
        let reader: Box<dyn RecordBatchReader + Send> = Box::new(batches);

        table
            .add(reader)
            .execute()
            .await
            .map_err(|e| StoreError::Lance(format!("add: {}", e)))?;

        Ok(count)
    }

    /// Delete nodes by their IDs.
    pub async fn delete(&mut self, node_ids: &[u128]) -> Result<usize, StoreError> {
        let table = self.table.as_ref().ok_or(StoreError::NotOpen)?;
        if node_ids.is_empty() {
            return Ok(0);
        }

        let count = node_ids.len();
        let hex_ids: Vec<String> = node_ids.iter().map(|id| format!("'{:032x}'", id)).collect();
        let predicate = format!("node_id IN ({})", hex_ids.join(", "));

        table
            .delete(&predicate)
            .await
            .map_err(|e| StoreError::Lance(format!("delete: {}", e)))?;

        Ok(count)
    }

    /// ANN search: find k nearest neighbors to a query embedding.
    pub async fn search(
        &self,
        query_embedding: &[f32],
        node_type: Option<&str>,
        k: usize,
    ) -> Result<Vec<VectorSearchResult>, StoreError> {
        let table = self.table.as_ref().ok_or(StoreError::NotOpen)?;

        let mut query = table
            .vector_search(query_embedding)
            .map_err(|e| StoreError::Lance(format!("vector_search: {}", e)))?;

        query = query.limit(k);

        if let Some(nt) = node_type {
            query = query.only_if(format!("node_type = '{}'", nt));
        }

        let results = query
            .execute()
            .await
            .map_err(|e| StoreError::Lance(format!("execute: {}", e)))?;

        use futures_util::TryStreamExt;
        let batches: Vec<RecordBatch> = results
            .try_collect()
            .await
            .map_err(|e| StoreError::Arrow(format!("collect: {}", e)))?;

        let mut matches = Vec::new();
        for batch in &batches {
            let node_ids = batch
                .column_by_name("node_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let names = batch
                .column_by_name("name")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let node_types = batch
                .column_by_name("node_type")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

            if let (Some(ids), Some(names), Some(types), Some(dists)) =
                (node_ids, names, node_types, distances)
            {
                for i in 0..batch.num_rows() {
                    let node_id = u128::from_str_radix(ids.value(i), 16).unwrap_or(0);
                    // Convert L2 distance to approximate cosine similarity
                    // For normalized vectors: cos_sim ≈ 1 - (L2_dist² / 2)
                    let distance = dists.value(i);
                    let score = (1.0f32 - distance / 2.0).max(0.0);

                    matches.push(VectorSearchResult {
                        node_id,
                        name: names.value(i).to_string(),
                        node_type: types.value(i).to_string(),
                        score,
                    });
                }
            }
        }

        Ok(matches)
    }

    /// Get the count of vectors in the store.
    pub async fn count(&self) -> Result<usize, StoreError> {
        let table = self.table.as_ref().ok_or(StoreError::NotOpen)?;
        let count = table
            .count_rows(None)
            .await
            .map_err(|e| StoreError::Lance(format!("count: {}", e)))?;
        Ok(count)
    }

    fn create_schema() -> Schema {
        Schema::new(vec![
            Field::new("node_id", DataType::Utf8, false),
            Field::new("node_type", DataType::Utf8, false),
            Field::new("name", DataType::Utf8, false),
            Field::new(
                "embedding",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, true)),
                    EMBEDDING_DIM as i32,
                ),
                false,
            ),
        ])
    }

    fn empty_batch(schema: &Schema) -> Result<RecordBatch, StoreError> {
        let node_ids = StringArray::from(Vec::<String>::new());
        let node_types = StringArray::from(Vec::<String>::new());
        let names = StringArray::from(Vec::<String>::new());
        let values = Float32Array::from(Vec::<f32>::new());
        let embeddings = FixedSizeListArray::try_new(
            Arc::new(Field::new("item", DataType::Float32, true)),
            EMBEDDING_DIM as i32,
            Arc::new(values),
            None,
        )
        .map_err(|e| StoreError::Arrow(e.to_string()))?;

        RecordBatch::try_new(
            Arc::new(schema.clone()),
            vec![
                Arc::new(node_ids),
                Arc::new(node_types),
                Arc::new(names),
                Arc::new(embeddings),
            ],
        )
        .map_err(|e| StoreError::Arrow(e.to_string()))
    }

    fn records_to_batch(records: &[VectorRecord]) -> Result<RecordBatch, StoreError> {
        let schema = Self::create_schema();

        let node_ids: Vec<String> = records.iter().map(|r| format!("{:032x}", r.node_id)).collect();
        let node_types: Vec<&str> = records.iter().map(|r| r.node_type.as_str()).collect();
        let names: Vec<&str> = records.iter().map(|r| r.name.as_str()).collect();

        let flat_embeddings: Vec<f32> = records
            .iter()
            .flat_map(|r| r.embedding.iter().copied())
            .collect();

        let id_array = StringArray::from(node_ids);
        let type_array = StringArray::from(node_types);
        let name_array = StringArray::from(names);
        let values = Float32Array::from(flat_embeddings);
        let embedding_array = FixedSizeListArray::try_new(
            Arc::new(Field::new("item", DataType::Float32, true)),
            EMBEDDING_DIM as i32,
            Arc::new(values),
            None,
        )
        .map_err(|e| StoreError::Arrow(e.to_string()))?;

        RecordBatch::try_new(
            Arc::new(schema),
            vec![
                Arc::new(id_array),
                Arc::new(type_array),
                Arc::new(name_array),
                Arc::new(embedding_array),
            ],
        )
        .map_err(|e| StoreError::Arrow(e.to_string()))
    }
}

#[derive(Debug)]
pub enum StoreError {
    Lance(String),
    Arrow(String),
    NotOpen,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Lance(e) => write!(f, "LanceDB error: {}", e),
            Self::Arrow(e) => write!(f, "Arrow error: {}", e),
            Self::NotOpen => write!(f, "Store not open"),
        }
    }
}

impl std::error::Error for StoreError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_store_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = VectorStore::new(dir.path());
        store.ensure_open().await.unwrap();

        let mut embedding = vec![0.0f32; EMBEDDING_DIM];
        embedding[0] = 1.0;

        let records = vec![VectorRecord {
            node_id: 12345,
            node_type: "CLASS".to_string(),
            name: "HeartbeatService".to_string(),
            embedding,
        }];

        let upserted = store.upsert(records).await.unwrap();
        assert_eq!(upserted, 1);

        let count = store.count().await.unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn test_store_search() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = VectorStore::new(dir.path());
        store.ensure_open().await.unwrap();

        let mut emb1 = vec![0.0f32; EMBEDDING_DIM];
        emb1[0] = 1.0;
        let mut emb2 = vec![0.0f32; EMBEDDING_DIM];
        emb2[1] = 1.0;

        store
            .upsert(vec![
                VectorRecord {
                    node_id: 1,
                    node_type: "CLASS".to_string(),
                    name: "HeartbeatService".to_string(),
                    embedding: emb1.clone(),
                },
                VectorRecord {
                    node_id: 2,
                    node_type: "FUNCTION".to_string(),
                    name: "getUserById".to_string(),
                    embedding: emb2,
                },
            ])
            .await
            .unwrap();

        let results = store.search(&emb1, None, 2).await.unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].name, "HeartbeatService");
    }

    #[tokio::test]
    async fn test_store_delete() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = VectorStore::new(dir.path());
        store.ensure_open().await.unwrap();

        let embedding = vec![0.1f32; EMBEDDING_DIM];
        store
            .upsert(vec![VectorRecord {
                node_id: 42,
                node_type: "CLASS".to_string(),
                name: "Test".to_string(),
                embedding,
            }])
            .await
            .unwrap();

        assert_eq!(store.count().await.unwrap(), 1);
        store.delete(&[42]).await.unwrap();
        assert_eq!(store.count().await.unwrap(), 0);
    }
}
