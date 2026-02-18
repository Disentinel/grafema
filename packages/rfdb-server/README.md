# @grafema/rfdb

> **RFDB** (Rega Flow Database) — high-performance disk-backed graph database server for Grafema

*Named after the author's wife Regina (Rega for short). The Hebrew word רגע (rega, "moment") conveniently fits the concept — a flow of discrete moments captured in the graph.*

**Warning: This package is in beta stage and the API may change between minor versions.**

## Installation

```bash
npm install @grafema/rfdb
```

Prebuilt binaries are included for:
- macOS x64 (Intel)
- macOS arm64 (Apple Silicon)
- Linux x64

For other platforms, build from source (requires Rust):

```bash
git clone https://github.com/Disentinel/rfdb.git
cd rfdb
cargo build --release
```

## Usage

### As a CLI

```bash
# Start the server
npx @grafema/rfdb ./my-graph.rfdb --socket /tmp/rfdb.sock

# Using default socket path (/tmp/rfdb.sock)
rfdb-server ./my-graph.rfdb
```

### Programmatic usage

Server lifecycle is managed through `@grafema/core`:

```javascript
const { startRfdbServer, RFDBServerBackend } = require('@grafema/core');

// Start server (handles binary discovery, socket polling, PID file)
const server = await startRfdbServer({
  dbPath: './my-graph.rfdb',
  socketPath: '.grafema/rfdb.sock',
});

// Use with Grafema
const backend = new RFDBServerBackend({ socketPath: '.grafema/rfdb.sock' });

// Stop server when done
server.kill();
```

This package also exports helpers for binary detection:

```javascript
const { isAvailable, waitForServer } = require('@grafema/rfdb');

if (!isAvailable()) {
  console.log('RFDB not available, using in-memory backend');
}
```

## With Grafema

RFDB is the default storage backend for Grafema. The MCP server and CLI auto-start RFDB when needed.

```javascript
const { Orchestrator, RFDBServerBackend } = require('@grafema/core');

const orchestrator = new Orchestrator({
  rootDir: './src',
  backend: new RFDBServerBackend({ socketPath: '.grafema/rfdb.sock' }),
});
```

## Features

- **Adaptive tuning** — Auto-detects CPU cores, memory, and disk type; tunes write buffers, compaction parallelism, and prefetch strategy
- **Columnar storage** — Efficient storage for graph nodes and edges
- **Deterministic IDs** — BLAKE3 hash-based node identification
- **Zero-copy access** — Memory-mapped files for fast reads
- **BFS/DFS traversal** — Fast graph traversal algorithms
- **Parallel compaction** — Multi-threaded background compaction

## Protocol

RFDB server communicates via Unix socket using MessagePack-encoded messages. The protocol supports:

- `add_nodes` / `add_edges` — Batch insert operations
- `get_node` / `find_by_attr` — Query operations
- `bfs` / `dfs` — Graph traversal
- `flush` / `compact` — Persistence operations
- `compact_with_stats` — Compaction with statistics reporting

## Building from source

```bash
# Build release binary
cargo build --release

# Run tests
cargo test
```

## Performance Benchmarks

RFDB includes Criterion-based benchmarks covering all core graph operations.

### Running Locally

```bash
cd packages/rfdb-server

# Run all benchmarks
cargo bench --bench graph_operations

# Run specific benchmark group
cargo bench --bench graph_operations -- 'add_nodes'
cargo bench --bench graph_operations -- 'get_node'

# Save baseline for future comparison
cargo bench --bench graph_operations -- --save-baseline my-baseline

# Compare against saved baseline
cargo bench --bench graph_operations -- --baseline my-baseline
```

### Benchmark Coverage (16 groups)

| Category | Operations |
|----------|-----------|
| **Node write** | add_nodes |
| **Edge write** | add_edges |
| **Node read** | get_node, find_by_type, find_by_type (wildcard), find_by_attr |
| **Edge read** | get_outgoing_edges, get_incoming_edges, neighbors |
| **Mutation** | delete_node, delete_edge |
| **Traversal** | bfs, reachability (forward/backward) |
| **Maintenance** | flush, compact |
| **Analysis** | reanalysis_cost, compaction |

### Additional Tools

```bash
# Memory profiling
cargo run --bin memory_profile

# Benchmark report generation
cargo run --bin bench_report
```

### CI Regression Detection

Benchmarks run on PRs with the `benchmark` label (comparing PR vs main branch).
Regressions >20% will fail the workflow.

### What to Do If Benchmarks Regress

1. **Check if it's noise** — re-run the workflow
2. **Reproduce locally** — save baselines before/after:
   ```bash
   git stash && cargo bench --bench graph_operations -- --save-baseline before
   git stash pop && cargo bench --bench graph_operations -- --save-baseline after
   cargo install critcmp && critcmp before after
   ```
3. **Identify the cause** — `add_nodes` regression = storage overhead; `bfs`/`reachability` = traversal changes
4. **Fix or justify** — document trade-offs in PR description

## License

Apache-2.0

## Author

Vadim Reshetnikov
