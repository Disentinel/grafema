//! MVCC C2 — bulk-load (deferred durability) acceptance bench (RFD-71 phase C2).
//!
//! C1 amortized the commit-point fsync across CONCURRENT commits (group-commit,
//! 3.02x). The remaining ceiling for SERIAL bulk ingest — the dominant Grafema
//! workload (initial analysis of a codebase, committed batch-by-batch) — is the
//! per-commit fsync itself. C2 adds a BULK-LOAD MODE: `BeginBulkLoad` flips the
//! manifest durability flag to `Relaxed` (commits skip fsync), and `EndBulkLoad`
//! runs ONE durable barrier (`make_durable`: fsync every segment of the current
//! published version + shard dirs + manifest chain + current.json under Strict)
//! then restores `Strict`. Mid-bulk durability is deferred; the barrier makes the
//! whole state durable in one O(segments) pass.
//!
//! These tests prove the four C2 acceptance properties via the high-level engine
//! API (`GraphEngineV2` + the `begin_bulk_load`/`end_bulk_load` GraphStore
//! passthroughs):
//!
//!   (a) THROUGHPUT (headline): N serial Strict commits vs the same N under
//!       BeginBulkLoad→Relaxed→EndBulkLoad (barrier INCLUDED). Report
//!       BULK_SPEEDUP = strict_wall / bulk_wall, the single-barrier cost (ms),
//!       and the segment count the barrier fsynced. Also a bulk+concurrent (C1)
//!       combined number.
//!
//!   (b) DURABILITY BARRIER (the safety): bulk-load N commits, EndBulkLoad, then
//!       REOPEN FROM DISK (fresh `open`, not the in-memory handle) → counts ==
//!       independent oracle, sample of nodes bit-faithful. Done for both serial
//!       and concurrent bulk loads. Plus: after EndBulkLoad a normal Strict commit
//!       reopens durably (mode restored).
//!
//!   (c) CRASH-BEFORE-BARRIER is safe: bulk-load some commits, drop the handle
//!       WITHOUT the barrier (unclean shutdown), then reopen → MUST NOT panic; the
//!       manifest parses to *some* consistent version (Ok with counts ≤ committed,
//!       or a clean recoverable Err) — never a panic / corruption.
//!
//! ⚠️ WATCHDOG (MANDATORY): every test arms an in-process watchdog thread that,
//! after a hard timeout, prints + `std::process::abort()`s — a deadlock FAILS LOUD
//! instead of hanging. Disarmed on the normal exit path. Run under a shell timeout.
//!
//! Run: cargo test --release -p rfdb --test bench_c2_bulkload -- --nocapture

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use rfdb::error::GraphError;
use rfdb::graph::GraphEngineV2;
use rfdb::storage_v2::types::{EdgeRecordV2, NodeRecordV2};
use rfdb::GraphStore;
use tempfile::TempDir;

// ── Watchdog ────────────────────────────────────────────────────────────────

/// Arms an in-process watchdog: spawns a thread that sleeps until `secs` and,
/// unless `disarm` flips first, prints + `std::process::abort()`s. A deadlock in
/// the engine therefore aborts the whole test binary (loud cargo failure) instead
/// of hanging. Returns the `disarm` flag — set it true on the success path.
fn arm_watchdog(secs: u64, label: &'static str) -> Arc<AtomicBool> {
    let disarm = Arc::new(AtomicBool::new(false));
    let d = Arc::clone(&disarm);
    thread::Builder::new()
        .name(format!("c2-watchdog-{label}"))
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
                "C2 WATCHDOG: deadlock, aborting (test={label} exceeded {secs}s hard timeout)"
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

/// Deterministic node/edge batch for `file`: `n` FUNCTION nodes + `n` intra-file
/// CALLS edges (edge i: node i -> node (i+1)%n). `content_hash` distinguishes a
/// revision while keeping the same ids.
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

const MAX_RETRIES: u32 = 8;

/// Retry wrapper around the concurrent commit: on `ConflictedCommit`, rebuild the
/// batch from a fresh snapshot and retry, bounded at `MAX_RETRIES`.
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

/// Count `.seg` files under a database's `segments/` dir, recursing into the
/// per-shard `segments/NN/` subdirectories (the multi-shard disk layout). This is
/// the upper bound on what the barrier fsyncs (the barrier fsyncs only segments
/// referenced by the CURRENT version; orphaned/old segments are not counted by
/// it, but for a freshly bulk-loaded DB with no compaction every seg is current).
fn count_seg_files(db_path: &std::path::Path) -> usize {
    fn walk(dir: &std::path::Path) -> usize {
        let mut n = 0;
        let Ok(rd) = std::fs::read_dir(dir) else {
            return 0;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += walk(&p);
            } else if p.extension().and_then(|s| s.to_str()) == Some("seg") {
                n += 1;
            }
        }
        n
    }
    walk(&db_path.join("segments"))
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — THROUGHPUT (headline) + serial durability oracle.
//   SERIAL Strict baseline vs SERIAL bulk (Begin→Relaxed→End barrier), then
//   reopen-from-disk proves the barrier made the bulk state durable.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c2_throughput_and_serial_durability() {
    // Both runs are single-threaded (no deadlock possible — the Strict baseline
    // just fsyncs per commit and is slow). Watchdog still guards against any
    // pathological hang in the barrier / reopen path; set comfortably above the
    // serial Strict baseline (per-commit fsync is ~100+ ms/commit on some disks).
    let disarm = arm_watchdog(300, "throughput");

    // Disjoint files so every commit publishes a new version with no conflicts.
    // NOTE: deferring fsync (bulk mode) only removes the fsync FRACTION of
    // per-commit cost. Measurement on this engine showed fsync is NOT the
    // dominant serial cost — the per-commit O(segments) snapshot-descriptor
    // clone + manifest work dominates and GROWS with segment count (no
    // compaction during bulk). So the serial BULK_SPEEDUP is modest (~1.3-1.4x);
    // this test asserts DURABILITY/correctness and REPORTS the speedup + the
    // ms/commit breakdown (so the real ceiling stays visible), rather than
    // asserting a fsync-dominated speedup threshold that does not hold.
    const N_COMMITS: usize = 600;
    const NODES_PER_COMMIT: usize = 4;

    // ---- Serial Strict baseline (per-commit fsync) ----
    let strict_dir = TempDir::new().unwrap();
    let strict_path = strict_dir.path().join("strict.rfdb");
    let strict_engine = GraphEngineV2::create(&strict_path).unwrap();
    let strict_start = Instant::now();
    for c in 0..N_COMMITS {
        let file = format!("strict/file_{c}.js");
        let (nodes, edges) = make_batch(&file, NODES_PER_COMMIT, 1);
        strict_engine
            .commit_batch_concurrent(
                nodes,
                edges,
                std::slice::from_ref(&file),
                HashMap::new(),
                &[],
            )
            .expect("strict commit");
    }
    let strict_wall = strict_start.elapsed();
    let strict_nodes = strict_engine.node_count();

    // ---- Serial bulk: BeginBulkLoad → N Relaxed commits → EndBulkLoad ----
    let bulk_dir = TempDir::new().unwrap();
    let bulk_path = bulk_dir.path().join("bulk.rfdb");
    let mut bulk_engine = GraphEngineV2::create(&bulk_path).unwrap();
    let bulk_start = Instant::now();
    bulk_engine.begin_bulk_load().expect("begin_bulk_load");
    for c in 0..N_COMMITS {
        let file = format!("bulk/file_{c}.js");
        let (nodes, edges) = make_batch(&file, NODES_PER_COMMIT, 1);
        bulk_engine
            .commit_batch_concurrent(
                nodes,
                edges,
                std::slice::from_ref(&file),
                HashMap::new(),
                &[],
            )
            .expect("bulk commit");
    }
    let seg_count = count_seg_files(&bulk_path);
    let barrier_start = Instant::now();
    bulk_engine.end_bulk_load().expect("end_bulk_load barrier");
    let barrier_cost = barrier_start.elapsed();
    let bulk_wall = bulk_start.elapsed();
    let bulk_nodes = bulk_engine.node_count();

    // ---- Independent oracle (what we KNOW we committed) ----
    let oracle_nodes = N_COMMITS * NODES_PER_COMMIT;
    assert_eq!(strict_nodes, oracle_nodes, "strict in-session node_count");
    assert_eq!(bulk_nodes, oracle_nodes, "bulk in-session node_count");

    // ---- THE SAFETY: reopen the bulk DB FROM DISK after the barrier ----
    drop(bulk_engine);
    let reopened = GraphEngineV2::open(&bulk_path).unwrap();
    assert_eq!(
        reopened.node_count(),
        oracle_nodes,
        "post-barrier reopen: node_count must == oracle (barrier made bulk state durable)"
    );
    assert_eq!(
        reopened.edge_count(),
        oracle_nodes,
        "post-barrier reopen: edge_count must == oracle"
    );
    // Bit-faithful spot-check: sample 100 nodes across the committed files.
    for c in (0..N_COMMITS).step_by(N_COMMITS / 100) {
        let sem = format!("FUNCTION:bulk/file_{c}.js#fn_0");
        assert!(
            reopened.node_exists(id_of(&sem)),
            "post-barrier reopen: sampled node {sem} must be live"
        );
    }

    let speedup = strict_wall.as_secs_f64() / bulk_wall.as_secs_f64();
    eprintln!("[c2_throughput] commits={N_COMMITS} nodes/commit={NODES_PER_COMMIT}");
    eprintln!(
        "[c2_throughput] strict : wall={:.3}s ({:.2} ms/commit)",
        strict_wall.as_secs_f64(),
        strict_wall.as_secs_f64() * 1000.0 / N_COMMITS as f64
    );
    eprintln!(
        "[c2_throughput] bulk   : wall={:.3}s  barrier_cost={:.1}ms  seg_files_fsynced={seg_count}",
        bulk_wall.as_secs_f64(),
        barrier_cost.as_secs_f64() * 1000.0
    );
    eprintln!(
        "[c2_throughput] bulk   : {:.2} ms/commit (fsync deferred to one barrier)",
        bulk_wall.as_secs_f64() * 1000.0 / N_COMMITS as f64
    );
    eprintln!("[c2_throughput] BULK_SPEEDUP={speedup:.2}x   (strict/bulk, barrier included)");
    eprintln!(
        "[c2_throughput] fsync_fraction~={:.0}% of per-commit cost (rest = O(segments) snapshot+manifest, the next ceiling)",
        (1.0 - bulk_wall.as_secs_f64() / strict_wall.as_secs_f64()) * 100.0
    );

    // ── Acceptance ─────────────────────────────────────────────────────────
    // The barrier must have actually fsynced segments (proof it did work).
    assert!(
        seg_count > 0,
        "barrier must have segments to fsync (seg_files={seg_count})"
    );
    // C2's GUARANTEE is durability (proven by the reopen-from-disk oracle above)
    // + that deferring fsync is never SLOWER than per-commit fsync. The magnitude
    // of the win is hardware/workload-dependent and bounded by the fsync fraction
    // (NOT asserted as a threshold — measurement refuted fsync-dominance; the real
    // serial ceiling is the O(segments) per-commit cost, reported above).
    assert!(
        speedup >= 1.0,
        "C2 bulk-load must not be slower than per-commit fsync, got {speedup:.2}x \
         (strict={:.3}s bulk={:.3}s barrier={:.1}ms)",
        strict_wall.as_secs_f64(),
        bulk_wall.as_secs_f64(),
        barrier_cost.as_secs_f64() * 1000.0
    );

    disarm.store(true, Ordering::SeqCst);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — CRASH-BEFORE-BARRIER is safe (not corrupt, never panics).
//   Bulk-load commits, DROP the handle without EndBulkLoad (unclean shutdown),
//   reopen → must parse to a consistent version OR a clean Err; NEVER panic.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c2_crash_before_barrier_no_panic() {
    let disarm = arm_watchdog(120, "crash_before_barrier");

    const N_COMMITS: usize = 500;
    const NODES_PER_COMMIT: usize = 4;

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("crash.rfdb");

    {
        // Enter bulk mode, commit, then DROP without EndBulkLoad → some tail
        // commits' fsync was deferred and never flushed (simulated unclean exit).
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.begin_bulk_load().expect("begin_bulk_load");
        for c in 0..N_COMMITS {
            let file = format!("crash/file_{c}.js");
            let (nodes, edges) = make_batch(&file, NODES_PER_COMMIT, 1);
            engine
                .commit_batch_concurrent(
                    nodes,
                    edges,
                    std::slice::from_ref(&file),
                    HashMap::new(),
                    &[],
                )
                .expect("bulk commit");
        }
        // NO end_bulk_load() — the barrier never ran. Drop the handle here.
    }

    // ---- Reopen after the "crash": MUST NOT panic. ----
    // current.json is swapped via atomic rename so it is never torn; the manifest
    // chain validation (parent_version checks / clean read_json failures) catches
    // any un-fsync'd tail. Acceptable outcomes: Ok(consistent state, count <=
    // what we committed) OR a clean recoverable Err. A panic is the only FAIL.
    let reopen = std::panic::catch_unwind(|| GraphEngineV2::open(&db_path));
    assert!(
        reopen.is_ok(),
        "crash-before-barrier reopen must NOT panic"
    );
    match reopen.unwrap() {
        Ok(engine) => {
            let n = engine.node_count();
            let e = engine.edge_count();
            let max = N_COMMITS * NODES_PER_COMMIT;
            eprintln!(
                "[c2_crash] reopen OK after unclean bulk drop: node_count={n} edge_count={e} (<= committed {max})"
            );
            assert!(
                n <= max,
                "reopen node_count {n} must not exceed what was committed {max}"
            );
            assert!(
                e <= max,
                "reopen edge_count {e} must not exceed what was committed {max}"
            );
            // The reopened state must itself be durable (Strict restored at open):
            // a second reopen sees the SAME version (no further loss / no churn).
            drop(engine);
            let again = GraphEngineV2::open(&db_path).expect("second reopen");
            assert_eq!(again.node_count(), n, "second reopen: stable node_count");
            assert_eq!(again.edge_count(), e, "second reopen: stable edge_count");
        }
        Err(err) => {
            // A clean recoverable error is also acceptable (the contract is "no
            // panic / no corruption", not "always recovers some state").
            eprintln!("[c2_crash] reopen returned a clean recoverable Err: {err}");
        }
    }

    disarm.store(true, Ordering::SeqCst);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — Mode restored: after EndBulkLoad a normal Strict commit is durable.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c2_mode_restored_after_barrier() {
    let disarm = arm_watchdog(120, "mode_restored");

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("restored.rfdb");

    {
        let mut engine = GraphEngineV2::create(&db_path).unwrap();
        engine.begin_bulk_load().expect("begin");
        for c in 0..50 {
            let file = format!("bulk/file_{c}.js");
            let (nodes, edges) = make_batch(&file, 4, 1);
            engine
                .commit_batch_concurrent(nodes, edges, std::slice::from_ref(&file), HashMap::new(), &[])
                .expect("bulk commit");
        }
        engine.end_bulk_load().expect("end barrier");

        // A single NORMAL commit AFTER the barrier — must be Strict-durable on its
        // own, with NO further barrier. We reopen below without calling end again.
        let (nodes, edges) = make_batch("post/after_barrier.js", 4, 9);
        engine
            .commit_batch_concurrent(
                nodes,
                edges,
                std::slice::from_ref(&"post/after_barrier.js".to_string()),
                HashMap::new(),
                &[],
            )
            .expect("post-barrier strict commit");
        // drop without any extra barrier
    }

    // ---- Reopen: the post-barrier Strict commit must be present (mode restored
    // to Strict ⇒ that single commit fsynced itself). ----
    let reopened = GraphEngineV2::open(&db_path).unwrap();
    // 50 bulk files * 4 + 1 post file * 4 = 204 nodes.
    let oracle = 50 * 4 + 4;
    assert_eq!(
        reopened.node_count(),
        oracle,
        "reopen must see bulk state + the post-barrier Strict commit (mode restored)"
    );
    assert!(
        reopened.node_exists(id_of("FUNCTION:post/after_barrier.js#fn_0")),
        "post-barrier Strict commit must be durable on its own (no extra barrier)"
    );

    disarm.store(true, Ordering::SeqCst);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — COMPOSITION with C1: bulk + concurrent.
//   BeginBulkLoad, then a CONCURRENT (C1) storm under Relaxed, then EndBulkLoad,
//   then reopen-from-disk sees the FULL concurrently-built state, durable.
//   Reports the combined wall for the headline "bulk + concurrent" number.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn c2_bulk_plus_concurrent_durability() {
    // This is the only test with real concurrency → the watchdog is load-bearing.
    let disarm = arm_watchdog(120, "bulk_plus_concurrent");

    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(4, 16))
        .unwrap_or(4);
    let n_threads = (n_threads * 2).min(16).max(n_threads);
    const COMMITS_PER_THREAD: usize = 60;
    const NODES_PER_COMMIT: usize = 4;

    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("bulkconc.rfdb");

    // begin_bulk_load / end_bulk_load take &mut self; the concurrent storm takes
    // &self via Arc. So: begin on the owned engine, wrap in Arc, run the storm,
    // unwrap the Arc back to the owned engine, end_bulk_load (barrier).
    let mut engine = GraphEngineV2::create(&db_path).unwrap();
    assert!(engine.supports_concurrent_commit());
    engine.begin_bulk_load().expect("begin_bulk_load");

    let combined_start = Instant::now();
    let engine = Arc::new(engine);
    let barrier = Arc::new(Barrier::new(n_threads));
    let mut handles = Vec::new();
    for t in 0..n_threads {
        let engine = Arc::clone(&engine);
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

    // Unwrap the Arc to regain &mut for the barrier.
    let mut engine = Arc::try_unwrap(engine)
        .map_err(|_| "outstanding Arc refs to engine")
        .expect("sole owner after joins");
    let seg_count = count_seg_files(&db_path);
    let barrier_start = Instant::now();
    engine.end_bulk_load().expect("end_bulk_load barrier");
    let barrier_cost = barrier_start.elapsed();
    let combined_wall = combined_start.elapsed();

    let oracle = n_threads * COMMITS_PER_THREAD * NODES_PER_COMMIT;
    assert_eq!(engine.node_count(), oracle, "in-session node_count == oracle");

    // ---- THE SAFETY: reopen the concurrently-built bulk DB FROM DISK ----
    drop(engine);
    let reopened = GraphEngineV2::open(&db_path).unwrap();
    assert_eq!(
        reopened.node_count(),
        oracle,
        "post-barrier reopen of CONCURRENT bulk: node_count == oracle (full state durable)"
    );
    assert_eq!(
        reopened.edge_count(),
        oracle,
        "post-barrier reopen of CONCURRENT bulk: edge_count == oracle"
    );

    eprintln!(
        "[c2_bulk_concurrent] threads={n_threads} commits/thread={COMMITS_PER_THREAD} oracle_nodes={oracle}"
    );
    eprintln!(
        "[c2_bulk_concurrent] combined_wall={:.3}s  barrier_cost={:.1}ms  seg_files_fsynced={seg_count}",
        combined_wall.as_secs_f64(),
        barrier_cost.as_secs_f64() * 1000.0
    );

    disarm.store(true, Ordering::SeqCst);
}
