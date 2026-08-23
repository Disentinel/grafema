//! Guard: the per-commit write path must never scan the whole database.
//!
//! The defect this pins down (RFD-71 phase C3, serial bulk load): the
//! auto-compaction trigger inside `commit_batch` asked for the FULL per-shard
//! diagnostics snapshot while using only two of its fields — the L0 segment
//! counts. Building that snapshot calls `Shard::node_count()` and
//! `Shard::edge_count()`, each of which walks every live record of the shard and
//! dedups it through a `HashSet` — O(database size). Once per commit, that makes
//! a serial bulk load cost O(commits x database size): quadratic in the amount
//! loaded. The two numbers actually wanted are `Vec::len()` reads, i.e. constant
//! time.
//!
//! Measuring this by wall clock needs a big load and minutes of patience, and
//! still only yields a soft "it felt slow". Instead the storage layer counts its
//! own exact-count full scans (`rfdb::storage_v2::exact_live_count_scans`), so
//! the property is checked exactly and in seconds: a bulk load that fires
//! auto-compaction many times must add ZERO full scans.
//!
//! The test carries its own positive control, so a broken meter cannot make the
//! guard vacuously green.
//!
//! Run: cargo test -p rfdb --test c3_hot_path_no_full_scan -- --nocapture

use std::collections::HashMap;

use rfdb::graph::GraphEngineV2;
use rfdb::storage_v2::exact_live_count_scans;
use rfdb::storage_v2::types::{EdgeRecordV2, NodeRecordV2};
use rfdb::GraphStore;
use tempfile::TempDir;

const NODES_PER_COMMIT: usize = 10;
/// Enough commits to cross the compaction threshold many times over, still a
/// couple of seconds even in an unoptimized build.
const COMMITS: usize = 300;
/// Low on purpose: auto-compaction must actually fire repeatedly, so the guard
/// covers the trigger AND everything compaction itself does per commit.
const THRESHOLD: usize = 8;

fn id_of(semantic_id: &str) -> u128 {
    let hash = blake3::hash(semantic_id.as_bytes());
    u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap())
}

/// Deterministic batch for `file`: `n` FUNCTION nodes + `n` intra-file CALLS edges.
fn make_batch(file: &str, n: usize) -> (Vec<NodeRecordV2>, Vec<EdgeRecordV2>) {
    let nodes: Vec<NodeRecordV2> = (0..n)
        .map(|i| {
            let sem = format!("FUNCTION:{file}#fn_{i}");
            NodeRecordV2 {
                id: id_of(&sem),
                semantic_id: sem,
                node_type: "FUNCTION".to_string(),
                name: format!("fn_{i}"),
                file: file.to_string(),
                content_hash: 1,
                metadata: String::new(),
            }
        })
        .collect();
    let edges: Vec<EdgeRecordV2> = (0..n)
        .map(|i| EdgeRecordV2 {
            src: nodes[i].id,
            dst: nodes[(i + 1) % n].id,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        })
        .collect();
    (nodes, edges)
}

/// All three phases live in ONE test on purpose: the scan meter is process-wide,
/// so two tests in this binary would run in parallel and pollute each other's
/// measurement window.
#[test]
fn write_path_never_scans_the_whole_database() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("c3_hot_path.rfdb");
    let mut engine = GraphEngineV2::create(&db_path).unwrap();
    engine.set_auto_compact_threshold(THRESHOLD);

    // Seed a little data so the shards are non-empty and a full scan has
    // something to walk.
    let (nodes, edges) = make_batch("src/gen/seed.rs", NODES_PER_COMMIT);
    engine
        .commit_batch(nodes, edges, &["src/gen/seed.rs".to_string()], HashMap::new())
        .expect("seed commit");

    let shard_count = engine.shard_l0_segment_counts().len();
    assert!(shard_count > 0, "engine must report at least one shard");

    // ── Phase 1. POSITIVE CONTROL: the meter does see the expensive path ──
    // One on-demand diagnostics snapshot = one node scan + one edge scan per
    // shard. If this were 0, the guard in phase 2 would prove nothing.
    let before_control = exact_live_count_scans();
    let diags = engine.shard_diagnostics();
    let control_scans = exact_live_count_scans() - before_control;
    assert_eq!(
        control_scans,
        2 * shard_count as u64,
        "positive control: one shard_diagnostics() call must perform exactly one \
         node scan + one edge scan per shard ({shard_count} shards); the meter is \
         not observing the expensive path"
    );

    // ── Phase 2. THE GUARD: a bulk load adds no full scan at all ──
    engine.begin_bulk_load().expect("begin_bulk_load");
    let before_bulk = exact_live_count_scans();
    let compactions_before = engine.auto_compactions();

    for i in 0..COMMITS {
        let file = format!("src/gen/file_{i:06}.rs");
        let (nodes, edges) = make_batch(&file, NODES_PER_COMMIT);
        engine
            .commit_batch(nodes, edges, std::slice::from_ref(&file), HashMap::new())
            .expect("bulk commit");
    }

    let bulk_scans = exact_live_count_scans() - before_bulk;
    let compactions = engine.auto_compactions() - compactions_before;

    println!(
        "C3 hot path: {COMMITS} bulk commits, {shard_count} shards, threshold {THRESHOLD} \
         => {compactions} auto-compactions, {bulk_scans} exact-count full scans"
    );

    assert!(
        compactions > 0,
        "the compaction trigger must have fired during the measured window, \
         otherwise the hot path was never exercised (got {compactions})"
    );
    assert_eq!(
        bulk_scans, 0,
        "the per-commit write path performed {bulk_scans} exact-count full scans \
         over {COMMITS} commits. Each scan walks every live record, so this is \
         O(commits x database size) — a quadratic bulk load. The compaction \
         trigger needs only the L0 segment counts, which are constant time: use \
         shard_l0_segment_counts(), not shard_diagnostics()"
    );

    engine.end_bulk_load().expect("end_bulk_load");

    // ── Phase 3. HONESTY: cheap and expensive agree on the shared numbers ──
    // A constant-time answer is worthless if it is a different answer.
    let cheap = engine.shard_l0_segment_counts();
    let full = engine.shard_diagnostics();
    assert_eq!(cheap.len(), full.len(), "same number of shards from both paths");
    for (c, f) in cheap.iter().zip(full.iter()) {
        assert_eq!(c.shard_id, f.shard_id, "shard ids must line up");
        assert_eq!(
            c.l0_node_segment_count, f.l0_node_segment_count,
            "shard {}: cheap L0 node segment count disagrees with diagnostics",
            c.shard_id
        );
        assert_eq!(
            c.l0_edge_segment_count, f.l0_edge_segment_count,
            "shard {}: cheap L0 edge segment count disagrees with diagnostics",
            c.shard_id
        );
    }

    // The data really did land (the guard is not green because nothing happened).
    let expected_nodes = (COMMITS + 1) * NODES_PER_COMMIT;
    assert_eq!(
        diags.len(),
        shard_count,
        "diagnostics must cover every shard"
    );
    assert_eq!(
        engine.node_count(),
        expected_nodes,
        "all bulk-loaded nodes must be live"
    );
}
