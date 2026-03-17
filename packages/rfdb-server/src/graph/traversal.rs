//! Граф traversal алгоритмы

use std::collections::{HashSet, VecDeque};

/// BFS traversal от start нод
pub fn bfs<F>(
    start: &[u128],
    max_depth: usize,
    mut get_neighbors: F,
) -> Vec<u128>
where
    F: FnMut(u128) -> Vec<u128>,
{
    let mut visited = HashSet::new();
    let mut queue = VecDeque::from_iter(start.iter().copied());
    let mut result = Vec::new();
    let mut depth = 0;

    while !queue.is_empty() && depth <= max_depth {
        let level_size = queue.len();

        for _ in 0..level_size {
            if let Some(node) = queue.pop_front() {
                if !visited.insert(node) {
                    continue;
                }

                result.push(node);

                // Добавляем соседей в очередь
                for neighbor in get_neighbors(node) {
                    if !visited.contains(&neighbor) {
                        queue.push_back(neighbor);
                    }
                }
            }
        }

        depth += 1;
    }

    result
}

/// DFS traversal (для обратной трассировки)
pub fn dfs<F>(
    start: &[u128],
    max_depth: usize,
    mut get_neighbors: F,
) -> Vec<u128>
where
    F: FnMut(u128) -> Vec<u128>,
{
    let mut visited = HashSet::new();
    let mut stack = Vec::from_iter(start.iter().map(|&id| (id, 0)));
    let mut result = Vec::new();

    while let Some((node, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }

        if !visited.insert(node) {
            continue;
        }

        result.push(node);

        // Добавляем соседей в stack
        for neighbor in get_neighbors(node) {
            if !visited.contains(&neighbor) {
                stack.push((neighbor, depth + 1));
            }
        }
    }

    result
}

/// Result of a subgraph extraction: collected nodes, edges, and frontier (dangling edges).
#[derive(Debug, Clone)]
pub struct SubgraphResult {
    /// IDs of all visited nodes within this shard
    pub node_ids: Vec<u128>,
    /// All edges traversed (src, dst, edge_type) within this shard
    pub edges: Vec<(u128, u128, String)>,
    /// Frontier: edges whose target node doesn't exist in the store.
    /// These are potential cross-shard references.
    /// Format: (source_id, target_id, edge_type, metadata)
    pub frontier: Vec<(u128, u128, String, String)>,
}

/// Extract a reachable subgraph from entry points, collecting nodes, edges, and frontier.
///
/// Unlike BFS which only returns node IDs, this collects the full subgraph structure
/// and identifies dangling edges (frontier) — edges pointing to nodes that don't exist
/// in the local store. These are candidates for cross-shard resolution in federation mode.
///
/// - `get_edges`: returns (neighbor_id, edge_type, metadata) tuples for a node (directional)
/// - `node_exists`: checks if a node ID exists in the local store
pub fn subgraph<F, E>(
    start: &[u128],
    max_depth: usize,
    mut get_edges: F,
    mut node_exists: E,
) -> SubgraphResult
where
    F: FnMut(u128) -> Vec<(u128, String, String)>,  // (neighbor_id, edge_type, metadata)
    E: FnMut(u128) -> bool,
{
    let mut visited = HashSet::new();
    let mut queue: VecDeque<(u128, usize)> = VecDeque::new();
    let mut result_nodes = Vec::new();
    let mut result_edges = Vec::new();
    let mut frontier = Vec::new();

    // Seed the queue with entry points
    for &id in start {
        if visited.insert(id) {
            queue.push_back((id, 0));
            result_nodes.push(id);
        }
    }

    while let Some((node_id, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        for (neighbor_id, edge_type, metadata) in get_edges(node_id) {
            if node_exists(neighbor_id) {
                // Local node — collect edge and continue traversal
                result_edges.push((node_id, neighbor_id, edge_type));
                if visited.insert(neighbor_id) {
                    result_nodes.push(neighbor_id);
                    queue.push_back((neighbor_id, depth + 1));
                }
            } else {
                // Dangling edge — target doesn't exist locally → frontier
                frontier.push((node_id, neighbor_id, edge_type, metadata));
            }
        }
    }

    SubgraphResult {
        node_ids: result_nodes,
        edges: result_edges,
        frontier,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_bfs_simple_graph() {
        // Граф: 1 -> 2 -> 3
        //       1 -> 4
        let edges: HashMap<u128, Vec<u128>> = [
            (1, vec![2, 4]),
            (2, vec![3]),
            (3, vec![]),
            (4, vec![]),
        ]
        .iter()
        .cloned()
        .collect();

        let result = bfs(&[1], 10, |id| {
            edges.get(&id).cloned().unwrap_or_default()
        });

        assert_eq!(result.len(), 4);
        assert!(result.contains(&1));
        assert!(result.contains(&2));
        assert!(result.contains(&3));
        assert!(result.contains(&4));
    }

    #[test]
    fn test_bfs_max_depth() {
        // Граф: 1 -> 2 -> 3 -> 4
        let edges: HashMap<u128, Vec<u128>> = [
            (1, vec![2]),
            (2, vec![3]),
            (3, vec![4]),
            (4, vec![]),
        ]
        .iter()
        .cloned()
        .collect();

        let result = bfs(&[1], 2, |id| {
            edges.get(&id).cloned().unwrap_or_default()
        });

        // Должны дойти только до глубины 2: 1, 2, 3
        assert_eq!(result.len(), 3);
        assert!(!result.contains(&4));
    }

    #[test]
    fn test_subgraph_with_frontier() {
        // Local nodes: 1, 2, 3
        // Node 99 does NOT exist locally (dangling / cross-shard)
        //
        // Graph: 1 --CALLS--> 2 --CALLS--> 3
        //        1 --IMPORTS_FROM--> 99 (dangling, with metadata)
        //        3 --CALLS--> 99 (dangling)
        let local_nodes: HashSet<u128> = [1, 2, 3].iter().copied().collect();

        let edges: HashMap<u128, Vec<(u128, String, String)>> = [
            (1, vec![
                (2, "CALLS".to_string(), String::new()),
                (99, "IMPORTS_FROM".to_string(), r#"{"source":"@pkg/api"}"#.to_string()),
            ]),
            (2, vec![(3, "CALLS".to_string(), String::new())]),
            (3, vec![(99, "CALLS".to_string(), String::new())]),
        ].iter().cloned().collect();

        let result = subgraph(
            &[1],
            10,
            |id| edges.get(&id).cloned().unwrap_or_default(),
            |id| local_nodes.contains(&id),
        );

        // All 3 local nodes visited
        assert_eq!(result.node_ids.len(), 3);
        assert!(result.node_ids.contains(&1));
        assert!(result.node_ids.contains(&2));
        assert!(result.node_ids.contains(&3));

        // 2 internal edges
        assert_eq!(result.edges.len(), 2);

        // 2 frontier edges (both point to node 99)
        assert_eq!(result.frontier.len(), 2);
        assert!(result.frontier.iter().all(|(_, dst, _, _)| *dst == 99));
        // Check edge types
        let frontier_types: HashSet<&str> = result.frontier.iter().map(|(_, _, t, _)| t.as_str()).collect();
        assert!(frontier_types.contains("IMPORTS_FROM"));
        assert!(frontier_types.contains("CALLS"));
        // Check metadata preserved on frontier
        let imports_edge = result.frontier.iter().find(|(_, _, t, _)| t == "IMPORTS_FROM").unwrap();
        assert!(imports_edge.3.contains("@pkg/api"));
    }

    #[test]
    fn test_subgraph_fan_in_dedup() {
        let local_nodes: HashSet<u128> = [1, 2, 3, 10, 20].iter().copied().collect();

        let edges: HashMap<u128, Vec<(u128, String, String)>> = [
            (1, vec![(10, "CALLS".to_string(), String::new())]),
            (2, vec![(10, "CALLS".to_string(), String::new())]),
            (3, vec![(10, "CALLS".to_string(), String::new())]),
            (10, vec![(20, "CALLS".to_string(), String::new())]),
            (20, vec![]),
        ].iter().cloned().collect();

        let result = subgraph(
            &[1, 2, 3],
            10,
            |id| edges.get(&id).cloned().unwrap_or_default(),
            |id| local_nodes.contains(&id),
        );

        assert_eq!(result.node_ids.len(), 5);
        assert_eq!(result.node_ids.iter().filter(|&&id| id == 10).count(), 1);
    }

    #[test]
    fn test_subgraph_depth_limit() {
        let local_nodes: HashSet<u128> = [1, 2, 3, 4, 5].iter().copied().collect();

        let edges: HashMap<u128, Vec<(u128, String, String)>> = [
            (1, vec![(2, "CALLS".to_string(), String::new())]),
            (2, vec![(3, "CALLS".to_string(), String::new())]),
            (3, vec![(4, "CALLS".to_string(), String::new())]),
            (4, vec![(5, "CALLS".to_string(), String::new())]),
        ].iter().cloned().collect();

        let result = subgraph(
            &[1],
            2,
            |id| edges.get(&id).cloned().unwrap_or_default(),
            |id| local_nodes.contains(&id),
        );

        assert_eq!(result.node_ids.len(), 3);
        assert!(!result.node_ids.contains(&4));
        assert!(!result.node_ids.contains(&5));
    }
}
