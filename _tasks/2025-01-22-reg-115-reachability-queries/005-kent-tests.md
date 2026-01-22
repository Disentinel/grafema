# Kent Beck's Test Report: REG-115 Reachability Queries

## Test Design Philosophy

Tests should:
1. **Communicate intent clearly** - Each test name explains what behavior it verifies
2. **Follow existing patterns** - Use `tempfile::tempdir()`, `GraphEngine::create()`
3. **Test edge cases first** - Empty inputs, cycles, persistence
4. **Be independent** - Each test creates its own graph state

## Test Cases

| Test | Purpose |
|------|---------|
| `test_reverse_adjacency_basic` | reverse_neighbors() returns correct sources |
| `test_reachability_forward` | Forward traversal with depth limit |
| `test_reachability_backward` | Backward traversal (find sources) |
| `test_reachability_with_cycles` | Diamond pattern (no infinite loops) |
| `test_reverse_adjacency_persists_after_flush` | Persistence across flush/reopen |
| `test_reachability_edge_type_filter` | Only traverse specified edge types |
| `test_reachability_empty_start` | Empty start returns empty result |
| `test_reachability_depth_zero` | max_depth=0 returns only start nodes |
| `test_reachability_nonexistent_start` | Non-existent node handled gracefully |

## Complete Test Code

Add to `#[cfg(test)] mod tests` in `rust-engine/src/graph/engine.rs`:

```rust
// ============================================================
// REG-115: Reachability Queries Tests
// ============================================================

/// Helper function to create a test node
fn make_test_node(id: u128, name: &str, node_type: &str) -> NodeRecord {
    NodeRecord {
        id,
        node_type: Some(node_type.to_string()),
        file_id: 0,
        name_offset: 0,
        version: "main".to_string(),
        exported: false,
        replaces: None,
        deleted: false,
        name: Some(name.to_string()),
        file: Some("test.js".to_string()),
        metadata: None,
    }
}

/// Helper function to create a test edge
fn make_test_edge(src: u128, dst: u128, edge_type: &str) -> EdgeRecord {
    EdgeRecord {
        src,
        dst,
        edge_type: Some(edge_type.to_string()),
        version: "main".to_string(),
        metadata: None,
        deleted: false,
    }
}

#[test]
fn test_reverse_adjacency_basic() {
    // Graph: A --CALLS--> B, C --CALLS--> B, D --IMPORTS--> B
    // reverse_neighbors(B, ["CALLS"]) should return [A, C] (not D)

    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test_reverse_adj");

    let mut engine = GraphEngine::create(&db_path).unwrap();

    let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

    engine.add_nodes(vec![
        make_test_node(a, "funcA", "FUNCTION"),
        make_test_node(b, "funcB", "FUNCTION"),
        make_test_node(c, "funcC", "FUNCTION"),
        make_test_node(d, "moduleD", "MODULE"),
    ]);

    engine.add_edges(vec![
        make_test_edge(a, b, "CALLS"),
        make_test_edge(c, b, "CALLS"),
        make_test_edge(d, b, "IMPORTS"),
    ], false);

    let callers = engine.reverse_neighbors(b, &["CALLS"]);

    assert_eq!(callers.len(), 2);
    assert!(callers.contains(&a));
    assert!(callers.contains(&c));
    assert!(!callers.contains(&d));

    // Empty filter returns all
    let all_sources = engine.reverse_neighbors(b, &[]);
    assert_eq!(all_sources.len(), 3);
}

#[test]
fn test_reachability_forward() {
    // Graph: A -> B -> C -> D -> E
    // reachability([A], 2, [], false) = [A, B, C]

    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

    let [a, b, c, d, e]: [u128; 5] = [1, 2, 3, 4, 5];

    engine.add_nodes(vec![
        make_test_node(a, "A", "FUNCTION"),
        make_test_node(b, "B", "FUNCTION"),
        make_test_node(c, "C", "FUNCTION"),
        make_test_node(d, "D", "FUNCTION"),
        make_test_node(e, "E", "FUNCTION"),
    ]);

    engine.add_edges(vec![
        make_test_edge(a, b, "CALLS"),
        make_test_edge(b, c, "CALLS"),
        make_test_edge(c, d, "CALLS"),
        make_test_edge(d, e, "CALLS"),
    ], false);

    let result_2 = engine.reachability(&[a], 2, &[], false);
    assert_eq!(result_2.len(), 3);
    assert!(result_2.contains(&a) && result_2.contains(&b) && result_2.contains(&c));

    let result_10 = engine.reachability(&[a], 10, &[], false);
    assert_eq!(result_10.len(), 5);
}

#[test]
fn test_reachability_backward() {
    // Graph: A -> D, B -> D, C -> D
    // reachability([D], 1, [], true) = [D, A, B, C]

    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

    let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

    engine.add_nodes(vec![
        make_test_node(a, "A", "FUNCTION"),
        make_test_node(b, "B", "FUNCTION"),
        make_test_node(c, "C", "FUNCTION"),
        make_test_node(d, "D", "FUNCTION"),
    ]);

    engine.add_edges(vec![
        make_test_edge(a, d, "CALLS"),
        make_test_edge(b, d, "CALLS"),
        make_test_edge(c, d, "CALLS"),
    ], false);

    let result = engine.reachability(&[d], 1, &[], true);
    assert_eq!(result.len(), 4);
    assert!(result.contains(&d) && result.contains(&a) && result.contains(&b) && result.contains(&c));
}

#[test]
fn test_reachability_with_cycles() {
    // Diamond: A->B, A->C, B->D, C->D
    // Each node should appear exactly once

    use tempfile::tempdir;
    use std::collections::HashSet;

    let temp_dir = tempdir().unwrap();
    let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

    let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

    engine.add_nodes(vec![
        make_test_node(a, "A", "FUNCTION"),
        make_test_node(b, "B", "FUNCTION"),
        make_test_node(c, "C", "FUNCTION"),
        make_test_node(d, "D", "FUNCTION"),
    ]);

    engine.add_edges(vec![
        make_test_edge(a, b, "CALLS"),
        make_test_edge(a, c, "CALLS"),
        make_test_edge(b, d, "CALLS"),
        make_test_edge(c, d, "CALLS"),
    ], false);

    let forward = engine.reachability(&[a], 10, &[], false);
    assert_eq!(forward.len(), 4);

    let backward = engine.reachability(&[d], 10, &[], true);
    assert_eq!(backward.len(), 4);
}

#[test]
fn test_reverse_adjacency_persists_after_flush() {
    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test");

    let [a, b, c]: [u128; 3] = [1, 2, 3];

    {
        let mut engine = GraphEngine::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
            make_test_node(c, "C", "FUNCTION"),
        ]);
        engine.add_edges(vec![
            make_test_edge(a, c, "CALLS"),
            make_test_edge(b, c, "CALLS"),
        ], false);
        engine.flush().unwrap();
    }

    {
        let engine = GraphEngine::open(&db_path).unwrap();
        let callers = engine.reverse_neighbors(c, &["CALLS"]);
        assert_eq!(callers.len(), 2);
    }
}

#[test]
fn test_reachability_edge_type_filter() {
    // A --CALLS--> B, A --IMPORTS--> C, B --CALLS--> D
    // reachability([A], 10, ["CALLS"], false) = [A, B, D] (not C)

    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

    let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

    engine.add_nodes(vec![
        make_test_node(a, "A", "FUNCTION"),
        make_test_node(b, "B", "FUNCTION"),
        make_test_node(c, "C", "MODULE"),
        make_test_node(d, "D", "FUNCTION"),
    ]);

    engine.add_edges(vec![
        make_test_edge(a, b, "CALLS"),
        make_test_edge(a, c, "IMPORTS"),
        make_test_edge(b, d, "CALLS"),
    ], false);

    let result = engine.reachability(&[a], 10, &["CALLS"], false);
    assert_eq!(result.len(), 3);
    assert!(!result.contains(&c));
}

#[test]
fn test_reachability_empty_start() {
    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

    let forward = engine.reachability(&[], 10, &[], false);
    assert!(forward.is_empty());

    let backward = engine.reachability(&[], 10, &[], true);
    assert!(backward.is_empty());
}

#[test]
fn test_reachability_depth_zero() {
    use tempfile::tempdir;

    let temp_dir = tempdir().unwrap();
    let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

    let [a, b]: [u128; 2] = [1, 2];

    engine.add_nodes(vec![
        make_test_node(a, "A", "FUNCTION"),
        make_test_node(b, "B", "FUNCTION"),
    ]);
    engine.add_edges(vec![make_test_edge(a, b, "CALLS")], false);

    let result = engine.reachability(&[a], 0, &[], false);
    assert_eq!(result.len(), 1);
    assert!(result.contains(&a));
}
```

## Implementation Notes for Rob Pike

These tests expect:
1. `reverse_neighbors(id, edge_types)` - O(degree) lookup via reverse_adjacency
2. `reachability(start, max_depth, edge_types, backward)` - uses BFS with direction
3. `flush()`/`open()` must rebuild reverse_adjacency
