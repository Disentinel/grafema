//! Source-tagged deletion helpers for the RFDB server.
//!
//! Enables lifecycle management for synthetic nodes/edges emitted by
//! secondary writers (e.g. the per-symbol layout pack in DAI-22):
//! every writer stamps `_source: "<tag>"` into metadata, then calls
//! these helpers before a re-run to clear its own prior output without
//! touching analyzer-emitted data or another writer's output.

use crate::graph::GraphStore;

/// Result of a source-tagged edge deletion.
#[derive(Debug, Clone, Copy)]
pub struct DeleteEdgesOutcome {
    pub deleted: usize,
}

/// Result of a source-tagged node deletion.
#[derive(Debug, Clone, Copy)]
pub struct DeleteNodesOutcome {
    pub deleted_nodes: usize,
    pub deleted_outgoing_edges: usize,
}

/// Extract the value of `_source` from a flat JSON metadata string.
///
/// Returns `None` if the key is absent. Assumes the writer emits
/// unescaped string values (current convention for `layout-pack`).
fn extract_source_tag(metadata: &str) -> Option<&str> {
    let key = "\"_source\":\"";
    let start = metadata.find(key)? + key.len();
    let rest = &metadata[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Delete all edges of `edge_type` whose metadata contains `_source == source_tag`.
///
/// Fails loudly if any edge of `edge_type` carries `_source` with a value
/// different from `source_tag` — this signals a collision with another
/// writer using the same edge type, and silent overlap is worse than a
/// failed rerun. Edges without any `_source` key are untouched (unrelated).
pub fn delete_edges_by_type_and_source(
    engine: &mut dyn GraphStore,
    edge_type: &str,
    source_tag: &str,
) -> Result<DeleteEdgesOutcome, String> {
    let candidates = engine.get_edges_by_type(edge_type);
    let mut to_delete: Vec<(u128, u128, String)> = Vec::new();

    for edge in candidates {
        let md = match &edge.metadata {
            Some(m) => m.as_str(),
            None => continue,
        };
        match extract_source_tag(md) {
            Some(tag) if tag == source_tag => {
                to_delete.push((
                    edge.src,
                    edge.dst,
                    edge.edge_type.clone().unwrap_or_default(),
                ));
            }
            Some(other) => {
                return Err(format!(
                    "delete_edges_by_type_and_source: collision — edge_type={} has edge with _source={:?} (expected {:?} or absent); refusing to proceed",
                    edge_type, other, source_tag
                ));
            }
            None => continue,
        }
    }

    let deleted = to_delete.len();
    for (src, dst, et) in to_delete {
        engine.delete_edge(src, dst, &et);
    }

    engine.flush().map_err(|e| format!("flush failed: {}", e))?;
    Ok(DeleteEdgesOutcome { deleted })
}

/// Delete all nodes of `node_type` whose metadata contains `_source == source_tag`.
///
/// Also deletes outgoing edges from each matched node (mirrors the
/// deletion contract in `handle_commit_batch`). Fails loudly on a
/// `_source` collision, same as the edge variant.
pub fn delete_nodes_by_type_and_source(
    engine: &mut dyn GraphStore,
    node_type: &str,
    source_tag: &str,
) -> Result<DeleteNodesOutcome, String> {
    let candidate_ids = engine.find_by_type(node_type);
    let mut to_delete: Vec<u128> = Vec::new();

    for id in candidate_ids {
        let node = match engine.get_node(id) {
            Some(n) => n,
            None => continue,
        };
        let md = match &node.metadata {
            Some(m) => m.as_str(),
            None => continue,
        };
        match extract_source_tag(md) {
            Some(tag) if tag == source_tag => to_delete.push(id),
            Some(other) => {
                return Err(format!(
                    "delete_nodes_by_type_and_source: collision — node_type={} has node with _source={:?} (expected {:?} or absent); refusing to proceed",
                    node_type, other, source_tag
                ));
            }
            None => continue,
        }
    }

    let mut deleted_outgoing_edges: usize = 0;
    for id in &to_delete {
        for edge in engine.get_outgoing_edges(*id, None) {
            engine.delete_edge(
                edge.src,
                edge.dst,
                edge.edge_type.as_deref().unwrap_or(""),
            );
            deleted_outgoing_edges += 1;
        }
        engine.delete_node(*id);
    }

    engine.flush().map_err(|e| format!("flush failed: {}", e))?;
    Ok(DeleteNodesOutcome {
        deleted_nodes: to_delete.len(),
        deleted_outgoing_edges,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_source_tag_basic() {
        assert_eq!(
            extract_source_tag(r#"{"_source":"layout-pack","q":0}"#),
            Some("layout-pack")
        );
        assert_eq!(extract_source_tag(r#"{"q":0,"r":1}"#), None);
        assert_eq!(extract_source_tag(r#"{}"#), None);
    }
}
