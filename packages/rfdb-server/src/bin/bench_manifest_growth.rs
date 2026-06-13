//! Manifest / per-commit cost growth probe (RFD-71 investigation).
//!
//! Question raised against the "manifests are cheap" claim: a past bug had
//! manifests eating disk. This probe measures, *deterministically* (bytes
//! and counts, not timing-sensitive), how per-commit cost and on-disk
//! footprint grow as a real on-disk graph is ingested commit-by-commit.
//!
//! What it measures, sampled as the graph grows:
//!   - `manifests/` total bytes + file count (is manifest disk bounded by
//!     the `gc_manifests(MANIFEST_GC_KEEP=3)` in `manifest.rs:900`?)
//!   - current manifest file bytes (the blob serialised under the engine
//!     lock on EVERY commit — grows with segment count × zone-map size,
//!     incl. each descriptor's `file_paths: HashSet<String>`)
//!   - `segments/` total bytes + file count
//!   - per-commit wall time (corroborating trend: does commit latency rise
//!     as the graph grows, i.e. is the under-lock work super-constant?)
//!
//! Two regimes: `--compact-every K` (0 = never). Compaction collapses L0
//! segments into L1 and bounds segment count; without it segment count and
//! thus manifest size grow unbounded.
//!
//! Run:
//!   cargo run --release --bin bench_manifest_growth -- \
//!       --files 2000 --nodes-per-file 80 --edges-per-file 40 \
//!       --sample-every 200 --compact-every 0
//!   ... then again with --compact-every 50 to compare.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use rfdb::graph::GraphEngineV2;
use rfdb::storage_v2::types::{EdgeRecordV2, NodeRecordV2};

fn node_id(sem_id: &str) -> u128 {
    let hash = blake3::hash(sem_id.as_bytes());
    u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap())
}

/// Build `m` nodes + `e` intra-file edges for file `idx`.
fn make_file(idx: usize, m: usize, e: usize) -> (Vec<NodeRecordV2>, Vec<EdgeRecordV2>, String) {
    let file = format!("src/pkg{}/mod{}/file_{}.ts", idx % 53, idx % 211, idx);
    let mut nodes = Vec::with_capacity(m);
    let mut ids = Vec::with_capacity(m);
    for n in 0..m {
        let sem_id = format!("FUNCTION:fn_{}_{}@{}", idx, n, file);
        let id = node_id(&sem_id);
        ids.push(id);
        nodes.push(NodeRecordV2 {
            semantic_id: sem_id,
            id,
            node_type: "FUNCTION".to_string(),
            name: format!("fn_{}", n),
            file: file.clone(),
            content_hash: (idx as u64).wrapping_mul(1000).wrapping_add(n as u64),
            metadata: String::new(),
        });
    }
    let mut edges = Vec::with_capacity(e);
    for k in 0..e.min(m.saturating_sub(1)) {
        edges.push(EdgeRecordV2 {
            src: ids[k % m],
            dst: ids[(k + 1) % m],
            edge_type: "CALLS".to_string(),
            metadata: String::new(),
        });
    }
    (nodes, edges, file)
}

/// Recursively sum file sizes and count files under `dir` (non-existent → 0).
fn dir_stats(dir: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut count = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let (b, c) = dir_stats(&path);
                bytes += b;
                count += c;
            } else if let Ok(meta) = entry.metadata() {
                bytes += meta.len();
                count += 1;
            }
        }
    }
    (bytes, count)
}

/// Largest single file (bytes) directly under `dir` (one level).
fn largest_file_bytes(dir: &Path) -> u64 {
    let mut max = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    max = max.max(meta.len());
                }
            }
        }
    }
    max
}

struct Args {
    files: usize,
    nodes_per_file: usize,
    edges_per_file: usize,
    sample_every: usize,
    compact_every: usize,
    bulk_load: bool,
    auto_threshold: usize,
    fanout: f64,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            files: 2000,
            nodes_per_file: 80,
            edges_per_file: 40,
            sample_every: 200,
            compact_every: 0,
            bulk_load: false,
            auto_threshold: 4,
            fanout: 4.0,
        }
    }
}

fn parse_args() -> Args {
    let mut a = Args::default();
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < argv.len() {
        let v = || argv[i + 1].parse().expect("expected integer arg");
        match argv[i].as_str() {
            "--files" => a.files = v(),
            "--nodes-per-file" => a.nodes_per_file = v(),
            "--edges-per-file" => a.edges_per_file = v(),
            "--sample-every" => a.sample_every = v(),
            "--compact-every" => a.compact_every = v(),
            "--auto-threshold" => a.auto_threshold = v(),
            "--fanout" => {
                // Accept "inf" for the legacy always-full-merge A/B baseline.
                let raw = &argv[i + 1];
                a.fanout = if raw.eq_ignore_ascii_case("inf") {
                    f64::INFINITY
                } else {
                    raw.parse().expect("expected float for --fanout")
                };
            }
            "--bulk-load" => {
                a.bulk_load = true;
                i -= 1; // flag has no value
            }
            "-h" | "--help" => {
                eprintln!(
                    "usage: bench_manifest_growth [--files N] [--nodes-per-file N] \
                     [--edges-per-file N] [--sample-every N] [--compact-every N]"
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("unknown arg: {other}");
                std::process::exit(2);
            }
        }
        i += 2;
    }
    a
}

fn main() {
    use rfdb::GraphStore;

    let args = parse_args();
    let db_path = std::env::temp_dir().join(format!(
        "rfdb-manifest-probe-{}-{}",
        std::process::id(),
        args.compact_every
    ));
    let _ = std::fs::remove_dir_all(&db_path);
    std::fs::create_dir_all(&db_path).unwrap();
    let db_path = db_path.as_path();
    let mut engine = GraphEngineV2::create(db_path).unwrap();

    let manifests_dir = db_path.join("manifests");
    let segments_dir = db_path.join("segments");

    println!("# RFD-71 manifest / per-commit growth probe\n");
    println!(
        "files={}  nodes_per_file={}  edges_per_file={}  compact_every={}  bulk_load={}  auto_threshold={}  fanout={}\n",
        args.files, args.nodes_per_file, args.edges_per_file, args.compact_every,
        args.bulk_load, args.auto_threshold, args.fanout
    );
    println!("| commit | nodes | cur manifest B | manifests/ B | #man | segments/ B | #seg | commit ms | comp ms |");
    println!("|-------:|------:|---------------:|-------------:|-----:|------------:|-----:|----------:|--------:|");

    // Bulk-load mode exercises the per-commit SIZE-TIERED auto-compaction (W7): each
    // commit may fire `maybe_auto_compact`, whose cost the `commit ms` column then
    // absorbs. (Without bulk-load, `--compact-every` calls the explicit FULL-MERGE
    // barrier instead.)
    if args.bulk_load {
        engine.set_auto_compact_threshold(args.auto_threshold);
        engine.set_auto_compact_fanout(args.fanout);
        engine.begin_bulk_load().unwrap();
    }

    let wall = Instant::now();
    let mut total_nodes = 0usize;
    let mut prev_auto = 0u64;
    for c in 0..args.files {
        let (nodes, edges, file) = make_file(c, args.nodes_per_file, args.edges_per_file);
        total_nodes += nodes.len();

        let t = Instant::now();
        engine
            .commit_batch(nodes, edges, std::slice::from_ref(&file), HashMap::new())
            .unwrap();
        // In bulk-load, commit_ms INCLUDES any auto-compaction fired this commit.
        let commit_ms = t.elapsed().as_secs_f64() * 1000.0;

        let mut comp_ms = 0.0;
        if args.bulk_load {
            // Surface the auto-compaction cost in the comp column when it fired this
            // commit (approximated by the slice of commit_ms above threshold-quick).
            let now_auto = engine.auto_compactions();
            if now_auto > prev_auto {
                comp_ms = commit_ms; // this commit's time was dominated by the auto-compact
                prev_auto = now_auto;
            }
        } else if args.compact_every > 0 && (c + 1) % args.compact_every == 0 {
            let tc = Instant::now();
            engine.compact().unwrap();
            comp_ms = tc.elapsed().as_secs_f64() * 1000.0;
        }

        if (c + 1) % args.sample_every == 0 || c + 1 == args.files {
            let (man_bytes, man_count) = dir_stats(&manifests_dir);
            let cur_man = largest_file_bytes(&manifests_dir);
            let (seg_bytes, seg_count) = dir_stats(&segments_dir);
            println!(
                "| {:>6} | {:>5} | {:>14} | {:>12} | {:>4} | {:>11} | {:>4} | {:>9.2} | {:>7.2} |",
                c + 1,
                total_nodes,
                cur_man,
                man_bytes,
                man_count,
                seg_bytes,
                seg_count,
                commit_ms,
                comp_ms,
            );
        }
    }

    let ingest_wall_ms = wall.elapsed().as_secs_f64() * 1000.0;
    let auto_compactions = engine.auto_compactions();

    // Final flush so on-disk state is complete for the last reading.
    if args.bulk_load {
        // end_bulk_load runs the final FULL-MERGE barrier + durable barrier.
        engine.end_bulk_load().unwrap();
    }
    engine.flush().unwrap();
    let (man_bytes, _) = dir_stats(&manifests_dir);
    let cur_man = largest_file_bytes(&manifests_dir);
    let (seg_bytes, _) = dir_stats(&segments_dir);
    println!(
        "\nfinal: nodes={}  current-manifest={} B  manifests/={} B  segments/={} B",
        total_nodes, cur_man, man_bytes, seg_bytes
    );
    if args.bulk_load {
        println!(
            "bulk-load: ingest_wall={:.1} ms  auto_compactions={}  (size-tiered per-commit path)",
            ingest_wall_ms, auto_compactions
        );
    }
    println!(
        "note: current-manifest bytes is serialised under the engine lock on EVERY commit; \
         watch whether it (and commit ms) grow with the graph."
    );

    drop(engine);
    let _ = std::fs::remove_dir_all(db_path);
}
