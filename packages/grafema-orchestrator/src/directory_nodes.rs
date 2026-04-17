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

/// Build DIRECTORY and FILE nodes from a list of discovered file paths.
///
/// Returns (nodes, edges, cleanup_files):
/// - `nodes`: FILE and DIRECTORY nodes to commit
/// - `edges`: CONTAINS edges between parent → child
/// - `cleanup_files`: sentinel file paths (directory paths with trailing slash)
///   to pass as `changed_files` to `commit_batch`, so stale DIRECTORY nodes
///   get tombstoned on re-analysis. FILE nodes are upserted by semantic ID
///   and do not need cleanup entries (and must not — their `file` field is
///   the real source file path, which would wipe semantic nodes).
///
/// Each FILE node uses the real file path as its `file` field so that
/// `file_dir`-based container hierarchy groups FILE nodes with the semantic
/// nodes (FUNCTION, CLASS, etc.) from the same file into the same region.
///
/// Each DIRECTORY node uses "<dir_path>/" (with trailing slash) as its `file`
/// field. This makes the directory a sentinel path that doesn't collide with
/// any real source file, and `file_dir("src/api/")` strips the trailing slash
/// to return "src/api" — meaning the DIRECTORY node sits in the SAME region
/// as the files it contains, acting as the region centroid.
///
/// The input paths should be relative to the project root.
/// Directory hierarchy is reconstructed from path segments.
pub fn build(files: &[String]) -> (Vec<WireNode>, Vec<WireEdge>, Vec<String>) {
    if files.is_empty() {
        return (Vec::new(), Vec::new(), Vec::new());
    }

    let mut nodes: Vec<WireNode> = Vec::new();
    let mut edges: Vec<WireEdge> = Vec::new();
    let mut seen_dirs: HashSet<String> = HashSet::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    let mut cleanup_files: Vec<String> = Vec::new();

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
                    // Real file path: co-locates FILE node with FUNCTION/CLASS
                    // etc. in the same container region (via file_dir rule).
                    file: Some(normalized.clone()),
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
                // Sentinel file path — trailing slash prevents collision with
                // any real source file and makes file_dir(dir_file) return
                // current_path (parent's segment is stripped).
                let dir_file = format!("{}/", current_path);

                if seen_dirs.insert(dir_id.clone()) {
                    nodes.push(WireNode {
                        id: dir_id.clone(),
                        semantic_id: Some(dir_id.clone()),
                        node_type: Some("DIRECTORY".to_string()),
                        name: Some(part.to_string()),
                        file: Some(dir_file.clone()),
                        exported: false,
                        metadata: Some(serde_json::json!({
                            "isVirtual": true,
                            "kind": "directory",
                            "path": current_path.clone(),
                        }).to_string()),
                    });
                    cleanup_files.push(dir_file);
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

    (nodes, edges, cleanup_files)
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
        let (nodes, edges, cleanup) = build(&files);

        // Expected nodes: DIRECTORY->src + 2 FILE nodes
        assert_eq!(nodes.len(), 3);
        assert!(nodes.iter().any(|n| n.id == "DIRECTORY->src"));
        assert!(nodes.iter().any(|n| n.id == "FILE->src/main.ts"));
        assert!(nodes.iter().any(|n| n.id == "FILE->src/utils.ts"));

        // Expected edges:
        assert_eq!(edges.len(), 2);
        assert!(edges.iter().all(|e| e.src == "DIRECTORY->src"));

        // Only the directory sentinel shows up in cleanup list
        assert_eq!(cleanup, vec!["src/".to_string()]);
    }

    #[test]
    fn test_nested_directories() {
        let files = vec![
            "packages/util/src/core/graph.ts".to_string(),
            "packages/util/src/core/edges.ts".to_string(),
            "packages/cli/src/main.ts".to_string(),
        ];
        let (nodes, edges, cleanup) = build(&files);

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

        // Every directory contributes a "<dir>/" cleanup sentinel
        assert!(cleanup.contains(&"packages/".to_string()));
        assert!(cleanup.contains(&"packages/util/src/core/".to_string()));
    }

    #[test]
    fn test_file_node_metadata() {
        let files = vec!["src/foo.ts".to_string()];
        let (nodes, _, _) = build(&files);
        let file_node = nodes.iter().find(|n| n.node_type.as_deref() == Some("FILE")).unwrap();
        assert_eq!(file_node.name, Some("foo.ts".to_string()));
        // FILE node uses real file path — co-locates it with FUNCTION/CLASS
        // from the same file in region computation.
        assert_eq!(file_node.file, Some("src/foo.ts".to_string()));
        let meta: serde_json::Value = serde_json::from_str(file_node.metadata.as_ref().unwrap()).unwrap();
        assert_eq!(meta["kind"], "file");
        assert_eq!(meta["path"], "src/foo.ts");
    }

    #[test]
    fn test_directory_node_file_is_sentinel() {
        let files = vec!["src/api/user.ts".to_string()];
        let (nodes, _, _) = build(&files);
        let dir_api = nodes.iter()
            .find(|n| n.id == "DIRECTORY->src/api")
            .unwrap();
        // Trailing slash: file_dir("src/api/") = "src/api", placing the
        // DIRECTORY node in the same region as its contained files.
        assert_eq!(dir_api.file, Some("src/api/".to_string()));
    }

    #[test]
    fn test_dedup_directories() {
        // Same directory mentioned by multiple files — should only get one node
        let files = vec![
            "src/a.ts".to_string(),
            "src/b.ts".to_string(),
            "src/c.ts".to_string(),
        ];
        let (nodes, _, cleanup) = build(&files);
        let src_dirs: Vec<_> = nodes.iter().filter(|n| n.id == "DIRECTORY->src").collect();
        assert_eq!(src_dirs.len(), 1);
        // And its sentinel appears exactly once in cleanup.
        assert_eq!(cleanup.iter().filter(|f| *f == "src/").count(), 1);
    }

    #[test]
    fn test_empty_input() {
        let (nodes, edges, cleanup) = build(&[]);
        assert!(nodes.is_empty());
        assert!(edges.is_empty());
        assert!(cleanup.is_empty());
    }

    #[test]
    fn test_root_level_file() {
        let files = vec!["README.md".to_string()];
        let (nodes, edges, cleanup) = build(&files);
        // Just a FILE node, no DIRECTORY
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "FILE->README.md");
        assert!(edges.is_empty());
        // No directories → no cleanup sentinels
        assert!(cleanup.is_empty());
    }
}
