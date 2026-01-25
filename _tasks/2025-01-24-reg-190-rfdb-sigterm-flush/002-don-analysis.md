# Don Melton Analysis: REG-190 SIGTERM/SIGINT Handler for RFDB Server

## Problem Statement

The RFDB server (`rust-engine/src/bin/rfdb_server.rs`) currently has no graceful shutdown mechanism. When the process receives SIGTERM or SIGINT:
- In-memory data (delta log) is lost
- Database may be left in inconsistent state
- Clients have no warning of impending shutdown

## Current Architecture Analysis

### Server Structure

The server is a **synchronous multi-threaded** architecture:

```rust
fn main() {
    // 1. Parse args, open/create database
    let engine = GraphEngine::create_or_open(&db_path);
    let engine = Arc<RwLock<GraphEngine>>;

    // 2. Bind Unix socket
    let listener = UnixListener::bind(socket_path);

    // 3. Accept loop (blocking, infinite)
    for stream in listener.incoming() {
        thread::spawn(|| handle_client(stream, engine_clone, client_id));
    }
}
```

Key observations:
1. **No tokio runtime** - despite tokio being in Cargo.toml, the server uses std threads
2. **Blocking accept loop** - `listener.incoming()` blocks forever
3. **Arc<RwLock<GraphEngine>>** - shared mutable engine across client threads
4. **Shutdown command exists** - but only via client request (`Request::Shutdown`)

### Data at Risk

From `engine.rs`, unflushed data lives in:
```rust
pub struct GraphEngine {
    delta_log: DeltaLog,           // Append-only log of all operations
    delta_nodes: HashMap<u128, NodeRecord>,  // In-memory node cache
    delta_edges: Vec<EdgeRecord>,  // In-memory edge cache
    // ... mmap segments are safe (already on disk)
}
```

The `flush()` method writes this to disk:
- Collects all nodes/edges (segment + delta)
- Writes to `nodes.bin`, `edges.bin`, `metadata.json`
- Clears delta caches

**CRITICAL**: Without flush on shutdown, all operations since last flush are LOST.

## Signal Handling Options

### Option 1: ctrlc crate (Simplest)
```toml
ctrlc = "3.4"
```
```rust
let engine_for_signal = Arc::clone(&engine);
ctrlc::set_handler(move || {
    let mut guard = engine_for_signal.write().unwrap();
    let _ = guard.flush();
    std::process::exit(0);
})?;
```

**Pros**: Minimal change, handles Ctrl+C
**Cons**: Only SIGINT (Ctrl+C), not SIGTERM; uses separate thread

### Option 2: signal-hook crate (More robust)
```toml
signal-hook = "0.3"
```
```rust
use signal_hook::{consts::SIGTERM, iterator::Signals};

let mut signals = Signals::new(&[SIGINT, SIGTERM])?;
thread::spawn(move || {
    for sig in signals.forever() {
        // flush and exit
    }
});
```

**Pros**: Handles both SIGINT and SIGTERM, low-level control
**Cons**: More boilerplate, separate thread

### Option 3: tokio::signal (Already in deps, but...)
The server doesn't use tokio runtime. Adding async signal handling would require restructuring. **Not recommended for this task.**

## Recommended Solution

**Use `signal-hook` crate** - it's the standard choice for sync Rust servers.

### Implementation Plan

1. Add `signal-hook` to Cargo.toml:
```toml
signal-hook = "0.3"
```

2. In `main()`, before the accept loop:
```rust
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

// Clone Arc for signal handler
let engine_for_signal = Arc::clone(&engine);

// Spawn signal handler thread
let mut signals = Signals::new(&[SIGINT, SIGTERM])?;
thread::spawn(move || {
    for sig in signals.forever() {
        eprintln!("[rfdb-server] Received signal {}, flushing...", sig);

        // Acquire write lock and flush
        if let Ok(mut guard) = engine_for_signal.write() {
            match guard.flush() {
                Ok(()) => eprintln!("[rfdb-server] Flush complete, exiting"),
                Err(e) => eprintln!("[rfdb-server] Flush failed: {}", e),
            }
        }

        std::process::exit(0);
    }
});
```

3. Optional: Add socket cleanup in signal handler:
```rust
let _ = std::fs::remove_file(socket_path);
```

## Edge Cases to Consider

1. **Signal during flush** - RwLock will block signal handler until current op completes. This is correct behavior.

2. **Signal during client write** - Client thread holds write lock, signal handler waits. Data will be consistent.

3. **Multiple signals** - First signal triggers exit, subsequent are ignored.

4. **Empty delta** - `flush()` short-circuits if `delta_log.is_empty()`, so no-op is cheap.

## Complexity Assessment

This is a **small, focused change**:
- ~15 lines of new code
- 1 new dependency
- No architectural changes
- No API changes

Recommend: **Mini-MLA** (Don -> Rob -> Linus)

## Acceptance Criteria

1. SIGINT (Ctrl+C) triggers graceful shutdown with flush
2. SIGTERM triggers graceful shutdown with flush
3. Log messages indicate shutdown progress
4. Socket file is cleaned up on exit
5. Tests: integration test that sends SIGTERM and verifies data persisted
