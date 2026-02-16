//! Memory profile: RSS measurement at various graph sizes.
//!
//! Measures process-specific RSS delta for v1 and v2 engines at
//! 1K, 10K, 100K, and 1M nodes. Prints comparison table to stdout.
//!
//! Run: cargo run --release --bin memory_profile

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use rfdb::graph::{GraphEngine, GraphEngineV2};
use rfdb::storage::{EdgeRecord, NodeRecord};
use rfdb::storage_v2::types::NodeRecordV2;
use rfdb::GraphStore;
use sysinfo::{ProcessRefreshKind, RefreshKind, System};

// ── Temp directory (avoids dev-dependency on tempfile) ───────────────────

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct TmpDir(PathBuf);

impl TmpDir {
    fn new() -> Self {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let path = std::env::temp_dir().join(format!("rfdb-memprof-{}-{}", pid, id));
        std::fs::create_dir_all(&path).expect("failed to create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ── Node generators ────────────────────────────────────────────────────

fn make_v1_nodes(count: usize) -> Vec<NodeRecord> {
    (0..count)
        .map(|i| NodeRecord {
            id: i as u128,
            node_type: Some("FUNCTION".to_string()),
            file_id: (i % 100) as u32,
            name_offset: i as u32,
            version: "main".to_string(),
            exported: i % 10 == 0,
            replaces: None,
            deleted: false,
            name: Some(format!("func_{}", i)),
            file: Some(format!("src/file_{}.js", i % 100)),
            metadata: None,
            semantic_id: None,
        })
        .collect()
}

fn make_v1_edges(count: usize, node_count: usize) -> Vec<EdgeRecord> {
    (0..count)
        .map(|i| EdgeRecord {
            src: (i % node_count) as u128,
            dst: ((i + 1) % node_count) as u128,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        })
        .collect()
}

fn make_v2_nodes(count: usize) -> Vec<NodeRecordV2> {
    (0..count)
        .map(|i| {
            let sem_id = format!("FUNCTION:func_{}@src/file_{}.js", i, i % 100);
            let hash = blake3::hash(sem_id.as_bytes());
            let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
            NodeRecordV2 {
                semantic_id: sem_id,
                id,
                node_type: "FUNCTION".to_string(),
                name: format!("func_{}", i),
                file: format!("src/file_{}.js", i % 100),
                content_hash: 0,
                metadata: String::new(),
            }
        })
        .collect()
}

// ── RSS measurement ────────────────────────────────────────────────────

fn get_process_rss() -> u64 {
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_all();
    let pid = sysinfo::get_current_pid().expect("failed to get PID");
    sys.process(pid)
        .map(|p| p.memory())
        .unwrap_or(0)
}

fn measure_v1_rss(node_count: usize) -> u64 {
    // Let OS settle RSS from prior allocations
    std::thread::sleep(std::time::Duration::from_millis(100));
    let baseline = get_process_rss();

    let dir = TmpDir::new();
    let mut engine = GraphEngine::create(dir.path()).unwrap();
    let nodes = make_v1_nodes(node_count);
    let edges = make_v1_edges(node_count * 3, node_count);
    engine.add_nodes(nodes);
    engine.add_edges(edges, false);
    engine.flush().unwrap();

    let after = get_process_rss();

    // Keep engine alive until after measurement
    drop(engine);
    drop(dir);

    after.saturating_sub(baseline)
}

fn measure_v2_rss(node_count: usize) -> u64 {
    std::thread::sleep(std::time::Duration::from_millis(100));
    let baseline = get_process_rss();

    let dir = TmpDir::new();
    let mut engine = GraphEngineV2::create(dir.path()).unwrap();

    // Use v2-native commit_batch for realistic setup
    let v2_nodes = make_v2_nodes(node_count);
    let files: Vec<String> = (0..100.min(node_count))
        .map(|i| format!("src/file_{}.js", i))
        .collect();
    engine
        .commit_batch(v2_nodes, vec![], &files, HashMap::new())
        .unwrap();

    let after = get_process_rss();

    drop(engine);
    drop(dir);

    after.saturating_sub(baseline)
}

// ── Main ───────────────────────────────────────────────────────────────

fn main() {
    println!("RFDB Memory Profile (process RSS delta)");
    println!("========================================");
    println!();
    println!(
        "{:<12} {:>14} {:>14} {:>10}",
        "Nodes", "v1 RSS (MB)", "v2 RSS (MB)", "Ratio"
    );
    println!("{:-<54}", "");

    for size in [1_000, 10_000, 100_000, 1_000_000] {
        eprint!("Measuring {}... ", size);

        let v1_bytes = measure_v1_rss(size);
        let v2_bytes = measure_v2_rss(size);

        let v1_mb = v1_bytes as f64 / (1024.0 * 1024.0);
        let v2_mb = v2_bytes as f64 / (1024.0 * 1024.0);
        let ratio = if v1_mb > 0.0 {
            format!("{:.2}x", v2_mb / v1_mb)
        } else {
            "N/A".to_string()
        };

        println!("{:<12} {:>14.1} {:>14.1} {:>10}", size, v1_mb, v2_mb, ratio);
        eprintln!("done");
    }

    println!();
    println!("Note: RSS includes OS page cache for mmap'd files.");
    println!("      Numbers are relative, not absolute memory cost.");
}
