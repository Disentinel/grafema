# Grafema Performance Profiling Guide

## Overview

The orchestrator emits a JSONL profiler stream to `.grafema/analysis-profile.jsonl` during every `grafema analyze` run. A standalone Node.js tool (`scripts/profile-analyze.mjs`) parses this data and produces a diagnostic report.

## Quick Start

```bash
# 1. Run analysis (profiling is automatic)
grafema analyze

# 2. View report
node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl

# 3. Predict scaling to N files
node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --predict 14000

# 4. With interval arithmetic (formal bounds)
node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --predict 14000 \
  --assumptions scripts/assumptions.yaml

# 5. Machine-readable output
node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --json
```

## What Gets Measured

### Per-file metrics (`file_analyzed` events)

Every file produces a profiler event with:

| Field | Description |
|-------|-------------|
| `file_size_bytes` | Source file size on disk |
| `ast_size_bytes` | AST JSON size after parsing (JS/TS only; 0 for other languages) |
| `parse_ms` | Time in parser (OXC for JS, tree-sitter for Rust, etc.) |
| `analyze_ms` | Time in analyzer daemon (Haskell IPC round-trip for JS) |
| `total_ms` | Wall-clock time for the entire file |
| `node_count` | Graph nodes produced |
| `edge_count` | Graph edges produced |

**Language coverage:** All languages (JS/TS, Haskell, Rust, Java, Kotlin, Python, Go, Swift, Obj-C, C/C++, BEAM) emit per-file metrics. For languages where the parser is internal to the daemon, `parse_ms = 0` and `analyze_ms ≈ total_ms`.

### Batch commit metrics (`batch_committed` events)

| Field | Description |
|-------|-------------|
| `batch_index` | Sequential batch number (0-based) |
| `files` | Number of files in this batch |
| `nodes` / `edges` | Counts committed |
| `commit_ms` | RFDB `commit_batch` wall time |

**Key diagnostic:** If `commit_ms` grows with `batch_index`, that indicates O(N²) degradation in RFDB (see RFD-51).

### Phase events

| Event | Description |
|-------|-------------|
| `analysis_start` / `analysis_complete` | Full analysis phase (includes batching + commits) |
| `js_resolve_start` / `js_resolve_complete` | JS/TS resolution pipeline |
| `js_stream_complete` | Node streaming to resolve workers (with `duration_ms`) |
| `js_resolve_cmd_start` / `js_resolve_cmd_complete` | Per-command resolve timing (with `cmd` and `duration_ms`) |
| `haskell_resolve_start` / `haskell_resolve_complete` | Haskell resolution |
| `rust_resolve_start` / `rust_resolve_complete` | Rust resolution |
| `compact_start` / `compact_complete` | RFDB compaction (with `duration_ms`) |
| `depends_on_start` / `depends_on_complete` | MODULE→MODULE edge derivation |
| `channel_backpressure` | Channel was full N times (analysis faster than ingestion) |

### System metrics (on every event)

| Field | Description |
|-------|-------------|
| `ts` | ISO 8601 UTC timestamp |
| `elapsed_ms` | Milliseconds since profiler start |
| `rss_mb` | Process RSS (resident set size) |
| `cpu_s` | User+system CPU seconds |

## Report Sections

### Phase Breakdown
Shows % of wall time per phase. Typical healthy profile: analysis 60-80%, resolve 10-20%, compact 5-10%.

### File Distribution
Histogram + percentiles (P50/P90/P99/max) for total_ms, parse_ms, analyze_ms. Files with `FileMetrics::default()` (all zeros) are filtered out.

### Outlier Detection
Files > 3σ on total_ms, or with AST expansion ratio > 30x. These are candidates for size guards or special handling.

### Memory Profile
Peak RSS, max delta between events, per-file memory estimate, and attribution by phase.

### Critical Path
Pipeline modeled as phases; identifies bottleneck (longest sequential phase).

### Sensitivity Analysis
What-if: "if phase X is 2x/10x slower, how much does total grow?"

### Scaling Predictions
Extrapolates to target file count using per-file medians. With `--assumptions`, uses interval arithmetic for formal bounds.

### Calibration
Compares observed P5/P95 against assumed intervals from `scripts/assumptions.yaml`. Flags violations and suggests narrowed intervals.

## Assumptions Model

`scripts/assumptions.yaml` defines 7 formal assumptions (A1–A7) with interval bounds:

| ID | Name | Unit | Range |
|----|------|------|-------|
| A1 | parse_time_per_kb | ms/KB | [0.5, 5.0] |
| A2 | analyze_time_per_file | ms | [10, 200] |
| A3 | rfdb_commit_per_batch | ms | [10, 500] |
| A4 | memory_per_file | KB | [50, 5000] |
| A5 | ast_expansion_ratio | ratio | [5, 50] |
| A6 | resolve_time_per_node | ms/node | [0.01, 1.0] |
| A7 | compact_time_per_1k_nodes | ms | [10, 300] |

Update these after calibrating against real data.

## Backpressure Monitoring

The streaming pipeline uses a bounded mpsc channel (capacity = 2 × batch_size). When analysis produces results faster than RFDB can commit them, `try_send` fails and a counter increments. Every 10 batches, the counter is read and emitted as a `channel_backpressure` event.

If you see frequent backpressure events, the bottleneck is RFDB ingestion, not analysis.

## Files

| File | Description |
|------|-------------|
| `packages/grafema-orchestrator/src/profiler.rs` | JSONL profiler (Rust) |
| `packages/grafema-orchestrator/src/analyzer.rs` | `FileMetrics` struct + per-file instrumentation |
| `packages/grafema-orchestrator/src/main.rs` | Phase events, batch timing, backpressure |
| `scripts/profile-analyze.mjs` | Analysis tool (Node.js, zero deps) |
| `scripts/assumptions.yaml` | Interval bounds for scaling predictions |
| `.grafema/analysis-profile.jsonl` | Output (gitignored) |

## Known Issues

- **RFD-51**: `commit_batch` O(N²) degradation — tombstone discovery scans grow with graph size. On Grafema (514 files), commits consume 99.9% of wall time (780s vs 56.5s analysis).
- **Parallelism estimation** in scaling predictions shows 1x when commit time dominates (sum of per-file times < wall time because files wait for commits).
