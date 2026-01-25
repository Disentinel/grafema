# @grafema/rfdb

> High-performance disk-backed graph database server for Grafema

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
# Start the server
npx rfdb-server --socket /tmp/rfdb.sock --data-dir ./my-graph

# Or if installed globally
rfdb-server --socket /tmp/rfdb.sock --data-dir ./my-graph
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

RFDB is optional for Grafema. By default, Grafema uses an in-memory backend. To use RFDB for persistent storage:

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

# Run benchmarks
cargo bench
```

## License

Apache-2.0

## Author

Vadim Reshetnikov
