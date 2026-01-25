//! Secondary indexes via sled KV store

use sled::Db;
use std::path::Path;
use crate::error::{GraphError, Result};

/// File index: path -> [node_ids]
pub struct FileIndex {
    db: Db,
}

impl FileIndex {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let db = sled::open(path).map_err(|e| {
            GraphError::Index(format!("Failed to open sled: {}", e))
        })?;

        Ok(Self { db })
    }

    /// Add mapping file_path -> node_id
    pub fn add_mapping(&self, file_path: &str, node_id: u128) -> Result<()> {
        let key = file_path.as_bytes();
        let value = node_id.to_le_bytes();

        // Append to existing values
        self.db
            .update_and_fetch(key, |old: Option<&[u8]>| {
                let mut new_value = old.map(|v| v.to_vec()).unwrap_or_default();
                new_value.extend_from_slice(&value);
                Some(new_value)
            })
            .map_err(|e| GraphError::Index(format!("Failed to add mapping: {}", e)))?;

        Ok(())
    }

    /// Get all node_ids for a file
    pub fn get_nodes(&self, file_path: &str) -> Result<Vec<u128>> {
        let key = file_path.as_bytes();

        let value = self.db.get(key).map_err(|e| {
            GraphError::Index(format!("Failed to get nodes: {}", e))
        })?;

        if let Some(bytes) = value {
            let node_count = bytes.len() / 16;
            let mut result = Vec::with_capacity(node_count);

            for i in 0..node_count {
                let start = i * 16;
                let id_bytes: [u8; 16] = bytes[start..start + 16]
                    .try_into()
                    .map_err(|_| GraphError::Index("Invalid node ID".into()))?;
                result.push(u128::from_le_bytes(id_bytes));
            }

            Ok(result)
        } else {
            Ok(Vec::new())
        }
    }
}
