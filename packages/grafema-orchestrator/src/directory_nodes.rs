//! Directory and File node builder.
//!
//! Creates structural nodes for the project hierarchy:
//! - DIRECTORY nodes (one per directory)
//! - FILE nodes (one per discovered source file)
//! - CONTAINS edges: directory → directory, directory → file
//!
//! These nodes give the visualization a stable structural perspective
//! independent of the semantic graph (functions, classes, etc.).
//! Used for hierarchical LOD: zoom out shows directories, zoom in shows files.

use std::collections::HashSet;
use std::path::Path;

use crate::rfdb::{WireNode, WireEdge};

/// Synthetic file path used for cleanup of stale directory/file nodes.
pub const SYNTHETIC_FILE: &str = "__grafema_virtual/directory-structure";

/// Build DIRECTORY and FILE nodes from a list of discovered file paths.
///
/// Returns (nodes, edges) ready for `rfdb.commit_batch`.
///
/// The input paths should be relative to the project root.
/// Directory hierarchy is reconstructed from path segments.
pub fn build(files: &[String]) -> (Vec<WireNode>, Vec<WireEdge>) {
    if files.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut nodes: Vec<WireNode> = Vec::new();
    let mut edges: Vec<WireEdge> = Vec::new();
    let mut seen_dirs: HashSet<String> = HashSet::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();

    for file_path in files {
        // Skip absolute paths or empty
        if file_path.is_empty() || file_path.starts_with('/') {
            continue;
        }

        let normalized = file_path.replace('\\', "/");
        let path = Path::new(&normalized);

        // Build the directory chain from this file's path
        let mut parent_dir: Option<String> = None;
        let mut current_path = String::new();

        let parts: Vec<&str> = normalized.split('/').collect();
        if parts.is_empty() {
            continue;
        }

        // All parts except last are directories
        for (i, part) in parts.iter().enumerate() {
            if i == parts.len() - 1 {
                // Last segment is the file itself
                let file_id = format!("FILE->{}", normalized);
                let file_name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(part)
                    .to_string();

                nodes.push(WireNode {
                    id: file_id.clone(),
                    semantic_id: Some(file_id.clone()),
                    node_type: Some("FILE".to_string()),
                    name: Some(file_name),
                    file: Some(SYNTHETIC_FILE.to_string()),
                    exported: false,
                    metadata: Some(serde_json::json!({
                        "isVirtual": true,
                        "kind": "file",
                        "path": normalized,
                    }).to_string()),
                });

                // Edge: parent_dir → file
                if let Some(parent) = &parent_dir {
                    let edge_key = (parent.clone(), file_id.clone());
                    if seen_edges.insert(edge_key) {
                        edges.push(WireEdge {
                            src: parent.clone(),
                            dst: file_id,
                            edge_type: "CONTAINS".to_string(),
                            metadata: None,
                        });
                    }
                }
            } else {
                // Directory segment
                if !current_path.is_empty() {
                    current_path.push('/');
                }
                current_path.push_str(part);

                let dir_id = format!("DIRECTORY->{}", current_path);

                if seen_dirs.insert(dir_id.clone()) {
                    nodes.push(WireNode {
                        id: dir_id.clone(),
                        semantic_id: Some(dir_id.clone()),
                        node_type: Some("DIRECTORY".to_string()),
                        name: Some(part.to_string()),
                        file: Some(SYNTHETIC_FILE.to_string()),
                        exported: false,
                        metadata: Some(serde_json::json!({
                            "isVirtual": true,
                            "kind": "directory",
                            "path": current_path.clone(),
                        }).to_string()),
                    });
                }

                // Edge: parent_dir → current dir
                if let Some(parent) = &parent_dir {
                    let edge_key = (parent.clone(), dir_id.clone());
                    if seen_edges.insert(edge_key) {
                        edges.push(WireEdge {
                            src: parent.clone(),
                            dst: dir_id.clone(),
                            edge_type: "CONTAINS".to_string(),
                            metadata: None,
                        });
                    }
                }

                parent_dir = Some(dir_id);
            }
        }
    }

    (nodes, edges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_files() {
        let files = vec![
            "src/main.ts".to_string(),
            "src/utils.ts".to_string(),
        ];
        let (nodes, edges) = build(&files);

        // Expected nodes:
        // DIRECTORY->src
        // FILE->src/main.ts
        // FILE->src/utils.ts
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].id, "DIRECTORY->src");
        assert!(nodes.iter().any(|n| n.id == "FILE->src/main.ts"));
        assert!(nodes.iter().any(|n| n.id == "FILE->src/utils.ts"));

        // Expected edges:
        // DIRECTORY->src CONTAINS FILE->src/main.ts
        // DIRECTORY->src CONTAINS FILE->src/utils.ts
        assert_eq!(edges.len(), 2);
        assert!(edges.iter().all(|e| e.src == "DIRECTORY->src"));
    }

    #[test]
    fn test_nested_directories() {
        let files = vec![
            "packages/util/src/core/graph.ts".to_string(),
            "packages/util/src/core/edges.ts".to_string(),
            "packages/cli/src/main.ts".to_string(),
        ];
        let (nodes, edges) = build(&files);

        let dir_ids: Vec<&String> = nodes.iter()
            .filter(|n| n.node_type.as_deref() == Some("DIRECTORY"))
            .map(|n| &n.id)
            .collect();

        assert!(dir_ids.contains(&&"DIRECTORY->packages".to_string()));
        assert!(dir_ids.contains(&&"DIRECTORY->packages/util".to_string()));
        assert!(dir_ids.contains(&&"DIRECTORY->packages/util/src".to_string()));
        assert!(dir_ids.contains(&&"DIRECTORY->packages/util/src/core".to_string()));
        assert!(dir_ids.contains(&&"DIRECTORY->packages/cli".to_string()));
        assert!(dir_ids.contains(&&"DIRECTORY->packages/cli/src".to_string()));

        // CONTAINS chain: packages → util → src → core → graph.ts
        let chain_edges: Vec<&WireEdge> = edges.iter()
            .filter(|e| e.src == "DIRECTORY->packages")
            .collect();
        assert!(chain_edges.iter().any(|e| e.dst == "DIRECTORY->packages/util"));
        assert!(chain_edges.iter().any(|e| e.dst == "DIRECTORY->packages/cli"));
    }

    #[test]
    fn test_file_node_metadata() {
        let files = vec!["src/foo.ts".to_string()];
        let (nodes, _) = build(&files);
        let file_node = nodes.iter().find(|n| n.node_type.as_deref() == Some("FILE")).unwrap();
        assert_eq!(file_node.name, Some("foo.ts".to_string()));
        assert_eq!(file_node.file, Some(SYNTHETIC_FILE.to_string()));
        let meta: serde_json::Value = serde_json::from_str(file_node.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["kind"], "file");
        assert_eq!(meta["path"], "src/foo.ts");
    }

    #[test]
    fn test_dedup_directories() {
        // Same directory mentioned by multiple files — should only get one node
        let files = vec![
            "src/a.ts".to_string(),
            "src/b.ts".to_string(),
            "src/c.ts".to_string(),
        ];
        let (nodes, _) = build(&files);
        let src_dirs: Vec<_> = nodes.iter().filter(|n| n.id == "DIRECTORY->src").collect();
        assert_eq!(src_dirs.len(), 1);
    }

    #[test]
    fn test_empty_input() {
        let (nodes, edges) = build(&[]);
        assert!(nodes.is_empty());
        assert!(edges.is_empty());
    }

    #[test]
    fn test_root_level_file() {
        let files = vec!["README.md".to_string()];
        let (nodes, edges) = build(&files);
        // Just a FILE node, no DIRECTORY
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "FILE->README.md");
        assert!(edges.is_empty());
    }
}
