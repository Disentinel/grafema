//! MVCC C1 — group-commit stress tests (RFD-71 phase C1).
//!
//! B4 delivered real lock-free parallel build/flush (build_peak == n_threads)
//! but only ~1.61x WALL speedup because the commit point — manifest `commit_edit`
//! (temp+fsync+rename of manifest edit + index + current.json under one mutex) —
//! is serialized: N concurrent commits queue their fsyncs on one disk. C1 adds a
//! classic leader/follower GROUP-COMMIT so the manifest durable write happens ONCE
//! per BATCH of commits, amortizing the fsync across the batch. These tests prove
//! the three C1 acceptance properties via the SAME high-level engine API the B4
//! 1.61x baseline used (`GraphEngineV2::commit_batch_concurrent`):
//!
//!   (1) THROUGHPUT: N threads commit DISJOINT files repeatedly (the B4 workload,
//!       but small-batch so the commit point — not build/flush — dominates and the
//!       group-commit amortization is what moves the needle). We measure wall-clock
//!       speedup vs the SAME total work run serially on one thread, and report the
//!       observed avg/max `group_commit_batch_size`. Target: materially better than
//!       the B4 1.61x baseline (> ~2.5x on this box's cores).
//!
//!   (2) INTEGRITY: a concurrent storm (disjoint files + a same-file contended
//!       slice + a re-analysis/delete phase) → final node/edge counts == an
//!       INDEPENDENT oracle, reopen ×2 is bit-faithful, no loss, no deadlock.
//!
//!   (3) INTRA-BATCH CONFLICT: many threads hammer the SAME file at once so
//!       multiple land in ONE group-commit batch → exactly one wins per batch, the
//!       others abort+retry (loud `commit_conflict_retries` counter), no lost
//!       update, bounded.
//!
//! ⚠️ WATCHDOG (MANDATORY — a prior 2PL stress hung 16h): every test arms an
//! in-process watchdog thread that, after a hard timeout, prints + calls
//! `std::process::abort()` so a deadlock FAILS LOUD instead of hanging. Disarmed
//! on the normal exit path. Run under a shell timeout too.
//!
//! Run: cargo test --release -p rfdb --test mvcc_c1_groupcommit -- --nocapture

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use rfdb::error::GraphError;
use rfdb::graph::GraphEngineV2;
use rfdb::storage_v2::types::{EdgeRecordV2, NodeRecordV2};
use rfdb::GraphStore;
use tempfile::TempDir;

// ── Watchdog ────────────────────────────────────────────────────────────────

/// Arms an in-process watchdog: spawns a thread that sleeps `secs` and, unless
/// `disarm` flips first, prints + `std::process::abort()`s. A deadlock in the
/// engine therefore aborts the whole test binary (loud cargo failure) instead
/// of hanging. Returns the `disarm` flag — set it true on the success path.
fn arm_watchdog(secs: u64, label: &'static str) -> Arc<AtomicBool> {
    let disarm = Arc::new(AtomicBool::new(false));
    let d = Arc::clone(&disarm);
    thread::Builder::new()
        .name(format!("c1-watchdog-{label}"))
        .spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(secs);
            while Instant::now() < deadline {
                if d.load(Ordering::SeqCst) {
                    return; // disarmed: test finished normally
                }
                thread::sleep(Duration::from_millis(100));
            }
            if d.load(Ordering::SeqCst) {
                return;
            }
            eprintln!(
                "C1 WATCHDOG: deadlock, aborting (test={label} exceeded {secs}s hard timeout)"
            );
            std::process::abort();
        })
        .expect("spawn watchdog");
    disarm
}

// ── Record builders (blake3-derived ids, matching the engine's contract) ──────

fn id_of(semantic_id: &str) -> u128 {
    let hash = blake3::hash(semantic_id.as_bytes());
    u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap())
}

/// Build a deterministic node/edge batch for `file` with `n` FUNCTION nodes and
/// `n` intra-file CALLS edges (edge i: node i -> node (i+1)%n). `content_hash`
/// makes a re-analysis revision distinguishable while keeping the same ids — so
/// two threads racing the same (file, n) are idempotent and the oracle is
/// deterministic regardless of which one wins.
fn make_batch(file: &str, n: usize, content_hash: u64) -> (Vec<NodeRecordV2>, Vec<EdgeRecordV2>) {
    let nodes: Vec<NodeRecordV2> = (0..n)
        .map(|i| {
            let sem = format!("FUNCTION:{file}#fn_{i}");
            NodeRecordV2 {
                id: id_of(&sem),
                semantic_id: sem,
                node_type: "FUNCTION".to_string(),
                name: format!("fn_{i}"),
                file: file.to_string(),
                content_hash,
                metadata: String::new(),
            }
        })
        .collect();
    let edges: Vec<EdgeRecordV2> = if n == 0 {
        Vec::new()
    } else {
        (0..n)
            .map(|i| EdgeRecordV2 {
                src: nodes[i].id,
                dst: nodes[(i + 1) % n].id,
                edge_type: "CALLS".to_string(),
                metadata: String::new(),
            })
            .collect()
    };
    (nodes, edges)
}

/// Live-edge count for a file whose final node set has `n` nodes (all intra-file
/// edges survive iff their file's nodes are live; n>=2 => n distinct, n==1 => 1
/// self-loop, n==0 => 0).
fn live_edges_for(n: usize) -> usize {
    n
}

const MAX_RETRIES: u32 = 8;

/// Retry wrapper around the concurrent commit: on `ConflictedCommit`, rebuild the
/// batch from a fresh snapshot and retry, bounded at `MAX_RETRIES`. Returns the
/// number of conflict-aborts for this logical commit (0 on a clean first win).
fn commit_with_retry(engine: &GraphEngineV2, file: &str, n: usize, content_hash: u64) -> u32 {
    let mut aborts = 0u32;
    loop {
        let (nodes, edges) = make_batch(file, n, content_hash);
        match engine.commit_batch_concurrent(
            nodes,
            edges,
            std::slice::from_ref(&file.to_string()),
            HashMap::new(),
            &[],
        ) {
            Ok(_) => return aborts,
            Err(GraphError::ConflictedCommit { .. }) => {
                aborts += 1;
                assert!(
                    aborts <= MAX_RETRIES,
                    "retry bound exceeded for file {file} (>{MAX_RETRIES} conflict aborts)"
                );
                continue;
            }
            Err(e) => panic!("unexpected commit error for {file}: {e}"),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — THROUGHPUT: group-commit amortizes the commit-point fsync.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c1_throughput_disjoint_parallelism() {
    // 180s hard watchdog. The serial baseline below issues THREADS*COMMITS_PER
    // Strict-fsync commits one-at-a-time — slow but cannot deadlock. The
    // concurrent run is the part that could deadlock; the watchdog covers both
    // (serial is just slow, never hangs). Generous budget because every commit
    // fsyncs.
    let disarm = arm_watchdog(180, "throughput");

    // Workload shape: MANY threads, MANY SMALL commits. Small per-commit batches
    // mean the FIXED commit-point cost (manifest fsync) dominates the work — so
    // this is exactly where B4 stalled at ~1.61x and where C1's group-commit can
    // pay off: when N threads pile up at the commit point, ONE leader drains them
    // and does ONE fsync for the whole batch. (Large per-commit batches would
    // hide the effect — build/flush would dominate and the B4 baseline already
    // overlapped that.)
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(4, 16))
        .unwrap_or(4);
    // Oversubscribe relative to cores so many commits queue at the commit point
    // simultaneously (that's what forms big batches). On a 4-core box this gives
    // 16 writer threads contending the commit point.
    let n_threads = (n_threads * 4).min(16).max(n_threads);
    const COMMITS_PER_THREAD: usize = 80;
    const NODES_PER_COMMIT: usize = 4; // SMALL ⇒ fsync-per-commit dominates.

    // ---- Serial baseline: one thread does ALL the commits (no group-commit can
    // form — every batch is size 1 — so this is the un-amortized fsync cost). ----
    let serial_dir = TempDir::new().unwrap();
    let serial_path = serial_dir.path().join("serial.rfdb");
    let serial_engine = GraphEngineV2::create(&serial_path).unwrap();
    assert!(serial_engine.supports_concurrent_commit());
    let serial_start = Instant::now();
    for t in 0..n_threads {
        for c in 0..COMMITS_PER_THREAD {
            let file = format!("serial/t{t}/file_{c}.js");
            let (nodes, edges) = make_batch(&file, NODES_PER_COMMIT, 1);
            serial_engine
                .commit_batch_concurrent(
                    nodes,
                    edges,
                    std::slice::from_ref(&file),
                    HashMap::new(),
                    &[],
                )
                .expect("serial commit");
        }
    }
    let serial_wall = serial_start.elapsed();
    let serial_mean_batch = serial_engine.group_commit_batch_size();
    let serial_max_batch = serial_engine.group_commit_batch_size_max();

    // ---- Concurrent run: n_threads, each its own disjoint file space ----
    let conc_dir = TempDir::new().unwrap();
    let conc_path = conc_dir.path().join("concurrent.rfdb");
    let conc_engine = Arc::new(GraphEngineV2::create(&conc_path).unwrap());
    let barrier = Arc::new(Barrier::new(n_threads));
    let conc_start = Instant::now();
    let mut handles = Vec::new();
    for t in 0..n_threads {
        let engine = Arc::clone(&conc_engine);
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            for c in 0..COMMITS_PER_THREAD {
                let file = format!("conc/t{t}/file_{c}.js");
                let aborts = commit_with_retry(&engine, &file, NODES_PER_COMMIT, 1);
                assert_eq!(aborts, 0, "disjoint file {file} must not conflict");
            }
        }));
    }
    for h in handles {
        h.join().expect("parallel thread panicked");
    }
    let conc_wall = conc_start.elapsed();

    let build_peak = conc_engine.commit_build_peak();
    let mean_batch = conc_engine.group_commit_batch_size();
    let max_batch = conc_engine.group_commit_batch_size_max();
    let n_batches = conc_engine.group_commit_batches();

    // ---- Integrity: concurrent run committed every node, zero conflicts ----
    let expected = n_threads * COMMITS_PER_THREAD * NODES_PER_COMMIT;
    assert_eq!(
        conc_engine.node_count(),
        expected,
        "concurrent run must have committed every node (no loss)"
    );
    assert_eq!(
        conc_engine.commit_conflict_retries(),
        0,
        "disjoint-file workload must produce ZERO conflicts"
    );

    let speedup = serial_wall.as_secs_f64() / conc_wall.as_secs_f64();

    eprintln!(
        "[c1_throughput] threads={n_threads} commits/thread={COMMITS_PER_THREAD} nodes/commit={NODES_PER_COMMIT}"
    );
    eprintln!(
        "[c1_throughput] serial : wall={:.3}s mean_batch={serial_mean_batch:.2} max_batch={serial_max_batch}",
        serial_wall.as_secs_f64()
    );
    eprintln!(
        "[c1_throughput] concur : wall={:.3}s mean_batch={mean_batch:.2} max_batch={max_batch} batches={n_batches} build_peak={build_peak}/{n_threads}",
        conc_wall.as_secs_f64()
    );
    eprintln!("[c1_throughput] WALL_SPEEDUP={speedup:.2}x   (B4 baseline was 1.61x; C1 target > ~2.5x)");

    // ── Acceptance ─────────────────────────────────────────────────────────
    // The serial run can never form a batch > 1 (only one commit ever at the
    // commit point). The concurrent run MUST form real batches (mean > 1) — that
    // is the amortization firing.
    assert!(
        (serial_max_batch <= 1) && (serial_mean_batch - 1.0).abs() < 1e-9,
        "serial baseline must have batch size 1 (no group-commit possible): mean={serial_mean_batch} max={serial_max_batch}"
    );
    assert!(
        mean_batch > 1.0,
        "C1 group-commit must fold multiple commits per durable write: mean_batch={mean_batch} (<=1 means amortization never fired)"
    );
    assert!(
        max_batch >= 2,
        "C1 must observe at least one multi-commit batch: max_batch={max_batch}"
    );
    // HEADLINE: materially better than the B4 1.61x baseline.
    assert!(
        speedup > 2.5,
        "C1 group-commit expected WALL speedup > 2.5x (B4 was 1.61x), got {speedup:.2}x \
         (serial={:.3}s concurrent={:.3}s mean_batch={mean_batch:.2})",
        serial_wall.as_secs_f64(),
        conc_wall.as_secs_f64()
    );

    disarm.store(true, Ordering::SeqCst);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — INTEGRITY: concurrent storm (disjoint + same-file + deletes).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c1_integrity_storm() {
    let disarm = arm_watchdog(180, "integrity");

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("integrity.rfdb");

    const N_THREADS: usize = 16;
    const FILES_PER_THREAD: usize = 12;
    const NODES_INIT: usize = 24;
    const NODES_REANALYZED: usize = 10; // re-analysis drops to 10 nodes
    const SHARED_FILES: usize = 4; // small contended pool ⇒ real conflicts

    let (oracle_nodes, oracle_edges, in_session_nodes, in_session_edges) = {
        let engine = Arc::new(GraphEngineV2::create(&db_path).unwrap());
        assert!(engine.supports_concurrent_commit());

        // ---- Phase A: disjoint initial ingest + a shared-file slice ----
        let barrier = Arc::new(Barrier::new(N_THREADS));
        let mut handles = Vec::new();
        for t in 0..N_THREADS {
            let engine = Arc::clone(&engine);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                for f in 0..FILES_PER_THREAD {
                    let file = format!("t{t}/file_{f}.js");
                    let aborts = commit_with_retry(&engine, &file, NODES_INIT, 1);
                    assert_eq!(aborts, 0, "disjoint file {file} must not conflict");
                }
                // Each thread commits ONE shared file (idempotent content) to
                // force genuine same-file write-write conflicts mid-storm. 16/4=4
                // threads per shared file — well under the 8-retry bound.
                let file = format!("shared/file_{}.js", t % SHARED_FILES);
                commit_with_retry(&engine, &file, NODES_INIT, 7);
            }));
        }
        for h in handles {
            h.join().expect("ingest thread panicked");
        }

        // ---- Phase B: concurrent RE-ANALYSIS (owner-exclusive, deletes nodes) ----
        let barrier2 = Arc::new(Barrier::new(N_THREADS));
        let mut handles = Vec::new();
        for t in 0..N_THREADS {
            let engine = Arc::clone(&engine);
            let barrier2 = Arc::clone(&barrier2);
            handles.push(thread::spawn(move || {
                barrier2.wait();
                // Re-analyze EVEN-indexed files down to NODES_REANALYZED (this
                // tombstones the dropped nodes — the "delete" axis of the storm).
                for f in 0..FILES_PER_THREAD {
                    if f % 2 == 0 {
                        let file = format!("t{t}/file_{f}.js");
                        let aborts = commit_with_retry(&engine, &file, NODES_REANALYZED, 2);
                        assert_eq!(aborts, 0, "owner re-analysis of {file} must not conflict");
                    }
                }
            }));
        }
        for h in handles {
            h.join().expect("reanalysis thread panicked");
        }

        // ---- Independent oracle ----
        let mut oracle_nodes = 0usize;
        let mut oracle_edges = 0usize;
        for _t in 0..N_THREADS {
            for f in 0..FILES_PER_THREAD {
                let n = if f % 2 == 0 { NODES_REANALYZED } else { NODES_INIT };
                oracle_nodes += n;
                oracle_edges += live_edges_for(n);
            }
        }
        for _s in 0..SHARED_FILES {
            oracle_nodes += NODES_INIT;
            oracle_edges += live_edges_for(NODES_INIT);
        }

        let in_session_nodes = engine.node_count();
        let in_session_edges = engine.edge_count();
        assert_eq!(in_session_nodes, oracle_nodes, "node_count == oracle");
        assert_eq!(in_session_edges, oracle_edges, "edge_count == oracle");

        let retries = engine.commit_conflict_retries();
        let mean_batch = engine.group_commit_batch_size();
        let max_batch = engine.group_commit_batch_size_max();
        eprintln!(
            "[c1_integrity] threads={N_THREADS} oracle_nodes={oracle_nodes} oracle_edges={oracle_edges} \
             conflict_retries={retries} mean_batch={mean_batch:.2} max_batch={max_batch}"
        );
        assert!(
            retries > 0,
            "the shared-file slice must have produced at least one conflict-retry"
        );

        (oracle_nodes, oracle_edges, in_session_nodes, in_session_edges)
    }; // engine dropped here

    // ---- Reopen ×2: bit-faithful ----
    for pass in 1..=2 {
        let engine = GraphEngineV2::open(&db_path).unwrap();
        assert_eq!(
            engine.node_count(),
            in_session_nodes,
            "reopen pass {pass}: node_count must match in-session ({oracle_nodes})"
        );
        assert_eq!(
            engine.edge_count(),
            in_session_edges,
            "reopen pass {pass}: edge_count must match in-session ({oracle_edges})"
        );
        // Spot-check a re-analyzed file: fn_0 live, fn_23 tombstoned.
        let live = id_of("FUNCTION:t0/file_0.js#fn_0");
        let gone = id_of("FUNCTION:t0/file_0.js#fn_23");
        assert!(engine.node_exists(live), "reopen pass {pass}: kept node must be live");
        assert!(
            !engine.node_exists(gone),
            "reopen pass {pass}: re-analysis-dropped node must be gone"
        );
    }

    disarm.store(true, Ordering::SeqCst);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — INTRA-BATCH CONFLICT: many threads hammer ONE file at once.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c1_intra_batch_conflict() {
    // Many threads racing the SAME file concurrently — so MULTIPLE same-file
    // commits land in ONE group-commit batch. The leader keeps the FIRST and
    // aborts the rest (intra-batch conflict). Exactly one wins per batch, the
    // losers retry from a fresh snapshot, the loud counter increments, no lost
    // update, bounded retries.
    let disarm = arm_watchdog(180, "intra_batch");

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("intra.rfdb");
    let engine = Arc::new(GraphEngineV2::create(&db_path).unwrap());

    // Contention width is chosen against the retry BOUND, on purpose. Under the
    // per-round lock-step below, all W threads flood the commit point at once;
    // the leader publishes ONE and aborts the (W-1) same-file losers (intra-batch
    // conflict). The losers immediately retry and race among themselves — one
    // wins, the rest retry — so within a single round a given logical commit can
    // abort at most (W-1) times. The contract caps retries at MAX_RETRIES (8) and
    // treats exhaustion as a legitimate HARD error (pathological same-file
    // contention). So we pick W=6 (worst-case 5 aborts < 8) to exercise the
    // intra-batch path AGGRESSIVELY while staying comfortably bounded — the test
    // proves correct+bounded handling, not bound exhaustion. (W>=9 would
    // legitimately exhaust the bound; that is a different, also-correct outcome.)
    // ROUNDS kept modest: every same-file commit re-serializes + fsyncs a manifest
    // checkpoint, and same-file contention multiplies that via the retries — so
    // this test is write/fsync-bound (a sample under load showed workers in
    // serde_json::serialize_field → File::write inside group_commit_publish, plus
    // followers in the result-slot condvar — forward progress, NOT a deadlock).
    // 6 threads × 30 rounds = 180 logical commits exercises hundreds of intra-batch
    // conflict aborts while finishing well under the watchdog.
    const N_THREADS: usize = 6;
    const ROUNDS: usize = 30;
    const NODES: usize = 16;
    let file = "contended/hot.js".to_string();

    let round_barrier = Arc::new(Barrier::new(N_THREADS));
    let total_aborts = Arc::new(AtomicU64::new(0));
    let total_commits = Arc::new(AtomicU64::new(0));
    // Max aborts observed for any SINGLE logical commit — the bounded-retry
    // witness (must stay <= MAX_RETRIES; commit_with_retry hard-asserts it too).
    let max_aborts_one = Arc::new(AtomicU64::new(0));

    let mut handles = Vec::new();
    for worker in 0..N_THREADS as u64 {
        let engine = Arc::clone(&engine);
        let round_barrier = Arc::clone(&round_barrier);
        let total_aborts = Arc::clone(&total_aborts);
        let total_commits = Arc::clone(&total_commits);
        let max_aborts_one = Arc::clone(&max_aborts_one);
        let file = file.clone();
        handles.push(thread::spawn(move || {
            for r in 0..ROUNDS {
                // Distinct content_hash per (round, worker): a different revision
                // won't change the id set (idempotent shape) but lets the conflict
                // path be exercised honestly (real write-write, not a no-op).
                let ch = (r as u64) * (N_THREADS as u64) + worker + 1000;
                round_barrier.wait(); // all N workers enter the round together
                let aborts = commit_with_retry(&engine, &file, NODES, ch) as u64;
                total_aborts.fetch_add(aborts, Ordering::Relaxed);
                total_commits.fetch_add(1, Ordering::Relaxed);
                let mut cur = max_aborts_one.load(Ordering::Relaxed);
                while aborts > cur {
                    match max_aborts_one.compare_exchange(
                        cur, aborts, Ordering::Relaxed, Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(actual) => cur = actual,
                    }
                }
            }
        }));
    }
    for h in handles {
        h.join().expect("conflict thread panicked");
    }

    let observed_aborts = total_aborts.load(Ordering::Relaxed);
    let counter = engine.commit_conflict_retries();
    let commits = total_commits.load(Ordering::Relaxed);
    let mean_batch = engine.group_commit_batch_size();
    let max_batch = engine.group_commit_batch_size_max();
    let worst_one = max_aborts_one.load(Ordering::Relaxed);

    eprintln!(
        "[c1_intra_batch] threads={N_THREADS} rounds={ROUNDS} logical_commits={commits} \
         test_observed_aborts={observed_aborts} engine_conflict_counter={counter} \
         max_aborts_for_one_commit={worst_one}/{MAX_RETRIES} mean_batch={mean_batch:.2} max_batch={max_batch}"
    );

    // ---- Bounded: no single logical commit exceeded the retry cap ----
    assert!(
        worst_one <= MAX_RETRIES as u64,
        "retries must be bounded: worst single-commit aborts={worst_one} > MAX_RETRIES={MAX_RETRIES}"
    );

    // ---- Same-file concurrent commits DID conflict ----
    assert!(
        counter > 0,
        "{N_THREADS} threads racing the same file {ROUNDS} rounds must trip the conflict path; counter={counter}"
    );
    // ---- The engine's loud counter == the ConflictedCommit aborts the test saw ----
    assert_eq!(
        counter, observed_aborts,
        "engine commit_conflict_retries ({counter}) must equal the ConflictedCommit aborts the test observed ({observed_aborts})"
    );
    // ---- We actually formed multi-commit batches (so INTRA-batch conflict — not
    // just inter-batch — was exercised). With N threads flooding one file per
    // round, batches > 1 must occur. ----
    assert!(
        max_batch >= 2,
        "wide same-file flood must form at least one multi-commit batch (intra-batch path): max_batch={max_batch}"
    );
    // ---- Every logical commit eventually succeeded (no lost update) ----
    assert_eq!(
        commits as usize,
        N_THREADS * ROUNDS,
        "every logical commit must eventually succeed"
    );

    // ---- Final state correct & uncorrupted: ONE file, NODES nodes, regardless
    // of which revision won each round. ----
    assert_eq!(
        engine.node_count(),
        NODES,
        "final live node_count for the single contended file"
    );
    assert_eq!(
        engine.edge_count(),
        live_edges_for(NODES),
        "final live edge_count for the single contended file"
    );

    // ---- Reopen faithful (commit point already persisted) ----
    drop(engine);
    let reopened = GraphEngineV2::open(&db_path).unwrap();
    assert_eq!(reopened.node_count(), NODES, "reopen: node_count");
    assert_eq!(reopened.edge_count(), live_edges_for(NODES), "reopen: edge_count");

    disarm.store(true, Ordering::SeqCst);
}
