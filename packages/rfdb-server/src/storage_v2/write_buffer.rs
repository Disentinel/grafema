//! In-memory write buffer for accumulating records before flush.
//!
//! Analogous to an LSM-tree memtable. NOT sorted (L0 segments are unsorted).
//! NOT Send+Sync -- single-writer access assumed.
//!
//! Nodes are keyed by id (u128) for O(1) point lookup + upsert semantics.
//! Edges are stored in a Vec with upsert semantics on (src, dst, edge_type).

use std::collections::{HashMap, HashSet};

use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};

/// Result of a single edge upsert operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeWriteOp {
    /// A new edge key was inserted into the buffer.
    Inserted,
    /// An existing edge record was updated in place (same src, dst, edge_type).
    Updated,
}

/// Aggregate stats from a batch edge upsert operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpsertStats {
    /// Number of new edge keys inserted.
    pub inserted: usize,
    /// Number of existing edge records updated in place.
    pub updated: usize,
}

/// In-memory accumulation buffer for records before flush.
///
/// Analogous to LSM-tree memtable. NOT sorted (L0 segments are unsorted).
/// NOT Send+Sync -- single-writer access assumed.
///
/// Nodes are keyed by id (u128) for O(1) point lookup + upsert semantics.
/// Edges are stored in a Vec with upsert semantics on (src, dst, edge_type).
pub struct WriteBuffer {
    /// Nodes keyed by u128 id. Upsert: adding a node with an existing id
    /// replaces the previous record (same as v1 delta_nodes pattern).
    nodes: HashMap<u128, NodeRecordV2>,

    /// Edge storage. Linear scan for queries is acceptable because the
    /// buffer is small (flushed regularly).
    edges: Vec<EdgeRecordV2>,

    /// Edge dedup key: (src, dst, edge_type). Matches v1 engine's
    /// `edge_keys: HashSet<(u128, u128, String)>` pattern.
    edge_keys: HashSet<(u128, u128, String)>,
}

impl WriteBuffer {
    // -- Constructors ---------------------------------------------------------

    /// Create empty write buffer.
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: Vec::new(),
            edge_keys: HashSet::new(),
        }
    }

    // -- Write Operations -----------------------------------------------------

    /// Add a single node. Upsert: if id already exists, replaces.
    pub fn add_node(&mut self, record: NodeRecordV2) {
        self.nodes.insert(record.id, record);
    }

    /// Add multiple nodes. Each is upserted individually.
    pub fn add_nodes(&mut self, records: Vec<NodeRecordV2>) {
        for record in records {
            self.add_node(record);
        }
    }

    /// Upsert a single edge.
    ///
    /// If (src, dst, edge_type) already exists in buffer, replaces the
    /// existing record metadata (upsert).
    ///
    /// Returns `EdgeWriteOp::Inserted` if a new edge key was inserted,
    /// `EdgeWriteOp::Updated` if an existing edge record was updated in place.
    pub fn upsert_edge(&mut self, record: EdgeRecordV2) -> EdgeWriteOp {
        let key = (record.src, record.dst, record.edge_type.clone());
        if self.edge_keys.insert(key) {
            self.edges.push(record);
            EdgeWriteOp::Inserted
        } else {
            if let Some(existing) = self.edges.iter_mut().find(|edge| {
                edge.src == record.src &&
                edge.dst == record.dst &&
                edge.edge_type == record.edge_type
            }) {
                *existing = record;
            }
            EdgeWriteOp::Updated
        }
    }

    /// Upsert multiple edges. Each is deduped individually.
    ///
    /// Returns `UpsertStats` with counts of inserted vs updated edges.
    pub fn upsert_edges(&mut self, records: Vec<EdgeRecordV2>) -> UpsertStats {
        let mut stats = UpsertStats { inserted: 0, updated: 0 };
        for record in records {
            match self.upsert_edge(record) {
                EdgeWriteOp::Inserted => stats.inserted += 1,
                EdgeWriteOp::Updated => stats.updated += 1,
            }
        }
        stats
    }

    // -- Read Operations (for merge with segments) ----------------------------

    /// Point lookup by node id. O(1).
    pub fn get_node(&self, id: u128) -> Option<&NodeRecordV2> {
        self.nodes.get(&id)
    }

    /// Iterator over all buffered nodes.
    pub fn iter_nodes(&self) -> impl Iterator<Item = &NodeRecordV2> {
        self.nodes.values()
    }

    /// Iterator over all buffered edges.
    pub fn iter_edges(&self) -> impl Iterator<Item = &EdgeRecordV2> {
        self.edges.iter()
    }

    // -- Query Support --------------------------------------------------------

    /// Find all nodes with matching node_type. O(N_buf).
    pub fn find_nodes_by_type(&self, node_type: &str) -> Vec<&NodeRecordV2> {
        self.nodes
            .values()
            .filter(|n| n.node_type == node_type)
            .collect()
    }

    /// Find all nodes with matching file. O(N_buf).
    pub fn find_nodes_by_file(&self, file: &str) -> Vec<&NodeRecordV2> {
        self.nodes.values().filter(|n| n.file == file).collect()
    }

    /// Find all edges with matching src. O(E_buf).
    pub fn find_edges_by_src(&self, src: u128) -> Vec<&EdgeRecordV2> {
        self.edges.iter().filter(|e| e.src == src).collect()
    }

    /// Find all edges with matching dst. O(E_buf).
    pub fn find_edges_by_dst(&self, dst: u128) -> Vec<&EdgeRecordV2> {
        self.edges.iter().filter(|e| e.dst == dst).collect()
    }

    /// Find all edges with matching edge_type. O(E_buf).
    pub fn find_edges_by_type(&self, edge_type: &str) -> Vec<&EdgeRecordV2> {
        self.edges
            .iter()
            .filter(|e| e.edge_type == edge_type)
            .collect()
    }

    // -- Buffer Management ----------------------------------------------------

    /// Number of nodes in buffer.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Number of edges in buffer.
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// True if buffer contains no nodes AND no edges.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.edges.is_empty()
    }

    /// Remove and return all nodes, leaving buffer empty for nodes.
    /// Also clears the node HashMap.
    pub fn drain_nodes(&mut self) -> Vec<NodeRecordV2> {
        self.nodes.drain().map(|(_, v)| v).collect()
    }

    /// Remove and return all edges, leaving buffer empty for edges.
    /// Also clears the edge_keys HashSet.
    pub fn drain_edges(&mut self) -> Vec<EdgeRecordV2> {
        self.edge_keys.clear();
        std::mem::take(&mut self.edges)
    }
}

impl Default for WriteBuffer {
    fn default() -> Self {
        Self::new()
    }
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
        let hash = blake3::hash(semantic_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        NodeRecordV2 {
            semantic_id: semantic_id.to_string(),
            id,
            node_type: node_type.to_string(),
            name: name.to_string(),
            file: file.to_string(),
            content_hash: 0,
            metadata: String::new(),
        }
    }

    fn make_edge(src_id: &str, dst_id: &str, edge_type: &str) -> EdgeRecordV2 {
        let src = u128::from_le_bytes(
            blake3::hash(src_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        let dst = u128::from_le_bytes(
            blake3::hash(dst_id.as_bytes()).as_bytes()[0..16]
                .try_into()
                .unwrap(),
        );
        EdgeRecordV2 {
            src,
            dst,
            edge_type: edge_type.to_string(),
            metadata: String::new(),
        }
    }

    #[test]
    fn test_empty_buffer() {
        let buf = WriteBuffer::new();
        assert!(buf.is_empty());
        assert_eq!(buf.node_count(), 0);
        assert_eq!(buf.edge_count(), 0);
        assert_eq!(buf.iter_nodes().count(), 0);
        assert_eq!(buf.iter_edges().count(), 0);
    }

    #[test]
    fn test_add_get_node_roundtrip() {
        let mut buf = WriteBuffer::new();
        let node = make_node("src/main.rs::main", "FUNCTION", "main", "src/main.rs");
        let id = node.id;

        buf.add_node(node.clone());

        assert_eq!(buf.node_count(), 1);
        assert!(!buf.is_empty());

        let got = buf.get_node(id).unwrap();
        assert_eq!(got, &node);
    }

    #[test]
    fn test_upsert_edges() {
        let mut buf = WriteBuffer::new();
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src2", "dst2", "IMPORTS_FROM");

        assert_eq!(buf.upsert_edge(e1.clone()), EdgeWriteOp::Inserted);
        assert_eq!(buf.upsert_edge(e2.clone()), EdgeWriteOp::Inserted);

        assert_eq!(buf.edge_count(), 2);
        let edges: Vec<&EdgeRecordV2> = buf.iter_edges().collect();
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0], &e1);
        assert_eq!(edges[1], &e2);
    }

    #[test]
    fn test_node_upsert() {
        let mut buf = WriteBuffer::new();
        let node1 = make_node("src/main.rs::main", "FUNCTION", "main", "src/main.rs");
        let id = node1.id;

        buf.add_node(node1);
        assert_eq!(buf.node_count(), 1);
        assert_eq!(buf.get_node(id).unwrap().node_type, "FUNCTION");

        // Upsert with same semantic_id (same id) but different type
        let mut node2 = make_node("src/main.rs::main", "METHOD", "main", "src/main.rs");
        node2.content_hash = 42;
        buf.add_node(node2);

        assert_eq!(buf.node_count(), 1);
        let got = buf.get_node(id).unwrap();
        assert_eq!(got.node_type, "METHOD");
        assert_eq!(got.content_hash, 42);
    }

    #[test]
    fn test_edge_dedup() {
        let mut buf = WriteBuffer::new();
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src1", "dst1", "CALLS"); // same (src, dst, type)

        assert_eq!(buf.upsert_edge(e1), EdgeWriteOp::Inserted);
        assert_eq!(buf.upsert_edge(e2), EdgeWriteOp::Updated); // duplicate, updated

        assert_eq!(buf.edge_count(), 1);
    }

    #[test]
    fn test_edge_upsert_replaces_metadata() {
        let mut buf = WriteBuffer::new();
        let mut e1 = make_edge("src1", "dst1", "FLOWS_INTO");
        e1.metadata = r#"{"resolutionStatus":"UNKNOWN_RUNTIME"}"#.to_string();

        let mut e2 = make_edge("src1", "dst1", "FLOWS_INTO");
        e2.metadata = r#"{"resolutionStatus":"RESOLVED"}"#.to_string();

        assert_eq!(buf.upsert_edge(e1), EdgeWriteOp::Inserted);
        assert_eq!(buf.upsert_edge(e2.clone()), EdgeWriteOp::Updated); // upsert existing key

        assert_eq!(buf.edge_count(), 1);
        let stored = buf.iter_edges().next().unwrap();
        assert_eq!(stored.metadata, e2.metadata);
    }

    #[test]
    fn test_query_by_type_file_src_dst() {
        let mut buf = WriteBuffer::new();

        buf.add_node(make_node("id1", "FUNCTION", "fn1", "src/main.rs"));
        buf.add_node(make_node("id2", "CLASS", "cls1", "src/main.rs"));
        buf.add_node(make_node("id3", "FUNCTION", "fn2", "src/lib.rs"));

        // find_nodes_by_type
        let fns = buf.find_nodes_by_type("FUNCTION");
        assert_eq!(fns.len(), 2);
        let classes = buf.find_nodes_by_type("CLASS");
        assert_eq!(classes.len(), 1);

        // find_nodes_by_file
        let main_nodes = buf.find_nodes_by_file("src/main.rs");
        assert_eq!(main_nodes.len(), 2);
        let lib_nodes = buf.find_nodes_by_file("src/lib.rs");
        assert_eq!(lib_nodes.len(), 1);

        // Edges
        let e1 = make_edge("id1", "id2", "CALLS");
        let e2 = make_edge("id1", "id3", "IMPORTS_FROM");
        let e3 = make_edge("id3", "id2", "CALLS");
        buf.upsert_edge(e1.clone());
        buf.upsert_edge(e2.clone());
        buf.upsert_edge(e3.clone());

        // find_edges_by_src
        let from_id1 = buf.find_edges_by_src(e1.src);
        assert_eq!(from_id1.len(), 2);

        // find_edges_by_dst
        let to_id2 = buf.find_edges_by_dst(e1.dst);
        assert_eq!(to_id2.len(), 2); // e1 and e3 both go to id2

        // find_edges_by_type
        let calls = buf.find_edges_by_type("CALLS");
        assert_eq!(calls.len(), 2);
        let imports = buf.find_edges_by_type("IMPORTS_FROM");
        assert_eq!(imports.len(), 1);
    }

    #[test]
    fn test_drain_empties_buffer() {
        let mut buf = WriteBuffer::new();
        buf.add_node(make_node("id1", "FUNCTION", "fn1", "file.rs"));
        buf.add_node(make_node("id2", "CLASS", "cls1", "file.rs"));
        buf.upsert_edge(make_edge("id1", "id2", "CALLS"));
        buf.upsert_edge(make_edge("id2", "id1", "IMPORTS_FROM"));

        assert_eq!(buf.node_count(), 2);
        assert_eq!(buf.edge_count(), 2);

        let drained_nodes = buf.drain_nodes();
        assert_eq!(drained_nodes.len(), 2);
        assert_eq!(buf.node_count(), 0);

        let drained_edges = buf.drain_edges();
        assert_eq!(drained_edges.len(), 2);
        assert_eq!(buf.edge_count(), 0);

        assert!(buf.is_empty());
    }

    #[test]
    fn test_multiple_edge_types_same_endpoints() {
        let mut buf = WriteBuffer::new();
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src1", "dst1", "IMPORTS_FROM");

        assert_eq!(buf.upsert_edge(e1), EdgeWriteOp::Inserted);
        assert_eq!(buf.upsert_edge(e2), EdgeWriteOp::Inserted); // different edge_type, should be inserted

        assert_eq!(buf.edge_count(), 2);
    }

    #[test]
    fn test_upsert_edges_batch_stats() {
        let mut buf = WriteBuffer::new();
        let e1 = make_edge("src1", "dst1", "CALLS");
        let e2 = make_edge("src2", "dst2", "IMPORTS_FROM");
        let e3 = make_edge("src1", "dst1", "CALLS"); // duplicate of e1

        let stats = buf.upsert_edges(vec![e1, e2, e3]);
        assert_eq!(stats, UpsertStats { inserted: 2, updated: 1 });
        assert_eq!(buf.edge_count(), 2);
    }
}
