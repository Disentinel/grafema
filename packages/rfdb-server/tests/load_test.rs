//! Load test: realistic code analysis scenarios at scale.
//!
//! Builds a graph modeling a large codebase (400K nodes, 800K edges)
//! with realistic type distributions, then benchmarks key operations
//! including the new edge-type index (RFD-44).
//!
//! Run: `cargo test --release --test load_test -- --ignored --nocapture`

use std::time::{Duration, Instant};
use rfdb::graph::GraphEngineV2;
use rfdb::{GraphStore, NodeRecord, EdgeRecord};
use rfdb::datalog::{Evaluator, parse_program, parse_query, parse_rule};

// ---------------------------------------------------------------------------
// PRNG (LCG — no external deps)
// ---------------------------------------------------------------------------

fn lcg(seed: u64) -> u64 {
    seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407)
}

/// Pick an index from `weights` using weighted random selection.
/// Mutates `rng` state. `weights` must sum to > 0.
fn weighted_pick(rng: &mut u64, weights: &[u32]) -> usize {
    let total: u32 = weights.iter().sum();
    *rng = lcg(*rng);
    let roll = (*rng >> 33) as u32 % total;
    let mut acc = 0u32;
    for (i, &w) in weights.iter().enumerate() {
        acc += w;
        if roll < acc {
            return i;
        }
    }
    weights.len() - 1
}

// ---------------------------------------------------------------------------
// Node & edge type definitions with realistic distributions
// ---------------------------------------------------------------------------

const NODE_TYPES: &[(&str, u32)] = &[
    // High-freq (70%)
    ("FUNCTION",        15), ("VARIABLE",        15), ("CALL",            12),
    ("PARAMETER",        8), ("ASSIGNMENT",        6), ("PROPERTY_ACCESS",  6),
    ("CLASS",            4), ("METHOD",            4),
    // Mid-freq (20%)
    ("MODULE",           3), ("IMPORT",            3), ("EXPORT",           2),
    ("LITERAL",          2), ("CONDITION",         2), ("LOOP",             2),
    ("RETURN",           2), ("ARROW_FUNCTION",    2), ("BINARY_EXPR",      1),
    ("TEMPLATE_LITERAL", 1),
    // Low-freq (10%)
    ("OBJECT_LITERAL",   1), ("ARRAY_LITERAL",     1), ("GENERATOR",        1),
    ("ASYNC_FUNCTION",   1), ("DECORATOR",         1), ("TYPE_ANNOTATION",  1),
    ("JSX_ELEMENT",      1), ("EVENT_LISTENER",    1), ("ROUTE_HANDLER",    1),
    ("MIDDLEWARE",        1), ("DATABASE_QUERY",    1), ("CONFIG",           1),
    ("TRY_CATCH",        1), ("THROW",             1),
];

const EDGE_TYPES: &[(&str, u32)] = &[
    // High-freq (60%)
    ("CONTAINS",       15), ("CALLS",          12), ("ASSIGNED_FROM",  10),
    ("HAS_PARAMETER",   8), ("SCOPED_IN",       8), ("DEFINED_IN",      7),
    // Mid-freq (25%)
    ("IMPORTS_FROM",    4), ("READS_PROPERTY",  4), ("WRITES_PROPERTY", 3),
    ("PASSES_ARGUMENT", 3), ("RETURNS_VALUE",   3), ("RESOLVES_TO",     3),
    ("USED_IN",         3), ("HAS_PROPERTY",    2),
    // Low-freq (15%)
    ("EXPORTS",         1), ("ITERATES_OVER",   1), ("EXTENDS",         1),
    ("IMPLEMENTS",      1), ("INSTANTIATES",    1), ("CATCHES_ERROR",   1),
    ("THROWS_ERROR",    1), ("LISTENS_TO",      1), ("EMITS_EVENT",     1),
    ("DEPENDS_ON",      1), ("OVERRIDES",       1), ("DECORATED_BY",    1),
    ("ROUTES_TO",       1), ("MIDDLEWARE_OF",    1), ("QUERIES_DB",      1),
    ("READS_CONFIG",    1), ("TYPE_OF",         1), ("ALIAS_OF",        1),
];

const NODE_COUNT: usize = 400_000;
const EDGE_COUNT: usize = 800_000;
const FILE_COUNT: usize = 500;

// ---------------------------------------------------------------------------
// ID generation (deterministic, matches build_graph)
// ---------------------------------------------------------------------------

/// Generate all node IDs deterministically from seed.
/// Returns (ids, node_type_for_each_id).
fn generate_ids() -> (Vec<u128>, Vec<&'static str>) {
    let node_weights: Vec<u32> = NODE_TYPES.iter().map(|(_, w)| *w).collect();
    let mut rng: u64 = 42;
    let mut ids = Vec::with_capacity(NODE_COUNT);
    let mut types = Vec::with_capacity(NODE_COUNT);
    for i in 0..NODE_COUNT {
        let type_idx = weighted_pick(&mut rng, &node_weights);
        let node_type = NODE_TYPES[type_idx].0;
        let file_idx = i % FILE_COUNT;
        let sem_id = format!("{}:item_{}@src/file_{}.js", node_type, i, file_idx);
        let hash = blake3::hash(sem_id.as_bytes());
        ids.push(u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap()));
        types.push(node_type);
    }
    (ids, types)
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

fn build_graph(all_ids: &[u128], all_types: &[&str]) -> GraphEngineV2 {
    let mut engine = GraphEngineV2::create_ephemeral();
    let edge_weights: Vec<u32> = EDGE_TYPES.iter().map(|(_, w)| *w).collect();

    // -- Nodes (batched) --
    let batch_size = 50_000;
    for start in (0..NODE_COUNT).step_by(batch_size) {
        let end = (start + batch_size).min(NODE_COUNT);
        let nodes: Vec<NodeRecord> = (start..end)
            .map(|i| {
                let node_type = all_types[i];
                let file_idx = i % FILE_COUNT;
                NodeRecord {
                    id: all_ids[i],
                    node_type: Some(node_type.to_string()),
                    file_id: file_idx as u32,
                    name_offset: i as u32,
                    version: "main".to_string(),
                    exported: i % 20 == 0,
                    replaces: None,
                    deleted: false,
                    name: Some(format!("item_{}", i)),
                    file: Some(format!("src/file_{}.js", file_idx)),
                    metadata: Some(format!("{{\"line\":{},\"column\":{}}}", i % 1000, i % 80)),
                    semantic_id: Some(format!("{}:item_{}@src/file_{}.js", node_type, i, file_idx)),
                }
            })
            .collect();
        engine.add_nodes(nodes);
    }

    // -- Edges (batched) --
    // Use a separate rng stream for edges (seeded differently from node generation)
    let mut rng: u64 = 123456789;
    let edge_batch = 100_000;
    for start in (0..EDGE_COUNT).step_by(edge_batch) {
        let end = (start + edge_batch).min(EDGE_COUNT);
        let edges: Vec<EdgeRecord> = (start..end)
            .map(|_| {
                rng = lcg(rng);
                let src_idx = (rng >> 17) as usize % NODE_COUNT;
                rng = lcg(rng);
                let dst_idx = (rng >> 17) as usize % NODE_COUNT;
                let type_idx = weighted_pick(&mut rng, &edge_weights);
                EdgeRecord {
                    src: all_ids[src_idx],
                    dst: all_ids[dst_idx],
                    edge_type: Some(EDGE_TYPES[type_idx].0.to_string()),
                    version: "main".to_string(),
                    metadata: None,
                    deleted: false,
                }
            })
            .collect();
        engine.add_edges(edges, true);
    }

    engine
}

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

fn timed<F, R>(f: F) -> (R, Duration)
where
    F: FnOnce() -> R,
{
    let start = Instant::now();
    let result = f();
    (result, start.elapsed())
}

// ---------------------------------------------------------------------------
// Storage-level scenarios
// ---------------------------------------------------------------------------

/// 1. Point lookup: get_node for 1000 random IDs
fn scenario_point_lookup(engine: &dyn GraphStore, ids: &[u128]) -> (usize, Duration) {
    let sample: Vec<u128> = ids.iter().step_by(ids.len() / 1000).copied().collect();
    timed(|| {
        let mut found = 0usize;
        for &id in &sample {
            if engine.get_node(id).is_some() {
                found += 1;
            }
        }
        found
    })
}

/// 2. Outgoing edges filtered by CALLS
fn scenario_outgoing_edges(engine: &dyn GraphStore, ids: &[u128]) -> (usize, Duration) {
    let sample: Vec<u128> = ids.iter().step_by(ids.len() / 1000).copied().collect();
    timed(|| {
        let mut total = 0usize;
        for &id in &sample {
            total += engine.get_outgoing_edges(id, Some(&["CALLS"])).len();
        }
        total
    })
}

/// 3. Incoming edges filtered by CALLS
fn scenario_incoming_edges(engine: &dyn GraphStore, ids: &[u128]) -> (usize, Duration) {
    let sample: Vec<u128> = ids.iter().step_by(ids.len() / 1000).copied().collect();
    timed(|| {
        let mut total = 0usize;
        for &id in &sample {
            total += engine.get_incoming_edges(id, Some(&["CALLS"])).len();
        }
        total
    })
}

/// 4. Edges by type (NEW — uses edge-type index)
fn scenario_edges_by_type(engine: &dyn GraphStore) -> (usize, Duration) {
    timed(|| engine.get_edges_by_type("CALLS").len())
}

/// 5. Find by type — all FUNCTION nodes
fn scenario_find_by_type(engine: &dyn GraphStore) -> (usize, Duration) {
    timed(|| engine.find_by_type("FUNCTION").len())
}

/// 6. BFS depth=3 single type (CALLS) from 100 starts
fn scenario_bfs_single_type(engine: &dyn GraphStore, ids: &[u128]) -> (usize, Duration) {
    let sample: Vec<u128> = ids.iter().step_by(ids.len() / 100).copied().collect();
    timed(|| {
        let mut total = 0usize;
        for &id in &sample {
            total += engine.bfs(&[id], 3, &["CALLS"]).len();
        }
        total
    })
}

/// 7. BFS depth=3 multi-type from 100 starts
fn scenario_bfs_multi_type(engine: &dyn GraphStore, ids: &[u128]) -> (usize, Duration) {
    let sample: Vec<u128> = ids.iter().step_by(ids.len() / 100).copied().collect();
    timed(|| {
        let mut total = 0usize;
        for &id in &sample {
            total += engine.bfs(&[id], 3, &["CALLS", "CONTAINS", "ASSIGNED_FROM"]).len();
        }
        total
    })
}

/// 8. get_all_edges — full scan baseline
fn scenario_get_all_edges(engine: &dyn GraphStore) -> (usize, Duration) {
    timed(|| engine.get_all_edges().len())
}

// ---------------------------------------------------------------------------
// Datalog-level scenarios
// ---------------------------------------------------------------------------

/// 9. Bound src edge: edge("ID", Y, "CALLS")
fn scenario_datalog_bound_src(engine: &dyn GraphStore, sample_id: u128) -> (usize, Duration) {
    let evaluator = Evaluator::new(engine);
    let query_str = format!(
        "edge(\"{}\", Y, \"CALLS\")",
        sample_id
    );
    let literals = parse_query(&query_str).expect("parse bound-src query");
    timed(|| evaluator.eval_query(&literals).unwrap().len())
}

/// 10. Unbound src, const type: edge(X, Y, "CALLS") — all CALLS via index
fn scenario_datalog_all_calls(engine: &dyn GraphStore) -> (usize, Duration) {
    let evaluator = Evaluator::new(engine);
    let literals = parse_query("edge(X, Y, \"CALLS\")").expect("parse all-calls query");
    timed(|| evaluator.eval_query(&literals).unwrap().len())
}

/// 11. Incoming with bound dst: incoming("ID", Y, "CALLS") — find callers of a node
fn scenario_datalog_incoming(engine: &dyn GraphStore, sample_id: u128) -> (usize, Duration) {
    let evaluator = Evaluator::new(engine);
    let query_str = format!(
        "incoming(\"{}\", Y, \"CALLS\")",
        sample_id
    );
    let literals = parse_query(&query_str).expect("parse incoming query");
    timed(|| evaluator.eval_query(&literals).unwrap().len())
}

/// 12. Multi-literal join: node(F, "FUNCTION"), edge(F, C, "CALLS"), attr(C, "name", Name)
fn scenario_datalog_join(engine: &dyn GraphStore) -> (usize, Duration) {
    let evaluator = Evaluator::new(engine);
    let literals = parse_query(
        "node(F, \"FUNCTION\"), edge(F, C, \"CALLS\"), attr(C, \"name\", Name)"
    ).expect("parse join query");
    timed(|| evaluator.eval_query(&literals).unwrap().len())
}

/// 13. Guarantee rule: orphan calls without RESOLVES_TO
fn scenario_datalog_guarantee(engine: &dyn GraphStore) -> (usize, Duration) {
    let mut evaluator = Evaluator::new(engine);
    let rule = parse_rule(
        "orphan(X) :- node(X, \"CALL\"), \\+ edge(X, _, \"RESOLVES_TO\")."
    ).expect("parse guarantee rule");
    evaluator.add_rule(rule);
    let goal = rfdb::datalog::parse_atom("orphan(X)").expect("parse goal");
    timed(|| evaluator.query(&goal).len())
}

/// 14. 2-hop pattern: functions that call DB queries
fn scenario_datalog_2hop(engine: &dyn GraphStore) -> (usize, Duration) {
    let mut evaluator = Evaluator::new(engine);
    let program = parse_program(
        "db_caller(F, Q) :- node(F, \"FUNCTION\"), edge(F, C, \"CALLS\"), edge(C, Q, \"QUERIES_DB\")."
    ).expect("parse 2-hop program");
    evaluator.load_rules(program.rules().to_vec());
    let goal = rfdb::datalog::parse_atom("db_caller(F, Q)").expect("parse goal");
    timed(|| evaluator.query(&goal).len())
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

#[test]
#[ignore]
fn load_test_400k_nodes_800k_edges() {
    println!("\n=== RFDB Load Test: 400K nodes, 800K edges ===\n");

    // Generate deterministic IDs
    let (all_ids, all_types) = generate_ids();

    // -- Build graph --
    let (engine, build_dur) = timed(|| build_graph(&all_ids, &all_types));
    println!("Graph built in {:.1}s", build_dur.as_secs_f64());

    // Verify counts
    let nc = engine.node_count();
    let ec = engine.edge_count();
    println!("Nodes: {}  Edges: {}\n", nc, ec);
    assert_eq!(nc, NODE_COUNT, "expected {} nodes", NODE_COUNT);
    assert!(ec > 0, "must have edges");

    // Pick a sample node for bound-src / incoming scenarios
    let sample_id = all_ids[0];

    // -- Run scenarios --
    struct Row {
        name: &'static str,
        count: usize,
        dur: Duration,
    }
    let mut rows: Vec<Row> = Vec::new();

    macro_rules! run {
        ($name:expr, $expr:expr) => {{
            let (count, dur) = $expr;
            rows.push(Row { name: $name, count, dur });
        }};
    }

    // Storage-level
    run!("1. Point lookup (1000x)",         scenario_point_lookup(&engine, &all_ids));
    run!("2. Outgoing edges CALLS (1000x)", scenario_outgoing_edges(&engine, &all_ids));
    run!("3. Incoming edges CALLS (1000x)", scenario_incoming_edges(&engine, &all_ids));
    run!("4. Edges by type CALLS (index)",  scenario_edges_by_type(&engine));
    run!("5. Find by type FUNCTION",        scenario_find_by_type(&engine));
    run!("6. BFS d=3 CALLS (100x)",         scenario_bfs_single_type(&engine, &all_ids));
    run!("7. BFS d=3 multi-type (100x)",    scenario_bfs_multi_type(&engine, &all_ids));
    run!("8. get_all_edges (full scan)",     scenario_get_all_edges(&engine));

    // Datalog-level
    run!("9.  Datalog: bound src edge",        scenario_datalog_bound_src(&engine, sample_id));
    run!("10. Datalog: all CALLS (index)",     scenario_datalog_all_calls(&engine));
    run!("11. Datalog: incoming CALLS (bound)", scenario_datalog_incoming(&engine, sample_id));
    run!("12. Datalog: join F->C->name",       scenario_datalog_join(&engine));
    run!("13. Datalog: orphan CALLs",          scenario_datalog_guarantee(&engine));
    run!("14. Datalog: 2-hop F->C->DB",        scenario_datalog_2hop(&engine));

    // -- Print table --
    println!("{:<40} {:>12} {:>12} {:>12}", "scenario", "results", "time_ms", "ops/sec");
    println!("{}", "-".repeat(78));
    for r in &rows {
        let ms = r.dur.as_secs_f64() * 1000.0;
        let ops = if ms > 0.0 { r.count as f64 / (ms / 1000.0) } else { f64::INFINITY };
        println!("{:<40} {:>12} {:>12.2} {:>12.0}", r.name, r.count, ms, ops);
    }
    println!();

    // -- Correctness invariants --

    // 4 vs 8: edge-type index must be faster than full scan
    let idx_ms = rows[3].dur.as_secs_f64() * 1000.0; // scenario 4
    let scan_ms = rows[7].dur.as_secs_f64() * 1000.0; // scenario 8
    println!(
        "Edge-type index vs full scan: {:.1}ms vs {:.1}ms ({:.1}x speedup)",
        idx_ms, scan_ms,
        if idx_ms > 0.0 { scan_ms / idx_ms } else { f64::INFINITY }
    );
    assert!(
        idx_ms < scan_ms,
        "get_edges_by_type should be faster than get_all_edges ({:.1}ms vs {:.1}ms)",
        idx_ms, scan_ms
    );

    // Scenario 10 (Datalog all CALLS) count should match scenario 4 (storage CALLS)
    assert_eq!(
        rows[3].count, rows[9].count,
        "Datalog edge(X,Y,\"CALLS\") count ({}) must match get_edges_by_type(\"CALLS\") count ({})",
        rows[9].count, rows[3].count
    );

    // Scenario 5: FUNCTION nodes should be ~15% of total
    let fn_pct = rows[4].count as f64 / NODE_COUNT as f64 * 100.0;
    println!("FUNCTION nodes: {} ({:.1}% of total, expected ~15%)", rows[4].count, fn_pct);
    assert!(fn_pct > 10.0 && fn_pct < 20.0, "FUNCTION distribution out of range: {:.1}%", fn_pct);

    // BFS should not hang — already completed if we got here
    println!("BFS single-type found {} reachable nodes (100 starts)", rows[5].count);
    println!("BFS multi-type found {} reachable nodes (100 starts)", rows[6].count);

    // -- Hash join performance assertions --
    // Scenarios 12-14 use multi-literal joins that should benefit from hash join.
    // Before hash join: 130-200s. After: should be <10s.
    let scenario_12_ms = rows[11].dur.as_secs_f64() * 1000.0;
    let scenario_13_ms = rows[12].dur.as_secs_f64() * 1000.0;
    let scenario_14_ms = rows[13].dur.as_secs_f64() * 1000.0;

    println!("\nHash join performance:");
    println!("  12. join F->C->name:   {:.1}ms (target: <10000ms)", scenario_12_ms);
    println!("  13. orphan CALLs:      {:.1}ms (target: <10000ms)", scenario_13_ms);
    println!("  14. 2-hop F->C->DB:    {:.1}ms (target: <10000ms)", scenario_14_ms);

    assert!(
        scenario_12_ms < 10_000.0,
        "Scenario 12 (join F->C->name) took {:.1}ms, expected <10000ms with hash join",
        scenario_12_ms
    );
    assert!(
        scenario_13_ms < 10_000.0,
        "Scenario 13 (orphan CALLs) took {:.1}ms, expected <10000ms with hash join",
        scenario_13_ms
    );
    assert!(
        scenario_14_ms < 10_000.0,
        "Scenario 14 (2-hop F->C->DB) took {:.1}ms, expected <10000ms with hash join",
        scenario_14_ms
    );

    // Result counts should not change (correctness invariant)
    assert!(rows[11].count > 0, "Scenario 12 should produce results");
    assert!(rows[12].count > 0, "Scenario 13 should produce results");

    println!("\n=== Load test passed ===\n");
}
