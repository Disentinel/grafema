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
}
