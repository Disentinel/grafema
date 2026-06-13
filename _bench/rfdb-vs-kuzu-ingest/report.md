# RFDB vs KùzuDB — Ingest Throughput Benchmark

**Date:** 2026-05-31  **Host:** macOS (darwin 22.6.0), x86_64
**Q1:** Does KùzuDB degrade at ~50k nodes?  **Q2:** Baseline RFDB write-path throughput + growth.

Raw outputs alongside this file: `kuzu_bench.py`, `kuzu_result.txt`,
`rfdb_50k_nocompact.txt`, `rfdb_100k_nocompact.txt`, `rfdb_50k_compact50.txt`, `rfdb_100k_compact50.txt`.

## Setup

### Kuzu
- Kuzu **0.11.3**, prebuilt wheel `cp312 macosx_11_0_x86_64`.
- **Install caveat:** project default Python is **3.14**, which has **no Kuzu wheel**; `pip install kuzu`
  there builds from C++ source and fails (`Command '['make','python','NUM_THREADS=4']' returned non-zero exit status 2`).
  Worked around with Python **3.12**:
  `/usr/local/bin/python3.12 -m venv /tmp/kuzu-bench-venv && /tmp/kuzu-bench-venv/bin/pip install --only-binary :all: kuzu`.
- Schema: `N(id INT64 PRIMARY KEY, name STRING, file STRING)` + rel `CALLS(FROM N TO N)`. Fresh DB per point. ~2 edges/node.
- Two paths: (1) **COPY FROM CSV** (recommended fast path); (2) **batched CREATE** in one txn (NOT fast path, used only for the per-bucket curve).
- Timer `time.monotonic()`; CSV generation excluded from ingest timing.

### RFDB
- Prebuilt probe `packages/rfdb-server/target/release/bench_manifest_growth` (RFD-71). **Not rebuilt.**
- Ingest path = `GraphEngineV2::commit_batch` (real LSM write path), one commit per file = 80 nodes + 40 edges.
- 625 files ≈ 50k nodes; 1250 files ≈ 100k nodes. `commit ms` = latency to ingest 80n+40e at that graph size. Timer `std::time::Instant`.

## 1. Throughput table (engine × scale point)

### Kuzu — COPY FROM CSV (fast path)  [src: kuzu_result.txt]
| N nodes | edges | total s | **nodes/s (node COPY)** | elems/s |
|--------:|------:|--------:|------------------------:|--------:|
| 10,000  | 20,000   | 0.1535 | **99,497**  | 195,478 |
| 50,000  | 100,000  | 0.2626 | **271,562** | 571,110 |
| 100,000 | 200,000  | 0.4174 | **357,832** | 718,671 |
| 500,000 | 1,000,000| 1.1881 | **713,854** | 1,262,556 |

Throughput **increases** with scale (fixed COPY overhead amortizes). No degradation.

### RFDB — commit_batch, no compaction  [src: rfdb_50k_nocompact.txt / rfdb_100k_nocompact.txt]
Effective nodes/s = 80 / (commit ms / 1000).
| graph size (nodes) | sampled commit ms | **effective nodes/s** |
|-------------------:|------------------:|----------------------:|
| 4,000   | 59.4  | **1,347** |
| 50,000  | 356.6 | **224**   |
| 100,000 | 651.5 | **123**   |

RFDB per-commit cost **rises** with graph size (RFD-71). Numbers not directly comparable to Kuzu COPY (durable per-commit LSM, see Fairness).

### RFDB — commit_batch, --compact-every 50 (bounded)  [src: rfdb_*_compact50.txt]
| graph size (nodes) | sampled commit ms | effective nodes/s |
|-------------------:|------------------:|------------------:|
| 4,000   | 64.9 | 1,233 |
| 50,000  | 51.5 | 1,553 |
| 100,000 | 76.2 | 1,050 |

With compaction the per-commit cost stays **flat** (~50–77 ms) to 100k; growth moves into separate `compact()`.

## 2. Per-bucket degradation curves (does cost/node rise with size?)

### Kuzu — batched CREATE, single txn, per-10k bucket  [src: kuzu_result.txt]
| graph size after | bucket s | nodes/s |
|-----------------:|---------:|--------:|
| 10,000 | 2.6602 | 3,759 |
| 20,000 | 2.6745 | 3,739 |
| 30,000 | 2.6569 | 3,764 |
| 40,000 | 2.6935 | 3,713 |
| **50,000** | 2.7064 | 3,695 |
| 60,000 | 2.6696 | 3,746 |

**Flat.** Per-bucket time constant (2.66–2.71 s) across the 50k boundary. Cost/node does NOT rise (<2% spread).

### RFDB — no-compaction, commit ms vs graph size  [src: rfdb_100k_nocompact.txt]
| graph size (nodes) | commit ms |
|-------------------:|----------:|
| 8,000   | 73.2  |
| 24,000  | 177.7 |
| 40,000  | 274.4 |
| **48,000** | 334.3 |
| 64,000  | 402.8 |
| 80,000  | 518.0 |
| 100,000 | 651.5 |

**Rising — super-constant.** Fixed work per commit (80n+40e), yet latency grows ~9× (73→651 ms) over 100k.
Probe shows why: `cur manifest B` 44.6 KB→559 KB and `#seg` 200→2500; the full manifest blob is re-serialised
under the engine lock on EVERY commit, so cost scales with live segment count. RFD-71 magnitude confirmed (~9×).

### RFDB — compaction on: degradation removed  [src: rfdb_100k_compact50.txt]
`commit ms` stays ~57–87 ms from 8k→100k; `cur manifest B` bounded 26 KB→71 KB (vs 559 KB unbounded).
Work absorbed by periodic `compact()` (comp ms 122→605 ms, 1-in-50 commits).

## 3. Verdict: "Does Kuzu slow down around 50k?"

**FALSE (measured).** No per-node degradation on either path across the 50k boundary:
- COPY fast path: nodes/s *increases* 99k→271k→357k→713k as N goes 10k→500k — gets faster at 50k, not slower.
- Batched CREATE: per-10k-bucket time flat at 2.66–2.71 s through 50k and on to 60k; cost/node constant <2%.

No inflection at 50k in any Kuzu measurement. The engine that DOES show super-linear ingest cost here is **RFDB**
(compaction off): ~9× per-commit slowdown over the first 100k nodes from unbounded manifest/segment growth (RFD-71),
flattened by periodic compaction.

## 4. Honest caveats about fairness

1. **COPY vs commit_batch are different write units.** Kuzu COPY = single bulk whole-table load. RFDB commit_batch =
   per-commit independently-durable LSM append (80 nodes/commit), closer to Grafema's real incremental ingest.
   The absolute gap (Kuzu 100k–700k/s vs RFDB ~100–1,500/s) is MOSTLY this difference, not raw engine speed. Compare the *trend*, not absolutes.
2. **Columnar vs LSM.** Kuzu columnar/vectorized with amortizing bulk COPY; RFDB LSM with per-commit segment+manifest writes.
   The RFDB degradation is an LSM-manifest artifact (RFD-71), not an inherent columnar-vs-LSM verdict.
3. **Durability not normalized.** fsync/WAL/checkpoint behaviour differs per side; absolute numbers are not a head-to-head "N× faster".
4. **Kuzu batched-CREATE is deliberately the slow path** (single-row CREATE, ~3.7k nodes/s), used only to bucket a curve (COPY is one atomic call).
5. **Curve N differs:** Kuzu curve to 60k (python O(N) loop), RFDB curves to 100k; both cross the 50k boundary the claim is about.
6. **Single run, no warm-up averaging.** Kuzu COPY points are sub-second (cache/JIT noise possible); trend direction is robust, exact decimals are not.
