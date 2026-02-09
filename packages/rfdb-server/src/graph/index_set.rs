//! In-memory secondary indexes over segment data.
//!
//! Rebuilt from scratch on open() and flush() — not persisted to disk.
//! Analogous to adjacency/reverse_adjacency lists in GraphEngine.

use std::collections::HashMap;
use crate::storage::segment::NodesSegment;

/// Secondary indexes for O(1) lookups over mmap segment data.
///
/// Currently contains:
/// - `id_index`: node ID → segment index (replaces O(n) linear scan)
///
/// Future phases will add type_index and file_index.
pub struct IndexSet {
    /// Node ID → segment index. O(1) lookup replacing O(n) `NodesSegment::find_index()`.
    id_index: HashMap<u128, usize>,
}

impl IndexSet {
    pub fn new() -> Self {
        Self {
            id_index: HashMap::new(),
        }
    }

    /// Rebuild all indexes from segment data in a single pass.
    ///
    /// Called from `GraphEngine::open()` and `GraphEngine::flush()`.
    /// Includes deleted nodes — the caller decides whether to reject them,
    /// matching the original `find_index()` contract.
    pub fn rebuild_from_segment(&mut self, segment: &NodesSegment) {
        self.id_index.clear();
        self.id_index.reserve(segment.node_count());
        for idx in 0..segment.node_count() {
            if let Some(id) = segment.get_id(idx) {
                self.id_index.insert(id, idx);
            }
        }
    }

    /// Clear all indexes.
    ///
    /// Called from `GraphEngine::clear()`.
    pub fn clear(&mut self) {
        self.id_index.clear();
    }

    /// Look up segment index for a node ID. O(1).
    ///
    /// Returns `None` if the ID is not in the segment.
    /// Does NOT check deleted flag — caller must check separately.
    pub fn find_node_index(&self, id: u128) -> Option<usize> {
        self.id_index.get(&id).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_index_set_is_empty() {
        let index = IndexSet::new();
        assert_eq!(index.find_node_index(1), None);
        assert_eq!(index.find_node_index(0), None);
        assert_eq!(index.find_node_index(u128::MAX), None);
    }

    #[test]
    fn test_clear_empties_index() {
        let mut index = IndexSet::new();
        // Manually insert to test clear
        index.id_index.insert(42, 0);
        index.id_index.insert(99, 1);
        assert_eq!(index.find_node_index(42), Some(0));

        index.clear();
        assert_eq!(index.find_node_index(42), None);
        assert_eq!(index.find_node_index(99), None);
    }

    #[test]
    fn test_rebuild_from_segment() {
        use tempfile::tempdir;
        use crate::storage::{NodeRecord, SegmentWriter};
        use crate::storage::segment::NodesSegment;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path();

        // Write a segment with test nodes
        let nodes = vec![
            NodeRecord {
                id: 100,
                node_type: Some("FUNCTION".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("funcA".to_string()),
                file: Some("test.js".to_string()),
                metadata: None,
            },
            NodeRecord {
                id: 200,
                node_type: Some("CLASS".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: true,
                replaces: None,
                deleted: false,
                name: Some("ClassB".to_string()),
                file: Some("test.js".to_string()),
                metadata: None,
            },
            NodeRecord {
                id: 300,
                node_type: Some("VARIABLE".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: true, // deleted node
                name: Some("varC".to_string()),
                file: None,
                metadata: None,
            },
        ];

        let writer = SegmentWriter::new(db_path);
        writer.write_nodes(&nodes).unwrap();

        // Open the segment
        let segment = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();
        assert_eq!(segment.node_count(), 3);

        // Rebuild index
        let mut index = IndexSet::new();
        index.rebuild_from_segment(&segment);

        // All nodes should be indexed (including deleted)
        assert_eq!(index.find_node_index(100), Some(0));
        assert_eq!(index.find_node_index(200), Some(1));
        assert_eq!(index.find_node_index(300), Some(2)); // deleted but still indexed

        // Non-existent ID
        assert_eq!(index.find_node_index(999), None);
    }

    #[test]
    fn test_rebuild_replaces_previous_index() {
        use tempfile::tempdir;
        use crate::storage::{NodeRecord, SegmentWriter};
        use crate::storage::segment::NodesSegment;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path();

        // First segment
        let nodes1 = vec![NodeRecord {
            id: 10,
            node_type: Some("A".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: None,
            file: None,
            metadata: None,
        }];

        let writer = SegmentWriter::new(db_path);
        writer.write_nodes(&nodes1).unwrap();

        let segment1 = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        let mut index = IndexSet::new();
        index.rebuild_from_segment(&segment1);
        assert_eq!(index.find_node_index(10), Some(0));

        // Second segment (different nodes)
        let nodes2 = vec![
            NodeRecord {
                id: 20,
                node_type: Some("B".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: None,
                file: None,
                metadata: None,
            },
            NodeRecord {
                id: 30,
                node_type: Some("C".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: None,
                file: None,
                metadata: None,
            },
        ];

        // Close the first segment by dropping it
        drop(segment1);

        writer.write_nodes(&nodes2).unwrap();
        let segment2 = NodesSegment::open(&db_path.join("nodes.bin")).unwrap();

        // Rebuild with new segment
        index.rebuild_from_segment(&segment2);

        // Old ID should be gone
        assert_eq!(index.find_node_index(10), None);
        // New IDs should be present
        assert_eq!(index.find_node_index(20), Some(0));
        assert_eq!(index.find_node_index(30), Some(1));
    }
}
