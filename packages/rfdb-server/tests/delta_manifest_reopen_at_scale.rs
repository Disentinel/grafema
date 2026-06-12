//! Integration test: delta-manifest reopen-at-scale with deletes.
//!
//! Exercises the Delta-Lake-style delta manifest write path end-to-end through
//! the real engine (`GraphEngineV2` + `GraphStore`) on an on-disk temp DB:
//!
//!   - 520 `commit_batch` calls (crossing many checkpoint boundaries; a full
//!     snapshot is written every MANIFEST_CHECKPOINT_INTERVAL = 32 commits,
//!     a `.edit.json` delta on every other commit).
//!   - Re-analysis of a subset of files (commit the same `changed_files` with
//!     fewer nodes) so REAL tombstones are produced and persisted as deltas.
//!   - Full-clear of some files (commit empty node set => all nodes tombstoned).
//!   - Drop the engine, `GraphEngineV2::open()` the same path, and assert the
//!     reconstructed state matches the in-session state EXACTLY (the delta
//!     replay must be faithful): counts, specific live/deleted node IDs, a
//!     live edge and a deleted edge.
//!   - Reopen TWICE to confirm stability.
//!
//! NOTE ON COUNT SEMANTICS: this test asserts post-reopen == pre-close
//! (delta-replay fidelity), NOT against a hand-computed "ideal" live count.
//! A separate, PRE-EXISTING bug (`node_count()` double-counts a node that is
//! tombstoned-then-re-added with the same ID in a later commit — reproduces on
//! the clean baseline branch with just 2 commits, independent of the delta
//! manifest) inflates the absolute live count. That bug is out of scope here;
//! what matters for the delta write path is that reopen reproduces in-session
//! state bit-for-bit. See report for the separate-bug repro.
//!
//! Run: cargo test --release -p rfdb --test delta_manifest_reopen_at_scale

use std::collections::HashMap;

use rfdb::graph::GraphEngineV2;
use rfdb::storage_v2::types::{EdgeRecordV2, NodeRecordV2};
use rfdb::GraphStore;
use tempfile::TempDir;

const NUM_FILES: usize = 520; // > 512: crosses checkpoint boundaries 32,64,..512
const NODES_PER_FILE: usize = 80;
const EDGES_PER_FILE: usize = 40;

fn id_of(semantic_id: &str) -> u128 {
    let hash = blake3::hash(semantic_id.as_bytes());
    u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap())
}

fn make_file_batch(
    file_idx: usize,
    node_count: usize,
    edge_count: usize,
    content_hash: u64,
) -> (String, Vec<NodeRecordV2>, Vec<EdgeRecordV2>) {
    let file = format!("src/file_{:04}.js", file_idx);
    let nodes: Vec<NodeRecordV2> = (0..node_count)
        .map(|n| {
            let sem_id = format!("FUNCTION:func_{}_{}@{}", file_idx, n, file);
            NodeRecordV2 {
                id: id_of(&sem_id),
                semantic_id: sem_id,
                node_type: "FUNCTION".to_string(),
                name: format!("func_{}_{}", file_idx, n),
                file: file.clone(),
                content_hash,
                metadata: String::new(),
            }
        })
        .collect();
    let edges: Vec<EdgeRecordV2> = (0..edge_count.min(node_count))
        .map(|e| EdgeRecordV2 {
            src: nodes[e].id,
            dst: nodes[(e + 1) % node_count].id,
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        })
        .collect();
    (file, nodes, edges)
}

#[test]
fn delta_manifest_reopen_at_scale_with_deletes() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("scale.rfdb");

    let reanalyzed_files: Vec<usize> = vec![5, 33, 64, 100, 200, 333, 480, 511];
    const REANALYZED_KEEP: usize = 30;
    let cleared_files: Vec<usize> = vec![17, 256, 400];

    // Sample IDs to spot-check after reopen.
    let mut sample_live_node_ids: Vec<u128> = Vec::new();
    let mut sample_deleted_node_ids: Vec<u128> = Vec::new();
    let sample_live_edge: (u128, u128);
    let mut sample_deleted_edge: Option<(u128, u128)> = None;

    // In-session ground truth captured just before drop.
    let inmem_node_count;
    let inmem_edge_count;

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();

        // ---- Phase 1: initial ingest ----
        for f in 0..NUM_FILES {
            let (file, nodes, edges) = make_file_batch(f, NODES_PER_FILE, EDGES_PER_FILE, 1);
            engine.commit_batch(nodes, edges, &[file], HashMap::new()).unwrap();
        }
        assert_eq!(engine.node_count(), NUM_FILES * NODES_PER_FILE, "post-ingest node_count");
        assert_eq!(engine.edge_count(), NUM_FILES * EDGES_PER_FILE, "post-ingest edge_count");

        // Live samples from an untouched file (file 1).
        {
            let (_f, nodes, _e) = make_file_batch(1, NODES_PER_FILE, EDGES_PER_FILE, 1);
            sample_live_edge = (nodes[0].id, nodes[1].id);
            sample_live_node_ids.push(nodes[10].id);
            sample_live_node_ids.push(nodes[79].id);
        }
        // Also a kept node from a reanalyzed file (idx < KEEP) must stay live.
        sample_live_node_ids.push(id_of(&format!(
            "FUNCTION:func_{}_{}@src/file_{:04}.js", 100, 3, 100
        )));

        // ---- Phase 2: re-analyze (shrink 80 -> 30) -> real tombstones ----
        for &f in &reanalyzed_files {
            let (file, all_nodes, all_edges) = make_file_batch(f, NODES_PER_FILE, EDGES_PER_FILE, 1);
            for n in REANALYZED_KEEP..NODES_PER_FILE {
                if sample_deleted_node_ids.len() < 16 {
                    sample_deleted_node_ids.push(all_nodes[n].id);
                }
            }
            // An edge whose src is a now-deleted node should disappear.
            if sample_deleted_edge.is_none() && REANALYZED_KEEP < all_edges.len() {
                let e = &all_edges[REANALYZED_KEEP];
                sample_deleted_edge = Some((e.src, e.dst));
            }
            let kept_nodes: Vec<NodeRecordV2> = (0..REANALYZED_KEEP)
                .map(|n| {
                    let sem_id = format!("FUNCTION:func_{}_{}@{}", f, n, file);
                    NodeRecordV2 {
                        id: id_of(&sem_id),
                        semantic_id: sem_id,
                        node_type: "FUNCTION".to_string(),
                        name: format!("func_{}_{}", f, n),
                        file: file.clone(),
                        content_hash: 2,
                        metadata: String::new(),
                    }
                })
                .collect();
            let kept_edges: Vec<EdgeRecordV2> = (0..(EDGES_PER_FILE.min(REANALYZED_KEEP)))
                .map(|e| EdgeRecordV2 {
                    src: kept_nodes[e].id,
                    dst: kept_nodes[(e + 1) % REANALYZED_KEEP].id,
                    edge_type: "CALLS".to_string(),
                    metadata: String::new(),
                })
                .collect();
            engine.commit_batch(kept_nodes, kept_edges, &[file], HashMap::new()).unwrap();
        }

        // ---- Phase 3: full-clear some files ----
        for &f in &cleared_files {
            let (file, all_nodes, _all_edges) = make_file_batch(f, NODES_PER_FILE, EDGES_PER_FILE, 1);
            for n in 0..NODES_PER_FILE {
                if sample_deleted_node_ids.len() < 32 {
                    sample_deleted_node_ids.push(all_nodes[n].id);
                }
            }
            engine.commit_batch(vec![], vec![], &[file], HashMap::new()).unwrap();
        }

        // In-session: deleted samples gone, live samples present.
        for &nid in &sample_deleted_node_ids {
            assert!(!engine.node_exists(nid), "node {} should be tombstoned in-session", nid);
        }
        for &nid in &sample_live_node_ids {
            assert!(engine.node_exists(nid), "live node {} missing in-session", nid);
        }
        if let Some((src, dst)) = sample_deleted_edge {
            let out = engine.get_outgoing_edges(src, None);
            assert!(!out.iter().any(|e| e.dst == dst), "deleted edge gone in-session");
        }
        {
            let out = engine.get_outgoing_edges(sample_live_edge.0, None);
            assert!(out.iter().any(|e| e.dst == sample_live_edge.1), "live edge present in-session");
        }

        inmem_node_count = engine.node_count();
        inmem_edge_count = engine.edge_count();
        eprintln!("IN-SESSION pre-close: node_count={}, edge_count={}", inmem_node_count, inmem_edge_count);

        engine.flush().unwrap();
    }

    // ===== REOPEN #1 — delta replay + tombstone recovery under test =====
    {
        let engine = GraphEngineV2::open(&db_path).unwrap();

        // Delta replay must reproduce in-session state EXACTLY.
        assert_eq!(engine.node_count(), inmem_node_count,
            "REOPEN#1: node_count must match in-session pre-close exactly (delta replay fidelity)");
        assert_eq!(engine.edge_count(), inmem_edge_count,
            "REOPEN#1: edge_count must match in-session pre-close exactly (delta replay fidelity)");

        for &nid in &sample_deleted_node_ids {
            assert!(!engine.node_exists(nid),
                "REOPEN#1: tombstoned node {} reappeared after replay", nid);
            assert!(engine.get_node(nid).is_none(),
                "REOPEN#1: get_node returned a tombstoned node {}", nid);
        }
        for &nid in &sample_live_node_ids {
            assert!(engine.node_exists(nid),
                "REOPEN#1: live node {} missing after replay", nid);
            assert!(engine.get_node(nid).is_some(),
                "REOPEN#1: get_node failed for live node {}", nid);
        }
        {
            let out = engine.get_outgoing_edges(sample_live_edge.0, None);
            assert!(out.iter().any(|e| e.dst == sample_live_edge.1),
                "REOPEN#1: live edge missing after replay");
        }
        if let Some((src, dst)) = sample_deleted_edge {
            let out = engine.get_outgoing_edges(src, None);
            assert!(!out.iter().any(|e| e.dst == dst),
                "REOPEN#1: deleted edge reappeared after replay");
        }
        eprintln!("REOPEN#1: node_count={}, edge_count={} (matches in-session)",
            engine.node_count(), engine.edge_count());
    }

    // ===== REOPEN #2 — stability =====
    {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(engine.node_count(), inmem_node_count, "REOPEN#2: node_count drifted");
        assert_eq!(engine.edge_count(), inmem_edge_count, "REOPEN#2: edge_count drifted");
        for &nid in &sample_deleted_node_ids {
            assert!(!engine.node_exists(nid), "REOPEN#2: tombstoned node {} reappeared", nid);
        }
        for &nid in &sample_live_node_ids {
            assert!(engine.node_exists(nid), "REOPEN#2: live node {} missing", nid);
        }
    }

    eprintln!(
        "delta-manifest reopen-at-scale OK: {} commits, in-session node_count={} edge_count={} \
         reproduced bit-for-bit across 2 reopens; {} sampled deleted nodes verified gone, \
         {} sampled live nodes retrievable.",
        NUM_FILES + reanalyzed_files.len() + cleared_files.len(),
        inmem_node_count, inmem_edge_count,
        sample_deleted_node_ids.len(), sample_live_node_ids.len(),
    );
}

// ---------------------------------------------------------------------------
// Separate probe: delete_node / delete_edge via the GraphStore trait.
//
// MVCC B3 (RFD-71): trait-level delete + flush NOW persists across reopen. The
// deletion is merged into the manifest VERSION's cumulative tombstone set (the
// authority) and written to disk, so it survives restart — same persistence
// guarantee as commit_batch. (Pre-B3 this was a documented limitation: only
// commit_batch tracked manifest tombstones; flush-path deletes were lost on
// reopen.) Pins the new behavior so a regression is caught loudly.
// ---------------------------------------------------------------------------
#[test]
fn trait_delete_node_edge_persistence_behavior_at_scale() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("traitdel.rfdb");

    let mut target_node: u128 = 0;
    let mut target_edge: (u128, u128) = (0, 0);

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        for f in 0..40 {
            let (file, nodes, edges) = make_file_batch(f, 20, 10, 1);
            if f == 3 {
                target_node = nodes[5].id;
                target_edge = (nodes[0].id, nodes[1].id);
            }
            engine.commit_batch(nodes, edges, &[file], HashMap::new()).unwrap();
        }
        engine.delete_node(target_node);
        engine.delete_edge(target_edge.0, target_edge.1, "CALLS");
        // B2 (RFD-71): trait deletes are invisible until flushed — publish the
        // tombstones, then they are observable in-session.
        engine.flush().unwrap();
        assert!(!engine.node_exists(target_node), "trait delete should hide node after flush");
        let out = engine.get_outgoing_edges(target_edge.0, None);
        assert!(!out.iter().any(|e| e.dst == target_edge.1), "trait delete should hide edge after flush");
    }

    let engine = GraphEngineV2::open(&db_path).unwrap();
    let node_back = engine.node_exists(target_node);
    let edge_back = engine.get_outgoing_edges(target_edge.0, None).iter().any(|e| e.dst == target_edge.1);
    eprintln!("TRAIT-DELETE PROBE after reopen: node persisted-deleted={}, edge persisted-deleted={}",
        !node_back, !edge_back);

    // MVCC B3: the manifest version carries the tombstones → deletes stay deleted.
    assert!(!node_back,
        "B3: trait delete_node must persist across reopen (version-state tombstone)");
    assert!(!edge_back,
        "B3: trait delete_edge must persist across reopen (version-state tombstone)");
}
