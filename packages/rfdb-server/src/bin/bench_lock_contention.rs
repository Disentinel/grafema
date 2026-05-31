//! Lock-contention microbench for RFD-71.
//!
//! Pins down the write-parallelism curve that the production server is
//! currently capped by. The server wraps the whole engine in a single
//! `RwLock<Box<dyn GraphStore>>` (`database_manager.rs:125`) and every
//! `commitBatch` acquires it via `with_engine_write`
//! (`bin/rfdb_server.rs:2391`). Concurrent commits therefore serialise
//! *before* the multi-shard dispatch layer runs — which is why the
//! `par_iter_mut` patch in `multi_shard.rs:add_nodes` did not move the
//! vscode wall-time curve (only one commit ever holds the engine lock).
//!
//! This bench isolates exactly that structural variable. Two models run
//! the *identical* per-commit work (build N node records with real blake3
//! id hashing — representative ingest CPU — then `Shard::add_nodes`), and
//! differ only in lock granularity:
//!
//!   - `engine-wide`: one `Mutex<Vec<Shard>>` around all shards. A worker
//!     locks the whole vec to write its own shard. Models the current
//!     `RwLock<Engine>`: disjoint shard writes serialise anyway.
//!   - `per-shard`: `Vec<Mutex<Shard>>`. A worker locks only its own
//!     shard. Models the RFD-71 proposal: `shard[0]` and `shard[7]` are
//!     independent locks.
//!
//! Each worker writes to its *own* shard (worker `t` → shard `t`), so the
//! data is fully disjoint. Any serialisation in the `engine-wide` model is
//! purely the lock, not data conflict.
//!
//! Total work is held constant across thread counts (strong scaling):
//! `total_commits` commits are split evenly across the workers. Wall time
//! for the `per-shard` model should fall ~1/N; for `engine-wide` it should
//! stay flat (speedup ~1) — the single-core ceiling RFD-71 describes.
//!
//! Run:
//!   cargo run --release --bin bench_lock_contention
//!   cargo run --release --bin bench_lock_contention -- \
//!       --threads 1,2,4,8,16 --commits 256 --nodes-per-commit 4000
//!
//! Output is a markdown table (throughput + speedup per model) plus a
//! one-line verdict. Cross-check pcpu externally with e.g.
//! `/usr/bin/time -l` or a `ps`-based sampler; the speedup column is the
//! portable proxy for "how many cores did this actually use".

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use rfdb::storage_v2::shard::Shard;
use rfdb::storage_v2::types::NodeRecordV2;

/// Build `n` node records for `(shard_idx, commit_idx)` and insert them.
///
/// Record construction (incl. blake3 id hashing) happens *inside* this
/// function, and the whole function is the critical section in both
/// models — mirroring the production server, which holds the engine lock
/// for the entire `commit_batch` (tombstone scan, add, serialise), not
/// just the buffer push.
#[inline(never)]
fn build_and_insert(shard: &mut Shard, shard_idx: usize, commit_idx: usize, n: usize) {
    let file = format!("src/shard_{shard_idx}/file_{commit_idx}.ts");
    let mut records = Vec::with_capacity(n);
    for i in 0..n {
        // Globally-unique semantic id → distinct u128 per node.
        let sem_id = format!("FUNCTION:s{shard_idx}_c{commit_idx}_n{i}@{file}");
        let hash = blake3::hash(sem_id.as_bytes());
        let id = u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap());
        records.push(NodeRecordV2 {
            semantic_id: sem_id,
            id,
            node_type: "FUNCTION".to_string(),
            name: format!("fn_{i}"),
            file: file.clone(),
            content_hash: i as u64,
            metadata: String::new(),
        });
    }
    shard.add_nodes(records);
}

/// Distribute `total_commits` commits round-robin across `threads`
/// workers. Returns the per-worker commit count list (length == threads).
fn split_commits(total_commits: usize, threads: usize) -> Vec<usize> {
    let base = total_commits / threads;
    let rem = total_commits % threads;
    (0..threads).map(|t| base + if t < rem { 1 } else { 0 }).collect()
}

/// Run the engine-wide model: one Mutex around the whole shard vec.
/// Returns wall time.
fn run_engine_wide(threads: usize, per_worker: &[usize], nodes_per_commit: usize) -> Duration {
    let shards: Vec<Shard> = (0..threads).map(|_| Shard::ephemeral()).collect();
    let store = Arc::new(Mutex::new(shards));

    let start = Instant::now();
    thread::scope(|scope| {
        for t in 0..threads {
            let store = Arc::clone(&store);
            let commits = per_worker[t];
            scope.spawn(move || {
                for c in 0..commits {
                    // Whole engine locked to write a single shard — the
                    // current `RwLock<Engine>` behaviour. Record build runs
                    // under the lock, same as the server's commit_batch.
                    let mut guard = store.lock().unwrap();
                    build_and_insert(&mut guard[t], t, c, nodes_per_commit);
                }
            });
        }
    });
    start.elapsed()
}

/// Run the per-shard model: one Mutex per shard.
/// Returns wall time.
fn run_per_shard(threads: usize, per_worker: &[usize], nodes_per_commit: usize) -> Duration {
    let shards: Vec<Arc<Mutex<Shard>>> = (0..threads)
        .map(|_| Arc::new(Mutex::new(Shard::ephemeral())))
        .collect();

    let start = Instant::now();
    thread::scope(|scope| {
        for t in 0..threads {
            let shard = Arc::clone(&shards[t]);
            let commits = per_worker[t];
            scope.spawn(move || {
                for c in 0..commits {
                    // Only this worker's shard is locked — RFD-71 proposal.
                    let mut guard = shard.lock().unwrap();
                    build_and_insert(&mut guard, t, c, nodes_per_commit);
                }
            });
        }
    });
    start.elapsed()
}

#[derive(Clone, Copy, PartialEq)]
enum Model {
    EngineWide,
    PerShard,
    Both,
}

struct Args {
    thread_counts: Vec<usize>,
    total_commits: usize,
    nodes_per_commit: usize,
    model: Model,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            thread_counts: vec![1, 2, 4, 8, 16],
            total_commits: 256,
            nodes_per_commit: 4000,
            model: Model::Both,
        }
    }
}

fn parse_args() -> Args {
    let mut args = Args::default();
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--threads" => {
                i += 1;
                args.thread_counts = argv[i]
                    .split(',')
                    .filter_map(|s| s.trim().parse().ok())
                    .collect();
            }
            "--commits" => {
                i += 1;
                args.total_commits = argv[i].parse().expect("--commits must be an integer");
            }
            "--nodes-per-commit" => {
                i += 1;
                args.nodes_per_commit =
                    argv[i].parse().expect("--nodes-per-commit must be an integer");
            }
            "--model" => {
                i += 1;
                args.model = match argv[i].as_str() {
                    "engine" | "engine-wide" => Model::EngineWide,
                    "shard" | "per-shard" => Model::PerShard,
                    "both" => Model::Both,
                    other => {
                        eprintln!("--model must be engine|shard|both, got {other}");
                        std::process::exit(2);
                    }
                };
            }
            "-h" | "--help" => {
                eprintln!(
                    "usage: bench_lock_contention [--threads 1,2,4,8,16] \
                     [--commits N] [--nodes-per-commit N] [--model engine|shard|both]"
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("unknown arg: {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    args
}

fn throughput_nps(total_commits: usize, nodes_per_commit: usize, elapsed: Duration) -> f64 {
    let total_nodes = (total_commits * nodes_per_commit) as f64;
    total_nodes / elapsed.as_secs_f64()
}

/// Single-model CPU probe. Runs each thread count once for the selected
/// model only, so the process can be wrapped under `/usr/bin/time -l` to
/// read the CPU-time / wall-time ratio (≈ cores actually used). No
/// baselines or warmup of the other model, to keep the CPU attribution
/// clean.
fn run_cpu_probe(args: &Args, model: Model) {
    let label = if model == Model::EngineWide { "engine-wide" } else { "per-shard" };
    println!("# RFD-71 CPU probe — model={label}\n");
    println!(
        "total_commits={}  nodes_per_commit={}\n",
        args.total_commits, args.nodes_per_commit
    );
    println!("| threads | wall ms | nodes/s |");
    println!("|--------:|--------:|--------:|");
    for &threads in &args.thread_counts {
        if threads == 0 {
            continue;
        }
        let per_worker = split_commits(args.total_commits, threads);
        let elapsed = match model {
            Model::EngineWide => run_engine_wide(threads, &per_worker, args.nodes_per_commit),
            _ => run_per_shard(threads, &per_worker, args.nodes_per_commit),
        };
        println!(
            "| {:>7} | {:>7.1} | {:>7.2e} |",
            threads,
            elapsed.as_secs_f64() * 1000.0,
            throughput_nps(args.total_commits, args.nodes_per_commit, elapsed),
        );
    }
    println!(
        "\nWrap under `/usr/bin/time -l` and compute (user+sys)/real ≈ cores used."
    );
}

fn main() {
    let args = parse_args();

    if args.model != Model::Both {
        run_cpu_probe(&args, args.model);
        return;
    }

    let avail = thread::available_parallelism().map(|n| n.get()).unwrap_or(1);

    println!("# RFD-71 lock-contention microbench\n");
    println!(
        "total_commits={}  nodes_per_commit={}  available_parallelism={}\n",
        args.total_commits, args.nodes_per_commit, avail
    );
    println!("Strong scaling: total work held constant, split across N workers.");
    println!("Each worker writes its own shard (disjoint data); the only");
    println!("variable is lock granularity.\n");

    // Warm up the allocator / blake3 path so the first row isn't penalised.
    {
        let w = split_commits(8, 1);
        let _ = run_per_shard(1, &w, args.nodes_per_commit.min(256));
    }

    // Baselines at 1 thread for speedup reference.
    let base_w = split_commits(args.total_commits, 1);
    let base_ew = run_engine_wide(1, &base_w, args.nodes_per_commit);
    let base_ps = run_per_shard(1, &base_w, args.nodes_per_commit);
    let base_ew_nps = throughput_nps(args.total_commits, args.nodes_per_commit, base_ew);
    let base_ps_nps = throughput_nps(args.total_commits, args.nodes_per_commit, base_ps);

    println!("| threads | engine-wide ms | eng nodes/s | eng speedup | per-shard ms | shard nodes/s | shard speedup |");
    println!("|--------:|---------------:|------------:|------------:|-------------:|--------------:|--------------:|");

    for &threads in &args.thread_counts {
        if threads == 0 {
            continue;
        }
        let per_worker = split_commits(args.total_commits, threads);

        let ew = run_engine_wide(threads, &per_worker, args.nodes_per_commit);
        let ps = run_per_shard(threads, &per_worker, args.nodes_per_commit);

        let ew_nps = throughput_nps(args.total_commits, args.nodes_per_commit, ew);
        let ps_nps = throughput_nps(args.total_commits, args.nodes_per_commit, ps);

        println!(
            "| {:>7} | {:>14.1} | {:>11.2e} | {:>11.2} | {:>12.1} | {:>13.2e} | {:>13.2} |",
            threads,
            ew.as_secs_f64() * 1000.0,
            ew_nps,
            ew_nps / base_ew_nps,
            ps.as_secs_f64() * 1000.0,
            ps_nps,
            ps_nps / base_ps_nps,
        );
    }

    // Verdict at the largest thread count that fits available parallelism.
    let probe = *args
        .thread_counts
        .iter()
        .filter(|&&t| t > 0 && t <= avail)
        .max()
        .unwrap_or(&1);
    if probe > 1 {
        let w = split_commits(args.total_commits, probe);
        let ew = run_engine_wide(probe, &w, args.nodes_per_commit);
        let ps = run_per_shard(probe, &w, args.nodes_per_commit);
        let ew_speedup = throughput_nps(args.total_commits, args.nodes_per_commit, ew) / base_ew_nps;
        let ps_speedup = throughput_nps(args.total_commits, args.nodes_per_commit, ps) / base_ps_nps;
        println!(
            "\nverdict @ {probe} threads: engine-wide speedup {ew_speedup:.2}x \
             (caps at ~1 core), per-shard speedup {ps_speedup:.2}x"
        );
        if ps_speedup > ew_speedup * 1.5 {
            println!(
                "→ per-shard locking unlocks {:.1}x more write parallelism than the \
                 engine-wide lock. Confirms RFD-71 root cause.",
                ps_speedup / ew_speedup.max(1e-9)
            );
        } else {
            println!(
                "→ per-shard advantage NOT demonstrated at this scale — increase \
                 --nodes-per-commit (longer critical section) or --commits."
            );
        }
    }
}
