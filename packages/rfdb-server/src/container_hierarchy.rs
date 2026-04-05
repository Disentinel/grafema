//! Declarative container hierarchy for LOD visualization.
//!
//! Defines a hierarchy of container levels (package → directory → file → symbol)
//! using composable rules. The resulting `ContainerTree` is used by the SA layout
//! engine for region assignment, gap enforcement, and edge aggregation.
//!
//! # Example
//!
//! ```
//! use rfdb::container_hierarchy::{HierarchyLevel, ContainerRule, ContainerTree};
//!
//! let hierarchy = vec![
//!     HierarchyLevel::new("package", ContainerRule::FilePrefix(2)),
//!     HierarchyLevel::new("directory", ContainerRule::FileDir),
//!     HierarchyLevel::new("file", ContainerRule::NodeType(vec!["MODULE".into()])),
//!     HierarchyLevel::new("symbol", ContainerRule::NodeType(vec![
//!         "FUNCTION".into(), "CLASS".into(), "METHOD".into(),
//!     ])),
//! ];
//!
//! let tree = ContainerTree::build(&hierarchy, &nodes, &edges);
//! let region = tree.sa_region(node_idx);
//! ```

use std::collections::HashMap;

/// A single level in the container hierarchy.
#[derive(Debug, Clone)]
pub struct HierarchyLevel {
    pub name: String,
    pub rule: ContainerRule,
}

impl HierarchyLevel {
    pub fn new(name: &str, rule: ContainerRule) -> Self {
        Self {
            name: name.to_string(),
            rule,
        }
    }
}

/// Rule that determines how nodes are grouped into containers at a given level.
#[derive(Debug, Clone)]
pub enum ContainerRule {
    /// Group by first N segments of the file path.
    /// `file_prefix(2)` on "packages/util/src/core/graph.ts" → "packages/util"
    FilePrefix(usize),

    /// Group by full directory path (everything before the last '/').
    /// "packages/util/src/core/graph.ts" → "packages/util/src/core"
    FileDir,

    /// Select nodes matching any of the given node types.
    /// These become the containers (real nodes from the graph).
    NodeType(Vec<String>),

    /// Group by a metadata field value.
    /// E.g., `metadata("namespace")` groups by C++/Rust namespace.
    Metadata(String),
}

/// A node reference for hierarchy building.
/// Lightweight struct — the actual data lives in GraphEngineV2.
#[derive(Debug, Clone)]
pub struct NodeRef {
    pub idx: u32,
    pub id: u128,
    pub node_type: String,
    pub file: String,
    pub name: String,
    pub metadata: Option<String>,
}

/// An edge reference for hierarchy building.
#[derive(Debug, Clone)]
pub struct EdgeRef {
    pub src_idx: u32,
    pub dst_idx: u32,
    pub edge_type: String,
}

/// Aggregated edge between containers.
#[derive(Debug, Clone)]
pub struct AggEdge {
    pub src_container: String,
    pub dst_container: String,
    pub count: u32,
    pub edge_types: HashMap<String, u32>,
}

/// A container node in the hierarchy.
#[derive(Debug, Clone)]
pub struct ContainerNode {
    pub id: String,
    pub level: usize,
    pub parent: Option<String>,
    pub child_count: u32,
}

/// The built container tree — maps nodes to their container chain.
#[derive(Debug)]
pub struct ContainerTree {
    /// level_idx → container_id → ContainerNode
    pub levels: Vec<HashMap<String, ContainerNode>>,

    /// node_idx → container ID at each level (indexed by level)
    /// membership[node_idx][level_idx] = container_id
    pub membership: Vec<Vec<String>>,

    /// The level used for SA region assignment (deepest level with >1 containers)
    pub sa_region_level: usize,

    /// Hierarchy level names for reference
    pub level_names: Vec<String>,
}

impl ContainerTree {
    /// Build the container tree from hierarchy rules and graph data.
    pub fn build(
        hierarchy: &[HierarchyLevel],
        nodes: &[NodeRef],
        _edges: &[EdgeRef],
    ) -> Self {
        let n = nodes.len();
        let num_levels = hierarchy.len();

        // membership[node_idx][level_idx] = container_id
        let mut membership: Vec<Vec<String>> = vec![vec![String::new(); num_levels]; n];

        // levels[level_idx] = map of container_id → ContainerNode
        let mut levels: Vec<HashMap<String, ContainerNode>> = Vec::with_capacity(num_levels);

        for (li, level) in hierarchy.iter().enumerate() {
            let mut containers: HashMap<String, ContainerNode> = HashMap::new();

            for node in nodes.iter() {
                let container_id = match &level.rule {
                    ContainerRule::FilePrefix(segments) => {
                        file_prefix(&node.file, *segments)
                    }
                    ContainerRule::FileDir => {
                        file_dir(&node.file)
                    }
                    ContainerRule::NodeType(types) => {
                        if types.iter().any(|t| t == &node.node_type) {
                            // Node IS the container — use its unique ID
                            format!("{}:{}", node.node_type, node.name)
                        } else {
                            // Node doesn't match this level — inherit from parent level
                            if li > 0 {
                                membership[node.idx as usize][li - 1].clone()
                            } else {
                                "_root".to_string()
                            }
                        }
                    }
                    ContainerRule::Metadata(key) => {
                        extract_metadata_value(&node.metadata, key)
                            .unwrap_or_else(|| "_unknown".to_string())
                    }
                };

                membership[node.idx as usize][li] = container_id.clone();

                let parent = if li > 0 {
                    Some(membership[node.idx as usize][li - 1].clone())
                } else {
                    None
                };

                containers
                    .entry(container_id.clone())
                    .and_modify(|c| c.child_count += 1)
                    .or_insert_with(|| ContainerNode {
                        id: container_id,
                        level: li,
                        parent,
                        child_count: 1,
                    });
            }

            levels.push(containers);
        }

        // Find the best level for SA regions:
        // the deepest level that has >1 containers and ≤ N/2 containers
        // (too many containers = each node is its own region = useless)
        let sa_region_level = (0..num_levels)
            .rev()
            .find(|&li| {
                let count = levels[li].len();
                count > 1 && count <= n / 2
            })
            .unwrap_or(0);

        let level_names = hierarchy.iter().map(|l| l.name.clone()).collect();

        ContainerTree {
            levels,
            membership,
            sa_region_level,
            level_names,
        }
    }

    /// Get the SA region for a node (container ID at the sa_region_level).
    pub fn sa_region(&self, node_idx: u32) -> &str {
        &self.membership[node_idx as usize][self.sa_region_level]
    }

    /// Get all unique region names for SA.
    pub fn sa_region_names(&self) -> Vec<String> {
        self.levels[self.sa_region_level]
            .keys()
            .cloned()
            .collect()
    }

    /// Get the container chain for a node (one ID per level).
    pub fn container_chain(&self, node_idx: u32) -> &[String] {
        &self.membership[node_idx as usize]
    }

    /// Aggregate edges between containers at a given hierarchy level.
    pub fn aggregate_edges(&self, level: usize, edges: &[EdgeRef]) -> Vec<AggEdge> {
        let mut agg: HashMap<(String, String), AggEdge> = HashMap::new();

        for edge in edges {
            let src_idx = edge.src_idx as usize;
            let dst_idx = edge.dst_idx as usize;

            if src_idx >= self.membership.len() || dst_idx >= self.membership.len() {
                continue;
            }

            let src_container = &self.membership[src_idx][level];
            let dst_container = &self.membership[dst_idx][level];

            // Skip intra-container edges
            if src_container == dst_container {
                continue;
            }

            // Canonical key (smaller first for dedup)
            let key = if src_container < dst_container {
                (src_container.clone(), dst_container.clone())
            } else {
                (dst_container.clone(), src_container.clone())
            };

            let entry = agg.entry(key.clone()).or_insert_with(|| AggEdge {
                src_container: key.0.clone(),
                dst_container: key.1.clone(),
                count: 0,
                edge_types: HashMap::new(),
            });
            entry.count += 1;
            *entry.edge_types.entry(edge.edge_type.clone()).or_insert(0) += 1;
        }

        agg.into_values().collect()
    }

    /// Get containers at a given level with their child counts.
    pub fn containers_at_level(&self, level: usize) -> &HashMap<String, ContainerNode> {
        &self.levels[level]
    }
}

// ── Helper functions ────────────────────────────────────────────────────

/// Extract first N path segments: "packages/util/src/core/file.ts" with N=2 → "packages/util"
fn file_prefix(file: &str, segments: usize) -> String {
    let parts: Vec<&str> = file.split('/').collect();
    if parts.len() <= segments {
        parts.join("/")
    } else {
        parts[..segments].join("/")
    }
}

/// Extract directory path: "packages/util/src/core/file.ts" → "packages/util/src/core"
fn file_dir(file: &str) -> String {
    match file.rfind('/') {
        Some(pos) => file[..pos].to_string(),
        None => "_root".to_string(),
    }
}

/// Extract a value from JSON metadata string by key.
fn extract_metadata_value(metadata: &Option<String>, key: &str) -> Option<String> {
    let meta_str = metadata.as_ref()?;
    let parsed: serde_json::Value = serde_json::from_str(meta_str).ok()?;
    parsed.get(key)?.as_str().map(|s| s.to_string())
}

/// Default hierarchy when none is specified.
pub fn default_hierarchy() -> Vec<HierarchyLevel> {
    vec![
        HierarchyLevel::new("package", ContainerRule::FilePrefix(2)),
        HierarchyLevel::new("directory", ContainerRule::FileDir),
        HierarchyLevel::new("file", ContainerRule::NodeType(vec!["MODULE".into()])),
        HierarchyLevel::new("symbol", ContainerRule::NodeType(vec![
            "FUNCTION".into(),
            "CLASS".into(),
            "METHOD".into(),
            "VARIABLE".into(),
            "INTERFACE".into(),
        ])),
    ]
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_nodes() -> Vec<NodeRef> {
        vec![
            NodeRef { idx: 0, id: 1, node_type: "MODULE".into(), file: "packages/util/src/core/graph.ts".into(), name: "graph.ts".into(), metadata: None },
            NodeRef { idx: 1, id: 2, node_type: "FUNCTION".into(), file: "packages/util/src/core/graph.ts".into(), name: "traverse".into(), metadata: None },
            NodeRef { idx: 2, id: 3, node_type: "FUNCTION".into(), file: "packages/util/src/core/graph.ts".into(), name: "search".into(), metadata: None },
            NodeRef { idx: 3, id: 4, node_type: "MODULE".into(), file: "packages/cli/src/commands/get.ts".into(), name: "get.ts".into(), metadata: None },
            NodeRef { idx: 4, id: 5, node_type: "FUNCTION".into(), file: "packages/cli/src/commands/get.ts".into(), name: "handleGet".into(), metadata: None },
            NodeRef { idx: 5, id: 6, node_type: "CLASS".into(), file: "packages/cli/src/commands/get.ts".into(), name: "GetCommand".into(), metadata: None },
        ]
    }

    fn make_edges() -> Vec<EdgeRef> {
        vec![
            EdgeRef { src_idx: 4, dst_idx: 1, edge_type: "CALLS".into() },
            EdgeRef { src_idx: 5, dst_idx: 2, edge_type: "CALLS".into() },
            EdgeRef { src_idx: 1, dst_idx: 2, edge_type: "CALLS".into() },
        ]
    }

    #[test]
    fn test_default_hierarchy_builds() {
        let nodes = make_nodes();
        let edges = make_edges();
        let hierarchy = default_hierarchy();
        let tree = ContainerTree::build(&hierarchy, &nodes, &edges);

        assert_eq!(tree.levels.len(), 4);
        assert_eq!(tree.level_names, vec!["package", "directory", "file", "symbol"]);
    }

    #[test]
    fn test_file_prefix_grouping() {
        let nodes = make_nodes();
        let edges = make_edges();
        let hierarchy = vec![HierarchyLevel::new("package", ContainerRule::FilePrefix(2))];
        let tree = ContainerTree::build(&hierarchy, &nodes, &edges);

        // Should produce 2 packages: "packages/util" and "packages/cli"
        assert_eq!(tree.levels[0].len(), 2);
        assert!(tree.levels[0].contains_key("packages/util"));
        assert!(tree.levels[0].contains_key("packages/cli"));

        // util has 3 nodes, cli has 3 nodes
        assert_eq!(tree.levels[0]["packages/util"].child_count, 3);
        assert_eq!(tree.levels[0]["packages/cli"].child_count, 3);
    }

    #[test]
    fn test_file_dir_grouping() {
        let nodes = make_nodes();
        let edges = make_edges();
        let hierarchy = vec![HierarchyLevel::new("dir", ContainerRule::FileDir)];
        let tree = ContainerTree::build(&hierarchy, &nodes, &edges);

        // Two directories
        assert_eq!(tree.levels[0].len(), 2);
        assert!(tree.levels[0].contains_key("packages/util/src/core"));
        assert!(tree.levels[0].contains_key("packages/cli/src/commands"));
    }

    #[test]
    fn test_sa_region_assignment() {
        let nodes = make_nodes();
        let edges = make_edges();
        let hierarchy = default_hierarchy();
        let tree = ContainerTree::build(&hierarchy, &nodes, &edges);

        // SA region should be at a useful level (not too granular, not too broad)
        let region_0 = tree.sa_region(0);
        let region_4 = tree.sa_region(4);
        assert!(!region_0.is_empty());
        assert!(!region_4.is_empty());
        // Nodes in different packages should have different regions
        assert_ne!(tree.sa_region(1), tree.sa_region(4));
    }

    #[test]
    fn test_edge_aggregation() {
        let nodes = make_nodes();
        let edges = make_edges();
        let hierarchy = vec![HierarchyLevel::new("package", ContainerRule::FilePrefix(2))];
        let tree = ContainerTree::build(&hierarchy, &nodes, &edges);

        let agg = tree.aggregate_edges(0, &edges);

        // 2 cross-package CALLS edges (idx 4→1 and 5→2), 1 intra-package (1→2)
        assert_eq!(agg.len(), 1); // one pair: util ↔ cli
        assert_eq!(agg[0].count, 2); // 2 cross-package edges
    }

    #[test]
    fn test_container_chain() {
        let nodes = make_nodes();
        let edges = make_edges();
        let hierarchy = default_hierarchy();
        let tree = ContainerTree::build(&hierarchy, &nodes, &edges);

        let chain = tree.container_chain(1); // "traverse" function
        assert_eq!(chain.len(), 4);
        assert_eq!(chain[0], "packages/util"); // package level
        assert_eq!(chain[1], "packages/util/src/core"); // directory level
    }

    #[test]
    fn test_file_prefix_helper() {
        assert_eq!(file_prefix("packages/util/src/core/graph.ts", 2), "packages/util");
        assert_eq!(file_prefix("packages/util/src/core/graph.ts", 1), "packages");
        assert_eq!(file_prefix("src/main.ts", 2), "src/main.ts");
        assert_eq!(file_prefix("main.ts", 1), "main.ts");
    }

    #[test]
    fn test_file_dir_helper() {
        assert_eq!(file_dir("packages/util/src/core/graph.ts"), "packages/util/src/core");
        assert_eq!(file_dir("main.ts"), "_root");
    }
}
