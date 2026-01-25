//! Delta log for incremental updates

use super::{NodeRecord, EdgeRecord};
use serde::{Deserialize, Serialize};

/// Operation in delta log
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Delta {
    AddNode(NodeRecord),
    DeleteNode { id: u128 },
    AddEdge(EdgeRecord),
    DeleteEdge { src: u128, dst: u128, edge_type: String },
    UpdateNodeVersion { id: u128, version: String },
}

/// In-memory delta log for fast writes
#[derive(Debug, Default)]
pub struct DeltaLog {
    operations: Vec<Delta>,
}

impl DeltaLog {
    pub fn new() -> Self {
        Self {
            operations: Vec::new(),
        }
    }

    pub fn push(&mut self, delta: Delta) {
        self.operations.push(delta);
    }

    pub fn len(&self) -> usize {
        self.operations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.operations.is_empty()
    }

    pub fn clear(&mut self) {
        self.operations.clear();
    }

    pub fn iter(&self) -> impl Iterator<Item = &Delta> {
        self.operations.iter()
    }

    pub fn drain(&mut self) -> impl Iterator<Item = Delta> + '_ {
        self.operations.drain(..)
    }
}
