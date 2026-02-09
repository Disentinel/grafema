# @grafema/rfdb

> **RFDB** (Rega Flow Database) — high-performance disk-backed graph database server for Grafema

*Named after the author's wife Regina (Rega for short). The Hebrew word רגע (rega, "moment") conveniently fits the concept — a flow of discrete moments captured in the graph.*

**Warning: This package is in early alpha stage and is not recommended for production use.**

## Installation

```bash
npm install @grafema/rfdb
```

Prebuilt binaries are included for:
- macOS x64 (Intel)
- macOS arm64 (Apple Silicon) - coming soon
- Linux x64 - coming soon
- Linux arm64 - coming soon

For other platforms, build from source (requires Rust):

```bash
git clone https://github.com/Disentinel/rfdb.git
cd rfdb
cargo build --release
```

## Usage

### As a CLI

```bash
# Start the server (db-path is required, socket is optional)
npx rfdb-server ./my-graph.rfdb --socket /tmp/rfdb.sock

# Or if installed globally
rfdb-server ./my-graph.rfdb --socket /tmp/rfdb.sock

# Using default socket path (/tmp/rfdb.sock)
rfdb-server ./my-graph.rfdb
```

### Programmatic usage

```javascript
const { startServer, waitForServer, isAvailable } = require('@grafema/rfdb');

// Check if binary is available
if (!isAvailable()) {
  console.log('RFDB not available, using in-memory backend');
}

// Start server
const server = startServer({
  socketPath: '/tmp/rfdb.sock',
  dataDir: './rfdb-data',
  silent: false,
});

// Wait for it to be ready
await waitForServer('/tmp/rfdb.sock');

// Use with @grafema/core
const { RFDBServerBackend } = require('@grafema/core');
const backend = new RFDBServerBackend({ socketPath: '/tmp/rfdb.sock' });

// Stop server when done
server.kill();
```

## With Grafema

RFDB (Rega Flow Database) is optional for Grafema. By default, Grafema uses an in-memory backend. To use RFDB for persistent storage:

```javascript
const { Orchestrator, RFDBServerBackend } = require('@grafema/core');

const orchestrator = new Orchestrator({
  rootDir: './src',
  backend: new RFDBServerBackend({ socketPath: '/tmp/rfdb.sock' }),
});
```

## Features

- **Columnar storage**: Efficient storage for graph nodes and edges
- **Deterministic IDs**: BLAKE3 hash-based node identification
- **Zero-copy access**: Memory-mapped files for fast reads
- **BFS/DFS traversal**: Fast graph traversal algorithms
- **Version-aware**: Support for incremental analysis

## Protocol

RFDB server communicates via Unix socket using MessagePack-encoded messages. The protocol supports:

- `add_nodes` / `add_edges` - Batch insert operations
- `get_node` / `find_by_attr` - Query operations
- `bfs` / `dfs` - Graph traversal
- `flush` / `compact` - Persistence operations

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

### Benchmark Coverage

| Category | Operations |
|----------|-----------|
| **Node write** | add_nodes |
| **Edge write** | add_edges |
| **Node read** | get_node, find_by_type, find_by_type (wildcard), find_by_attr |
| **Edge read** | get_outgoing_edges, get_incoming_edges, neighbors |
| **Mutation** | delete_node, delete_edge |
| **Traversal** | bfs, reachability (forward/backward) |
| **Maintenance** | flush, compact |

### CI Regression Detection

Benchmarks run on PRs with the `benchmark` label (comparing PR vs main branch).
Regressions >20% will fail the workflow.

To trigger on your PR: add the `benchmark` label.

### What to Do If Benchmarks Regress

If CI reports a regression on your PR:

1. **Check if it's noise** — re-run the workflow. CI runners have variable load; spurious regressions happen.
2. **Reproduce locally** — save baselines before/after your change and compare with `critcmp`:
   ```bash
   git stash && cargo bench --bench graph_operations -- --save-baseline before
   git stash pop && cargo bench --bench graph_operations -- --save-baseline after
   cargo install critcmp && critcmp before after
   ```
3. **Identify the cause** — look at which operations regressed. A regression in `add_nodes` suggests storage overhead; `bfs`/`reachability` point to traversal changes.
4. **Fix or justify** — if the regression is real, fix it. If it's an acceptable trade-off (e.g., +15% write latency for 10x better reads), document the trade-off in the PR description.

### Comparing Before/After Changes

```bash
# Before making changes
cargo bench --bench graph_operations -- --save-baseline before

# Make changes, then compare
cargo bench --bench graph_operations -- --baseline before
```

## License

Apache-2.0

## Author

Vadim Reshetnikov
