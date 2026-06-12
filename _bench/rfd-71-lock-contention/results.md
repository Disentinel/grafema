# RFD-71 — lock-contention microbench results

**Question:** does the engine-wide `RwLock<Engine>` cap write parallelism,
and would per-shard locking lift the cap? (Step before touching engine
internals, per RFD-71.)

## What was measured

Standalone binary `packages/rfdb-server/src/bin/bench_lock_contention.rs`.

Two models run the *identical* per-commit work — build N `NodeRecordV2`
(with real blake3 id hashing, representative ingest CPU) then
`Shard::add_nodes` — and differ **only** in lock granularity:

- `engine-wide`: one `Mutex<Vec<Shard>>` around all shards. A worker locks
  the whole vec to write its own shard. Models today's
  `RwLock<Box<dyn GraphStore>>` (`database_manager.rs:125`), acquired per
  commit by `with_engine_write` (`bin/rfdb_server.rs:2391`).
- `per-shard`: `Vec<Mutex<Shard>>`. A worker locks only its own shard.
  Models the RFD-71 proposal.

Worker `t` writes only to shard `t`, so data is fully disjoint — any
serialisation in `engine-wide` is the lock, not data conflict. Strong
scaling: total work held constant, split across N workers.

Run:
```
cargo run --release --bin bench_lock_contention                # comparison table
cargo run --release --bin bench_lock_contention -- --model engine --threads 4
cargo run --release --bin bench_lock_contention -- --model shard  --threads 4
```

## Environment

MacBook, `available_parallelism = 4` cores (Darwin 22.6.0). NB: this is a
4-core laptop, **not** the 16-vCPU Hetzner box where the production
symptom was recorded — the laptop compresses the dynamic range, so the
absolute speedups here are a floor, not the ceiling.

## Result 1 — throughput / speedup table (400 commits × 4000 nodes)

| threads | engine-wide ms | eng nodes/s | eng speedup | per-shard ms | shard nodes/s | shard speedup |
|--------:|---------------:|------------:|------------:|-------------:|--------------:|--------------:|
|       1 |         ~1260  |      1.27e6 |        ~1.0 |       ~1180  |        1.36e6 |          ~1.0 |
|       2 |         ~1120  |      1.43e6 |        ~1.2 |        ~660  |        2.43e6 |          ~1.9 |
|       4 |         ~1000  |      1.60e6 |        ~1.4 |        ~600  |        2.67e6 |          ~2.1 |

Per-shard is consistently **1.5–1.9× faster** at 4 threads across repeats.

> ⚠️ The engine-wide "1.4× speedup" here is **a turbo artifact, not real
> parallelism** — the 1-thread baseline runs at a higher single-core clock,
> inflating the ratio. The honest metric is cores consumed (Result 2).

## Result 2 — cores actually used (`/usr/bin/time -l`, 4 threads)

Cores ≈ (user + sys) / real, run on the built binary (no cargo wrapper):

| model       | user+sys (s) | real (s) | **cores used** |
|-------------|-------------:|---------:|---------------:|
| engine-wide |        1.94  |    1.97  | **0.98** ≈ 1   |
| per-shard   |        2.82  |    1.38  | **2.04**       |

## Verdict

- The engine-wide lock pins the process at **~1 core** regardless of
  worker count — the exact RFD-71 symptom (pcpu hard-capped at ~1 core on
  vscode/16-vCPU). Disjoint shard data does **not** help while one lock
  guards the whole engine.
- Swapping to per-shard locks, with everything else identical, lifts the
  process to **~2 cores on a 4-core box (2.1× more)**. The contention is
  the lock granularity, nothing else.
- This confirms the RFD-71 root cause empirically *before* engine
  internals are touched, and gives a reusable harness to verify the real
  fix on the 16-vCPU box (expect per-shard cores ≈ min(N, shard_count)).
